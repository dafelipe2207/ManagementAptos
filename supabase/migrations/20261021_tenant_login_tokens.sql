-- One-tap login QR codes for tenants. Only a SHA-256 hash of each token is stored; the token itself
-- lives only in the QR / link given to the tenant. Valid 30 days, up to 3 devices; making a new QR
-- for a tenant revokes the previous one. Read and written only by the tenant-qr-login Edge Function
-- (service role) — RLS is on with no policies, so no browser can read this table.
create table if not exists public.tenant_login_tokens (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  auth_user_id uuid not null,
  created_by_profile_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  uses int not null default 0,
  max_uses int not null default 3,
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index if not exists tenant_login_tokens_tenant_idx on public.tenant_login_tokens(tenant_id);
alter table public.tenant_login_tokens enable row level security;
