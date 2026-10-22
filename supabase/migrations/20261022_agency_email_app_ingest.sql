-- Agency emails processed by the app itself (Gmail Apps Script → Edge Function agency-email → Gemini).
-- * agency_email_checks gets updates / errors / source ('claude' for the old scheduled task, 'app' now).
-- * agency_email_runs: per-run counters, so the batches of one script run add up to one checks row.
--   Service role only (RLS on, no policies).

alter table public.agency_email_checks
  add column if not exists updates integer not null default 0,
  add column if not exists errors integer not null default 0,
  add column if not exists source text not null default 'claude';

create table if not exists public.agency_email_runs (
  run_id text primary key,
  emails_found integer not null default 0,
  notified integer not null default 0,
  updates integer not null default 0,
  errors integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.agency_email_runs enable row level security;
revoke all on public.agency_email_runs from anon, authenticated;

-- Atomic per-batch counter bump (service role).
create or replace function public.agency_email_run_add(p_run_id text, p_found int, p_notified int, p_updates int, p_errors int)
returns public.agency_email_runs
language sql security definer set search_path = public as $$
  insert into public.agency_email_runs as r (run_id, emails_found, notified, updates, errors)
  values (p_run_id, p_found, p_notified, p_updates, p_errors)
  on conflict (run_id) do update set
    emails_found = r.emails_found + excluded.emails_found,
    notified = r.notified + excluded.notified,
    updates = r.updates + excluded.updates,
    errors = r.errors + excluded.errors
  returning r.*;
$$;
revoke all on function public.agency_email_run_add(text, int, int, int, int) from public, anon, authenticated;

-- Webhook token kept in the database too (service role only), so the function works even if the
-- AGENCY_EMAIL_TOKEN secret isn't set. The value itself is inserted outside the repo.
create table if not exists public.agency_email_settings (key text primary key, value text not null, updated_at timestamptz not null default now());
alter table public.agency_email_settings enable row level security;
revoke all on public.agency_email_settings from anon, authenticated;
