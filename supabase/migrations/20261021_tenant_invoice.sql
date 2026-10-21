-- Tenant invoice: a clean PDF copy of the real estate's invoice (same values, no agency/owner
-- details), made in the app (lib/tenantInvoice.js) and attached to the bill. Tenants open it
-- instead of the original document (tenant-bill-receipt Edge Function).
-- * bills.tenant_invoice_path: the PDF in the `receipts` bucket.
-- * bills.tenant_invoice_data: the fields the PDF is drawn from (invoice #, folio, created/due
--   date, bill-to, description, amounts; `water` = meter/usage/tier details for the
--   Water-Corporation-style layout).
-- * agency_email_cases.invoice_doc: the same fields as read from the agency's email by the
--   scheduled check, used when the bill itself has none.
alter table public.bills
  add column if not exists tenant_invoice_path text,
  add column if not exists tenant_invoice_data jsonb;
alter table public.agency_email_cases add column if not exists invoice_doc jsonb;
