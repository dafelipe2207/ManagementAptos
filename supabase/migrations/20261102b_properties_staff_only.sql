-- A tenant must never see anything about the landlord's lease with the real estate (rent paid to the
-- agency, BPAY / bank details, lease end…). The app only ASKED for safe columns, but the database
-- still let a tenant read the whole `properties` row through the API. Now:
--  1) tenants read their property through my_properties() (tenant-safe columns only, own property);
--  2) the tenant branch is removed from the properties SELECT policy (staff only).
create or replace function public.my_properties()
returns table (
  id uuid, name text, address text, bedrooms integer, bathrooms integer, notes text,
  whatsapp_group_link text, wifi_ssid text, wifi_password text, wifi_notes text,
  has_parking boolean, parking_cost numeric, parking_tenant_id uuid, inventory jsonb, created_at timestamptz
)
language sql stable security definer set search_path to 'public'
as $$
  select p.id, p.name, p.address, p.bedrooms, p.bathrooms, p.notes,
         p.whatsapp_group_link, p.wifi_ssid, p.wifi_password, p.wifi_notes,
         p.has_parking, p.parking_cost, p.parking_tenant_id, p.inventory, p.created_at
  from public.properties p
  where p.id in (select t.property_id from public.tenants t where t.auth_user_id = auth.uid())
  order by p.created_at;
$$;
revoke all on function public.my_properties() from public, anon;
grant execute on function public.my_properties() to authenticated;

drop policy if exists properties_select on public.properties;
create policy properties_select on public.properties for select
  using (can_manage_property_in((select is_super_admin()), (select my_managed_property_ids()), id));
