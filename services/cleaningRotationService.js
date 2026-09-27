// services/cleaningRotationService.js
// One standing config per property: how often a cleaning turn comes up (intervalDays) and the
// anchor date the cycle is measured from (referenceDate). Replaces the old "generate N weeks of
// tasks" one-off batch — app.js reads this and the property's existing cleaning_tasks/rooms to
// auto-extend the schedule by exactly one task each time the current cycle is done, skipping any
// room that's currently vacant. No cursor/room-order is stored here: which room comes next is
// always derived from which rooms are occupied right now and which room had the most recent
// task, so it can never go stale as tenants move in/out or rooms change.
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  return {
    id: row.id,
    propertyId: row.property_id,
    intervalDays: row.interval_days,
    referenceDate: row.reference_date
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('cleaning_rotations').select('*');
  if (error) throw error;
  return data.map(fromRow);
}

/** Creates the rotation config for a property, or updates it if one already exists (one per
 *  property) — this is what the admin's "Edit rotation" form calls to change the periodicity. */
export async function upsertForProperty(existing, draft) {
  const payload = {
    property_id: draft.propertyId,
    interval_days: draft.intervalDays,
    reference_date: draft.referenceDate
  };
  if (existing) {
    const { data, error } = await supabase.from('cleaning_rotations').update(payload).eq('id', existing.id).select().single();
    if (error) throw error;
    return fromRow(data);
  }
  const userId = await getCurrentUserId();
  payload.user_id = userId;
  const { data, error } = await supabase.from('cleaning_rotations').insert(payload).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function remove(id) {
  const { error } = await supabase.from('cleaning_rotations').delete().eq('id', id);
  if (error) throw error;
}
