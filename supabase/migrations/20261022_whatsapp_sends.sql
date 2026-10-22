-- WhatsApp sends of bills, so admins don't send the same thing twice: one row per bill per send —
-- to a tenant (kind 'tenant', tenant_id set) or to the property's WhatsApp group (kind 'group').
-- Who sent it and when. The app checks this table (fresh) before opening a send and warns when
-- another admin already sent it.
create table if not exists public.whatsapp_sends (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('tenant', 'group')),
  bill_id uuid references public.bills(id) on delete cascade, -- null = a statement with rent only
  tenant_id uuid references public.tenants(id) on delete cascade,
  sent_by_profile_id uuid references public.profiles(id) on delete set null,
  sent_at timestamptz not null default now()
);
create index if not exists whatsapp_sends_bill on public.whatsapp_sends (bill_id, sent_at desc);
create index if not exists whatsapp_sends_tenant on public.whatsapp_sends (tenant_id, sent_at desc);

alter table public.whatsapp_sends enable row level security;
drop policy if exists whatsapp_sends_select on public.whatsapp_sends;
create policy whatsapp_sends_select on public.whatsapp_sends for select to authenticated using ((select public.is_staff()));
drop policy if exists whatsapp_sends_insert on public.whatsapp_sends;
create policy whatsapp_sends_insert on public.whatsapp_sends for insert to authenticated with check ((select public.is_staff()));
grant select, insert on public.whatsapp_sends to authenticated;
