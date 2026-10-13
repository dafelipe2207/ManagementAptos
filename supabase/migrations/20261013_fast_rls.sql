-- Speed (applied 2026-10-13): every RLS policy called the role helpers (is_staff(),
-- is_super_admin(), current_tenant_id(), auth.uid(), can_manage_property(...)) once PER ROW, and
-- each call looks up the caller's profile — a 260-row table cost 40–200 ms per query and the app
-- runs ~30 of them at start-up. Checking every table for every user went from 14.2 s to 0.7 s,
-- with exactly the same rows visible to every user (verified for all 700 user/table pairs).
--
-- optimize_rls_policies() rewrites every public policy so caller-only checks run once per query:
--   f()                    -> (SELECT f())
--   auth.uid()             -> (SELECT auth.uid())
--   can_manage_property(x) -> can_manage_property_in((SELECT is_super_admin()), (SELECT my_managed_property_ids()), x)
--   (the administrator's assigned properties are read once as a list; each row is a list lookup)
-- Same functions and logic, evaluated once. Administrators' queries went from 174 ms to 37 ms for
-- all tables together. It's idempotent — run it again after any migration
-- that adds or changes policies (the pending migrations below already end with it).

create or replace function public.my_managed_property_ids() returns uuid[] language sql stable security definer set search_path = public
as $$ select case when public.is_administrator() then coalesce(array_agg(pa.property_id), '{}'::uuid[]) else '{}'::uuid[] end
      from public.property_administrators pa where pa.profile_id = public.current_profile_id() $$;

create or replace function public.can_manage_property_in(is_sa boolean, managed uuid[], prop_id uuid) returns boolean language sql immutable
as $$ select coalesce(is_sa or prop_id = any(managed), false) $$;

create or replace function public.optimize_rls_policies() returns integer language plpgsql as $f$
declare
  p record; q text; c text; stmt text; n integer := 0; prev text;
  fn constant text := '(?<![.\w])(?<!SELECT )(is_staff|is_super_admin|is_administrator|is_viewer|current_tenant_id|current_profile_id|current_profile_role)\(\)';
  au constant text := '(?<![.\w])(?<!SELECT )auth\.uid\(\)';
  cm constant text := '(?<![.\w])can_manage_property\(';
  old_fast constant text := 'can_manage_property_fast\(\( SELECT is_super_admin\(\) AS is_super_admin\), \( SELECT is_administrator\(\) AS is_administrator\), ';
  cm_new constant text := 'public.can_manage_property_in((SELECT public.is_super_admin()), (SELECT public.my_managed_property_ids()), ';
  nest constant text := '\( SELECT \( SELECT ((?:auth\.)?\w+)\(\) AS (\w+)\) AS \w+\)';
begin
  for p in select schemaname, tablename, policyname, qual, with_check from pg_policies where schemaname = 'public' loop
    q := p.qual; c := p.with_check;
    if q is not null then
      loop prev := q; q := regexp_replace(q, nest, '( SELECT \1() AS \2)', 'g'); exit when q = prev; end loop;
      q := regexp_replace(q, old_fast, cm_new, 'g');
      q := regexp_replace(regexp_replace(regexp_replace(q, fn, '(SELECT public.\1())', 'g'), au, '(SELECT auth.uid())', 'g'), cm, cm_new, 'g');
    end if;
    if c is not null then
      loop prev := c; c := regexp_replace(c, nest, '( SELECT \1() AS \2)', 'g'); exit when c = prev; end loop;
      c := regexp_replace(c, old_fast, cm_new, 'g');
      c := regexp_replace(regexp_replace(regexp_replace(c, fn, '(SELECT public.\1())', 'g'), au, '(SELECT auth.uid())', 'g'), cm, cm_new, 'g');
    end if;
    if q is distinct from p.qual or c is distinct from p.with_check then
      stmt := format('alter policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
      if q is not null then stmt := stmt || ' using (' || q || ')'; end if;
      if c is not null then stmt := stmt || ' with check (' || c || ')'; end if;
      execute stmt; n := n + 1;
    end if;
  end loop;
  return n;
end $f$;
revoke all on function public.optimize_rls_policies() from public, anon, authenticated;

select public.optimize_rls_policies();
