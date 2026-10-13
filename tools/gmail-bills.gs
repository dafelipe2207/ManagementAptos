/**
 * ManagementAptos — send bills from Gmail to the app.
 *
 * Every 10 minutes this looks for emails labelled "Bills" (and not yet "Bills/Sent"), sends their
 * PDF/photo attachments to the app, and labels them "Bills/Sent". The app reads each bill,
 * skips anything already loaded, and puts the rest in Bills → "Pending review".
 *
 * SETUP (once):
 *  1. Go to script.google.com → New project → paste this whole file → Save.
 *  2. Project Settings (gear) → Script properties → Add property:
 *       Name:  WEBHOOK_URL
 *       Value: https://iikdscwhwtkhlzzmqwur.supabase.co/functions/v1/email-bill?token=YOUR_TOKEN
 *     (YOUR_TOKEN = the INBOUND_EMAIL_TOKEN secret you created in Supabase.)
 *  3. Back in the editor, pick the function "setup" and press Run. Accept the Gmail permissions.
 *     That creates the labels and the 10-minute timer. Done.
 *  4. In Gmail, put the "Bills" label on bill emails — by hand, or with a filter
 *     (e.g. from:(synergy.net.au OR alintaenergy.com.au OR watercorporation.com.au) → Apply label "Bills").
 */

var LABEL = 'Bills';
var DONE_LABEL = 'Bills/Sent';

function setup() {
  GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL);
  GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL);
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendBills') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendBills').timeBased().everyMinutes(10).create();
  sendBills();
}

function sendBills() {
  var url = PropertiesService.getScriptProperties().getProperty('WEBHOOK_URL');
  if (!url) throw new Error('Add the WEBHOOK_URL script property first (see SETUP).');
  var done = GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL);
  var threads = GmailApp.search('label:"' + LABEL + '" -label:"' + DONE_LABEL + '"', 0, 20);
  threads.forEach(function (thread) {
    var ok = true;
    thread.getMessages().forEach(function (msg) {
      var files = msg.getAttachments({ includeInlineImages: false }).filter(function (a) {
        return /pdf|image\//i.test(a.getContentType()) || /\.(pdf|png|jpe?g|heic)$/i.test(a.getName());
      });
      if (!files.length) return;
      var payload = {
        from: msg.getFrom(),
        subject: msg.getSubject(),
        attachments: files.map(function (a) {
          return { name: a.getName(), type: a.getContentType(), contentBase64: Utilities.base64Encode(a.getBytes()) };
        })
      };
      var res = UrlFetchApp.fetch(url, {
        method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true
      });
      if (res.getResponseCode() !== 200) { ok = false; console.error('App answered ' + res.getResponseCode() + ': ' + res.getContentText()); }
    });
    if (ok) thread.addLabel(done); // failed ones are retried on the next run
  });
}
