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
  if (res.error) throw await describeFunctionError(res.error, 'The AI service could not be reached.');
  if (res.data && res.data.error) throw new Error(res.data.error);
  return res.data;
}

