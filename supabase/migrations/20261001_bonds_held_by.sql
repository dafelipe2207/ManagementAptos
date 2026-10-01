-- Who is holding the tenant's bond money.
alter table public.bonds add column if not exists held_by text;
alter table public.bonds drop constraint if exists bonds_held_by_check;
alter table public.bonds add constraint bonds_held_by_check check (held_by is null or held_by in ('Daniel','Geraldine'));
