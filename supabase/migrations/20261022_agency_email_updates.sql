-- Correos: follow-up emails ("Updates").
-- When an agency email continues a case that was already notified (same maintenance job, same
-- invoice, same arrears, a reply in the same Gmail thread…), the scheduled check no longer
-- creates a new notification/case for it: it adds a row here, under the original case. The
-- Correos page shows these as "Updates" inside the original card.
-- Inserting an update bumps the case's updated_at and marks the original notification unread
-- again for every admin, so the card comes back to the top / "Correos nuevos" and nothing is missed.

create table if not exists public.agency_email_updates (
  dedup_key text primary key,              -- 'agency-email:<gmail message id>' of the follow-up email
  case_dedup_key text not null references public.agency_email_cases(dedup_key) on delete cascade,
  received_at timestamptz,                 -- when the follow-up email arrived
  summary text not null,                   -- Spanish 1–2 sentence summary (+ what to do, if anything)
  action boolean not null default false,   -- true when the update asks for something / has a deadline
  url text,                                -- Gmail link
  created_at timestamptz not null default now()
);
create index if not exists agency_email_updates_case on public.agency_email_updates (case_dedup_key, received_at desc);

alter table public.agency_email_updates enable row level security;
drop policy if exists agency_email_updates_select on public.agency_email_updates;
create policy agency_email_updates_select on public.agency_email_updates for select to authenticated using ((select public.is_staff()));
grant select on public.agency_email_updates to authenticated;

create or replace function public.on_agency_email_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.agency_email_cases set updated_at = now() where dedup_key = new.case_dedup_key;
  update public.notifications set is_read = false
    where dedup_key = new.case_dedup_key and related_table = 'agency_email' and archived_at is null;
  return new;
end $$;
revoke all on function public.on_agency_email_update() from public, anon, authenticated;

drop trigger if exists agency_email_updates_after_insert on public.agency_email_updates;
create trigger agency_email_updates_after_insert after insert on public.agency_email_updates
  for each row execute function public.on_agency_email_update();
