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

export async function create(b) {
  const userId = await getCurrentUserId();
  const row = toRow(b);
  row.user_id = userId;
  const { data, error } = await supabase.from('bills').insert(row).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function update(id, b) {
  const { data, error } = await supabase.from('bills').update(toRow(b)).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function remove(id) {
  // .select() returns the deleted rows: when the database refuses (no permission for that
  // property) nothing is deleted and no error comes back, so check something was removed.
  const { data: deleted, error } = await supabase.from('bills').delete().eq('id', id).select('id');
  if (!error && (!deleted || deleted.length === 0)) {
    throw new Error('It wasn\'t deleted — your account doesn\'t have permission to delete this. Ask the Super Admin.');
  }
  if (error) throw error;
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

async function describeFunctionError(err) {
  try {
    if (err && err.context && typeof err.context.json === 'function') {
      var body = await err.context.clone().json();
      if (body && body.error) return new Error(body.error);
    }
  } catch (_e) { /* fall through */ }
  return err instanceof Error ? err : new Error((err && err.message) || 'Could not reach the server.');
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
