alter table public.bonds add column if not exists deposits jsonb not null default '[]'::jsonb;
