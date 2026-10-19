-- The amount the tenant says they transferred when reporting bill payments (one transfer can
-- cover several bills, and rent too). Optional: older reports have none.
alter table public.payment_reports add column if not exists amount numeric(12,2) check (amount is null or amount > 0);
