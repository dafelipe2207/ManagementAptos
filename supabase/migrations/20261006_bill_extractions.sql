-- Bill extraction records: one row per uploaded bill document, from the moment it's read until
-- the administrator confirms it as a bill (or discards it). Keeps an audit trail of what the
-- readers detected versus what was finally confirmed, and lets the "Pending review" queue
-- survive a page reload.
--   storage_path       original document, in the private `receipts` bucket
--   extractor          'azure' | 'gemini' | 'azure+gemini' | 'known_account' | 'manual' | 'failed'
--   extracted          full JSON returned by the analyze-bill Edge Function (fields, per-field
--                      confidence and source, line items, issues)
--   confidence         overall confidence of the key fields (null when not measurable)
--   status             'needs_review' | 'ready' (waiting for the admin) | 'confirmed' | 'discarded'
--   issues             validation issues at extraction time
--   confirmed          the final values the admin saved (+ which warnings they acknowledged)
--   bill_id            the bill created from it, once confirmed

create table if not exists public.bill_extractions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid(),
  property_id uuid references public.properties(id) on delete set null,
  bill_id uuid references public.bills(id) on delete set null,
  storage_path text,
  file_name text,
  mime_type text,
  extractor text not null default 'manual',
  extracted jsonb,
  confidence numeric,
  status text not null default 'needs_review'
    check (status in ('needs_review', 'ready', 'confirmed', 'discarded')),
  issues jsonb not null default '[]'::jsonb,
  confirmed jsonb,
  confirmed_at timestamptz,
  confirmed_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bill_extractions_status_idx on public.bill_extractions (status);
create index if not exists bill_extractions_bill_idx on public.bill_extractions (bill_id);

alter table public.bill_extractions enable row level security;

-- Staff who uploaded it, a Super Admin, or an administrator assigned to the property can see and
-- work on a record. Tenants have no access.
drop policy if exists "Staff can read bill extractions" on public.bill_extractions;
create policy "Staff can read bill extractions" on public.bill_extractions for select to authenticated
  using (public.is_super_admin() or (public.is_staff() and user_id = auth.uid())
         or (property_id is not null and public.can_manage_property(property_id)));

drop policy if exists "Staff can add bill extractions" on public.bill_extractions;
create policy "Staff can add bill extractions" on public.bill_extractions for insert to authenticated
  with check (public.is_staff() and user_id = auth.uid()
              and (property_id is null or public.can_manage_property(property_id)));

drop policy if exists "Staff can update bill extractions" on public.bill_extractions;
create policy "Staff can update bill extractions" on public.bill_extractions for update to authenticated
  using (public.is_super_admin() or (public.is_staff() and user_id = auth.uid())
         or (property_id is not null and public.can_manage_property(property_id)))
  with check (public.is_super_admin()
              or (public.is_staff() and (property_id is null or public.can_manage_property(property_id))));

drop policy if exists "Super Admin can delete bill extractions" on public.bill_extractions;
create policy "Super Admin can delete bill extractions" on public.bill_extractions for delete to authenticated
  using (public.is_super_admin());

create or replace function public.bill_extractions_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists bill_extractions_touch on public.bill_extractions;
create trigger bill_extractions_touch before update on public.bill_extractions
  for each row execute function public.bill_extractions_touch();
