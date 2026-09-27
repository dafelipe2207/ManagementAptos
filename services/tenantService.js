// services/tenantService.js
// Maps the app's camelCase tenant shape (fullName, propertyId, roomId,
// moveInDate, expectedMoveOutDate, actualMoveOutDate, rentAmount,
// rentFrequency, paymentDay, notes, phone, email, excludedBillTypes,
// billOccupancyFactor) to/from `tenants`. excludedBillTypes lists bill types
// (matching bills.type, e.g. 'gas') this tenant does not pay a share of —
// see computeAllocationRows in app.js, which redirects their share to the
// admin instead. billOccupancyFactor is how many people this tenant
// represents for the 'occupancy' allocation method (1.0 = one person, 2.0 =
// a couple, etc.) — see computeOccupancyFactorAllocationRows in app.js.
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  const t = {
    id: row.id,
    fullName: row.full_name,
    propertyId: row.property_id,
    roomId: row.room_id,
    moveInDate: row.move_in_date,
    rentAmount: Number(row.rent_amount) || 0,
    rentFrequency: row.rent_frequency,
    paymentDay: row.payment_day,
    excludedBillTypes: Array.isArray(row.excluded_bill_types) ? row.excluded_bill_types : [],
    billOccupancyFactor: Number(row.bill_occupancy_factor) || 1,
    isActive: row.is_active !== false
  };
  if (row.phone) t.phone = row.phone;
  if (row.email) t.email = row.email;
  if (row.expected_move_out_date) t.expectedMoveOutDate = row.expected_move_out_date;
  if (row.actual_move_out_date) t.actualMoveOutDate = row.actual_move_out_date;
  if (row.notes) t.notes = row.notes;
  // Idempotency guard for the move-out bond settlement (auto-deduct outstanding rent/bills
  // from the bond): set the first time it runs for this tenant so it never re-runs on its own
  // on a later save. Null/absent = not settled yet. See processMoveOutBondSettlement in app.js.
  t.moveOutSettledAt = row.move_out_settled_at || null;
  t.authUserId = row.auth_user_id || null;
  return t;
}

function toRow(t) {
  return {
    full_name: t.fullName,
    phone: t.phone || null,
    email: t.email || null,
    property_id: t.propertyId,
    room_id: t.roomId,
    move_in_date: t.moveInDate,
    expected_move_out_date: t.expectedMoveOutDate || null,
    actual_move_out_date: t.actualMoveOutDate || null,
    rent_amount: t.rentAmount,
    rent_frequency: t.rentFrequency,
    payment_day: t.paymentDay,
    notes: t.notes || null,
    excluded_bill_types: Array.isArray(t.excludedBillTypes) ? t.excludedBillTypes : [],
    bill_occupancy_factor: (typeof t.billOccupancyFactor === 'number' && t.billOccupancyFactor > 0) ? t.billOccupancyFactor : 1,
    is_active: t.isActive !== false
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('tenants').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  return data.map(fromRow);
}

export async function create(t) {
  const userId = await getCurrentUserId();
  const row = toRow(t);
  row.user_id = userId;
  const { data, error } = await supabase.from('tenants').insert(row).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function update(id, t) {
  const { data, error } = await supabase.from('tenants').update(toRow(t)).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function remove(id) {
  const { error } = await supabase.from('tenants').delete().eq('id', id);
  if (error) throw error;
}

/** Marks that the move-out bond settlement has run for this tenant, without touching any other
 *  field (a plain `update()` call would send toRow(t), which requires the FULL tenant draft). */
export async function markMoveOutSettled(id, isoTimestamp) {
  const { data, error } = await supabase.from('tenants')
    .update({ move_out_settled_at: isoTimestamp }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

// Lets a logged-in TENANT set only their own actual_move_out_date (when starting the move-out
// process from "My Bond") — tenants have no UPDATE grant on `tenants` under RLS, so this goes
// through the narrow SECURITY DEFINER function set_own_actual_move_out_date, which only ever
// touches that one column on the caller's own row (current_tenant_id()).
export async function setOwnActualMoveOutDate(date) {
  const { error } = await supabase.rpc('set_own_actual_move_out_date', { p_date: date });
  if (error) throw error;
}
