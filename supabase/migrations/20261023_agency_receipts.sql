-- Payment receipts the real estate sends by email (PDF): kept as "Real estate receipt" next to the
-- rent payment to the agency (lease_payments) or the bill they cover, without replacing the
-- receipt the admin uploaded. One row per receipt email in agency_email_receipts (what was read
-- from the PDF and where it was attached). Written by the agency-email Edge Function.
alter table public.lease_payments
  add column if not exists agency_receipt_path text,
  add column if not exists agency_receipt_number text;
alter table public.bills
  add column if not exists agency_receipt_path text;

create table if not exists public.agency_email_receipts (
  dedup_key text primary key,              -- 'agency-email:<gmail id>' of the receipt email
  property_id uuid references public.properties(id) on delete set null,
  storage_path text not null,              -- PDF in the private `receipts` bucket
  file_name text,
  receipt_number text,
  amount numeric,
  paid_date date,
  items jsonb,                             -- what the PDF says was paid: [{kind, amount, invoiceNumber, description}]
  targets jsonb not null default '[]',     -- where it was attached: [{table:'lease_payments'|'bills', id}]
  created_at timestamptz not null default now()
);
alter table public.agency_email_receipts enable row level security;
create policy agency_email_receipts_select on public.agency_email_receipts for select to authenticated using ((select public.is_staff()));
create policy agency_email_receipts_update on public.agency_email_receipts for update to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));
grant select, update on public.agency_email_receipts to authenticated;
