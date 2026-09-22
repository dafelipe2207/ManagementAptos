// services/tenantService.js
// Maps the app's camelCase tenant shape (fullName, propertyId, roomId,
// moveInDate, expectedMoveOutDate, actualMoveOutDate, rentAmount,
// rentFrequency, paymentDay, notes, phone, email) to/from `tenants`.
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
    paymentDay: row.payment_day
  };
  if (row.phone) t.phone = row.phone;
  if (row.email) t.email = row.email;
  if (row.expected_move_out_date) t.expectedMoveOutDate = row.expected_move_out_date;
  if (row.actual_move_out_date) t.actualMoveOutDate = row.actual_move_out_date;
  if (row.notes) t.notes = row.notes;
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
    notes: t.notes || null
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
