// services/propertyDutyRotationService.js
// One standing config per property: an admin-curated, explicitly ordered list of room ids
// (roomOrder) plus the anchor date the cycle is measured from (referenceDate). Replaces the old
// cleaningRotationService (interval + auto-detected occupied rooms) — the admin now picks which
// rooms participate and in what order, and BOTH Cleaning (weekly cadence) and Bin OUT (fortnightly
// cadence) advance through this same list independently (see ensureCleaningDutiesUpToDate /
// ensureBinDutiesUpToDate in app.js). No occupancy auto-skip here: the admin adds/removes rooms
// from the list directly (e.g. when a tenant moves out), same as they'd edit anything else.
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  return {
    id: row.id,
    propertyId: row.property_id,
    roomOrder: Array.isArray(row.room_order) ? row.room_order : [],
    referenceDate: row.reference_date
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('property_duty_rotations').select('*');
  if (error) throw error;
  return data.map(fromRow);
}

/** Creates the rotation config for a property, or updates it if one already exists (one per
 *  property, enforced by a unique constraint) — this is what the admin's rotation editor calls
 *  whenever the room order or reference date changes. */
export async function upsertForProperty(existing, draft) {
  const payload = {
    property_id: draft.propertyId,
    room_order: draft.roomOrder,
    reference_date: draft.referenceDate
  };
  if (existing) {
    const { data, error } = await supabase.from('property_duty_rotations').update(payload).eq('id', existing.id).select().single();
    if (error) throw error;
    return fromRow(data);
  }
  const userId = await getCurrentUserId();
  payload.user_id = userId;
  const { data, error } = await supabase.from('property_duty_rotations').insert(payload).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function remove(id) {
  const { error } = await supabase.from('property_duty_rotations').delete().eq('id', id);
  if (error) throw error;
}
