/**
 * ManagementAptos — send real-estate agency emails from Gmail to the app (every hour).
 *
 * Every hour this looks at the last 2 days of emails from the agencies / their portals and sends each
 * message to the app (Supabase function "agency-email"). The app reads it with Gemini, skips anything
 * already processed, and creates the notification / case — or files it as an "Update" under the
 * original case — exactly like the old scheduled check. Nothing is changed in Gmail.
 *
 * SETUP (once):
 *  1. script.google.com → New project → paste this whole file → Save. (Signed in as dafelipe2207@gmail.com.)
 *  2. Project Settings (gear) → Script properties → Add property:
 *       Name:  WEBHOOK_URL
 *       Value: https://iikdscwhwtkhlzzmqwur.supabase.co/functions/v1/agency-email?token=YOUR_TOKEN
 *     (YOUR_TOKEN = the AGENCY_EMAIL_TOKEN secret in Supabase → Edge Functions → Secrets.)
 *  3. In the editor pick the function "setup" and press Run. Accept the Gmail permissions.
 *     That creates the hourly timer and runs a first check. Done.
 *  View → Executions shows each run and the app's answer.
 *
 * RECEIPTS: when an agency email is a payment receipt with a PDF, the PDF goes along; the app keeps
 * it as the "Real estate receipt" of the rent payment or bill it covers.
 * Once, after updating this script: pick "backfillReceipts" and press Run — it sends the receipt PDFs
 * of the last 60 days (no new notifications are created).
 */

var QUERY = 'newer_than:2d -category:promotions (' + [
  'from:propertyme.com', 'from:propertytree.com', 'from:ipropertyexpress.com', 'from:yaran.com.au',
  'from:woodproperty.com.au', 'from:raywhite', 'from:sfrproperty', 'from:bricksandagent', 'from:inspectrealestate',
  'Lapage', '"Wright St"', '"Wright Street"', 'Bouverie', '"Tannery Walk"', '"Mackenzie St"', '"Mackenzie Street"'
].join(' OR ') + ')';
var ME = 'dafelipe2207@gmail.com';
var BATCH = 10;
var RECEIPT_RE = /receipt|recibo|payment received|thanks for your (recent )?payment/i;
var MAX_PDF = 5 * 1024 * 1024;

function setup() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendAgencyEmails') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendAgencyEmails').timeBased().everyHours(1).create();
  sendAgencyEmails();
}

function sendAgencyEmails() { run_(QUERY, false); }

/** One-off: the receipt PDFs of the last 60 days (only receipts; no notifications). */
function backfillReceipts() {
  run_(QUERY.replace('newer_than:2d', 'newer_than:60d') + ' has:attachment', true);
}

/** PDFs of a receipt email (a receipt is told by the subject / start of the body). */
function receiptPdfs_(m) {
  if (!RECEIPT_RE.test((m.getSubject() || '') + ' ' + (m.getPlainBody() || '').slice(0, 600))) return [];
  return m.getAttachments({ includeInlineImages: false }).filter(function (a) {
    return /pdf/i.test(a.getContentType()) && a.getSize() <= MAX_PDF;
  }).slice(0, 2).map(function (a) {
    return { name: a.getName(), mimeType: 'application/pdf', base64: Utilities.base64Encode(a.getBytes()) };
  });
}

function run_(query, receiptsOnly) {
  var url = PropertiesService.getScriptProperties().getProperty('WEBHOOK_URL');
  if (!url) throw new Error('Add the WEBHOOK_URL script property first (see SETUP).');

  var items = [];
  var threads = GmailApp.search(query, 0, receiptsOnly ? 100 : 50);
  threads.forEach(function (thread) {
    var msgs = thread.getMessages();
    var context = msgs.map(function (m) {
      return { messageId: m.getId(), date: m.getDate().toISOString(), from: m.getFrom(), subject: m.getSubject(),
               snippet: (m.getPlainBody() || '').replace(/\s+/g, ' ').slice(0, 500) };
    });
    msgs.forEach(function (m) {
      if (m.isDraft() || m.isInTrash()) return;
      if ((m.getFrom() || '').toLowerCase().indexOf(ME) !== -1) return; // Daniel's own sent emails
      if (!receiptsOnly && Date.now() - m.getDate().getTime() > 2 * 86400000) return;
      var pdfs = receiptPdfs_(m);
      if (receiptsOnly && !pdfs.length) return;
      items.push({
        messageId: m.getId(), threadId: thread.getId(), date: m.getDate().toISOString(),
        from: m.getFrom(), to: m.getTo(), subject: m.getSubject(),
        body: (m.getPlainBody() || '').slice(0, 12000),
        url: 'https://mail.google.com/mail/?authuser=' + ME + '#all/' + m.getId(),
        thread: context,
        attachments: pdfs
      });
    });
  });
  items.sort(function (a, b) { return a.date < b.date ? -1 : 1; });

  if (receiptsOnly) {
    // One receipt per call with a pause, so Gemini isn't flooded (it answers "too many requests").
    // Safe to run again: receipts already stored are skipped.
    items.forEach(function (it, k) {
      if (k) Utilities.sleep(6000);
      post(url, { receiptsOnly: true, messages: [it] });
    });
    return;
  }
  var runId = Utilities.getUuid();
  if (!items.length) { post(url, { runId: runId, final: true, messages: [] }); return; }
  for (var i = 0; i < items.length; i += BATCH) {
    post(url, { runId: runId, final: i + BATCH >= items.length, messages: items.slice(i, i + BATCH) });
  }
}

function post(url, payload) {
  var res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  Logger.log(res.getResponseCode() + ' ' + res.getContentText().slice(0, 2000));
  if (res.getResponseCode() >= 400) throw new Error('App answered ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
}
