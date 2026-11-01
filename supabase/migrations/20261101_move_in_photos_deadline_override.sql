-- Staff can now move a tenant's move-in photos deadline earlier as well as later (app.js,
-- extendMoveInPhotos with "Add days" / "Remove days"). tenants.move_in_photos_extended_until is
-- therefore the deadline itself whenever it is set (before: only used when later than move-in + 5).
-- Existing values were all later than the default, so nothing changes for them.
create or replace function public.guard_inspection_photos()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tid uuid := current_tenant_id();
  v_today date := (now() at time zone 'Australia/Perth')::date;
  v_t tenants%rowtype;
  v_deadline date;
begin
  if v_tid is null then return new; end if; -- staff / viewer / server-side: no limits here
  if tg_op = 'UPDATE' then
    if coalesce(jsonb_array_length(new.photo_paths), 0) <= coalesce(jsonb_array_length(old.photo_paths), 0) then
      return new; -- only removing (or keeping) photos
    end if;
  end if;
  select * into v_t from tenants where id = v_tid;
  if not found then return new; end if;

  if new.type = 'move_in' then
    v_deadline := coalesce(v_t.move_in_photos_extended_until, v_t.move_in_date + 5);
    if v_today > v_deadline then
      raise exception 'The time to upload move-in photos has ended. Ask your administrator for more days.' using errcode = 'P0001';
    end if;
  elsif new.type = 'move_out' then
    if v_t.actual_move_out_date is null and v_t.expected_move_out_date is null then
      raise exception 'Move-out photos open once you give your move-out notice.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $function$;

create or replace function public.tenant_may_upload_inspection_photos()
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_tid uuid := current_tenant_id();
  v_today date := (now() at time zone 'Australia/Perth')::date;
  v_t tenants%rowtype;
  v_deadline date;
begin
  if v_tid is null then return true; end if;
  select * into v_t from tenants where id = v_tid;
  if not found then return true; end if;
  if v_t.actual_move_out_date is not null or v_t.expected_move_out_date is not null then return true; end if;
  v_deadline := coalesce(v_t.move_in_photos_extended_until, v_t.move_in_date + 5);
  return v_today <= v_deadline;
end $function$;
