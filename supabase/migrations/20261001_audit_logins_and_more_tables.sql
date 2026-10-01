-- 1) Log every sign-in / app open (one entry per user per 30 minutes, so reloads don't flood it).
create or replace function public.log_app_login(p_device text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  if exists (select 1 from public.audit_logs where user_id = auth.uid() and action = 'LOGIN'
             and created_at > now() - interval '30 minutes') then return; end if;
  insert into public.audit_logs(user_id, action, table_name, record_id, old_data, new_data)
  values (auth.uid(), 'LOGIN', 'session', null, null, jsonb_build_object('device', left(coalesce(p_device,''), 200)));
end $$;
revoke all on function public.log_app_login(text) from public;
grant execute on function public.log_app_login(text) to authenticated;

-- 2) Record changes on the tables tenants and staff work with day to day (same trigger as the rest).
do $$
declare t text;
begin
  foreach t in array array['bill_allocations','payment_reports','rent_payment_reports','bonds','maintenance_requests',
    'real_estate_inspections','recurring_bills','move_out_settlements','tenant_documents','cleaning_submissions','inspection_submissions']
  loop
    execute format('drop trigger if exists audit_%1$s on public.%1$I', t);
    execute format('create trigger audit_%1$s after insert or update or delete on public.%1$I for each row execute function public.write_audit_log()', t);
  end loop;
end $$;

create index if not exists audit_logs_created_at_idx on public.audit_logs (created_at desc);
create index if not exists audit_logs_user_action_idx on public.audit_logs (user_id, action, created_at desc);
