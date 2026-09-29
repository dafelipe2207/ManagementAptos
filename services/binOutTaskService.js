// services/binOutTaskService.js
// One row per pickup date that lands inside a room's bin_duty period (see binDutyService.js) —
// the tenant's Bin OUT responsibility for that date, fully independent from Cleaning's
// cleaning_tasks (see the spec's binding "no combined status" rule). pickup_date/bin_types are
// always derived from trash_schedule at generation time and are never hand-edited here — only
// status/evidence are ever written after creation, and only
// status/completed_at/completed_by_tenant_id/evidence_photo_path (see bin_out_tasks_update RLS,
// which restricts a tenant's own-room update to exactly those effects via the app layer, the same
// trust boundary cleaning_submissions already relies on).
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  return {
    id: row.id,
    binDutyId: row.bin_duty_id,
    propertyId: row.property_id,
    roomId: row.room_id,
    pickupDate: row.pickup_date,
    binTypes: Array.isArray(row.bin_types) ? row.bin_types : [],
    status: row.status,
    completedAt: row.completed_at,
    completedByTenantId: row.completed_by_tenant_id,
    evidencePhotoPath: row.evidence_photo_path || null,
    createdAt: row.created_at
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('bin_out_tasks').select('*').order('pickup_date', { ascending: true });
  if (error) throw error;
  return data.map(fromRow);
}

/** Bulk-creates bin_out_tasks rows — used by the generator right after it creates the
 *  bin_duties rows for the same period (see ensureBinDutiesUpToDate). */
export async function createTasksBulk(rows) {
  const userId = await getCurrentUserId();
  const dbRows = rows.map(function(r){
    return {
      user_id: userId, bin_duty_id: r.binDutyId, property_id: r.propertyId, room_id: r.roomId,
      pickup_date: r.pickupDate, bin_types: r.binTypes
    };
  });
  const { data, error } = await supabase.from('bin_out_tasks').insert(dbRows).select();
  if (error) throw error;
  return data.map(fromRow);
}

/** Concurrency guard: completion/not-completed writes only apply while the stored status is
 *  still open. 0 rows matched (someone else already closed it) → throws a STALE_STATUS error
 *  (err.code === STALE_STATUS_CODE) so the caller can reload instead of silently overwriting. */
const OPEN_STATUSES = ['upcoming', 'due_today', 'overdue'];
export const STALE_STATUS_CODE = 'STALE_STATUS';
function staleStatusError() {
  const err = new Error('This task was already updated elsewhere.');
  err.code = STALE_STATUS_CODE;
  return err;
}

/** Tenant self-confirmation — no admin review step (unlike cleaning), per spec. */
export async function markCompleted(id, tenantId, evidencePhotoPath) {
  const { data, error } = await supabase.from('bin_out_tasks').update({
    status: 'completed', completed_at: new Date().toISOString(), completed_by_tenant_id: tenantId,
    evidence_photo_path: evidencePhotoPath || null
  }).eq('id', id).in('status', OPEN_STATUSES).select().maybeSingle();
  if (error) throw error;
  if (!data) throw staleStatusError();
  return fromRow(data);
}

/** Admin-only manual close of an overdue task — never set automatically. */
export async function markNotCompleted(id) {
  const { data, error } = await supabase.from('bin_out_tasks').update({ status: 'not_completed' })
    .eq('id', id).in('status', OPEN_STATUSES).select().maybeSingle();
  if (error) throw error;
  if (!data) throw staleStatusError();
  return fromRow(data);
}

/** Admin override from the Cleaning calendar: keeps every pickup task in this bin_duty's 2-week
 *  block in step with it after a reassignment (see binDutyService.updateRoom) — called right
 *  after it, never on its own. There can be more than one pickup date per block, so this updates
 *  all of them in one call. */
export async function updateTasksRoom(binDutyId, roomId) {
  const { data, error } = await supabase.from('bin_out_tasks').update({ room_id: roomId }).eq('bin_duty_id', binDutyId).select();
  if (error) throw error;
  return data.map(fromRow);
}
