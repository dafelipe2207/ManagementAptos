alter table public.properties add column if not exists listing_info jsonb not null default '{}'::jsonb;
