-- History of the admin's rent payments to the real estate (one row per period paid), each with an
-- optional invoice/receipt file in the private `receipts` bucket. Staff only — tenants never see it.
create table if not exists public.lease_payments (
  id uuid primary key default gen_random_uuid(),
  property_id uuid not null references public.properties(id) on delete cascade,
  period_start date not null,
  period_end date,
  amount numeric(10,2),
  paid_date date,
  method text,
  receipt_path text,
  notes text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists lease_payments_property_idx on public.lease_payments(property_id, period_start desc);
alter table public.lease_payments enable row level security;
create policy lease_payments_staff_select on public.lease_payments for select using (can_manage_property(property_id));
create policy lease_payments_staff_insert on public.lease_payments for insert with check (can_manage_property(property_id));
create policy lease_payments_staff_update on public.lease_payments for update using (can_manage_property(property_id)) with check (can_manage_property(property_id));
create policy lease_payments_staff_delete on public.lease_payments for delete using (can_manage_property(property_id));
create trigger audit_lease_payments after insert or update or delete on public.lease_payments
  for each row execute function write_audit_log();
alter publication supabase_realtime add table public.lease_payments;

-- Seed the history with the last period already marked as paid on each property.
insert into public.lease_payments (property_id, period_start, period_end, amount, method, notes, created_by)
select p.id, p.last_lease_payment_date,
  case when p.lease_payment_frequency = 'fortnightly' then p.last_lease_payment_date + 13
       else (p.last_lease_payment_date + interval '1 month')::date - 1 end,
  p.lease_payment_amount, p.lease_payment_method, 'Recorded before payment history existed', null
from public.properties p
where p.last_lease_payment_date is not null
  and not exists (select 1 from public.lease_payments lp where lp.property_id = p.id and lp.period_start = p.last_lease_payment_date);
