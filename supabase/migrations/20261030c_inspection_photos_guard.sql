-- Database-side version of the rules the Inspection screen already shows (app.js,
-- canAddInspectionPhotosNow). Only affects a signed-in TENANT; staff, viewers and server-side jobs
-- (no tenant row for the caller) are never blocked.
--   move_in : the tenant can add photos until 5 days after move-in, or until
--             tenants.move_in_photos_extended_until if staff gave them more days (whichever is later).
--   move_out: only once the tenant has a move-out date (actual or expected) — before that they
--             haven't left, so there is nothing to photograph.
-- It runs when a submission row is inserted, or when an update ADDS photos to one (removing photos
-- is always allowed). Photo files themselves can still reach the storage bucket, but they only show
-- up in the app once attached to a submission row, which this blocks.
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
    v_deadline := v_t.move_in_date + 5;
    if v_t.move_in_photos_extended_until is not null and v_t.move_in_photos_extended_until > v_deadline then
      v_deadline := v_t.move_in_photos_extended_until;
    end if;
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

drop trigger if exists inspection_submissions_guard on public.inspection_submissions;
create trigger inspection_submissions_guard
  before insert or update of photo_paths on public.inspection_submissions
  for each row execute function public.guard_inspection_photos();
