-- Move-in photos: tenants get 5 days from their move-in date (app.js, MOVE_IN_PHOTOS_WINDOW_DAYS).
-- Staff can give a tenant more time (move_in_photos_extended_until = last day they can upload);
-- once the window is closed the tenant has to ask for more days (move_in_photos_extension_requested_at,
-- cleared again when staff grant them).
alter table public.tenants add column if not exists move_in_photos_extended_until date;
alter table public.tenants add column if not exists move_in_photos_extension_requested_at timestamptz;

-- Tenants have no UPDATE grant on tenants under RLS: this narrow function only stamps the request
-- on the caller's own row and tells the property's administrators (same audience as the move-out notice).
create or replace function public.request_move_in_photos_extension()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tid uuid := current_tenant_id();
  v_name text; v_prop uuid; v_already timestamptz;
begin
  if v_tid is null then return; end if;
  select full_name, property_id, move_in_photos_extension_requested_at into v_name, v_prop, v_already
    from tenants where id = v_tid;
  if v_already is not null then return; end if; -- already asked, still waiting for staff
  update tenants set move_in_photos_extension_requested_at = now() where id = v_tid;
  insert into notifications (auth_user_id, title, body, category, related_table, related_id, property_id, tenant_id)
  select p.auth_user_id, 'Move-in photos: more days requested',
    coalesce(v_name,'A tenant') || ' asked for more days to upload their move-in photos — open their Inspection page to give them more time.',
    'check_in', 'tenants', v_tid, v_prop, v_tid
  from profiles p
  where p.is_active and p.auth_user_id is not null and (p.role = 'super_admin' or (p.role = 'administrator' and exists (
    select 1 from property_administrators pa where pa.profile_id = p.id and pa.property_id = v_prop)));
end $function$;
revoke all on function public.request_move_in_photos_extension() from public;
grant execute on function public.request_move_in_photos_extension() to authenticated;
