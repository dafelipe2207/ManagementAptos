// services/tenantDocumentService.js
// Persists tenant documents (lease agreements, ID copies, etc) in the
// `tenant_documents` table — the reference app kept these only in an
// in-memory array (`tenantDocuments`), lost on every reload. The actual
// file bytes live in the private `documents` Storage bucket; this table
// just stores the path (see services/storageService.js for uploads).
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function fromRow(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    docType: row.doc_type,
    fileName: row.file_name || '',
    storagePath: row.storage_path,
    addedAt: row.created_at ? row.created_at.slice(0, 10) : ''
  };
}

export async function getAll() {
  const { data, error } = await supabase.from('tenant_documents').select('*').order('created_at', { ascending: true });
  if (error) throw error;
  return data.map(fromRow);
}

export async function create(d) {
  const userId = await getCurrentUserId();
  const { data, error } = await supabase.from('tenant_documents').insert({
    user_id: userId,
    tenant_id: d.tenantId,
    doc_type: d.docType,
    storage_path: d.storagePath,
    file_name: d.fileName
  }).select().single();
  if (error) throw error;
  return fromRow(data);
}

export async function remove(id) {
  const { error } = await supabase.from('tenant_documents').delete().eq('id', id);
  if (error) throw error;
}
