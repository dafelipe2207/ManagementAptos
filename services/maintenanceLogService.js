// services/maintenanceLogService.js
// Read-only history of maintenance requests (created / updated / deleted, who and what changed).
// Written by the log_maintenance_change DB trigger — never by the client.
import { supabase } from '../lib/supabaseClient.js';

function fromRow(row) {
  return {
    id: row.id,
    requestId: row.request_id,
    propertyId: row.property_id,
    tenantId: row.tenant_id || null,
    action: row.action,
    title: row.title || '',
    changes: row.changes || {},
    snapshot: row.snapshot || null,
    actorName: row.actor_name || '',
    actorRole: row.actor_role || '',
    createdAt: row.created_at
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('maintenance_log').select('*').order('created_at', { ascending: false }).limit(500);
  if (error) throw error;
  return data.map(fromRow);
}
