// services/billService.js
// Maps the camelCase `bill` shape (propertyId, billType, provider,
// invoiceNumber, issueDate, dueDate, billingPeriodStart, billingPeriodEnd,
// amount, status, allocationMethod, receiptPath, notes) to/from `bills`.
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
    invoiceNumber: row.invoice_number || '',
    issueDate: row.issue_date,
    dueDate: row.due_date,
    billingPeriodStart: row.billing_period_start,
    billingPeriodEnd: row.billing_period_end,
    amount: Number(row.amount) || 0,
    status: row.status,
    notes: row.notes || ''
  };
  if (row.allocation_method) b.allocationMethod = row.allocation_method;
  if (row.receipt_path) b.receiptPath = row.receipt_path;
  return b;
}

function toRow(b) {
  return {
    property_id: b.propertyId,
    type: b.billType,
    provider: b.provider,
    invoice_number: b.invoiceNumber || null,
    issue_date: b.issueDate,
    due_date: b.dueDate,
    billing_period_start: b.billingPeriodStart,
    billing_period_end: b.billingPeriodEnd,
    amount: b.amount,
    status: b.status,
    allocation_method: b.allocationMethod || null,
    receipt_path: b.receiptPath || null,
    notes: b.notes || null
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
  const { error } = await supabase.from('bills').delete().eq('id', id);
  if (error) throw error;
}
