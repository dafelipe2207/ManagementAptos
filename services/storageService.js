// services/storageService.js
// Uploads to the private Storage buckets and signed URLs to read them back. Every bucket is
// private and RLS restricts each user to files under `<their-auth-uid>/...` (staff can read all),
// so every path starts with the uploader's uid and reading needs a signed URL.
import { supabase } from '../lib/supabaseClient.js';
import { getCurrentUserId } from '../lib/auth.js';

function sanitizeFileName(name) {
  return String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
}

/** Uploads one file to `bucket` under `<uid>/[prefix-]<timestamp>-<name>` and returns its path. */
async function upload(bucket, file, prefix) {
  const userId = await getCurrentUserId();
  const path = userId + '/' + (prefix ? prefix + '-' : '') + Date.now() + '-' + sanitizeFileName(file.name);
  const { error } = await supabase.storage.from(bucket).upload(path, file, { upsert: false });
  if (error) throw error;
  return path;
}

/** Uploads several files (a FileList or array) one at a time, so a single failure doesn't lose
 *  the paths of files that already succeeded. Returns the storage paths, in order. */
async function uploadMany(bucket, files) {
  const paths = [];
  for (const file of Array.from(files || [])) paths.push(await upload(bucket, file));
  return paths;
}

export const uploadReceipt = (billId, file) => upload('receipts', file, billId);
export const uploadDocument = (tenantId, file) => upload('documents', file, tenantId);
export const uploadMaintenancePhotos = (files) => uploadMany('maintenance-photos', files);
export const uploadCleaningPhotos = (files) => uploadMany('cleaning-photos', files);
export const uploadInspectionPhotos = (files) => uploadMany('inspection-photos', files);
export const uploadMoveOutEvidencePhotos = (files) => uploadMany('move-out-evidence', files);
export const uploadBinOutEvidencePhoto = (file) => upload('bin-out-evidence', file);

/** Buckets are private — always use a signed URL (expires after `expiresInSeconds`) to display/open a file. */
export async function getSignedUrl(bucket, path, expiresInSeconds) {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, expiresInSeconds || 3600);
  if (error) throw error;
  return data.signedUrl;
}
