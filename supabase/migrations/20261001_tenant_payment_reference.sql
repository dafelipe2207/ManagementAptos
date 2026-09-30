-- Permanent per-tenant payment reference (e.g. NOE105): first 4 letters of the first name + a
-- sequential number. Auto-assigned on insert; quoted on rent and bill payments and saved with
-- each payment report so receipts can be matched to the tenant.
create sequence if not exists public.tenant_payment_ref_seq start 101;
alter table public.tenants add column if not exists payment_reference text;
create or replace function public.make_tenant_payment_reference(p_name text)
returns text language plpgsql as $$
declare
  letters text := upper(left(regexp_replace(translate(coalesce(split_part(trim(p_name),' ',1),''),
    'áéíóúàèìòùäëïöüâêîôûñçÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÂÊÎÔÛÑÇ','aeiouaeiouaeiouaeiouncAEIOUAEIOUAEIOUAEIOUNC'), '[^A-Za-z]', '', 'g'), 4));
begin
  if letters = '' then letters := 'TEN'; end if;
  return letters || nextval('public.tenant_payment_ref_seq')::text;
end $$;
create or replace function public.tenants_set_payment_reference()
returns trigger language plpgsql as $$
begin
  if new.payment_reference is null or new.payment_reference = '' then
    new.payment_reference := public.make_tenant_payment_reference(new.full_name);
  end if;
  return new;
end $$;
drop trigger if exists tenants_payment_reference on public.tenants;
create trigger tenants_payment_reference before insert on public.tenants
  for each row execute function public.tenants_set_payment_reference();
do $$ declare r record; begin
  for r in select id, full_name from public.tenants where payment_reference is null order by created_at loop
    update public.tenants set payment_reference = public.make_tenant_payment_reference(r.full_name) where id = r.id;
  end loop;
end $$;
create unique index if not exists tenants_payment_reference_key on public.tenants (payment_reference);
alter table public.rent_payment_reports add column if not exists tenant_reference text;
alter table public.payment_reports add column if not exists tenant_reference text;
