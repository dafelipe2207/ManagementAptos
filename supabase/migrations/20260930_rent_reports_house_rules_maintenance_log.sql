-- 1) Tenants can upload their own payment proofs (receipts/<auth uid>/...). Before this they could
--    only READ that folder, so "attach proof" failed for tenants.
drop policy if exists tenant_own_folder_receipts_insert on storage.objects;
create policy tenant_own_folder_receipts_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and (auth.uid())::text = (storage.foldername(name))[1]);

-- 2) Rent payment reports: tenant says "I paid", attaches proof; stays pending until staff confirm/reject.
create table if not exists public.rent_payment_reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  payment_date date not null,
  payment_method text,
  reference text,
  proof_path text,
  period_label text,
  status text not null default 'pending' check (status in ('pending','confirmed','rejected')),
  payment_id uuid references public.payments(id) on delete set null,
  reviewed_by_profile_id uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  rejection_reason text,
  reported_at timestamptz not null default now()
);
create index if not exists rent_payment_reports_tenant_idx on public.rent_payment_reports(tenant_id);
alter table public.rent_payment_reports enable row level security;
drop policy if exists rent_reports_select on public.rent_payment_reports;
create policy rent_reports_select on public.rent_payment_reports for select
  using (can_manage_property(property_id) or tenant_id = current_tenant_id());
drop policy if exists rent_reports_insert on public.rent_payment_reports;
create policy rent_reports_insert on public.rent_payment_reports for insert
  with check (tenant_id = current_tenant_id() and property_id = property_of_tenant(tenant_id)
    and status = 'pending' and reviewed_by_profile_id is null and reviewed_at is null and payment_id is null);
drop policy if exists rent_reports_update on public.rent_payment_reports;
create policy rent_reports_update on public.rent_payment_reports for update
  using (can_manage_property(property_id)) with check (can_manage_property(property_id));
drop policy if exists rent_reports_delete on public.rent_payment_reports;
create policy rent_reports_delete on public.rent_payment_reports for delete
  using (can_manage_property(property_id) or (tenant_id = current_tenant_id() and status = 'pending'));

create or replace function public.notify_staff_of_rent_report() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if new.status <> 'pending' then return new; end if;
  select full_name into v_name from tenants where id = new.tenant_id;
  insert into notifications (auth_user_id, title, body, category, related_table, related_id, property_id, tenant_id)
  select p.auth_user_id, 'Rent payment reported',
    coalesce(v_name,'A tenant') || ' reported a rent payment of $' || to_char(new.amount,'FM999999990.00') ||
      ' on ' || to_char(new.payment_date,'DD Mon') || ' — review it in Payments.',
    'rent', 'rent_payment_reports', new.id, new.property_id, new.tenant_id
  from profiles p
  where p.is_active and (p.role = 'super_admin' or (p.role = 'administrator' and exists (
    select 1 from property_administrators pa where pa.profile_id = p.id and pa.property_id = new.property_id)));
  return new;
end $$;
drop trigger if exists rent_payment_reports_notify_staff on public.rent_payment_reports;
create trigger rent_payment_reports_notify_staff after insert on public.rent_payment_reports
  for each row execute function public.notify_staff_of_rent_report();

-- 3) House rules per property (replaces the tenant "My Documents" tab).
create table if not exists public.house_rules (
  property_id uuid primary key references public.properties(id) on delete cascade,
  content text not null default '',
  file_path text,
  file_name text,
  updated_by_profile_id uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.house_rules enable row level security;
drop policy if exists house_rules_select on public.house_rules;
create policy house_rules_select on public.house_rules for select
  using (can_manage_property(property_id) or property_id = property_of_tenant(current_tenant_id()));
drop policy if exists house_rules_write on public.house_rules;
create policy house_rules_write on public.house_rules for all
  using (can_manage_property(property_id)) with check (can_manage_property(property_id));

insert into storage.buckets (id, name, public) values ('house-rules','house-rules', false)
  on conflict (id) do nothing;
drop policy if exists house_rules_staff_all on storage.objects;
create policy house_rules_staff_all on storage.objects for all to authenticated
  using (bucket_id = 'house-rules' and is_staff()) with check (bucket_id = 'house-rules' and is_staff());
drop policy if exists house_rules_tenant_read on storage.objects;
create policy house_rules_tenant_read on storage.objects for select to authenticated
  using (bucket_id = 'house-rules' and (storage.foldername(name))[1] = (property_of_tenant(current_tenant_id()))::text);

-- 4) Maintenance: staff of the property can delete (was super admin only); tenants can edit and
--    delete their OWN requests while still "reported" (not yet actioned). A guard trigger stops a
--    tenant from changing staff-only fields.
drop policy if exists maintenance_delete on public.maintenance_requests;
create policy maintenance_delete on public.maintenance_requests for delete
  using (can_manage_property(property_id) or (tenant_id = current_tenant_id() and status = 'reported'));
drop policy if exists maintenance_update on public.maintenance_requests;
create policy maintenance_update on public.maintenance_requests for update
  using (can_manage_property(property_id) or (tenant_id = current_tenant_id() and status = 'reported'))
  with check (can_manage_property(property_id) or tenant_id = current_tenant_id());

create or replace function public.maintenance_tenant_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if can_manage_property(old.property_id) then return new; end if;
  if new.status is distinct from old.status or new.assigned_to is distinct from old.assigned_to
     or new.due_date is distinct from old.due_date or new.resolution_notes is distinct from old.resolution_notes
     or new.property_id is distinct from old.property_id or new.tenant_id is distinct from old.tenant_id
     or new.room_id is distinct from old.room_id then
    raise exception 'Only staff can change status, assignment, dates or notes of a maintenance request.';
  end if;
  return new;
