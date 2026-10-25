-- Move-in / move-out photos are shared evidence: a tenant can SEE every photo on their own
-- inspection record (including the ones the property manager uploaded under the manager's
-- folder), but can only change/remove the submissions they uploaded themselves.

-- Read access to any inspection photo (or its thumbnail) listed on one of the caller's own
-- inspection submissions. Thumbnails live at <uid>/thumbs/<file> next to <uid>/<file>.
drop policy if exists tenant_read_shared_inspection_photos on storage.objects;
create policy tenant_read_shared_inspection_photos on storage.objects
  for select to authenticated
  using (
    bucket_id = 'inspection-photos'
    and exists (
      select 1 from public.inspection_submissions s
      where s.tenant_id = (select public.current_tenant_id())
        and (s.photo_paths ? storage.objects.name
             or s.photo_paths ? regexp_replace(storage.objects.name, '^([^/]+)/thumbs/', '\1/'))
    )
  );

-- Tenants may only edit (e.g. remove photos from) their own uploads; staff keep full access.
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

-- New move-in / move-out photos tell the other side: a tenant's upload notifies the property's
-- staff, a staff upload notifies the tenant.
create or replace function public.notify_inspection_photos() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_name text; v_tenant_uid uuid; v_label text; v_n int; v_cat text;
begin
  select full_name, auth_user_id into v_name, v_tenant_uid from tenants where id = new.tenant_id;
  v_label := case when new.type = 'move_out' then 'move-out' else 'move-in' end;
  v_cat := case when new.type = 'move_out' then 'check_out' else 'check_in' end;
  v_n := coalesce(jsonb_array_length(new.photo_paths), 0);
  if v_tenant_uid is not null and new.user_id = v_tenant_uid then
    insert into notifications (auth_user_id, title, body, category, related_table, related_id, property_id, tenant_id)
    select p.auth_user_id, 'New ' || v_label || ' photos',
      coalesce(v_name, 'A tenant') || ' added ' || v_n || ' ' || v_label || ' photo' || case when v_n = 1 then '' else 's' end || '.',
      v_cat, 'inspection_submissions', new.id, new.property_id, new.tenant_id
    from profiles p
    where p.is_active and p.auth_user_id is not null and (p.role = 'super_admin' or (p.role = 'administrator' and exists (
      select 1 from property_administrators pa where pa.profile_id = p.id and pa.property_id = new.property_id)));
  elsif v_tenant_uid is not null then
    insert into notifications (auth_user_id, title, body, category, related_table, related_id, property_id, tenant_id)
    values (v_tenant_uid, 'New ' || v_label || ' photos',
      'Your property manager added ' || v_n || ' ' || v_label || ' photo' || case when v_n = 1 then '' else 's' end || ' of your room. You can see them in Inspection.',
      v_cat, 'inspection_submissions', new.id, new.property_id, new.tenant_id);
  end if;
  return new;
end $$;
drop trigger if exists inspection_submissions_notify on public.inspection_submissions;
create trigger inspection_submissions_notify after insert on public.inspection_submissions
  for each row execute function public.notify_inspection_photos();
