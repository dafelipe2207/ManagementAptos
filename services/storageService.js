// services/storageService.js
// Uploads to the private Storage buckets and signed URLs to read them back. Every bucket is
// private and RLS restricts each user to files under `<their-auth-uid>/...` (staff can read all),
// so every path starts with the uploader's uid and reading needs a signed URL.
import { supabase, isViewOnly, VIEW_ONLY_MESSAGE } from '../lib/supabaseClient.js';
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

/* ---------- Inspection photos: one file at a time, with real progress ----------
 * The move-in / move-out photo composer uploads several photos in parallel and shows a progress
 * ring on each tile, so it talks to Storage's REST endpoint through XMLHttpRequest (supabase-js
 * gives no upload progress). Same bucket, same `<uid>/...` path rule, same RLS as uploadMany.
 * Every photo also gets a small JPEG thumbnail at `<uid>/thumbs/<name>` (see thumbPathFor) so
 * grids load ~30 KB tiles instead of full photos — no paid image-transformation service needed. */
export function thumbPathFor(path) {
  const parts = String(path || '').split('/');
  if (parts.length < 2) return '';
  return parts[0] + '/thumbs/' + parts.slice(1).join('/');
}

function xhrUpload(bucket, path, blob, token, onProgress) {
  return new Promise(function (resolve, reject) {
    const xhr = new XMLHttpRequest();
    const url = supabase.supabaseUrl + '/storage/v1/object/' + bucket + '/' + path.split('/').map(encodeURIComponent).join('/');
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', 'Bearer ' + token);
    xhr.setRequestHeader('apikey', supabase.supabaseKey);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
    xhr.setRequestHeader('cache-control', 'max-age=3600');
    if (onProgress && xhr.upload) xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) resolve(path);
      else {
        let msg = 'Upload failed (' + xhr.status + ')';
        try { const j = JSON.parse(xhr.responseText); if (j && (j.message || j.error)) msg = j.message || j.error; } catch (_e) { /* keep the status message */ }
        reject(new Error(msg));
      }
    };
    xhr.onerror = function () { reject(new Error('Network error — check your connection and try again.')); };
    xhr.onabort = function () { reject(new Error('Upload cancelled.')); };
    xhr.send(blob);
  });
}

/** Uploads one inspection photo (+ its optional thumbnail). `onProgress(0..1)` follows the main
 *  photo. Returns the storage path of the photo (the thumbnail path is always thumbPathFor(it)). */
export async function uploadInspectionPhotoWithProgress(file, thumbBlob, onProgress) {
  if (isViewOnly()) throw new Error(VIEW_ONLY_MESSAGE);
  const userId = await getCurrentUserId();
  const { data } = await supabase.auth.getSession();
  const token = data && data.session && data.session.access_token;
  const rand = Math.random().toString(36).slice(2, 7);
  const path = userId + '/' + Date.now() + '-' + rand + '-' + sanitizeFileName(file.name);
  if (!token || !supabase.supabaseUrl || !supabase.supabaseKey) {
    // No session token in hand (shouldn't happen once signed in) — fall back to supabase-js.
    const { error } = await supabase.storage.from('inspection-photos').upload(path, file, { upsert: false });
    if (error) throw error;
    if (onProgress) onProgress(1);
  } else {
    await xhrUpload('inspection-photos', path, file, token, onProgress);
  }
  supabase.__lastLocalWriteAt = Date.now();
  if (thumbBlob) {
    // Best effort: a missing thumbnail only means the grid falls back to the full photo.
    try { await xhrUpload('inspection-photos', thumbPathFor(path), thumbBlob, token, null); } catch (_e) { /* ignore */ }
  }
  return path;
}

/** Removes stored files (and their thumbnails) — best effort, never throws. */
export async function removeInspectionPhotos(paths) {
  const all = [];
  (paths || []).forEach(function (p) { if (p) { all.push(p); all.push(thumbPathFor(p)); } });
  if (!all.length) return;
  try { await supabase.storage.from('inspection-photos').remove(all); } catch (_e) { /* orphaned files are harmless */ }
}
