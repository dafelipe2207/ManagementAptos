// services/houseRulesService.js
// One row of apartment rules per property: text written by the admin plus an optional file
// (PDF/image) in the private `house-rules` bucket under <propertyId>/..., readable by that
// property's tenants (see house_rules_tenant_read storage policy).
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  return {
    propertyId: row.property_id,
    content: row.content || '',
    filePath: row.file_path || null,
    fileName: row.file_name || null,
    updatedByProfileId: row.updated_by_profile_id || null,
    updatedAt: row.updated_at
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('house_rules').select('*');
  if (error) throw error;
  return data.map(fromRow);
}

export async function save(r) {
  const { data, error } = await supabase.from('house_rules').upsert({
    property_id: r.propertyId, content: r.content || '',
    file_path: r.filePath || null, file_name: r.fileName || null,
    updated_by_profile_id: r.updatedByProfileId || null, updated_at: new Date().toISOString()
  }, { onConflict: 'property_id' }).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function uploadFile(propertyId, file) {
  await getCurrentUserId(); // ensures a session
  const safe = String(file.name || 'rules').replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = propertyId + '/' + Date.now() + '-' + safe;
  const { error } = await supabase.storage.from('house-rules').upload(path, file, { upsert: false });
  if (error) throw error;
  return path;
}
