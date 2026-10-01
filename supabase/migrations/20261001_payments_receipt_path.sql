-- Receipt (photo/PDF in the private `receipts` bucket) attached to a rent payment — uploaded by
-- the administrator, or carried over from the tenant's confirmed "I paid" report.
alter table public.payments add column if not exists receipt_path text;
