// services/dutyService.js
// Roster period containers — one row per (room, period):
//   weekly_duties  the weekly roster: which room is on duty for Cleaning AND Bin OUT each week
//                  (cleaning_tasks link here via weekly_duty_id; see ensureCleaningDutiesUpToDate)
//   bin_duties     fortnightly containers bin_out_tasks hang off (bin_duty_id); their room is not
//                  used for assignment — each bin task's room follows weekly_duties
// Both tables have the same shape, so one factory serves both.
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

function makeDutyService(table) {
  return {
    async getAll() {
      const { data, error } = await supabase.from(table).select('*').order('period_start', { ascending: true });
      if (error) throw error;
      return data.map(fromRow);
    },
    /** Bulk-creates rows (the generators in app.js call this before creating the child tasks). */
    async createTasksBulk(rows) {
      const userId = await getCurrentUserId();
      const dbRows = rows.map(function(r){
        return { user_id: userId, property_id: r.propertyId, room_id: r.roomId, period_start: r.periodStart, period_end: r.periodEnd };
      });
      const { data, error } = await supabase.from(table).insert(dbRows).select();
      if (error) throw error;
      return data.map(fromRow);
    },
    /** Admin override from the Cleaning calendar (reassignDutyRoom). */
    async updateRoom(id, roomId) {
      const { data, error } = await supabase.from(table).update({ room_id: roomId }).eq('id', id).select().single();
      if (error) throw error;
      return fromRow(data);
    },
    async updatePeriod(id, periodStart, periodEnd) {
      const { data, error } = await supabase.from(table).update({ period_start: periodStart, period_end: periodEnd }).eq('id', id).select().single();
      if (error) throw error;
      return fromRow(data);
    }
  };
}

export const weeklyDutyService = makeDutyService('weekly_duties');
export const binDutyService = makeDutyService('bin_duties');
