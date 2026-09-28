// services/taskIndexService.js
// Read-only index of "live" task-shaped rows (cleaning_tasks, maintenance_requests,
// bin_out_tasks today), maintained exclusively by Postgres triggers — see the Phase 0
// spec. Never write to this table from the app; it would just be undone/conflict with
// the next trigger fire on the real source row.
import { supabase } from '../lib/supabaseClient.js';

function fromRow(row) {
  return {
    id: row.id,
    sourceTable: row.source_table,
    sourceId: row.source_id,
    category: row.category,
    propertyId: row.property_id,
    roomId: row.room_id,
    tenantId: row.tenant_id,
    title: row.title,
    priority: row.priority,
    rawStatus: row.raw_status,
    statusFamily: row.status_family,
    dueDate: row.due_date,
    assignedTo: row.assigned_to,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('task_index').select('*').order('due_date', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return data.map(fromRow);
}
