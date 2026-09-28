// services/weeklyDutyService.js
// The Weekly Duty container: one row per (room, period) — the parent that Cleaning and Bin OUT
// tasks (and any future per-turn task type) both link to via weekly_duty_id, so the app can
// always show them grouped by the same period without either one owning the other. See
// cleaningService.js and binOutTaskService.js for the sub-tasks themselves; this file only
// creates/reads the container. RLS mirrors cleaning_tasks: is_staff()/can_manage_property() for
// staff, current-room match for a tenant's own read.
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

/** Bulk-creates weekly_duties rows — used by the generator alongside their child
 *  cleaning_tasks/bin_out_tasks rows (see ensureWeeklyDutiesUpToDate in app.js). */
export async function createTasksBulk(rows) {
  const userId = await getCurrentUserId();
  const dbRows = rows.map(function(r){
    return { user_id: userId, property_id: r.propertyId, room_id: r.roomId, period_start: r.periodStart, period_end: r.periodEnd };
  });
  const { data, error } = await supabase.from('weekly_duties').insert(dbRows).select();
  if (error) throw error;
  return data.map(fromRow);
}

/** Admin reassigns which room is on duty for one specific period — e.g. correcting the
 *  auto-rotation's pick, or handling a swap between tenants. This only updates the container;
 *  cascading to that duty's cleaning_tasks/bin_out_tasks rows is the caller's job (see
 *  reassignRoom in cleaningService.js / binOutTaskService.js). */
export async function update(id, e) {
  const { data, error } = await supabase.from('weekly_duties').update({ room_id: e.roomId }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}
