-- A tenant's move-out estimate (app.js, estimateTenantBillGap) splits the house's daily bill cost among
-- the people living there each day. A tenant only sees their own row in `tenants`, so the app saw ONE
-- person and charged them the whole house's cost (e.g. electricity ~3x too high). This returns what the
-- estimate needs about the OTHER tenants of the caller's property — dates and bill factor only, no
-- names, ids or contact details.
create or replace function public.my_housemates_occupancy()
returns table(property_id uuid, move_in_date date, expected_move_out_date date, actual_move_out_date date, bill_occupancy_factor numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select t.property_id, t.move_in_date, t.expected_move_out_date, t.actual_move_out_date, t.bill_occupancy_factor
  from tenants t
  where current_tenant_id() is not null
    and t.property_id = (select me.property_id from tenants me where me.id = current_tenant_id())
    and t.id <> current_tenant_id()
    and t.rent_amount > 0;
$function$;
revoke all on function public.my_housemates_occupancy() from public;
grant execute on function public.my_housemates_occupancy() to authenticated;
