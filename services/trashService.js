// services/trashService.js
// The trash agenda: which room takes which bin out, on which day of the week. `dayOfWeek` is
// 0=Sunday..6=Saturday (JS Date.getDay() convention, used consistently throughout app.js).
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  return {
    id: row.id,
    propertyId: row.property_id,
    roomId: row.room_id,
    dayOfWeek: row.day_of_week,
    trashType: row.trash_type,
    notes: row.notes || '',
    createdAt: row.created_at
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('trash_schedule').select('*').order('day_of_week', { ascending: true });
  if (error) throw error;
  return data.map(fromRow);
}

export async function create(t) {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase.from('trash_schedule').insert({
    user_id: userId, property_id: t.propertyId, room_id: t.roomId,
    day_of_week: t.dayOfWeek, trash_type: t.trashType, notes: t.notes || null
  }).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function update(id, t) {
  const { data, error } = await supabase.from('trash_schedule').update({
    day_of_week: t.dayOfWeek, trash_type: t.trashType, notes: t.notes || null
  }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function remove(id) {
  const { error } = await supabase.from('trash_schedule').delete().eq('id', id);
  if (error) throw error;
}
