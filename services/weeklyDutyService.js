// services/weeklyDutyService.js
// Cleaning's own period container — one row per (room, period), advancing weekly through the
// property's admin-curated room order (see propertyDutyRotationService.js). Bin OUT has its own,
// separate container (bin_duties/binDutyService.js) since it advances on a different, fortnightly
// cadence through that same room order. See cleaningService.js for the cleaning_tasks that link
// here via weekly_duty_id; this file only creates/reads the container. RLS mirrors cleaning_tasks:
// is_staff()/can_manage_property() for staff, current-room match for a tenant's own read.
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
  const { data, error } = await supabase.from('weekly_duties').select('*').order('period_start', { ascending: true });
  if (error) throw error;
  return data.map(fromRow);
}

/** Bulk-creates weekly_duties rows — used by the generator alongside its child cleaning_tasks
 *  rows (see ensureCleaningDutiesUpToDate in app.js). */
export async function createTasksBulk(rows) {
  const userId = await getCurrentUserId();
  const dbRows = rows.map(function(r){
    return { user_id: userId, property_id: r.propertyId, room_id: r.roomId, period_start: r.periodStart, period_end: r.periodEnd };
  });
  const { data, error } = await supabase.from('weekly_duties').insert(dbRows).select();
  if (error) throw error;
  return data.map(fromRow);
}
