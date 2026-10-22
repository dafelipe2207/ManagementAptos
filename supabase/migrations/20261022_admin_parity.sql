-- Administrators get the same powers as the Super Admin inside the properties assigned to them.
-- Still Super Admin only: assigning properties (property_administrators), changing roles, staff
-- accounts (and their saved passwords), and deleting a whole property.
-- (Applied 2026-10-22.)

create or replace function public.admin_manages_auth_user(p_auth uuid)
returns boolean language sql stable security definer set search_path to 'public' as $$
  select coalesce(public.is_administrator() and exists (
    select 1 from public.tenants t
    where t.auth_user_id = p_auth and t.property_id = any(public.my_managed_property_ids())
  ), false);
$$;

-- Profiles: an administrator reads/updates the tenant logins of their properties.
alter policy profiles_select on public.profiles using (
  (auth_user_id = (select auth.uid())) or (select public.is_super_admin()) or public.admin_manages_auth_user(auth_user_id));
alter policy profiles_update on public.profiles
  using ((auth_user_id = (select auth.uid())) or (select public.is_super_admin()) or public.admin_manages_auth_user(auth_user_id))
  with check ((auth_user_id = (select auth.uid())) or (select public.is_super_admin()) or public.admin_manages_auth_user(auth_user_id));

-- Roles: Super Admin only. Active/inactive: Super Admin, or an administrator for their tenants.
create or replace function public.profiles_protect_role()
returns trigger language plpgsql security definer set search_path to 'public' as $function$
begin
  if new.role is distinct from old.role and not public.is_super_admin() then
    raise exception 'Only a Super Admin can change a user''s role.';
  end if;
  if new.is_active is distinct from old.is_active and not public.is_super_admin()
     and not (old.role = 'tenant' and public.admin_manages_auth_user(old.auth_user_id)) then
    raise exception 'Only a Super Admin can change this user''s active status.';
  end if;
  return new;
end;
$function$;

-- Deletes inside the administrator's properties.
alter policy bills_delete on public.bills using (can_manage_property_in((select is_super_admin()), (select my_managed_property_ids()), property_id));
alter policy tenants_delete on public.tenants using (can_manage_property_in((select is_super_admin()), (select my_managed_property_ids()), property_id));
alter policy rooms_delete on public.rooms using (can_manage_property_in((select is_super_admin()), (select my_managed_property_ids()), property_id));
alter policy recurring_bills_delete on public.recurring_bills using (can_manage_property_in((select is_super_admin()), (select my_managed_property_ids()), property_id));
alter policy "Super Admin can delete bill extractions" on public.bill_extractions using (
  (select is_super_admin()) or ((select is_staff()) and user_id = (select auth.uid()))
  or (property_id is not null and can_manage_property_in((select is_super_admin()), (select my_managed_property_ids()), property_id)));
alter policy notifications_delete on public.notifications using ((auth_user_id = (select auth.uid())) or (select is_staff()));

-- Audit log: an administrator sees what happened in their properties.
alter policy audit_logs_select on public.audit_logs using (
  (select is_super_admin())
  or ((select is_administrator()) and (
    user_id = (select auth.uid())
    or public.admin_manages_auth_user(user_id)
    or (coalesce(new_data, old_data) ->> 'property_id') = any(public.my_managed_property_ids()::text[])
    or ((coalesce(new_data, old_data) ->> 'tenant_id') is not null
        and public.property_of_tenant((coalesce(new_data, old_data) ->> 'tenant_id')::uuid) = any(public.my_managed_property_ids()))
  )));
