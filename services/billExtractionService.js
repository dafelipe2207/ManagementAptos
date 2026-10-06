// services/billExtractionService.js
// One `bill_extractions` row per uploaded bill document: the original file's storage path, what
// the readers extracted (Azure / Gemini, with confidence and issues), its review status, and —
// once the admin saves it — the final confirmed values and the bill it became. The rows waiting
// for review ("needs_review" / "ready") are the app's "Pending review" queue, so it survives a
// page reload.
//
// Until the table exists (migration supabase/migrations/20261006_bill_extractions.sql) every
// call quietly does nothing and `isAvailable()` turns false — the import flow keeps working,
// just without the saved record.
import { supabase } from '../lib/supabaseClient.js';

let available = true;
export function isAvailable() { return available; }

function isMissingTable(error) {
  if (!error) return false;
  const code = error.code || '';
  const msg = (error.message || '') + ' ' + (error.details || '');
  return code === '42P01' || code === 'PGRST205' || /bill_extractions/.test(msg) && /(does not exist|could not find|schema cache)/i.test(msg);
}

function fromRow(r) {
  return {
    id: r.id,
    propertyId: r.property_id,
    billId: r.bill_id,
    storagePath: r.storage_path,
    fileName: r.file_name,
    mimeType: r.mime_type,
    extractor: r.extractor,
    extracted: r.extracted,
    confidence: r.confidence == null ? null : Number(r.confidence),
    status: r.status,
    issues: Array.isArray(r.issues) ? r.issues : [],
    confirmed: r.confirmed,
    confirmedAt: r.confirmed_at,
    createdAt: r.created_at
  };
}

/** Saves a new extraction record. Returns it, or null if the table isn't there yet. */
export async function create(x) {
  if (!available) return null;
  const { data, error } = await supabase.from('bill_extractions').insert({
    property_id: x.propertyId || null,
    storage_path: x.storagePath || null,
    file_name: x.fileName || null,
    mime_type: x.mimeType || null,
    extractor: x.extractor || 'manual',
    extracted: x.extracted || null,
    confidence: x.confidence == null ? null : x.confidence,
    status: x.status || 'needs_review',
    issues: x.issues || []
  }).select().single();
  if (error) {
    if (isMissingTable(error)) { available = false; return null; }
    throw error;
  }
  return fromRow(data);
}

/** Patches a record (camelCase keys). Returns the updated record, or null if unavailable. */
export async function update(id, patch) {
  if (!available || !id) return null;
  const row = {};
  if ('propertyId' in patch) row.property_id = patch.propertyId || null;
  if ('storagePath' in patch) row.storage_path = patch.storagePath;
  if ('status' in patch) row.status = patch.status;
  if ('billId' in patch) row.bill_id = patch.billId;
  if ('confirmed' in patch) row.confirmed = patch.confirmed;
  if ('confirmedAt' in patch) row.confirmed_at = patch.confirmedAt;
  if ('confirmedBy' in patch) row.confirmed_by = patch.confirmedBy;
  const { data, error } = await supabase.from('bill_extractions').update(row).eq('id', id).select().single();
  if (error) {
    if (isMissingTable(error)) { available = false; return null; }
    throw error;
  }
  return fromRow(data);
}

/** Records still waiting for the admin's review, oldest first. */
export async function listOpen() {
  if (!available) return [];
  const { data, error } = await supabase.from('bill_extractions').select('*')
    .in('status', ['needs_review', 'ready']).order('created_at', { ascending: true });
  if (error) {
    if (isMissingTable(error)) { available = false; return []; }
    throw error;
  }
  return data.map(fromRow);
}
