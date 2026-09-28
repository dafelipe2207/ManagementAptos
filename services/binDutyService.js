// services/binDutyService.js
// Bin OUT's own period container — one row per (room, period), advancing on its own fortnightly
// cadence through the property's admin-curated room order (see propertyDutyRotationService.js).
// Split out from weekly_duties (which now belongs to Cleaning alone) because the two duties no
// longer share a cadence: Cleaning is weekly, Bin OUT is fortnightly, so the same room-order list
// lands on a different room for each at any given time. bin_out_tasks link here via bin_duty_id.
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  return {
    id: row.id,
    propertyId: row.property_id,
    roomId: row.room_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    createdAt: row.created_at
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('bin_duties').select('*').order('period_start', { ascending: true });
  if (error) throw error;
  return data.map(fromRow);
}

/** Bulk-creates bin_duties rows — used by the generator alongside their child bin_out_tasks rows
 *  (see ensureBinDutiesUpToDate in app.js). */
export async function createTasksBulk(rows) {
  const userId = await getCurrentUserId();
  const dbRows = rows.map(function(r){
    return { user_id: userId, property_id: r.propertyId, room_id: r.roomId, period_start: r.periodStart, period_end: r.periodEnd };
  });
  const { data, error } = await supabase.from('bin_duties').insert(dbRows).select();
  if (error) throw error;
  return data.map(fromRow);
}
