// services/recurringBillService.js
// Template for a bill that repeats every month (gas, internet, etc.) — see `recurring_bills` in
// Supabase. app.js checks these against TODAY on every load (generateDueRecurringBills) and
// auto-creates the matching row in `bills` once `nextDueDate` arrives, then advances
// `nextDueDate` by a month (looping if the app wasn't opened for more than one month).
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  return {
    id: row.id,
    propertyId: row.property_id,
    billType: row.bill_type,
    provider: row.provider,
    amount: Number(row.amount) || 0,
    billingDay: row.billing_day,
    nextDueDate: row.next_due_date,
    isActive: !!row.is_active,
    notes: row.notes || ''
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('recurring_bills').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  return data.map(fromRow);
}

export async function create(r) {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase.from('recurring_bills').insert({
    user_id: userId,
    property_id: r.propertyId,
    bill_type: r.billType,
    provider: r.provider,
    amount: r.amount,
    billing_day: r.billingDay,
    next_due_date: r.nextDueDate,
    is_active: r.isActive !== false,
    notes: r.notes || null
  }).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function update(id, r) {
  const { data, error } = await supabase.from('recurring_bills').update({
    property_id: r.propertyId,
    bill_type: r.billType,
    provider: r.provider,
    amount: r.amount,
    billing_day: r.billingDay,
    next_due_date: r.nextDueDate,
    is_active: r.isActive !== false,
    notes: r.notes || null
  }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

/** Just moves `nextDueDate` forward — used after auto-generating a bill from this template. */
export async function advanceNextDueDate(id, nextDueDate) {
  const { data, error } = await supabase.from('recurring_bills').update({ next_due_date: nextDueDate }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function setActive(id, isActive) {
  const { data, error } = await supabase.from('recurring_bills').update({ is_active: isActive }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function remove(id) {
  const { error } = await supabase.from('recurring_bills').delete().eq('id', id);
  if (error) throw error;
}
