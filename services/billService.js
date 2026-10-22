// services/billService.js
// Maps the camelCase `bill` shape (propertyId, billType, provider,
// accountNumber, invoiceNumber, issueDate, dueDate, billingPeriodStart, billingPeriodEnd,
// amount, status, allocationMethod, receiptPath, notes, adminPaid,
// adminPaidDate, adminReceiptPath) to/from `bills`.
// `receiptPath` is the original bill/invoice document. `adminPaid`/
// `adminPaidDate`/`adminReceiptPath` track a SEPARATE payment: the admin
// forwarding the money to the provider (only allowed once tenants have
// paid their shares — see billReadyForAdminPayment in app.js) — distinct
// from each tenant's own allocation.paid/paidDate/receiptPath in
// billAllocationService.js.
// Allocations live in a separate table — see billAllocationService.js;
// app.js attaches `bill.allocations` after loading both in parallel.
import { supabase } from '../lib/supabaseClient.js';
import { removeById } from '../lib/db.js';
import { describeFunctionError } from '../lib/errors.js?v=2';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  const b = {
    id: row.id,
    propertyId: row.property_id,
    billType: row.type,
    provider: row.provider || '',
    accountNumber: row.account_number || '',
    invoiceNumber: row.invoice_number || '',
    issueDate: row.issue_date,
    dueDate: row.due_date,
    billingPeriodStart: row.billing_period_start,
    billingPeriodEnd: row.billing_period_end,
    amount: Number(row.amount) || 0,
    status: row.status,
    notes: row.notes || '',
    adminPaid: !!row.admin_paid,
    adminPaidDate: row.admin_paid_date || null
  };
  if (row.allocation_method) b.allocationMethod = row.allocation_method;
  if (row.receipt_path) b.receiptPath = row.receipt_path;
  if (row.admin_receipt_path) b.adminReceiptPath = row.admin_receipt_path;
  // The clean invoice made for tenants (no agency/owner details) — shown to tenants instead of
  // the original document once attached. tenantInvoiceData = the fields it's drawn from.
  b.tenantInvoicePath = row.tenant_invoice_path || null;
  b.tenantInvoiceData = row.tenant_invoice_data || null;
  b.whatsappGroupSharedAt = row.whatsapp_group_shared_at || null;
  b.whatsappGroupShareCount = Number(row.whatsapp_group_share_count) || 0;
  return b;
}

function toRow(b) {
  return {
    property_id: b.propertyId,
    type: b.billType,
    provider: b.provider,
    account_number: b.accountNumber || null,
    invoice_number: b.invoiceNumber || null,
    issue_date: b.issueDate,
    due_date: b.dueDate,
    billing_period_start: b.billingPeriodStart,
    billing_period_end: b.billingPeriodEnd,
    amount: b.amount,
    status: b.status,
    allocation_method: b.allocationMethod || null,
    receipt_path: b.receiptPath || null,
    notes: b.notes || null,
    admin_paid: !!b.adminPaid,
    admin_paid_date: b.adminPaidDate || null,
    admin_receipt_path: b.adminReceiptPath || null
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('bills').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  return data.map(fromRow);
}

/** An account number belongs to one property: refuse to save it on a bill of another property
 *  (a Footscray invoice number once ended up as the "account" of a Kewdale bill). The same number
 *  on several bills of the SAME property is normal. */
async function assertAccountBelongsToProperty(row, ownId) {
  const acct = (row.account_number || '').trim();
  if (!acct || !row.property_id) return;
  let q = supabase.from('bills').select('id, property_id, properties(name)')
    .ilike('account_number', acct.replace(/[%_\\]/g, (c) => '\\' + c))
    .neq('property_id', row.property_id).limit(1);
  if (ownId) q = q.neq('id', ownId);
  const { data, error } = await q;
  if (error || !data || !data.length) return; // never block a save because the check itself failed
  const other = (data[0].properties && data[0].properties.name) || 'another property';
  throw new Error('Account number ' + acct + ' is already used by a bill of ' + other +
    '. Each property has its own account number — check it against the bill (or leave it empty).');
}

export async function create(b) {
  const userId = await getCurrentUserId();
  const row = toRow(b);
  row.user_id = userId;
  await assertAccountBelongsToProperty(row, null);
  const { data, error } = await supabase.from('bills').insert(row).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function update(id, b) {
  const row = toRow(b);
  await assertAccountBelongsToProperty(row, id);
  const { data, error } = await supabase.from('bills').update(row).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function remove(id) {
  return removeById('bills', id);
}

/** Signed URL for a bill's original document (photo/PDF), via the tenant-bill-receipt Edge
 *  Function — needed for a TENANT because the file lives under the staff uploader's storage
 *  folder, which plain storage RLS won't let a tenant read directly (see that function's own
 *  comment). Staff can call this too; it just checks their role instead of an allocation. */
export async function getTenantReceiptUrl(billId) {
  const res = await supabase.functions.invoke('tenant-bill-receipt', { body: { billId } });
  if (res.error) throw await describeFunctionError(res.error);
  if (res.data && res.data.error) throw new Error(res.data.error);
  return res.data && res.data.url;
}


/** Records that this bill was sent to the property's WhatsApp group (or clears it with
 *  `shared=false`). Kept out of toRow() so ordinary bill edits never overwrite it. */
export async function setWhatsAppGroupShared(id, shared, newCount) {
  const patch = shared
    ? { whatsapp_group_shared_at: new Date().toISOString(), whatsapp_group_share_count: newCount }
    : { whatsapp_group_shared_at: null, whatsapp_group_share_count: 0 };
  const { data, error } = await supabase.from('bills').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

/** Attaches (path) or detaches (null) the tenant invoice PDF. Kept out of toRow() so ordinary
 *  bill edits never overwrite it. */
export async function setTenantInvoice(id, path, data) {
  const patch = { tenant_invoice_path: path || null };
  if (data !== undefined) patch.tenant_invoice_data = data;
  const { data: row, error } = await supabase.from('bills').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(row);
}
