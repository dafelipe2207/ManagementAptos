-- Correos (agency emails) follow-up.
-- * agency_email_cases: one row per agency email (keyed by the notifications' dedup_key
--   'agency-email:<gmail message id>', shared by every admin's copy of that notification).
--   Holds who is responsible for the follow-up, and — for invoices — the invoice number /
--   amount / linked bill so the app can show live whether it is loaded and paid.
-- * agency_email_checks: one row per run of the scheduled Gmail check, so the Correos page
--   can show when the agencies' emails were last checked even when nothing new arrived.
-- * agency_email_staff(): the active Super Admin + administrators (id, name, role) for the
--   "Responsable" picker — administrators can't read other profiles directly.

create table if not exists public.agency_email_cases (
  dedup_key text primary key,
  kind text,                 -- invoice | arrears | receipt | inspection | maintenance | strata | lease | other
  property_id uuid references public.properties(id) on delete set null,
  invoice_number text,
  amount numeric,
  due_date date,
  bill_id uuid references public.bills(id) on delete set null,
  assigned_profile_id uuid references public.profiles(id) on delete set null,
  assigned_at timestamptz,
  assigned_by_profile_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.touch_agency_email_case() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists agency_email_cases_touch on public.agency_email_cases;
create trigger agency_email_cases_touch before update on public.agency_email_cases
  for each row execute function public.touch_agency_email_case();

alter table public.agency_email_cases enable row level security;
drop policy if exists agency_email_cases_select on public.agency_email_cases;
create policy agency_email_cases_select on public.agency_email_cases for select to authenticated using ((select public.is_staff()));
drop policy if exists agency_email_cases_insert on public.agency_email_cases;
create policy agency_email_cases_insert on public.agency_email_cases for insert to authenticated with check ((select public.is_staff()));
drop policy if exists agency_email_cases_update on public.agency_email_cases;
create policy agency_email_cases_update on public.agency_email_cases for update to authenticated using ((select public.is_staff())) with check ((select public.is_staff()));

create table if not exists public.agency_email_checks (
  id uuid primary key default gen_random_uuid(),
  checked_at timestamptz not null default now(),
  emails_found integer not null default 0,
  notified integer not null default 0
);
create index if not exists agency_email_checks_checked_at on public.agency_email_checks (checked_at desc);

alter table public.agency_email_checks enable row level security;
drop policy if exists agency_email_checks_select on public.agency_email_checks;
create policy agency_email_checks_select on public.agency_email_checks for select to authenticated using ((select public.is_staff()));

create or replace function public.agency_email_staff()
returns table (id uuid, name text, role text, auth_user_id uuid)
language sql stable security definer set search_path = public as $$
  select p.id, trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), p.role, p.auth_user_id
  from public.profiles p
  where public.is_staff() and p.is_active and p.role in ('super_admin', 'administrator')
  order by case p.role when 'super_admin' then 0 else 1 end, p.first_name;
$$;
revoke all on function public.agency_email_staff() from public, anon;
grant execute on function public.agency_email_staff() to authenticated;
grant select, insert, update on public.agency_email_cases to authenticated;
grant select on public.agency_email_checks to authenticated;

-- What each agency email is about: a maintenance request or a real-estate inspection in the app
-- (bills use bill_id above). linked_auto = set by the scheduled check (or backfill) rather than
-- chosen by an admin, so the app can say "asociado automáticamente".
alter table public.agency_email_cases
  add column if not exists linked_table text check (linked_table in ('maintenance_requests','real_estate_inspections')),
  add column if not exists linked_id uuid,
  add column if not exists linked_auto boolean not null default false,
  add column if not exists linked_by_profile_id uuid references public.profiles(id) on delete set null;
