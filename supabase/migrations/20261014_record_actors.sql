-- Who did what, per record, for staff (Super Admin + Administrators) — read from audit_logs,
-- which only the Super Admin can read directly. Returns, per (table, record, kind), the person
-- who did it most recently and when:
--   created  – who created the record
--   updated  – who changed it last
--   receipt  – who attached the current receipt / proof / document file
--   paid     – who last changed its paid status (bill shares)
--   status   – who last changed its status (confirmed / rejected reports, maintenance, …)
-- Changes made by the system (no signed-in user) are ignored.
create or replace function public.record_actors(p_tables text[])
returns table(table_name text, record_id uuid, kind text, actor_name text, actor_role text, at timestamptz)
language sql stable security definer set search_path = public as $$
  with ev as (
    select a.table_name, a.record_id, a.user_id, a.created_at, a.action,
      coalesce(a.new_data->>'receipt_path', a.new_data->>'proof_path', a.new_data->>'storage_path') as new_file,
      coalesce(a.old_data->>'receipt_path', a.old_data->>'proof_path', a.old_data->>'storage_path') as old_file,
      a.new_data, a.old_data
    from public.audit_logs a
    where public.is_staff()
      and a.table_name = any(p_tables)
      and a.action in ('INSERT','UPDATE')
      and a.record_id is not null
      and a.user_id is not null
  ), flat as (
    select table_name, record_id, user_id, created_at, 'created'::text as kind from ev where action = 'INSERT'
    union all
    select table_name, record_id, user_id, created_at, 'updated' from ev where action = 'UPDATE'
    union all
    -- The person who put the file there. On insert only for records where the inserter is the
    -- uploader (reports and documents); a payment created from a report carries the tenant's file.
    select table_name, record_id, user_id, created_at, 'receipt' from ev
      where new_file is not null and (
        (action = 'UPDATE' and new_file is distinct from old_file) or
        (action = 'INSERT' and table_name in ('rent_payment_reports','payment_reports','tenant_documents','bills','lease_payments')))
    union all
    select table_name, record_id, user_id, created_at, 'paid' from ev
      where action = 'UPDATE' and (new_data->>'paid') is distinct from (old_data->>'paid')
    union all
    select table_name, record_id, user_id, created_at, 'status' from ev
      where action = 'UPDATE' and (new_data->>'status') is distinct from (old_data->>'status')
  )
  select distinct on (f.table_name, f.record_id, f.kind)
    f.table_name, f.record_id, f.kind,
    coalesce(nullif(trim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')), ''), p.email, 'Unknown user'),
    p.role, f.created_at
  from flat f left join public.profiles p on p.auth_user_id = f.user_id
  order by f.table_name, f.record_id, f.kind, f.created_at desc
$$;
revoke all on function public.record_actors(text[]) from public;
grant execute on function public.record_actors(text[]) to authenticated;
