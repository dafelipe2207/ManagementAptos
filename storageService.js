// services/storageService.js
// Upload/download for the `receipts` and `documents` private Storage
// buckets. Both buckets are private (RLS restricts each user to files
// under `<bucket>/<their-auth-uid>/...`), so reading a file back needs a
// signed URL rather than a public one.
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function sanitizeFileName(name) {
  return String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
}

export async function uploadReceipt(billId, file) {
  const userId = await getCurrentUserId();
  const path = userId + '/' + billId + '-' + Date.now() + '-' + sanitizeFileName(file.name);
  const { error } = await supabase.storage.from('receipts').upload(path, file, { upsert: false });
  if (error) throw error;
  return path;
}

export async function uploadDocument(tenantId, file) {
  const userId = await getCurrentUserId();
  const path = userId + '/' + tenantId + '-' + Date.now() + '-' + sanitizeFileName(file.name);
  const { error } = await supabase.storage.from('documents').upload(path, file, { upsert: false });
  if (error) throw error;
  return path;
}

export async function uploadMaintenancePhoto(file) {
  const userId = await getCurrentUserId();
  const path = userId + '/' + Date.now() + '-' + sanitizeFileName(file.name);
  const { error } = await supabase.storage.from('maintenance-photos').upload(path, file, { upsert: false });
  if (error) throw error;
  return path;
}

/** Buckets are private — always use a signed URL (expires after `expiresInSeconds`) to display/open a file. */
export async function getSignedUrl(bucket, path, expiresInSeconds) {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, expiresInSeconds || 3600);
  if (error) throw error;
  return data.signedUrl;
}
