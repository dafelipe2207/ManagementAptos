-- Administrators get the same powers as the Super Admin on the properties assigned to them —
-- including deleting bills, rooms, tenants, recurring bills and the property itself, and clearing
-- notifications about those properties. What stays Super Admin-only: managing users and assigning
-- properties to administrators (Users page / property_administrators) and the Audit log.
-- can_manage_property() = Super Admin, or an administrator assigned to that property.

drop policy if exists bills_delete on public.bills;
create policy bills_delete on public.bills for delete to authenticated
  using (public.can_manage_property(property_id));

drop policy if exists rooms_delete on public.rooms;
create policy rooms_delete on public.rooms for delete to authenticated
  using (public.can_manage_property(property_id));

drop policy if exists tenants_delete on public.tenants;
create policy tenants_delete on public.tenants for delete to authenticated
  using (public.can_manage_property(property_id));

drop policy if exists properties_delete on public.properties;
create policy properties_delete on public.properties for delete to authenticated
  using (public.can_manage_property(id));

drop policy if exists recurring_bills_delete on public.recurring_bills;
create policy recurring_bills_delete on public.recurring_bills for delete to authenticated
  using (public.can_manage_property(property_id));

drop policy if exists notifications_delete on public.notifications;
create policy notifications_delete on public.notifications for delete to authenticated
  using (auth_user_id = auth.uid() or public.is_super_admin()
         or (property_id is not null and public.can_manage_property(property_id)));
