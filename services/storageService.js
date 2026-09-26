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

/** Uploads several files (a FileList or array — from a multi-select gallery picker or repeated
 *  camera shots) to `maintenance-photos`, one at a time so a single failure doesn't lose the
 *  paths of files that already succeeded. Returns the array of storage paths, in order. */
export async function uploadMaintenancePhotos(files) {
  const paths = [];
  for (const file of Array.from(files || [])) {
    paths.push(await uploadMaintenancePhoto(file));
  }
  return paths;
}

/** Cleaning-check photos (a tenant's "how it looks after cleaning" submission) — same private,
 *  path-scoped-by-uid pattern as the other buckets. */
export async function uploadCleaningPhoto(file) {
  const userId = await getCurrentUserId();
  const path = userId + '/' + Date.now() + '-' + sanitizeFileName(file.name);
  const { error } = await supabase.storage.from('cleaning-photos').upload(path, file, { upsert: false });
  if (error) throw error;
  return path;
}

export async function uploadCleaningPhotos(files) {
  const paths = [];
  for (const file of Array.from(files || [])) {
    paths.push(await uploadCleaningPhoto(file));
  }
  return paths;
}

/** Move-in / move-out condition photos — same private, path-scoped-by-uid pattern. */
export async function uploadInspectionPhoto(file) {
  const userId = await getCurrentUserId();
  const path = userId + '/' + Date.now() + '-' + sanitizeFileName(file.name);
  const { error } = await supabase.storage.from('inspection-photos').upload(path, file, { upsert: false });
  if (error) throw error;
  return path;
}

export async function uploadInspectionPhotos(files) {
  const paths = [];
  for (const file of Array.from(files || [])) {
    paths.push(await uploadInspectionPhoto(file));
  }
  return paths;
}

/** Buckets are private — always use a signed URL (expires after `expiresInSeconds`) to display/open a file. */
export async function getSignedUrl(bucket, path, expiresInSeconds) {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, expiresInSeconds || 3600);
  if (error) throw error;
  return data.signedUrl;
}
