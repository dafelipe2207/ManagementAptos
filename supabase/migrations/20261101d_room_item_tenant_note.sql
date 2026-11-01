-- A tenant can leave an observation about a room item (a stain on the pillow, a wobbly bedside table…).
-- It is stored in tenants.room_items_check -> <item id> -> { n: text, na: date, v: reviewed date }.
-- Tenants have no UPDATE on `tenants`, so this narrow function writes only that note on the caller's own
-- row, always resets the administrator's review ("v") and notifies the property's administrators.
create or replace function public.set_own_room_item_note(p_item_id text, p_note text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tid uuid := current_tenant_id();
  v_name text; v_prop uuid; v_room uuid; v_check jsonb;
  v_item text;
  v_note text := nullif(left(trim(coalesce(p_note, '')), 400), '');
  v_today date := (now() at time zone 'Australia/Perth')::date;
  v_cur jsonb;
begin
  if v_tid is null then return; end if;
  select full_name, property_id, room_id, coalesce(room_items_check, '{}'::jsonb)
    into v_name, v_prop, v_room, v_check from tenants where id = v_tid;
  select it->>'name' into v_item from rooms r, jsonb_array_elements(r.items) it
    where r.id = v_room and it->>'id' = p_item_id;
  if v_item is null then raise exception 'That item is not in your room.' using errcode = 'P0001'; end if;
  v_cur := coalesce(v_check -> p_item_id, '{}'::jsonb);
  if v_note is null then
    v_cur := v_cur - 'n' - 'na' - 'v';
  else
    v_cur := (v_cur || jsonb_build_object('n', v_note, 'na', v_today::text)) - 'v';
  end if;
  update tenants set room_items_check = jsonb_set(coalesce(room_items_check, '{}'::jsonb), array[p_item_id], v_cur, true) where id = v_tid;
  if v_note is not null then
    insert into notifications (auth_user_id, title, body, category, related_table, related_id, property_id, tenant_id)
    select p.auth_user_id, 'Room item observation: ' || v_item,
      coalesce(v_name, 'A tenant') || ' left an observation about "' || v_item || '" — open their page to review it.',
      'check_in', 'tenants', v_tid, v_prop, v_tid
    from profiles p
    where p.is_active and p.auth_user_id is not null and (p.role = 'super_admin' or (p.role = 'administrator' and exists (
      select 1 from property_administrators pa where pa.profile_id = p.id and pa.property_id = v_prop)));
  end if;
end $function$;
revoke all on function public.set_own_room_item_note(text, text) from public;
grant execute on function public.set_own_room_item_note(text, text) to authenticated;
