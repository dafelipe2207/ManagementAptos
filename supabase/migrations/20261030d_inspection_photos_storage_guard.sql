-- Storage side of 20261030c_inspection_photos_guard.sql. The file's path doesn't say whether a photo is
-- for move-in or move-out, so the rule is the union of both: a TENANT may upload to the inspection-photos
-- bucket while they are inside their move-in window (5 days from move-in, or the extension staff gave
-- them) OR once they have a move-out date. Outside both, nothing can be uploaded at all.
-- Staff, viewers and server-side jobs (no tenant row for the caller) are never limited. It is a
-- RESTRICTIVE policy, so it is ANDed with the existing permissive ones and only touches this bucket.
-- Applied to production via the Supabase MCP on 2026-10-30.
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
  v_deadline := v_t.move_in_date + 5;
  if v_t.move_in_photos_extended_until is not null and v_t.move_in_photos_extended_until > v_deadline then
    v_deadline := v_t.move_in_photos_extended_until;
  end if;
  return v_today <= v_deadline;
end $function$;
revoke all on function public.tenant_may_upload_inspection_photos() from public;
grant execute on function public.tenant_may_upload_inspection_photos() to authenticated;

drop policy if exists tenant_inspection_photos_window on storage.objects;
create policy tenant_inspection_photos_window on storage.objects
  as restrictive for insert to authenticated
  with check (bucket_id <> 'inspection-photos' or public.tenant_may_upload_inspection_photos());
