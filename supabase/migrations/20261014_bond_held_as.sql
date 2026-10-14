alter table public.bonds add column if not exists held_as text not null default 'transfer' check (held_as in ('transfer','cash'));
