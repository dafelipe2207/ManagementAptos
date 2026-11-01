-- Move-in / move-out photos taken by staff are PRIVATE by default.
-- The admin uploads them in their own section (separate from the tenant's photos) and ticks
-- "Show to tenant" on the ones the tenant may see. Until then the tenant can neither list the rows
-- nor open the files. The tenant's own uploads are always visible to them.
--
-- Supersedes 20261025_inspection_photos_shared.sql, which made every staff photo visible to the
-- tenant. That migration was never applied to production — do not apply it after this one.

alter table public.inspection_submissions
  add column if not exists shared_with_tenant boolean not null default false;

-- Rows: staff see everything for their properties; a tenant sees their own uploads plus the staff
-- submissions that were explicitly shared with them.
drop policy if exists inspection_submissions_select on public.inspection_submissions;
create policy inspection_submissions_select on public.inspection_submissions
  for select
  using (
    can_manage_property_in((select is_super_admin()), (select my_managed_property_ids()), property_id)
    or (tenant_id = (select current_tenant_id())
        and (shared_with_tenant or user_id = (select auth.uid())))
  );

-- A tenant can only insert / edit submissions that are their own (never a staff one, never
-- flipping a staff submission to "shown").
drop policy if exists inspection_submissions_insert on public.inspection_submissions;
create policy inspection_submissions_insert on public.inspection_submissions
  for insert
  with check (
    can_manage_property_in((select is_super_admin()), (select my_managed_property_ids()), property_id)
    or (tenant_id = (select current_tenant_id()) and user_id = (select auth.uid()))
  );

drop policy if exists inspection_submissions_update on public.inspection_submissions;
create policy inspection_submissions_update on public.inspection_submissions
  for update
  using (
    can_manage_property_in((select is_super_admin()), (select my_managed_property_ids()), property_id)
    or (tenant_id = (select current_tenant_id()) and user_id = (select auth.uid()))
  )
  with check (
    can_manage_property_in((select is_super_admin()), (select my_managed_property_ids()), property_id)
    or (tenant_id = (select current_tenant_id()) and user_id = (select auth.uid()))
  );

create index if not exists inspection_submissions_tenant_idx on public.inspection_submissions (tenant_id);

-- Files: besides their own folder (tenant_own_inspection_photos), a tenant can open a photo (or its
-- thumbnail, stored at <uid>/thumbs/<file> next to <uid>/<file>) only if it is listed on a staff
-- submission that was shared with them.
drop policy if exists tenant_read_shared_inspection_photos on storage.objects;
create policy tenant_read_shared_inspection_photos on storage.objects
  for select to authenticated
  using (
    bucket_id = 'inspection-photos'
    and exists (
      select 1 from public.inspection_submissions s
      where s.tenant_id = (select public.current_tenant_id())
        and s.shared_with_tenant
        and (s.photo_paths ? storage.objects.name
             or s.photo_paths ? regexp_replace(storage.objects.name, '^([^/]+)/thumbs/', '\1/'))
    )
  );

-- Tell the tenant when staff photos become visible to them: on upload when shared straight away,
-- or later when the admin ticks "Show to tenant".
create or replace function public.notify_inspection_photos_shared() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_tenant_uid uuid; v_label text; v_cat text; v_n int;
begin
  if not new.shared_with_tenant then return new; end if;
  if tg_op = 'UPDATE' and old.shared_with_tenant then return new; end if;
  select auth_user_id into v_tenant_uid from tenants where id = new.tenant_id;
  if v_tenant_uid is null or new.user_id = v_tenant_uid then return new; end if; -- tenant's own upload
  v_label := case when new.type = 'move_out' then 'move-out' else 'move-in' end;
  v_cat := case when new.type = 'move_out' then 'check_out' else 'check_in' end;
  v_n := coalesce(jsonb_array_length(new.photo_paths), 0);
  insert into notifications (auth_user_id, title, body, category, related_table, related_id, property_id, tenant_id)
  values (v_tenant_uid, 'New ' || v_label || ' photos',
    'Your property manager shared ' || v_n || ' ' || v_label || ' photo' || case when v_n = 1 then '' else 's' end || ' of your room. You can see them in Inspection.',
    v_cat, 'inspection_submissions', new.id, new.property_id, new.tenant_id);
  return new;
end $$;
drop trigger if exists inspection_submissions_notify_shared on public.inspection_submissions;
create trigger inspection_submissions_notify_shared
  after insert or update of shared_with_tenant on public.inspection_submissions
  for each row execute function public.notify_inspection_photos_shared();
