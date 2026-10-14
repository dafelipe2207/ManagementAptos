// services/aiService.js
// Sends a bill photo/PDF to the `analyze-bill` Supabase Edge Function, which reads it server-side
// with Azure AI Document Intelligence (prebuilt invoice model) and falls back to Gemini only for
// what Azure couldn't read reliably. It returns the bill's details plus `extraction` (every field
// with its confidence and source, line items, and validation issues). The API keys live only as
// Edge Function secrets; nothing secret ever reaches the browser.
import { supabase } from '../lib/supabaseClient.js';
import { describeFunctionError } from '../lib/errors.js?v=2';

function readFileAsBase64(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () {
      var result = reader.result || '';
      var comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = function () { reject(reader.error || new Error('Could not read the file.')); };
    reader.readAsDataURL(file);
  });
}

/** Phone photos are often 3–8 MB; sent as-is they're slow to upload on mobile data and heavy for
 *  the reader. Photos are scaled down to at most 2400 px on the long side (plenty for reading a
 *  bill) and re-encoded as JPEG. PDFs and small images go as they are; if anything fails, the
 *  original file is sent. */
var MAX_SIDE = 2400;
async function shrinkImage(file) {
  if (!file || !/^image\//.test(file.type || '') || /gif|svg/.test(file.type) || file.size < 900 * 1024) return file;
  try {
    var url = URL.createObjectURL(file);
    var img;
    try {
      img = await new Promise(function (resolve, reject) { var i = new Image(); i.onload = function () { resolve(i); }; i.onerror = reject; i.src = url; });
    } finally { URL.revokeObjectURL(url); }
    var w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return file;
    var scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.round(w * scale); c.height = Math.round(h * scale);
    var g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    var blob = await new Promise(function (resolve) { c.toBlob(resolve, 'image/jpeg', 0.85); });
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], (file.name || 'bill').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch (_e) {
    return file;
  }
}

/** The reader answers within ~75 s (server-side budget); past this the app stops waiting and
 *  lets the bill be filled in by hand instead of spinning forever. */
var CLIENT_TIMEOUT_MS = 95000;

/**
 * Analyzes a bill photo/PDF and returns the extracted fields:
 * { billType, provider, invoiceNumber, issueDate, dueDate, billingPeriodStart,
 *   billingPeriodEnd, amount, propertyId, propertyMatchConfidence, propertyGuessText }
 * Throws (with a plain message) on failure — network issues, a missing/invalid API key on the
 * server, or a file the model couldn't read. Callers should fall back to a blank manual-entry
 * form rather than blocking the import when this rejects.
 */
export async function analyzeBill(file, properties, today) {
  file = await shrinkImage(file);
  var imageBase64 = await readFileAsBase64(file);
  var propertyList = (properties || []).map(function (p) {
    return { id: p.id, name: p.name, address: p.address || '' };
  });
  var timer;
  var timeout = new Promise(function (_resolve, reject) {
    timer = setTimeout(function () {
      reject(new Error('The bill reader took too long to answer — fill in the details by hand, or try again with a clearer photo.'));
    }, CLIENT_TIMEOUT_MS);
  });
  var res;
  try {
    res = await Promise.race([supabase.functions.invoke('analyze-bill', {
      body: {
        imageBase64: imageBase64,
        mimeType: file.type || 'application/octet-stream',
        properties: propertyList,
        today: today
      }
    }), timeout]);
  } finally { clearTimeout(timer); }
  if (res.error) throw await describeFunctionError(res.error, 'The AI service could not be reached.');
  if (res.data && res.data.error) throw new Error(res.data.error);
  return res.data;
}

