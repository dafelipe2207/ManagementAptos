// services/binDutyService.js
// Bin OUT's own period container — one row per (room, period), advancing on its own fortnightly
// cadence. The room for each not-yet-reached period is suggested by round-robin over the
// property's rooms (see ensureBinDutiesUpToDate in app.js), and the admin can override it per
// 2-week block from the Cleaning calendar (see updateRoom below). Split out from weekly_duties
// (which belongs to Cleaning alone) because the two duties don't share a cadence: Cleaning is
// weekly, Bin OUT is fortnightly, so the same room order lands on a different room for each at
// any given time. bin_out_tasks link here via bin_duty_id.
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

/** Admin override from the Cleaning calendar: reassigns which room this 2-week block falls to.
 *  Callers must also update every linked bin_out_tasks row's room_id (see
 *  binOutTaskService.updateTasksRoom) so the two stay consistent. */
export async function updateRoom(id, roomId) {
  const { data, error } = await supabase.from('bin_duties').update({ room_id: roomId }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}

/** Admin override from the Cleaning calendar's date field: moves this 2-week block to start on a
 *  different date, keeping its 14-day length. Callers must also shift every linked bin_out_tasks
 *  row's pickup_date by the same delta (see binOutTaskService.shiftTasksByDays) so the two stay
 *  consistent, and should cascade the same delta through every later block for the property so the
 *  fortnightly cadence stays unbroken (see reassignDutyRoom in app.js). */
export async function updatePeriod(id, periodStart, periodEnd) {
  const { data, error } = await supabase.from('bin_duties').update({ period_start: periodStart, period_end: periodEnd }).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(data);
}
