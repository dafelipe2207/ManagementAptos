// services/activityLogService.js
// Read-only append-only event feed (cleaning/maintenance/bin_out/inspection/documents),
// maintained exclusively by Postgres triggers — see the Phase 0 spec. Powers the
// Timeline; never write to this table from the app.
import { supabase } from '../lib/supabaseClient.js';

function fromRow(row) {
  return {
    id: row.id,
    eventType: row.event_type,
    category: row.category,
    propertyId: row.property_id,
    roomId: row.room_id,
    tenantId: row.tenant_id,
    sourceTable: row.source_table,
    sourceId: row.source_id,
    actorProfileId: row.actor_profile_id,
    description: row.description,
    createdAt: row.created_at
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('activity_log').select('*').order('created_at', { ascending: false });
  if (error) throw error;
  return data.map(fromRow);
}
