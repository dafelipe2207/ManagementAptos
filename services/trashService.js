// services/trashService.js
// The trash agenda — property-level (not per-room): which bin type gets collected, from a
// reference pickup date, repeating every `intervalDays` days. Not every property has bin
// collection managed here, so a property simply has zero entries until the admin adds one.
// Typical intervals (the admin can still set any number): organic/green ~8 days, garbage/red and
// recycling/yellow ~14 days each, offset by 7 days from each other so they alternate week to week.
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

export var TRASH_TYPE_DEFAULT_INTERVAL = { organic: 8, garbage: 14, recycling: 14 };

function fromRow(row) {
  return {
    id: row.id,
    propertyId: row.property_id,
    trashType: row.trash_type, // 'garbage' | 'recycling' | 'organic'
    referenceDate: row.reference_date,
    intervalDays: row.interval_days,
    notes: row.notes || '',
    createdAt: row.created_at
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('trash_schedule').select('*').order('trash_type', { ascending: true });
  if (error) throw error;
  return data.map(fromRow);
}

export async function create(t) {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase.from('trash_schedule').insert({
    user_id: userId, property_id: t.propertyId, trash_type: t.trashType,
    reference_date: t.referenceDate, interval_days: t.intervalDays, notes: t.notes || null
  }).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function update(id, t) {
  const { data, error } = await supabase.from('trash_schedule').update({
    trash_type: t.trashType, reference_date: t.referenceDate, interval_days: t.intervalDays, notes: t.notes || null
  }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function remove(id) {
  const { error } = await supabase.from('trash_schedule').delete().eq('id', id);
  if (error) throw error;
}
