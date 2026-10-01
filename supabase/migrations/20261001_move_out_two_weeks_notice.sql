-- Tenants must give at least two weeks' notice when choosing their move-out date,
-- and the property's staff are notified when they do.
create or replace function public.set_own_actual_move_out_date(p_date date)
returns void language plpgsql security definer set search_path to 'public' as $function$
declare
  v_today date := (now() at time zone 'Australia/Perth')::date;
  v_tid uuid := current_tenant_id();
  v_name text; v_prop uuid;
begin
  if p_date is null or p_date < v_today + 14 then
    raise exception 'Move-out needs at least two weeks'' notice: the earliest date you can choose is %', to_char(v_today + 14, 'DD Mon YYYY')
      using errcode = 'P0001';
  end if;
  update tenants set actual_move_out_date = p_date where id = v_tid
    returning full_name, property_id into v_name, v_prop;
  if v_tid is null then return; end if;
  insert into notifications (auth_user_id, title, body, category, related_table, related_id, property_id, tenant_id)
  select p.auth_user_id, 'Move-out notice',
    coalesce(v_name,'A tenant') || ' gave notice to move out on ' || to_char(p_date,'DD Mon YYYY') ||
      ' — see their tenant page.',
    'check_out', 'tenants', v_tid, v_prop, v_tid
  from profiles p
  where p.is_active and p.auth_user_id is not null and (p.role = 'super_admin' or (p.role = 'administrator' and exists (
    select 1 from property_administrators pa where pa.profile_id = p.id and pa.property_id = v_prop)));
end $function$;
