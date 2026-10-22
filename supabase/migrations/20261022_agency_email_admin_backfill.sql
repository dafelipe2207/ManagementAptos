-- Correos: each agency email is one notification per admin, created when the email arrives. An
-- administrator assigned to a property LATER never got the emails that were already there, so their
-- Correos page was empty. Now assigning an administrator to a property copies that property's agency
-- emails of the last 60 days to them (same title/body/date/archived state, unread).
create or replace function public.agency_email_copy_to_admin(p_profile_id uuid, p_property_id uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare v_auth uuid; v_n integer;
begin
  select auth_user_id into v_auth from profiles where id = p_profile_id and role in ('administrator','super_admin') and is_active;
  if v_auth is null then return 0; end if;
  insert into notifications (auth_user_id, title, body, category, property_id, related_table, is_read, dedup_key, created_at, archived_at)
  select distinct on (n.dedup_key) v_auth, n.title, n.body, n.category, n.property_id, 'agency_email', false, n.dedup_key, n.created_at, n.archived_at
  from notifications n
  where n.related_table = 'agency_email' and n.dedup_key like 'agency-email:%' and n.property_id = p_property_id
    and n.created_at > now() - interval '60 days'
  order by n.dedup_key, n.created_at
  on conflict (auth_user_id, dedup_key) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.agency_email_copy_to_admin(uuid, uuid) from public, anon, authenticated;

create or replace function public.on_property_admin_assigned() returns trigger
language plpgsql security definer set search_path = public as $$
begin perform public.agency_email_copy_to_admin(new.profile_id, new.property_id); return new; end $$;
revoke all on function public.on_property_admin_assigned() from public, anon, authenticated;

create or replace trigger property_admin_agency_emails after insert on public.property_administrators
  for each row execute function public.on_property_admin_assigned();

-- One-time backfill for administrators already assigned.
select public.agency_email_copy_to_admin(pa.profile_id, pa.property_id)
from property_administrators pa join profiles p on p.id = pa.profile_id where p.role = 'administrator';
