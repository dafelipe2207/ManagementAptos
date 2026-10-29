-- Same function as 20261029_checkout_steps_notification.sql, just with the check-out steps text
-- made more dynamic (an icon per requirement, extra spacing) to match app.js's checkoutStepsText.
create or replace function public.set_own_actual_move_out_date(p_date date)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
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

  insert into notifications (auth_user_id, title, body, category, related_table, related_id, property_id, tenant_id, dedup_key)
  values (auth.uid(), 'Your move-out steps',
    '📅 Your move-out date: ' || to_char(p_date,'FMDD Mon YYYY') || E'\n⏰ Check-out by 12:00 PM' || E'\n\n' ||
    '📦 Tenant Check-out Requirements' || E'\n' ||
    'When moving out, tenants must ensure that the room and all assigned areas are left clean and tidy, in the same condition as they were provided.' || E'\n\n' ||
    '🛏️ Bedroom: The room must be thoroughly cleaned before departure.' || E'\n\n' ||
    '🍳 Kitchen: All assigned drawers and the tenant’s designated space in the fridge must be cleaned and left empty.' || E'\n\n' ||
    '🚿 Private bathroom: If the room includes a private bathroom, it must be thoroughly cleaned and left in the same condition as when the tenant moved in.' || E'\n\n' ||
    '🧺 Bed linen: All provided bed linen must be washed before departure.' || E'\n\n' ||
    '📸 Move-out photos: Once the room is clean, take photos of the room and your assigned areas and upload them in the app (Inspection → Move-out photos) before you leave.' || E'\n\n' ||
    '🔑 Keys: All keys must be left on the bedside table.' || E'\n\n' ||
    '💳 Rent and bills: All outstanding rent and utility bills must be paid in full before moving out.' || E'\n\n' ||
    '⚠️ Important: If any of these requirements are not met, an additional cleaning or service charge may apply, where appropriate and permitted under the applicable agreement and tenancy laws. Any applicable charge will depend on the work required to address the issue.' || E'\n' ||
    'Please ensure that all requirements are completed before vacating the property to avoid additional charges.',
    'check_out', 'tenants', v_tid, v_prop, v_tid,
    'checkout-steps:' || v_tid::text || ':' || to_char(p_date,'YYYY-MM-DD'))
  on conflict (auth_user_id, dedup_key) do nothing;
end $function$;
