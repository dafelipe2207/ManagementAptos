// services/aiService.js
// Sends a bill photo/PDF to the `analyze-bill` Supabase Edge Function, which calls Gemini
// (Google's vision-capable AI) server-side to read the actual document — provider, bill type,
// dates, amount, and a best-guess property match against this account's properties. The AI
// API key lives only as an Edge Function secret; nothing secret ever reaches the browser.
import { supabase } from '../lib/supabaseClient.js';

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

/**
 * Analyzes a bill photo/PDF and returns the extracted fields:
 * { billType, provider, invoiceNumber, issueDate, dueDate, billingPeriodStart,
 *   billingPeriodEnd, amount, propertyId, propertyMatchConfidence, propertyGuessText }
 * Throws (with a plain message) on failure — network issues, a missing/invalid API key on the
 * server, or a file the model couldn't read. Callers should fall back to a blank manual-entry
 * form rather than blocking the import when this rejects.
 */
export async function analyzeBill(file, properties, today) {
  var imageBase64 = await readFileAsBase64(file);
  var propertyList = (properties || []).map(function (p) {
    return { id: p.id, name: p.name, address: p.address || '' };
  });
  var res = await supabase.functions.invoke('analyze-bill', {
    body: {
      imageBase64: imageBase64,
      mimeType: file.type || 'application/octet-stream',
      properties: propertyList,
      today: today
    }
  });
  if (res.error) throw await describeFunctionError(res.error);
  if (res.data && res.data.error) throw new Error(res.data.error);
  return res.data;
}

// supabase-js's default error for a non-2xx Edge Function response is a generic
// "Edge Function returned a non-2xx status code" — it doesn't read the response body.
// The actual, useful message (from our Edge Function's own json({error: '...'}) replies)
// is on err.context, which is the raw fetch Response. Read it here so the person sees the
// real reason (bad/missing API key, Gemini quota, etc.) instead of a generic error.
async function describeFunctionError(err) {
  try {
    if (err && err.context && typeof err.context.json === 'function') {
      var body = await err.context.clone().json();
      if (body && body.error) return new Error(body.error);
    }
  } catch (_e) { /* fall through to the generic message below */ }
  return err instanceof Error ? err : new Error((err && err.message) || 'The AI service could not be reached.');
}