end $$;
drop trigger if exists maintenance_requests_tenant_guard on public.maintenance_requests;
create trigger maintenance_requests_tenant_guard before update on public.maintenance_requests
  for each row execute function public.maintenance_tenant_guard();

-- Change log: every create / edit / delete, who did it, and what changed (old -> new). Kept even
-- after the request itself is deleted (no FK), with a snapshot of the deleted row.
create table if not exists public.maintenance_log (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  property_id uuid not null,
  tenant_id uuid,
  action text not null check (action in ('created','updated','deleted')),
  title text,
  changes jsonb not null default '{}'::jsonb,
  snapshot jsonb,
  actor_auth_user_id uuid,
  actor_name text,
  actor_role text,
  created_at timestamptz not null default now()
);
create index if not exists maintenance_log_request_idx on public.maintenance_log(request_id, created_at);
alter table public.maintenance_log enable row level security;
drop policy if exists maintenance_log_select on public.maintenance_log;
create policy maintenance_log_select on public.maintenance_log for select
  using (can_manage_property(property_id) or tenant_id = current_tenant_id());

create or replace function public.log_maintenance_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_name text; v_role text; v_changes jsonb := '{}'::jsonb; k text;
  v_old jsonb; v_new jsonb;
  tracked text[] := array['title','description','category','priority','status','assigned_to','due_date',
    'resolution_notes','room_id','photos_before','photos_during','photos_after'];
begin
  select trim(coalesce(first_name,'') || ' ' || coalesce(last_name,'')), role into v_name, v_role
    from profiles where auth_user_id = auth.uid() limit 1;
  if TG_OP = 'INSERT' then
    insert into maintenance_log (request_id, property_id, tenant_id, action, title, snapshot, actor_auth_user_id, actor_name, actor_role)
    values (new.id, new.property_id, new.tenant_id, 'created', new.title, to_jsonb(new), auth.uid(), v_name, v_role);
    return new;
  elsif TG_OP = 'UPDATE' then
    v_old := to_jsonb(old); v_new := to_jsonb(new);
    foreach k in array tracked loop
      if (v_old -> k) is distinct from (v_new -> k) then
        if k like 'photos_%' then
          v_changes := v_changes || jsonb_build_object(k, jsonb_build_object('from', jsonb_array_length(coalesce(v_old->k,'[]'::jsonb)), 'to', jsonb_array_length(coalesce(v_new->k,'[]'::jsonb))));
        else
          v_changes := v_changes || jsonb_build_object(k, jsonb_build_object('from', v_old -> k, 'to', v_new -> k));
        end if;
      end if;
    end loop;
    if v_changes <> '{}'::jsonb then
      insert into maintenance_log (request_id, property_id, tenant_id, action, title, changes, actor_auth_user_id, actor_name, actor_role)
      values (new.id, new.property_id, new.tenant_id, 'updated', new.title, v_changes, auth.uid(), v_name, v_role);
    end if;
    return new;
  else
    insert into maintenance_log (request_id, property_id, tenant_id, action, title, snapshot, actor_auth_user_id, actor_name, actor_role)
    values (old.id, old.property_id, old.tenant_id, 'deleted', old.title, to_jsonb(old), auth.uid(), v_name, v_role);
    return old;
  end if;
end $$;
drop trigger if exists maintenance_requests_change_log on public.maintenance_requests;
create trigger maintenance_requests_change_log after insert or update or delete on public.maintenance_requests
  for each row execute function public.log_maintenance_change();

-- 5) Staff are notified when a tenant deletes their own maintenance request.
create or replace function public.notify_staff_on_tenant_maintenance_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if can_manage_property(old.property_id) then return old; end if;
  insert into notifications (auth_user_id, title, body, category, related_table, property_id, tenant_id)
  select p.auth_user_id, 'Maintenance request deleted',
    coalesce((select full_name from tenants where id = old.tenant_id), 'A tenant') || ' deleted their request: ' || old.title,
    'important_notice', 'maintenance_log', old.property_id, old.tenant_id
  from profiles p
  where p.is_active and (p.role = 'super_admin' or (p.role = 'administrator' and exists (
    select 1 from property_administrators pa where pa.profile_id = p.id and pa.property_id = old.property_id)));
  return old;
end $$;
drop trigger if exists maintenance_requests_notify_delete on public.maintenance_requests;
create trigger maintenance_requests_notify_delete after delete on public.maintenance_requests
  for each row execute function public.notify_staff_on_tenant_maintenance_delete();

-- 6) Fix: tenants couldn't report maintenance problems — this trigger wrote task_index with the
--    tenant's own permissions. Its cleaning/bin siblings already run as security definer.
alter function public.sync_task_index_maintenance() security definer;
alter function public.sync_task_index_maintenance() set search_path = public;

-- 7) Remember when a bill was sent to the property's WhatsApp group.
alter table public.bills add column if not exists whatsapp_group_shared_at timestamptz;
alter table public.bills add column if not exists whatsapp_group_share_count integer not null default 0;

-- 8) Real estate inspections (agency visits) per property; tenants of the property can read them.
create table if not exists public.real_estate_inspections (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id) on delete cascade,
  inspection_date date not null, start_time time, end_time time, agency text, notes text,
  status text not null default 'scheduled' check (status in ('scheduled','cancelled','done')),
  notified_at timestamptz, created_by_profile_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table public.real_estate_inspections enable row level security;
create policy rei_select on public.real_estate_inspections for select
  using (can_manage_property(property_id) or property_id = property_of_tenant(current_tenant_id()));
create policy rei_write on public.real_estate_inspections for all
  using (can_manage_property(property_id)) with check (can_manage_property(property_id));

-- 9) What happened at each real estate inspection (admin only).
alter table public.real_estate_inspections add column if not exists outcome text;
