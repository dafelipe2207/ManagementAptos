-- One-off backfill: receipts tenants attached to payment reports that were already confirmed
-- become the receipt of the bill share / rent payment, so staff can see them.
update public.bill_allocations ba set receipt_path = pr.proof_path
from public.payment_reports pr
where pr.allocation_id = ba.id and pr.status = 'confirmed' and pr.proof_path is not null and ba.receipt_path is null;
update public.payments p set receipt_path = r.proof_path
from public.rent_payment_reports r
where r.payment_id = p.id and r.proof_path is not null and p.receipt_path is null;
