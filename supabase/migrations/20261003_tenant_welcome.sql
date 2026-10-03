-- Welcome guide for new tenants: shown on their first sign-ins until they finish it.
alter table public.tenants add column if not exists welcome_seen_at timestamptz;

-- Tenants already settled in (moved in more than a week ago) don't need the guide.
update public.tenants set welcome_seen_at = now()
where welcome_seen_at is null and move_in_date < ((now() at time zone 'Australia/Perth')::date - 7);

-- Tenants have no UPDATE grant on tenants under RLS: this narrow function only stamps
-- welcome_seen_at on the caller's own row.
create or replace function public.mark_own_welcome_seen()
returns void language plpgsql security definer set search_path to 'public' as $function$
begin
  update tenants set welcome_seen_at = now() where id = current_tenant_id() and welcome_seen_at is null;
end $function$;
revoke all on function public.mark_own_welcome_seen() from public;
grant execute on function public.mark_own_welcome_seen() to authenticated;
