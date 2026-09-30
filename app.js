// app.js — orchestration layer: auth gate, initial async load from Supabase,
// render()/router wiring. Business logic and rendering below are adapted
// from artifact/index.html, preserved as closely as possible; the main
// structural change is that persistence now goes through the async
// services/* modules instead of synchronous localStorage.
import * as auth from './lib/auth.js?v=2';
import { friendlyErrorMessage } from './lib/errors.js';
import * as propertyService from './services/propertyService.js?v=2';
import * as roomService from './services/roomService.js';
import * as tenantService from './services/tenantService.js?v=6';
import * as bondService from './services/bondService.js';
import * as rentScheduleService from './services/rentScheduleService.js';
import * as paymentService from './services/paymentService.js';
import * as billService from './services/billService.js?v=3';
import * as billAllocationService from './services/billAllocationService.js?v=4';
import * as tenantDocumentService from './services/tenantDocumentService.js';
import * as storageService from './services/storageService.js?v=2';
import * as aiService from './services/aiService.js?v=3';
import * as migrationService from './services/migrationService.js';
import * as profileService from './services/profileService.js?v=5';
import * as maintenanceService from './services/maintenanceService.js';
import * as notificationService from './services/notificationService.js';
import * as paymentReportService from './services/paymentReportService.js';
import * as auditService from './services/auditService.js';
import * as recurringBillService from './services/recurringBillService.js';
import * as cleaningService from './services/cleaningService.js?v=3';
import * as trashService from './services/trashService.js';
import * as inspectionService from './services/inspectionService.js';
import * as weeklyDutyService from './services/weeklyDutyService.js?v=3';
import * as binDutyService from './services/binDutyService.js';
import * as binOutTaskService from './services/binOutTaskService.js?v=4';
import * as moveOutSettlementService from './services/moveOutSettlementService.js?v=1';
import * as taskIndexService from './services/taskIndexService.js?v=1';
import * as activityLogService from './services/activityLogService.js?v=1';
import * as entityLinkService from './services/entityLinkService.js';
import * as roomIncludedBillService from './services/roomIncludedBillService.js';

(function(){
  "use strict";

  // pdf.js (loaded as a plain global script in index.html, before this module) needs to know
  // where its worker script lives — same CDN build/version, so it always matches this pdfjsLib.
  if (typeof pdfjsLib !== 'undefined'){
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.4.120/build/pdf.worker.min.js';
  }

  /* ============ "Today" — the real current date, computed once at load ============ */
  var TODAY = toIsoLocal(new Date());

  /* ============ In-memory data, populated by bootstrapData() after sign-in ============ */
  var properties = [];
  var rooms = [];
  var tenants = [];
  var bonds = [];
  var moveOutSettlements = []; // one row per move-out attempt per tenant — see moveOutSettlementService.js
  /* Role/session state — set once by enterApp() right after sign-in, before anything else
   * loads. currentProfile is the signed-in user's own profiles row (role, name, active status);
   * allProfiles/maintenanceRequests/notificationsList are populated by bootstrapData(). RLS is
   * what actually enforces who can see what — these helpers just drive what the UI *offers*. */
  var currentProfile = null;
  var allProfiles = [];
  var propertyAssignments = []; // [{id, propertyId, profileId}] — which Administrator sees which property (super_admin only, loaded in bootstrapData)
  var maintenanceRequests = [];
  var notificationsList = [];
  var paymentReports = []; // tenant-reported payments awaiting admin confirmation — see paymentReportService.js
  var cleaningTasks = [];
  var cleaningSubmissions = [];
  var cleaningComments = [];
  var trashSchedule = [];
  var weeklyDuties = []; // Cleaning's own (room, period) container, weekly cadence; see weeklyDutyService.js
  var binDuties = []; // Bin OUT's own (room, period) container, fortnightly cadence; see binDutyService.js
  var binOutTasks = []; // independent Bin OUT sub-tasks, one per pickup date landing in a bin_duty's period; see binOutTaskService.js
  var taskIndexRows = []; // task_index — current-state read model, see taskIndexService.js
  var activityLogRows = []; // activity_log — historical event feed, see activityLogService.js
  var inspectionSubmissions = [];
  var inspectionComments = [];
  var entityLinks = []; // entity_links — generic cross-module relations; Phase 2's Inspection -> Create Issue
                         // is its first real consumer (see entityLinkService.js). Loaded once at bootstrap,
                         // updated locally (push) after linkEntities() calls, same pattern as other lists here.
  var roomIncludedBills = []; // room_included_bills — admin-paid costs bundled into a room's rent, Profits-page-only
  var signedUrlCache = {}; // "bucket|path" -> { url, expiresAt }
  var PHONE_LOGIN_SUFFIX = '@tenant.belmontmanager.internal'; // must match the create-user Edge Function exactly
  function isPhoneLoginProfile(p){ return p.role === 'tenant' && p.email && p.email.indexOf(PHONE_LOGIN_SUFFIX) > -1; }
  function phoneDigitsOnly(raw){ return (raw || '').replace(/[^0-9]/g, ''); }
  function isSuperAdmin(){ return !!currentProfile && currentProfile.role === 'super_admin'; }
  function isStaff(){ return !!currentProfile && (currentProfile.role === 'super_admin' || currentProfile.role === 'administrator'); }
  function isTenantRole(){ return !!currentProfile && currentProfile.role === 'tenant'; }
  /** Bills from this provider are NEVER shown to or sent to tenants — not in "My Bills",
   *  not in the outstanding balance on their dashboard, and not with the WhatsApp buttons
   *  (individual or group) on the admin side. Comparison is case/whitespace-insensitive so it
   *  doesn't depend on exactly how the provider name was typed in. */
  function isTenantHiddenProvider(provider){ return (provider || '').trim().toUpperCase() === 'RS'; }
  /** Same "no longer lives here" test used for the tenancy badge elsewhere (deactivated, or
   *  their actual move-out date has arrived) — pulled out so Payments can reuse it to decide
   *  which tenants still belong in the list. */
  function tenantHasMovedOut(t){ return t.isActive === false || !!(t.actualMoveOutDate && t.actualMoveOutDate <= TODAY); }
  /**
   * Converts a Date object (built in LOCAL time, e.g. with
   * `new Date(iso+'T00:00:00')`) back to 'YYYY-MM-DD' using its
   * local components. `toISOString()` does NOT work for this: it converts to
   * UTC first, so in any timezone with a positive offset
   * (Perth, UTC+8, for example) a date computed as "September 30th
   * at local midnight" becomes "September 29th, 16:00 UTC", and
   * slice(0,10) returns the wrong day. All date calculations in the
   * app (rent periods, dueDates, bill extraction) go through this function.
   */
  function toIsoLocal(d){
    var y = d.getFullYear();
    var m = String(d.getMonth()+1).padStart(2,'0');
    var day = String(d.getDate()).padStart(2,'0');
    return y+'-'+m+'-'+day;
  }

  /** Adds `days` BUSINESS days (Monday to Friday, not counting holidays) to a 'YYYY-MM-DD' date.
   *  Used to compute a default payment due date when a bill imported via AI doesn't have a
   *  printed/legible due date — 10 business days after the issue date, instead of
   *  leaving the field empty and blocking saving. */
  function addBusinessDays(isoDate, days){
    var d = new Date(isoDate+'T00:00:00');
    var added = 0;
    while (added < days){
      d.setDate(d.getDate()+1);
      var dow = d.getDay(); // 0=Sunday, 6=Saturday
      if (dow !== 0 && dow !== 6) added++;
    }
    return toIsoLocal(d);
  }

  /**
   * rentService — generates rent charges from a RentSchedule.
   * Isolated from the rest of the logic (brief section 35: dedicated
   * services for "Rent calculations").
   */
  var rentService = (function(){
    function stepDate(iso, days){
      var d = new Date(iso + 'T00:00:00');
      d.setDate(d.getDate() + days);
      return toIsoLocal(d);
    }
    function addMonths(iso, months){
      var d = new Date(iso + 'T00:00:00');
      d.setMonth(d.getMonth() + months);
      return toIsoLocal(d);
    }
    function periodLengthDays(freq){
      return freq==='weekly' ? 7 : freq==='fortnightly' ? 14 : null;
    }
    function round2(n){ return Math.round(n*100)/100; }

    /**
     * Generates ALL periods from `schedule.startDate` up to the first
     * period that starts after `asOfIso` (a single "future" period),
     * respecting the tenant's move-out date if it exists (section 32:
     * never generate charges for after the tenant no longer lives there).
     */
    // Business rule: the tenant must pay 2 weeks in advance — the due date for
    // each period falls 14 days BEFORE that period starts, not on the same day. So if today is
    // the due date of the week starting 20/10, that week should already have been paid since
    // 06/10 (14 days before), and the tenant must always keep a 2-week buffer paid.
    var ADVANCE_DAYS = 14;
    // How many FUTURE periods (that haven't started yet) are generated at once — there's no need
    // to look further ahead than what's actually needed to show as "upcoming": 1 if the cycle is
    // fortnightly or monthly, 2 if it's weekly (so the notice window is always ~2 weeks in
    // both cases, instead of generating charges further and further ahead that aren't due yet).
    function futureLookahead(frequency){ return frequency === 'weekly' ? 2 : 1; }
    function generateAllPeriods(schedule, tenant, asOfIso){
      var periods = [];
      var cutoff = tenant.actualMoveOutDate || tenant.expectedMoveOutDate || null;
      var cursor = schedule.startDate;
      var isFirstPeriod = true;
      var lookahead = futureLookahead(schedule.frequency);
      var futurePushed = 0;
      while (true){
        if (cutoff && cursor > cutoff) break;
        var isFuture = cursor > asOfIso;
        if (isFuture && futurePushed >= lookahead) break;
        var end = schedule.frequency === 'monthly'
          ? stepDate(addMonths(cursor, 1), -1)
          : stepDate(cursor, periodLengthDays(schedule.frequency) - 1);
        // The first period of the tenancy is the exception to the "2 weeks in
        // advance" rule: before moving in, the tenant only pays the bond to reserve the
        // room — rent is only owed from when they move in, not 14 days before (that day
        // they weren't even a tenant yet). That's why the first period's due date is
        // the move-in date itself, and only from the second period onward is the
        // 2-week buffer required.
        var dueDate = isFirstPeriod ? cursor : stepDate(cursor, -ADVANCE_DAYS);
        periods.push({ periodStart: cursor, periodEnd: end, dueDate: dueDate });
        isFirstPeriod = false;
        if (isFuture) futurePushed++;
        cursor = schedule.frequency === 'monthly' ? addMonths(cursor, 1) : stepDate(cursor, periodLengthDays(schedule.frequency));
      }
      return periods;
    }

    // "Overdue" only when the period has ALREADY started (reached its first day) and is still
    // unpaid — it's not enough to have passed the ideal advance-payment date (dueDate, 14 days
    // before). That 2-week buffer date is still stored in dueDate in case it's needed for
    // something else, but it no longer determines the status: while the period hasn't started
    // it's "upcoming" — only once its start date arrives without a payment recorded does it
    // become "overdue".
    function computeStatus(period, amountPaid, remaining, asOfIso){
      if (remaining <= 0.004) return 'paid';
      if (amountPaid > 0) return 'partially_paid';
      if (period.periodStart <= asOfIso) return 'overdue';
      return 'upcoming';
    }

    /** Allocates a tenant's payments against ALL of their periods since move-in (not just
     *  a recent window), in chronological order (FIFO), so that each overdue
     *  week/fortnight appears as its own row in Payments. */
    function generateChargesForTenant(tenant, schedule, asOfIso, allPayments){
      if (!schedule || tenant.rentAmount <= 0) return [];
      var periods = generateAllPeriods(schedule, tenant, asOfIso);
      var pays = allPayments
        .filter(function(p){ return p.tenantId === tenant.id; })
        .slice()
        .sort(function(a,b){ return a.date.localeCompare(b.date); });
      var payIdx = 0, payLeft = pays.length ? pays[0].amount : 0;

      return periods.map(function(period){
        var amountDue = schedule.amount;
        var need = amountDue, amountPaid = 0, lastPaidDate = null;
        while (need > 0.004 && payIdx < pays.length){
          var take = Math.min(need, payLeft);
          amountPaid += take; need -= take; payLeft -= take;
          // The date of the payment that actually covered (part of) this period — if the period
          // ends up fully paid, this is "when it was paid"; if it's left with a balance, it's the
          // date of the last partial payment received.
          lastPaidDate = pays[payIdx].date;
          if (payLeft <= 0.004){ payIdx++; payLeft = payIdx < pays.length ? pays[payIdx].amount : 0; }
        }
        amountPaid = round2(amountPaid);
        var remaining = round2(amountDue - amountPaid);
        return {
          id: tenant.id + '-' + period.periodStart,
          tenantId: tenant.id,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          dueDate: period.dueDate,
          amountDue: amountDue,
          amountPaid: amountPaid,
          remaining: remaining,
          paidDate: amountPaid > 0 ? lastPaidDate : null,
          status: computeStatus(period, amountPaid, remaining, asOfIso)
        };
      });
    }

    return { generateChargesForTenant: generateChargesForTenant };
  })();

  /**
   * PHASE 8 — OCR/AI bill extraction (the "Import Bill" section of the brief):
   * the invoice photo/PDF is sent to the `analyze-bill` Edge Function
   * (services/aiService.js), which calls Gemini (Google) server-side
   * to actually read the document — provider, type, dates,
   * amount, and a suggested property based on matching the address/name
   * against existing properties. The API key lives as an Edge Function
   * secret, never in the frontend. The result still goes through the
   * same review screen as always (queue -> "analyzing" ->
   * review/edit -> confirm), so an error or a misread value
   * is always corrected by hand before saving.
   */

  /**
   * PHASE 4 — Rent system (brief section 9): rent charges are NO LONGER
   * entered by hand. `rentService` (below) generates them automatically
   * from a per-tenant `RentSchedule` (frequency, amount, start
   * date), applying recorded payments in chronological order (FIFO) to
   * derive amountPaid/remaining/status. ONE period is generated per
   * week/fortnight/month from move-in to today (plus one future one) — not just
   * the last 3 — so that a tenant who is several months behind shows each
   * outstanding week as its own separate row in Payments, and the administrator knows
   * exactly which week each payment is settling.
   */
  var rentSchedules = [];
  var paymentRecords = [];

  /* ---------- PHASE 13: Notifications (read/unread state persisted; local UI state only, not business data) ---------- */
  var NOTIF_READ_KEY = 'belmont-manager-notif-read-v1';
  function loadNotifRead(){
    try { var raw = localStorage.getItem(NOTIF_READ_KEY); if (raw) return JSON.parse(raw); } catch(e){ /* ignore */ }
    return [];
  }
  function saveNotifRead(list){ try { localStorage.setItem(NOTIF_READ_KEY, JSON.stringify(list)); } catch(e){ /* ignore */ } }
  var notifReadIds = loadNotifRead();

  var rentCharges = [];
  function recomputeRentCharges(){
    rentCharges = tenants
      .filter(function(t){ return t.rentAmount > 0; })
      .reduce(function(acc, t){
        var schedule = rentSchedules.find(function(s){ return s.tenantId===t.id; });
        return acc.concat(rentService.generateChargesForTenant(t, schedule, TODAY, paymentRecords));
      }, [])
      .sort(function(a,b){ return b.periodStart.localeCompare(a.periodStart); }); // most recent first, oldest last
  }
  recomputeRentCharges();

  /** Records a payment against Supabase; only mutates the in-memory ledger once the insert succeeds. Returns the
   *  saved payment on success, or null on failure. `date` defaults to today but can be set to whenever the tenant
   *  actually paid (may be earlier than today). The success toast offers an immediate "Undo" — for when the admin
   *  picked the wrong date, or confirmed a payment that hadn't actually happened. */
  async function recordPayment(tenantId, amount, date, method){
    amount = Math.round(amount*100)/100;
    if (!(amount > 0)) return null;
    try {
      var saved = await paymentService.create({ tenantId:tenantId, amount:amount, date: date || TODAY, method: method || 'cash' });
      paymentRecords.push(saved);
      recomputeRentCharges();
      // A bond-deduction "payment" isn't something the admin can undo the same way (it's part of
      // a move-out settlement, not a mistaken entry) — no undo toast for those.
      if (saved.method === 'bond_deduction'){
        showToast('Outstanding rent settled from the bond.', 'success');
      } else {
        showToast('Payment recorded.', 'success', { label:'Undo', onClick: function(){ undoRecordedPayment(saved.id); } });
      }
      return saved;
    } catch(err){
      showToast('Could not record the payment. ' + friendlyErrorMessage(err), 'error');
      return null;
    }
  }
  /** Undoes a payment that was just recorded (shortcut from the toast's "Undo") — for when the
   *  administrator picked the wrong date, or confirmed a payment that hadn't actually happened. The
   *  same correction is also available later from "View history" (✕ or ✎). */
  async function undoRecordedPayment(paymentId){
    var ok = await removePayment(paymentId);
    if (ok){
      render();
      showToast('Payment undone.', 'success');
    }
  }
  window.undoRecordedPayment = undoRecordedPayment;
  async function removePayment(paymentId){
    try {
      await paymentService.remove(paymentId);
      paymentRecords = paymentRecords.filter(function(p){ return p.id !== paymentId; });
      recomputeRentCharges();
      return true;
    } catch(err){
      showToast('Could not remove the payment. ' + friendlyErrorMessage(err), 'error');
      return false;
    }
  }
  /** Pays this charge and any earlier unpaid period for the same tenant (the ledger is FIFO).
   *  `date` is the ACTUAL date the tenant paid (may be several days ago) — not always
   *  today, which is why openChargePaidModal asks for it instead of just assuming TODAY. */
  async function markChargeAsPaid(chargeId, date){
    var charge = rentCharges.find(function(c){ return c.id===chargeId; });
    if (!charge) return;
    var owed = rentCharges
      .filter(function(c){ return c.tenantId===charge.tenantId && c.periodStart<=charge.periodStart; })
      .reduce(function(sum,c){ return sum + c.remaining; }, 0);
    await recordPayment(charge.tenantId, owed, date);
    render();
  }

  /* ---------- Modal: confirm "Mark as Paid" on a rent charge with the actual date it was paid ---------- */
  var chargePaidModalChargeId = null;
  function openChargePaidModal(chargeId){
    var charge = rentCharges.find(function(c){ return c.id===chargeId; });
    if (!charge) return;
    var t = tenantOf(charge.tenantId);
    var owed = rentCharges
      .filter(function(c){ return c.tenantId===charge.tenantId && c.periodStart<=charge.periodStart; })
      .reduce(function(sum,c){ return sum + c.remaining; }, 0);
    chargePaidModalChargeId = chargeId;
    document.getElementById('charge-paid-modal-sub').textContent = (t?t.fullName:'') + ' • ' + money(owed);
    var dateInput = document.getElementById('charge-paid-modal-date');
    dateInput.value = TODAY; // editable: the tenant may have paid several days ago, not necessarily today
    document.getElementById('charge-paid-modal').hidden = false;
  }
  function closeChargePaidModal(){
    document.getElementById('charge-paid-modal').hidden = true;
    chargePaidModalChargeId = null;
  }
  async function confirmChargePaidModal(){
    var chargeId = chargePaidModalChargeId;
    var dateInput = document.getElementById('charge-paid-modal-date');
    var date = dateInput.value || TODAY;
    closeChargePaidModal();
    if (!chargeId) return;
    await markChargeAsPaid(chargeId, date);
  }
  window.openChargePaidModal = openChargePaidModal;
  window.closeChargePaidModal = closeChargePaidModal;
  window.confirmChargePaidModal = confirmChargePaidModal;

  /* ---------- Modal: Record a payment (partial or full, with the actual date it was paid) ---------- */
  var partialModalChargeId = null;
  function openPartialModal(chargeId){
    var charge = rentCharges.find(function(c){ return c.id===chargeId; });
    if (!charge) return;
    var t = tenantOf(charge.tenantId);
    partialModalChargeId = chargeId;
    document.getElementById('partial-modal-sub').textContent =
      (t?t.fullName:'') + ' • remaining ' + money(charge.remaining);
    var input = document.getElementById('partial-modal-input');
    input.value = '';
    input.max = charge.remaining;
    var dateInput = document.getElementById('partial-modal-date');
    if (dateInput) dateInput.value = TODAY; // editable: the tenant may have paid on a different day than today
    document.getElementById('partial-modal').hidden = false;
    input.focus();
  }
  function closePartialModal(){
    document.getElementById('partial-modal').hidden = true;
    partialModalChargeId = null;
  }
  async function confirmPartialModal(){
    var chargeId = partialModalChargeId;
    var charge = rentCharges.find(function(c){ return c.id===chargeId; });
    var input = document.getElementById('partial-modal-input');
    var amount = parseFloat(input.value);
    var dateInput = document.getElementById('partial-modal-date');
    var date = (dateInput && dateInput.value) ? dateInput.value : TODAY;
    closePartialModal();
    if (!charge || !isFinite(amount) || amount <= 0) return;
    if (amount > charge.remaining) amount = charge.remaining; // overpayment is not allowed
    await recordPayment(charge.tenantId, amount, date);
    render();
  }

  /* ---------- Modal: Payment history (view, correct a mistaken entry, or remove) ---------- */
  var historyModalTenantId = null;
  var historyModalEditingId = null; // payment currently shown in inline edit mode, or null
  function historyRowHtml(p){
    if (p.id === historyModalEditingId){
      return '<div class="history-row" style="align-items:flex-end;gap:8px;">'+
        '<span style="display:flex;flex-direction:column;gap:4px;">'+
          '<label style="font-size:10.5px;color:var(--text-faint);">Amount</label>'+
          '<input id="history-edit-amount" class="modal-input" type="number" min="0" step="0.01" value="'+p.amount+'" style="width:100px;" />'+
        '</span>'+
        '<span style="display:flex;flex-direction:column;gap:4px;">'+
          '<label style="font-size:10.5px;color:var(--text-faint);">Date paid</label>'+
          '<input id="history-edit-date" class="modal-input" type="date" value="'+p.date+'" style="width:140px;" />'+
        '</span>'+
        '<span style="display:flex;gap:4px;">'+
          '<button class="mini-btn" onclick="cancelEditPayment()">Cancel</button>'+
          '<button class="mini-btn primary" onclick="saveEditedPayment(\''+p.id+'\')">Save</button>'+
        '</span>'+
      '</div>';
    }
    // Bond-deduction entries were never a payment the tenant made — labeled clearly instead of
    // edit/remove controls that imply a normal, correctable cash entry (see move-out settlement).
    if (p.method === 'bond_deduction'){
      return '<div class="history-row"><span>'+fullDate(p.date)+'</span>'+
        '<span style="display:flex;align-items:center;gap:8px;font-weight:600;">'+money(p.amount)+
        badge('neutral','Bond deduction')+'</span></div>';
    }
    return '<div class="history-row"><span>'+fullDate(p.date)+'</span>'+
      '<span style="display:flex;align-items:center;gap:6px;font-weight:600;">'+money(p.amount)+
      '<button class="del" title="Correct this payment" style="color:var(--text-dim);" onclick="startEditPayment(\''+p.id+'\')">✎</button>'+
      '<button class="del" title="Remove payment" onclick="removePaymentAndRefresh(\''+p.id+'\')">✕</button></span></div>';
  }
  /** Re-renders just the history modal's body from current state (historyModalTenantId /
   *  historyModalEditingId), without resetting which row (if any) is mid-edit — used by
   *  startEditPayment/cancelEditPayment/saveEditedPayment so they don't clobber their own edit state. */
  function renderHistoryModalBody(){
    var tenantId = historyModalTenantId;
    var t = tenantOf(tenantId);
    var pays = paymentRecords.filter(function(p){ return p.tenantId===tenantId; })
      .slice().sort(function(a,b){ return b.date.localeCompare(a.date); });
    document.getElementById('history-modal-title').textContent = (t?t.fullName:'') + ' — Payment history';
    document.getElementById('history-modal-body').innerHTML = pays.length===0
      ? '<p style="font-size:13px;color:var(--text-faint);margin:8px 0;">No payments recorded yet.</p>'
      : pays.map(historyRowHtml).join('');
  }
  function openHistoryModal(tenantId){
    historyModalTenantId = tenantId;
    historyModalEditingId = null;
    renderHistoryModalBody();
    document.getElementById('history-modal').hidden = false;
  }
  function closeHistoryModal(){
    document.getElementById('history-modal').hidden = true;
    historyModalTenantId = null;
    historyModalEditingId = null;
  }
  async function removePaymentAndRefresh(paymentId){
    var payment = paymentRecords.find(function(p){ return p.id===paymentId; });
    await removePayment(paymentId);
    render();
    if (payment) openHistoryModal(payment.tenantId);
  }
  /** Lets the admin fix a payment that was recorded by mistake (wrong amount, or the tenant
   *  actually hadn't paid yet) without deleting and re-entering it — switches that one row
   *  in the history list into an inline amount+date editor. */
  function startEditPayment(paymentId){
    historyModalEditingId = paymentId;
    renderHistoryModalBody();
  }
  function cancelEditPayment(){
    historyModalEditingId = null;
    renderHistoryModalBody();
  }
  async function saveEditedPayment(paymentId){
    var amountInput = document.getElementById('history-edit-amount');
    var dateInput = document.getElementById('history-edit-date');
    var amount = parseFloat(amountInput.value);
    var date = dateInput.value;
    if (!isFinite(amount) || amount <= 0 || !date){
      showToast('Enter a valid amount and date.', 'error');
      return;
    }
    try {
      var saved = await paymentService.update(paymentId, { amount: Math.round(amount*100)/100, date: date });
      var idx = paymentRecords.findIndex(function(p){ return p.id === paymentId; });
      if (idx >= 0) paymentRecords[idx] = saved;
      recomputeRentCharges();
      showToast('Payment corrected.', 'success');
    } catch(err){
      showToast('Could not update the payment. ' + friendlyErrorMessage(err), 'error');
    }
    historyModalEditingId = null;
    render();
    if (historyModalTenantId) renderHistoryModalBody();
  }

  window.markChargeAsPaid = markChargeAsPaid;
  window.openPartialModal = openPartialModal;
  window.closePartialModal = closePartialModal;
  window.confirmPartialModal = confirmPartialModal;
  window.openHistoryModal = openHistoryModal;
  window.closeHistoryModal = closeHistoryModal;
  window.removePaymentAndRefresh = removePaymentAndRefresh;
  window.startEditPayment = startEditPayment;
  window.cancelEditPayment = cancelEditPayment;
  window.saveEditedPayment = saveEditedPayment;
  window.setPaymentsFilter = setPaymentsFilter;
  window.setPaymentsTenantFilter = setPaymentsTenantFilter;
  window.setBillsFilter = setBillsFilter;
  window.setBillsPropertyFilter = setBillsPropertyFilter;

  var bills = [];
  var recurringBills = [];
  /** Persists a bill's mutable fields (status/allocationMethod/receiptPath/etc) back to Supabase. Throws on failure — callers decide how to surface it. */
  async function persistBill(bill){
    var saved = await billService.update(bill.id, bill);
    // keep any extra in-memory fields (like `allocations`) that the DB row doesn't carry
    Object.assign(bill, saved);
    return bill;
  }
  /* ============ Utils ============ */
  var currencyFmt = new Intl.NumberFormat('en-AU', { style:'currency', currency:'AUD', minimumFractionDigits:2 });
  function money(n){ return currencyFmt.format(n); }
  /** Converts any {amount, frequency} pair to its steady weekly-equivalent value.
   *  'monthly' NEVER divides by 4 — it uses the real weeks-per-month ratio
   *  (52 weeks/year / 12 months/year), so $1,690/month and $390/week normalize
   *  to the identical weekly figure. */
  function normalizeToWeekly(amount, frequency){
    if (amount == null) return 0;
    if (frequency === 'fortnightly') return amount / 2;
    if (frequency === 'monthly') return amount * 12 / 52;
    return amount; // 'weekly' (and any unrecognized value falls back to as-is)
  }
  function weeklyToMonthly(weekly){ return weekly * 52 / 12; }
  function weeklyToAnnual(weekly){ return weekly * 52; }
  function weeklyToFortnightly(weekly){ return weekly * 2; }
  function shortDate(iso){
    var d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-AU', { day:'2-digit', month:'short' });
  }
  function fullDate(iso){
    var d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-AU', { day:'2-digit', month:'short', year:'numeric' });
  }
  function daysBetween(a,b){ return Math.round((new Date(b)-new Date(a))/86400000); }
  function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
  function addMonthsIso(iso, months){
    var d = new Date(iso + 'T00:00:00');
    d.setMonth(d.getMonth() + months);
    return toIsoLocal(d);
  }
  function stepDateIso(iso, days){
    var d = new Date(iso + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return toIsoLocal(d);
  }
  /** The next date on/after `iso` that falls on `targetDow` (0=Sunday..6=Saturday) — used to
   *  default the cleaning rotation's first date to the coming weekend. */
  function nextWeekdayIso(iso, targetDow){
    var d = new Date(iso + 'T00:00:00');
    var diff = (targetDow - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + diff);
    return toIsoLocal(d);
  }

  /* ============ dashboardService (same logic as src/services/dashboardService.ts) ============ */
  function isRoomOccupied(room){
    return tenants.some(function(t){
      if (t.roomId !== room.id || t.rentAmount <= 0) return false;
      var movedIn = t.moveInDate <= TODAY;
      var movedOut = t.actualMoveOutDate ? t.actualMoveOutDate <= TODAY : false;
      return movedIn && !movedOut;
    });
  }
  /** The date this (currently vacant) room has been empty since — the most recent move-out
   *  date among tenants who used to live there, or null if it's never had a tenant (in which
   *  case it's treated as vacant since before any move-out on record, i.e. the longest-vacant
   *  case — see vacantRoomsOldestFirst). */
  function roomVacantSinceDate(room){
    var moveOuts = tenants
      .filter(function(t){ return t.roomId === room.id && t.actualMoveOutDate && t.actualMoveOutDate <= TODAY; })
      .map(function(t){ return t.actualMoveOutDate; });
    return moveOuts.length ? moveOuts.sort().pop() : null;
  }
  /** Every vacant room across all properties, oldest vacancy first (a room that's never had a
   *  tenant counts as the longest-vacant, since there's no move-out date to say otherwise). */
  function vacantRoomsOldestFirst(){
    return rooms.filter(function(r){ return !isRoomOccupied(r); })
      .map(function(r){ return { room:r, since: roomVacantSinceDate(r) }; })
      .sort(function(a,b){
        if (!a.since && !b.since) return 0;
        if (!a.since) return -1;
        if (!b.since) return 1;
        return a.since.localeCompare(b.since);
      });
  }
  function getDashboardSummary(){
    var occupied = rooms.filter(isRoomOccupied).length;
    var expected = rentCharges.reduce(function(s,c){ return s+c.amountDue; },0);
    var received = rentCharges.reduce(function(s,c){ return s+c.amountPaid; },0);
    var outstanding = rentCharges.reduce(function(s,c){ return s+c.remaining; },0);
    var overdueCount = rentCharges.filter(function(c){ return c.status==='overdue'; }).length;
    var billsPending = bills.filter(function(b){ return billEffectiveStatus(b) !== 'paid'; }).length;
    return {
      totalProperties: properties.length,
      occupiedRooms: occupied,
      vacantRooms: rooms.length - occupied,
      totalRentExpected: expected,
      totalRentReceived: received,
      totalOutstanding: outstanding,
      overduePaymentsCount: overdueCount,
      billsPendingCount: billsPending
    };
  }
  /** Individual bill shares that are still unpaid whose bill is already overdue (for the dashboard and, later, Reports). */
  function getOverdueUnpaidBillShares(){
    var items = [];
    bills.forEach(function(b){
      if (!b.allocations || !b.allocations.length) return;
      if (billEffectiveStatus(b) !== 'overdue') return;
      var property = properties.find(function(p){ return p.id === b.propertyId; });
      b.allocations.forEach(function(a){
        if (a.paid) return;
        var tenant = tenants.find(function(t){ return t.id===a.tenantId; });
        items.push({
          type: 'bill',
          billId: b.id,
          tenantId: a.tenantId,
          tenantName: tenant ? tenant.fullName : 'Unknown tenant',
          propertyName: property ? property.name : '—',
          provider: b.provider,
          amountRemaining: a.amount,
          daysOverdue: Math.max(0, daysBetween(b.dueDate, TODAY))
        });
      });
    });
    return items;
  }
  function getNeedsAttention(){
    // A tenant who is several months behind now has many overdue periods in rentCharges
    // (one per week/fortnight, see generateChargesForTenant) — "Needs attention" keeps only
    // the most recent one per tenant so it doesn't repeat a row for every week; the full
    // week-by-week breakdown lives in Payments (with the filter by tenant).
    var mostRecentByTenant = {};
    rentCharges
      .filter(function(c){ return c.status==='overdue' || c.status==='partially_paid'; })
      .forEach(function(c){
        var existing = mostRecentByTenant[c.tenantId];
        if (!existing || c.periodStart > existing.periodStart) mostRecentByTenant[c.tenantId] = c;
      });
    var rentItems = Object.keys(mostRecentByTenant)
      .map(function(tenantId){ return mostRecentByTenant[tenantId]; })
      .map(function(c){
        var tenant = tenants.find(function(t){ return t.id===c.tenantId; });
        var room = rooms.find(function(r){ return r.id === (tenant && tenant.roomId); });
        var property = properties.find(function(p){ return p.id === (tenant && tenant.propertyId); });
        return {
          type: 'rent',
          chargeId: c.id,
          tenantName: tenant ? tenant.fullName : 'Unknown tenant',
          propertyName: property ? property.name : '—',
          roomName: room ? room.name : '—',
          amountRemaining: c.remaining,
          status: c.status,
          daysOverdue: c.status==='overdue' ? Math.max(0, daysBetween(c.periodStart, TODAY)) : 0
        };
      })
      .sort(function(a,b){
        if (a.status !== b.status) return a.status==='overdue' ? -1 : 1;
        if (a.status==='overdue') return b.daysOverdue - a.daysOverdue;
        return b.amountRemaining - a.amountRemaining;
      });
    var billItems = getOverdueUnpaidBillShares()
      .sort(function(a,b){
        if (a.daysOverdue !== b.daysOverdue) return b.daysOverdue - a.daysOverdue;
        return b.amountRemaining - a.amountRemaining;
      });
    var leaseItems = getUpcomingLeasePayments();
    return rentItems.concat(billItems).concat(leaseItems);
  }
  /** Properties whose ADMIN-to-real-estate rent payment is due today, tomorrow, or the day
   *  after tomorrow (warns 2 days ahead, as requested) — or that is ALREADY overdue and wasn't
   *  marked as paid ("generate an alert in case the payment isn't made"), so the date doesn't get missed. */
  function getUpcomingLeasePayments(){
    return properties
      .map(function(p){
        var nextDue = nextLeaseDueDate(p, TODAY);
        if (!nextDue) return null;
        return { type:'lease', propertyId:p.id, propertyName:p.name, amount:p.leasePaymentAmount,
          dueDate:nextDue, daysUntil: daysBetween(TODAY, nextDue) };
      })
      .filter(function(item){ return item && item.daysUntil <= 2; })
      .sort(function(a,b){ return a.daysUntil - b.daysUntil; });
  }
  function getUpcomingEvents(withinDays){
    withinDays = withinDays || 14;
    var limit = new Date(TODAY + 'T00:00:00'); limit.setDate(limit.getDate()+withinDays);
    var limitIso = toIsoLocal(limit);
    return buildCalendarEvents()
      .filter(function(e){ return e.date >= TODAY && e.date <= limitIso; })
      .sort(function(a,b){ return a.date.localeCompare(b.date); });
  }
  /**
   * PHASE 10 — Calendar (brief section): instead of a hand-written list of
   * events, calendar events are DERIVED from the same data that already
   * drives Payments and Bills (rent charges, bills, tenants),
   * just like rentService generates rent charges from the schedule.
   * This way the calendar can never get out of sync with a recorded
   * payment or a bill marked as paid.
   */
  function buildCalendarEvents(){
    var events = [];
    // A tenant has no access to the bill/tenant/property detail pages (router blocks them — see
    // render()), and must never see anything about the landlord's own lease with the real estate
    // agent — so notification links point at pages a tenant can actually open, and real-estate
    // lease/inspection events are skipped for them entirely.
    var tenantMode = isTenantRole();
    rentCharges.forEach(function(c){
      if (c.status === 'paid') return; // already resolved, doesn't contribute to the calendar
      var t = tenantOf(c.tenantId);
      if (!t) return;
      events.push({
        date: c.dueDate,
        kind: c.status === 'overdue' ? 'overdue' : 'due',
        title: t.fullName + ' — Rent due',
        href: '#/payments'
      });
    });
    bills.forEach(function(b){
      if (billEffectiveStatus(b) === 'paid') return;
      var kind = billEffectiveStatus(b) === 'overdue' ? 'overdue' : 'due';
      if (b.allocations && b.allocations.length){
        // A bill that's already been split: one event per EACH unpaid tenant share,
        // instead of a single generic event (so each tenant sees what they owe).
        b.allocations.forEach(function(a){
          if (a.paid) return;
          var t = tenantOf(a.tenantId);
          if (!t) return;
          events.push({
            date: b.dueDate,
            kind: kind,
            title: t.fullName + ' owes ' + money(a.amount) + ' — ' + b.provider,
            href: tenantMode ? '#/bills' : ('#/bills/' + b.id)
          });
        });
      } else {
        events.push({
          date: b.dueDate,
          kind: kind,
          title: b.provider + ' — Bill due',
          href: tenantMode ? '#/bills' : ('#/bills/' + b.id)
        });
      }
    });
    tenants.forEach(function(t){
      if (t.rentAmount <= 0) return; // owner: doesn't generate tenancy events
      events.push({ date: t.moveInDate, kind: 'move', title: t.fullName + ' — Move-in', href: tenantMode ? '#/payments' : ('#/tenants/' + t.id) });
      var moveOut = t.actualMoveOutDate || t.expectedMoveOutDate;
      if (moveOut) events.push({ date: moveOut, kind: 'move', title: t.fullName + ' — Move-out', href: tenantMode ? '#/payments' : ('#/tenants/' + t.id) });
    });
    if (!tenantMode){
      // The landlord's own lease payments/inspections with the real estate agent — never a
      // tenant concern, and never something a tenant should see the numbers for.
      properties.forEach(function(p){
        var nextDue = nextLeaseDueDate(p, TODAY);
        if (nextDue){
          events.push({
            date: nextDue,
            kind: daysBetween(TODAY, nextDue) <= 2 ? 'overdue' : 'due',
            title: p.name + ' — Rent due to real estate' + (p.leasePaymentAmount!=null ? ' (' + money(p.leasePaymentAmount) + ')' : ''),
            href: '#/properties/' + p.id
          });
        }
        if (p.nextInspectionDate){
          events.push({ date: p.nextInspectionDate, kind: 'move', title: p.name + ' — Real estate inspection', href: '#/properties/' + p.id });
        }
      });
    }
    return events;
  }
  function pad2(n){ return n < 10 ? '0'+n : ''+n; }
  /** Grid for a calendar month ('YYYY-MM'): null = empty filler cell; Monday as the first day of the week. */
  function buildMonthGrid(yearMonth){
    var year = parseInt(yearMonth.slice(0,4), 10);
    var month = parseInt(yearMonth.slice(5,7), 10) - 1;
    var firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7; // Sun=0..Sat=6 -> Mon=0..Sun=6
    var daysInMonth = new Date(year, month+1, 0).getDate();
    var cells = [];
    for (var i=0;i<firstWeekday;i++) cells.push(null);
    for (var d=1; d<=daysInMonth; d++) cells.push(year+'-'+pad2(month+1)+'-'+pad2(d));
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }
  var CALENDAR_MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var calendarMonth = TODAY.slice(0,7);
  function calendarShiftMonth(delta){
    var year = parseInt(calendarMonth.slice(0,4), 10);
    var month = parseInt(calendarMonth.slice(5,7), 10) - 1;
    var d = new Date(year, month + delta, 1);
    calendarMonth = d.getFullYear() + '-' + pad2(d.getMonth()+1);
    renderPreservingScroll();
  }
  function calendarGoToday(){ calendarMonth = TODAY.slice(0,7); renderPreservingScroll(); }
  window.calendarShiftMonth = calendarShiftMonth;
  window.calendarGoToday = calendarGoToday;

  /* ============ Icons ============ */
  var ICONS = {
    dashboard:'<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    building:'<path d="M4 21V6l8-3 8 3v15"/><path d="M4 21h16"/><path d="M9 9h1M14 9h1M9 13h1M14 13h1M9 17h1M14 17h1"/>',
    tenants:'<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17.5" cy="9" r="2.4"/><path d="M14.8 12.5c2.4.1 4.4 2.3 4.7 5.5"/>',
    payments:'<rect x="2.5" y="6" width="19" height="13" rx="2"/><path d="M2.5 10.5h19"/><path d="M6 15h4"/>',
    receipt:'<path d="M6 3h12v18l-2.5-1.5L13 21l-2.5-1.5L8 21l-2-1.5V3z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
    calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    chart:'<path d="M4 20V10M11 20V4M18 20v-7"/><path d="M2 20h20"/>',
    document:'<path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/>',
    bell:'<path d="M6 8a6 6 0 1 1 12 0c0 4 1.5 5.5 2 6.5H4c.5-1 2-2.5 2-6.5z"/><path d="M10 18.5a2 2 0 0 0 4 0"/>',
    settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9c.2.6.8 1 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    more:'<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
    chevron:'<path d="M9 5l7 7-7 7"/>',
    sun:'<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/>',
    moon:'<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>',
    camera:'<path d="M4 8h3l1.6-2.4A1 1 0 0 1 9.4 5h5.2a1 1 0 0 1 .8.6L16.8 8H20a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.4"/>',
    gallery:'<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16.5l-5.2-5.2-4 4-2.8-2.8L3 17"/>',
    plus:'<path d="M12 5v14M5 12h14"/>',
    inbox:'<path d="M4 12h4l2 3h4l2-3h4"/><path d="M5.5 5h13l3 7v8a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1v-8z"/>',
    edit:'<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    logout:'<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>'
  };
  function svg(name, extra){
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'+(extra?' '+extra:'')+'>'+ICONS[name]+'</svg>';
  }

  /* ============ Navigation ============ */
  // Two separate menus — which one is active is only known after the signed-in user's role
  // loads (enterApp() calls buildNavDom() again once currentProfile is set). Staff (super_admin/
  // administrator) get today's full app plus Maintenance, and Users/Audit Log for super_admin
  // only; Tenant gets a small menu limited to their own data (see the "Tenant → only their
  // own data" rule).
  var STAFF_NAV = [
    { hash:'#/', label:'Dashboard', icon:'dashboard', primary:true },
    { hash:'#/payments', label:'Payments', icon:'payments', primary:true },
    { hash:'#/bills', label:'Bills', icon:'receipt', primary:true },
    { hash:'#/tenants', label:'Tenants', icon:'tenants', primary:true },
    { hash:'#/reports', label:'Reports', icon:'chart', primary:false },
    { hash:'#/profits', label:'Profits', icon:'chart', primary:false },
    { hash:'#/properties', label:'Properties', icon:'building', primary:false },
    { header:true, label:'Property Operations' },
    { hash:'#/property-operations', label:'Property Operations', icon:'building', primary:false },
    { hash:'#/calendar', label:'Calendar', icon:'calendar', primary:false },
    { hash:'#/notifications', label:'Notifications', icon:'bell', primary:false },
    { hash:'#/users', label:'Users', icon:'tenants', primary:false, superAdminOnly:true },
    { hash:'#/audit-log', label:'Audit log', icon:'chart', primary:false, superAdminOnly:true },
    { hash:'#/settings', label:'Settings', icon:'settings', primary:false }
  ];
  var TENANT_NAV = [
    { hash:'#/', label:'My Dashboard', icon:'dashboard', primary:true },
    { hash:'#/payments', label:'Payments', icon:'payments', primary:true },
    { hash:'#/bills', label:'Bills', icon:'receipt', primary:true },
    { hash:'#/documents', label:'Documents', icon:'document', primary:true },
    { hash:'#/maintenance', label:'Maintenance', icon:'document', primary:false },
    { hash:'#/cleaning', label:'Cleaning', icon:'document', primary:false },
    { hash:'#/inspection', label:'Inspection', icon:'document', primary:false },
    { hash:'#/notifications', label:'Notifications', icon:'bell', primary:false },
    { hash:'#/settings', label:'Settings', icon:'settings', primary:false }
  ];
  var NAV = STAFF_NAV;
  var MORE = { hash:'#/more', label:'More', icon:'more' };

  function buildNavDom(navList){
    NAV = navList.filter(function(i){ return !i.superAdminOnly || (currentProfile && currentProfile.role === 'super_admin'); });
    var sidebarNavEl = document.getElementById('sidebar-nav');
    sidebarNavEl.innerHTML = NAV.map(function(item){
      if (item.header) return '<div class="nav-section-header">'+esc(item.label)+'</div>';
      return '<a href="'+item.hash+'" data-hash="'+item.hash+'">'+svg(item.icon)+item.label+'</a>';
    }).join('');

    var bottomNavEl = document.getElementById('bottom-nav');
    bottomNavEl.innerHTML = NAV.filter(function(i){ return i.primary; }).map(function(item){
      return '<a href="'+item.hash+'" data-hash="'+item.hash+'">'+svg(item.icon)+item.label+'</a>';
    }).join('') + '<a href="'+MORE.hash+'" data-hash="'+MORE.hash+'" data-more="1">'+svg(MORE.icon)+MORE.label+'</a>';
  }
  buildNavDom(STAFF_NAV);

  var importPickerBtns = document.querySelectorAll('#import-modal-picker .import-option');
  var IMPORT_OPTIONS = [
    ['camera','Take a photo'],
    ['gallery','Choose from photos'],
    ['pdf','Upload PDF'],
    ['manual','Enter manually']
  ];
  importPickerBtns.forEach(function(btn, i){
    var opt = IMPORT_OPTIONS[i];
    btn.innerHTML = svg(opt[0]==='pdf' ? 'document' : opt[0]==='manual' ? 'edit' : opt[0]) + '<span>'+opt[1]+'</span>';
  });
  document.getElementById('import-preview-file').innerHTML = svg('document') + '<span>PDF file</span>';

  var reviewPropertySelect = document.getElementById('review-property');
  reviewPropertySelect.innerHTML = properties.map(function(p){
    return '<option value="'+p.id+'">'+esc(p.name)+'</option>';
  }).join('');

  var docTenantSelect = document.getElementById('doc-tenant');
  docTenantSelect.innerHTML = tenants.filter(function(t){ return t.rentAmount>0; }).map(function(t){
    return '<option value="'+t.id+'">'+esc(t.fullName)+'</option>';
  }).join('');
  document.getElementById('doc-preview-file').innerHTML = svg('document') + '<span>PDF file</span>';

  function setActiveNav(hash){
    var moreHashes = NAV.filter(function(i){ return !i.primary; }).map(function(i){ return i.hash; });
    document.querySelectorAll('#sidebar-nav a, #bottom-nav a').forEach(function(a){
      var h = a.getAttribute('data-hash');
      var isMoreBtn = a.hasAttribute('data-more');
      var isSection = h !== '#/' && hash.indexOf(h + '/') === 0;
      var active = h === hash || isSection || (isMoreBtn && (hash === MORE.hash || moreHashes.indexOf(hash) > -1));
      a.classList.toggle('active', active);
    });
  }

  /** Small red count badge on the "Notifications" nav item, kept in sync on every render() —
   *  reads notificationsList, which bootstrapData()/markDbNotifRead() etc. keep up to date. */
  function updateNotifNavBadge(){
    // For staff, notificationsList holds EVERY resident's notifications (RLS lets is_staff() see
    // all, so the admin Notification Center can filter/review them) — the badge must only count
    // the signed-in user's OWN unread notifications, not everyone's.
    var myAuthUserId = currentProfile ? currentProfile.authUserId : null;
    var count = notificationsList.filter(function(n){ return !n.isRead && n.authUserId === myAuthUserId; }).length;
    document.querySelectorAll('a[data-hash="#/notifications"]').forEach(function(a){
      var existing = a.querySelector('.nav-badge');
      if (count > 0){
        if (!existing){
          existing = document.createElement('span');
          existing.className = 'nav-badge';
          a.appendChild(existing);
        }
        existing.textContent = count > 99 ? '99+' : String(count);
      } else if (existing){
        existing.remove();
      }
    });
  }

  /* ============ Badges / filas reutilizables ============ */
  function badge(status, label){
    return '<span class="badge '+status+'"><span class="dot"></span>'+esc(label)+'</span>';
  }

  /* ============ Pages ============ */
  function pageHeader(title, sub){
    return '<div><h1 class="page-title">'+title+'</h1><p class="page-sub">'+sub+'</p></div>';
  }
  /** Friendly empty state: icon (from ICONS/svg), a short headline, a one-line explanation, and an optional action button/link. */
  function emptyState(iconName, title, sub, actionHtml){
    return '<div class="placeholder-box">'+
      '<div class="ph-icon">'+svg(iconName)+'</div>'+
      '<p>'+esc(title)+'</p>'+
      '<p class="sub">'+esc(sub)+'</p>'+
      (actionHtml || '') +
      '</div>';
  }
  /** State for a dynamic route id that no longer exists (deleted, or an outdated link). */
  function notFoundState(entityLabel, backHash, backLabel){
    return emptyState('inbox', entityLabel + ' not found',
      "It may have been deleted, or the link is out of date.",
      '<a class="mini-btn primary" href="'+backHash+'" style="display:inline-block;">'+esc(backLabel)+'</a>');
  }

  function renderDashboard(){
    var s = getDashboardSummary();
    var needs = getNeedsAttention();
    var upcoming = getUpcomingEvents();

    var stats = [
      ['Properties', String(s.totalProperties), false, 'goToDashboardStat(\'properties\')'],
      ['Occupied rooms', String(s.occupiedRooms), false, 'goToDashboardStat(\'properties\')'],
      ['Vacant rooms', String(s.vacantRooms), false, 'goToDashboardStat(\'vacant\')'],
      ['Overdue payments', String(s.overduePaymentsCount), s.overduePaymentsCount>0, 'goToDashboardStat(\'overdue\')'],
      ['Rent expected', money(s.totalRentExpected), false, 'goToDashboardStat(\'rent-all\')'],
      ['Rent received', money(s.totalRentReceived), false, 'goToDashboardStat(\'rent-paid\')'],
      ['Total outstanding', money(s.totalOutstanding), s.totalOutstanding>0, 'goToDashboardStat(\'rent-due\')'],
      ['Bills pending', String(s.billsPendingCount), false, 'goToDashboardStat(\'bills-pending\')']
    ];

    var statHtml = '<div class="stat-grid">' + stats.map(function(st){
      return '<div class="stat stat-clickable" role="button" tabindex="0" onclick="'+st[3]+'" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();'+st[3]+';}" style="cursor:pointer;">'+
        '<div class="label">'+st[0]+'</div><div class="value'+(st[2]?' warn':'')+'">'+st[1]+'</div></div>';
    }).join('') + '</div>';

    var needsHtml = '<div class="card"><h2>Needs attention</h2>' +
      (needs.length===0
        ? '<p style="font-size:13.5px;color:var(--text-dim);margin:0;">Nothing needs attention right now.</p>'
        : needs.map(function(item){
            if (item.type === 'lease'){
              var leaseBadge = item.daysUntil === 0 ? badge('due', 'Due today') : badge('due', 'Due in '+item.daysUntil+' day'+(item.daysUntil===1?'':'s'));
              return '<div class="row"><div class="who"><div class="name">'+esc(item.propertyName)+'</div>'+
                '<div class="meta">Rent payment to the real estate</div></div>'+
                '<div style="display:flex;align-items:center;gap:10px;">'+
                '<div class="amount">'+(item.amount!=null?money(item.amount):'—')+'<br/>'+leaseBadge+'</div>'+
                '<button class="text-link" style="margin:0;text-align:center;" onclick="location.hash=\'#/properties/'+item.propertyId+'\'">View</button>'+
                '</div></div>';
            }
            if (item.type === 'bill'){
              var billBadge = badge('overdue', item.daysOverdue+' days overdue');
              return '<div class="row"><div class="who"><div class="name">'+esc(item.tenantName)+'</div>'+
                '<div class="meta">'+esc(item.propertyName)+' • '+esc(item.provider)+' bill</div></div>'+
                '<div style="display:flex;align-items:center;gap:10px;">'+
                '<div class="amount">'+money(item.amountRemaining)+'<br/>'+billBadge+'</div>'+
                '<div style="display:flex;flex-direction:column;gap:6px;">'+
                '<button class="view-btn" onclick="openAllocPaidModal(\''+item.billId+'\',\''+item.tenantId+'\')">MARK AS PAID</button>'+
                '<button class="text-link" style="margin:0;text-align:center;" onclick="location.hash=\'#/bills/'+item.billId+'\'">View</button>'+
                '</div></div></div>';
            }
            var b = item.status==='overdue'
              ? badge('overdue', item.daysOverdue+' days overdue')
              : badge('due', 'Partially Paid');
            return '<div class="row"><div class="who"><div class="name">'+esc(item.tenantName)+'</div>'+
              '<div class="meta">'+esc(item.propertyName)+' • '+esc(item.roomName)+'</div></div>'+
              '<div style="display:flex;align-items:center;gap:10px;">'+
              '<div class="amount">'+money(item.amountRemaining)+'<br/>'+b+'</div>'+
              '<div style="display:flex;flex-direction:column;gap:6px;">'+
              '<button class="view-btn" onclick="openChargePaidModal(\''+item.chargeId+'\')">MARK AS PAID</button>'+
              '<button class="text-link" style="margin:0;text-align:center;" onclick="location.hash=\'#/payments\'">View</button>'+
              '</div></div></div>';
          }).join('')
      ) + '</div>';

    var upcomingHtml = '<div class="card"><h2>Upcoming</h2>' +
      (upcoming.length===0
        ? '<p style="font-size:13.5px;color:var(--text-dim);margin:0;">Nothing coming up in the next two weeks.</p>'
        : upcoming.map(function(e){
            return '<div class="upcoming-row"><span class="date">'+shortDate(e.date)+'</span><span class="title">'+esc(e.title)+'</span></div>';
          }).join('')
      ) + '</div>';

    return pageHeader('Dashboard', "Here's how things look across all your properties as of "+shortDate(TODAY)+'.') + statHtml + needsHtml + upcomingHtml;
  }

  /** Makes the Dashboard's summary tiles clickable: each one jumps to the page (and filter) that
   *  explains the number shown, instead of doing nothing. */
  function goToDashboardStat(kind){
    if (kind === 'properties'){
      location.hash = '#/properties';
      return;
    }
    if (kind === 'vacant'){
      // Straight to the property with the longest-standing vacancy, instead of the general
      // properties list — with 2+ vacant rooms, the oldest one wins.
      var oldest = vacantRoomsOldestFirst()[0];
      location.hash = oldest ? '#/properties/'+oldest.room.propertyId : '#/properties';
      return;
    }
    if (kind === 'bills-pending'){
      billsFilter = 'pending';
      billsViewTab = 'list';
      billsPropertyFilter = 'all';
      location.hash = '#/bills';
      render();
      return;
    }
    // Everything else is a Payments filter: 'overdue', 'rent-all' -> 'all', 'rent-paid' -> 'paid', 'rent-due' -> 'due'.
    var map = { overdue:'overdue', 'rent-all':'all', 'rent-paid':'paid', 'rent-due':'due' };
    paymentsFilter = map[kind] || 'all';
    paymentsPropertyFilter = 'all';
    paymentsTenantFilter = 'all';
    location.hash = '#/payments';
    render();
  }
  window.goToDashboardStat = goToDashboardStat;

  function roomsOf(propertyId){ return rooms.filter(function(r){ return r.propertyId===propertyId; }); }
  function currentTenantOf(roomId){ return tenants.find(function(t){ return t.roomId===roomId; }); }
  /** A room counts as occupied while ANY tenant assigned to it hasn't moved out — checks every
   *  tenant row for the room, not just the first one ever recorded (a room that turned over has
   *  the old, moved-out tenant listed first). */
  function roomIsOccupied(roomId){
    return tenants.some(function(t){ return t.roomId===roomId && !tenantHasMovedOut(t); });
  }
  /** Looks for ANOTHER tenant (different from excludeTenantId) already assigned to this room
   *  with a stay whose dates overlap [moveInDate, moveOutDate]. A null moveOutDate
   *  means "still living there, no move-out date" (open-ended stay). A tenant who
   *  had already moved out completely before the new one arrived (or who arrives after the new one
   *  left) does NOT count as a conflict — two people can pass through the same room at
   *  different times. */
  function overlappingRoomTenant(roomId, moveInDate, moveOutDate, excludeTenantId){
    return tenants.find(function(t){
      if (t.roomId !== roomId || t.id === excludeTenantId) return false;
      var tEnd = t.actualMoveOutDate || t.expectedMoveOutDate || null;
      var newStartsBeforeExistingEnds = !tEnd || moveInDate <= tEnd;
      var existingStartsBeforeNewEnds = !moveOutDate || t.moveInDate <= moveOutDate;
      return newStartsBeforeExistingEnds && existingStartsBeforeNewEnds;
    });
  }
  function propertyOf(id){ return properties.find(function(p){ return p.id===id; }); }
  function roomOf(id){ return rooms.find(function(r){ return r.id===id; }); }
  function tenantOf(id){ return tenants.find(function(t){ return t.id===id; }); }
  function myTenantRecord(){ return tenants.find(function(t){ return t.authUserId === (currentProfile && currentProfile.authUserId); }); }
  function bondOf(tenantId){ return bonds.find(function(b){ return b.tenantId===tenantId; }); }
  function billOf(id){ return bills.find(function(b){ return b.id===id; }); }
  function billsOf(propertyId){ return bills.filter(function(b){ return b.propertyId===propertyId; }); }
  function backLink(hash, label){
    return '<a class="back-link" href="'+hash+'">'+svg('chevron','style="transform:rotate(180deg)"')+label+'</a>';
  }

  var TASK_CATEGORY_ICON = { cleaning: '🧹', maintenance: '🔧', bin_out: '🗑️' };

  var ACTIVITY_CATEGORY_ICON = { cleaning: '🧹', maintenance: '🔧', bin_out: '🗑️', inspection: '🔍', documents: '📄' };

  /** Reusable activity feed, filtered by whichever id(s) are passed — used on the
   *  Property page, the Tenant profile ("Property Activity"), and the Room activity
   *  modal. Reads activityLogRows only; RLS already scopes what a tenant session can
   *  see, and both Property/Tenant detail pages that call this are staff-only routes. */
  function activityTimelineHtml(filter){
    var rows = activityLogRows.filter(function(a){
      if (filter.propertyId && a.propertyId !== filter.propertyId) return false;
      if (filter.roomId && a.roomId !== filter.roomId) return false;
      if (filter.tenantId && a.tenantId !== filter.tenantId) return false;
      return true;
    }).slice().sort(function(x,y){ return (y.createdAt||'').localeCompare(x.createdAt||''); });
    if (rows.length === 0) return '<p style="font-size:13px;color:var(--text-faint);margin:0;">No activity yet.</p>';
    return '<div class="activity-timeline">' + rows.map(function(a){
      var icon = ACTIVITY_CATEGORY_ICON[a.category] || '•';
      return '<div class="activity-row"><span class="activity-date">'+shortDate(a.createdAt.slice(0,10))+'</span>'+
        '<span class="activity-desc">'+icon+' '+esc(a.description)+'</span></div>';
    }).join('') + '</div>';
  }

  function propertyActivityTimelineCardHtml(propertyId){
    return '<div class="card"><h2>Activity</h2>'+activityTimelineHtml({ propertyId: propertyId })+'</div>';
  }

  function tenantActivityTimelineCardHtml(tenantId){
    return '<div class="card"><h2>Property Activity</h2>'+activityTimelineHtml({ tenantId: tenantId })+'</div>';
  }

  function openRoomActivityModal(roomId){
    var r = rooms.find(function(x){ return x.id===roomId; });
    document.getElementById('room-activity-title').textContent = (r ? r.name : 'Room') + ' — Activity';
    document.getElementById('room-activity-body').innerHTML = activityTimelineHtml({ roomId: roomId });
    document.getElementById('room-activity-modal').hidden = false;
  }
  function closeRoomActivityModal(){ document.getElementById('room-activity-modal').hidden = true; }
  window.openRoomActivityModal = openRoomActivityModal;
  window.closeRoomActivityModal = closeRoomActivityModal;

  /** The four operational sections (Maintenance, Cleaning, Inspection, Documents) used to be
   *  separate top-level nav items; they're now tabs inside this single "Property Operations" hub
   *  so the sidebar has one entry instead of five. `propertyOperationsTab` is plain UI state (not
   *  tied to location.hash) — switching tabs just re-renders in place, the same pattern used for
   *  cleaningStaffPropertyFilter/cleaningCalendarMonth elsewhere in this file. The four old flat
   *  hashes (#/maintenance etc., still used by notification deep-links) stay mapped in ROUTES and
   *  simply preset this tab before rendering the hub, so existing links keep working. */
  var propertyOperationsTab = 'overview';
  var PROPERTY_OPERATIONS_TABS = [
    { key:'overview', label:'Overview' },
    { key:'maintenance', label:'Maintenance' },
    { key:'cleaning', label:'Cleaning & Bin' },
    { key:'inspection', label:'Inspection' },
    { key:'documents', label:'Documents' }
  ];
  function setPropertyOperationsTab(tab){
    propertyOperationsTab = tab;
    renderPreservingScroll();
  }
  window.setPropertyOperationsTab = setPropertyOperationsTab; // inline onclick= runs in global scope — must be exposed here
  function propertyOperationsTabBarHtml(){
    return '<div class="po-tabbar">' + PROPERTY_OPERATIONS_TABS.map(function(t){
      return '<button type="button" class="po-tab'+(t.key===propertyOperationsTab?' active':'')+'" onclick="setPropertyOperationsTab(\''+t.key+'\')">'+esc(t.label)+'</button>';
    }).join('') + '</div>';
  }
  function renderPropertyOperations(){
    var body;
    switch(propertyOperationsTab){
      case 'maintenance': body = renderMaintenance(); break;
      case 'cleaning': body = renderCleaning(); break;
      case 'inspection': body = renderInspection(); break;
      case 'documents': body = renderDocuments(); break;
      default: body = renderPropertyOperationsOverview();
    }
    return propertyOperationsTabBarHtml() + body;
  }
  function renderPropertyOperationsOverview(){
    var header = pageHeader('Property Operations', "Today's tasks and what needs attention, across Cleaning, Maintenance and Bin OUT.");
    if (properties.length === 0){
      return header + emptyState('building', 'No properties yet', 'Add a property to start tracking operations.', '');
    }
    function taskLink(r){
      var opener = r.category === 'maintenance' ? 'openMaintenanceModal'
        : r.category === 'bin_out' ? 'openBinOutDetailModal'
        : 'openCleaningDetailModal';
      return '<div class="task-row"><a href="#" onclick="event.preventDefault();event.stopPropagation();'+opener+'(\''+r.sourceId+'\')">'+(TASK_CATEGORY_ICON[r.category]||'')+' '+esc(r.title)+'</a></div>';
    }
    var sections = properties.slice().sort(function(a,b){ return a.name.localeCompare(b.name); }).map(function(p){
      var rowsForProperty = taskIndexRows.filter(function(r){ return r.propertyId === p.id; });
      var todayRows = rowsForProperty.filter(function(r){
        return r.dueDate === TODAY && r.statusFamily !== 'completed' && r.statusFamily !== 'not_completed';
      });
      // Single OR pass over the property's rows — a row that is both overdue AND urgent
      // maintenance must still appear once, not twice (Review Focus #5).
      var attentionRows = rowsForProperty.filter(function(r){
        var isOverdue = taskIndexEffectiveStatus(r) === 'overdue';
        var isUrgentMaintenance = r.category === 'maintenance' && r.priority === 'urgent'
          && r.statusFamily !== 'completed' && r.statusFamily !== 'not_completed';
        return isOverdue || isUrgentMaintenance;
      });
      var inspectionDueLine = (p.nextInspectionDate && p.nextInspectionDate <= TODAY)
        ? '<div class="task-row">🟡 <a href="#/properties/'+p.id+'">Inspection due</a></div>' : '';
      var attentionHtml = attentionRows.map(taskLink).join('') + inspectionDueLine;
      return '<div class="card"><h2>'+esc(p.name)+'</h2>'+
        '<h3 style="margin:12px 0 6px;font-size:13px;color:var(--text-dim);">Today\'s tasks</h3>'+
        (todayRows.length===0 ? '<p style="font-size:13px;color:var(--text-faint);margin:0;">Nothing due today.</p>' : todayRows.map(taskLink).join(''))+
        '<h3 style="margin:16px 0 6px;font-size:13px;color:var(--text-dim);">Attention required</h3>'+
        (attentionHtml === '' ? '<p style="font-size:13px;color:var(--text-faint);margin:0;">Nothing needs attention.</p>' : attentionHtml)+
        '</div>';
    }).join('');
    return header + sections;
  }

  function renderProperties(){
    if (properties.length === 0){
      return '<div class="detail-head" style="align-items:center;">'+
        pageHeader('Properties', 'Manage your properties, rooms and occupancy.')+'</div>'+
        emptyState('building', 'No properties yet',
          'Add your first property to start tracking rooms, tenants and rent.',
          '<button class="mini-btn primary" onclick="openPropertyModal()">+ Add property</button>');
    }
    var cards = properties.map(function(p){
      var propRooms = roomsOf(p.id);
      var occupied = propRooms.filter(function(r){ var t=currentTenantOf(r.id); return t && t.rentAmount>0; }).length;
      var roomsHtml = propRooms.map(function(r){
        var t = currentTenantOf(r.id);
        var isPaying = t && t.rentAmount>0;
        var tenantLabel = isPaying
          ? esc(t.fullName)+' · $'+t.rentAmount+'/'+(t.rentFrequency==='weekly'?'week':t.rentFrequency)
          : (t ? esc(t.fullName) : 'Vacant');
        var inner = '<span class="rname">'+esc(r.name)+'</span><span class="rtenant">'+tenantLabel+'</span>';
        return isPaying
          ? '<a class="room-row linked" href="#/tenants/'+t.id+'">'+inner+'</a>'
          : '<div class="room-row">'+inner+'</div>';
      }).join('');
      return '<div class="card prop-card">'+
        '<a href="#/properties/'+p.id+'" style="display:block;text-decoration:none;color:inherit;"><div class="prop-head">'+
        '<div><div class="prop-name">'+esc(p.name)+'</div><div class="prop-addr">'+esc(p.address)+'</div>'+
        '<div class="prop-meta">'+p.bedrooms+' bedrooms • '+p.bathrooms+' bathrooms</div></div>'+
        '<div class="occ"><div style="color:var(--status-paid)">'+occupied+' occupied</div>'+
        '<div class="vacant">'+(propRooms.length-occupied)+' vacant</div></div></div></a>'+
        roomsHtml+'</div>';
    }).join('');
    return '<div class="detail-head" style="align-items:center;">'+
      pageHeader('Properties', 'Manage your properties, rooms and occupancy.')+
      '<button class="mini-btn primary" style="white-space:nowrap;" onclick="openPropertyModal()">+ Add property</button></div>'+
      cards;
  }

  /** Next date (day-of-month) on which the admin must pay the real estate, starting from
   *  `fromIso`. If the configured day (e.g. 31) doesn't exist in the current month, the last day
   *  of that month is used instead (e.g. Feb 28/29) instead of overflowing into the next month. */
  function nextMonthlyDueDate(day, fromIso){
    var from = new Date(fromIso+'T00:00:00');
    var year = from.getFullYear(), month = from.getMonth();
    function clamped(y, m, d){
      var lastDay = new Date(y, m+1, 0).getDate();
      return new Date(y, m, Math.min(d, lastDay));
    }
    var candidate = clamped(year, month, day);
    if (toIsoLocal(candidate) < fromIso){
      candidate = clamped(year, month+1, day);
    }
    return toIsoLocal(candidate);
  }

  /** Next date on which the admin must pay the real estate, based on the configured frequency.
   *  `lastLeasePaymentDate` stores the START of the period already paid (not the day "paid" was
   *  clicked) — so if the paid period was 06/07–05/08, the next due date correctly comes out
   *  as 06/08, no matter what day the payment was recorded. Monthly: if "Mark as paid" has
   *  been used at least once, it's computed from that period start + 1 month; otherwise it falls
   *  back to the previous behavior (fixed day of the month). Fortnightly: always period start + 14
   *  days — that's why it requires a first payment to have been marked to start tracking. */
  function nextLeaseDueDate(p, asOfIso){
    asOfIso = asOfIso || TODAY;
    if (p.leasePaymentFrequency === 'fortnightly'){
      return p.lastLeasePaymentDate ? stepDateIso(p.lastLeasePaymentDate, 14) : null;
    }
    if (p.lastLeasePaymentDate) return addMonthsIso(p.lastLeasePaymentDate, 1);
    return p.leasePaymentDay ? nextMonthlyDueDate(p.leasePaymentDay, asOfIso) : null;
  }
  /** End of the period covered by the payment whose start is `startIso`, based on the frequency. */
  function leasePeriodEnd(p, startIso){
    if (!startIso) return null;
    return p.leasePaymentFrequency === 'fortnightly' ? stepDateIso(startIso, 13) : stepDateIso(addMonthsIso(startIso, 1), -1);
  }

  var leasePaymentModalPropertyId = null;
  /** Opens a dialog to confirm the payment to the real estate, with the dates of the period it
   *  covers PRE-FILLED with whatever the system already computes as the next due date — but fully
   *  editable, because that default date might not match the invoice's actual period
   *  (e.g. if the payment arrived late or the actual cycle doesn't line up exactly). */
  function openLeasePaymentModal(propertyId){
    var p = propertyOf(propertyId);
    if (!p) return;
    leasePaymentModalPropertyId = propertyId;
    var defaultStart = nextLeaseDueDate(p, TODAY) || TODAY;
    document.getElementById('lease-payment-modal-sub').textContent =
      p.name + (p.leasePaymentAmount!=null ? ' • ' + money(p.leasePaymentAmount) : '') + ' • ' + (p.leasePaymentFrequency==='fortnightly'?'Fortnightly':'Monthly');
    document.getElementById('lease-payment-start').value = defaultStart;
    updateLeasePaymentEndPreview();
    document.getElementById('lease-payment-modal-error').hidden = true;
    document.getElementById('lease-payment-modal').hidden = false;
  }
  window.openLeasePaymentModal = openLeasePaymentModal;
  function updateLeasePaymentEndPreview(){
    var p = propertyOf(leasePaymentModalPropertyId);
    var start = document.getElementById('lease-payment-start').value;
    var end = p && start ? leasePeriodEnd(p, start) : null;
    document.getElementById('lease-payment-end-preview').textContent = end ? shortDate(end) : '—';
  }
  window.updateLeasePaymentEndPreview = updateLeasePaymentEndPreview;
  function closeLeasePaymentModal(){
    document.getElementById('lease-payment-modal').hidden = true;
    leasePaymentModalPropertyId = null;
  }
  window.closeLeasePaymentModal = closeLeasePaymentModal;
  async function confirmLeasePaymentModal(){
    var p = propertyOf(leasePaymentModalPropertyId);
    var start = document.getElementById('lease-payment-start').value;
    var errorEl = document.getElementById('lease-payment-modal-error');
    if (!p || !start){
      errorEl.textContent = 'Pick the date this payment\'s period starts.';
      errorEl.hidden = false;
      return;
    }
    try {
      var saved = await propertyService.update(p.id, Object.assign({}, p, { lastLeasePaymentDate: start }));
      Object.assign(p, saved);
      closeLeasePaymentModal();
      showToast('Lease payment marked as paid.', 'success');
      render();
    } catch(err){
      errorEl.textContent = 'Could not save this. ' + friendlyErrorMessage(err);
      errorEl.hidden = false;
    }
  }
  window.confirmLeasePaymentModal = confirmLeasePaymentModal;

  /** Detail card for the admin's own lease with the real estate (payment day/frequency,
   *  amount, next inspection, contract end date and payment method) — only shown if
   *  something has been configured. */
  function leasePaymentCardHtml(p){
    var hasAny = p.leasePaymentDay || p.leasePaymentAmount != null || p.leaseEndDate || p.leasePaymentMethod || p.nextInspectionDate || p.lastLeasePaymentDate;
    if (!hasAny) return '';
    var rows = '';
    var nextDue = nextLeaseDueDate(p, TODAY);
    var freqLabel = p.leasePaymentFrequency === 'fortnightly' ? 'Fortnightly' : 'Monthly';
    rows += '<div class="field-row"><span class="k">Payment frequency</span><span class="v">'+freqLabel+'</span></div>';
    if (p.leasePaymentFrequency !== 'fortnightly' && p.leasePaymentDay && !p.lastLeasePaymentDate){
      rows += '<div class="field-row"><span class="k">Rent payment day</span><span class="v">Day '+p.leasePaymentDay+' of each month</span></div>';
    }
    if (p.lastLeasePaymentDate){
      rows += '<div class="field-row"><span class="k">Last period paid</span><span class="v">'+shortDate(p.lastLeasePaymentDate)+' – '+shortDate(leasePeriodEnd(p, p.lastLeasePaymentDate))+'</span></div>';
    }
    if (nextDue){
      var isOverdue = nextDue < TODAY;
      rows += '<div class="field-row"><span class="k">Next payment due</span><span class="v">'+
        (isOverdue ? badge('overdue','Overdue since '+shortDate(nextDue)) : shortDate(nextDue))+'</span></div>';
    } else if (p.leasePaymentFrequency === 'fortnightly'){
      rows += '<div class="field-row"><span class="k">Next payment due</span><span class="v" style="font-weight:400;color:var(--text-faint);">Mark a payment below to start tracking</span></div>';
    }
    if (p.leasePaymentAmount != null) rows += '<div class="field-row"><span class="k">Amount to pay</span><span class="v">'+money(p.leasePaymentAmount)+'</span></div>';
    if (p.nextInspectionDate){
      var daysToInspection = daysBetween(TODAY, p.nextInspectionDate);
      rows += '<div class="field-row"><span class="k">Next inspection</span><span class="v">'+fullDate(p.nextInspectionDate)+
        (daysToInspection >= 0 && daysToInspection <= 7 ? ' ' + badge('due','Coming up') : (daysToInspection < 0 ? ' ' + badge('overdue','Past date') : ''))+'</span></div>';
    }
    if (p.leaseEndDate) rows += '<div class="field-row"><span class="k">Lease contract ends</span><span class="v">'+fullDate(p.leaseEndDate)+'</span></div>';
    if (p.leasePaymentMethod === 'bpay'){
      rows += '<div class="field-row"><span class="k">Payment method</span><span class="v">BPay</span></div>'+
        '<div class="field-row"><span class="k">Biller code</span><span class="v">'+esc(p.bpayBillerCode)+'</span></div>'+
        '<div class="field-row"><span class="k">Reference</span><span class="v">'+esc(p.bpayReference)+'</span></div>';
    } else if (p.leasePaymentMethod === 'bank_transfer'){
      rows += '<div class="field-row"><span class="k">Payment method</span><span class="v">Bank transfer</span></div>'+
        '<div class="field-row"><span class="k">Account name</span><span class="v">'+esc(p.bankAccountName)+'</span></div>'+
        '<div class="field-row"><span class="k">BSB</span><span class="v">'+esc(p.bankBsb)+'</span></div>'+
        '<div class="field-row"><span class="k">Account number</span><span class="v">'+esc(p.bankAccountNumber)+'</span></div>';
    }
    return '<div class="card"><h2>Landlord\'s lease (payment to the real estate)</h2><div class="field-list">'+rows+'</div>'+
      '<div class="actions-row" style="margin-top:10px;"><button class="mini-btn" onclick="openLeasePaymentModal(\''+p.id+'\')">Mark lease payment as paid</button></div></div>';
  }

  /** Short "Parking" line for the property detail page: "No" when the property has none, plus the
   *  cost and charged-to tenant when set (tracking info only — this doesn't generate a bill/charge). */
  function parkingSummary(p){
    if (!p.hasParking) return 'No';
    var parts = ['Yes'];
    if (p.parkingCost != null) parts.push(money(p.parkingCost));
    if (p.parkingTenantId){
      var t = tenantOf(p.parkingTenantId);
      parts.push('charged to ' + (t ? esc(t.fullName) : 'a former tenant'));
    }
    return parts.join(' · ');
  }

  function renderPropertyDetail(id){
    var p = propertyOf(id);
    if (!p){ return pageHeader('Property not found', '') + notFoundState('Property', '#/properties', 'Back to properties'); }
    var propRooms = roomsOf(p.id);
    var occupied = propRooms.filter(function(r){ var t=currentTenantOf(r.id); return t && t.rentAmount>0; }).length;
    var propBills = billsOf(p.id);

    var roomsHtml = propRooms.length===0
      ? '<p style="font-size:13.5px;color:var(--text-dim);margin:0;">No rooms yet — add the first one to get started.</p>'
      : propRooms.map(function(r){ return roomLine(r, p.id); }).join('');

    return backLink('#/properties', 'Properties') +
      '<div class="detail-head"><div><h1 class="page-title">'+esc(p.name)+'</h1>'+
      '<p class="page-sub">'+esc(p.address)+'</p></div>'+
      '<div class="occ"><div style="color:var(--status-paid)">'+occupied+' occupied</div>'+
      '<div class="vacant">'+(propRooms.length-occupied)+' vacant</div></div></div>'+
      '<div class="actions-row">'+
      (p.whatsappGroupLink ? '<a class="mini-btn" href="'+esc(whatsAppBusinessLink(p.whatsappGroupLink))+'" target="_blank" rel="noopener">Open WhatsApp group</a>' : '')+
      '<button class="mini-btn" onclick="openPropertyModal(\''+p.id+'\')">Edit property</button>'+
      (isSuperAdmin() ? '<button class="mini-btn danger" onclick="deletePropertyConfirm(\''+p.id+'\')">Delete property</button>' : '')+
      '</div>'+
      '<div class="card"><div class="field-list">'+
      '<div class="field-row"><span class="k">Bedrooms</span><span class="v">'+p.bedrooms+'</span></div>'+
      '<div class="field-row"><span class="k">Bathrooms</span><span class="v">'+p.bathrooms+'</span></div>'+
      '<div class="field-row"><span class="k">Parking</span><span class="v" style="font-weight:400;">'+parkingSummary(p)+'</span></div>'+
      (p.notes ? '<div class="field-row"><span class="k">Notes</span><span class="v" style="font-weight:400;">'+esc(p.notes)+'</span></div>' : '')+
      '</div></div>'+
      leasePaymentCardHtml(p)+
      '<div class="card"><div class="detail-head" style="margin-top:0;align-items:center;"><h2 style="margin:0;">Trash collection</h2>'+
      '<button class="mini-btn primary" onclick="openTrashModal(\''+p.id+'\')">+ Add</button></div>'+
      trashScheduleListHtml(p.id, true)+'</div>'+
      '<div class="card"><div class="detail-head" style="margin-top:0;align-items:center;"><h2 style="margin:0;">Rooms</h2>'+
      '<button class="mini-btn primary" onclick="openRoomModal(\''+p.id+'\')">+ Add room</button></div>'+roomsHtml+'</div>'+
      '<div class="card"><h2>Bills</h2>'+
      (propBills.length===0
        ? '<p style="font-size:13.5px;color:var(--text-dim);margin:0;">No bills recorded for this property yet.</p>'
        : propBills.map(billCard).join(''))+
      '</div>';
  }

  var tenantsShowInactive = false; // toggle: only active tenants are shown by default
  function setTenantsShowInactive(v){ tenantsShowInactive = v; renderPreservingScroll(); }
  window.setTenantsShowInactive = setTenantsShowInactive;

  var tenantsPropertyFilter = 'all';
  function setTenantsPropertyFilter(propertyId){ tenantsPropertyFilter = propertyId; renderPreservingScroll(); }
  window.setTenantsPropertyFilter = setTenantsPropertyFilter;

  function renderTenants(){
    var all = tenants.filter(function(t){ return t.rentAmount>0; });
    var inactiveCount = all.filter(function(t){ return t.isActive===false; }).length;
    var paying = all.filter(function(t){ return tenantsShowInactive ? t.isActive===false : t.isActive!==false; });
    var header = '<div class="detail-head" style="align-items:center;">'+
      pageHeader('Tenants', 'Everyone renting from you, and their lease details.')+
      '<button class="mini-btn primary" style="white-space:nowrap;" onclick="openTenantModal()">+ Add tenant</button></div>'+
      (inactiveCount>0 ? '<button class="mini-btn" style="margin-bottom:12px;" onclick="setTenantsShowInactive('+(!tenantsShowInactive)+')">'+
        (tenantsShowInactive ? 'Back to active tenants' : 'Show inactive tenants ('+inactiveCount+')')+'</button>' : '');
    // Property chips — same pattern as in Bills: filters the list and also groups/organizes
    // the cards by property (sorted alphabetically) instead of by creation order.
    var propertyTabsHtml = properties.length===0 ? '' : '<div class="filter-chips" style="margin-bottom:10px;">'+
      '<button class="chip'+(tenantsPropertyFilter==='all'?' active':'')+'" onclick="setTenantsPropertyFilter(\'all\')">All properties</button>'+
      properties.slice().sort(function(a,b){ return a.name.localeCompare(b.name); }).map(function(p){
        return '<button class="chip'+(tenantsPropertyFilter===p.id?' active':'')+'" onclick="setTenantsPropertyFilter(\''+p.id+'\')">'+esc(p.name)+'</button>';
      }).join('') + '</div>';
    if (tenantsPropertyFilter !== 'all'){
      paying = paying.filter(function(t){ return t.propertyId === tenantsPropertyFilter; });
    }
    // The stays timeline is computed over ALL tenants in scope (active and
    // inactive), regardless of the "Show inactive tenants" toggle — it's a history of dates,
    // not the operational list below.
    var timelineScope = tenantsPropertyFilter==='all' ? all : all.filter(function(t){ return t.propertyId===tenantsPropertyFilter; });
    var timelineHtml = tenantsTimelineHtml(timelineScope);
    if (paying.length === 0){
      if (tenantsShowInactive){
        return header + propertyTabsHtml + timelineHtml + emptyState('tenants', 'No inactive tenants', 'Everyone here is active.', '');
      }
      return header + propertyTabsHtml + timelineHtml + emptyState('tenants', 'No tenants yet',
        properties.length === 0
          ? 'Add a property and a room first, then add your first tenant.'
          : 'Add a tenant to start tracking rent, bonds and move-in dates.',
        properties.length === 0
          ? '<a class="mini-btn primary" href="#/properties" style="display:inline-block;">Go to properties</a>'
          : '<button class="mini-btn primary" onclick="openTenantModal()">+ Add tenant</button>');
    }
    // Grouped and sorted by property (alphabetically) and, within each, by tenant
    // name — so they stay organized by property even when the filter is on "All properties".
    var sorted = paying.slice().sort(function(a,b){
      var pa = propertyOf(a.propertyId), pb = propertyOf(b.propertyId);
      var cmp = (pa?pa.name:'').localeCompare(pb?pb.name:'');
      if (cmp === 0) cmp = a.fullName.localeCompare(b.fullName);
      return cmp;
    });
    var lastPropertyId = null;
    var rows = sorted.map(function(t){
      var p = propertyOf(t.propertyId);
      var bond = bondOf(t.id);
      var bondLine = bond
        ? ('Bond: '+money(bond.amountPaid)+' / '+money(bond.amountRequired)+' • '+esc(BOND_STATUS_LABEL[bond.status]||bond.status))
        : 'Bond: not recorded';
      var groupHeading = '';
      if (tenantsPropertyFilter === 'all' && t.propertyId !== lastPropertyId){
        lastPropertyId = t.propertyId;
        groupHeading = '<div style="font-size:12px;font-weight:650;color:var(--text-faint);margin:14px 0 4px;">'+esc(p?p.name:'—')+'</div>';
      }
      return groupHeading + '<a class="card" style="display:block;text-decoration:none;color:inherit;" href="#/tenants/'+t.id+'">'+
        '<div class="row" style="border:none;padding:0;">'+
        '<div class="who"><div class="name">'+esc(t.fullName)+'</div>'+
        '<div class="meta"><strong style="color:var(--text);">'+esc(p?p.name:'—')+'</strong> • Since '+shortDate(t.moveInDate)+'</div>'+
        '<div class="meta">'+bondLine+'</div></div>'+
        '<div class="amount">$'+t.rentAmount+'<br/><span style="font-weight:400;color:var(--text-faint);text-transform:capitalize;font-size:11.5px;">'+t.rentFrequency+'</span></div>'+
        '</div></a>';
    }).join('');
    return header + propertyTabsHtml + timelineHtml + rows;
  }

  /** Timeline of stays (similar to billsTimelineHtml, but for tenants): one ROW per
   *  room (not per tenant, since different tenants may have passed through the same
   *  room at different times), with one bar per stay within that row, from
   *  their move-in date to their move-out date (actual, expected, or today if they still
   *  live there). Grouped by property. Dynamic range: from the earliest move-in in scope to
   *  the most recent move-out (or one month after today, whichever is later). */
  function tenantsTimelineHtml(list){
    if (!list.length) return '';
    var endOf = function(t){ return t.actualMoveOutDate || t.expectedMoveOutDate || TODAY; };
    var rangeStart = list.reduce(function(min, t){ return t.moveInDate < min ? t.moveInDate : min; }, list[0].moveInDate);
    var rangeEnd = list.reduce(function(max, t){ var e = endOf(t); return e > max ? e : max; }, addMonthsIso(TODAY, 1));
    var totalDays = daysBetween(rangeStart, rangeEnd) + 1;
    if (totalDays <= 0) return '';
    function pct(iso){ return Math.max(0, Math.min(100, 100 * daysBetween(rangeStart, iso) / totalDays)); }
    function monthLabel(ym){
      var names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return names[parseInt(ym.slice(5,7),10)-1] + ' \'' + ym.slice(2,4);
    }
    var months = [];
    var cursor = rangeStart.slice(0,7) + '-01';
    while (cursor <= rangeEnd){ months.push(cursor); cursor = addMonthsIso(cursor, 1); }
    var tickStep = Math.max(1, Math.ceil(months.length / 6));

    function tenantStatus(t){
      if (t.isActive === false || (t.actualMoveOutDate && t.actualMoveOutDate <= TODAY)) return { color:'var(--status-move)', label:'Moved out' };
      if (t.moveInDate > TODAY) return { color:'var(--status-upcoming)', label:'Upcoming move-in' };
      return { color:'var(--status-paid)', label:'Current tenant' };
    }
    function barHtml(t){
      var end = endOf(t);
      var left = pct(t.moveInDate);
      var width = Math.max(1.2, pct(stepDateIso(end, 1)) - left);
      var st = tenantStatus(t);
      var tip = esc(t.fullName) + ': ' + shortDate(t.moveInDate) + ' – ' + (t.actualMoveOutDate||t.expectedMoveOutDate ? shortDate(end) : 'now') + ' • ' + st.label;
      return '<div title="'+tip+'" onclick="event.stopPropagation();location.hash=\'#/tenants/'+t.id+'\';" '+
        'style="position:absolute;top:1px;bottom:1px;left:calc('+left+'% + 1.5px);width:calc('+width+'% - 3px);min-width:2px;border-radius:3px;cursor:pointer;background:'+st.color+';"></div>';
    }
    var todayLeft = pct(TODAY);
    var todayLineHtml = '<div style="position:absolute;top:0;bottom:0;left:calc('+todayLeft+'% - 1px);width:2px;background:var(--text);opacity:0.55;pointer-events:none;"></div>';
    // One row per room — all stays that passed through that room are drawn
    // as bars within the SAME row (not a new row per tenant).
    function roomRowHtml(roomLabel, tenantsInRoom){
      return '<div style="display:flex;align-items:center;gap:8px;margin:5px 0;">'+
        '<span style="font-size:11.5px;color:var(--text-dim);width:84px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">'+esc(roomLabel)+'</span>'+
        '<div class="timeline-track" style="position:relative;flex:1;height:18px;border-radius:4px;overflow:hidden;">'+tenantsInRoom.map(barHtml).join('')+todayLineHtml+'</div></div>';
    }

    var byProperty = {};
    list.forEach(function(t){ (byProperty[t.propertyId] = byProperty[t.propertyId] || []).push(t); });
    var propRows = Object.keys(byProperty).map(function(propId){
      var p = propertyOf(propId);
      var byRoom = {};
      byProperty[propId].forEach(function(t){ (byRoom[t.roomId || '—'] = byRoom[t.roomId || '—'] || []).push(t); });
      var roomIds = Object.keys(byRoom).sort(function(a,b){
        var ra = rooms.find(function(r){ return r.id===a; }), rb = rooms.find(function(r){ return r.id===b; });
        return (ra?ra.name:'').localeCompare(rb?rb.name:'');
      });
      var roomRows = roomIds.map(function(roomId){
        var room = rooms.find(function(r){ return r.id===roomId; });
        var tenantsInRoom = byRoom[roomId].slice().sort(function(a,b){ return a.moveInDate.localeCompare(b.moveInDate); });
        return roomRowHtml(room ? room.name : 'No room', tenantsInRoom);
      }).join('');
      return '<div style="margin-bottom:12px;"><div style="font-size:12.5px;font-weight:650;margin-bottom:4px;">'+esc(p?p.name:'—')+'</div>'+
        roomRows + '</div>';
    }).join('');

    var monthTicks = months.filter(function(ym, i){ return i % tickStep === 0; }).map(function(ym){
      var left = pct(ym);
      return '<span style="position:absolute;left:'+left+'%;font-size:9.5px;color:var(--text-faint);">'+monthLabel(ym)+'</span>';
    }).join('');
    var legendItem = function(colorVar, label){
      return '<span style="display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:var(--text-faint);margin-right:10px;">'+
        '<span style="width:9px;height:9px;border-radius:2px;background:'+colorVar+';display:inline-block;"></span>'+label+'</span>';
    };
    return '<div class="card">'+
      '<h2 style="margin-bottom:2px;">Tenancy timeline</h2>'+
      '<p style="font-size:11px;color:var(--text-faint);margin:0 0 10px;">Grouped by room. Each bar is one tenant\'s stay, from move-in to move-out (or today, if still living there).</p>'+
      propRows+
      '<div style="position:relative;height:14px;margin:6px 0 8px 92px;">'+monthTicks+'</div>'+
      '<div>'+legendItem('var(--status-paid)','Current') + legendItem('var(--status-upcoming)','Upcoming move-in') + legendItem('var(--status-move)','Moved out')+'</div>'+
      '</div>';
  }

  var BOND_STATUS_LABEL = { pending:'Pending', paid:'Paid', partially_returned:'Partially Returned', fully_returned:'Fully Returned' };

  /** The "Move-Out Settlement" card on the admin's tenant detail page — one of four shapes
   *  depending on moveOutSettlementOf(t.id).status (or its absence). Never shown for a tenant
   *  settled under the OLD automatic flow (t.moveOutSettledAt set, no move_out_settlements row)
   *  — those keep showing bondSettlementSummaryHtml unchanged. */
  function moveOutSettlementCardHtml(t){
    if (t.moveOutSettledAt) return ''; // legacy-settled tenant — bondSettlementSummaryHtml handles it
    var settlement = moveOutSettlementOf(t.id);
    if (!settlement){
      return '<div class="card"><h2>Move-Out Settlement</h2>'+
        '<p style="font-size:13px;color:var(--text-dim);margin:0 0 12px;">No move-out process has been started for this tenant.</p>'+
        '<button class="mini-btn primary" onclick="startMoveOutProcess(\''+t.id+'\')">Start Move-Out Process</button></div>';
    }
    var bond = bondOf(t.id);
    if (settlement.status === 'completed'){
      var lines = (bond && bond.discounts || []).filter(function(d){ return d.settlementId === settlement.id; });
      return '<div class="card"><h2>Move-Out Settlement</h2>'+
        '<div class="field-row"><span class="k">Status</span><span class="v">Move-Out Completed</span></div>'+
        '<div class="field-row"><span class="k">Approved</span><span class="v">'+fullDate(settlement.approvedAt)+'</span></div>'+
        (bond ? '<div class="field-row"><span class="k">Original bond</span><span class="v">'+money(bond.amountPaid)+'</span></div>' : '')+
        lines.map(function(d){ return '<div class="field-row"><span class="k">'+esc(d.label)+'</span><span class="v" style="color:var(--status-overdue);">-'+money(d.amount)+'</span></div>'; }).join('')+
        (bond ? '<div class="field-row"><span class="k" style="font-weight:650;">Bond refund</span><span class="v" style="font-weight:650;">'+money(round2(bond.amountPaid - (bond.deduction || 0) - (bond.amountReturned || 0)))+'</span></div>' : '')+ // same basis as computeSettlementTotals: bond.deduction now holds existing + this settlement's lines; subtract what was already returned
        '</div>';
    }
    var candidates = computeCandidateDeductions(t.id);
    // Only in_progress recomputes live; a pending_approval proposal shows the FROZEN totals
    // stored on the settlement row at Calculate time (what Approve will actually act on).
    var totals = settlement.status === 'pending_approval'
      ? { totalDeductions: settlement.totalDeductions, bondRefund: settlement.bondRefund }
      : computeSettlementTotals(bond, settlement.manualDeductions, candidates);
    var deductionRowsHtml = settlement.manualDeductions.map(function(d){
      // "Evidence" sub-row for a deduction linked to a Maintenance request at creation time (see
      // openMoveOutDeductionModal/saveMoveOutDeductionForm) — click-through via openMaintenanceModal,
      // the same global entry point Maintenance's own list uses. Only available pre-approval:
      // approveMoveOutSettlement snapshots deductions onto bond.discounts (a plain audit record,
      // untouched by this task), which doesn't carry linkedMaintenanceRequestId.
      var linkedReq = d.linkedMaintenanceRequestId ? maintenanceRequests.find(function(m){ return m.id === d.linkedMaintenanceRequestId; }) : null;
      return '<div class="field-row"><span class="k">'+esc(d.description)+' ('+esc(d.category)+')</span>'+
        '<span class="v">'+money(d.amount)+
        (settlement.status==='in_progress' ? ' <button class="text-link" onclick="openMoveOutDeductionModal(\''+settlement.id+'\',\''+d.id+'\')">Edit</button>'+
          ' <button class="text-link" onclick="removeMoveOutDeduction(\''+settlement.id+'\',\''+d.id+'\')">Remove</button>' : '')+
        '</span></div>'+
        (linkedReq ? '<div class="field-row"><span class="k" style="padding-left:12px;color:var(--text-faint);font-size:11.5px;">Evidence</span>'+
          '<span class="v"><button class="text-link" onclick="openMaintenanceModal(\''+linkedReq.id+'\')">Maintenance request: '+esc(linkedReq.title)+'</button></span></div>' : '');
    }).join('');
    var candidateRowsHtml = (candidates.rentAmount > 0 ? '<div class="field-row"><span class="k">Outstanding rent</span><span class="v">'+money(candidates.rentAmount)+'</span></div>' : '')+
      candidates.billLines.map(function(l){ return '<div class="field-row"><span class="k">'+esc(billTypeLabel(l.billType))+' bill (Unpaid)</span><span class="v">'+money(l.amount)+'</span></div>'; }).join('');
    var summaryHtml = '<div class="field-row"><span class="k">Original bond</span><span class="v">'+(bond?money(bond.amountPaid):'No bond on file')+'</span></div>'+
      '<div class="field-row"><span class="k">Total deductions</span><span class="v" style="color:var(--status-overdue);">-'+money(totals.totalDeductions)+'</span></div>'+
      (totals.bondRefund != null ? '<div class="field-row"><span class="k" style="font-weight:650;">Refund to tenant</span><span class="v" style="font-weight:650;">'+money(totals.bondRefund)+'</span></div>' : '');

    if (settlement.status === 'in_progress'){
      return '<div class="card"><h2>Move-Out Settlement</h2>'+
        '<p style="font-size:12px;color:var(--text-faint);">Move-Out in Progress. Bills remain Unpaid until you approve a settlement below.</p>'+
        '<h3 style="font-size:12.5px;">Candidate deductions (from unpaid bills/rent)</h3>'+candidateRowsHtml+
        '<h3 style="font-size:12.5px;">Other deductions</h3>'+(deductionRowsHtml||'<p style="font-size:12.5px;color:var(--text-dim);">None added yet.</p>')+
        '<button class="mini-btn" onclick="openMoveOutDeductionModal(\''+settlement.id+'\')">Add deduction</button>'+
        '<h3 style="font-size:12.5px;">Bond Summary (preview — not final)</h3>'+summaryHtml+
        '<button class="mini-btn primary" onclick="calculateMoveOutSettlement(\''+settlement.id+'\')">Calculate Move-Out Settlement</button></div>';
    }
    // pending_approval
    return '<div class="card"><h2>Move-Out Settlement — Pending Approval</h2>'+
      '<h3 style="font-size:12.5px;">Deductions in this proposal</h3>'+
      settlement.billsSnapshot.map(function(l){ return '<div class="field-row"><span class="k">'+esc(l.label)+'</span><span class="v">'+money(l.amount)+'</span></div>'; }).join('')+
      deductionRowsHtml+
      '<h3 style="font-size:12.5px;">Bond Summary</h3>'+summaryHtml+
      '<div class="actions-row">'+
      '<button class="mini-btn primary" onclick="confirmApproveMoveOutSettlement(\''+settlement.id+'\')">Approve Deduction & Finalise Bond</button>'+
      '<button class="mini-btn danger" onclick="confirmRejectMoveOutSettlement(\''+settlement.id+'\')">Reject Settlement</button>'+
      '</div></div>';
  }

  function renderTenantDetail(id){
    var t = tenantOf(id);
    if (!t){ return pageHeader('Tenant not found', '') + notFoundState('Tenant', '#/tenants', 'Back to tenants'); }
    var p = propertyOf(t.propertyId);
    var room = rooms.find(function(r){ return r.id===t.roomId; });
    var bond = bondOf(t.id);
    var currentCharge = pickCurrentCharge(rentCharges.filter(function(c){ return c.tenantId===t.id; }), TODAY);

    var tenancyBadge = '';
    if (t.isActive === false) tenancyBadge = badge('neutral', 'Inactive');
    else if (t.actualMoveOutDate && t.actualMoveOutDate <= TODAY) tenancyBadge = badge('move', 'Moved out');
    else if (t.moveInDate > TODAY) tenancyBadge = badge('move', 'Upcoming move-in');
    else if (t.rentAmount > 0) tenancyBadge = badge('neutral', 'Current tenant');

    var contactRows = '' +
      (t.phone ? '<div class="field-row"><span class="k">Phone</span><span class="v">'+esc(t.phone)+'</span></div>' : '') +
      (t.email ? '<div class="field-row"><span class="k">Email</span><span class="v">'+esc(t.email)+'</span></div>' : '') +
      '<div class="field-row"><span class="k">Property</span><span class="v"><a href="#/properties/'+(p?p.id:'')+'">'+esc(p?p.name:'—')+'</a></span></div>'+
      '<div class="field-row"><span class="k">Room</span><span class="v">'+esc(room?room.name:'—')+'</span></div>';

    var datesRows = '' +
      '<div class="field-row"><span class="k">Move-in</span><span class="v">'+fullDate(t.moveInDate)+'</span></div>'+
      (t.expectedMoveOutDate ? '<div class="field-row"><span class="k">Expected move-out</span><span class="v">'+fullDate(t.expectedMoveOutDate)+'</span></div>' : '') +
      (t.actualMoveOutDate ? '<div class="field-row"><span class="k">Actual move-out</span><span class="v">'+fullDate(t.actualMoveOutDate)+'</span></div>' : '');

    var rentRows = t.rentAmount > 0 ? (
      '<div class="field-row"><span class="k">Rent</span><span class="v">'+money(t.rentAmount)+' / '+t.rentFrequency+'</span></div>'+
      '<div class="field-row"><span class="k">Payment day</span><span class="v">'+paymentDayLabel(t)+'</span></div>' +
      (currentCharge ? '<div class="field-row"><span class="k">Current charge</span><span class="v">'+chargeStatusBadge(currentCharge)+'</span></div>' : '') +
      ((t.excludedBillTypes && t.excludedBillTypes.length) ? '<div class="field-row"><span class="k">Doesn\'t pay for</span><span class="v">'+esc(t.excludedBillTypes.map(billTypeLabel).join(', '))+'</span></div>' : '')
    ) : '';

    // Bond discount labels stored by the move-out settlement flow read as "Outstanding X Bill" /
    // "Outstanding Rent" — accurate at the moment they're written (that's what was owed), but
    // confusing here since by the time they're shown the amount has already been deducted and
    // the bill/rent is already marked paid via bond deduction. Relabel for display only — the
    // stored text is untouched, so bondSettlementSummaryHtml's /^Outstanding .+ Bill$/ matcher
    // above still works on old AND new rows alike.
    function bondDiscountDisplayLabel(label){
      var billMatch = /^Outstanding (.+) Bill$/.exec(label || '');
      if (billMatch) return billMatch[1] + ' bill (paid from bond)';
      if (label === 'Outstanding Rent') return 'Rent (paid from bond)';
      return label || 'Discount';
    }
    var bondRows = bond ? (function(){
      // A bond saved before the itemized discounts list existed only has the old single
      // `deduction` number, with an empty discounts array — show that as one unlabeled
      // line rather than silently dropping it (that's what was happening for tenants like
      // Daniel, whose $200 deduction wasn't showing up anywhere).
      var effectiveDiscounts = (bond.discounts && bond.discounts.length) ? bond.discounts
        : (bond.deduction > 0 ? [{ label:'Deduction', amount:bond.deduction }] : []);
      var totalDeduction = round2(effectiveDiscounts.reduce(function(s,d){ return s+(d.amount||0); }, 0));
      var toReturn = round2(bond.amountPaid - totalDeduction);
      return '<div class="field-row"><span class="k">Bond required</span><span class="v">'+money(bond.amountRequired)+'</span></div>'+
      '<div class="field-row"><span class="k">Bond paid</span><span class="v">'+money(bond.amountPaid)+'</span></div>'+
      (effectiveDiscounts.length
        ? effectiveDiscounts.map(function(d){ return '<div class="field-row"><span class="k">'+esc(bondDiscountDisplayLabel(d.label))+'</span><span class="v" style="color:var(--status-overdue);">-'+money(d.amount)+'</span></div>'; }).join('') +
          '<div class="field-row"><span class="k">Total deduction</span><span class="v">-'+money(totalDeduction)+'</span></div>'+
          '<div class="field-row"><span class="k" style="font-weight:650;">Amount to return</span><span class="v" style="font-weight:650;">'+money(toReturn)+'</span></div>'
        : '') +
      '<div class="field-row"><span class="k">Amount returned</span><span class="v">'+money(bond.amountReturned)+'</span></div>'+
      '<div class="field-row"><span class="k">Status</span><span class="v">'+esc(BOND_STATUS_LABEL[bond.status]||bond.status)+'</span></div>';
    })() : '';

    return backLink('#/tenants', 'Tenants') +
      '<div class="detail-head"><div><h1 class="page-title">'+esc(t.fullName)+'</h1>'+
      '<p class="page-sub">'+esc(p?p.name:'')+(room?' • '+esc(room.name):'')+'</p></div>'+
      (tenancyBadge?'<div>'+tenancyBadge+'</div>':'')+'</div>'+
      '<div class="actions-row">'+
      '<button class="mini-btn" onclick="openTenantModal(\''+t.id+'\')">Edit tenant</button>'+
      '<button class="mini-btn" onclick="openBondModal(\''+t.id+'\')">'+(bond?'Edit bond':'Add bond')+'</button>'+
      '<button class="mini-btn" onclick="toggleTenantActiveConfirm(\''+t.id+'\')">'+(t.isActive===false?'Reactivate tenant':'Deactivate tenant')+'</button>'+
      (isSuperAdmin() ? '<button class="mini-btn danger" onclick="deleteTenantConfirm(\''+t.id+'\')">Delete tenant</button>' : '')+
      '</div>'+
      '<div class="card"><h2>Contact</h2><div class="field-list">'+contactRows+'</div></div>'+
      (rentRows ? '<div class="card"><h2>Rent</h2><div class="field-list">'+rentRows+'</div></div>' : '') +
      tenantRentHistoryHtml(t.id) +
      (bondRows ? '<div class="card"><h2>Bond</h2><div class="field-list">'+bondRows+'</div></div>' : '') +
      '<div class="card"><h2>Dates</h2><div class="field-list">'+datesRows+'</div></div>'+
      inspectionSectionHtml(t.id, 'move_in', false) +
      inspectionSectionHtml(t.id, 'move_out', false) +
      moveOutSettlementCardHtml(t) +
      bondSettlementSummaryHtml(t) +
      moveOutSettlementHtml(t) +
      (t.notes ? '<div class="card"><h2>Notes</h2><p style="margin:0;font-size:13.5px;color:var(--text-dim);">'+esc(t.notes)+'</p></div>' : '');
  }

  /** When a tenant leaves (or is about to leave), computes an ESTIMATE of how much bond should
   *  be refunded: it takes their average daily rate from bills already invoiced (allocated amount
   *  / occupied days in those same bills) and projects it over the days between the last
   *  already-invoiced period and the move-out date — which don't yet have a real bill. It adds
   *  whatever is already invoiced and unpaid (that IS a real amount, not an estimate), any rent
   *  still owed (unpaid/overdue/partially-paid rent periods), and any bond discounts/deductions
   *  already recorded (cleaning, damage, etc.) — and subtracts all of that from the paid bond. It
   *  never replaces the real bill once it arrives: it's only a projection to guide the
   *  administrator in the meantime, only shown once there's a move-out date (actual or expected). */
  function computeMoveOutEstimate(t){
    var moveOutDate = t.actualMoveOutDate || t.expectedMoveOutDate;
    if (!moveOutDate) return null;
    var bond = bondOf(t.id);
    var bondPaid = bond ? bond.amountPaid : 0;
    var bondDeduction = bond ? bond.deduction : 0;

    // Grouped by service TYPE (electricity, gas, internet, etc.) — each one has its
    // own billing cycle, so the "not-yet-billed gap" and the average rate are
    // computed separately for each, not mixed into a single number.
    var byType = {};
    bills.forEach(function(b){
      (b.allocations || []).forEach(function(a){
        if (a.tenantId !== t.id) return;
        var bt = b.billType || 'other';
        var g = byType[bt] || (byType[bt] = { billedDays:0, billedAmount:0, unpaid:0, lastCovered:t.moveInDate });
        var days = (b.billingPeriodStart && b.billingPeriodEnd) ? occupiedDaysInRange(t, b.billingPeriodStart, b.billingPeriodEnd) : 0;
        if (days > 0){ g.billedDays += days; g.billedAmount += a.amount; }
        if (!a.paid) g.unpaid += a.amount;
        if (b.billingPeriodEnd && b.billingPeriodEnd > g.lastCovered) g.lastCovered = b.billingPeriodEnd;
      });
    });

    var lines = [];
    var totalUnpaid = 0, totalEstimatedGap = 0;
    Object.keys(byType).sort(function(a,b){ return billTypeLabel(a).localeCompare(billTypeLabel(b)); }).forEach(function(bt){
      var g = byType[bt];
      var hasHistory = g.billedDays > 0;
      var dailyRate = hasHistory ? (g.billedAmount / g.billedDays) : 0;
      var gapStart = stepDateIso(g.lastCovered, 1);
      var gapDays = gapStart <= moveOutDate ? (daysBetween(gapStart, moveOutDate) + 1) : 0;
      var estimatedGapAmount = round2(dailyRate * gapDays);
      var unpaid = round2(g.unpaid);
      if (unpaid <= 0 && estimatedGapAmount <= 0) return; // nothing to show for this type
      totalUnpaid += unpaid;
      totalEstimatedGap += estimatedGapAmount;
      lines.push({
        billType: bt, unpaid: unpaid, hasHistory: hasHistory,
        dailyRate: round2(dailyRate), gapDays: gapDays, estimatedGapAmount: estimatedGapAmount
      });
    });

    var totalEstimatedOwed = round2(totalUnpaid + totalEstimatedGap);
    var outstandingRent = round2(rentCharges
      .filter(function(c){ return c.tenantId===t.id && c.remaining > 0.004; })
      .reduce(function(s,c){ return s + c.remaining; }, 0));
    // The full picture: bond paid, minus whatever's still owed on rent, minus whatever's still
    // owed on bills (real + estimated), minus any discount/deduction already applied to the bond.
    var estimatedReturn = round2(bondPaid - outstandingRent - totalEstimatedOwed - bondDeduction);

    return {
      moveOutDate: moveOutDate, isActual: !!t.actualMoveOutDate, hasBond: !!bond,
      bondPaid: bondPaid, bondDeduction: round2(bondDeduction), lines: lines,
      totalUnpaid: round2(totalUnpaid), totalEstimatedGap: round2(totalEstimatedGap),
      totalEstimatedOwed: totalEstimatedOwed, estimatedReturn: estimatedReturn,
      outstandingRent: outstandingRent
    };
  }

  function moveOutSettlementHtml(t){
    if (t.moveOutSettledAt) return ''; // already settled for real — see bondSettlementSummaryHtml
    if (moveOutSettlementOf(t.id)) return ''; // the staged move-out settlement flow has taken over — see moveOutSettlementCardHtml
    var est = computeMoveOutEstimate(t);
    if (!est) return '';
    /** One row per service type, showing the FIXED part (already billed, unpaid — a
     *  real amount) separate from the ESTIMATED part (projected from the average, for the days
     *  that don't have a bill yet) — so it's clear what's certain and what's a projection. */
    function typeLineHtml(line){
      var parts = [];
      if (line.unpaid > 0) parts.push('<b>'+money(line.unpaid)+'</b> already charged (unpaid)');
      if (line.estimatedGapAmount > 0) parts.push('<b>'+money(line.estimatedGapAmount)+'</b> estimated ('+line.gapDays+' day'+(line.gapDays===1?'':'s')+' not billed yet'+(line.hasHistory?(', at '+money(line.dailyRate)+'/day'):'')+')');
      return '<div class="field-row" style="align-items:flex-start;">'+
        '<span class="k">'+esc(billTypeLabel(line.billType))+'</span>'+
        '<span class="v" style="text-align:right;font-weight:400;">'+money(round2(line.unpaid+line.estimatedGapAmount))+
        '<br/><span style="font-size:10.5px;color:var(--text-faint);font-weight:400;">'+parts.join(' + ')+'</span></span></div>';
    }
    var rows =
      '<div class="field-row"><span class="k">Move-out date</span><span class="v">'+fullDate(est.moveOutDate)+(est.isActual?'':' (expected)')+'</span></div>'+
      '<div class="field-row"><span class="k">Bond paid</span><span class="v">'+money(est.bondPaid)+'</span></div>';
    rows += est.lines.length
      ? est.lines.map(typeLineHtml).join('')
      : '<div class="field-row"><span class="k">Bills</span><span class="v">Nothing charged or estimated</span></div>';
    rows +=
      '<div class="field-row"><span class="k">Estimated total owed on bills</span><span class="v">'+money(est.totalEstimatedOwed)+'</span></div>'+
      (est.outstandingRent > 0 ? '<div class="field-row"><span class="k">Still owed on rent</span><span class="v" style="color:var(--status-overdue);">-'+money(est.outstandingRent)+'</span></div>' : '')+
      (est.bondDeduction > 0 ? '<div class="field-row"><span class="k">Bond deductions</span><span class="v" style="color:var(--status-overdue);">-'+money(est.bondDeduction)+'</span></div>' : '')+
      '<div class="field-row"><span class="k" style="font-weight:650;">Estimated bond to return</span><span class="v" style="font-weight:650;">'+money(est.estimatedReturn)+'</span></div>';
    return '<div class="card"><h2>Move-out settlement</h2>'+
      '<p style="font-size:11.5px;color:var(--text-faint);margin:0 0 8px;">Below, each service shows what\'s already charged and unpaid (a real amount) separately from what\'s estimated from the average for days not billed yet. Update it once the real bills for the final days arrive. "Estimated bond to return" already subtracts unpaid rent and any bond deductions, along with the bills above.</p>'+
      '<div class="field-list">'+rows+'</div></div>';
  }

  /* ============ Move-out bond settlement ============
   * Once a tenant has actually moved out (actualMoveOutDate reached), any rent still owed and
   * any unpaid bill shares are automatically settled by deducting them from the bond — never
   * left as if the tenant still had to pay them separately. This runs once per tenant
   * (guarded by tenant.moveOutSettledAt): automatically right after saveTenantForm crosses a
   * tenant into "moved out", and manually from the "Settle bond now" button below for tenants
   * who were already moved out before this existed, or to re-run after correcting a bill.
   * It only ever marks things paid and records bond deductions — the actual bond REFUND (giving
   * money back) stays a deliberate manual step via "Edit bond", exactly as before. */
  function bondSettlementSummaryHtml(t){
    if (!t.moveOutSettledAt) return '';
    var bond = bondOf(t.id);
    if (!bond){
      return '<div class="card"><h2>Bond settlement</h2>'+
        '<p style="font-size:13px;color:var(--text-dim);margin:0;">This tenant moved out with no bond on file — outstanding rent/bills couldn\'t be deducted from anything.</p></div>';
    }
    var discounts = bond.discounts || [];
    var rentLine = round2(discounts.filter(function(d){ return d.label==='Outstanding Rent'; }).reduce(function(s,d){ return s+(d.amount||0); }, 0));
    var billsLine = round2(discounts.filter(function(d){ return /^Outstanding .+ Bill$/.test(d.label||''); }).reduce(function(s,d){ return s+(d.amount||0); }, 0));
    var settlementTotal = round2(rentLine + billsLine);
    var totalDeducted = round2(bond.deduction || 0);
    var otherDeductions = round2(totalDeducted - settlementTotal);
    var refund = round2(bond.amountPaid - totalDeducted);
    var owed = refund < 0 ? round2(-refund) : 0;
    if (refund < 0) refund = 0;
    var rows =
      '<div class="field-row"><span class="k">Bond</span><span class="v">'+money(bond.amountPaid)+'</span></div>'+
      (rentLine > 0 ? '<div class="field-row"><span class="k">Rent deducted</span><span class="v" style="color:var(--status-overdue);">-'+money(rentLine)+'</span></div>' : '')+
      (billsLine > 0 ? '<div class="field-row"><span class="k">Bills deducted</span><span class="v" style="color:var(--status-overdue);">-'+money(billsLine)+'</span></div>' : '')+
      (otherDeductions > 0.004 ? '<div class="field-row"><span class="k">Other deductions on this bond</span><span class="v" style="color:var(--status-overdue);">-'+money(otherDeductions)+'</span></div>' : '')+
      '<div class="field-row"><span class="k">Total deducted</span><span class="v">'+money(totalDeducted)+'</span></div>'+
      (owed > 0
        ? '<div class="field-row"><span class="k" style="font-weight:650;">Still owed by tenant</span><span class="v" style="font-weight:650;color:var(--status-overdue);">'+money(owed)+'</span></div>'
        : '<div class="field-row"><span class="k" style="font-weight:650;">Bond refund</span><span class="v" style="font-weight:650;">'+money(refund)+'</span></div>');
    return '<div class="card"><h2>Bond settlement</h2>'+
      '<p style="font-size:11.5px;color:var(--text-faint);margin:0 0 8px;">Outstanding rent and bills were settled by deducting them from the bond on move-out — see payment history and each bill\'s allocation for the individual entries. Actually returning a refund is still a manual step, from "Edit bond" below.</p>'+
      '<div class="field-list">'+rows+'</div>'+
      '</div>';
  }

  /** Every unpaid bill share for this tenant (grouped one line per allocation, not merged by
   *  type — the settlement needs to reference each bill individually) plus outstanding rent.
   *  Pure and read-only: never marks anything paid. Used both for the live "in_progress"
   *  preview and, frozen, as the bills_snapshot at Calculate time. */
  function computeCandidateDeductions(tenantId){
    var rentAmount = round2(rentCharges
      .filter(function(c){ return c.tenantId === tenantId && c.remaining > 0.004; })
      .reduce(function(s, c){ return s + c.remaining; }, 0));
    var billLines = [];
    bills.forEach(function(b){
      (b.allocations || []).forEach(function(a){
        if (a.tenantId !== tenantId || a.paid || round2(a.amount) <= 0) return;
        billLines.push({ billId: b.id, billType: b.billType || 'other', allocationId: a.id, amount: round2(a.amount) });
      });
    });
    return { rentAmount: rentAmount, billLines: billLines };
  }

  /** bondRefund is null (not 0) when there's no bond on file, so the UI can show "No bond on
   *  file" instead of a misleading "$0.00 refund". */
  function computeSettlementTotals(bond, manualDeductions, candidates){
    var manualTotal = (manualDeductions || []).reduce(function(s, d){ return s + (d.amount || 0); }, 0);
    var billsTotal = candidates.billLines.reduce(function(s, l){ return s + l.amount; }, 0);
    var totalDeductions = round2(candidates.rentAmount + billsTotal + manualTotal);
    // Account for anything already deducted from / returned out of this bond before this
    // settlement (e.g. an old-format single-number deduction, or a partial refund already paid).
    var existingDeduction = bond ? round2(bond.deduction || 0) : 0;
    var alreadyReturned = bond ? round2(bond.amountReturned || 0) : 0;
    var bondRefund = bond ? round2(bond.amountPaid - existingDeduction - totalDeductions - alreadyReturned) : null;
    return { totalDeductions: totalDeductions, bondRefund: bondRefund };
  }

  /** The tenant's current move-out settlement: the active (non-completed) row if one exists,
   *  otherwise the most recently completed one (so a finished settlement still displays after
   *  the fact), otherwise undefined (no move-out process started). */
  function moveOutSettlementOf(tenantId){
    var mine = moveOutSettlements.filter(function(s){ return s.tenantId === tenantId; });
    var active = mine.find(function(s){ return s.status !== 'completed'; });
    if (active) return active;
    return mine.slice().sort(function(a,b){ return (b.approvedAt||'').localeCompare(a.approvedAt||''); })[0];
  }

  /** Rebuilds the {fullName, propertyId, ...} draft shape tenantService.update expects, from an
   *  in-memory tenant object — used by startMoveOutProcess so it can patch just actualMoveOutDate
   *  without duplicating saveTenantForm's full form-reading logic. */
  function tenantToDraft(t){
    var draft = { fullName:t.fullName, propertyId:t.propertyId, roomId:t.roomId, moveInDate:t.moveInDate,
      rentAmount:t.rentAmount, rentFrequency:t.rentFrequency, paymentDay:t.paymentDay,
      excludedBillTypes:t.excludedBillTypes||[], billOccupancyFactor:t.billOccupancyFactor||1,
      isActive: t.isActive !== false }; // toRow writes is_active: t.isActive !== false — omitting it would silently reactivate a deactivated tenant
    if (t.phone) draft.phone = t.phone;
    if (t.email) draft.email = t.email;
    if (t.expectedMoveOutDate) draft.expectedMoveOutDate = t.expectedMoveOutDate;
    if (t.actualMoveOutDate) draft.actualMoveOutDate = t.actualMoveOutDate;
    if (t.notes) draft.notes = t.notes;
    return draft;
  }

  /** Starts the staged move-out settlement process for a tenant — never marks anything paid or
   *  touches the bond. Callable by staff (from the tenant detail page) or by the tenant
   *  themselves (from "My Bond" in the portal). If there's no actual move-out date yet, asks
   *  for one first (defaulting to today) since the settlement needs a settle-as-of date. */
  async function startMoveOutProcess(tenantId){
    var t = tenantOf(tenantId);
    if (!t) return;
    if (moveOutSettlementOf(tenantId) && moveOutSettlementOf(tenantId).status !== 'completed'){
      showToast('This tenant already has a move-out in progress.', 'info');
      return;
    }
    if (!t.actualMoveOutDate){
      var dateInput = window.prompt('Actual move-out date (YYYY-MM-DD):', TODAY);
      if (!dateInput) return;
      if (dateInput < t.moveInDate){
        showToast("Actual move-out can't be before the move-in date.", 'error');
        return;
      }
      try {
        if (isTenantRole()){
          // Tenants have no UPDATE grant on their own tenants row (RLS) — use the narrow
          // SECURITY DEFINER RPC that can only set this one date on the caller's own row.
          await tenantService.setOwnActualMoveOutDate(dateInput);
          t.actualMoveOutDate = dateInput;
        } else {
          var saved = await tenantService.update(tenantId, Object.assign({}, tenantToDraft(t), { actualMoveOutDate: dateInput }));
          Object.assign(t, saved);
        }
      } catch(err){
        showToast('Could not save the move-out date. ' + friendlyErrorMessage(err), 'error');
        return;
      }
    }
    var role = isTenantRole() ? 'tenant' : (currentProfile ? currentProfile.role : 'administrator');
    try {
      var row = await moveOutSettlementService.start(tenantId, role);
      moveOutSettlements.push(row);
      showToast('Move-out process started.', 'success');
      render();
    } catch(err){
      // 23505 = unique violation on move_out_settlements_one_active_per_tenant: someone else
      // (staff or the tenant) started one between our in-memory check above and this insert.
      if (err && err.code === '23505'){
        showToast('This tenant already has a move-out in progress.', 'info');
      } else {
        showToast('Could not start the move-out process. ' + friendlyErrorMessage(err), 'error');
      }
    }
  }
  window.startMoveOutProcess = startMoveOutProcess;

  var moveOutDeductionModalSettlementId = null;
  var moveOutDeductionModalEditId = null;
  // Evidence photo paths (still living in the `maintenance-photos` bucket — see
  // onMoveOutDeductionLinkChange) pulled in from a linked Maintenance request, staged here until
  // Save. Only ever populated when ADDING a deduction (Phase 4 Task 3 links at creation time only).
  var moveOutDeductionModalLinkedPhotoPaths = [];

  function openMoveOutDeductionModal(settlementId, deductionId){
    moveOutDeductionModalSettlementId = settlementId;
    moveOutDeductionModalEditId = deductionId || null;
    moveOutDeductionModalLinkedPhotoPaths = [];
    var settlement = moveOutSettlements.find(function(s){ return s.id === settlementId; });
    var existing = deductionId && settlement ? settlement.manualDeductions.find(function(d){ return d.id === deductionId; }) : null;
    document.getElementById('move-out-deduction-modal-title').textContent = existing ? 'Edit deduction' : 'Add deduction';
    document.getElementById('move-out-deduction-category').value = existing ? existing.category : 'cleaning';
    document.getElementById('move-out-deduction-description').value = existing ? existing.description : '';
    document.getElementById('move-out-deduction-amount').value = existing ? existing.amount : '';
    document.getElementById('move-out-deduction-date').value = existing ? existing.date : TODAY;
    document.getElementById('move-out-deduction-comments').value = existing ? (existing.comments||'') : '';
    document.getElementById('move-out-deduction-photos').value = '';
    document.getElementById('move-out-deduction-modal-error').hidden = true;
    // "Link to Maintenance request" — optional, and only offered when ADDING a new deduction (the
    // plan scopes this to deduction-creation time); editing an existing deduction hides it and
    // leaves whatever link it already has untouched (see saveMoveOutDeductionForm).
    var linkRow = document.getElementById('move-out-deduction-link-row');
    var linkSelect = document.getElementById('move-out-deduction-link-request');
    var linkPreview = document.getElementById('move-out-deduction-link-photos-preview');
    if (linkRow && linkSelect && linkPreview){
      linkPreview.innerHTML = '';
      if (existing){
        linkRow.hidden = true;
        linkSelect.innerHTML = '<option value="">— None —</option>';
        linkSelect.value = '';
      } else {
        linkRow.hidden = false;
        var linkTenant = settlement ? tenantOf(settlement.tenantId) : null;
        // Only requests for THIS tenant (or, when a request has no tenant_id, this tenant's current
        // room) — never another tenant's Maintenance history (Review Focus #3).
        var eligibleRequests = linkTenant ? maintenanceRequests.filter(function(m){
          return m.tenantId === linkTenant.id || (m.tenantId == null && m.roomId === linkTenant.roomId);
        }) : [];
        linkSelect.innerHTML = '<option value="">— None —</option>' + eligibleRequests.map(function(m){
          return '<option value="'+m.id+'">'+esc(m.title)+' ('+esc(MAINTENANCE_STATUS_LABEL[m.status]||m.status)+')</option>';
        }).join('');
        linkSelect.value = '';
      }
    }
    document.getElementById('move-out-deduction-modal').hidden = false;
  }
  window.openMoveOutDeductionModal = openMoveOutDeductionModal;

  /** Fired when the admin picks (or clears) a Maintenance request in the optional evidence-link
   *  selector, while adding a new deduction. Pre-fills description + stages evidence photos for
   *  save — never touches the amount field (Review Focus #4: the deduction amount stays a manual
   *  entry, always). Photos are concatenated from all 3 staged sets (before/during/after) — the
   *  simplest option the plan left to this implementer's judgment — and stay editable: the admin
   *  can retype the description, or pick "— None —" again to drop the photos, before saving. */
  function onMoveOutDeductionLinkChange(){
    var select = document.getElementById('move-out-deduction-link-request');
    var requestId = select ? select.value : '';
    if (!requestId){
      moveOutDeductionModalLinkedPhotoPaths = [];
      renderMoveOutDeductionLinkedPhotosPreview();
      return;
    }
    var m = maintenanceRequests.find(function(x){ return x.id === requestId; });
    if (!m) return;
    document.getElementById('move-out-deduction-description').value = m.title + (m.description ? ' — ' + m.description : '');
    moveOutDeductionModalLinkedPhotoPaths = (m.photosBefore||[]).concat(m.photosDuring||[]).concat(m.photosAfter||[]);
    renderMoveOutDeductionLinkedPhotosPreview();
  }
  window.onMoveOutDeductionLinkChange = onMoveOutDeductionLinkChange;

  /** Thumbnails for moveOutDeductionModalLinkedPhotoPaths — same signed-URL-thumbnail pattern as
   *  renderMaintenancePhotosPreview, since these paths are (until Save) still sitting in the
   *  `maintenance-photos` bucket they were originally uploaded to. */
  function renderMoveOutDeductionLinkedPhotosPreview(){
    var box = document.getElementById('move-out-deduction-link-photos-preview');
    if (!box) return;
    box.innerHTML = '';
    var groupId = 'lbg' + (++lightboxGroupSeq);
    moveOutDeductionModalLinkedPhotoPaths.forEach(function(path, idx){
      var img = document.createElement('img');
      img.style.cssText = 'width:52px;height:52px;object-fit:cover;border-radius:6px;border:1px solid var(--border);cursor:pointer;background:var(--surface-2,#eee);';
      img.title = 'Open photo';
      registerLightboxImg(img, 'maintenance-photos', path, groupId, idx);
      getCachedSignedUrl('maintenance-photos', path, 600).then(function(url){ img.src = url; }).catch(function(){ /* ignore a single broken thumbnail */ });
      box.appendChild(img);
    });
  }

  function closeMoveOutDeductionModal(){
    document.getElementById('move-out-deduction-modal').hidden = true;
    moveOutDeductionModalSettlementId = null;
    moveOutDeductionModalEditId = null;
    moveOutDeductionModalLinkedPhotoPaths = [];
  }
  window.closeMoveOutDeductionModal = closeMoveOutDeductionModal;

  async function saveMoveOutDeductionForm(){
    var settlement = moveOutSettlements.find(function(s){ return s.id === moveOutDeductionModalSettlementId; });
    var errorEl = document.getElementById('move-out-deduction-modal-error');
    if (!settlement){ errorEl.textContent = 'Settlement not found.'; errorEl.hidden = false; return; }
    var category = document.getElementById('move-out-deduction-category').value;
    var description = document.getElementById('move-out-deduction-description').value.trim();
    var amount = parseFloat(document.getElementById('move-out-deduction-amount').value);
    var date = document.getElementById('move-out-deduction-date').value;
    var comments = document.getElementById('move-out-deduction-comments').value.trim();
    var fileInput = document.getElementById('move-out-deduction-photos');
    // Only read when ADDING (the picker is hidden while editing — see openMoveOutDeductionModal),
    // so this is '' for every edit regardless of what the (reset, hidden) select currently holds.
    var linkSelectEl = document.getElementById('move-out-deduction-link-request');
    var linkedRequestId = (!moveOutDeductionModalEditId && linkSelectEl) ? linkSelectEl.value : '';
    if (!description || !isFinite(amount) || amount <= 0 || !date){
      errorEl.textContent = 'Add a description, a date, and an amount greater than 0.';
      errorEl.hidden = false;
      return;
    }
    var saveBtn = document.querySelector('#move-out-deduction-modal .mini-btn.primary');
    var originalLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    errorEl.hidden = true;
    try {
      var photoPaths = [];
      if (fileInput.files && fileInput.files.length){
        photoPaths = await storageService.uploadMoveOutEvidencePhotos(fileInput.files);
      }
      var deductions = settlement.manualDeductions.slice();
      var timelineEntries;
      if (moveOutDeductionModalEditId){
        var idx = deductions.findIndex(function(d){ return d.id === moveOutDeductionModalEditId; });
        var prevAmount = idx >= 0 ? deductions[idx].amount : null;
        var existingPhotos = idx >= 0 ? (deductions[idx].photoPaths || []) : [];
        // Evidence-link fields are creation-time-only — carry forward whatever this deduction
        // already had rather than the (hidden, reset) picker, so editing never changes the link.
        var priorLinkedRequestId = idx >= 0 ? (deductions[idx].linkedMaintenanceRequestId || null) : null;
        var priorLinkedPhotoPaths = idx >= 0 ? (deductions[idx].linkedEvidencePhotoPaths || []) : [];
        deductions[idx] = { id: moveOutDeductionModalEditId, category:category, description:description,
          amount:round2(amount), date:date, comments:comments, photoPaths: existingPhotos.concat(photoPaths),
          linkedMaintenanceRequestId: priorLinkedRequestId, linkedEvidencePhotoPaths: priorLinkedPhotoPaths };
        timelineEntries = [{ at:new Date().toISOString(), action:'Admin edited deduction: ' + description,
          amount: round2(amount), detail: prevAmount != null ? ('was ' + money(prevAmount)) : null }];
      } else {
        var newId = 'ded_' + Date.now() + '_' + Math.random().toString(36).slice(2,8);
        // linkedMaintenanceRequestId/linkedEvidencePhotoPaths are purely additive fields on the
        // manual_deductions jsonb entry — no schema change, and every other field/behavior here
        // (amount above all — Review Focus #4) is exactly what it was before this task.
        deductions.push({ id:newId, category:category, description:description, amount:round2(amount),
          date:date, comments:comments, photoPaths:photoPaths,
          linkedMaintenanceRequestId: linkedRequestId || null,
          linkedEvidencePhotoPaths: linkedRequestId ? moveOutDeductionModalLinkedPhotoPaths.slice() : [] });
        timelineEntries = [{ at:new Date().toISOString(), action:'Admin added deduction: ' + description, amount: round2(amount) }];
      }
      // If a proposal was already calculated, this invalidates it — see calculateMoveOutSettlement's
      // "revert on edit" rule (Task 8's Review Focus item 2).
      var wasPending = settlement.status === 'pending_approval';
      var saved = wasPending
        ? await moveOutSettlementService.revertToInProgress(settlement.id, timelineEntries.concat([
            { at:new Date().toISOString(), action:'Settlement proposal invalidated by a deduction change — recalculate to continue.' }
          ]))
        : await moveOutSettlementService.saveDraftDeductions(settlement.id, deductions, timelineEntries);
      if (wasPending){
        saved.manualDeductions = deductions;
        await moveOutSettlementService.saveDraftDeductions(settlement.id, deductions, []);
      }
      Object.assign(settlement, saved, { manualDeductions: deductions });
      // Record the evidence relation in entity_links too (in addition to the fields above), same
      // "loaded whole, kept in sync locally" pattern as every other entityLinkService caller in
      // this file. Non-fatal: the deduction itself already saved successfully by this point, so a
      // failure here is logged rather than surfaced as a save error (avoids the admin retrying and
      // creating a duplicate deduction).
      if (linkedRequestId){
        try {
          var newLink = await entityLinkService.linkEntities('maintenance_requests', linkedRequestId, 'move_out_settlements', settlement.id, 'deduction_evidence');
          entityLinks.push(newLink);
        } catch(linkErr){
          console.error('Could not record maintenance-request evidence link', linkErr);
        }
      }
      closeMoveOutDeductionModal();
      showToast('Deduction saved.', 'success');
      render();
    } catch(err){
      errorEl.textContent = 'Could not save this deduction. ' + friendlyErrorMessage(err);
      errorEl.hidden = false;
    } finally {
      if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = originalLabel; }
    }
  }
  window.saveMoveOutDeductionForm = saveMoveOutDeductionForm;

  async function removeMoveOutDeduction(settlementId, deductionId){
    var settlement = moveOutSettlements.find(function(s){ return s.id === settlementId; });
    if (!settlement) return;
    var target = settlement.manualDeductions.find(function(d){ return d.id === deductionId; });
    var deductions = settlement.manualDeductions.filter(function(d){ return d.id !== deductionId; });
    var timelineEntries = [{ at:new Date().toISOString(), action:'Admin removed deduction: ' + (target ? target.description : deductionId) }];
    try {
      var saved = settlement.status === 'pending_approval'
        ? await moveOutSettlementService.revertToInProgress(settlement.id, timelineEntries)
        : await moveOutSettlementService.saveDraftDeductions(settlement.id, deductions, timelineEntries);
      Object.assign(settlement, saved, { manualDeductions: deductions });
      showToast('Deduction removed.', 'success');
      render();
    } catch(err){
      showToast('Could not remove this deduction. ' + friendlyErrorMessage(err), 'error');
    }
  }
  window.removeMoveOutDeduction = removeMoveOutDeduction;

  /** Freezes the current candidate bills/rent + manual deductions into a proposal. Recomputing
   *  (pressing this again while already pending_approval) simply overwrites the previous
   *  snapshot — there's no need to revert first since this IS the recalculation. */
  async function calculateMoveOutSettlement(settlementId){
    var settlement = moveOutSettlements.find(function(s){ return s.id === settlementId; });
    if (!settlement) return;
    var t = tenantOf(settlement.tenantId);
    if (!t) return;
    var candidates = computeCandidateDeductions(t.id);
    var bond = bondOf(t.id);
    var totals = computeSettlementTotals(bond, settlement.manualDeductions, candidates);
    var billsSnapshot = candidates.billLines.map(function(l){
      return { kind:'bill', label: billTypeLabel(l.billType) + ' bill', amount: l.amount, billId: l.billId, billType: l.billType, allocationId: l.allocationId };
    });
    if (candidates.rentAmount > 0){
      billsSnapshot.unshift({ kind:'rent', label:'Outstanding rent', amount: candidates.rentAmount });
    }
    var timelineEntries = [{
      at: new Date().toISOString(),
      action: 'Admin generated settlement proposal.',
      amount: totals.totalDeductions, fromStatus: settlement.status, toStatus: 'pending_approval'
    }];
    try {
      var saved = await moveOutSettlementService.calculate(settlementId, billsSnapshot, totals, timelineEntries);
      Object.assign(settlement, saved);
      showToast('Move-out settlement proposal generated — pending approval.', 'success');
      render();
    } catch(err){
      showToast('Could not generate the settlement proposal. ' + friendlyErrorMessage(err), 'error');
    }
  }
  window.calculateMoveOutSettlement = calculateMoveOutSettlement;

  /** The ONLY function in this feature allowed to touch bill_allocations, payments or bonds —
   *  and only ever called from confirmApproveMoveOutSettlement's explicit confirm. Mirrors what
   *  the old automatic settlement flow did, minus the "automatic" part. Skips any
   *  snapshot line whose allocation is already paid (Review Focus item 4 — e.g. the tenant paid
   *  cash between Calculate and Approve) so it never double-counts or errors on a stale row. */
  async function approveMoveOutSettlement(settlementId){
    var settlement = moveOutSettlements.find(function(s){ return s.id === settlementId; });
    if (!settlement || !settlement.billsSnapshot) return;
    if (settlement.status !== 'pending_approval') return;
    var t = tenantOf(settlement.tenantId);
    if (!t) return;
    var settleDate = t.actualMoveOutDate || TODAY;
    var bond = bondOf(t.id);
    var timelineEntries = [];
    var newDiscountLines = [];
    var touchedBills = {};

    for (var i = 0; i < settlement.billsSnapshot.length; i++){
      var line = settlement.billsSnapshot[i];
      if (line.kind === 'rent'){
        var stillOwed = round2(rentCharges.filter(function(c){ return c.tenantId === t.id && c.remaining > 0.004; })
          .reduce(function(s,c){ return s + c.remaining; }, 0));
        var rentToDeduct = Math.min(stillOwed, line.amount);
        // Retry recovery (Task9a): if an earlier, partially-failed attempt of THIS approval already
        // created the bond_deduction rent payment but never got as far as recording it on the bond,
        // stillOwed is now 0 and the rent would otherwise never appear in bond.discounts. Recover it
        // from the bond_deduction payment(s) already on file for this settle date (only this flow
        // creates bond_deduction payments), capped at what the snapshot line proposed — unless the
        // bond already has this settlement's rent line (then the alreadyRecorded filter below
        // would drop it anyway).
        var rentAlreadyOnBond = !!bond && (bond.discounts || []).some(function(d){ return d.settlementId === settlement.id && d.sourceId === 'rent'; });
        var recoveredRent = 0;
        if (!rentAlreadyOnBond && rentToDeduct < line.amount - 0.004){
          var priorBondRent = round2(paymentRecords.filter(function(p){ return p.tenantId === t.id && p.method === 'bond_deduction' && p.date === settleDate; })
            .reduce(function(s,p){ return s + p.amount; }, 0));
          recoveredRent = round2(Math.min(priorBondRent, line.amount - rentToDeduct));
        }
        if (rentToDeduct > 0.004){
          var savedPayment = await paymentService.create({ tenantId:t.id, amount:rentToDeduct, date:settleDate, method:'bond_deduction' });
          paymentRecords.push(savedPayment);
          recomputeRentCharges();
          timelineEntries.push({ at:new Date().toISOString(), action:'Rent deducted from bond.', amount: rentToDeduct });
        }
        if (recoveredRent > 0.004){
          timelineEntries.push({ at:new Date().toISOString(), action:'Rent already deducted from bond on an earlier approval attempt — recording it on the bond.', amount: recoveredRent });
        }
        var rentDiscountTotal = round2(rentToDeduct + recoveredRent);
        if (rentDiscountTotal > 0.004){
          newDiscountLines.push({ label:'Outstanding Rent', amount:rentDiscountTotal, category:'rent', sourceType:'rent', sourceId:'rent', settlementId:settlement.id });
        }
        continue;
      }
      // line.kind === 'bill'
      var bill = bills.find(function(b){ return b.id === line.billId; });
      var alloc = bill ? (bill.allocations||[]).find(function(a){ return a.id === line.allocationId; }) : null;
      var hasPendingReport = alloc ? paymentReports.some(function(pr){ return pr.allocationId === alloc.id && pr.status === 'pending'; }) : false;
      // Retry recovery (Task9a): already paid via bond_deduction means an earlier, partially-failed
      // attempt of THIS approval marked it paid (only this flow uses bond_deduction, and the
      // snapshot only holds shares that were unpaid at Calculate time). Don't mark it paid again,
      // but still contribute its discount line so the bond records the money that already moved
      // (the alreadyRecorded/sourceId filter below drops it if the bond already has it), and
      // re-persist the bill's status in case the earlier attempt failed before doing so. A pending
      // report here can only be one this flow's own autoConfirmPendingPaymentReport failed to
      // resolve after markPaid (approval never marks a share with a pending report paid), so it
      // doesn't block recovery — retry the auto-confirm instead.
      if (bill && alloc && alloc.paid && alloc.paidVia === 'bond_deduction'){
        if (hasPendingReport){ try { await autoConfirmPendingPaymentReport(alloc.id); } catch(_e){ console.error('autoConfirmPendingPaymentReport failed', _e); } }
        touchedBills[bill.id] = bill;
        newDiscountLines.push({ label: billTypeLabel(line.billType) + ' bill', amount: line.amount, category:'bill', sourceType:'bill', billId:bill.id, sourceId:bill.id, settlementId:settlement.id });
        timelineEntries.push({ at:new Date().toISOString(), action: billTypeLabel(line.billType) + ' bill was already marked Paid — Bond deduction on an earlier approval attempt; recording it on the bond.', amount: line.amount });
        continue;
      }
      if (!bill || !alloc || alloc.paid || hasPendingReport){
        timelineEntries.push({ at:new Date().toISOString(), action:'Skipped ' + billTypeLabel(line.billType) + ' bill from the approved settlement — ' + (hasPendingReport ? 'tenant has a pending payment report for it.' : 'it was already resolved another way since the proposal was calculated.') });
        continue;
      }
      var savedAlloc = await billAllocationService.markPaid(alloc.id, settleDate, 'bond_deduction');
      alloc.paid = true; alloc.paidDate = settleDate; alloc.paidVia = savedAlloc.paidVia;
      try { await autoConfirmPendingPaymentReport(alloc.id); } catch(_e){ console.error('autoConfirmPendingPaymentReport failed', _e); }
      touchedBills[bill.id] = bill;
      newDiscountLines.push({ label: billTypeLabel(line.billType) + ' bill', amount: line.amount, category:'bill', sourceType:'bill', billId:bill.id, sourceId:bill.id, settlementId:settlement.id });
      timelineEntries.push({ at:new Date().toISOString(), action: billTypeLabel(line.billType) + ' bill marked Paid — Bond deduction.', amount: line.amount });
    }
    for (var billId in touchedBills){
      var touchedBill = touchedBills[billId];
      recomputeBillStatus(touchedBill);
      var keepAllocations = touchedBill.allocations;
      await persistBill(touchedBill);
      touchedBill.allocations = keepAllocations;
    }

    (settlement.manualDeductions || []).forEach(function(d){
      newDiscountLines.push({ label:d.description, amount:d.amount, category:d.category, description:d.description,
        photoPaths:d.photoPaths||[], comments:d.comments||'', date:d.date, sourceType:'manual', sourceId:d.id, settlementId:settlement.id });
      timelineEntries.push({ at:new Date().toISOString(), action:'Manual deduction applied: ' + d.description, amount:d.amount });
    });

    if (bond){
      var alreadyRecorded = (bond.discounts || []).filter(function(d){ return d.settlementId === settlement.id; })
        .map(function(d){ return d.sourceId; });
      newDiscountLines = newDiscountLines.filter(function(d){ return alreadyRecorded.indexOf(d.sourceId) === -1; });
    }

    if (bond && newDiscountLines.length){
      // Same old-format migration as openBondModal: a bond saved before itemized discounts existed
      // only has the single `deduction` number with an empty discounts array — seed it as one line
      // so approving this settlement doesn't silently erase that pre-existing deduction.
      var existingDiscounts = (bond.discounts && bond.discounts.length) ? bond.discounts
        : (bond.deduction > 0 ? [{ label:'Existing deduction', amount:bond.deduction }] : []);
      var mergedDiscounts = existingDiscounts.concat(newDiscountLines);
      var newDeduction = round2(mergedDiscounts.reduce(function(s,d){ return s + (d.amount||0); }, 0));
      var savedBond = await bondService.update(bond.id, {
        amountRequired: bond.amountRequired, amountPaid: bond.amountPaid, amountReturned: bond.amountReturned,
        deduction: newDeduction, discounts: mergedDiscounts, status: bond.status
      });
      Object.assign(bond, savedBond);
    }

    timelineEntries.push({ at:new Date().toISOString(), action:'Move-out completed.', fromStatus:'pending_approval', toStatus:'completed' });
    var saved = await moveOutSettlementService.approve(settlement.id, timelineEntries);
    Object.assign(settlement, saved);
  }

  function confirmApproveMoveOutSettlement(settlementId){
    openConfirmModal('Approve Deduction & Finalise Bond',
      "Are you sure you want to approve this move-out settlement? This action will deduct the approved amounts from the tenant's bond and mark the corresponding bills as paid.",
      async function(){
        try {
          await approveMoveOutSettlement(settlementId);
          showToast('Move-out settlement approved and finalised.', 'success');
          render();
        } catch(err){
          return { blocked:true, message: 'Could not finalise the settlement. ' + friendlyErrorMessage(err) };
        }
      },
      { confirmLabel: 'Approve & Finalise' });
  }
  window.confirmApproveMoveOutSettlement = confirmApproveMoveOutSettlement;

  function confirmRejectMoveOutSettlement(settlementId){
    openConfirmModal('Reject Settlement',
      'Reject this proposal? Bills stay Unpaid, the bond stays intact, and you can edit the deductions and generate a new proposal afterward.',
      async function(){
        try {
          var saved = await moveOutSettlementService.revertToInProgress(settlementId, [
            { at:new Date().toISOString(), action:'Admin rejected the settlement proposal.', fromStatus:'pending_approval', toStatus:'in_progress' }
          ]);
          var settlement = moveOutSettlements.find(function(s){ return s.id === settlementId; });
          Object.assign(settlement, saved);
          showToast('Settlement rejected — bills and bond are unchanged.', 'info');
          render();
        } catch(err){
          return { blocked:true, message: 'Could not reject the settlement. ' + friendlyErrorMessage(err) };
        }
      },
      { confirmLabel: 'Reject' });
  }
  window.confirmRejectMoveOutSettlement = confirmRejectMoveOutSettlement;

  /** "Rent history" card for a tenant's profile: which weeks/periods are already paid, and
   *  which are still due, overdue or upcoming — split into two lists so what still needs
   *  chasing isn't buried under months of already-settled periods. Each row reuses
   *  chargeStatusBadge() so the colors match the Payments page exactly. */
  function tenantRentHistoryHtml(tenantId){
    var charges = rentCharges.filter(function(c){ return c.tenantId===tenantId; });
    if (charges.length === 0) return '';
    var paid = charges.filter(function(c){ return c.status==='paid'; })
      .sort(function(a,b){ return b.periodStart.localeCompare(a.periodStart); });
    var pending = charges.filter(function(c){ return c.status!=='paid'; })
      .sort(function(a,b){ return b.periodStart.localeCompare(a.periodStart); }); // most recent first
    function row(c){
      var label = shortDate(c.periodStart)+' – '+shortDate(c.periodEnd);
      if (c.status === 'paid' && c.paidDate) label += ' <span style="color:var(--text-faint);">(paid '+shortDate(c.paidDate)+')</span>';
      return '<div class="field-row"><span class="k">'+label+'</span>'+
        '<span class="v" style="display:flex;align-items:center;gap:8px;">'+money(c.amountDue)+chargeStatusBadge(c)+'</span></div>';
    }
    var PAID_CAP = 12;
    var pendingShown = pending; // pending items are always shown in full, never truncated
    var pendingExtra = 0;
    var paidShown = paid.slice(0, PAID_CAP);
    var paidExtra = paid.length - paidShown.length;
    return '<div class="card"><h2>Rent history</h2>'+
      '<h3 style="font-size:12px;text-transform:none;letter-spacing:0;color:var(--text-dim);margin:0 0 6px;">Due &amp; upcoming ('+pending.length+')</h3>'+
      (pendingShown.length ? '<div class="field-list">'+pendingShown.map(row).join('')+'</div>' : '<p style="font-size:12.5px;color:var(--text-faint);margin:0 0 10px;">Nothing due right now.</p>')+
      (pendingExtra>0 ? '<p style="font-size:11.5px;color:var(--text-faint);margin:6px 0 0;">+'+pendingExtra+' more further out, not shown.</p>' : '')+
      '<h3 style="font-size:12px;text-transform:none;letter-spacing:0;color:var(--text-dim);margin:14px 0 6px;">Paid ('+paid.length+')</h3>'+
      (paidShown.length ? '<div class="field-list">'+paidShown.map(row).join('')+'</div>' : '<p style="font-size:12.5px;color:var(--text-faint);margin:0;">No payments recorded yet.</p>')+
      (paidExtra>0 ? '<p style="font-size:11.5px;color:var(--text-faint);margin:6px 0 0;">+'+paidExtra+' earlier paid periods not shown.</p>' : '')+
      '</div>';
  }

  function paymentDayLabel(t){
    if (t.rentFrequency==='monthly') return 'Day '+t.paymentDay+' of the month';
    var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    return days[t.paymentDay] || ('Day '+t.paymentDay);
  }
  function chargeStatusBadge(c){
    var map = { paid:['paid','Paid'], due:['due','Due Soon'], partially_paid:['due','Partially Paid'], overdue:['overdue','Overdue'], upcoming:['upcoming','Upcoming'] };
    var m = map[c.status] || ['neutral', c.status];
    return badge(m[0], m[1]);
  }
  /** A bill's effective status: if it's still pending and its due date has already passed, it shows as overdue. */
  function billEffectiveStatus(b){
    if (b.status === 'paid') return 'paid';
    if (b.dueDate && b.dueDate < TODAY) return 'overdue';
    return b.status;
  }
  /**
   * Amount of a bill that has actually been collected: if it has allocations,
   * the sum of the shares marked as paid (supports partial payment); if
   * it has no allocations, the full amount only if the whole bill is
   * marked 'paid' by hand (legacy behavior — without allocations there's
   * nothing more granular to show).
   */
  function billPaidAmount(b){
    if (b.allocations && b.allocations.length){
      return round2(b.allocations.filter(function(a){ return a.paid; }).reduce(function(s,a){ return s+a.amount; }, 0));
    }
    return b.status === 'paid' ? b.amount : 0;
  }
  /** What's still owed on a bill (total amount minus what's already paid, never negative). */
  function billOutstandingAmount(b){
    return Math.max(0, round2(b.amount - billPaidAmount(b)));
  }
  function billStatusBadge(b){
    var map = { paid:['paid','Paid'], pending:['due','Pending'], overdue:['overdue','Overdue'], allocated:['upcoming','Allocated'],
      partially_allocated:['due','Partially Allocated'], partially_paid:['due','Partially Paid'] };
    var m = map[billEffectiveStatus(b)] || ['neutral', b.status];
    return badge(m[0], m[1]);
  }
  /** The "current" charge is the one that contains today; if there is none, the next future one; otherwise, the last past one. */
  function pickCurrentCharge(charges, asOfIso){
    var containing = charges.find(function(c){ return c.periodStart<=asOfIso && c.periodEnd>=asOfIso; });
    if (containing) return containing;
    var future = charges.filter(function(c){ return c.periodStart>asOfIso; })
      .sort(function(a,b){ return a.periodStart.localeCompare(b.periodStart); });
    if (future.length) return future[0];
    var past = charges.filter(function(c){ return c.periodEnd<asOfIso; })
      .sort(function(a,b){ return b.periodEnd.localeCompare(a.periodEnd); });
    return past[0];
  }

  var paymentsFilter = 'all';
  var paymentsTenantFilter = 'all';
  var paymentsPropertyFilter = 'all';
  var paymentsMonthFilter = TODAY.slice(0,7); // 'YYYY-MM', or 'all' — default = current month
  // 'active' (default) = today's normal view: active tenants + any moved-out tenant who still
  // owes something (never hidden while they owe). 'moved_out' = every moved-out tenant, settled
  // or not — a dedicated place to review who's left, since a settled one otherwise drops off
  // the default view entirely (see groupTenants below).
  var paymentsTenantStatusFilter = 'active';
  function setPaymentsMonthFilter(v){ paymentsMonthFilter = v; renderPreservingScroll(); }
  window.setPaymentsMonthFilter = setPaymentsMonthFilter;
  function setPaymentsTenantStatusFilter(v){ paymentsTenantStatusFilter = v; renderPreservingScroll(); }
  window.setPaymentsTenantStatusFilter = setPaymentsTenantStatusFilter;
  var paymentsDateSort = 'desc'; // 'desc' = most recent first, 'asc' = oldest first
  var PAYMENTS_FILTERS = [['all','All'], ['paid','Paid'], ['due','Due'], ['overdue','Overdue']];
  function setPaymentsFilter(f){ paymentsFilter = f; renderPreservingScroll(); }
  function setPaymentsTenantFilter(tenantId){ paymentsTenantFilter = tenantId; renderPreservingScroll(); }
  /** Picking a property no longer leaves the tenant filter pointing at someone from ANOTHER
   *  property — if the selected tenant doesn't live in the chosen property, it resets to "All". */
  function setPaymentsPropertyFilter(propertyId){
    paymentsPropertyFilter = propertyId;
    if (propertyId !== 'all' && paymentsTenantFilter !== 'all'){
      var t = tenantOf(paymentsTenantFilter);
      if (!t || t.propertyId !== propertyId) paymentsTenantFilter = 'all';
    }
    renderPreservingScroll();
  }
  function togglePaymentsDateSort(){ paymentsDateSort = paymentsDateSort==='desc' ? 'asc' : 'desc'; renderPreservingScroll(); }
  window.setPaymentsPropertyFilter = setPaymentsPropertyFilter;
  window.togglePaymentsDateSort = togglePaymentsDateSort;
  function chargeMatchesFilter(c, filter){
    if (filter==='paid') return c.status==='paid';
    if (filter==='overdue') return c.status==='overdue';
    if (filter==='due') return c.status==='due' || c.status==='partially_paid';
    return true; // 'all' — also includes 'upcoming', which has no chip of its own
  }

  /** True if the tenant owes nothing: no pending/overdue rent and no unpaid share of any
   *  bill — used to know whether it's "safe" to deactivate them without leaving a balance hanging. */
  function tenantOwesNothing(t){
    var owesRent = rentCharges.some(function(c){ return c.tenantId===t.id && c.remaining > 0.004; });
    if (owesRent) return false;
    return unpaidBillAllocationsFor(t.id).length === 0;
  }

  /** Each pending bill obligation of a tenant (to show it alongside their rent in Payments). */
  function unpaidBillAllocationsFor(tenantId){
    var out = [];
    bills.forEach(function(b){
      if (!b.allocations) return;
      b.allocations.forEach(function(a){
        if (a.tenantId===tenantId && !a.paid) out.push({ bill:b, alloc:a });
      });
    });
    return out.sort(function(x,y){ return (x.bill.dueDate||'').localeCompare(y.bill.dueDate||''); });
  }

  var PAYMENTS_ROW_LIMIT = 5; // how many rows are shown per block before sending to "View history"

  function renderPaymentsRentTab(){
    var propertyOptions = '<option value="all"'+(paymentsPropertyFilter==='all'?' selected':'')+'>All properties</option>'+
      properties.slice().sort(function(a,b){ return a.name.localeCompare(b.name); }).map(function(p){
        return '<option value="'+p.id+'"'+(paymentsPropertyFilter===p.id?' selected':'')+'>'+esc(p.name)+'</option>';
      }).join('');
    // With a property chosen, "All tenants" no longer lists everyone — only those who
    // live there, so a tenant from another property can't be selected (or confused with).
    var tenantPool = paymentsPropertyFilter==='all' ? tenants : tenants.filter(function(t){ return t.propertyId===paymentsPropertyFilter; });
    var tenantOptions = '<option value="all"'+(paymentsTenantFilter==='all'?' selected':'')+'>All tenants</option>'+
      tenantPool.slice().sort(function(a,b){ return a.fullName.localeCompare(b.fullName); }).map(function(t){
        return '<option value="'+t.id+'"'+(paymentsTenantFilter===t.id?' selected':'')+'>'+esc(t.fullName)+'</option>';
      }).join('');
    var monthsPresent = Array.from(new Set(rentCharges.map(function(c){ return c.periodStart.slice(0,7); }))).sort().reverse();
    var monthOptionsHtml = '<option value="all"'+(paymentsMonthFilter==='all'?' selected':'')+'>All months</option>'+
      monthsPresent.map(function(m){
        var label = CALENDAR_MONTH_NAMES[parseInt(m.slice(5,7),10)-1] + ' ' + m.slice(0,4);
        return '<option value="'+m+'"'+(paymentsMonthFilter===m?' selected':'')+'>'+label+'</option>';
      }).join('');

    var tenantFilterHtml = '<div style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0;align-items:flex-end;">'+
      '<div style="flex:1;min-width:160px;">'+
      '<label style="font-size:11.5px;color:var(--text-faint);display:block;margin-bottom:4px;">Filter by property</label>'+
      '<select class="modal-input" onchange="setPaymentsPropertyFilter(this.value)">'+propertyOptions+'</select>'+
      '</div>'+
      '<div style="flex:1;min-width:160px;">'+
      '<label style="font-size:11.5px;color:var(--text-faint);display:block;margin-bottom:4px;">Filter by tenant</label>'+
      '<select class="modal-input" onchange="setPaymentsTenantFilter(this.value)">'+tenantOptions+'</select>'+
      '</div>'+
      '<div style="flex:1;min-width:160px;">'+
      '<label style="font-size:11.5px;color:var(--text-faint);display:block;margin-bottom:4px;">Filter by month</label>'+
      '<select class="modal-input" onchange="setPaymentsMonthFilter(this.value)">'+monthOptionsHtml+'</select>'+
      '</div>'+
      '<div style="flex:1;min-width:160px;">'+
      '<label style="font-size:11.5px;color:var(--text-faint);display:block;margin-bottom:4px;">Tenant status</label>'+
      '<select class="modal-input" onchange="setPaymentsTenantStatusFilter(this.value)">'+
      '<option value="active"'+(paymentsTenantStatusFilter==='active'?' selected':'')+'>Active</option>'+
      '<option value="moved_out"'+(paymentsTenantStatusFilter==='moved_out'?' selected':'')+'>Moved out</option>'+
      '</select>'+
      '</div>'+
      '<button type="button" class="mini-btn" style="flex:1;min-width:160px;" onclick="togglePaymentsDateSort()">Date: '+(paymentsDateSort==='desc'?'Newest first ▾':'Oldest first ▴')+'</button>'+
      '</div>';

    // Property + tenant scope when filtering rent charges — the 3 stats above (Expected/
    // Received/Outstanding) are computed AFTER this filter, so "All properties" still
    // sums the whole portfolio but choosing a property limits all 3 numbers to just that one.
    var charges = paymentsTenantFilter==='all' ? rentCharges : rentCharges.filter(function(c){ return c.tenantId===paymentsTenantFilter; });
    if (paymentsPropertyFilter !== 'all'){
      charges = charges.filter(function(c){ var t = tenantOf(c.tenantId); return t && t.propertyId === paymentsPropertyFilter; });
    }
    if (paymentsMonthFilter !== 'all'){
      charges = charges.filter(function(c){ return c.periodStart.slice(0,7) === paymentsMonthFilter; });
    }

    var expected = charges.reduce(function(s,c){ return s+c.amountDue; },0);
    var received = charges.reduce(function(s,c){ return s+c.amountPaid; },0);
    var outstanding = charges.reduce(function(s,c){ return s+c.remaining; },0);
    var statHtml = '<div class="stat-grid cols-3">'+
      '<div class="stat"><div class="label">Expected</div><div class="value">'+money(expected)+'</div></div>'+
      '<div class="stat"><div class="label">Received</div><div class="value">'+money(received)+'</div></div>'+
      '<div class="stat"><div class="label">Outstanding</div><div class="value'+(outstanding>0?' warn':'')+'">'+money(outstanding)+'</div></div>'+
      '</div>';

    var chipsHtml = '<div class="filter-chips">' + PAYMENTS_FILTERS.map(function(f){
      return '<button class="chip'+(paymentsFilter===f[0]?' active':'')+'" onclick="setPaymentsFilter(\''+f[0]+'\')">'+f[1]+'</button>';
    }).join('') + '</div>';

    var filtered = charges.filter(function(c){ return chargeMatchesFilter(c, paymentsFilter); });

    function sortByDate(list){
      return list.slice().sort(function(a,b){ return paymentsDateSort==='asc' ? a.periodStart.localeCompare(b.periodStart) : b.periodStart.localeCompare(a.periodStart); });
    }
    function pendingRow(c){
      return '<div class="field-row"><span class="k">'+shortDate(c.periodStart)+' – '+shortDate(c.periodEnd)+'</span>'+
        '<span class="v" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;">'+
        money(c.remaining)+chargeStatusBadge(c)+
        '<button class="mini-btn primary" style="padding:2px 8px;font-size:11px;" onclick="openChargePaidModal(\''+c.id+'\')">Pay</button>'+
        '<button class="mini-btn" style="padding:2px 8px;font-size:11px;" onclick="openPartialModal(\''+c.id+'\')">Partial</button>'+
        '</span></div>';
    }
    function paidRow(c){
      var paidNote = c.paidDate ? ' <span style="color:var(--text-faint);">(paid '+shortDate(c.paidDate)+')</span>' : '';
      return '<div class="field-row"><span class="k">'+shortDate(c.periodStart)+' – '+shortDate(c.periodEnd)+paidNote+'</span>'+
        '<span class="v">'+money(c.amountDue)+'</span></div>';
    }
    function billOwedRow(o){
      var b = o.bill, a = o.alloc;
      var overdue = b.dueDate && b.dueDate < TODAY;
      return '<div class="alloc-summary-row" style="align-items:center;flex-wrap:wrap;">'+
        '<div class="who"><div>'+esc(billTypeLabel(b.billType))+' — '+esc(b.provider)+'</div><div class="meta">'+(b.dueDate?('Due '+shortDate(b.dueDate)):'No due date')+'</div></div>'+
        '<div style="display:flex;align-items:center;gap:10px;">'+
        (overdue ? badge('overdue','Overdue') : badge('due','Unpaid'))+
        '<b>'+money(a.amount)+'</b>'+
        '<button class="mini-btn primary" onclick="openAllocPaidModal(\''+b.id+'\',\''+o.tenant.id+'\')">Mark as paid</button>'+
        '</div></div>';
    }
    /** Everything still PENDING (owed/due) is shown in full, never truncated —
     *  something the tenant still owes is never sent off to "history". */
    function fullSection(list, rowFn, emptyText){
      if (!list.length) return '<p style="font-size:12.5px;color:var(--text-faint);margin:0;">'+emptyText+'</p>';
      return '<div class="field-list">'+list.map(rowFn).join('')+'</div>';
    }
    /** The "Due" section, with one addition over fullSection: when there's nothing pending
     *  (every generated period — including the single future one rentService always keeps
     *  one period ahead — has already been paid), it still names that next period instead of
     *  just saying "nothing due". Without this, a tenant who happens to be paid in advance
     *  shows no "Upcoming" line at all, while one who isn't paid that far ahead still has an
     *  unpaid future period to show — which looked like an inconsistency between tenants,
     *  but was really just "already paid ahead" vs "not yet". */
    /** `upcomingCharges` is the tenant's next N generated periods (paid ahead) — one for
     *  fortnightly/monthly, two for weekly, matching how far ahead rentService itself looks
     *  (futureLookahead) — so a weekly tenant who's paid ahead sees both of their next two
     *  upcoming weeks listed here, not just the first one. */
    function dueSectionHtml(list, upcomingCharges){
      if (list.length) return '<div class="field-list">'+list.map(pendingRow).join('')+'</div>';
      if (!upcomingCharges || !upcomingCharges.length){
        return '<p style="font-size:12.5px;color:var(--text-faint);margin:0;">Nothing due right now.</p>';
      }
      var lines = upcomingCharges.map(function(c){
        return shortDate(c.periodStart)+' – '+shortDate(c.periodEnd)+' · '+money(c.amountDue)+' (due '+shortDate(c.dueDate)+' — already paid)';
      });
      var note = 'Nothing due right now. ' + (lines.length > 1 ? 'Next ' + lines.length + ': ' : 'Next: ') + lines.join('; ');
      return '<p style="font-size:12.5px;color:var(--text-faint);margin:0;">'+note+'</p>';
    }
    /** Trims a list to the first N and, if more remain, adds a note + the link that
     *  opens the full history — used ONLY for things already paid/resolved (never for
     *  pending items, which are always shown in full via fullSection). */
    function limitedSection(list, rowFn, emptyText, moreLabel, tenantId){
      if (!list.length) return '<p style="font-size:12.5px;color:var(--text-faint);margin:0;">'+emptyText+'</p>';
      var shown = list.slice(0, PAYMENTS_ROW_LIMIT);
      var html = '<div class="field-list">'+shown.map(rowFn).join('')+'</div>';
      if (list.length > PAYMENTS_ROW_LIMIT){
        html += '<button class="text-link" style="margin-top:4px;" onclick="openHistoryModal(\''+tenantId+'\')">'+moreLabel+' ('+(list.length-PAYMENTS_ROW_LIMIT)+' more) — view history</button>';
      }
      return html;
    }

    // Grouped by tenant — three fixed blocks per tenant ("Due" / "Paid" / "Bills") instead
    // of a separate card for every week or a separate Bills tab.
    function tenantOwesSomething(t){
      return rentCharges.some(function(c){ return c.tenantId===t.id && c.status!=='paid'; }) ||
        unpaidBillAllocationsFor(t.id).length > 0;
    }
    // A tenant who wasn't renting yet (or already had no charges) in the selected month has
    // nothing to show there — without this, picking a month before a tenant's move-in still
    // showed their card, with a "next period" note pointing at some unrelated, out-of-scope
    // month, which read as if they'd been registered for a month they never lived in.
    function tenantHasAnythingInMonth(t, monthStr){
      if (rentCharges.some(function(c){ return c.tenantId===t.id && c.periodStart.slice(0,7)===monthStr; })) return true;
      return unpaidBillAllocationsFor(t.id).some(function(o){ return o.bill.dueDate && o.bill.dueDate.slice(0,7)===monthStr; });
    }
    // A tenant who's moved out (or been deactivated) and is fully settled has nothing left to
    // track here, so they drop off the default ("Active") view entirely — only kept around
    // while they still owe rent or a bill. A currently-active tenant always stays, even with
    // zero charges yet, so the admin can see them (and their next upcoming period, added below)
    // from day one. The "Moved out" status filter is the dedicated place to review every
    // moved-out tenant, settled or not, since the default view otherwise hides a settled one.
    // Picking a specific tenant from the dropdown always shows that one — unless a month filter
    // is also active and they have nothing that month, in which case the month wins (see above).
    var groupTenants = (paymentsPropertyFilter==='all' ? tenants : tenantPool).filter(function(t){
        if (paymentsMonthFilter !== 'all' && !tenantHasAnythingInMonth(t, paymentsMonthFilter)) return false;
        if (paymentsTenantFilter !== 'all') return paymentsTenantFilter === t.id;
        if (paymentsTenantStatusFilter === 'moved_out') return tenantHasMovedOut(t);
        return !tenantHasMovedOut(t) || tenantOwesSomething(t);
      })
      .sort(function(a,b){ return a.fullName.localeCompare(b.fullName); });

    var rows = groupTenants.length===0
      ? (rentCharges.length===0
          ? emptyState('payments', 'No rent charges yet',
              'Add a tenant with a rent amount and charges will show up here automatically.',
              '<a class="mini-btn primary" href="#/tenants" style="display:inline-block;">Go to tenants</a>')
          : emptyState('payments', 'Nothing in this filter', 'Try a different filter, or choose "All" to see every charge.', ''))
      : groupTenants.map(function(t){
          var tCharges = filtered.filter(function(c){ return c.tenantId===t.id; });
          var pending = sortByDate(tCharges.filter(function(c){ return c.status!=='paid'; }));
          var paid = sortByDate(tCharges.filter(function(c){ return c.status==='paid'; }));
          var owedBills = unpaidBillAllocationsFor(t.id).map(function(o){ return { tenant:t, bill:o.bill, alloc:o.alloc }; });
          var prop = properties.find(function(p){ return p.id===t.propertyId; });
          var pendingTotal = pending.reduce(function(s,c){ return s+c.remaining; }, 0);
          var billsTotal = owedBills.reduce(function(s,o){ return s+o.alloc.amount; }, 0);
          // rentCharges (unfiltered by the chip/date-sort above) is sorted most-future-first,
          // so the tenant's first match here is always their next period — paid or not —
          // regardless of which filter chip is currently selected. Only meaningful for a
          // tenant who's still active; a moved-out tenant kept on the list because they owe
          // a bill has no real "next period" — their last generated charge is history, not
          // upcoming — so it's left out for them.
          var allTenantCharges = rentCharges.filter(function(c){ return c.tenantId===t.id; });
          var upcomingCount = t.rentFrequency === 'weekly' ? 2 : 1;
          // allTenantCharges is sorted most-future-first (see recomputeRentCharges), so the
          // first `upcomingCount` entries are the tenant's next period(s) — reversed here so
          // they display in chronological order (earliest upcoming period first).
          // Suppressed entirely while a specific month is selected — the "Next: ..." note points
          // at whatever period is actually next for the tenant, which can be a different month
          // than the one being viewed, and reads as an out-of-scope non-sequitur there.
          var upcomingCharges = (paymentsMonthFilter==='all' && !tenantHasMovedOut(t) && allTenantCharges.length) ? allTenantCharges.slice(0, upcomingCount).reverse() : [];
          return '<div class="card">'+
            '<div class="detail-head" style="margin-top:0;"><h2 style="margin:0;font-size:14px;">'+esc(t.fullName)+
            (prop?' <span style="font-weight:400;color:var(--text-faint);font-size:11.5px;">· '+esc(prop.name)+'</span>':'')+'</h2></div>'+
            '<h3 style="font-size:12px;text-transform:none;letter-spacing:0;color:var(--text-dim);margin:8px 0 6px;">Due ('+pending.length+') · '+money(pendingTotal)+'</h3>'+
            dueSectionHtml(pending, upcomingCharges)+
            '<h3 style="font-size:12px;text-transform:none;letter-spacing:0;color:var(--text-dim);margin:14px 0 6px;">Paid ('+paid.length+')</h3>'+
            limitedSection(paid, paidRow, 'No payments recorded yet.', 'Paid', t.id)+
            '<h3 style="font-size:12px;text-transform:none;letter-spacing:0;color:var(--text-dim);margin:14px 0 6px;">Bills ('+owedBills.length+') · '+money(billsTotal)+'</h3>'+
            fullSection(owedBills, billOwedRow, 'Nothing owed on bills right now.')+
            '<button class="text-link" onclick="openHistoryModal(\''+t.id+'\')">View history</button>'+
            '</div>';
        }).join('');

    return statHtml + chipsHtml + tenantFilterHtml + rows;
  }

  function renderPayments(){
    return pageHeader('Payments', "What tenants owe on rent and shared bills, what they've paid, and what's outstanding.") + renderPaymentsRentTab();
  }

  var billsFilter = 'all';
  var billsPropertyFilter = 'all';
  var BILLS_FILTERS = [['all','All'], ['pending','Pending'], ['overdue','Overdue'], ['partially_paid','Partially Paid'], ['paid','Paid']];
  function setBillsFilter(f){ billsFilter = f; renderPreservingScroll(); }
  function setBillsPropertyFilter(propertyId){ billsPropertyFilter = propertyId; renderPreservingScroll(); }
  function billMatchesFilter(b, filter){
    if (filter==='all') return true;
    return billEffectiveStatus(b) === filter;
  }

  /* ---------- Import bill (PHASE 7: capture UI only; OCR comes later) ---------- */
  var importQueue = [];
  var pendingImportFile = null;

  function triggerImportInput(kind){
    var inputId = kind==='camera' ? 'import-input-camera' : kind==='gallery' ? 'import-input-gallery' : 'import-input-pdf';
    document.getElementById(inputId).click();
  }
  function handleImportFile(evt){
    var file = evt.target.files && evt.target.files[0];
    evt.target.value = ''; // allows the same file to be picked again later
    if (!file) return;
    if (pendingImportFile && pendingImportFile.previewUrl) URL.revokeObjectURL(pendingImportFile.previewUrl);
    var isImage = file.type.indexOf('image/') === 0;
    pendingImportFile = {
      fileName: file.name || (isImage ? 'photo.jpg' : 'document.pdf'),
      kind: isImage ? 'image' : 'pdf',
      previewUrl: URL.createObjectURL(file),
      file: file // kept so the original bytes can be uploaded to the `receipts` bucket once the bill is saved
    };
    renderImportPreview();
  }
  function renderImportPreview(){
    var picker = document.getElementById('import-modal-picker');
    var preview = document.getElementById('import-modal-preview');
    var img = document.getElementById('import-preview-img');
    var fileChip = document.getElementById('import-preview-file');
    var nameEl = document.getElementById('import-preview-name');
    var confirmBtn = document.getElementById('import-modal-confirm');
    if (!pendingImportFile){
      picker.hidden = false; preview.hidden = true; confirmBtn.hidden = true;
      img.hidden = true; fileChip.hidden = true;
      return;
    }
    picker.hidden = true; preview.hidden = false; confirmBtn.hidden = false;
    if (pendingImportFile.kind === 'image'){
      img.src = pendingImportFile.previewUrl; img.hidden = false; fileChip.hidden = true;
    } else {
      img.hidden = true; fileChip.hidden = false;
    }
    nameEl.textContent = pendingImportFile.fileName;
  }
  function openImportModal(){
    pendingImportFile = null;
    document.getElementById('import-billtype').value = '';
    document.getElementById('import-account').value = '';
    document.getElementById('import-account-hint').hidden = true;
    refreshKnownAccountsDatalist();
    renderImportPreview();
    document.getElementById('import-modal').hidden = false;
  }
  function closeImportModal(){
    if (pendingImportFile && pendingImportFile.previewUrl) URL.revokeObjectURL(pendingImportFile.previewUrl);
    pendingImportFile = null;
    document.getElementById('import-modal').hidden = true;
  }
  function confirmImportBill(){
    if (!pendingImportFile) return;
    var billTypeHint = document.getElementById('import-billtype').value;
    var accountNumber = document.getElementById('import-account').value.trim();
    var knownAccount = findKnownAccount(accountNumber, billTypeHint);
    var item = {
      id: 'import-' + Date.now() + '-' + Math.round(Math.random()*1000),
      fileName: pendingImportFile.fileName,
      kind: pendingImportFile.kind,
      previewUrl: pendingImportFile.previewUrl,
      file: pendingImportFile.file,
      addedAt: TODAY,
      accountNumberHint: accountNumber, // used if the photo needs to be sent for analysis (see analyzeImportedFile)
      billTypeHint: billTypeHint,
      status: 'processing', // 'processing' -> 'ready' (with the data the AI returned, or blank if the analysis failed)
      extracted: null,
      aiError: null
    };
    if (knownAccount){
      // Account (+ service type) already known — no need to spend an AI call: the
      // property/type/provider fill in on their own and the user only has to enter the amount
      // and dates for this particular bill (those do change every time).
      item.status = 'ready';
      item.skippedAi = true;
      item.extracted = Object.assign({}, BLANK_EXTRACTED_BILL, {
        propertyId: knownAccount.propertyId,
        billType: knownAccount.billType,
        provider: knownAccount.provider,
        accountNumber: knownAccount.accountNumber
      });
    }
    importQueue.push(item);
    pendingImportFile = null;
    document.getElementById('import-modal').hidden = true;
    if (knownAccount){
      render();
      showToast('Recognized account — skipped the AI step. Just fill in the amount and dates.', 'success');
      openReviewModal(item.id);
    } else {
      render();
      analyzeImportedFile(item);
    }
  }
  var BLANK_EXTRACTED_BILL = { propertyId:'', billType:'other', provider:'', accountNumber:'', invoiceNumber:'', issueDate:'', dueDate:'', billingPeriodStart:'', billingPeriodEnd:'', amount:'' };

  /* ---------- Known accounts (PHASE: identify the bill by hand before spending an AI
   *  call) — every bill saved with an account number gets "remembered": the next time
   *  a bill arrives for that same account, the property/type/provider fill in on their own
   *  and there's no need to send the photo to the AI.
   *  The same account number can cover more than one service (e.g. Neogrids bills
   *  electricity AND hot water under the same account) — that's why the record is keyed by
   *  (account number + service type), not just by account number. ---------- */
  function normalizeAccountNumber(v){ return (v || '').trim().toLowerCase(); }
  /** { "<account>": { "<billType>": {accountNumber, propertyId, billType, provider}, ... }, ... }
   *  If there's more than one bill with the same account and type (the normal case), it keeps
   *  the most recent one by issue date. */
  function knownAccountsMap(){
    var map = {};
    bills.slice()
      .sort(function(a, b){ return (a.issueDate || '').localeCompare(b.issueDate || ''); })
      .forEach(function(b){
        var key = normalizeAccountNumber(b.accountNumber);
        if (!key) return;
        if (!map[key]) map[key] = {};
        map[key][b.billType] = { accountNumber: b.accountNumber, propertyId: b.propertyId, billType: b.billType, provider: b.provider };
      });
    return map;
  }
  /** With billType: returns the record only if that account+type matches exactly. Without
   *  billType: if the account only has one known service type, it returns it anyway (the
   *  common case); if it has more than one, it doesn't guess — the type needs to be specified. */
  function findKnownAccount(raw, billType){
    var key = normalizeAccountNumber(raw);
    if (!key) return null;
    var entry = knownAccountsMap()[key];
    if (!entry) return null;
    if (billType) return entry[billType] || null;
    var types = Object.keys(entry);
    return types.length === 1 ? entry[types[0]] : null;
  }
  /** Which service types exist for an account — used to warn when the account is
   *  recognized but the service type is needed to know which one it is. */
  function findKnownAccountTypes(raw){
    var key = normalizeAccountNumber(raw);
    var entry = key && knownAccountsMap()[key];
    return entry ? Object.keys(entry) : [];
  }
  function knownAccountLabel(entry){
    var propName = (properties.find(function(p){ return p.id===entry.propertyId; }) || {}).name || 'unknown property';
    return propName + ' · ' + billTypeLabel(entry.billType) + (entry.provider ? ' · ' + entry.provider : '');
  }
  function refreshKnownAccountsDatalist(){
    var list = document.getElementById('known-accounts-list');
    if (!list) return;
    var map = knownAccountsMap();
    var options = [];
    Object.keys(map).forEach(function(k){
      Object.keys(map[k]).forEach(function(t){
        var e = map[k][t];
        options.push('<option value="'+esc(e.accountNumber)+'">'+esc(knownAccountLabel(e))+'</option>');
      });
    });
    list.innerHTML = options.join('');
  }
  /** In the import modal: if what was typed (account + type, if given) matches an
   *  already known account, shows the notice that the AI won't be needed. If the account is
   *  recognized but covers more than one service, asks for the type instead of guessing. */
  function onImportAccountInput(){
    var val = document.getElementById('import-account').value;
    var billType = document.getElementById('import-billtype').value;
    var hint = document.getElementById('import-account-hint');
    var match = findKnownAccount(val, billType);
    if (match){
      hint.textContent = '✓ Matches a bill you already saved (' + knownAccountLabel(match) + '). No need to analyze the photo with AI — you\'ll just confirm the amount and dates.';
      hint.className = 'form-hint match';
      hint.hidden = false;
      return;
    }
    var knownTypes = findKnownAccountTypes(val);
    if (knownTypes.length){
      hint.textContent = 'This account is known for: ' + knownTypes.map(billTypeLabel).join(', ') + ' — pick the matching bill type above to skip the AI step.';
      hint.className = 'form-hint';
      hint.hidden = false;
    } else {
      hint.hidden = true;
    }
  }
  window.onImportAccountInput = onImportAccountInput;
  /** The same, but inside the review modal (manual entry, or to correct the account
   *  number after the AI has already analyzed the photo) — uses the service type already
   *  selected there to disambiguate, and only fills in property/provider (doesn't overwrite the chosen type). */
  function onReviewAccountInput(){
    var val = document.getElementById('review-account').value;
    var billType = document.getElementById('review-billtype').value;
    var hint = document.getElementById('review-account-hint');
    var match = findKnownAccount(val, billType);
    if (match){
      hint.textContent = '✓ Matches a bill you already saved (' + knownAccountLabel(match) + ') — property and provider filled in below.';
      hint.className = 'form-hint match';
      hint.hidden = false;
      document.getElementById('review-property').value = match.propertyId;
      document.getElementById('review-provider').value = match.provider;
      return;
    }
    var knownTypes = findKnownAccountTypes(val);
    if (knownTypes.length){
      hint.textContent = 'This account is known for: ' + knownTypes.map(billTypeLabel).join(', ') + ' — set the bill type above to match it.';
      hint.className = 'form-hint';
      hint.hidden = false;
    } else {
      hint.hidden = true;
    }
  }
  window.onReviewAccountInput = onReviewAccountInput;
  /** List of providers already used for the property selected in the review
   *  modal — so typing the provider shows relevant suggestions instead of the
   *  full list of every provider across every property. Refreshed every time
   *  the modal is opened and every time the property is changed inside it. */
  function refreshReviewProviderDatalist(){
    var list = document.getElementById('review-provider-list');
    if (!list) return;
    var propertyId = document.getElementById('review-property').value;
    var seen = {};
    var options = [];
    bills.slice()
      .sort(function(a,b){ return (b.issueDate||'').localeCompare(a.issueDate||''); })
      .forEach(function(b){
        if (propertyId && b.propertyId !== propertyId) return;
        var key = (b.provider||'').trim().toLowerCase();
        if (!key || seen[key]) return;
        seen[key] = true;
        options.push('<option value="'+esc(b.provider)+'">'+esc(billTypeLabel(b.billType))+'</option>');
      });
    list.innerHTML = options.join('');
  }
  /** When the property changes in the review modal, the suggested providers list
   *  is limited to those already used in THAT property. */
  function onReviewPropertyChange(){
    refreshReviewProviderDatalist();
  }
  window.onReviewPropertyChange = onReviewPropertyChange;
  /** When typing/choosing an already known provider (for this property, or for any if none
   *  has been loaded here yet), fills in the service type, account number and amount
   *  with the last thing loaded for that provider — the user only confirms or corrects, without
   *  having to type everything again. Never overwrites a field the user already filled in by hand. */
  function onReviewProviderInput(){
    var provider = document.getElementById('review-provider').value.trim();
    if (!provider) return;
    var propertyId = document.getElementById('review-property').value;
    var normProvider = provider.toLowerCase();
    var candidates = bills.filter(function(b){ return (b.provider||'').trim().toLowerCase() === normProvider; });
    if (!candidates.length) return;
    var sameProperty = candidates.filter(function(b){ return b.propertyId === propertyId; });
    var pool = (sameProperty.length ? sameProperty : candidates)
      .slice().sort(function(a,b){ return (b.issueDate||'').localeCompare(a.issueDate||''); });
    var match = pool[0];
    var billTypeEl = document.getElementById('review-billtype');
    var accountEl = document.getElementById('review-account');
    var amountEl = document.getElementById('review-amount');
    if (billTypeEl && (!billTypeEl.value || billTypeEl.value === 'other')) billTypeEl.value = match.billType;
    if (accountEl && !accountEl.value && match.accountNumber) accountEl.value = match.accountNumber;
    if (amountEl && !amountEl.value && match.amount) amountEl.value = match.amount;
  }
  window.onReviewProviderInput = onReviewProviderInput;
  var BILL_TYPES = ['electricity','water','hot_water','gas','internet','other'];
  var BILL_TYPE_LABELS = { electricity:'Electricity', water:'Water', hot_water:'Hot water', gas:'Gas', internet:'Internet', other:'Other' };
  function billTypeLabel(t){ return BILL_TYPE_LABELS[t] || (t ? t.charAt(0).toUpperCase()+t.slice(1) : ''); }
  /** Sends the photo/PDF to the AI (Gemini, via the analyze-bill Edge Function) to extract
   *  provider, service type, dates, amount and a suggested property. If the analysis
   *  fails (no network, no API key configured server-side, unclear photo, etc.) the
   *  item still ends up ready to review with blank fields, to be filled in by hand
   *  instead of getting stuck. */
  async function analyzeImportedFile(item){
    try {
      var data = await aiService.analyzeBill(item.file, properties, TODAY);
      var current = importQueue.find(function(i){ return i.id===item.id; });
      if (!current) return; // it was removed from the queue while being analyzed
      current.status = 'ready';
      var issueDate = data.issueDate || '';
      var dueDate = data.dueDate || '';
      var dueDateWasGuessed = false;
      if (!dueDate && issueDate){
        // The receipt didn't have (or the AI couldn't find) a legible payment due date —
        // it's assumed to be 10 business days after the issue date instead of leaving it blank.
        dueDate = addBusinessDays(issueDate, 10);
        dueDateWasGuessed = true;
      }
      current.extracted = {
        propertyId: data.propertyId || '',
        billType: item.billTypeHint || (BILL_TYPES.indexOf(data.billType) >= 0 ? data.billType : 'other'),
        provider: data.provider || '',
        accountNumber: (item.accountNumberHint || data.accountNumber || '').trim(),
        invoiceNumber: data.invoiceNumber || '',
        issueDate: issueDate,
        dueDate: dueDate,
        billingPeriodStart: data.billingPeriodStart || '',
        billingPeriodEnd: data.billingPeriodEnd || '',
        amount: isFinite(parseFloat(data.amount)) ? parseFloat(data.amount) : ''
      };
      if (!data.propertyId && data.propertyGuessText){
        showToast('AI couldn\'t confidently match a property — it found "'+data.propertyGuessText+'" on the bill. Pick the property manually when reviewing.', 'info');
      }
      if (dueDateWasGuessed){
        showToast('No due date found on the bill — set to 10 business days after the issue date. Check it before saving.', 'info');
      }
      render();
    } catch(err){
      var current2 = importQueue.find(function(i){ return i.id===item.id; });
      if (!current2) return; // it was removed from the queue while being analyzed
      current2.status = 'ready';
      current2.aiError = friendlyErrorMessage(err);
      current2.extracted = Object.assign({}, BLANK_EXTRACTED_BILL, { accountNumber: item.accountNumberHint || '', billType: item.billTypeHint || 'other' });
      showToast('AI analysis failed — you can still fill in the details by hand. ' + current2.aiError, 'error');
      render();
    }
  }
  function removeImportQueueItem(id){
    var item = importQueue.find(function(i){ return i.id===id; });
    if (item && item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    importQueue = importQueue.filter(function(i){ return i.id!==id; });
    render();
  }
  function importQueueCard(){
    if (importQueue.length === 0) return '';
    var rows = importQueue.map(function(item){
      var statusBit = item.status === 'ready'
        ? (item.aiError ? badge('due', 'Needs manual entry') : item.skippedAi ? badge('paid', 'Recognized — no AI needed') : badge('upcoming', 'Ready to review'))
        : badge('neutral', 'Analyzing with AI…');
      var actionBtn = item.status === 'ready'
        ? '<button class="mini-btn primary" onclick="openReviewModal(\''+item.id+'\')">Review</button>'
        : '';
      return '<div class="row" style="border:none;padding:8px 0;">'+
        '<div class="who"><div class="name">'+esc(item.fileName)+'</div>'+
        '<div class="meta">added '+shortDate(item.addedAt)+(item.aiError?(' • '+esc(item.aiError)):'')+'</div></div>'+
        '<div style="display:flex;align-items:center;gap:8px;">'+statusBit+actionBtn+
        '<button class="del" title="Remove" onclick="removeImportQueueItem(\''+item.id+'\')">✕</button></div></div>';
    }).join('');
    return '<div class="card"><h2>Pending review ('+importQueue.length+')</h2>'+
      '<p style="font-size:12.5px;color:var(--text-dim);margin:0 0 4px;">AI reads the provider, property, dates and amount from each bill automatically — check them before saving.</p>'+
      rows+'</div>';
  }

  /** Looks for an already saved bill that is likely the same one about to be saved:
   *  same invoice number (if both have one), or same provider + property + billing
   *  period. Used to warn before saving a bill duplicated by mistake (e.g. uploading
   *  the same photo twice, or re-scanning a receipt that had already been loaded). */
  function findDuplicateBill(propertyId, provider, invoiceNumber, periodStart, periodEnd, accountNumber){
    var providerNorm = (provider || '').trim().toLowerCase();
    var invoiceNorm = (invoiceNumber || '').trim().toLowerCase();
    var accountNorm = normalizeAccountNumber(accountNumber);
    return bills.find(function(b){
      if (b.propertyId !== propertyId) return false;
      if (invoiceNorm && b.invoiceNumber && b.invoiceNumber.trim().toLowerCase() === invoiceNorm) return true;
      if (accountNorm && normalizeAccountNumber(b.accountNumber) === accountNorm &&
        b.billingPeriodStart === periodStart && b.billingPeriodEnd === periodEnd) return true;
      var bProviderNorm = (b.provider || '').trim().toLowerCase();
      return bProviderNorm === providerNorm && bProviderNorm !== '' &&
        b.billingPeriodStart === periodStart && b.billingPeriodEnd === periodEnd;
    });
  }

  /* ---------- Review extracted data (review/edit before confirming) ---------- */
  var reviewItemId = null;
  var reviewDuplicateOverride = false; // true once the user confirms "Save anyway" on a possible duplicate
  var editingBillId = null; // set while #review-modal is being reused to EDIT an existing bill instead of importing a new one
  function openReviewModal(itemId){
    var item = importQueue.find(function(i){ return i.id===itemId; });
    if (!item || !item.extracted) return;
    reviewItemId = itemId;
    reviewDuplicateOverride = false;
    var saveBtnReset = document.querySelector('#review-modal .mini-btn.primary');
    if (saveBtnReset) saveBtnReset.textContent = 'Save bill';
    var d = item.extracted;
    document.getElementById('review-property').value = d.propertyId;
    document.getElementById('review-billtype').value = d.billType;
    document.getElementById('review-provider').value = d.provider;
    document.getElementById('review-account').value = d.accountNumber || '';
    document.getElementById('review-account-hint').hidden = true;
    document.getElementById('review-invoice').value = d.invoiceNumber;
    document.getElementById('review-issue').value = d.issueDate;
    document.getElementById('review-due').value = d.dueDate;
    document.getElementById('review-period-start').value = d.billingPeriodStart;
    document.getElementById('review-period-end').value = d.billingPeriodEnd;
    document.getElementById('review-amount').value = d.amount;
    document.getElementById('review-recurring').checked = false;
    document.getElementById('review-recurring-day').value = '';
    document.getElementById('review-recurring-day-row').hidden = true;
    document.getElementById('review-recurring-existing-hint').hidden = true;
    document.getElementById('review-modal-error').hidden = true;
    refreshKnownAccountsDatalist();
    refreshReviewProviderDatalist();
    document.getElementById('review-modal').hidden = false;
  }
  function closeReviewModal(){
    reviewItemId = null;
    reviewDuplicateOverride = false;
    editingBillId = null;
    document.getElementById('review-modal-title').textContent = 'Review extracted data';
    document.getElementById('review-modal-sub').textContent = 'Check and correct what the automatic analysis detected before saving this bill.';
    document.getElementById('review-discard-btn').hidden = false;
    document.getElementById('review-recurring-row').hidden = false;
    document.getElementById('review-recurring').disabled = false;
    document.getElementById('review-recurring-existing-hint').textContent = 'This provider already repeats automatically every month for this property — that won\'t be duplicated.';
    document.getElementById('review-modal').hidden = true;
  }
  /** Reopens the same "Review extracted data" modal but pre-loaded with an already saved bill,
   *  so a wrongly entered value (provider, dates, amount, etc.) can be corrected without having
   *  to delete the bill and create it again. Doesn't touch the allocations — if the amount or
   *  period change in a meaningful way, the admin can use "Re-allocate" to recalculate each
   *  tenant's share separately. */
  function openEditBillModal(billId){
    var b = billOf(billId);
    if (!b) return;
    reviewItemId = null;
    reviewDuplicateOverride = false;
    editingBillId = billId;
    var saveBtnEl = document.querySelector('#review-modal .mini-btn.primary');
    if (saveBtnEl) saveBtnEl.textContent = 'Save changes';
    document.getElementById('review-modal-title').textContent = 'Edit bill';
    document.getElementById('review-modal-sub').textContent = 'Update the details for this bill.';
    document.getElementById('review-discard-btn').hidden = true;
    document.getElementById('review-property').value = b.propertyId;
    document.getElementById('review-billtype').value = b.billType;
    document.getElementById('review-provider').value = b.provider;
    document.getElementById('review-account').value = b.accountNumber || '';
    document.getElementById('review-account-hint').hidden = true;
    document.getElementById('review-invoice').value = b.invoiceNumber || '';
    document.getElementById('review-issue').value = b.issueDate || '';
    document.getElementById('review-due').value = b.dueDate || '';
    document.getElementById('review-period-start').value = b.billingPeriodStart || '';
    document.getElementById('review-period-end').value = b.billingPeriodEnd || '';
    document.getElementById('review-amount').value = b.amount;
    document.getElementById('review-recurring-row').hidden = false;
    var recurringCheckbox = document.getElementById('review-recurring');
    var recurringHint = document.getElementById('review-recurring-existing-hint');
    var dayRow = document.getElementById('review-recurring-day-row');
    var dayField = document.getElementById('review-recurring-day');
    var existingTpl = findActiveRecurringTemplate(b.propertyId, b.provider, b.billType);
    recurringCheckbox.disabled = false;
    dayField.value = '';
    if (existingTpl){
      recurringCheckbox.checked = true;
      recurringCheckbox.disabled = true;
      dayRow.hidden = true;
      recurringHint.hidden = false;
      recurringHint.textContent = 'This provider already repeats automatically every month for this property (next: '+shortDate(existingTpl.nextDueDate)+'). Manage it from "Recurring bills" instead.';
    } else {
      recurringCheckbox.checked = false;
      dayRow.hidden = true;
      recurringHint.hidden = true;
      recurringHint.textContent = 'This provider already repeats automatically every month for this property — that won\'t be duplicated.';
    }
    document.getElementById('review-modal-error').hidden = true;
    refreshKnownAccountsDatalist();
    refreshReviewProviderDatalist();
    document.getElementById('review-modal').hidden = false;
  }
  window.openEditBillModal = openEditBillModal;
  /** Saves changes to an existing bill edited from openEditBillModal — unlike
   *  confirmReviewedBill (which creates a new bill from the import queue), this only
   *  updates the fields of the already saved bill; it doesn't touch its allocations or create recurring bills. */
  var pendingBillEdit = null; // {billId, updated, makeRecurring, billingDay} waiting for Accept/Reject in #bill-changes-modal
  var BILL_EDIT_FIELDS = [
    ['propertyId', 'Property'], ['billType', 'Bill type'], ['provider', 'Provider'],
    ['accountNumber', 'Account number'], ['invoiceNumber', 'Invoice number'],
    ['issueDate', 'Issue date'], ['dueDate', 'Due date'],
    ['billingPeriodStart', 'Period start'], ['billingPeriodEnd', 'Period end'], ['amount', 'Amount']
  ];
  function billEditFieldText(key, v){
    if (v === null || v === undefined || v === '') return '—';
    if (key === 'amount') return money(v);
    if (key === 'propertyId'){ var pr = properties.find(function(x){ return x.id===v; }); return pr ? pr.name : v; }
    if (/Date$|^billingPeriod/.test(key)) return shortDate(v);
    return String(v);
  }
  /** Step 1 of editing a bill: validates the form, lists every value that differs from the saved
   *  bill (old → new) and asks the admin to Accept or Reject before anything is written. Nothing
   *  is saved with no changes. Payments already recorded are never touched by an edit. */
  async function saveEditedBill(){
    var provider = document.getElementById('review-provider').value.trim();
    var accountNumber = document.getElementById('review-account').value.trim();
    var invoiceNumber = document.getElementById('review-invoice').value.trim();
    var issueDate = document.getElementById('review-issue').value;
    var dueDate = document.getElementById('review-due').value;
    var periodStart = document.getElementById('review-period-start').value;
    var periodEnd = document.getElementById('review-period-end').value;
    var amount = parseFloat(document.getElementById('review-amount').value);
    var errorEl = document.getElementById('review-modal-error');

    if (!provider || !issueDate || !dueDate || !periodStart || !periodEnd || !isFinite(amount) || amount <= 0){
      errorEl.textContent = 'Add a provider, both dates and a valid amount before saving.';
      errorEl.hidden = false;
      return;
    }

    var b = billOf(editingBillId);
    if (!b){ closeReviewModal(); return; }
    var newAmount = Math.round(amount*100)/100;
    var amountChanged = newAmount !== round2(b.amount);
    var periodChanged = periodStart !== b.billingPeriodStart || periodEnd !== b.billingPeriodEnd;

    var updated = Object.assign({}, b, {
      propertyId: document.getElementById('review-property').value,
      billType: document.getElementById('review-billtype').value,
      provider: provider,
      accountNumber: accountNumber,
      invoiceNumber: invoiceNumber,
      issueDate: issueDate,
      dueDate: dueDate,
      billingPeriodStart: periodStart,
      billingPeriodEnd: periodEnd,
      amount: newAmount
    });

    var recurringCheckbox = document.getElementById('review-recurring');
    var makeRecurring = recurringCheckbox.checked && !recurringCheckbox.disabled;
    var billingDay = parseInt(document.getElementById('review-recurring-day').value, 10);

    var changes = BILL_EDIT_FIELDS.filter(function(f){
      var a = b[f[0]], c = updated[f[0]];
      if (f[0]==='amount') return round2(a) !== round2(c);
      return (a || '') !== (c || '');
    });
    if (!changes.length && !makeRecurring){
      closeReviewModal();
      showToast('No changes to save.', 'info');
      return;
    }
    errorEl.hidden = true;
    pendingBillEdit = { billId: editingBillId, updated: updated, makeRecurring: makeRecurring, billingDay: billingDay, amountChanged: amountChanged, periodChanged: periodChanged };

    var rowsHtml = changes.map(function(f){
      var isAmount = f[0]==='amount';
      var diffHtml = '';
      if (isAmount){
        var d = round2(updated.amount - b.amount);
        diffHtml = '<div class="chg-diff '+(d>0?'up':'down')+'">'+(d>0?'+':'−')+money(Math.abs(d))+'</div>';
      }
      return '<div class="chg-row'+(isAmount?' amount':'')+'"><div class="chg-label">'+esc(f[1])+'</div>'+
        '<div class="chg-vals"><span class="chg-old">'+esc(billEditFieldText(f[0], b[f[0]]))+'</span>'+
        '<span class="chg-arrow">→</span><span class="chg-new">'+esc(billEditFieldText(f[0], updated[f[0]]))+'</span></div>'+diffHtml+'</div>';
    }).join('');
    if (!changes.length) rowsHtml = '<p style="font-size:13px;color:var(--text-dim);margin:0;">No field changes — only the monthly repeat will be set up.</p>';

    var paidAllocs = (b.allocations || []).filter(function(a){ return a.paid && !a.isAdmin && round2(a.amount) > 0.004; });
    var paidHtml = '';
    if (paidAllocs.length){
      paidHtml = '<div class="chg-note">✅ Payments already recorded are kept: '+
        paidAllocs.map(function(a){ var t = tenantOf(a.tenantId); return '<b>'+esc(t?t.fullName:'Tenant')+'</b> ('+money(a.amount)+')'; }).join(', ')+'.</div>';
    }
    if (amountChanged || periodChanged){
      paidHtml += '<div class="chg-note warn">⚠️ The '+(amountChanged?'amount':'billing period')+' changed. Tenant shares are not recalculated automatically — use "Re-allocate" on the bill afterwards if they should change (people who already paid stay marked as paid).</div>';
    }
    document.getElementById('bill-changes-sub').textContent = b.provider + ' • ' + (changes.length ? (changes.length===1 ? '1 change' : changes.length+' changes') : 'no field changes');
    document.getElementById('bill-changes-list').innerHTML = rowsHtml + paidHtml;
    document.getElementById('bill-changes-error').hidden = true;
    document.getElementById('bill-changes-modal').hidden = false;
  }
  window.saveEditedBill = saveEditedBill;

  /** Back to the edit form without saving or discarding — the admin can keep adjusting. */
  function backToBillEdit(){
    document.getElementById('bill-changes-modal').hidden = true;
    pendingBillEdit = null;
  }
  window.backToBillEdit = backToBillEdit;
  /** Reject: throws the edits away; the bill stays exactly as it was. */
  function rejectBillChanges(){
    document.getElementById('bill-changes-modal').hidden = true;
    pendingBillEdit = null;
    closeReviewModal();
    showToast('Changes rejected — the bill was left as it was.', 'info');
  }
  window.rejectBillChanges = rejectBillChanges;

  /** Accept: writes the edited fields. The bill object in memory is updated IN PLACE so its
   *  `allocations` (who owes what, who already paid, receipts) survive — the DB row returned by
   *  billService.update doesn't carry them, and replacing the object with it is what used to make
   *  paid tenants disappear (and later get wiped by ensureBillAllocated). */
  async function acceptBillChanges(){
    if (!pendingBillEdit) return;
    var pe = pendingBillEdit;
    var b = billOf(pe.billId);
    var errorEl = document.getElementById('bill-changes-error');
    if (!b){ backToBillEdit(); closeReviewModal(); return; }
    var updated = pe.updated, makeRecurring = pe.makeRecurring, billingDay = pe.billingDay;
    var amountChanged = pe.amountChanged, periodChanged = pe.periodChanged;
    var oldAmount = b.amount;
    var saveBtn = document.getElementById('bill-changes-accept-btn');
    var originalLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    errorEl.hidden = true;
    try {
      var keepAllocations = b.allocations;
      var savedRow = await billService.update(pe.billId, updated);
      Object.assign(b, savedRow);
      b.allocations = keepAllocations;
      var saved = b;

      var recurringMsg = '';
      if (makeRecurring){
        if (findActiveRecurringTemplate(saved.propertyId, saved.provider, saved.billType)){
          recurringMsg = ' This provider already repeats automatically for this property, so a duplicate monthly repeat wasn\'t created.';
        } else if (isFinite(billingDay) && billingDay >= 1 && billingDay <= 28){
          try {
            var tpl = await recurringBillService.create({
              propertyId: saved.propertyId,
              billType: saved.billType,
              provider: saved.provider,
              amount: saved.amount,
              billingDay: billingDay,
              nextDueDate: addMonthsIso(saved.dueDate, 1),
              isActive: true,
              notes: 'Auto-generated from an edited bill.'
            });
            recurringBills.push(tpl);
            recurringMsg = ' It will now repeat automatically every month.';
          } catch(tplErr){
            recurringMsg = ' The bill was saved, but the recurring template failed to save: ' + friendlyErrorMessage(tplErr);
          }
        } else {
          recurringMsg = ' Add a billing day (1–28) to make it repeat automatically.';
        }
      }

      pendingBillEdit = null;
      document.getElementById('bill-changes-modal').hidden = true;
      closeReviewModal();
      render();
      showToast(
        'Changes accepted.' +
        (amountChanged ? ' Amount: '+money(oldAmount)+' → '+money(saved.amount)+'.' : '') +
        ((amountChanged || periodChanged) ? ' Payments already made were kept — use "Re-allocate" if the tenant shares need recalculating.' : '') +
        recurringMsg,
        'success'
      );
    } catch(err){
      errorEl.textContent = friendlyErrorMessage(err);
      errorEl.hidden = false;
    } finally {
      if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = originalLabel; }
    }
  }
  window.acceptBillChanges = acceptBillChanges;
  /** The modal's "Save" button is reused for creating (import) and editing — routes to one
   *  function or the other depending on whether editingBillId is set. */
  function submitReviewModal(){
    if (editingBillId) return saveEditedBill();
    return confirmReviewedBill();
  }
  window.submitReviewModal = submitReviewModal;
  function discardReviewItem(){
    if (reviewItemId) removeImportQueueItem(reviewItemId);
    closeReviewModal();
  }
  /** Looks for an already existing ACTIVE recurring bill template for that property + provider +
   *  service type — to prevent creating a duplicate. This is what caused the phantom bills
   *  seen at Dodo: two active templates generating the same bill every month, one of
   *  them with a wrongly computed date. The provider comparison ignores case/whitespace. */
  function findActiveRecurringTemplate(propertyId, provider, billType){
    var normProvider = (provider || '').trim().toLowerCase();
    return recurringBills.find(function(r){
      return r.isActive && r.propertyId === propertyId && r.billType === billType &&
        (r.provider || '').trim().toLowerCase() === normProvider;
    });
  }
  /** Shows/hides the "day of month" field when "Repeats every month" is checked — and if the
   *  user has already entered a due date, uses it to guess the default day. If there's
   *  already an active template for this provider+property+type, it won't allow checking
   *  the box and explains why instead of letting a duplicate be created. */
  function toggleReviewRecurringDay(){
    var checkboxEl = document.getElementById('review-recurring');
    var row = document.getElementById('review-recurring-day-row');
    var hint = document.getElementById('review-recurring-existing-hint');
    if (checkboxEl.checked){
      var propertyId = document.getElementById('review-property').value;
      var provider = document.getElementById('review-provider').value;
      var billType = document.getElementById('review-billtype').value;
      if (findActiveRecurringTemplate(propertyId, provider, billType)){
        checkboxEl.checked = false;
        row.hidden = true;
        hint.hidden = false;
        return;
      }
    }
    hint.hidden = true;
    var checked = checkboxEl.checked;
    row.hidden = !checked;
    if (checked){
      var dayField = document.getElementById('review-recurring-day');
      if (!dayField.value){
        var due = document.getElementById('review-due').value;
        if (due) dayField.value = Math.min(28, parseInt(due.slice(8,10), 10) || 1);
      }
    }
  }
  window.toggleReviewRecurringDay = toggleReviewRecurringDay;
  /** Opens the bill review modal blank, without going through the photo/AI — for a bill
   *  the administrator prefers to enter by hand. Reuses the same modal and the same save
   *  (confirmReviewedBill) as the photo-import flow. */
  function openManualBillModal(){
    var item = {
      id: 'manual-' + Date.now() + '-' + Math.round(Math.random()*1000),
      fileName: 'Manual entry',
      kind: 'manual',
      previewUrl: null,
      file: null,
      addedAt: TODAY,
      status: 'ready',
      extracted: Object.assign({}, BLANK_EXTRACTED_BILL),
      aiError: null
    };
    importQueue.push(item);
    openReviewModal(item.id);
  }
  window.openManualBillModal = openManualBillModal;
  /** "Enter manually" option inside the "+ Add bill" picker — closes that modal and opens the
   *  same blank review form as before, just reached from one place instead of two buttons. */
  function chooseManualBillEntry(){
    closeImportModal();
    openManualBillModal();
  }
  window.chooseManualBillEntry = chooseManualBillEntry;
  async function confirmReviewedBill(){
    var provider = document.getElementById('review-provider').value.trim();
    var accountNumber = document.getElementById('review-account').value.trim();
    var invoiceNumber = document.getElementById('review-invoice').value.trim();
    var issueDate = document.getElementById('review-issue').value;
    var dueDate = document.getElementById('review-due').value;
    var periodStart = document.getElementById('review-period-start').value;
    var periodEnd = document.getElementById('review-period-end').value;
    var amount = parseFloat(document.getElementById('review-amount').value);
    var errorEl = document.getElementById('review-modal-error');

    if (!provider || !issueDate || !dueDate || !periodStart || !periodEnd || !isFinite(amount) || amount <= 0){
      errorEl.textContent = 'Add a provider, both dates and a valid amount before saving.';
      errorEl.hidden = false;
      return;
    }

    var reviewPropertyId = document.getElementById('review-property').value;
    var saveBtnEl = document.querySelector('#review-modal .mini-btn.primary');
    if (!reviewDuplicateOverride){
      var duplicate = findDuplicateBill(reviewPropertyId, provider, invoiceNumber, periodStart, periodEnd, accountNumber);
      if (duplicate){
        errorEl.textContent = 'This looks like a bill you already saved — same provider ('+esc(provider)+') and period for this property'+(invoiceNumber && duplicate.invoiceNumber ? ' (or a matching invoice number)' : '')+'. Tap "Save anyway" if this is a different bill, or Cancel to check it first.';
        errorEl.hidden = false;
        reviewDuplicateOverride = true;
        if (saveBtnEl) saveBtnEl.textContent = 'Save anyway';
        return;
      }
    }

    var queueItem = importQueue.find(function(i){ return i.id===reviewItemId; }) || {};
    var draftBill = {
      propertyId: document.getElementById('review-property').value,
      provider: provider,
      billType: document.getElementById('review-billtype').value,
      accountNumber: accountNumber,
      invoiceNumber: invoiceNumber,
      issueDate: issueDate,
      dueDate: dueDate,
      billingPeriodStart: periodStart,
      billingPeriodEnd: periodEnd,
      amount: Math.round(amount*100)/100,
      status: 'pending',
      notes: queueItem.skippedAi
        ? 'Imported — recognized account, entered by hand without using AI.'
        : 'Imported from ' + (queueItem.fileName || 'a photo/PDF') + ' (details extracted automatically and reviewed before saving).'
    };

    var saveBtn = document.querySelector('#review-modal .mini-btn.primary');
    var originalLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    errorEl.hidden = true;
    try {
      var newBill = await billService.create(draftBill);

      // Actually keep the imported photo/PDF this time (the mock-OCR flow used to discard it):
      // upload it to the private `receipts` bucket and store the path on the bill.
      if (queueItem.file){
        try {
          var path = await storageService.uploadReceipt(newBill.id, queueItem.file);
          newBill = await billService.update(newBill.id, Object.assign({}, newBill, { receiptPath: path }));
        } catch(uploadErr){
          // Bill itself is saved; surface the upload problem but don't block the flow.
          showToast('Bill saved, but the receipt photo failed to upload. ' + friendlyErrorMessage(uploadErr), 'error');
        }
      }

      newBill = await autoAllocateNewBill(newBill);

      // "Repeats every month" — in addition to this bill, saves a template (recurring_bills) that
      // automatically generates next month's bill when its date arrives, without having to
      // enter it by hand every time (gas, internet, etc.).
      var makeRecurring = document.getElementById('review-recurring').checked;
      var skippedDuplicateRecurring = false;
      if (makeRecurring && findActiveRecurringTemplate(newBill.propertyId, newBill.provider, newBill.billType)){
        // Re-check just in case (another tab, or another bill from the queue just created the
        // template) — don't create a second active template for the same provider+property+type.
        makeRecurring = false;
        skippedDuplicateRecurring = true;
        showToast('Bill saved. This provider already repeats automatically for this property, so a duplicate monthly repeat wasn\'t created.', 'info');
      }
      if (makeRecurring){
        var billingDay = parseInt(document.getElementById('review-recurring-day').value, 10);
        if (isFinite(billingDay) && billingDay >= 1 && billingDay <= 28){
          try {
            var tpl = await recurringBillService.create({
              propertyId: newBill.propertyId,
              billType: newBill.billType,
              provider: newBill.provider,
              amount: newBill.amount,
              billingDay: billingDay,
              nextDueDate: addMonthsIso(newBill.dueDate, 1),
              isActive: true,
              notes: 'Auto-generated from a manually saved bill.'
            });
            recurringBills.push(tpl);
            showToast('Bill saved — it will repeat automatically every month.', 'success');
          } catch(recErr){
            showToast('Bill saved, but could not set up the monthly repeat. ' + friendlyErrorMessage(recErr), 'error');
          }
        }
      }

      bills.push(newBill);
      removeImportQueueItem(reviewItemId);
      closeReviewModal();
      if (!makeRecurring && !skippedDuplicateRecurring) showToast('Bill saved successfully.', 'success');
      // Step 7 of the flow (review and confirm the allocation): instead of landing
      // on the Bills list, the detail of the newly created bill is opened
      // directly, where the Allocation card already shows the per-tenant
      // split calculated automatically (or the "Allocate" button if the
      // property had no paying tenants).
      location.hash = '#/bills/' + newBill.id;
      render();
    } catch(err){
      errorEl.textContent = 'Could not save this bill. ' + friendlyErrorMessage(err);
      errorEl.hidden = false;
    } finally {
      if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = originalLabel; }
    }
  }

  window.triggerImportInput = triggerImportInput;
  window.handleImportFile = handleImportFile;
  window.openImportModal = openImportModal;
  window.closeImportModal = closeImportModal;
  window.confirmImportBill = confirmImportBill;
  window.removeImportQueueItem = removeImportQueueItem;
  window.openReviewModal = openReviewModal;
  window.closeReviewModal = closeReviewModal;
  window.discardReviewItem = discardReviewItem;
  window.confirmReviewedBill = confirmReviewedBill;

  /* ---------- Bill allocation (PHASE 9): split a bill among the tenants who occupied the property ---------- */
  function tenantsOfProperty(propertyId){
    return tenants.filter(function(t){ return t.propertyId===propertyId && t.rentAmount>0; });
  }
  /** Days of overlap (inclusive) between a tenant's stay and a bill's period. */
  function occupiedDaysInRange(tenant, rangeStart, rangeEnd){
    var tenantEnd = tenant.actualMoveOutDate || tenant.expectedMoveOutDate || rangeEnd;
    var start = tenant.moveInDate > rangeStart ? tenant.moveInDate : rangeStart;
    var end = tenantEnd < rangeEnd ? tenantEnd : rangeEnd;
    var days = daysBetween(start, end) + 1;
    return Math.max(0, days);
  }
  function round2(n){ return Math.round(n*100)/100; }

  var allocationDraft = null; // { billId, method, periodDays, rows:[{tenantId,name,days,amount}] }

  /** Splits `total` across `weights` (proportionally), adjusting the rounding on the row with the highest weight so the sum comes out exact. */
  function splitByWeights(total, weights){
    var sumW = weights.reduce(function(s,w){ return s+w; }, 0);
    if (sumW <= 0) return weights.map(function(){ return 0; });
    var amounts = weights.map(function(w){ return round2(total * w / sumW); });
    var diff = round2(total - amounts.reduce(function(s,a){ return s+a; }, 0));
    if (diff !== 0){
      var maxIdx = 0;
      for (var i=1;i<weights.length;i++){ if (weights[i]>weights[maxIdx]) maxIdx = i; }
      amounts[maxIdx] = round2(amounts[maxIdx] + diff);
    }
    return amounts;
  }

  /** A tenant can be excluded from paying one or more service types (tenant.excludedBillTypes,
   *  editable from the tenant form) — for example, if their rent already includes gas. */
  function isTenantExcludedFromBillType(tenant, billType){
    return !!(tenant && Array.isArray(tenant.excludedBillTypes) && tenant.excludedBillTypes.indexOf(billType) >= 0);
  }

  /** Did the tenant occupy their room on THAT specific day? Move-in date included, move-out
   *  date NOT included (half-open) — so the same day isn't counted twice when someone
   *  leaves and another person moves into the same room. This is separate from occupiedDaysInRange
   *  (which is still inclusive on both ends and is used for the informational "days
   *  occupied" metrics in the UI) — it's only used to decide how many ROOMS were occupied each
   *  day of the bill. */
  function tenantOccupiesDay(t, dayIso){
    if (dayIso < t.moveInDate) return false;
    var moveOut = t.actualMoveOutDate || t.expectedMoveOutDate;
    if (moveOut && dayIso >= moveOut) return false;
    return true;
  }

  /** Day-by-day allocation, by ROOM — not by tenant. Each day, the bill's daily cost is
   *  divided among the rooms that were occupied on THAT day (not among the property's
   *  total rooms, nor among the total number of people). If two tenants share the
   *  same room that day, they split that room's share between them. A day with no
   *  room occupied is neither lost nor forced onto other days: it's added to the
   *  administrator's row, just like the share of a tenant excluded from this service type. */
  function computeDailyRoomAllocationRows(bill){
    var totalDays = daysBetween(bill.billingPeriodStart, bill.billingPeriodEnd) + 1;
    var propTenants = tenantsOfProperty(bill.propertyId);
    var totals = {}; // tenantId -> accumulated total (not yet rounded)
    var adminTotal = 0;
    var dailyCost = bill.amount / totalDays;
    for (var i=0; i<totalDays; i++){
      var dayIso = stepDateIso(bill.billingPeriodStart, i);
      var byRoom = {};
      propTenants.forEach(function(t){
        if (!tenantOccupiesDay(t, dayIso)) return;
        var key = t.roomId || ('__no_room_'+t.id); // no room assigned = their own "room"
        (byRoom[key] = byRoom[key] || []).push(t);
      });
      var roomKeys = Object.keys(byRoom);
      if (roomKeys.length === 0){
        adminTotal += dailyCost; // no tenant registered that day — the admin absorbs that day
        continue;
      }
      var costPerRoom = dailyCost / roomKeys.length;
      roomKeys.forEach(function(key){
        var occupants = byRoom[key];
        var costPerPerson = costPerRoom / occupants.length; // split among whoever shares the room THAT day
        occupants.forEach(function(t){
          if (isTenantExcludedFromBillType(t, bill.billType)){
            adminTotal += costPerPerson;
          } else {
            totals[t.id] = (totals[t.id] || 0) + costPerPerson;
          }
        });
      });
    }
    var rows = Object.keys(totals).map(function(tenantId){
      var t = tenantOf(tenantId);
      return { tenantId: tenantId, name: t ? t.fullName : tenantId,
        days: t ? occupiedDaysInRange(t, bill.billingPeriodStart, bill.billingPeriodEnd) : 0,
        amount: round2(totals[tenantId]) };
    });
    if (adminTotal > 0.004){
      rows.push({ tenantId: null, isAdmin: true, name: 'Administrator (you)', days: null, amount: round2(adminTotal) });
    }
    // Adjusts the rounding (61 days split into fractions of a cent can throw off the total by
    // a few cents) on the largest row, so the sum matches the bill exactly.
    var sum = round2(rows.reduce(function(s,r){ return s + r.amount; }, 0));
    var diff = round2(bill.amount - sum);
    if (diff !== 0 && rows.length){
      var maxIdx = 0;
      for (var j=1; j<rows.length; j++){ if (rows[j].amount > rows[maxIdx].amount) maxIdx = j; }
      rows[maxIdx].amount = round2(rows[maxIdx].amount + diff);
    }
    return rows;
  }

  /** Day-prorated split by each present tenant's bill_occupancy_factor (spec:
   *  docs/superpowers/specs/2026-09-27-bill-occupancy-factor-design.md §5). Parallels
   *  computeDailyRoomAllocationRows's day loop, but skips the room-grouping step entirely —
   *  each day's cost is split directly among that day's present tenants, weighted by their
   *  factor, so a couple (factor 2.0) pays twice what a single tenant (factor 1.0) does. */
  function computeOccupancyFactorAllocationRows(bill){
    var totalDays = daysBetween(bill.billingPeriodStart, bill.billingPeriodEnd) + 1;
    var propTenants = tenantsOfProperty(bill.propertyId);
    var totals = {};
    var adminTotal = 0;
    var dailyCost = bill.amount / totalDays;
    for (var i=0; i<totalDays; i++){
      var dayIso = stepDateIso(bill.billingPeriodStart, i);
      var present = propTenants.filter(function(t){ return tenantOccupiesDay(t, dayIso); });
      if (present.length === 0){ adminTotal += dailyCost; continue; }
      var totalFactor = present.reduce(function(s,t){ return s + (t.billOccupancyFactor || 1); }, 0);
      present.forEach(function(t){
        var share = dailyCost * (t.billOccupancyFactor || 1) / totalFactor;
        if (isTenantExcludedFromBillType(t, bill.billType)) adminTotal += share;
        else totals[t.id] = (totals[t.id] || 0) + share;
      });
    }
    var rows = Object.keys(totals).map(function(tenantId){
      var t = tenantOf(tenantId);
      return { tenantId: tenantId, name: t ? t.fullName : tenantId,
        occupancyFactor: t ? t.billOccupancyFactor : 1, amount: round2(totals[tenantId]) };
    });
    if (adminTotal > 0.004){
      rows.push({ tenantId: null, isAdmin: true, name: 'Administrator (you)', amount: round2(adminTotal) });
    }
    // Same largest-row rounding-remainder fix as computeDailyRoomAllocationRows, so the sum
    // always matches the bill's amount exactly regardless of how the cents fell.
    var sum = round2(rows.reduce(function(s,r){ return s + r.amount; }, 0));
    var diff = round2(bill.amount - sum);
    if (diff !== 0 && rows.length){
      var maxIdx = 0;
      for (var j=1; j<rows.length; j++){ if (rows[j].amount > rows[maxIdx].amount) maxIdx = j; }
      rows[maxIdx].amount = round2(rows[maxIdx].amount + diff);
    }
    return rows;
  }

  function computeAllocationRows(bill, method){
    if (method === 'days') return computeDailyRoomAllocationRows(bill);
    if (method === 'occupancy') return computeOccupancyFactorAllocationRows(bill);
    // 'equal' and the starting point for 'custom' — even split among tenants (not by room,
    // since "equal" is intentionally "everyone pays the same", regardless of how many share a
    // room or how many days they were there).
    // Only tenants who actually overlapped with the bill's period are included — someone who moved
    // out before it started, or moved in after it ended (or no longer lives there today), is left
    // out instead of showing up with $0 to split by hand.
    var propTenants = tenantsOfProperty(bill.propertyId).filter(function(t){
      return occupiedDaysInRange(t, bill.billingPeriodStart, bill.billingPeriodEnd) > 0;
    });
    var amounts = splitByWeights(bill.amount, propTenants.map(function(){ return 1; }));
    // If a tenant is excluded from this service type, their share isn't redistributed among the
    // rest (that would unfairly raise their amount) — instead, it's collected into a separate row
    // under the administrator's name, who absorbs it.
    var rows = [];
    var adminAmount = 0;
    propTenants.forEach(function(t, i){
      if (isTenantExcludedFromBillType(t, bill.billType)){
        adminAmount = round2(adminAmount + amounts[i]);
      } else {
        rows.push({ tenantId: t.id, name: t.fullName, days: occupiedDaysInRange(t, bill.billingPeriodStart, bill.billingPeriodEnd), amount: amounts[i] });
      }
    });
    if (adminAmount > 0){
      rows.push({ tenantId: null, isAdmin: true, name: 'Administrator (you)', days: null, amount: adminAmount });
    }
    return rows;
  }

  /** Automatically splits a newly saved bill among the tenants who currently pay rent at that
   *  property (by days occupied), used both when saving a bill from the review modal
   *  and when generating one automatically from a recurring bill. */
  async function autoAllocateNewBill(newBill){
    var propTenantsForBill = tenantsOfProperty(newBill.propertyId);
    if (propTenantsForBill.length > 0){
      var autoRows = computeAllocationRows(newBill, 'occupancy');
      // Same snapshot rule as confirmAllocation's manual "By occupancy factor" save: every
      // non-admin row carries the factor actually used, and the bill-wide total those factors
      // summed to — both frozen at allocation time (see docs/superpowers/specs/
      // 2026-09-27-bill-occupancy-factor-design.md §4). Tenants with the default factor (1.0)
      // produce identical amounts to the old 'days' default, so this is a safe default switch.
      var totalFactorForBill = round2(autoRows.filter(function(r){ return !r.isAdmin; })
        .reduce(function(s,r){ return s + (r.occupancyFactor || 1); }, 0));
      var allocRows = autoRows.map(function(r){
        if (r.isAdmin) return { tenantId:null, isAdmin:true, amount:round2(r.amount), paid:true, paidDate:TODAY,
          occupancyFactor:null, totalOccupancyFactor:null };
        var amt = round2(r.amount);
        var owesNothing = amt <= 0;
        return { tenantId:r.tenantId, amount:amt, paid:owesNothing, paidDate: owesNothing ? TODAY : null,
          occupancyFactor: r.occupancyFactor || 1, totalOccupancyFactor: totalFactorForBill };
      });
      var savedAllocations = await billAllocationService.replaceForBill(newBill.id, allocRows);
      newBill.allocationMethod = 'occupancy';
      newBill.status = 'allocated';
      newBill = await billService.update(newBill.id, newBill);
      newBill.allocations = savedAllocations;
    }
    return newBill;
  }
  /** Self-heals a bill that somehow ended up with no allocation at all (bill.allocations missing
   *  or an empty array) — normally impossible since autoAllocateNewBill runs the moment a bill is
   *  created, but it's a real dead end if it ever happens: "Mark as paid" for a tenant on an
   *  unallocated bill would otherwise silently do nothing (see openAllocPaidModal). Splits it by
   *  days occupied, same as a freshly created bill, and mutates `bill` in place (both `bills` and
   *  whatever local reference the caller holds see the new allocations). Does nothing if the bill
   *  is already allocated. */
  async function ensureBillAllocated(bill){
    if (bill.allocations && bill.allocations.length) return bill;
    // Before creating a fresh split, check the database: the in-memory copy can be missing its
    // allocations (e.g. after a save that returned the bare bill row) while the real rows — with
    // who already paid — still exist. Auto-allocating here would delete them (replaceForBill).
    var fromDb = await billAllocationService.getForBill(bill.id);
    if (fromDb && fromDb.length){ bill.allocations = fromDb; return bill; }
    var updated = await autoAllocateNewBill(bill);
    Object.assign(bill, updated);
    return bill;
  }

  /** Checks every active recurring bill and, if its next billing date has already arrived (or
   *  passed), creates the corresponding bill and allocates it automatically — just like rentService
   *  generates rent charges from a schedule, but for monthly bills (gas, internet, etc.).
   *  If the app went several months without being opened, generates one for each month that was pending. */
  async function generateDueRecurringBills(){
    for (var i=0; i<recurringBills.length; i++){
      var tpl = recurringBills[i];
      if (!tpl.isActive) continue;
      var guard = 0;
      while (tpl.nextDueDate <= TODAY && guard < 24){
        guard++;
        // Charged IN ADVANCE: the cycle that's starting is the one being billed, not the one that
        // already ended — the billing period starts on the due date (nextDueDate)
        // and extends one month forward, with the due date the same day it starts.
        var periodStart = tpl.nextDueDate;
        var periodEnd = stepDateIso(addMonthsIso(tpl.nextDueDate, 1), -1);
        var draftBill = {
          propertyId: tpl.propertyId,
          provider: tpl.provider,
          billType: tpl.billType,
          invoiceNumber: '',
          issueDate: periodStart,
          dueDate: tpl.nextDueDate,
          billingPeriodStart: periodStart,
          billingPeriodEnd: periodEnd,
          amount: tpl.amount,
          status: 'pending',
          notes: 'Auto-generated recurring bill (' + tpl.provider + ').'
        };
        try {
          var newBill = await billService.create(draftBill);
          newBill = await autoAllocateNewBill(newBill);
          bills.push(newBill);
        } catch(err){
          console.error('generateDueRecurringBills: could not create bill for template', tpl.id, err);
          break; // don't keep trying to advance this template if it failed — it's retried on the next bootstrap
        }
        var advanced = await recurringBillService.advanceNextDueDate(tpl.id, addMonthsIso(tpl.nextDueDate, 1));
        tpl.nextDueDate = advanced.nextDueDate;
      }
    }
  }

  /* ---------- Recurring bills (gas, internet, etc. — repeat every month) ---------- */
  var recurringModalId = null; // null = creating a new one
  function openRecurringBillModal(id){
    recurringModalId = id || null;
    var tpl = id ? recurringBills.find(function(r){ return r.id===id; }) : null;
    refreshStaticSelects();
    document.getElementById('recurring-property').value = tpl ? tpl.propertyId : (properties[0] ? properties[0].id : '');
    document.getElementById('recurring-billtype').value = tpl ? tpl.billType : 'other';
    document.getElementById('recurring-provider').value = tpl ? tpl.provider : '';
    document.getElementById('recurring-amount').value = tpl ? tpl.amount : '';
    document.getElementById('recurring-day').value = tpl ? tpl.billingDay : '';
    document.getElementById('recurring-delete-btn').hidden = !tpl;
    var errEl = document.getElementById('recurring-modal-error');
    errEl.hidden = true; errEl.textContent = '';
    document.getElementById('recurring-bill-modal').hidden = false;
  }
  window.openRecurringBillModal = openRecurringBillModal;
  function closeRecurringBillModal(){
    recurringModalId = null;
    document.getElementById('recurring-bill-modal').hidden = true;
  }
  window.closeRecurringBillModal = closeRecurringBillModal;
  /** The billing day may fall later this month (hasn't arrived yet) or may have already
   *  passed (in which case the next occurrence is next month) — generateDueRecurringBills
   *  takes care of generating the bill as soon as that date arrives. */
  function nextDueDateForBillingDay(day){
    var thisMonth = TODAY.slice(0,7) + '-' + String(day).padStart(2,'0');
    return thisMonth >= TODAY ? thisMonth : addMonthsIso(thisMonth, 1);
  }
  async function saveRecurringBillModal(){
    var propertyId = document.getElementById('recurring-property').value;
    var billType = document.getElementById('recurring-billtype').value;
    var provider = document.getElementById('recurring-provider').value.trim();
    var amount = parseFloat(document.getElementById('recurring-amount').value);
    var billingDay = parseInt(document.getElementById('recurring-day').value, 10);
    var errEl = document.getElementById('recurring-modal-error');
    if (!propertyId || !provider || !isFinite(amount) || amount <= 0 || !isFinite(billingDay) || billingDay < 1 || billingDay > 28){
      errEl.textContent = 'Add a property, provider, a valid amount, and a billing day between 1 and 28.';
      errEl.hidden = false;
      return;
    }
    // Don't allow creating a second active template for the same provider+property+type — this is
    // what generated the phantom bills at Dodo (two templates generating the same bill every month).
    if (!recurringModalId){
      var dupTpl = findActiveRecurringTemplate(propertyId, provider, billType);
      if (dupTpl){
        errEl.textContent = 'There\'s already an active recurring bill for ' + provider + ' at this property (' + billTypeLabel(billType) + '). Edit that one instead of creating a duplicate.';
        errEl.hidden = false;
        return;
      }
    }
    var saveBtn = document.querySelector('#recurring-bill-modal .mini-btn.primary');
    var originalLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    try {
      if (recurringModalId){
        var existing = recurringBills.find(function(r){ return r.id===recurringModalId; });
        var saved = await recurringBillService.update(recurringModalId, {
          propertyId: propertyId, billType: billType, provider: provider, amount: round2(amount),
          billingDay: billingDay, nextDueDate: existing.nextDueDate, isActive: existing.isActive
        });
        Object.assign(existing, saved);
      } else {
        var created = await recurringBillService.create({
          propertyId: propertyId, billType: billType, provider: provider, amount: round2(amount),
          billingDay: billingDay, nextDueDate: nextDueDateForBillingDay(billingDay), isActive: true
        });
        recurringBills.push(created);
      }
      closeRecurringBillModal();
      showToast('Recurring bill saved.', 'success');
      render();
    } catch(err){
      errEl.textContent = 'Could not save this recurring bill. ' + friendlyErrorMessage(err);
      errEl.hidden = false;
    } finally {
      if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = originalLabel; }
    }
  }
  window.saveRecurringBillModal = saveRecurringBillModal;
  async function deleteRecurringBillModal(){
    if (!recurringModalId) return;
    try {
      await recurringBillService.remove(recurringModalId);
      recurringBills = recurringBills.filter(function(r){ return r.id!==recurringModalId; });
      closeRecurringBillModal();
      showToast('Recurring bill deleted.', 'success');
      render();
    } catch(err){
      showToast('Could not delete this recurring bill. ' + friendlyErrorMessage(err), 'error');
    }
  }
  window.deleteRecurringBillModal = deleteRecurringBillModal;
  async function toggleRecurringBillActive(id, nextActive){
    try {
      var saved = await recurringBillService.setActive(id, nextActive);
      var tpl = recurringBills.find(function(r){ return r.id===id; });
      if (tpl) Object.assign(tpl, saved);
      showToast(nextActive ? 'Recurring bill resumed.' : 'Recurring bill paused.', 'success');
      renderPreservingScroll();
    } catch(err){
      showToast('Could not update this recurring bill. ' + friendlyErrorMessage(err), 'error');
    }
  }
  window.toggleRecurringBillActive = toggleRecurringBillActive;

  function openAllocateModal(billId){
    var bill = billOf(billId);
    if (!bill) return;
    var totalDays = daysBetween(bill.billingPeriodStart, bill.billingPeriodEnd) + 1;
    // bill.allocations can come back as an EMPTY array (not null/undefined) — for example, if this
    // bill was saved before that property's tenant records existed, or if none of the saved
    // tenants overlapped with its period. An empty array is still "truthy" in JS, so without this
    // check the modal would land in Custom mode with $0 of $X — as if the admin had to cover 100%
    // by hand — instead of proposing a real split between tenants and admin (per
    // tenant.excludedBillTypes) the way a newly created bill would.
    var existingRows = (bill.allocations && bill.allocations.length)
      ? bill.allocations.map(function(a){
          if (a.isAdmin) return { tenantId:null, isAdmin:true, name:'Administrator (you)', days:null, amount:a.amount };
          var t = tenantOf(a.tenantId);
          return { tenantId:a.tenantId, name:t?t.fullName:a.tenantId,
            days: t?occupiedDaysInRange(t, bill.billingPeriodStart, bill.billingPeriodEnd):0, amount:a.amount };
        // Filters out old allocations for someone who didn't overlap with the period (or who no
        // longer lives there) — they were left at $0 from an earlier allocation and shouldn't keep showing up.
        }).filter(function(row){ return row.isAdmin || row.days > 0 || row.amount > 0; })
      : [];
    var rows = existingRows.length ? existingRows : computeAllocationRows(bill, 'days');
    allocationDraft = { billId: billId, method: existingRows.length ? 'custom' : 'days', periodDays: totalDays, rows: rows };
    document.getElementById('allocate-modal-sub').textContent =
      esc(bill.provider) + ' • ' + money(bill.amount) + ' • ' + shortDate(bill.billingPeriodStart) + ' – ' + shortDate(bill.billingPeriodEnd);
    renderAllocateModal();
    document.getElementById('allocate-modal').hidden = false;
  }
  function closeAllocateModal(){
    allocationDraft = null;
    document.getElementById('allocate-modal').hidden = true;
  }
  function setAllocationMethod(method){
    if (!allocationDraft) return;
    var bill = billOf(allocationDraft.billId);
    allocationDraft.method = method;
    if (method === 'custom'){
      // Starts from the last distribution visible on screen instead of resetting to zero.
      allocationDraft.rows = allocationDraft.rows.slice();
    } else {
      allocationDraft.rows = computeAllocationRows(bill, method);
    }
    renderAllocateModal();
  }
  var ALLOCATION_METHOD_NOTES = {
    equal: 'The amount is split equally between every tenant at the property.',
    days: "The amount is split day by day between the rooms that were occupied each day (not a fixed number of rooms) — tenants sharing a room split that room's share between them.",
    occupancy: "The amount is split day by day by each tenant's occupancy factor (e.g. a couple counts as 2.0, a single tenant as 1.0) — moving in or out mid-period is handled automatically.",
    custom: "Set each amount by hand. The total must match the bill's amount exactly."
  };
  /** Lets the administrator mark that they're covering (part of) this bill themselves — for
   *  example, if they're on the hook for a portion and only the rest needs to be split among
   *  tenants. This is manual and independent of the automatic allocation via tenant.excludedBillTypes
   *  (see computeAllocationRows); it adds/removes an editable row under the administrator's name
   *  and switches the method to 'custom' so the amount isn't just recalculated over it. */
  function toggleAllocationAdmin(){
    if (!allocationDraft) return;
    var idx = allocationDraft.rows.findIndex(function(r){ return r.isAdmin; });
    if (idx > -1){
      allocationDraft.rows.splice(idx, 1);
    } else {
      allocationDraft.method = 'custom';
      allocationDraft.rows.push({ tenantId:null, isAdmin:true, name:'Administrator (you)', days:null, amount:0 });
    }
    renderAllocateModal();
  }
  window.toggleAllocationAdmin = toggleAllocationAdmin;
  function renderAllocateModal(){
    if (!allocationDraft) return;
    document.querySelectorAll('#allocate-method-chips .chip').forEach(function(btn, i){
      var methods = ['equal','days','occupancy','custom'];
      btn.classList.toggle('active', methods[i] === allocationDraft.method);
    });
    var hasAdminRow = allocationDraft.rows.some(function(r){ return r.isAdmin; });
    var note = ALLOCATION_METHOD_NOTES[allocationDraft.method] || '';
    if (hasAdminRow) note += ' The Administrator row is the part you cover yourself — the tenants only split what\'s left.';
    document.getElementById('allocate-method-note').textContent = note;
    document.getElementById('allocate-admin-toggle').innerHTML = hasAdminRow
      ? '<button class="mini-btn" type="button" onclick="toggleAllocationAdmin()">− Remove yourself as a payer</button>'
      : '<button class="mini-btn" type="button" onclick="toggleAllocationAdmin()">+ Add yourself (the admin) as a payer</button>';
    document.getElementById('allocate-rows').innerHTML = allocationDraft.rows.map(function(row, i){
      var metaText = row.isAdmin ? "Paid by you, not the tenants"
        : (allocationDraft.method === 'occupancy' ? ('Factor: ' + (row.occupancyFactor != null ? row.occupancyFactor.toFixed(1) : '1.0'))
        : (row.days+' / '+allocationDraft.periodDays+' days occupied'));
      return '<div class="alloc-row"><div class="who"><div>'+esc(row.name)+'</div>'+
        '<div class="meta">'+metaText+'</div></div>'+
        '<input class="alloc-amount-input" type="number" min="0" step="0.01" value="'+row.amount.toFixed(2)+'" '+
        'oninput="updateAllocationRow('+i+', this.value)" /></div>';
    }).join('');
    updateAllocationTotals();
  }
  function updateAllocationRow(index, value){
    if (!allocationDraft) return;
    var n = parseFloat(value);
    allocationDraft.rows[index].amount = isFinite(n) ? n : 0;
    updateAllocationTotals();
  }
  function updateAllocationTotals(){
    if (!allocationDraft) return;
    var bill = billOf(allocationDraft.billId);
    var sum = round2(allocationDraft.rows.reduce(function(s,r){ return s+(r.amount||0); }, 0));
    var diff = round2(bill.amount - sum);
    var el = document.getElementById('allocate-total-text');
    if (Math.abs(diff) < 0.005){
      el.innerHTML = '<span class="diff-ok">'+money(sum)+' of '+money(bill.amount)+' ✓</span>';
    } else {
      el.innerHTML = '<span class="diff-bad">'+money(sum)+' of '+money(bill.amount)+' ('+(diff>0?'short by ':'over by ')+money(Math.abs(diff))+')</span>';
    }
    document.getElementById('allocate-modal-error').hidden = true;
  }
  async function confirmAllocation(){
    if (!allocationDraft) return;
    var bill = billOf(allocationDraft.billId);
    var sum = round2(allocationDraft.rows.reduce(function(s,r){ return s+(r.amount||0); }, 0));
    var diff = round2(bill.amount - sum);
    var errorEl = document.getElementById('allocate-modal-error');
    if (Math.abs(diff) >= 0.005){
      errorEl.textContent = 'The total allocated must match the bill amount before you confirm.';
      errorEl.hidden = false;
      return;
    }
    // replaceForBill deletes every existing allocation row and inserts new ones with new ids —
    // payment_reports.allocation_id is ON DELETE CASCADE, so re-allocating while a tenant's
    // payment report is still pending would silently delete it (and their proof/reference) with
    // no admin review ever happening. Block that instead of letting it vanish.
    var hasPendingReport = (bill.allocations || []).some(function(a){ return allocationPaymentStatus(a) === 'pending_verification'; });
    if (hasPendingReport){
      errorEl.textContent = 'This bill has a payment report pending review — confirm or reject it first, then re-allocate.';
      errorEl.hidden = false;
      return;
    }
    // Preserves the "paid" status of each tenant who was already in the
    // previous allocation (by tenantId), even if the amount or method
    // changes — reallocating shouldn't un-mark as paid someone who already
    // paid their share.
    var oldPaidByTenant = {};
    (bill.allocations || []).forEach(function(a){ oldPaidByTenant[a.isAdmin ? 'admin' : a.tenantId] = { paid: !!a.paid, paidDate: a.paidDate || null, paidVia: a.paidVia || null, receiptPath: a.receiptPath || null }; });
    // Only an 'occupancy' allocation carries a real occupancy_factor/total_occupancy_factor
    // snapshot — every other method must explicitly write null so re-allocating a bill away
    // from 'occupancy' doesn't leave a stale factor from the old method on the new rows.
    var isOccupancy = allocationDraft.method === 'occupancy';
    var totalFactorForBill = isOccupancy
      ? round2(allocationDraft.rows.filter(function(r){ return !r.isAdmin; })
          .reduce(function(s,r){ return s + (r.occupancyFactor || 1); }, 0))
      : null;
    var newRows = allocationDraft.rows.map(function(r){
      if (r.isAdmin){
        var prevAdmin = oldPaidByTenant.admin;
        // No one else owes the administrator's share — it's considered covered as soon as it's saved.
        return { tenantId:null, isAdmin:true, amount:round2(r.amount), paid:true, paidDate: (prevAdmin && prevAdmin.paidDate) || TODAY,
          occupancyFactor: null, totalOccupancyFactor: null };
      }
      var amt = round2(r.amount);
      var factorFields = { occupancyFactor: isOccupancy ? (r.occupancyFactor || 1) : null, totalOccupancyFactor: totalFactorForBill };
      if (amt <= 0){
        // They don't owe anything (e.g. excluded from this service, or the admin set
        // $0 by hand) — it's considered settled on its own, without asking the admin to mark it as paid.
        var prevZero = oldPaidByTenant[r.tenantId];
        return Object.assign({ tenantId:r.tenantId, amount:0, paid:true, paidDate: (prevZero && prevZero.paidDate) || TODAY }, factorFields);
      }
      var prev = oldPaidByTenant[r.tenantId];
      return Object.assign({ tenantId:r.tenantId, amount:amt, paid: prev ? prev.paid : false, paidDate: prev ? prev.paidDate : null,
        paidVia: prev ? prev.paidVia : null, receiptPath: prev ? prev.receiptPath : null }, factorFields);
    });
    var confirmBtn = document.querySelector('#allocate-modal .mini-btn.primary');
    var originalLabel = confirmBtn ? confirmBtn.textContent : '';
    if (confirmBtn){ confirmBtn.disabled = true; confirmBtn.textContent = 'Saving…'; }
    try {
      var savedAllocations = await billAllocationService.replaceForBill(bill.id, newRows);
      bill.allocations = savedAllocations;
      bill.allocationMethod = allocationDraft.method;
      recomputeBillStatus(bill);
      await persistBill(bill);
      bill.allocations = savedAllocations; // persistBill's Object.assign doesn't carry `allocations` back from the DB row
      showToast('Allocation saved successfully.', 'success');
      closeAllocateModal();
      render();
    } catch(err){
      errorEl.textContent = 'Could not save the allocation. ' + friendlyErrorMessage(err);
      errorEl.hidden = false;
    } finally {
      if (confirmBtn){ confirmBtn.disabled = false; confirmBtn.textContent = originalLabel; }
    }
  }
  window.openAllocateModal = openAllocateModal;
  window.closeAllocateModal = closeAllocateModal;
  window.setAllocationMethod = setAllocationMethod;
  window.updateAllocationRow = updateAllocationRow;
  window.confirmAllocation = confirmAllocation;

  /**
   * A bill's overall status derived from its per-tenant shares: if it has
   * no allocations, the status doesn't change (stays 'pending', same as
   * before). If it does have them, it's derived from how many are paid: none ->
   * 'allocated', all -> 'paid', some -> 'partially_paid'.
   */
  function recomputeBillStatus(bill){
    if (!bill.allocations || !bill.allocations.length) return;
    var total = bill.allocations.length;
    var paidCount = bill.allocations.filter(function(a){ return a.paid; }).length;
    if (paidCount === 0) bill.status = 'allocated';
    else if (paidCount === total) bill.status = 'paid';
    else bill.status = 'partially_paid';
  }
  /** Marks a tenant's share of a bill as paid (with the actual date the admin specifies,
   *  not always today), and recomputes the bill's overall status. */
  async function markAllocationPaid(billId, tenantId, date, paidVia){
    var bill = billOf(billId);
    if (!bill || !bill.allocations) return;
    var alloc = bill.allocations.find(function(a){ return a.tenantId===tenantId; });
    if (!alloc) return;
    var paidDate = date || TODAY;
    try {
      var savedAlloc = await billAllocationService.markPaid(alloc.id, paidDate, paidVia);
      alloc.paid = true;
      alloc.paidDate = paidDate;
      alloc.paidVia = savedAlloc.paidVia;
      recomputeBillStatus(bill);
      var savedAllocations = bill.allocations;
      await persistBill(bill);
      bill.allocations = savedAllocations;
      // Whichever admin action actually marked this share paid — the "Confirm Payment" button,
      // or the plain "Mark as paid" button here or in pendingBillsByTenantHtml — must never leave
      // a payment_reports row stuck at 'pending' once the share is genuinely paid. This only runs
      // after the write above succeeded (we're still inside the try), so a failed write never
      // auto-confirms a report.
      try { await autoConfirmPendingPaymentReport(alloc.id); } catch(_e){ console.error('autoConfirmPendingPaymentReport failed', _e); }
      if (alloc.paidVia === 'bond_deduction'){
        showToast('Bill share settled from the bond.', 'success');
      } else {
        showToast('Marked as paid.', 'success', { label:'Undo', onClick: function(){ unmarkAllocationPaid(billId, tenantId); } });
      }
      render();
    } catch(err){
      showToast('Could not mark this as paid. ' + friendlyErrorMessage(err), 'error');
    }
  }
  /** If this allocation has a 'pending' payment_reports row, resolves it to 'confirmed' and
   *  notifies the tenant — called from inside markAllocationPaid right after the share is
   *  actually marked paid, so it fires no matter which button triggered that (Confirm Payment,
   *  or either of the two pre-existing "Mark as paid" buttons). No-ops silently if there was no
   *  pending report (the ordinary case, when the admin marks paid without any tenant report). */
  async function autoConfirmPendingPaymentReport(allocationId){
    var pending = paymentReportsForAllocation(allocationId).find(function(r){ return r.status==='pending'; });
    if (!pending) return;
    var updated = await paymentReportService.confirm(pending.id, currentProfile ? currentProfile.id : null);
    var idx = paymentReports.findIndex(function(r){ return r.id===pending.id; });
    if (idx > -1) paymentReports[idx] = updated;
    var bill = billOf(pending.billId);
    var t = tenantOf(pending.tenantId);
    if (bill && t && t.authUserId){
      var alloc = bill.allocations && bill.allocations.find(function(a){ return a.id===allocationId; });
      notificationService.notify(t.authUserId, 'Payment confirmed',
        'Your payment of ' + money(alloc ? alloc.amount : 0) + ' for ' + billTypeLabel(bill.billType) + ' has been verified and marked as paid.',
        'bills', bill.id, { category: 'payment_report', propertyId: bill.propertyId, tenantId: pending.tenantId, createdByProfileId: currentProfile ? currentProfile.id : null });
    }
  }
  /** Corrects an administrator mistake: undoes the "paid" mark on a tenant's share of a
   *  bill (for example, if it was marked by accident before the tenant actually
   *  paid). The attached receipt, if any, is kept — use removeReceipt
   *  if it also needs to be removed. */
  async function unmarkAllocationPaid(billId, tenantId){
    var bill = billOf(billId);
    if (!bill || !bill.allocations) return;
    var alloc = bill.allocations.find(function(a){ return a.tenantId===tenantId; });
    if (!alloc) return;
    try {
      await billAllocationService.unmarkPaid(alloc.id);
      alloc.paid = false;
      alloc.paidDate = null;
      recomputeBillStatus(bill);
      var savedAllocations = bill.allocations;
      await persistBill(bill);
      bill.allocations = savedAllocations;
      showToast('Undone — marked as unpaid again.', 'success');
      render();
    } catch(err){
      showToast('Could not undo this. ' + friendlyErrorMessage(err), 'error');
    }
  }
  window.markAllocationPaid = markAllocationPaid;
  window.unmarkAllocationPaid = unmarkAllocationPaid;

  /* ---------- Modal: confirm a tenant's bill-share payment with the actual date it was paid ---------- */
  var allocPaidModalTarget = null; // { billId, tenantId }
  /** Opens the "mark as paid" modal for one tenant's share of a bill. If the bill somehow has no
   *  allocation yet (see ensureBillAllocated) it allocates it on the spot instead of doing nothing
   *  — clicking "Mark as paid" should never be a dead end waiting on a manual "Allocate" first. */
  async function openAllocPaidModal(billId, tenantId){
    var bill = billOf(billId);
    if (!bill) return;
    var alloc = bill.allocations && bill.allocations.find(function(a){ return a.tenantId===tenantId; });
    if (!alloc){
      try {
        await ensureBillAllocated(bill);
      } catch(err){
        showToast('Could not allocate this bill automatically. ' + friendlyErrorMessage(err), 'error');
        return;
      }
      alloc = bill.allocations && bill.allocations.find(function(a){ return a.tenantId===tenantId; });
    }
    if (!alloc){
      // Genuinely nothing to pay — e.g. this tenant didn't overlap with the bill's period, or
      // is excluded from this bill type, so the split never gave them a share.
      showToast('This tenant doesn\'t have a share of this bill to mark as paid.', 'error');
      return;
    }
    var t = tenantOf(tenantId);
    allocPaidModalTarget = { billId: billId, tenantId: tenantId };
    document.getElementById('alloc-paid-modal-sub').textContent = (t?t.fullName:'') + ' • ' + money(alloc.amount);
    var dateInput = document.getElementById('alloc-paid-modal-date');
    dateInput.value = TODAY; // editable: the tenant may have paid on an earlier day than today
    document.getElementById('alloc-paid-modal').hidden = false;
    render(); // reflect the freshly created allocations elsewhere on the page (e.g. the Allocation card)
  }
  function closeAllocPaidModal(){
    document.getElementById('alloc-paid-modal').hidden = true;
    allocPaidModalTarget = null;
  }
  async function confirmAllocPaidModal(){
    var target = allocPaidModalTarget;
    var dateInput = document.getElementById('alloc-paid-modal-date');
    var date = dateInput.value || TODAY;
    closeAllocPaidModal();
    if (!target) return;
    await markAllocationPaid(target.billId, target.tenantId, date);
  }
  window.openAllocPaidModal = openAllocPaidModal;
  window.closeAllocPaidModal = closeAllocPaidModal;
  window.confirmAllocPaidModal = confirmAllocPaidModal;

  /** Removes a receipt that was attached by mistake (from a tenant or the admin themselves)
   *  without touching whether the share is marked as paid — for when the wrong file was uploaded. */
  async function removeReceipt(billId, tenantId){
    var bill = billOf(billId);
    if (!bill) return;
    try {
      if (tenantId){
        var alloc = bill.allocations && bill.allocations.find(function(a){ return a.tenantId===tenantId; });
        if (!alloc) return;
        await billAllocationService.setReceipt(alloc.id, null);
        alloc.receiptPath = null;
      } else {
        bill.adminReceiptPath = null;
        await persistBill(bill);
      }
      showToast('Receipt removed.', 'success');
      render();
    } catch(err){
      showToast('Could not remove the receipt. ' + friendlyErrorMessage(err), 'error');
    }
  }
  window.removeReceipt = removeReceipt;

  /* ---------- Admin → provider payment (separate from each tenant's own allocation.paid) ----------
   * A bill has two payment legs: (1) each tenant pays their share to the admin — that's
   * allocation.paid/paidDate/receiptPath above; (2) once every tenant has paid, the admin
   * forwards the money on to the actual service provider — that's bill.adminPaid/adminPaidDate/
   * adminReceiptPath, gated by billReadyForAdminPayment so the admin can't mark the provider paid
   * before collecting from tenants. */
  function billReadyForAdminPayment(b){
    return b.amount > 0 && billOutstandingAmount(b) === 0;
  }
  /** Names (with what they still owe) of every non-admin allocation on a bill that hasn't been
   *  paid yet — used to spell out exactly who's still outstanding when the admin tries to pay
   *  the provider ahead of collecting from everyone. */
  function unpaidTenantAllocationLabels(bill){
    if (!bill.allocations) return [];
    return bill.allocations.filter(function(a){ return !a.isAdmin && !a.paid && round2(a.amount) > 0.004; }).map(function(a){
      var t = tenantOf(a.tenantId);
      return (t ? t.fullName : 'Unknown tenant') + ' (' + money(a.amount) + ')';
    });
  }
  async function doMarkBillAdminPaid(bill){
    try {
      bill.adminPaid = true;
      bill.adminPaidDate = TODAY;
      await persistBill(bill);
      showToast('Marked as paid to the provider.', 'success');
      render();
    } catch(err){
      return { blocked:true, message: friendlyErrorMessage(err) };
    }
  }
  /** Marking the provider paid used to be flatly disabled (a plain `disabled` button, so
   *  clicking it silently did nothing) until every tenant's share was paid. It's still marked as
   *  paid to the provider ONLY after this step, but now the admin can go ahead anyway — e.g.
   *  covering the gap themselves, or the provider needed paying regardless — as long as they've
   *  seen exactly who's still outstanding and confirm it deliberately. */
  async function markBillAdminPaid(billId){
    var bill = billOf(billId);
    if (!bill) return;
    if (billReadyForAdminPayment(bill)){
      var result = await doMarkBillAdminPaid(bill);
      if (result && result.blocked) showToast(result.message, 'error');
      return;
    }
    var owing = unpaidTenantAllocationLabels(bill);
    var body = (owing.length ? 'Still unpaid: ' + owing.join(', ') + '.' : 'Some tenants haven\'t paid their share yet.') +
      ' You can still mark this bill as paid to ' + bill.provider + ' — for example if you\'re covering the difference yourself — but their shares will still show as owed until they pay.';
    openConfirmModal('Not all tenants have paid yet', body, function(){ return doMarkBillAdminPaid(bill); },
      { confirmLabel: 'Mark as paid anyway' });
  }
  async function unmarkBillAdminPaid(billId){
    var bill = billOf(billId);
    if (!bill) return;
    try {
      bill.adminPaid = false;
      bill.adminPaidDate = null;
      await persistBill(bill);
      render();
    } catch(err){
      showToast('Could not undo this. ' + friendlyErrorMessage(err), 'error');
    }
  }
  window.markBillAdminPaid = markBillAdminPaid;
  window.unmarkBillAdminPaid = unmarkBillAdminPaid;

  /* ---------- Payment proof uploads (tenant's share receipt, or the admin's payment-to-provider receipt) ---------- */
  var receiptUploadTarget = null; // { billId, tenantId } — tenantId null means "the admin's own payment to the provider"
  function triggerReceiptUpload(billId, tenantId){
    receiptUploadTarget = { billId: billId, tenantId: tenantId || null };
    document.getElementById('receipt-input').click();
  }
  async function handleReceiptFile(event){
    var file = event.target.files && event.target.files[0];
    event.target.value = '';
    var target = receiptUploadTarget;
    receiptUploadTarget = null;
    if (!file || !target) return;
    var bill = billOf(target.billId);
    if (!bill) return;
    try {
      var idForPath = target.billId + (target.tenantId ? ('-' + target.tenantId) : '-admin');
      var path = await storageService.uploadReceipt(idForPath, file);
      if (target.tenantId){
        var alloc = bill.allocations && bill.allocations.find(function(a){ return a.tenantId===target.tenantId; });
        if (!alloc) return;
        await billAllocationService.setReceipt(alloc.id, path);
        alloc.receiptPath = path;
      } else {
        bill.adminReceiptPath = path;
        await persistBill(bill);
      }
      showToast('Receipt uploaded.', 'success');
      render();
    } catch(err){
      showToast('Could not upload the receipt. ' + friendlyErrorMessage(err), 'error');
    }
  }
  async function viewReceipt(bucket, path){
    try {
      var url = await storageService.getSignedUrl(bucket, path);
      window.open(url, '_blank');
    } catch(err){
      showToast('Could not open the receipt. ' + friendlyErrorMessage(err), 'error');
    }
  }
  window.triggerReceiptUpload = triggerReceiptUpload;
  window.handleReceiptFile = handleReceiptFile;
  window.viewReceipt = viewReceipt;

  /* ---------- PHASE 12: Documents (lease agreements, ID copies, other) ---------- */
  var tenantDocuments = [];
  var pendingDocFile = null;
  function triggerDocInput(kind){
    var inputId = kind==='camera' ? 'doc-input-camera' : kind==='gallery' ? 'doc-input-gallery' : 'doc-input-pdf';
    document.getElementById(inputId).click();
  }
  function handleDocFile(evt){
    var file = evt.target.files && evt.target.files[0];
    evt.target.value = '';
    if (!file) return;
    if (pendingDocFile && pendingDocFile.previewUrl) URL.revokeObjectURL(pendingDocFile.previewUrl);
    var isImage = file.type.indexOf('image/') === 0;
    pendingDocFile = {
      fileName: file.name || (isImage ? 'photo.jpg' : 'document.pdf'),
      kind: isImage ? 'image' : 'pdf',
      previewUrl: URL.createObjectURL(file),
      file: file
    };
    renderDocPreview();
  }
  function renderDocPreview(){
    var picker = document.getElementById('doc-modal-picker');
    var preview = document.getElementById('doc-modal-preview');
    var img = document.getElementById('doc-preview-img');
    var fileChip = document.getElementById('doc-preview-file');
    var nameEl = document.getElementById('doc-preview-name');
    var confirmBtn = document.getElementById('doc-modal-confirm');
    if (!pendingDocFile){
      picker.hidden = false; preview.hidden = true; confirmBtn.hidden = true;
      img.hidden = true; fileChip.hidden = true;
      return;
    }
    picker.hidden = true; preview.hidden = false; confirmBtn.hidden = false;
    if (pendingDocFile.kind === 'image'){
      img.src = pendingDocFile.previewUrl; img.hidden = false; fileChip.hidden = true;
    } else {
      img.hidden = true; fileChip.hidden = false;
    }
    nameEl.textContent = pendingDocFile.fileName;
  }
  function openDocModal(){
    pendingDocFile = null;
    renderDocPreview();
    document.getElementById('doc-modal').hidden = false;
  }
  function closeDocModal(){
    if (pendingDocFile && pendingDocFile.previewUrl) URL.revokeObjectURL(pendingDocFile.previewUrl);
    pendingDocFile = null;
    document.getElementById('doc-modal').hidden = true;
  }
  async function confirmAddDocument(){
    if (!pendingDocFile) return;
    var tenantId = document.getElementById('doc-tenant').value;
    var docType = document.getElementById('doc-type').value;
    var confirmBtn = document.getElementById('doc-modal-confirm');
    var originalLabel = confirmBtn ? confirmBtn.textContent : '';
    if (confirmBtn){ confirmBtn.disabled = true; confirmBtn.textContent = 'Uploading…'; }
    try {
      var storagePath = await storageService.uploadDocument(tenantId, pendingDocFile.file);
      var saved = await tenantDocumentService.create({ tenantId: tenantId, docType: docType, storagePath: storagePath, fileName: pendingDocFile.fileName });
      saved.previewUrl = pendingDocFile.previewUrl;
      saved.kind = pendingDocFile.kind;
      tenantDocuments.push(saved);
      pendingDocFile = null;
      document.getElementById('doc-modal').hidden = true;
      showToast('Document saved successfully.', 'success');
      await refreshOperationsReadModels();
      render();
    } catch(err){
      showToast('Could not save this document. ' + friendlyErrorMessage(err), 'error');
    } finally {
      if (confirmBtn){ confirmBtn.disabled = false; confirmBtn.textContent = originalLabel; }
    }
  }
  async function removeTenantDocument(id){
    var doc = tenantDocuments.find(function(d){ return d.id===id; });
    try {
      await tenantDocumentService.remove(id);
      if (doc && doc.previewUrl) URL.revokeObjectURL(doc.previewUrl);
      tenantDocuments = tenantDocuments.filter(function(d){ return d.id!==id; });
      render();
    } catch(err){
      showToast('Could not remove this document. ' + friendlyErrorMessage(err), 'error');
    }
  }
  window.triggerDocInput = triggerDocInput;
  window.handleDocFile = handleDocFile;
  window.openDocModal = openDocModal;
  window.closeDocModal = closeDocModal;
  window.confirmAddDocument = confirmAddDocument;
  window.removeTenantDocument = removeTenantDocument;

  var DOC_TYPE_LABEL = { lease:'Lease agreement', id:'ID copy', invoice:'Invoice', technician_report:'Technician report', warranty:'Warranty', other:'Other' };

  var docsSearchQuery = '';
  var docsTypeFilter = 'all';
  var docsPropertyFilter = 'all';
  var docsSortDir = 'desc'; // 'desc' = newest first (default), 'asc' = oldest first
  function setDocsSearchQuery(v){ docsSearchQuery = v; renderPreservingScroll(); }
  window.setDocsSearchQuery = setDocsSearchQuery;
  function setDocsTypeFilter(v){ docsTypeFilter = v; renderPreservingScroll(); }
  window.setDocsTypeFilter = setDocsTypeFilter;
  function setDocsPropertyFilter(v){ docsPropertyFilter = v; renderPreservingScroll(); }
  window.setDocsPropertyFilter = setDocsPropertyFilter;
  function toggleDocsSort(){ docsSortDir = (docsSortDir === 'desc') ? 'asc' : 'desc'; renderPreservingScroll(); }
  window.toggleDocsSort = toggleDocsSort;

  function renderDocuments(){
    var q = docsSearchQuery.trim().toLowerCase();
    var filtered = tenantDocuments.filter(function(d){
      if (q && (d.fileName||'').toLowerCase().indexOf(q) === -1) return false;
      if (docsTypeFilter !== 'all' && d.docType !== docsTypeFilter) return false;
      if (docsPropertyFilter !== 'all'){
        var t = tenantOf(d.tenantId);
        if (!t || t.propertyId !== docsPropertyFilter) return false;
      }
      return true;
    });
    filtered = filtered.slice().sort(function(a,b){
      var av = a.addedAt || '', bv = b.addedAt || '';
      return docsSortDir === 'desc' ? bv.localeCompare(av) : av.localeCompare(bv);
    });

    var typeOptions = '<option value="all"'+(docsTypeFilter==='all'?' selected':'')+'>All types</option>'+
      Object.keys(DOC_TYPE_LABEL).map(function(k){
        return '<option value="'+k+'"'+(docsTypeFilter===k?' selected':'')+'>'+esc(DOC_TYPE_LABEL[k])+'</option>';
      }).join('');
    var propertyFilterHtml = '';
    if (properties.length > 1){
      var propertyOptions = '<option value="all"'+(docsPropertyFilter==='all'?' selected':'')+'>All properties</option>'+
        properties.slice().sort(function(a,b){ return a.name.localeCompare(b.name); }).map(function(p){
          return '<option value="'+p.id+'"'+(docsPropertyFilter===p.id?' selected':'')+'>'+esc(p.name)+'</option>';
        }).join('');
      propertyFilterHtml = '<div style="flex:1;min-width:160px;">'+
        '<label style="font-size:11.5px;color:var(--text-faint);display:block;margin-bottom:4px;">Filter by property</label>'+
        '<select class="modal-input" onchange="setDocsPropertyFilter(this.value)">'+propertyOptions+'</select>'+
        '</div>';
    }
    var docsFilterHtml = '<div style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0;align-items:flex-end;">'+
      '<div style="flex:2;min-width:180px;">'+
      '<label style="font-size:11.5px;color:var(--text-faint);display:block;margin-bottom:4px;">Search by file name</label>'+
      '<input class="modal-input" type="text" value="'+esc(docsSearchQuery)+'" placeholder="Search documents…" oninput="setDocsSearchQuery(this.value)" />'+
      '</div>'+
      '<div style="flex:1;min-width:160px;">'+
      '<label style="font-size:11.5px;color:var(--text-faint);display:block;margin-bottom:4px;">Filter by type</label>'+
      '<select class="modal-input" onchange="setDocsTypeFilter(this.value)">'+typeOptions+'</select>'+
      '</div>'+
      propertyFilterHtml+
      '<button type="button" class="mini-btn" style="flex:1;min-width:160px;" onclick="toggleDocsSort()">Date: '+(docsSortDir==='desc'?'Newest first ▾':'Oldest first ▴')+'</button>'+
      '</div>';

    var tenantDocsHtml = tenantDocuments.length === 0
      ? emptyState('document', 'No tenant documents yet',
          'Save a lease agreement, ID copy or other file for a tenant.',
          '<button class="mini-btn primary" onclick="openDocModal()">+ Add document</button>')
      : docsFilterHtml + (filtered.length === 0
          ? emptyState('document', 'No documents', 'No documents match your search or filters.', '')
          : '<div class="card">' + filtered.map(function(d){
              var t = tenantOf(d.tenantId);
              return '<div class="row" style="border:none;padding:8px 0;">'+
                '<div class="who"><div class="name">'+esc(t?t.fullName:'—')+' — '+esc(DOC_TYPE_LABEL[d.docType]||'Other')+'</div>'+
                '<div class="meta">'+esc(d.fileName)+' • added '+shortDate(d.addedAt)+'</div></div>'+
                '<button class="del" title="Remove" onclick="removeTenantDocument(\''+d.id+'\')">✕</button></div>';
            }).join('') + '</div>');

    var billsSectionHtml = '<h2 style="margin:18px 0 10px;font-size:13px;font-weight:650;color:var(--text-dim);'+
      'text-transform:uppercase;letter-spacing:.04em;">Bills</h2>' +
      (bills.length === 0
        ? emptyState('receipt', 'No bills yet', 'Bills you add will show up here too.', '')
        : bills.map(billCard).join(''));

    return pageHeader('Documents', 'Bills, leases, ID copies and everything else on file.') +
      '<div class="detail-head" style="align-items:center;"><h2 style="margin:0;">Tenant documents</h2>'+
      '<button class="mini-btn primary" onclick="openDocModal()">+ Add document</button></div>'+
      tenantDocsHtml + billsSectionHtml;
  }

  function billCard(b){
    var p = propertyOf(b.propertyId);
    return '<a class="card" style="display:block;text-decoration:none;color:inherit;" href="#/bills/'+b.id+'">'+
      '<div class="row" style="border:none;padding:0;">'+
      '<div class="who"><div class="name">'+esc(billTypeLabel(b.billType))+'</div>'+
      '<div class="meta">'+esc(b.provider)+' • '+esc(p?p.name:'—')+' • '+shortDate(b.billingPeriodStart)+' – '+shortDate(b.billingPeriodEnd)+'</div></div>'+
      '<div class="amount">'+money(b.amount)+'<br/>'+billStatusBadge(b)+(b.adminPaid?' '+badge('paid','Sent to provider'):'')+'</div>'+
      '</div></a>';
  }

  /** Summary of "what the tenants have to pay" for the Bills table: how many have already
   *  paid their share and how much has been collected of the total. */
  function billTenantPaymentsSummary(b){
    if (b.allocations && b.allocations.length){
      var tenantAllocs = b.allocations.filter(function(a){ return !a.isAdmin; });
      var paidCount = tenantAllocs.filter(function(a){ return a.paid; }).length;
      return '<div>'+paidCount+'/'+tenantAllocs.length+' tenants</div>'+
        '<div style="font-size:11px;color:var(--text-faint);font-weight:400;">'+money(billPaidAmount(b))+' of '+money(b.amount)+'</div>';
    }
    return '<span style="color:var(--text-faint);">Not yet allocated</span>';
  }
  /** Summary of "what the administrator has to pay the provider" — the second leg of the
   *  payment, separate from billTenantPaymentsSummary (see billReadyForAdminPayment). */
  function billAdminPaymentSummary(b){
    if (b.adminPaid) return badge('paid', 'Paid'+(b.adminPaidDate?(' '+shortDate(b.adminPaidDate)):''));
    return billReadyForAdminPayment(b) ? badge('due','Ready to pay') : badge('neutral','Waiting on tenants');
  }
  /** Current sort order for the bills table — the user can tap any header to
   *  sort by provider, property, dates or payments; tapping the same column again
   *  reverses the direction. Persists while navigating between Bills tabs/filters. */
  var billsSortColumn = 'dueDate';
  var billsSortDir = 'desc'; // 'asc' | 'desc'
  var BILLS_SORT_DEFAULT_DIR = { provider:'asc', property:'asc', issueDate:'desc', dueDate:'desc', amount:'desc', tenantPayments:'desc', providerPayment:'desc', status:'asc' };
  function setBillsSort(col){
    if (billsSortColumn === col) billsSortDir = (billsSortDir === 'asc') ? 'desc' : 'asc';
    else { billsSortColumn = col; billsSortDir = BILLS_SORT_DEFAULT_DIR[col] || 'asc'; }
    renderPreservingScroll();
  }
  window.setBillsSort = setBillsSort;
  function billsSortValue(b, col){
    switch(col){
      case 'provider': return (b.provider || '').toLowerCase();
      case 'property': var p = propertyOf(b.propertyId); return (p ? p.name : '').toLowerCase();
      case 'issueDate': return b.issueDate || '';
      case 'dueDate': return b.dueDate || '';
      case 'amount': return b.amount || 0;
      case 'tenantPayments': return billPaidAmount(b);
      case 'providerPayment': return b.adminPaid ? 1 : 0;
      case 'status': return billEffectiveStatus(b);
      default: return '';
    }
  }
  /** Applies the current sort order (billsSortColumn/billsSortDir) to an already filtered list of bills. */
  function sortBillsList(list){
    var col = billsSortColumn, dir = billsSortDir === 'asc' ? 1 : -1;
    return list.slice().sort(function(a, b){
      var av = billsSortValue(a, col), bv = billsSortValue(b, col);
      var cmp = (typeof av === 'number' && typeof bv === 'number') ? (av - bv) : String(av).localeCompare(String(bv));
      if (cmp === 0) cmp = (b.dueDate || '').localeCompare(a.dueDate || ''); // stable tie-breaker
      return cmp * dir;
    });
  }
  function billsSortArrow(col){
    if (billsSortColumn !== col) return '';
    return ' <span style="font-size:9px;">'+(billsSortDir==='asc'?'▲':'▼')+'</span>';
  }
  function billsTableHtml(list, showPropertyCol){
    var cols = [['provider','Provider']];
    if (showPropertyCol) cols.push(['property','Property']);
    cols.push(['issueDate','Issue date'], ['dueDate','Due date'], ['amount','Total'], ['tenantPayments','Tenant payments'], ['providerPayment','Payment to provider'], ['status','Status']);
    var head = '<tr>'+cols.map(function(c){
      return '<th class="sortable-th" onclick="setBillsSort(\''+c[0]+'\')">'+c[1]+billsSortArrow(c[0])+'</th>';
    }).join('')+'</tr>';
    var body = list.map(function(b){
      var p = propertyOf(b.propertyId);
      return '<tr class="report-row-link" onclick="location.hash=\'#/bills/'+b.id+'\'">'+
        '<td><div style="font-weight:650;">'+esc(b.provider)+'</div>'+
        '<div style="font-size:11px;color:var(--text-faint);">'+esc(billTypeLabel(b.billType))+'</div></td>'+
        (showPropertyCol ? '<td>'+esc(p?p.name:'—')+'</td>' : '')+
        '<td>'+(b.issueDate?shortDate(b.issueDate):'—')+'</td>'+
        '<td>'+(b.dueDate?shortDate(b.dueDate):'—')+'</td>'+
        '<td style="font-weight:650;">'+money(b.amount)+'</td>'+
        '<td>'+billTenantPaymentsSummary(b)+'</td>'+
        '<td>'+billAdminPaymentSummary(b)+'</td>'+
        '<td>'+billStatusBadge(b)+(billHasPendingPaymentReport(b) ? ' ' + badge('upcoming','Payment reported') : '')+'</td>'+
        '</tr>';
    }).join('');
    return '<div class="card"><div class="report-table-wrap"><table class="report-table bills-table"><thead>'+head+'</thead><tbody>'+body+'</tbody></table></div></div>';
  }

  var billsViewTab = 'list'; // 'list' | 'missing' | 'recurring'
  function setBillsViewTab(tab){
    billsViewTab = tab;
    renderPreservingScroll();
  }
  window.setBillsViewTab = setBillsViewTab;
  function billsViewTabsHtml(){
    return '<div class="filter-chips" style="margin-bottom:10px;">'+
      '<button class="chip'+(billsViewTab==='list'?' active':'')+'" onclick="setBillsViewTab(\'list\')">Bills</button>'+
      '<button class="chip'+(billsViewTab==='missing'?' active':'')+'" onclick="setBillsViewTab(\'missing\')">Missing invoices</button>'+
      '<button class="chip'+(billsViewTab==='recurring'?' active':'')+'" onclick="setBillsViewTab(\'recurring\')">Recurring bills</button>'+
      '</div>';
  }

  function renderBills(){
    var tabBody = billsViewTab==='missing' ? renderMissingInvoicesTab()
      : billsViewTab==='recurring' ? renderRecurringBillsTab()
      : renderBillsListTab();
    return billsViewTabsHtml() + tabBody;
  }

  /** Its own top-level Bills tab (moved out of the main bills list, which was getting crowded) —
   *  reuses the same property chips filter as the list tab. */
  function renderRecurringBillsTab(){
    var propertyTabsHtml = properties.length===0 ? '' : '<div class="filter-chips" style="margin-bottom:10px;">'+
      '<button class="chip'+(billsPropertyFilter==='all'?' active':'')+'" onclick="setBillsPropertyFilter(\'all\')">All properties</button>'+
      properties.slice().sort(function(a,b){ return a.name.localeCompare(b.name); }).map(function(p){
        return '<button class="chip'+(billsPropertyFilter===p.id?' active':'')+'" onclick="setBillsPropertyFilter(\''+p.id+'\')">'+esc(p.name)+'</button>';
      }).join('') + '</div>';
    return pageHeader('Recurring bills', 'Bills that repeat every month, generated automatically when they come due.') +
      propertyTabsHtml + recurringBillsCardHtml(billsPropertyFilter);
  }

  /** Consolidates, per tenant, how much they still owe across all the (non-admin) bill shares
   *  assigned to them within `scopedBills` — e.g. "Ana owes $340 across 3 unpaid bill shares".
   *  Mirrors the same allocation-sum logic Payments uses (unpaidBillAllocationsFor), just
   *  grouped by tenant and totalled instead of listed bill-by-bill. Tenants with nothing
   *  outstanding are left out entirely — this is a "who still owes on bills" view, not a
   *  roster of every tenant. */
  function pendingBillsByTenantHtml(scopedBills){
    var byTenant = {}; // tenantId -> { amount, items: [{bill, alloc}] }
    scopedBills.forEach(function(b){
      if (!b.allocations) return;
      b.allocations.forEach(function(a){
        if (a.isAdmin || a.paid || !a.tenantId) return;
        var entry = byTenant[a.tenantId] || { amount: 0, items: [] };
        entry.amount += a.amount;
        entry.items.push({ bill:b, alloc:a });
        byTenant[a.tenantId] = entry;
      });
    });
    var rows = Object.keys(byTenant).map(function(tenantId){
      var t = tenantOf(tenantId);
      var items = byTenant[tenantId].items.slice().sort(function(x,y){
        // Overdue/soonest-due first — the ones the tenant should pay first show at the top.
        return (x.bill.dueDate||'9999-99-99').localeCompare(y.bill.dueDate||'9999-99-99');
      });
      return { tenant: t, tenantId: tenantId, amount: round2(byTenant[tenantId].amount), items: items };
    }).filter(function(r){ return r.amount > 0.004; })
      .sort(function(a,b){ return b.amount - a.amount; });
    if (!rows.length) return '';
    var grandTotal = rows.reduce(function(s,r){ return s+r.amount; }, 0);
    /** One unpaid bill share under a tenant's row — same info + action as the Payments tab's
     *  own "Bills" section, so the admin can mark it paid right from this consolidated view
     *  without having to go find the tenant in Payments. */
    function itemRowHtml(item){
      var b = item.bill, a = item.alloc;
      var overdue = b.dueDate && b.dueDate < TODAY;
      return '<div class="alloc-summary-row" style="align-items:center;flex-wrap:wrap;padding-left:10px;">'+
        '<div class="who"><div style="font-weight:400;">'+esc(billTypeLabel(b.billType))+' — '+esc(b.provider)+'</div>'+
        '<div class="meta">'+(b.dueDate?('Due '+shortDate(b.dueDate)):'No due date')+'</div></div>'+
        '<div style="display:flex;align-items:center;gap:8px;">'+
        (overdue ? badge('overdue','Overdue') : badge('due','Unpaid'))+
        '<b>'+money(a.amount)+'</b>'+
        '<button class="mini-btn primary" style="padding:2px 8px;font-size:11px;" onclick="openAllocPaidModal(\''+b.id+'\',\''+item.alloc.tenantId+'\')">Mark as paid</button>'+
        '</div></div>';
    }
    var body = rows.map(function(r){
      var prop = r.tenant ? properties.find(function(p){ return p.id===r.tenant.propertyId; }) : null;
      var itemsHtml = r.items.map(itemRowHtml).join('');
      var waHtml = r.tenant ? pendingBillsWhatsAppRowHtml(r.tenant, r.items, prop) : '';
      return '<details class="pending-bills-tenant">'+
        '<summary class="field-row" style="cursor:pointer;list-style:none;"><span class="k">'+esc(r.tenant ? r.tenant.fullName : 'Unknown tenant')+
        (prop ? ' <span style="color:var(--text-faint);font-weight:400;">· '+esc(prop.name)+'</span>' : '')+
        '</span><span class="v">'+money(r.amount)+' <span style="color:var(--text-faint);font-weight:400;">('+r.items.length+' bill'+(r.items.length===1?'':'s')+' — tap to see which)</span></span></summary>'+
        waHtml+itemsHtml+
        '</details>';
    }).join('');
    return '<div class="card">'+
      '<div class="detail-head" style="margin-top:0;"><h2 style="margin:0;font-size:14px;">Pending bills by tenant</h2></div>'+
      '<div class="field-list">'+body+'</div>'+
      '<div class="field-row" style="margin-top:6px;border-top:1px solid var(--border);padding-top:6px;">'+
      '<span class="k" style="font-weight:600;">Total</span><span class="v" style="font-weight:600;">'+money(grandTotal)+'</span></div>'+
      '</div>';
  }

  function renderBillsListTab(){
    // Property tab — "All properties" or a specific one; the status filter (chips)
    // and the stats are computed AFTER applying this, so each tab shows its own
    // numbers instead of the whole portfolio's.
    var propertyScoped = billsPropertyFilter==='all' ? bills : bills.filter(function(b){ return b.propertyId===billsPropertyFilter; });
    var propertyTabsHtml = properties.length===0 ? '' : '<div class="filter-chips" style="margin-bottom:10px;">'+
      '<button class="chip'+(billsPropertyFilter==='all'?' active':'')+'" onclick="setBillsPropertyFilter(\'all\')">All properties</button>'+
      properties.slice().sort(function(a,b){ return a.name.localeCompare(b.name); }).map(function(p){
        return '<button class="chip'+(billsPropertyFilter===p.id?' active':'')+'" onclick="setBillsPropertyFilter(\''+p.id+'\')">'+esc(p.name)+'</button>';
      }).join('') + '</div>';

    // "Pending" and "Paid" use the ACTUALLY collected amount (billPaidAmount),
    // not an all-or-nothing cut by bill.status: a partially paid bill
    // contributes its collected share to "Paid" and the rest to "Pending", just like
    // Reports (billPaidAmount/billOutstandingAmount above).
    var pendingTotal = propertyScoped.reduce(function(s,b){ return s+billOutstandingAmount(b); },0);
    var overdueCount = propertyScoped.filter(function(b){ return billEffectiveStatus(b)==='overdue'; }).length;
    var paidTotal = propertyScoped.reduce(function(s,b){ return s+billPaidAmount(b); },0);

    var statHtml = '<div class="stat-grid cols-3">'+
      '<div class="stat"><div class="label">Pending</div><div class="value'+(pendingTotal>0?' warn':'')+'">'+money(pendingTotal)+'</div></div>'+
      '<div class="stat"><div class="label">Overdue</div><div class="value'+(overdueCount>0?' warn':'')+'">'+overdueCount+'</div></div>'+
      '<div class="stat"><div class="label">Paid</div><div class="value">'+money(paidTotal)+'</div></div>'+
      '</div>';

    var chipsHtml = '<div class="filter-chips">' + BILLS_FILTERS.map(function(f){
      return '<button class="chip'+(billsFilter===f[0]?' active':'')+'" onclick="setBillsFilter(\''+f[0]+'\')">'+f[1]+'</button>';
    }).join('') + '</div>';

    var filtered = sortBillsList(propertyScoped.filter(function(b){ return billMatchesFilter(b, billsFilter); }));
    var rows = filtered.length===0
      ? (propertyScoped.length===0
          ? emptyState('receipt', 'No bills yet',
              billsPropertyFilter==='all'
                ? 'Add your first electricity, water, gas or internet bill to start tracking what\'s owed.'
                : 'No bills recorded for this property yet.',
              '<button class="mini-btn primary" onclick="openImportModal()">+ Add bill</button>')
          : emptyState('receipt', 'Nothing in this filter', 'Try a different filter, or choose "All" to see every bill.', ''))
      : billsTableHtml(filtered, billsPropertyFilter==='all');

    return '<div class="detail-head">'+pageHeader('Bills', 'Electricity, gas, water, internet and more.')+
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">'+
      '<button class="mini-btn primary" style="display:flex;align-items:center;gap:6px;white-space:nowrap;" onclick="openImportModal()">'+svg('plus','style="width:14px;height:14px;"')+'Add bill</button>'+
      '</div></div>'+
      importQueueCard() + propertyTabsHtml + billsTimelineHtml() + statHtml +
      pendingBillsByTenantHtml(propertyScoped) + chipsHtml + rows;
  }

  /* ============ "Missing invoices" tab — local calculation based on the average of past invoices ============
   * No longer depends on AI (the predict-bills Edge Function) — that dependency used to fail
   * often ("AI service is overloaded"). Instead, for each property + service type with at
   * least 2 bills loaded, it computes the actual AVERAGE interval between consecutive invoices
   * (instead of a fixed 45-day threshold for everyone) and projects the next expected date
   * from the last invoice — so it adapts on its own to each provider (monthly, quarterly,
   * etc.) and improves as more bills get loaded. It also estimates the expected amount
   * as the average of the amounts already seen. It's pure local computation, no network — it's
   * recomputed on every render(), always with the most recent data. */
  function computeMissingInvoicePredictions(){
    function dateOf(b){ return b.billingPeriodStart || b.issueDate || b.dueDate || null; }
    var groups = {};
    bills.forEach(function(b){
      if (BILL_RECURRING_TYPES.indexOf(b.billType) === -1 || !dateOf(b)) return;
      var key = b.propertyId + '|' + b.billType;
      (groups[key] = groups[key] || []).push(b);
    });
    var predictions = [];
    Object.keys(groups).forEach(function(key){
      var list = groups[key].slice().sort(function(a,b){ return dateOf(a).localeCompare(dateOf(b)); });
      if (list.length < 2) return; // need at least 2 to know the usual pace
      var intervals = [];
      for (var i=1;i<list.length;i++) intervals.push(daysBetween(dateOf(list[i-1]), dateOf(list[i])));
      var avgInterval = Math.round(intervals.reduce(function(s,n){ return s+n; }, 0) / intervals.length);
      if (avgInterval <= 0) return;
      var last = list[list.length-1];
      var lastDate = dateOf(last);
      var predictedNextDate = stepDateIso(lastDate, avgInterval);
      var daysOverdue = daysBetween(predictedNextDate, TODAY);
      if (daysOverdue <= 0) return; // not due yet, based on its own historical pace
      var estimatedAmount = round2(list.reduce(function(s,b){ return s + (b.amount||0); }, 0) / list.length);
      var p = properties.find(function(x){ return x.id===last.propertyId; });
      predictions.push({
        propertyId: last.propertyId, propertyName: p ? p.name : '—',
        billType: last.billType, provider: last.provider,
        lastBillDate: lastDate, predictedNextDate: predictedNextDate, daysOverdue: daysOverdue,
        estimatedAmount: estimatedAmount, sampleCount: list.length, avgInterval: avgInterval
      });
    });
    // Sorted by how FREQUENTLY the bill recurs (its own average interval), not by raw days
    // overdue — a bill that comes every ~30 days (monthly) is a much stronger, more likely-
    // to-be-real signal of "this one's about to arrive" than one that comes every ~60 days
    // (bimonthly) but happens to look more overdue in absolute days. Same-frequency ties fall
    // back to days overdue, most overdue first.
    return predictions.sort(function(a,b){
      if (a.avgInterval !== b.avgInterval) return a.avgInterval - b.avgInterval;
      return b.daysOverdue - a.daysOverdue;
    });
  }

  function missingInvoiceRowHtml(pred){
    var overdueTxt = pred.daysOverdue+' day'+(pred.daysOverdue===1?'':'s')+' overdue';
    return '<div class="card">'+
      '<div class="detail-head" style="margin-top:0;align-items:center;"><h2 style="margin:0;font-size:14px;">'+esc(billTypeLabel(pred.billType))+' — '+esc(pred.provider)+'</h2>'+
      badge('overdue', overdueTxt)+'</div>'+
      '<p style="font-size:12.5px;color:var(--text-dim);margin:2px 0;">'+esc(pred.propertyName)+'</p>'+
      '<div class="field-list">'+
      '<div class="field-row"><span class="k">Last bill</span><span class="v">'+shortDate(pred.lastBillDate)+'</span></div>'+
      '<div class="field-row"><span class="k">Expected around</span><span class="v">'+shortDate(pred.predictedNextDate)+'</span></div>'+
      '<div class="field-row"><span class="k">Estimated amount</span><span class="v">'+money(pred.estimatedAmount)+'</span></div>'+
      '</div>'+
      '<p style="font-size:12px;color:var(--text-faint);margin:8px 0 0;">Based on '+pred.sampleCount+' past bills for this provider, about every '+pred.avgInterval+' days on average.</p>'+
      '<button class="mini-btn primary" style="margin-top:10px;" onclick="setBillsViewTab(\'list\');openImportModal();">+ Add this bill</button>'+
      '</div>';
  }

  function renderMissingInvoicesTab(){
    var header = pageHeader('Missing invoices', "Looks at each property's own billing history — the average time between its past invoices — to guess when the next one should arrive, and flags the ones that seem overdue. Improves automatically as more bills are loaded.");
    var predictions = computeMissingInvoicePredictions();
    if (!predictions.length){
      return header + emptyState('receipt', 'Nothing missing', "Every recurring bill on file looks up to date — nothing seems overdue based on each property's usual pattern.", '');
    }
    return header + predictions.map(missingInvoiceRowHtml).join('');
  }

  /** Detects "recurring" bills (electricity, water, hot water, gas, internet — not "other") that
   *  have gone more than ~45 days without a new one loaded, compared to the last one that did
   *  arrive, for that property + type. Only applies once there are at least 2 bills of that
   *  type for that property (otherwise there isn't yet a pattern to say anything is "missing"). */
  var BILL_RECURRING_TYPES = ['electricity','water','hot_water','gas','internet'];
  function detectMissingBills(){
    var byKey = {};
    var countByKey = {};
    bills.forEach(function(b){
      if (BILL_RECURRING_TYPES.indexOf(b.billType) === -1) return;
      var key = b.propertyId + '|' + b.billType;
      countByKey[key] = (countByKey[key] || 0) + 1;
      var latestDate = b.billingPeriodEnd || b.dueDate || b.issueDate || '';
      var existingDate = byKey[key] ? (byKey[key].billingPeriodEnd || byKey[key].dueDate || byKey[key].issueDate || '') : '';
      if (!byKey[key] || latestDate > existingDate) byKey[key] = b;
    });
    var gaps = [];
    Object.keys(byKey).forEach(function(key){
      if (countByKey[key] < 2) return;
      var last = byKey[key];
      var lastDate = last.billingPeriodEnd || last.dueDate || last.issueDate;
      if (!lastDate) return;
      var daysSince = Math.round((new Date(TODAY) - new Date(lastDate)) / 86400000);
      if (daysSince > 45){
        var prop = properties.find(function(p){ return p.id===last.propertyId; });
        gaps.push({ propertyId:last.propertyId, propertyName: prop ? prop.name : '—', billType:last.billType, lastDate:lastDate, daysSince:daysSince });
      }
    });
    return gaps;
  }

  /** Which status color a bill maps to, reusing the same criteria as
   *  billStatusBadge (see below) — so the timeline bar and the table badge
   *  always match the same color for the same bill. */
  var BILL_TIMELINE_STATUS_COLOR = { paid:'paid', pending:'due', overdue:'overdue', allocated:'upcoming', partially_allocated:'due', partially_paid:'due' };
  var BILL_TIMELINE_STATUS_LABEL = { paid:'Paid', pending:'Pending', overdue:'Overdue', allocated:'Allocated', partially_allocated:'Partially allocated', partially_paid:'Partially paid' };
  function billTimelineColorVar(b){
    return 'var(--status-' + (BILL_TIMELINE_STATUS_COLOR[billEffectiveStatus(b)] || 'upcoming') + ')';
  }

  /** A real timeline (not a monthly grid) of the last 6 months by property ×
   *  bill type: each bill is drawn as a bar over the exact dates of its billing
   *  period (billingPeriodStart–billingPeriodEnd), colored according to its status (paid,
   *  pending, overdue). The striped background left visible between bars is a gap — a
   *  stretch of dates with no bill loaded. Respects the tab's property filter. */
  function billsTimelineHtml(){
    // Respects the same property chip ("All properties / Belmont / ...") that filters the table.
    var scopedProperties = billsPropertyFilter==='all' ? properties : properties.filter(function(p){ return p.id===billsPropertyFilter; });
    if (!scopedProperties.length) return '';
    var months = [];
    for (var i=5; i>=0; i--) months.push(addMonthsIso(TODAY.slice(0,7)+'-01', -i).slice(0,7));
    var rangeStart = months[0] + '-01';
    var rangeEnd = stepDateIso(addMonthsIso(months[5] + '-01', 1), -1); // last day of the most recent month
    var totalDays = daysBetween(rangeStart, rangeEnd) + 1;
    function pct(iso){ return Math.max(0, Math.min(100, 100 * daysBetween(rangeStart, iso) / totalDays)); }
    function monthLabel(ym){
      var names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      return names[parseInt(ym.slice(5,7),10)-1];
    }

    /** A bill from a row to draw as a bar: the position/size already comes resolved in %, with
     *  a small px inset on each side — so two consecutive bills (one ends and the other
     *  starts on the same day) show up as two separate bars, not a single merged one, making the
     *  date cut between them noticeable even when there's no real gap. */
    function timelineSegmentHtml(b){
      var segStart = b.billingPeriodStart < rangeStart ? rangeStart : b.billingPeriodStart;
      var segEnd = b.billingPeriodEnd > rangeEnd ? rangeEnd : b.billingPeriodEnd;
      var left = pct(segStart);
      var width = Math.max(1.2, pct(stepDateIso(segEnd, 1)) - left);
      var tip = esc(b.provider) + ': ' + shortDate(b.billingPeriodStart) + ' – ' + shortDate(b.billingPeriodEnd) +
        ' • ' + money(b.amount) + ' • ' + (BILL_TIMELINE_STATUS_LABEL[billEffectiveStatus(b)] || billEffectiveStatus(b));
      return '<div title="'+tip+'" onclick="event.stopPropagation();location.hash=\'#/bills/'+b.id+'\';" '+
        'style="position:absolute;top:1px;bottom:1px;left:calc('+left+'% + 1.5px);width:calc('+width+'% - 3px);min-width:2px;border-radius:3px;cursor:pointer;background:'+billTimelineColorVar(b)+';"></div>';
    }
    /** Splits bills of the same type into "the usual charge" (the amount that repeats most) and
     *  "adjustments" (a different amount — e.g. Kleenheat raises its rate every 3 months). Only
     *  splits when there's a clearly usual amount (repeats 2+ times); otherwise there's no
     *  "normal" to compare against and everything stays on a single line. */
    function splitByModalAmount(list){
      if (list.length < 2) return { regular: list, adjustments: [] };
      var counts = {};
      list.forEach(function(b){ var key = b.amount.toFixed(2); counts[key] = (counts[key] || 0) + 1; });
      var modeKey = null, modeCount = 0;
      Object.keys(counts).forEach(function(k){ if (counts[k] > modeCount){ modeCount = counts[k]; modeKey = k; } });
      if (modeCount < 2) return { regular: list, adjustments: [] };
      return {
        regular: list.filter(function(b){ return b.amount.toFixed(2) === modeKey; }),
        adjustments: list.filter(function(b){ return b.amount.toFixed(2) !== modeKey; })
      };
    }
    // "Today" vertical line — always recomputed against TODAY, so it moves on its own every
    // day without anything needing to be touched. It's drawn INSIDE each track (same % as the
    // bars, same rangeStart/rangeEnd) instead of a single overlay floating over the whole diagram,
    // so it stays perfectly aligned row by row without relying on measuring the layout with JS.
    var todayLeft = pct(TODAY);
    var todayLineHtml = '<div style="position:absolute;top:0;bottom:0;left:calc('+todayLeft+'% - 1px);width:2px;background:var(--text);opacity:0.55;pointer-events:none;"></div>';
    function timelineTrackRowHtml(label, faint, list){
      return '<div style="display:flex;align-items:center;gap:8px;margin:5px 0;">'+
        '<span style="font-size:'+(faint?'10px':'11.5px')+';color:'+(faint?'var(--text-faint)':'var(--text-dim)')+';width:72px;flex-shrink:0;'+(faint?'padding-left:8px;':'')+'">'+esc(label)+'</span>'+
        '<div class="timeline-track" style="position:relative;flex:1;height:18px;border-radius:4px;overflow:hidden;">'+list.map(timelineSegmentHtml).join('')+todayLineHtml+'</div></div>';
    }

    var rows = [];
    scopedProperties.slice().sort(function(a,b){ return a.name.localeCompare(b.name); }).forEach(function(p){
      var propBills = bills.filter(function(b){ return b.propertyId===p.id; });
      // Unlike detectMissingBills (which only looks at the truly "recurring" types),
      // the diagram has to reflect ALL payments — including "Other", where there might be
      // one-off charges or adjustments the admin classified separately from the main recurring
      // service (e.g. a rate adjustment from the same gas provider, saved as "Other" so it
      // doesn't mix with the usual monthly charge).
      var typesPresent = BILL_RECURRING_TYPES.concat(['other']).filter(function(t){ return propBills.some(function(b){ return b.billType===t; }); });
      propBills.forEach(function(b){ if (typesPresent.indexOf(b.billType) === -1) typesPresent.push(b.billType); });
      if (!typesPresent.length) return;
      var typeRows = typesPresent.map(function(bt){
        var typeBills = propBills.filter(function(b){
          return b.billType === bt && b.billingPeriodStart && b.billingPeriodEnd &&
            b.billingPeriodEnd >= rangeStart && b.billingPeriodStart <= rangeEnd;
        });
        var split = splitByModalAmount(typeBills);
        var html = timelineTrackRowHtml(billTypeLabel(bt), false, split.regular);
        if (split.adjustments.length) html += timelineTrackRowHtml('↳ rate change', true, split.adjustments);
        return html;
      }).join('');
      rows.push('<div style="margin-bottom:12px;"><div style="font-size:12.5px;font-weight:650;margin-bottom:4px;">'+esc(p.name)+'</div>'+typeRows+'</div>');
    });
    if (!rows.length) return '';

    var monthTicks = months.map(function(ym, i){
      var left = pct(ym + '-01');
      return '<span style="position:absolute;left:'+left+'%;font-size:9.5px;color:var(--text-faint);'+(i===0?'':'transform:translateX(-1px);')+'">'+monthLabel(ym)+'</span>';
    }).join('');
    var legendItem = function(colorVar, label){
      return '<span style="display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:var(--text-faint);margin-right:10px;">'+
        '<span style="width:9px;height:9px;border-radius:2px;background:'+colorVar+';display:inline-block;"></span>'+label+'</span>';
    };
    return '<div class="card">'+
      '<h2 style="text-transform:none;letter-spacing:0;font-size:13.5px;margin:0 0 6px;">Invoice timeline</h2>'+
      '<p style="font-size:11.5px;color:var(--text-faint);margin:0 0 10px;">Each bar is a bill, drawn across its actual billing period, with a small gap so consecutive bills stay visually separate. A bill priced differently from the usual amount (e.g. a rate change) gets its own "rate change" line instead of blending into the regular one. Striped gaps are stretches with no bill loaded. Tap a bar to open that bill.</p>'+
      '<div style="display:flex;gap:8px;margin-bottom:6px;"><span style="width:72px;flex-shrink:0;"></span><div style="position:relative;flex:1;height:12px;">'+monthTicks+'</div></div>'+
      rows.join('')+
      '<div style="margin-top:8px;">'+
      legendItem('var(--status-paid)','Paid') + legendItem('var(--status-due)','Due') +
      legendItem('var(--status-overdue)','Overdue') + legendItem('var(--status-upcoming)','Allocated') +
      '<span style="display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:var(--text-faint);margin-right:10px;">'+
      '<span class="timeline-track" style="width:9px;height:9px;border-radius:2px;display:inline-block;"></span>No bill loaded</span>'+
      '<span style="display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:var(--text-faint);">'+
      '<span style="width:2px;height:11px;background:var(--text);opacity:0.55;display:inline-block;"></span>Today</span>'+
      '</div>'+
      '</div>';
  }

  /** Generates the data-driven automatic notifications (check-out reminder, rent due/overdue,
   *  bill due/overdue, cleaning turn, bins) — one call per load, staff-only (mirrors
   *  checkMissingBillsNotifications below). Every rule uses notifyOnce with a stable dedupKey, so
   *  calling this on every bootstrap is safe and required — it's how "automatic" notifications
   *  actually get created in a backend-less app (see docs/superpowers/specs/2026-09-27-in-app-notifications-design.md §2/§5).
   *  Note: rentCharges statuses are 'paid' | 'partially_paid' | 'overdue' | 'upcoming' (not 'due') —
   *  mirrors the same overdue-vs-everything-else split buildCalendarEvents already uses. */
  async function ensureAutomaticNotifications(){
    if (isTenantRole() || !currentProfile) return;
    var createdByProfileId = currentProfile.id;

    // Check-in: fires the first time a tenant has BOTH a linked account and rent > 0 — accounts
    // are created separately from the tenant record (see saveUserForm), often well after the
    // tenant is created, so this can't only run once at creation time (it would silently never
    // fire for the common case). notifyOnce's dedup key makes re-checking every load safe: once
    // sent, it never repeats.
    for (var q=0; q<tenants.length; q++){
      var ct = tenants[q];
      if (ct.rentAmount <= 0 || !ct.authUserId) continue;
      await notificationService.notifyOnce(
        ct.authUserId, 'checkin:' + ct.id,
        'Welcome — your check-in time',
        'Your check-in time is 3:00 PM. Please make sure you arrive after the designated check-in time.',
        'tenants', ct.id,
        { category: 'check_in', propertyId: ct.propertyId, tenantId: ct.id, createdByProfileId: createdByProfileId }
      );
    }

    // Check-out: 7 days before the move-out date, for tenants who haven't moved out yet.
    for (var i=0; i<tenants.length; i++){
      var t = tenants[i];
      if (t.rentAmount <= 0 || tenantHasMovedOut(t)) continue;
      var moveOut = t.actualMoveOutDate || t.expectedMoveOutDate;
      if (!moveOut || !t.authUserId) continue;
      var daysUntil = daysBetween(TODAY, moveOut);
      if (daysUntil < 0 || daysUntil > 7) continue;
      await notificationService.notifyOnce(
        t.authUserId, 'checkout:' + t.id + ':' + moveOut,
        'Your check-out is coming up',
        'Your check-out time is 12:00 PM. Please make sure you have removed all your personal belongings and left the room and common areas clean.',
        'tenants', t.id,
        { category: 'check_out', propertyId: t.propertyId, tenantId: t.id, createdByProfileId: createdByProfileId }
      );
    }

    // Rent: one notification when a charge turns overdue, another when it's due within 3 days
    // (this also covers 'partially_paid' periods that haven't been fully settled yet). Guarded by
    // tenantHasMovedOut explicitly (not just relying on charge generation stopping at move-out).
    for (var j=0; j<rentCharges.length; j++){
      var c = rentCharges[j];
      if (c.status === 'paid') continue;
      var rt = tenantOf(c.tenantId);
      if (!rt || !rt.authUserId || tenantHasMovedOut(rt)) continue;
      if (c.status === 'overdue'){
        await notificationService.notifyOnce(
          rt.authUserId, 'rent_overdue:' + rt.id + ':' + c.dueDate,
          'Rent overdue', 'Your rent payment due ' + shortDate(c.dueDate) + ' (' + money(c.remaining) + ' remaining) is now overdue.',
          'tenants', rt.id, { category: 'rent', propertyId: rt.propertyId, tenantId: rt.id, createdByProfileId: createdByProfileId }
        );
      } else {
        var dueIn = daysBetween(TODAY, c.dueDate);
        if (dueIn < 0 || dueIn > 3) continue;
        await notificationService.notifyOnce(
          rt.authUserId, 'rent_upcoming:' + rt.id + ':' + c.dueDate,
          'Rent due soon', 'Your rent of ' + money(c.remaining) + ' is due ' + shortDate(c.dueDate) + '.',
          'tenants', rt.id, { category: 'rent', propertyId: rt.propertyId, tenantId: rt.id, createdByProfileId: createdByProfileId }
        );
      }
    }

    // Bills: same due-soon/overdue split, per unpaid tenant allocation — skipping the admin's own
    // share and any bill under the landlord's own hidden "RS" provider (never shown to tenants,
    // same rule isTenantHiddenProvider already enforces for the Bills UI). Dedup key is
    // bill+tenant, NOT the allocation id: replaceForBill deletes and reinserts allocations (new
    // ids) whenever a bill's split is edited, so keying on allocation id would re-notify on every edit.
    for (var k=0; k<bills.length; k++){
      var b = bills[k];
      if (!b.allocations || isTenantHiddenProvider(b.provider)) continue;
      for (var m=0; m<b.allocations.length; m++){
        var a = b.allocations[m];
        if (a.paid || a.isAdmin) continue;
        var bt = tenantOf(a.tenantId);
        if (!bt || !bt.authUserId || tenantHasMovedOut(bt)) continue;
        var overdue = billEffectiveStatus(b) === 'overdue';
        if (overdue){
          await notificationService.notifyOnce(
            bt.authUserId, 'bill_overdue:' + b.id + ':' + bt.id,
            'Bill overdue', billTypeLabel(b.billType) + ' (' + b.provider + ') — your share of ' + money(a.amount) + ' is overdue.',
            'bills', b.id, { category: 'bills', propertyId: bt.propertyId, tenantId: bt.id, createdByProfileId: createdByProfileId }
          );
        } else {
          var billDueIn = daysBetween(TODAY, b.dueDate);
          if (billDueIn < 0 || billDueIn > 3) continue;
          await notificationService.notifyOnce(
            bt.authUserId, 'bill_upcoming:' + b.id + ':' + bt.id,
            'Bill due soon', billTypeLabel(b.billType) + ' (' + b.provider + ') — your share of ' + money(a.amount) + ' is due ' + shortDate(b.dueDate) + '.',
            'bills', b.id, { category: 'bills', propertyId: bt.propertyId, tenantId: bt.id, createdByProfileId: createdByProfileId }
          );
        }
      }
    }

    // Cleaning: notify the current occupant of a room whose turn is today/tomorrow, or whose
    // turn has just become overdue. Stops once the task is completed (or closed not_completed) —
    // currentTenantOf() isn't right here — it returns the FIRST tenant ever recorded for the
    // room (tenants load oldest-first), which is often someone who has since moved out. Look up
    // the actual current occupant instead (same predicate roomIsOccupied() uses).
    for (var n=0; n<cleaningTasks.length; n++){
      var task = cleaningTasks[n];
      var effStatus = cleaningTaskEffectiveStatus(task);
      if (effStatus === 'completed' || effStatus === 'not_completed') continue;
      var occupant = tenants.find(function(x){ return x.roomId===task.roomId && !tenantHasMovedOut(x); });
      if (!occupant || !occupant.authUserId) continue;
      var room = roomOf(task.roomId);
      if (effStatus === 'overdue'){
        await notificationService.notifyOnce(
          occupant.authUserId, 'cleaning_overdue:' + task.id,
          'Cleaning overdue', "Your room's cleaning turn (" + (room?room.name:'') + ') is overdue.',
          'cleaning_tasks', task.id, { category: 'cleaning', propertyId: task.propertyId, tenantId: occupant.id, createdByProfileId: createdByProfileId }
        );
      } else {
        var taskDaysOut = daysBetween(TODAY, task.scheduledDate);
        if (taskDaysOut < 0 || taskDaysOut > 1) continue;
        await notificationService.notifyOnce(
          occupant.authUserId, 'cleaning_turn:' + task.id,
          'Your cleaning turn', "It's your room's turn for cleaning " + (taskDaysOut===0 ? 'today' : 'tomorrow') + ' (' + (room?room.name:'') + ').',
          'cleaning_tasks', task.id, { category: 'cleaning', propertyId: task.propertyId, tenantId: occupant.id, createdByProfileId: createdByProfileId }
        );
      }
    }

    // Bin OUT: notify only the current occupant of that task's own room (not the whole property)
    // — one dedup key per task, independent of the Cleaning notifications above. Stops once
    // completed/not_completed.
    for (var q=0; q<binOutTasks.length; q++){
      var binTask = binOutTasks[q];
      var binEffStatus = binOutTaskEffectiveStatus(binTask);
      if (binEffStatus === 'completed' || binEffStatus === 'not_completed') continue;
      var binOccupant = tenants.find(function(x){ return x.roomId===binTask.roomId && !tenantHasMovedOut(x); });
      if (!binOccupant || !binOccupant.authUserId) continue;
      var typeLabels = binTask.binTypes.map(function(bt){ return TRASH_TYPE_LABEL[bt] || bt; }).join(' & ');
      if (binEffStatus === 'overdue'){
        await notificationService.notifyOnce(
          binOccupant.authUserId, 'bin_out_overdue:' + binTask.id,
          'Bin OUT overdue', 'Your ' + typeLabels + ' bin(s) still need to go out.',
          'bin_out_tasks', binTask.id, { category: 'bins', propertyId: binTask.propertyId, tenantId: binOccupant.id, createdByProfileId: createdByProfileId }
        );
      } else {
        var binDaysOut = daysBetween(TODAY, binTask.pickupDate);
        if (binDaysOut < 0 || binDaysOut > 1) continue;
        await notificationService.notifyOnce(
          binOccupant.authUserId, 'bin_out_turn:' + binTask.id,
          'Bin OUT reminder', 'Your ' + typeLabels + ' bin(s) need to go out ' + (binDaysOut===0 ? 'today' : 'tomorrow') + '.',
          'bin_out_tasks', binTask.id, { category: 'bins', propertyId: binTask.propertyId, tenantId: binOccupant.id, createdByProfileId: createdByProfileId }
        );
      }
    }
  }

  /** Sends a notification (to the current user) for each detected gap that hasn't already
   *  been notified in the last 30 days — so the same alert isn't repeated every time the
   *  app is opened. Runs once per load, after generating the month's recurring bills. */
  async function checkMissingBillsNotifications(){
    if (isTenantRole() || !currentProfile) return;
    var gaps = detectMissingBills();
    if (!gaps.length) return;
    var cutoff = addMonthsIso(TODAY, -1);
    for (var i=0; i<gaps.length; i++){
      var g = gaps[i];
      var title = 'Missing bill: ' + billTypeLabel(g.billType) + ' at ' + g.propertyName;
      var alreadyNotified = notificationsList.some(function(n){
        return n.relatedTable==='bills' && n.relatedId===g.propertyId && n.title===title && n.createdAt && n.createdAt.slice(0,10) >= cutoff;
      });
      if (alreadyNotified) continue;
      var body = 'No ' + billTypeLabel(g.billType).toLowerCase() + ' bill has been loaded for ' + g.propertyName + ' since ' + shortDate(g.lastDate) + ' (' + g.daysSince + ' days ago). Add it once it arrives.';
      await notificationService.notify(currentProfile.authUserId, title, body, 'bills', g.propertyId);
      notificationsList.unshift({ id:'local-'+Date.now()+'-'+i, authUserId:currentProfile.authUserId, title:title, body:body, relatedTable:'bills', relatedId:g.propertyId, isRead:false, createdAt:new Date().toISOString() });
    }
  }

  /** "Recurring bills": templates for gas/internet/etc. that generate a new bill every month on
   *  their own (see generateDueRecurringBills) — so the same bill doesn't need to be re-entered by
   *  hand every time. `scopePropertyId` filters by property (as in the Bills tab); pass it as 'all' or
   *  omit it to view/edit the ones for the whole portfolio (as in Settings). */
  function recurringBillsCardHtml(scopePropertyId){
    var scoped = (!scopePropertyId || scopePropertyId==='all') ? recurringBills : recurringBills.filter(function(r){ return r.propertyId===scopePropertyId; });
    var rows = scoped.slice().sort(function(a,b){ return a.provider.localeCompare(b.provider); }).map(function(r){
      var p = propertyOf(r.propertyId);
      return '<div class="field-row"><span class="k">'+esc(r.provider)+
        ' <span style="color:var(--text-faint);font-weight:400;">('+esc(billTypeLabel(r.billType))+')</span><br/>'+
        '<span style="font-size:11px;color:var(--text-faint);">'+esc(p?p.name:'—')+' · day '+r.billingDay+' of each month · next '+shortDate(r.nextDueDate)+(r.isActive?'':' · paused')+'</span></span>'+
        '<span class="v" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;">'+money(r.amount)+
        '<button class="mini-btn" style="padding:2px 8px;font-size:11px;" onclick="openRecurringBillModal(\''+r.id+'\')">Edit</button>'+
        '<button class="mini-btn" style="padding:2px 8px;font-size:11px;" onclick="toggleRecurringBillActive(\''+r.id+'\','+(!r.isActive)+')">'+(r.isActive?'Pause':'Resume')+'</button>'+
        '</span></div>';
    }).join('');
    // There's no "+ New recurring" button here on purpose: a recurring template can only
    // ORIGINATE from a real bill (the "Repeats every month" checkbox when adding or editing a
    // bill), never from scratch. That way there's always a real bill as the first reference point
    // (dates, amount) instead of a template floating with no bill backing it up. Here you can
    // only edit/pause/resume what already exists.
    return '<div class="card"><div class="detail-head" style="margin-top:0;">'+
      '<h2 style="margin:0;font-size:14px;">Recurring bills</h2></div>'+
      (rows ? '<div class="field-list">'+rows+'</div>' : '<p style="font-size:12.5px;color:var(--text-faint);margin:0;">None yet — check "Repeats every month" when adding or editing a bill, like gas or internet, to set one up.</p>')+
      '</div>';
  }

  function renderBillDetail(id){
    var b = billOf(id);
    if (!b){ return pageHeader('Bill not found', '') + notFoundState('Bill', '#/bills', 'Back to bills'); }
    var p = propertyOf(b.propertyId);

    return backLink('#/bills', 'Bills') +
      '<div class="detail-head"><div><h1 class="page-title">'+esc(billTypeLabel(b.billType))+'</h1>'+
      '<p class="page-sub">'+esc(b.provider)+'</p></div>'+
      '<div class="occ"><div>'+money(b.amount)+'</div><div class="vacant">'+billStatusBadge(b)+'</div></div></div>'+
      '<div class="card"><div class="field-list">'+
      '<div class="field-row"><span class="k">Property</span><span class="v"><a href="#/properties/'+(p?p.id:'')+'">'+esc(p?p.name:'—')+'</a></span></div>'+
      '<div class="field-row"><span class="k">Provider</span><span class="v">'+esc(b.provider)+'</span></div>'+
      '<div class="field-row"><span class="k">Account number</span><span class="v">'+esc(b.accountNumber||'—')+'</span></div>'+
      '<div class="field-row"><span class="k">Invoice number</span><span class="v">'+esc(b.invoiceNumber||'—')+'</span></div>'+
      '<div class="field-row"><span class="k">Issue date</span><span class="v">'+(b.issueDate?fullDate(b.issueDate):'—')+'</span></div>'+
      '<div class="field-row"><span class="k">Due date</span><span class="v">'+(b.dueDate?fullDate(b.dueDate):'—')+'</span></div>'+
      '<div class="field-row"><span class="k">Billing period</span><span class="v">'+shortDate(b.billingPeriodStart)+' – '+shortDate(b.billingPeriodEnd)+'</span></div>'+
      '<div class="field-row"><span class="k">Amount</span><span class="v">'+money(b.amount)+'</span></div>'+
      '<div class="field-row"><span class="k">Status</span><span class="v">'+billStatusBadge(b)+'</span></div>'+
      (b.notes ? '<div class="field-row"><span class="k">Notes</span><span class="v" style="font-weight:400;">'+esc(b.notes)+'</span></div>' : '')+
      '</div></div>'+
      '<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">'+
      (b.receiptPath ? '<button class="mini-btn" onclick="openBillDocumentPreview(\''+b.id+'\')">View bill</button>' : '')+
      '<button class="mini-btn" onclick="openEditBillModal(\''+b.id+'\')">Edit bill</button>'+
      (isSuperAdmin() ? '<button class="mini-btn danger" onclick="deleteBillConfirm(\''+b.id+'\')">Delete bill</button>' : '')+
      '</div>'+
      billAllocationCard(b);
  }

  /** Shows the bill's original document (the photo/PDF attached when it was added). A PDF opens
   *  in the full PDF viewer (openPdfViewer — pagination, zoom, search, thumbnails, etc.); a photo
   *  still uses this simpler image-only modal, sized to the viewer's own screen. There's no stored
   *  mime type for the file, so which one it is is guessed from the saved filename's extension. */
  async function openBillDocumentPreview(billId){
    var bill = billOf(billId);
    if (!bill || !bill.receiptPath) return;
    var isPdf = /\.pdf(\?|$)/i.test(bill.receiptPath);
    if (isPdf){
      try {
        var pdfUrl = await storageService.getSignedUrl('receipts', bill.receiptPath, 600);
        var pdfName = (bill.provider || 'bill') + ' - ' + billTypeLabel(bill.billType) + '.pdf';
        openPdfViewer(pdfUrl, pdfName);
      } catch(err){
        showToast("Couldn't load the bill. " + friendlyErrorMessage(err), 'error');
      }
      return;
    }
    var modal = document.getElementById('bill-preview-modal');
    var body = document.getElementById('bill-preview-body');
    var openLink = document.getElementById('bill-preview-open-link');
    if (!modal || !body) return;
    document.getElementById('bill-preview-title').textContent = (bill.provider||'Bill') + ' — ' + billTypeLabel(bill.billType);
    body.innerHTML = '<p style="font-size:12.5px;color:var(--text-dim);">Loading…</p>';
    if (openLink) openLink.removeAttribute('href');
    modal.hidden = false;
    try {
      var url = await storageService.getSignedUrl('receipts', bill.receiptPath, 600);
      body.innerHTML = '<img src="'+esc(url)+'" alt="Bill document" style="max-width:100%;max-height:100%;object-fit:contain;display:block;margin:0 auto;" />';
      if (openLink) openLink.href = url;
    } catch(err){
      body.innerHTML = '<p style="font-size:12.5px;color:var(--status-overdue);">Could not load the bill. '+esc(friendlyErrorMessage(err))+'</p>';
    }
  }
  function closeBillPreviewModal(){
    var modal = document.getElementById('bill-preview-modal');
    if (modal) modal.hidden = true;
    var body = document.getElementById('bill-preview-body');
    if (body) body.innerHTML = '';
  }
  window.openBillDocumentPreview = openBillDocumentPreview;
  window.closeBillPreviewModal = closeBillPreviewModal;

  function deleteBillConfirm(billId){
    var b = billOf(billId);
    if (!b) return;
    openConfirmModal('Delete bill', 'Delete this '+b.billType+' bill from '+esc(b.provider)+'? This also removes its allocations. This cannot be undone.', async function(){
      try {
        await billAllocationService.removeForBill(billId);
        await billService.remove(billId);
        bills = bills.filter(function(x){ return x.id!==billId; });
        location.hash = '#/bills';
        showToast('Bill deleted.', 'success');
      } catch(err){
        return { blocked:true, message: friendlyErrorMessage(err) };
      }
    }, { confirmLabel:'Delete', danger:true });
  }
  window.deleteBillConfirm = deleteBillConfirm;

  /** Keeps only the digits of a saved phone number (strips spaces, dashes, parentheses and the
   *  '+') to build a wa.me link — WhatsApp requires the full number with country code but
   *  no symbols at all. If there aren't enough digits left to be a real number, returns
   *  null (there's no one to send the message to). */
  function phoneDigitsForWhatsApp(phone){
    var digits = (phone || '').replace(/[^0-9]/g, '');
    return digits.length >= 8 ? digits : null;
  }

  /** Rewrites a wa.me / chat.whatsapp.com link so that, on Android, it opens specifically in
   *  WhatsApp Business instead of whichever WhatsApp app the OS would otherwise pick when both
   *  the regular app and Business are installed. A web page can't change the phone's default
   *  handler for wa.me — but on Android it CAN name the app outright with an "intent://" URL
   *  that points straight at Business's package (com.whatsapp.w4b), falling back to the plain
   *  link (browser_fallback_url) if Business isn't installed. There is no equivalent way to do
   *  this on iOS or desktop — Apple doesn't expose a separate public URL scheme for the
   *  Business app there — so those just get the ordinary link back, same as before. */
  function whatsAppBusinessLink(httpsUrl){
    var isAndroid = /Android/i.test((navigator.userAgent || ''));
    if (!isAndroid) return httpsUrl;
    var withoutScheme = httpsUrl.replace(/^https?:\/\//, '');
    return 'intent://' + withoutScheme + '#Intent;package=com.whatsapp.w4b;scheme=https;S.browser_fallback_url=' + encodeURIComponent(httpsUrl) + ';end';
  }

  /** Builds the WhatsApp link (wa.me) that opens a chat with the tenant with the
   *  bill's payment notice already drafted — provider, service, amount owed and due date.
   *  The admin only has to review and tap send; nothing is sent automatically. */
  function billAllocationWhatsAppLink(bill, property, tenant, amount){
    var digits = phoneDigitsForWhatsApp(tenant.phone);
    if (!digits) return null;
    var propertyLabel = property ? (property.address || property.name) : 'the property';
    var message = 'Hi ' + tenant.fullName + ', this is ' + propertyLabel +
      ' — you owe ' + money(amount) + ' for ' + bill.billType +
      ' (' + bill.provider + '), for the period ' + shortDate(bill.billingPeriodStart) + ' to ' + shortDate(bill.billingPeriodEnd) +
      (bill.dueDate ? ('. Due date: ' + shortDate(bill.dueDate)) : '') + '. Thank you!';
    return whatsAppBusinessLink('https://wa.me/' + digits + '?text=' + encodeURIComponent(message));
  }

  /** The small "Send WhatsApp" button shown next to each tenant in a bill's
   *  allocation — only appears if the tenant has a saved phone number; if not, shows a short
   *  notice instead of the button, so it's clear why it can't be sent from there. */
  function whatsAppButtonHtml(bill, property, tenant, amount){
    if (!tenant || isTenantHiddenProvider(bill.provider)) return '';
    var link = billAllocationWhatsAppLink(bill, property, tenant, amount);
    if (!link) return '<span class="text-link" style="font-size:11.5px;color:var(--text-faint);cursor:default;">No phone on file</span>';
    return '<a class="text-link" style="font-size:11.5px;" href="'+link+'" target="_blank" rel="noopener">Send WhatsApp</a>';
  }

  /** Builds the general message for the property's WhatsApp group once a bill has been split
   *  among tenants — provider, service, period, due date, and a
   *  "Name: $amount" line for each tenant with a share assigned (who has already paid is marked separately). */
  function billGroupWhatsAppMessage(bill, property, tenants){
    var lines = tenants.map(function(row){
      return '• ' + row.name + ': ' + money(row.amount) + (row.paid ? ' (already paid)' : '');
    });
    var propertyLabel = property ? (property.address || property.name) : 'the property';
    return 'Bill split for ' + bill.billType + ' (' + bill.provider + ') — ' +
      propertyLabel + '\n' +
      'Period: ' + shortDate(bill.billingPeriodStart) + ' to ' + shortDate(bill.billingPeriodEnd) +
      (bill.dueDate ? ('\nDue date: ' + shortDate(bill.dueDate)) : '') + '\n\n' +
      lines.join('\n') +
      '\n\nPlease confirm payment with your receipt. Thank you!';
  }

  /** Builds the WhatsApp message + link for a tenant's whole consolidated list of pending bills
   *  (the "Pending bills by tenant" card in the Bills tab) — one line per bill plus a total,
   *  instead of sending one WhatsApp message per bill. Bills from a hidden-from-tenant provider
   *  (isTenantHiddenProvider) are left out of the message, same as everywhere else tenants see
   *  bill text, even though they still count in the on-screen total for the admin. */
  function pendingBillsWhatsAppMessage(tenant, items, property){
    var visibleItems = items.filter(function(it){ return !isTenantHiddenProvider(it.bill.provider); });
    if (!visibleItems.length) return null;
    var propertyLabel = property ? (property.address || property.name) : 'the property';
    var lines = visibleItems.map(function(it){
      var b = it.bill, a = it.alloc;
      return '• ' + billTypeLabel(b.billType) + ' (' + b.provider + '): ' + money(a.amount) +
        (b.dueDate ? (' — due ' + shortDate(b.dueDate)) : '');
    });
    var total = round2(visibleItems.reduce(function(s,it){ return s + it.alloc.amount; }, 0));
    return 'Hi ' + tenant.fullName + ', this is ' + propertyLabel + ' — here are your pending bills:\n\n' +
      lines.join('\n') +
      '\n\nTotal owed: ' + money(total) +
      '\n\nPlease confirm payment with your receipt. Thank you!';
  }
  /** The "Send WhatsApp" row shown when a tenant's consolidated pending-bills list is expanded —
   *  same pattern as whatsAppButtonHtml (one bill at a time), but for the whole list at once. */
  function pendingBillsWhatsAppRowHtml(tenant, items, property){
    var message = pendingBillsWhatsAppMessage(tenant, items, property);
    if (!message) return '';
    var digits = phoneDigitsForWhatsApp(tenant.phone);
    var linkOrNote = digits
      ? '<a class="mini-btn primary" style="padding:2px 8px;font-size:11px;" href="'+whatsAppBusinessLink('https://wa.me/'+digits+'?text='+encodeURIComponent(message))+'" target="_blank" rel="noopener">Send WhatsApp</a>'
      : '<span class="text-link" style="font-size:11.5px;color:var(--text-faint);cursor:default;">No phone on file</span>';
    return '<div class="alloc-summary-row" style="align-items:center;padding-left:10px;justify-content:flex-end;">'+linkOrNote+'</div>';
  }

  /** Downloads the bill's original document (saved in the private `receipts` bucket) as a
   *  File ready to attach to the native share sheet. Returns null if the bill has no
   *  attached document or if something fails while downloading it (the message can still be
   *  shared without an attached file). */
  async function fetchBillReceiptFile(bill){
    if (!bill.receiptPath) return null;
    try {
      var url = await storageService.getSignedUrl('receipts', bill.receiptPath, 300);
      var res = await fetch(url);
      if (!res.ok) return null;
      var blob = await res.blob();
      var name = bill.receiptPath.split('/').pop() || 'bill';
      return new File([blob], name, { type: blob.type || 'application/octet-stream' });
    } catch (_e){
      return null;
    }
  }

  /** Shares a bill's allocation to the property's WhatsApp group using the phone's native
   *  share sheet (Web Share API) — builds the message and, if there's an attached document,
   *  includes it as a file. The admin picks the group and taps send; nothing is sent on its own. If
   *  the phone/browser doesn't support sharing files (or sharing at all), falls back to copying the
   *  message to the clipboard and opening the group's link to paste it by hand. */
  async function shareBillToWhatsAppGroup(billId){
    var bill = billOf(billId);
    if (!bill || !bill.allocations || !bill.allocations.length) return;
    if (isTenantHiddenProvider(bill.provider)){
      showToast('Bills from this provider are never sent to tenants.', 'error');
      return;
    }
    var property = propertyOf(bill.propertyId);
    if (!property || !property.whatsappGroupLink){
      showToast('Add this property\'s WhatsApp group link first (Edit property).', 'error');
      return;
    }
    var tenantsForMsg = bill.allocations.filter(function(a){ return !a.isAdmin; }).map(function(a){
      var t = tenantOf(a.tenantId);
      return { name: t ? t.fullName : 'Tenant', amount: a.amount, paid: !!a.paid };
    });
    var message = billGroupWhatsAppMessage(bill, property, tenantsForMsg);
    var file = await fetchBillReceiptFile(bill);

    try {
      if (file && navigator.canShare && navigator.canShare({ files: [file] })){
        await navigator.share({ files: [file], text: message, title: 'Bill split' });
        return;
      }
      if (navigator.share){
        await navigator.share({ text: message, title: 'Bill split' });
        return;
      }
      throw new Error('not supported');
    } catch (err){
      if (err && err.name === 'AbortError') return; // person cancelled the share sheet — not an error
      try {
        await navigator.clipboard.writeText(message);
        showToast('Your phone doesn\'t support direct sharing — we copied the message; open the group and paste it in.', 'info');
      } catch (_e){
        showToast('Copy this message by hand and paste it in the group:\n\n' + message, 'info');
      }
      window.open(whatsAppBusinessLink(property.whatsappGroupLink), '_blank', 'noopener');
    }
  }
  window.shareBillToWhatsAppGroup = shareBillToWhatsAppGroup;

  /** The little "Upload receipt" / "View receipt" link shown under a tenant's allocation row or
   *  the admin's provider-payment row. `path` is the file's storage path, or null/undefined if
   *  nothing's been attached yet. */
  function receiptLinkHtml(path, billId, tenantId){
    var tenantArg = tenantId ? ('\''+tenantId+'\'') : 'null';
    if (path){
      return '<button class="text-link" style="font-size:11.5px;" onclick="viewReceipt(\'receipts\',\''+path+'\')">View receipt</button>'+
        '<button class="text-link" style="font-size:11.5px;color:var(--status-overdue);" onclick="removeReceipt(\''+billId+'\','+tenantArg+')">Remove</button>';
    }
    return '<button class="text-link" style="font-size:11.5px;" onclick="triggerReceiptUpload(\''+billId+'\','+tenantArg+')">Upload receipt</button>';
  }

  var PAYMENT_METHOD_LABEL = { bank_transfer: 'Bank transfer', cash: 'Cash', card: 'Card', other: 'Other' };

  /** Every payment_reports row for one allocation, newest first — the full history the spec
   *  requires (reported → rejected → reported → confirmed, etc.) is just this list in order. */
  function paymentReportsForAllocation(allocationId){
    return paymentReports.filter(function(r){ return r.allocationId === allocationId; })
      .sort(function(a, b){ return (b.reportedAt || '').localeCompare(a.reportedAt || ''); });
  }
  /** The tenant-facing / admin-facing effective status of one allocation's payment, derived —
   *  never stored as its own column. 'paid' always wins (bill_allocations.paid is the single
   *  source of truth); otherwise it's driven by the single most recent payment_reports row. */
  function allocationPaymentStatus(alloc){
    if (alloc.paid) return 'paid';
    var latest = paymentReportsForAllocation(alloc.id)[0];
    if (latest && latest.status === 'pending') return 'pending_verification';
    if (latest && latest.status === 'rejected') return 'rejected';
    return 'unpaid';
  }
  /** Used by the bill list (billsTableHtml) to show a "Payment reported" badge without opening
   *  the bill's own detail page. */
  function billHasPendingPaymentReport(bill){
    if (!bill.allocations) return false;
    return bill.allocations.some(function(a){ return allocationPaymentStatus(a) === 'pending_verification'; });
  }

  function billAllocationCard(b){
    var p = propertyOf(b.propertyId);
    var methodLabel = { equal:'Equal split', days:'By days occupied', custom:'Custom' };
    // The admin's own payment to the provider — a second leg, separate from each tenant's
    // allocation, only unlocked once every tenant has paid their share.
    var adminReady = billReadyForAdminPayment(b);
    var adminPaidBit = b.adminPaid
      ? badge('paid', 'Paid'+(b.adminPaidDate ? ' ' + shortDate(b.adminPaidDate) : ''))
      : badge(adminReady ? 'due' : 'neutral', 'Not yet paid');
    var adminActionBtn = b.adminPaid
      ? '<button class="mini-btn" onclick="unmarkBillAdminPaid(\''+b.id+'\')">Mark as unpaid</button>'
      : '<button class="mini-btn primary" onclick="markBillAdminPaid(\''+b.id+'\')">Mark as paid to provider</button>';
    var adminSectionHtml = '<div class="card"><div class="detail-head" style="margin-top:0;align-items:center;">'+
      '<h2 style="margin:0;">Payment to provider</h2></div>'+
      '<p style="font-size:12px;color:var(--text-faint);margin:2px 0 8px;">'+
      (adminReady ? 'All tenants have paid — you can now forward this on to '+esc(b.provider)+'.' : 'Not every tenant has paid their share yet — you can still mark this as paid to '+esc(b.provider)+', but you\'ll be asked to confirm first.')+
      '</p>'+
      '<div class="alloc-summary-row" style="align-items:center;flex-wrap:wrap;">'+
      '<div class="who"><div>'+esc(b.provider)+'</div>'+receiptLinkHtml(b.adminReceiptPath, b.id, null)+'</div>'+
      '<div style="display:flex;align-items:center;gap:10px;">'+
      '<div style="text-align:right;"><div style="font-weight:650;">'+money(b.amount)+'</div>'+adminPaidBit+'</div>'+
      adminActionBtn+
      '</div></div></div>';

    if (b.allocations && b.allocations.length){
      var rows = b.allocations.map(function(a){
        if (a.isAdmin){
          return '<div class="alloc-summary-row" style="align-items:center;flex-wrap:wrap;">'+
            '<div class="who"><div>Administrator (you)</div>'+
            '<div style="font-size:11.5px;color:var(--text-faint);">Covers tenants excluded from this service</div></div>'+
            '<div style="display:flex;align-items:center;gap:10px;">'+
            '<div style="text-align:right;"><div style="font-weight:650;">'+money(a.amount)+'</div>'+badge('paid','Absorbed by you')+'</div>'+
            '</div></div>';
        }
        var t = tenantOf(a.tenantId);
        var owesNothing = round2(a.amount) <= 0;
        // A former tenant who already left and whose dates don't even overlap this bill (they
        // didn't live there during the period) — left over from an old allocation, shouldn't keep showing up.
        var notRelevant = t && b.billingPeriodStart && b.billingPeriodEnd &&
          occupiedDaysInRange(t, b.billingPeriodStart, b.billingPeriodEnd) <= 0;
        // They don't owe anything on this share (e.g. it ended up at $0 when allocated by hand), or
        // it's not relevant — it isn't shown in the allocation instead of asking for a receipt or marking
        // as paid something that doesn't apply.
        if (owesNothing || notRelevant) return '';
        var payStatus = allocationPaymentStatus(a);
        var pendingReport = payStatus==='pending_verification' ? paymentReportsForAllocation(a.id)[0] : null;
        var paidBit = a.paid
          ? badge('paid', 'Paid'+(a.paidDate ? ' ' + shortDate(a.paidDate) : '')+(a.paidVia==='bond_deduction' ? ' · Bond deduction' : ''))
          : payStatus==='pending_verification' ? badge('upcoming','Reported')
          : badge('due', 'Unpaid');
        var actionBtn = a.paid
          ? '<button class="mini-btn" onclick="unmarkAllocationPaid(\''+b.id+'\',\''+a.tenantId+'\')">Mark as unpaid</button>'
          : pendingReport
            ? '<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">'+
              '<button class="mini-btn primary" onclick="confirmPaymentReport(\''+b.id+'\',\''+a.tenantId+'\',\''+(pendingReport.paymentDate||TODAY)+'\')">Confirm Payment</button>'+
              '<button class="mini-btn danger" onclick="openRejectPaymentReportModal(\''+pendingReport.id+'\',\''+a.tenantId+'\',\''+b.id+'\')">Reject Payment</button>'+
              '</div>'
            : '<button class="mini-btn primary" onclick="openAllocPaidModal(\''+b.id+'\',\''+a.tenantId+'\')">Mark as paid</button>';
        var reportDetailHtml = pendingReport
          ? '<div style="font-size:11.5px;color:var(--text-faint);margin-top:4px;">Payment reported by tenant'+
            (pendingReport.reportedAt ? ' · Reported ' + shortDate(pendingReport.reportedAt.slice(0,10)) : '')+
            (pendingReport.paymentDate ? ' · Paid ' + shortDate(pendingReport.paymentDate) : '')+
            (pendingReport.paymentMethod ? ' · ' + (PAYMENT_METHOD_LABEL[pendingReport.paymentMethod]||pendingReport.paymentMethod) : '')+
            (pendingReport.reference ? ' · Ref: "' + esc(pendingReport.reference) + '"' : '')+
            (pendingReport.proofPath ? ' · <button class="text-link" style="font-size:11.5px;" onclick="viewReceipt(\'receipts\',\''+pendingReport.proofPath+'\')">View proof</button>' : '')+
            '</div>'
          : '';
        // Collapsed audit trail once paid — the spec's full history requirement (reported →
        // rejected → reported → confirmed, etc.) is just this allocation's payment_reports rows
        // in order; no separate audit-log table needed.
        var historyReports = (a.paid && !pendingReport) ? paymentReportsForAllocation(a.id) : [];
        var historyHtml = historyReports.length
          ? '<details style="margin-top:4px;"><summary style="font-size:11px;color:var(--text-faint);cursor:pointer;">Payment report history</summary>'+
            historyReports.map(function(r){
              var label = r.status==='confirmed' ? 'Confirmed' : r.status==='rejected' ? ('Rejected'+(r.rejectionReason?' — '+esc(r.rejectionReason):'')) : 'Reported';
              return '<div style="font-size:11px;color:var(--text-faint);padding:2px 0 2px 8px;">'+shortDate((r.reportedAt||'').slice(0,10))+' — '+label+'</div>';
            }).join('')+
            '</details>'
          : '';
        return '<div class="alloc-summary-row" style="align-items:center;flex-wrap:wrap;">'+
          '<div class="who"><div>'+esc(t?t.fullName:a.tenantId)+'</div>'+
          '<div style="display:flex;gap:10px;flex-wrap:wrap;">'+receiptLinkHtml(a.receiptPath, b.id, a.tenantId)+
          (a.paid ? '' : whatsAppButtonHtml(b, p, t, a.amount))+'</div>'+
          reportDetailHtml+historyHtml+
          '</div>'+
          '<div style="display:flex;align-items:center;gap:10px;">'+
          '<div style="text-align:right;"><div style="font-weight:650;">'+money(a.amount)+'</div>'+paidBit+'</div>'+
          actionBtn+
          '</div></div>';
      }).join('');
      return '<div class="card"><div class="detail-head" style="margin-top:0;align-items:center;">'+
        '<h2 style="margin:0;">Allocation</h2>'+
        '<div style="display:flex;gap:8px;">'+
        (isTenantHiddenProvider(b.provider) ? '' : '<button class="mini-btn" onclick="shareBillToWhatsAppGroup(\''+b.id+'\')">Share to WhatsApp group</button>')+
        '<button class="mini-btn" onclick="openAllocateModal(\''+b.id+'\')">Re-allocate</button>'+
        '</div></div>'+
        '<p style="font-size:12px;color:var(--text-faint);margin:2px 0 8px;">'+(methodLabel[b.allocationMethod]||'Custom')+
        (p && !p.whatsappGroupLink ? ' · <span style="color:var(--text-faint);">No WhatsApp group link set for this property yet.</span>' : '')+
        '</p>'+
        (rows || '<p style="font-size:12.5px;color:var(--text-faint);margin:0;">No tenant owes anything on this bill.</p>')+'</div>'+adminSectionHtml;
    }
    var propTenants = tenantsOfProperty(b.propertyId);
    if (propTenants.length === 0) return adminSectionHtml;
    return '<div class="card"><div class="detail-head" style="margin-top:0;align-items:center;">'+
      '<h2 style="margin:0;">Allocation</h2>'+
      '<button class="mini-btn primary" onclick="openAllocateModal(\''+b.id+'\')">Allocate</button></div>'+
      '<p style="font-size:13px;color:var(--text-dim);margin:0;">Split this bill between the property\'s tenants — equally, by days occupied, or a custom amount.</p></div>'+
      adminSectionHtml;
  }

  /* ---------- Admin: confirm/reject a tenant's payment report ---------- */
  /** Confirm Payment is now just a thin wrapper: markAllocationPaid is what actually resolves the
   *  pending payment_reports row and notifies the tenant, via autoConfirmPendingPaymentReport —
   *  so this works identically whether triggered from here, or from either of the two
   *  pre-existing plain "Mark as paid" buttons. */
  async function confirmPaymentReport(billId, tenantId, paymentDate){
    // paid_via has a DB check constraint allowing only 'cash'/'bond_deduction' (bill_allocations
    // has no 'tenant_reported' value) — a tenant-reported-and-admin-confirmed payment is real
    // money paid by the tenant, i.e. semantically 'cash', same as any other manual confirmation.
    await markAllocationPaid(billId, tenantId, paymentDate, 'cash');
  }
  window.confirmPaymentReport = confirmPaymentReport;

  var rejectPaymentReportTarget = null; // { reportId, tenantId, billId }
  function openRejectPaymentReportModal(reportId, tenantId, billId){
    rejectPaymentReportTarget = { reportId: reportId, tenantId: tenantId, billId: billId };
    document.getElementById('reject-payment-reason').value = '';
    document.getElementById('reject-payment-modal-error').hidden = true;
    document.getElementById('reject-payment-modal').hidden = false;
  }
  function closeRejectPaymentReportModal(){
    document.getElementById('reject-payment-modal').hidden = true;
    rejectPaymentReportTarget = null;
  }
  async function confirmRejectPaymentReport(){
    var target = rejectPaymentReportTarget;
    var errorEl = document.getElementById('reject-payment-modal-error');
    var reason = document.getElementById('reject-payment-reason').value.trim();
    if (!reason){ errorEl.textContent = 'Enter a reason.'; errorEl.hidden = false; return; }
    if (!target) return;
    try {
      var updated = await paymentReportService.reject(target.reportId, currentProfile ? currentProfile.id : null, reason);
      var idx = paymentReports.findIndex(function(r){ return r.id===target.reportId; });
      if (idx > -1) paymentReports[idx] = updated;
      var bill = billOf(target.billId);
      var t = tenantOf(target.tenantId);
      if (t && t.authUserId && bill){
        await notificationService.notify(t.authUserId, 'Payment could not be verified',
          'Payment could not be verified. ' + reason,
          'bills', target.billId, { category: 'payment_report', propertyId: bill.propertyId, tenantId: target.tenantId, createdByProfileId: currentProfile ? currentProfile.id : null });
      }
      closeRejectPaymentReportModal();
      showToast('Payment report rejected.', 'success');
      render();
    } catch(err){
      errorEl.textContent = friendlyErrorMessage(err);
      errorEl.hidden = false;
    }
  }
  window.openRejectPaymentReportModal = openRejectPaymentReportModal;
  window.closeRejectPaymentReportModal = closeRejectPaymentReportModal;
  window.confirmRejectPaymentReport = confirmRejectPaymentReport;

  function renderCalendar(){
    var events = buildCalendarEvents();
    var byDate = {};
    events.forEach(function(e){ (byDate[e.date] = byDate[e.date] || []).push(e); });

    var year = parseInt(calendarMonth.slice(0,4), 10);
    var month = parseInt(calendarMonth.slice(5,7), 10) - 1;
    var monthLabel = CALENDAR_MONTH_NAMES[month] + ' ' + year;
    var cells = buildMonthGrid(calendarMonth);

    var toolbarHtml = '<div class="cal-toolbar">'+
      '<button class="mini-btn" type="button" onclick="calendarShiftMonth(-1)" aria-label="Previous month">‹</button>'+
      '<div class="cal-month-label">'+monthLabel+'</div>'+
      '<button class="mini-btn" type="button" onclick="calendarShiftMonth(1)" aria-label="Next month">›</button>'+
      '<button class="mini-btn" type="button" onclick="calendarGoToday()" style="margin-left:auto;">Today</button>'+
      '</div>';

    var weekdayHtml = '<div class="cal-grid">' + ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(function(w){
      return '<div class="cal-weekday">'+w+'</div>';
    }).join('') + '</div>';

    var cellsHtml = '<div class="cal-grid cal-days">' + cells.map(function(iso){
      if (!iso) return '<div class="cal-daycell empty"></div>';
      var dayNum = parseInt(iso.slice(8,10), 10);
      var isToday = iso === TODAY;
      var dayEvents = (byDate[iso] || []).slice().sort(function(a,b){
        var rank = { overdue:0, due:1, move:2 };
        return rank[a.kind] - rank[b.kind];
      });
      var shown = dayEvents.slice(0, 3);
      var extra = dayEvents.length - shown.length;
      var pillsHtml = shown.map(function(e){
        return '<a class="cal-pill '+e.kind+'" href="'+e.href+'" title="'+esc(e.title)+'">'+esc(e.title)+'</a>';
      }).join('') + (extra > 0 ? '<div class="cal-more">+'+extra+' more</div>' : '');
      return '<div class="cal-daycell'+(isToday ? ' today' : '')+'"><div class="cal-daynum">'+dayNum+'</div>'+pillsHtml+'</div>';
    }).join('') + '</div>';

    var legendHtml = '<div class="cal-legend">'+
      '<span><span class="dot overdue"></span>Overdue</span>'+
      '<span><span class="dot due"></span>Due</span>'+
      '<span><span class="dot move"></span>Move-in / Move-out</span>'+
      '</div>';

    var monthHasEvents = Object.keys(byDate).some(function(d){ return d.slice(0,7) === calendarMonth; });
    var monthEmptyNote = monthHasEvents ? '' :
      '<p style="font-size:12.5px;color:var(--text-faint);text-align:center;margin:12px 0 0;">Nothing due or scheduled in '+monthLabel+'.</p>';

    return pageHeader('Calendar', 'Rent due dates, payments, overdue charges, move-ins/move-outs and bills — all in one place.') +
      '<div class="card">'+toolbarHtml+weekdayHtml+cellsHtml+legendHtml+monthEmptyNote+'</div>';
  }

  /* ---------- PHASE 11: Reports ---------- */
  var reportsMonthFilter = TODAY.slice(0,7); // 'YYYY-MM', or 'all'
  function setReportsMonthFilter(v){ reportsMonthFilter = v; renderPreservingScroll(); }
  window.setReportsMonthFilter = setReportsMonthFilter;

  function renderReports(){
    if (properties.length === 0 && tenants.length === 0){
      return pageHeader('Reports', "Expected vs received rent, outstanding balances, bills and occupancy at a glance.") +
        emptyState('chart', 'Nothing to report yet',
          'Once you add properties, tenants and bills, your numbers will show up here.',
          '<a class="mini-btn primary" href="#/properties" style="display:inline-block;">Go to properties</a>');
    }
    var s = getDashboardSummary();
    var scopedCharges = reportsMonthFilter === 'all' ? rentCharges : rentCharges.filter(function(c){ return c.periodStart.slice(0,7) === reportsMonthFilter; });
    var scopedRentExpected = scopedCharges.reduce(function(s2,c){ return s2+c.amountDue; }, 0);
    var scopedRentReceived = scopedCharges.reduce(function(s2,c){ return s2+c.amountPaid; }, 0);
    var scopedOutstanding = scopedCharges.reduce(function(s2,c){ return s2+c.remaining; }, 0);
    function billDateKey(b){ return (b.billingPeriodStart || b.issueDate || '').slice(0,7); }
    var scopedBills = reportsMonthFilter === 'all' ? bills : bills.filter(function(b){ return billDateKey(b) === reportsMonthFilter; });
    // Real bill ledger: sums what's ACTUALLY been collected per allocation
    // (billPaidAmount) instead of all-or-nothing by bill.status, so a
    // partially paid bill is reflected correctly instead of counting
    // as "0% paid" until the last share is marked.
    var billsPaidTotal = scopedBills.reduce(function(sum,b){ return sum+billPaidAmount(b); },0);
    var billsOutstandingTotal = scopedBills.reduce(function(sum,b){ return sum+billOutstandingAmount(b); },0);
    var billsOverdueTotal = scopedBills.filter(function(b){ return billEffectiveStatus(b)==='overdue'; })
      .reduce(function(sum,b){ return sum+billOutstandingAmount(b); },0);
    var netCashflow = scopedRentReceived - billsPaidTotal;
    var occupancyRate = s.occupiedRooms + s.vacantRooms > 0 ? Math.round(100 * s.occupiedRooms / (s.occupiedRooms + s.vacantRooms)) : 0;

    var monthsPresent = Array.from(new Set(rentCharges.map(function(c){ return c.periodStart.slice(0,7); }))).sort().reverse();
    var monthOptionsHtml = '<option value="all"'+(reportsMonthFilter==='all'?' selected':'')+'>All months</option>'+
      monthsPresent.map(function(m){
        var label = CALENDAR_MONTH_NAMES[parseInt(m.slice(5,7),10)-1] + ' ' + m.slice(0,4);
        return '<option value="'+m+'"'+(reportsMonthFilter===m?' selected':'')+'>'+label+'</option>';
      }).join('');
    var monthFilterHtml = '<div style="margin-bottom:10px;">'+
      '<label style="font-size:11.5px;color:var(--text-faint);display:block;margin-bottom:4px;">Filter by month</label>'+
      '<select class="modal-input" onchange="setReportsMonthFilter(this.value)">'+monthOptionsHtml+'</select>'+
      '</div>';

    var statHtml = '<div class="stat-grid">'+
      ['Rent expected|'+money(scopedRentExpected)+'|0',
       'Rent received|'+money(scopedRentReceived)+'|0',
       'Outstanding|'+money(scopedOutstanding)+'|'+(scopedOutstanding>0?1:0),
       'Bills paid|'+money(billsPaidTotal)+'|0',
       'Bills outstanding|'+money(billsOutstandingTotal)+'|'+(billsOutstandingTotal>0?1:0),
       'Net cashflow|'+money(netCashflow)+'|'+(netCashflow<0?1:0)
      ].map(function(s2){
        var parts = s2.split('|');
        return '<div class="stat"><div class="label">'+parts[0]+'</div><div class="value'+(parts[2]==='1'?' warn':'')+'">'+parts[1]+'</div></div>';
      }).join('')+'</div>';

    var occupancyHtml = '<div class="card"><h2>Occupancy</h2>'+
      '<div class="bar-row"><div class="bar-label"><span>'+s.occupiedRooms+' of '+(s.occupiedRooms+s.vacantRooms)+' rooms occupied</span><span>'+occupancyRate+'%</span></div>'+
      '<div class="bar-track"><div class="bar-fill" style="width:'+occupancyRate+'%;"></div></div></div>'+
      '</div>';

    var billsAmountTotal = scopedBills.reduce(function(sum,b){ return sum+b.amount; },0);
    var billsBreakdownHtml = '<div class="card"><h2>Bills breakdown</h2>'+
      '<div class="bar-row"><div class="bar-label"><span>Paid</span><span>'+money(billsPaidTotal)+'</span></div>'+
      '<div class="bar-track"><div class="bar-fill" style="width:'+(billsAmountTotal? Math.round(100*billsPaidTotal/billsAmountTotal):0)+'%;background:var(--status-paid);"></div></div></div>'+
      '<div class="bar-row"><div class="bar-label"><span>Overdue</span><span>'+money(billsOverdueTotal)+'</span></div>'+
      '<div class="bar-track"><div class="bar-fill" style="width:'+(billsAmountTotal? Math.round(100*billsOverdueTotal/billsAmountTotal):0)+'%;background:var(--status-overdue);"></div></div></div>'+
      '</div>';

    var byTenant = {};
    scopedCharges.forEach(function(c){
      if (!byTenant[c.tenantId]) byTenant[c.tenantId] = { expected:0, received:0, outstanding:0 };
      byTenant[c.tenantId].expected += c.amountDue;
      byTenant[c.tenantId].received += c.amountPaid;
      byTenant[c.tenantId].outstanding += c.remaining;
    });
    var tenantRows = Object.keys(byTenant).map(function(tenantId){
      var t = tenantOf(tenantId);
      var row = byTenant[tenantId];
      return '<tr><td>'+esc(t?t.fullName:tenantId)+'</td><td>'+money(row.expected)+'</td><td>'+money(row.received)+'</td>'+
        '<td'+(row.outstanding>0?' class="warn"':'')+'>'+money(row.outstanding)+'</td></tr>';
    }).join('');
    var tenantTableHtml = '<div class="card"><h2>By tenant</h2>'+
      (tenantRows
        ? '<div class="report-table-wrap"><table class="report-table"><thead><tr><th>Tenant</th><th>Expected</th><th>Received</th><th>Outstanding</th></tr></thead>'+
          '<tbody>'+tenantRows+'</tbody></table></div>'+
          '<p style="font-size:11.5px;color:var(--text-faint);margin:8px 0 0;">'+
            (reportsMonthFilter === 'all'
              ? 'Covers every rent period since move-in, not just the current one.'
              : 'Scoped to the selected month — choose "All months" above to see every rent period since move-in.')+
          '</p>'
        : '<p style="font-size:13.5px;color:var(--text-dim);margin:0;">No rent charges yet — add a paying tenant to see a breakdown here.</p>')+
      '</div>';

    return pageHeader('Reports', 'Expected vs received rent, outstanding balances, bills and occupancy at a glance.') +
      monthFilterHtml + statHtml + occupancyHtml + billsBreakdownHtml + tenantTableHtml;
  }

  /** "Profits" by property: a current run-rate snapshot (not a historical
   *  range) of each occupied room's normalized weekly rent, minus active
   *  admin-paid bills bundled into rent (room_included_bills), minus the
   *  property's own weekly-normalized lease cost. See
   *  docs/superpowers/specs/2026-09-28-profit-by-property-design.md. */
  function propertyWeeklyLeaseCost(p){
    if (p.leasePaymentAmount == null) return 0;
    return normalizeToWeekly(p.leasePaymentAmount, p.leasePaymentFrequency === 'fortnightly' ? 'fortnightly' : 'monthly');
  }

  function activeIncludedBillsForRoom(roomId){
    return roomIncludedBills.filter(function(e){
      return e.roomId === roomId && e.startDate <= TODAY && (!e.endDate || e.endDate >= TODAY);
    });
  }

  function propertyProfitBreakdown(p){
    var propRooms = rooms.filter(function(r){ return r.propertyId === p.id; });
    var roomLines = propRooms.map(function(r){
      // NOT currentTenantOf(r.id) — that helper returns the first tenant EVER
      // assigned to this room by array order, which can be an old, moved-out
      // tenant on a room that has turned over. Filter for the currently active
      // tenant directly instead (same test roomIsOccupied uses internally).
      var tenant = tenants.find(function(t){ return t.roomId === r.id && !tenantHasMovedOut(t); }) || null;
      var weeklyRent = tenant ? normalizeToWeekly(tenant.rentAmount, tenant.rentFrequency) : 0;
      return { room:r, tenant:tenant, weeklyRent:weeklyRent };
    });
    var includedBillLines = [];
    propRooms.forEach(function(r){
      activeIncludedBillsForRoom(r.id).forEach(function(e){
        includedBillLines.push({ room:r, entry:e, weeklyAmount: normalizeToWeekly(e.amount, e.frequency) });
      });
    });
    var allBillLines = [];
    propRooms.forEach(function(r){
      roomIncludedBills.filter(function(e){ return e.roomId === r.id; }).forEach(function(e){
        allBillLines.push({ room:r, entry:e, weeklyAmount: normalizeToWeekly(e.amount, e.frequency) });
      });
    });
    var inactiveIncludedBills = allBillLines.filter(function(l){
      return !(l.entry.startDate <= TODAY && (!l.entry.endDate || l.entry.endDate >= TODAY));
    });
    var weeklyIncome = round2(roomLines.reduce(function(s,l){ return s+l.weeklyRent; }, 0));
    var weeklyIncludedBillsTotal = round2(includedBillLines.reduce(function(s,l){ return s+l.weeklyAmount; }, 0));
    var hasLeaseCost = p.leasePaymentAmount != null;
    var weeklyCost = propertyWeeklyLeaseCost(p);
    var weeklyProfit = round2(weeklyIncome - weeklyIncludedBillsTotal - weeklyCost);
    // Fortnightly profit is only shown for a property whose lease (what you pay the real
    // estate) is itself paid fortnightly — matching how that property's own bills land, rather
    // than an arbitrary "every 2 weeks" figure for every property.
    var isFortnightlyLease = p.leasePaymentFrequency === 'fortnightly';
    return {
      rooms: roomLines,
      includedBills: includedBillLines,
      inactiveIncludedBills: inactiveIncludedBills,
      weeklyCost: weeklyCost,
      hasLeaseCost: hasLeaseCost,
      weeklyIncome: weeklyIncome,
      weeklyIncludedBillsTotal: weeklyIncludedBillsTotal,
      weeklyProfit: weeklyProfit,
      monthlyProfit: round2(weeklyToMonthly(weeklyProfit)),
      isFortnightlyLease: isFortnightlyLease,
      fortnightlyProfit: isFortnightlyLease ? round2(weeklyToFortnightly(weeklyProfit)) : null
    };
  }

  function renderProfits(){
    if (properties.length === 0){
      return pageHeader('Profits', "What each property earns after admin-paid costs bundled into rent, and what you pay the real estate.") +
        emptyState('chart', 'Nothing to show yet', 'Once you add properties and tenants, profits will show up here.',
          '<a class="mini-btn primary" href="#/properties" style="display:inline-block;">Go to properties</a>');
    }
    var cardsHtml = properties.slice().sort(function(a,b){ return a.name.localeCompare(b.name); }).map(function(p){
      var b = propertyProfitBreakdown(p);
      var roomRowsHtml = b.rooms.map(function(l){
        var addBillBtn = '<button type="button" class="text-link" style="margin-left:8px;" onclick="openIncludedBillModal(\''+l.room.id+'\')">+ Add included bill</button>';
        return l.tenant
          ? '<div class="field-row"><span class="k">'+esc(l.room.name)+' — '+esc(l.tenant.fullName)+'</span><span class="v">'+money(round2(l.weeklyRent))+'/week'+addBillBtn+'</span></div>'
          : '<div class="field-row"><span class="k">'+esc(l.room.name)+'</span><span class="v" style="color:var(--text-faint);">Vacant'+addBillBtn+'</span></div>';
      }).join('');
      var includedBillRowsHtml = b.includedBills.length
        ? b.includedBills.map(function(l){
            return '<div class="field-row"><span class="k">− '+esc(l.entry.label)+' ('+esc(l.room.name)+')</span><span class="v" style="color:var(--status-overdue);">−'+money(round2(l.weeklyAmount))+'/week'+
              '<button type="button" class="icon-mini-btn" title="Edit" onclick="openIncludedBillModal(\''+l.room.id+'\',\''+l.entry.id+'\')">✎</button>'+
              '<button type="button" class="icon-mini-btn" title="End (stop applying from today)" onclick="endIncludedBill(\''+l.entry.id+'\')">⏹</button>'+
              '<button type="button" class="icon-mini-btn danger" title="Delete" onclick="deleteIncludedBillConfirm(\''+l.entry.id+'\')">✕</button>'+
              '</span></div>';
          }).join('')
        : '<p style="font-size:12px;color:var(--text-faint);margin:4px 0 0;">No included bills for this property.</p>';
      var inactiveRowsHtml = b.inactiveIncludedBills.length
        ? '<h3 style="font-size:11px;text-transform:none;letter-spacing:0;color:var(--text-faint);margin:10px 0 4px;">Not currently active</h3>'+
          b.inactiveIncludedBills.map(function(l){
            var range = shortDate(l.entry.startDate) + (l.entry.endDate ? ' – ' + shortDate(l.entry.endDate) : ' – (no end date)');
            return '<div class="field-row"><span class="k" style="color:var(--text-faint);">'+esc(l.entry.label)+' ('+esc(l.room.name)+') · '+range+'</span>'+
              '<span class="v"><button type="button" class="icon-mini-btn" title="Edit" onclick="openIncludedBillModal(\''+l.room.id+'\',\''+l.entry.id+'\')">✎</button>'+
              '<button type="button" class="icon-mini-btn danger" title="Delete" onclick="deleteIncludedBillConfirm(\''+l.entry.id+'\')">✕</button></span></div>';
          }).join('')
        : '';
      return '<div class="card"><div class="detail-head" style="margin-top:0;align-items:center;">'+
        '<h2 style="margin:0;"><a href="#/properties/'+p.id+'" style="color:inherit;text-decoration:none;">'+esc(p.name)+'</a></h2>'+
        '<div style="font-weight:700;font-size:15px;color:'+(b.weeklyProfit<0?'var(--status-overdue)':'var(--status-paid)')+';">'+money(b.weeklyProfit)+'/week</div>'+
        '</div>'+
        '<h3 style="font-size:12px;text-transform:none;letter-spacing:0;color:var(--text-dim);margin:14px 0 6px;">Rooms</h3>'+
        '<div class="field-list">'+roomRowsHtml+'</div>'+
        '<h3 style="font-size:12px;text-transform:none;letter-spacing:0;color:var(--text-dim);margin:14px 0 6px;">Included bills (paid by you, subtracted)</h3>'+
        includedBillRowsHtml+
        inactiveRowsHtml+
        '<div class="field-list" style="margin-top:10px;">'+
        '<div class="field-row"><span class="k">Weekly income</span><span class="v">'+money(b.weeklyIncome)+'</span></div>'+
        '<div class="field-row"><span class="k">Included bills</span><span class="v">−'+money(b.weeklyIncludedBillsTotal)+'</span></div>'+
        '<div class="field-row"><span class="k">Paid to real estate</span><span class="v">'+(b.hasLeaseCost ? '−'+money(b.weeklyCost) : '—')+'</span></div>'+
        '</div>'+
        '<div class="field-list" style="margin-top:6px;">'+
        '<div class="field-row"><span class="k">Profit / week</span><span class="v" style="font-weight:700;">'+money(b.weeklyProfit)+'</span></div>'+
        (b.isFortnightlyLease ? '<div class="field-row"><span class="k">Profit / 2 weeks</span><span class="v">'+money(b.fortnightlyProfit)+'</span></div>' : '')+
        '<div class="field-row"><span class="k">Profit / month</span><span class="v">'+money(b.monthlyProfit)+'</span></div>'+
        '</div>'+
        (b.hasLeaseCost ? '' : '<p style="font-size:11px;color:var(--text-faint);margin:8px 0 0;">No lease amount set for this property, so cost is not subtracted here.</p>')+
        '</div>';
    }).join('');

    return pageHeader('Profits', "What each property earns after admin-paid costs bundled into rent, and what you pay the real estate.") +
      cardsHtml;
  }

  /* ---------- PHASE 13: Notifications ---------- */
  function notifId(e){ return e.kind + '|' + e.date + '|' + e.title; }
  function isNotifRead(e){ return notifReadIds.indexOf(notifId(e)) > -1; }
  function toggleNotifRead(id){
    var idx = notifReadIds.indexOf(id);
    if (idx > -1) notifReadIds.splice(idx, 1); else notifReadIds.push(id);
    saveNotifRead(notifReadIds);
    renderPreservingScroll();
  }
  window.toggleNotifRead = toggleNotifRead;
  function relativeDateLabel(dateIso){
    var diff = daysBetween(TODAY, dateIso);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    if (diff > 1) return 'In ' + diff + ' days';
    return Math.abs(diff) + ' days ago';
  }
  function renderNotifications(){
    var events = buildCalendarEvents().filter(function(e){
      var diff = daysBetween(TODAY, e.date);
      return e.kind === 'overdue' || (diff >= -3 && diff <= 14);
    }).sort(function(a,b){
      if ((a.kind==='overdue') !== (b.kind==='overdue')) return a.kind==='overdue' ? -1 : 1;
      return a.date.localeCompare(b.date);
    });
    var unreadCount = events.filter(function(e){ return !isNotifRead(e); }).length;

    var rows = events.length===0
      ? emptyState('bell', "You're all caught up", 'Nothing needs your attention right now — check back closer to your next due date.', '')
      : '<div class="card">' + events.map(function(e){
          var id = notifId(e);
          var read = isNotifRead(e);
          var iconName = e.kind==='overdue' ? 'bell' : e.kind==='move' ? 'tenants' : 'calendar';
          return '<div class="notif-row'+(read?' read':'')+'">'+
            '<a href="'+e.href+'" style="display:flex;gap:10px;align-items:center;flex:1;min-width:0;text-decoration:none;color:inherit;">'+
            '<span class="notif-icon '+e.kind+'">'+svg(iconName)+'</span>'+
            '<span style="min-width:0;"><div style="font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+esc(e.title)+'</div>'+
            '<div class="meta" style="font-size:11.5px;color:var(--text-faint);">'+relativeDateLabel(e.date)+' • '+shortDate(e.date)+'</div></span></a>'+
            '<button class="notif-dot-btn" title="'+(read?'Mark as unread':'Mark as read')+'" onclick="toggleNotifRead(\''+id+'\')"><span class="notif-dot'+(read?'':' unread')+'"></span></button>'+
            '</div>';
        }).join('') + '</div>';

    var dbNotifHtml = notificationsList.length === 0 ? '' :
      '<div class="card" style="margin-bottom:14px;"><h2 style="text-transform:none;letter-spacing:0;">Updates</h2>' +
      notificationsList.slice(0, 20).map(function(n){
        var clickAttr = notifDetailClickAttr(n);
        var meta = NOTIFICATION_CATEGORY_META[n.category] || NOTIFICATION_CATEGORY_META.general_announcement;
        return '<div class="notif-row'+(n.isRead?' read':'')+'"'+clickAttr+' style="padding:8px 0;'+(clickAttr?'cursor:pointer;':'')+'">'+
          '<span style="min-width:0;flex:1;"><div style="font-weight:600;font-size:13.5px;">'+meta.emoji+' '+esc(n.title)+'</div>'+
          '<div class="meta" style="font-size:11px;color:var(--text-faint);">'+meta.label+'</div>'+
          (n.body ? '<div class="meta" style="font-size:12px;color:var(--text-dim);">'+esc(n.body)+'</div>' : '')+
          '<div class="meta" style="font-size:11px;color:var(--text-faint);">'+shortDate((n.createdAt||'').slice(0,10))+'</div></span>'+
          (n.isRead ? '' : '<button class="notif-dot-btn" title="Mark as read" onclick="event.stopPropagation();markDbNotifRead(\''+n.id+'\')"><span class="notif-dot unread"></span></button>')+
          '</div>';
      }).join('') + '</div>';

    return pageHeader('Notifications', 'Reminders for rent due dates, overdue payments, bills and move-in/out.') +
      dbNotifHtml +
      (unreadCount>0 ? '<p style="font-size:12.5px;color:var(--text-dim);margin:0 0 10px;">'+unreadCount+' unread</p>' : '') +
      rows +
      '<div class="card" style="margin-top:14px;"><h2 style="text-transform:none;letter-spacing:0;">About notifications</h2>'+
      "<p style=\"font-size:13px;color:var(--text-dim);margin:0;\">This is an in-app notification centre — check this screen when you open the app. Real push notifications (system alerts even when the app is closed) need a backend and browser permissions, and aren't available yet.</p></div>";
  }

  /* ---- Staff: Notification Center — every notification ever sent, filterable, with compose/cancel/archive ---- */
  var notifFilterTenantId = 'all';
  var notifFilterPropertyId = 'all';
  var notifFilterCategory = 'all';

  function notificationsFiltered(){
    return notificationsList.filter(function(n){
      if (notifFilterTenantId !== 'all' && n.tenantId !== notifFilterTenantId) return false;
      if (notifFilterPropertyId !== 'all' && n.propertyId !== notifFilterPropertyId) return false;
      if (notifFilterCategory !== 'all' && n.category !== notifFilterCategory) return false;
      return true;
    });
  }

  function notifStatusLabel(n){
    if (n.canceledAt) return badge('overdue', 'Canceled');
    if (n.archivedAt) return badge('neutral', 'Archived');
    if (n.scheduledFor && n.scheduledFor > new Date().toISOString()) return badge('upcoming', 'Scheduled');
    return n.isRead ? badge('paid', 'Read') : badge('due', 'Unread');
  }

  function renderNotificationsStaff(){
    var filterOptionsTenants = '<option value="all">All residents</option>' + tenants.filter(function(t){ return t.rentAmount>0; }).sort(function(a,b){ return a.fullName.localeCompare(b.fullName); }).map(function(t){
      return '<option value="'+t.id+'"'+(notifFilterTenantId===t.id?' selected':'')+'>'+esc(t.fullName)+'</option>';
    }).join('');
    var filterOptionsProperties = '<option value="all">All properties</option>' + properties.slice().sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); }).map(function(p){
      return '<option value="'+p.id+'"'+(notifFilterPropertyId===p.id?' selected':'')+'>'+esc(p.name)+'</option>';
    }).join('');
    var filterOptionsCategories = '<option value="all">All categories</option>' + Object.keys(NOTIFICATION_CATEGORY_META).map(function(cat){
      var meta = NOTIFICATION_CATEGORY_META[cat];
      return '<option value="'+cat+'"'+(notifFilterCategory===cat?' selected':'')+'>'+meta.emoji+' '+meta.label+'</option>';
    }).join('');

    var rows = notificationsFiltered();
    var listHtml = rows.length===0
      ? emptyState('bell', 'No notifications match these filters', 'Try widening your filters, or send a new one.', '')
      : '<div class="card">' + rows.map(function(n){
          var meta = NOTIFICATION_CATEGORY_META[n.category] || NOTIFICATION_CATEGORY_META.general_announcement;
          var recipient = n.tenantId ? (tenantOf(n.tenantId) ? tenantOf(n.tenantId).fullName : '—') : (n.propertyId ? (propertyOf(n.propertyId) ? propertyOf(n.propertyId).name + ' (all residents)' : '—') : '—');
          var canCancel = n.scheduledFor && !n.canceledAt && !n.archivedAt && n.scheduledFor > new Date().toISOString();
          var canArchive = !n.archivedAt;
          // A row addressed to the signed-in admin themselves (e.g. a "missing bill" system
          // alert) needs its own mark-read affordance here — this list is the only place staff
          // sees their own notifications now that the route no longer falls back to renderNotifications().
          var isMine = currentProfile && n.authUserId === currentProfile.authUserId;
          return '<div class="notif-row" style="align-items:flex-start;padding:10px 0;">'+
            '<span style="min-width:0;flex:1;"><div style="font-weight:600;font-size:13.5px;">'+meta.emoji+' '+esc(n.title)+'</div>'+
            '<div class="meta" style="font-size:11.5px;color:var(--text-faint);">'+esc(recipient)+' · '+meta.label+' · created '+shortDate((n.createdAt||'').slice(0,10))+(n.scheduledFor?' · sends '+shortDate(n.scheduledFor.slice(0,10)):'')+'</div>'+
            (n.body ? '<div class="meta" style="font-size:12px;color:var(--text-dim);">'+esc(n.body)+'</div>' : '')+
            '</span>'+notifStatusLabel(n)+
            '<span style="display:flex;gap:6px;">'+
            (isMine && !n.isRead ? '<button class="mini-btn" onclick="markDbNotifRead(\''+n.id+'\')">Mark read</button>' : '')+
            (canCancel ? '<button class="mini-btn" onclick="cancelScheduledNotification(\''+n.id+'\')">Cancel</button>' : '')+
            (canArchive ? '<button class="mini-btn" onclick="archiveNotification(\''+n.id+'\')">Archive</button>' : '')+
            '</span></div>';
        }).join('') + '</div>';

    return pageHeader('Notifications', 'Everything sent to residents — filter, review, or send a new one.') +
      '<div class="card" style="margin-bottom:12px;"><div class="detail-head" style="margin-top:0;align-items:center;flex-wrap:wrap;gap:8px;">'+
      '<select id="notif-filter-tenant" onchange="setNotifFilter(\'tenant\',this.value)" style="max-width:180px;">'+filterOptionsTenants+'</select>'+
      '<select id="notif-filter-property" onchange="setNotifFilter(\'property\',this.value)" style="max-width:180px;">'+filterOptionsProperties+'</select>'+
      '<select id="notif-filter-category" onchange="setNotifFilter(\'category\',this.value)" style="max-width:200px;">'+filterOptionsCategories+'</select>'+
      '<button class="mini-btn primary" style="margin-left:auto;" onclick="openNotificationComposeModal()">+ New notification</button>'+
      '</div></div>'+
      listHtml;
  }

  window.setNotifFilter = function(kind, value){
    if (kind==='tenant') notifFilterTenantId = value;
    else if (kind==='property') notifFilterPropertyId = value;
    else if (kind==='category') notifFilterCategory = value;
    renderPreservingScroll();
  };

  window.cancelScheduledNotification = async function(id){
    try {
      await notificationService.cancelScheduled(id);
      var n = notificationsList.find(function(x){ return x.id===id; });
      if (n) n.canceledAt = new Date().toISOString();
      showToast('Notification canceled.', 'success');
      render();
    } catch(err){ showToast('Could not cancel. ' + friendlyErrorMessage(err), 'error'); }
  };

  window.archiveNotification = async function(id){
    try {
      await notificationService.archive(id);
      var n = notificationsList.find(function(x){ return x.id===id; });
      if (n) n.archivedAt = new Date().toISOString();
      showToast('Notification archived.', 'success');
      render();
    } catch(err){ showToast('Could not archive. ' + friendlyErrorMessage(err), 'error'); }
  };

  function onNotifComposeScopeChange(){
    var scope = document.getElementById('notif-compose-scope').value;
    document.getElementById('notif-compose-tenant-row').hidden = scope !== 'tenant';
    document.getElementById('notif-compose-property-row').hidden = scope !== 'property';
  }
  window.onNotifComposeScopeChange = onNotifComposeScopeChange;

  function openNotificationComposeModal(){
    var tenantSelect = document.getElementById('notif-compose-tenant');
    tenantSelect.innerHTML = tenants.filter(function(t){ return t.rentAmount>0 && !tenantHasMovedOut(t); }).sort(function(a,b){ return a.fullName.localeCompare(b.fullName); }).map(function(t){
      return '<option value="'+t.id+'">'+esc(t.fullName)+'</option>';
    }).join('');
    var propertySelect = document.getElementById('notif-compose-property');
    propertySelect.innerHTML = properties.slice().sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); }).map(function(p){
      return '<option value="'+p.id+'">'+esc(p.name)+'</option>';
    }).join('');
    var categorySelect = document.getElementById('notif-compose-category');
    categorySelect.innerHTML = Object.keys(NOTIFICATION_CATEGORY_META).map(function(cat){
      var meta = NOTIFICATION_CATEGORY_META[cat];
      return '<option value="'+cat+'">'+meta.emoji+' '+meta.label+'</option>';
    }).join('');
    document.getElementById('notif-compose-scope').value = 'tenant';
    document.getElementById('notif-compose-title').value = '';
    document.getElementById('notif-compose-body').value = '';
    document.getElementById('notif-compose-schedule').value = '';
    onNotifComposeScopeChange();
    document.getElementById('notification-compose-modal-error').hidden = true;
    document.getElementById('notification-compose-modal').hidden = false;
  }
  window.openNotificationComposeModal = openNotificationComposeModal;

  function closeNotificationComposeModal(){ document.getElementById('notification-compose-modal').hidden = true; }
  window.closeNotificationComposeModal = closeNotificationComposeModal;

  async function saveNotificationCompose(){
    var scope = document.getElementById('notif-compose-scope').value;
    var category = document.getElementById('notif-compose-category').value;
    var title = document.getElementById('notif-compose-title').value.trim();
    var body = document.getElementById('notif-compose-body').value.trim();
    var scheduleRaw = document.getElementById('notif-compose-schedule').value;
    var scheduledFor = scheduleRaw ? new Date(scheduleRaw).toISOString() : null;
    var errorEl = document.getElementById('notification-compose-modal-error');
    if (!title){
      errorEl.textContent = 'Enter a title.';
      errorEl.hidden = false;
      return;
    }
    var createdByProfileId = currentProfile ? currentProfile.id : null;
    try {
      if (scope === 'tenant'){
        var tenantId = document.getElementById('notif-compose-tenant').value;
        var t = tenantOf(tenantId);
        if (!t){ errorEl.textContent = 'Choose a resident.'; errorEl.hidden = false; return; }
        if (!t.authUserId){ errorEl.textContent = 'This resident has no account yet, so they cannot receive in-app notifications.'; errorEl.hidden = false; return; }
        // notifyOrThrow (not notify) — the admin needs to actually know if this failed, unlike
        // the automatic/background call sites, which stay silent by design.
        await notificationService.notifyOrThrow(t.authUserId, title, body, 'tenants', t.id, { category: category, propertyId: t.propertyId, tenantId: t.id, scheduledFor: scheduledFor, createdByProfileId: createdByProfileId });
      } else if (scope === 'property'){
        var propertyId = document.getElementById('notif-compose-property').value;
        var propTenants = tenants.filter(function(x){ return x.propertyId===propertyId && x.rentAmount>0 && !tenantHasMovedOut(x); });
        var propResults = await notificationService.notifyProperty(propertyId, propTenants, title, body, category, { scheduledFor: scheduledFor, createdByProfileId: createdByProfileId });
        if (!propResults.some(function(r){ return r.sent; })){
          errorEl.textContent = 'Nobody was notified — no active resident of this property has an account yet.';
          errorEl.hidden = false;
          return;
        }
      } else {
        var allActive = tenants.filter(function(x){ return x.rentAmount>0 && !tenantHasMovedOut(x); });
        var allResults = await notificationService.notifyPortfolio(allActive, title, body, category, { scheduledFor: scheduledFor, createdByProfileId: createdByProfileId });
        if (!allResults.some(function(r){ return r.sent; })){
          errorEl.textContent = 'Nobody was notified — no active resident has an account yet.';
          errorEl.hidden = false;
          return;
        }
      }
      notificationsList = (await notificationService.getAll());
      closeNotificationComposeModal();
      showToast('Notification sent.', 'success');
      render();
    } catch(err){
      errorEl.textContent = friendlyErrorMessage(err);
      errorEl.hidden = false;
    }
  }
  window.saveNotificationCompose = saveNotificationCompose;

  /** Returns a ready-to-splice ` onclick="..."` attribute that opens whatever this DB notification
   *  is actually about (so selecting it shows the real detail, not the dashboard) — or '' when
   *  there's nothing to open. Marks it read at the same time, same as the dot button does. */
  function notifDetailClickAttr(n){
    var openCall = null;
    if (n.relatedTable === 'maintenance_requests' && n.relatedId){
      openCall = 'openMaintenanceModal(\''+n.relatedId+'\')';
    } else if (n.relatedTable === 'bills' && n.relatedId){
      openCall = isTenantRole() ? 'location.hash=\'#/bills\'' : ('location.hash=\'#/bills/'+n.relatedId+'\'');
    } else if (n.relatedTable === 'tenants' && n.relatedId){
      openCall = isTenantRole() ? 'location.hash=\'#/\'' : ('location.hash=\'#/tenants/'+n.relatedId+'\'');
    } else if (n.relatedTable === 'cleaning_tasks' && n.relatedId){
      openCall = 'location.hash=\'#/cleaning\'';
    } else if (n.relatedTable === 'inspection_submissions' && n.relatedId){
      openCall = 'location.hash=\'#/inspection\'';
    }
    if (!openCall) return '';
    return ' onclick="markDbNotifRead(\''+n.id+'\');'+openCall+'"';
  }

  async function markDbNotifRead(id){
    try {
      await notificationService.markRead(id);
      var n = notificationsList.find(function(x){ return x.id===id; });
      if (n) n.isRead = true;
      render();
    } catch(err){
      showToast('Could not mark as read. ' + friendlyErrorMessage(err), 'error');
    }
  }
  window.markDbNotifRead = markDbNotifRead;

  /* ---------- PHASE 14: App lock (local PIN) + Backup/restore ---------- */
  var APP_PIN_KEY = 'belmont-manager-app-pin';
  function getAppPin(){ try { return localStorage.getItem(APP_PIN_KEY) || ''; } catch(e){ return ''; } }
  function setAppPin(pin){ try { if (pin) localStorage.setItem(APP_PIN_KEY, pin); else localStorage.removeItem(APP_PIN_KEY); } catch(e){ /* ignorar */ } }
  function openSetPinModal(){
    document.getElementById('pin-input-1').value = '';
    document.getElementById('pin-input-2').value = '';
    document.getElementById('pin-modal-error').hidden = true;
    document.getElementById('pin-modal').hidden = false;
  }
  function closeSetPinModal(){ document.getElementById('pin-modal').hidden = true; }
  function confirmSetPin(){
    var p1 = document.getElementById('pin-input-1').value;
    var p2 = document.getElementById('pin-input-2').value;
    var err = document.getElementById('pin-modal-error');
    if (!/^\d{4,6}$/.test(p1) || p1 !== p2){
      err.textContent = 'Enter the same 4-to-6-digit PIN in both fields.';
      err.hidden = false;
      return;
    }
    setAppPin(p1);
    closeSetPinModal();
    render();
  }
  function removeAppPin(){ setAppPin(''); render(); }
  function attemptUnlock(){
    var input = document.getElementById('lock-pin-input');
    var err = document.getElementById('lock-error');
    if (input.value === getAppPin()){
      document.getElementById('lock-screen').hidden = true;
      input.value = '';
      err.hidden = true;
    } else {
      err.hidden = false;
      input.value = '';
      input.focus();
    }
  }
  window.openSetPinModal = openSetPinModal;
  window.closeSetPinModal = closeSetPinModal;
  window.confirmSetPin = confirmSetPin;
  window.removeAppPin = removeAppPin;
  window.attemptUnlock = attemptUnlock;

  function downloadViaAnchor(filename, json){
    // Fallback for when there's no capability system (e.g. opened directly as file://).
    var blob = new Blob([json], { type:'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  }
  function exportBackup(){
    var data = {
      exportedAt: TODAY,
      properties: properties,
      rooms: rooms,
      tenants: tenants,
      bonds: bonds,
      rentSchedules: rentSchedules,
      paymentRecords: paymentRecords,
      bills: bills,
      notifReadIds: notifReadIds
    };
    var json = JSON.stringify(data, null, 2);
    var filename = 'belmont-manager-backup-' + TODAY + '.json';
    downloadViaAnchor(filename, json);
    backupStatusMessage = 'Backup downloaded.';
    render();
  }
  var backupStatusMessage = '';
  function handleImportBackup(evt){
    var file = evt.target.files && evt.target.files[0];
    evt.target.value = '';
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function(){
      // Important: render() redraws the whole page (innerHTML), so
      // the status message has to live in a variable and come out of renderSettings(),
      // not be written directly into the old <p> — that node disappears as soon as render() runs.
      try {
        var data = JSON.parse(reader.result);
        if (!data || typeof data !== 'object') throw new Error('invalid format');
        // NOTE: this restores into the CURRENT SESSION's in-memory view only —
        // it does not write back to Supabase. It's a quick way to inspect an
        // old snapshot; reloading the page goes back to what's in the cloud.
        // To actually move old data into Supabase, use "Migrate local data to
        // cloud" below (services/migrationService.js), not this restore.
        if (Array.isArray(data.properties)) properties = data.properties;
        if (Array.isArray(data.rooms)) rooms = data.rooms;
        if (Array.isArray(data.tenants)) tenants = data.tenants;
        if (Array.isArray(data.bonds)) bonds = data.bonds;
        if (Array.isArray(data.rentSchedules)) rentSchedules = data.rentSchedules;
        if (Array.isArray(data.paymentRecords)) paymentRecords = data.paymentRecords;
        if (Array.isArray(data.bills)) bills = data.bills;
        if (Array.isArray(data.notifReadIds)){ notifReadIds = data.notifReadIds; saveNotifRead(notifReadIds); }
        recomputeRentCharges();
        refreshStaticSelects();
        backupStatusMessage = 'Backup loaded into this session (not saved to the cloud — reloading the page goes back to your Supabase data).';
      } catch(e){
        backupStatusMessage = "Couldn't read that file — it doesn't look like a valid backup.";
      }
      render();
    };
    reader.readAsText(file);
  }
  window.exportBackup = exportBackup;
  window.handleImportBackup = handleImportBackup;

  /* ---------- Phase E: localStorage -> Supabase migration tool ---------- */
  // Lives outside runLocalMigration (like backupStatusMessage) because render() replaces
  // the whole page via innerHTML — a status written straight into the old DOM node would
  // vanish the moment anything re-renders. renderSettings() reads this var each time.
  var migrationStatusMessage = '';
  async function runLocalMigration(){
    var btn = document.getElementById('migrate-btn');
    var statusEl = document.getElementById('migration-status');
    if (btn){ btn.disabled = true; btn.textContent = 'Migrating…'; }
    migrationStatusMessage = 'Migrating your local data — this can take a moment…';
    if (statusEl) statusEl.textContent = migrationStatusMessage;
    try {
      var result = await migrationService.migrate();
      window.__lastMigrationResult = result; // handy for debugging/tests
      var lines = [];
      Object.keys(result.counts).forEach(function(key){
        if (result.counts[key] > 0) lines.push(result.counts[key] + ' ' + key + ' migrated');
      });
      if (result.success){
        migrationStatusMessage = 'Your local data has been successfully migrated to the cloud.\n' + lines.join(', ');
        showToast('Migration complete.', 'success');
      } else {
        migrationStatusMessage = 'Migration finished with some issues.\n' +
          (lines.length ? 'Succeeded: ' + lines.join(', ') + '\n' : '') +
          'Not migrated:\n' + result.failures.map(function(f){ return '- ' + f.entity + ' ' + f.oldId + ': ' + f.reason; }).join('\n');
        showToast('Migration finished with some items that need attention — see Settings for details.', 'error');
      }
      // Reload the in-memory arrays from Supabase so the freshly-migrated data shows up immediately.
      await bootstrapData();
      render();
    } catch(err){
      migrationStatusMessage = 'Migration failed before it could finish: ' + friendlyErrorMessage(err) + '. Nothing further was changed — your local data is untouched and you can try again.';
      showToast('Migration failed. ' + friendlyErrorMessage(err), 'error');
      render();
    }
  }
  window.runLocalMigration = runLocalMigration;

  function renderSettings(){
    if (isTenantRole()){
      return pageHeader('Settings', '') +
        '<div class="card"><h2 style="text-transform:none;letter-spacing:0;">Account</h2>'+
        '<div style="display:flex;gap:8px;flex-wrap:wrap;">'+
        '<button class="mini-btn" onclick="openChangePasswordModal()">Change password</button>'+
        '<button class="mini-btn" onclick="signOutAndReload()">Sign out</button>'+
        '</div></div>';
    }
    var pin = getAppPin();
    var hasLocalData = migrationService.hasLocalData();
    var migrationCard = '<div class="card"><h2 style="text-transform:none;letter-spacing:0;">Migrate local data to cloud</h2>'+
      '<p style="font-size:13px;color:var(--text-dim);margin:0 0 10px;">If this browser still has data saved from an older, offline version of this app, this copies it into your Supabase account (new cloud IDs are assigned, and everything is relinked). Your old local data is left untouched as a safety-net backup.</p>'+
      (hasLocalData
        ? '<button class="mini-btn primary" id="migrate-btn" onclick="runLocalMigration()">Migrate local data to cloud</button>'
        : '<p style="font-size:12.5px;color:var(--text-faint);margin:0;">No old local data was found in this browser.</p>')+
      '<div id="migration-status" style="font-size:12px;color:var(--text-dim);margin-top:8px;white-space:pre-wrap;">'+esc(migrationStatusMessage)+'</div>'+
      '</div>';
    var recurringSection = isStaff() ? recurringBillsCardHtml('all') : '';
    return pageHeader('Settings', 'App lock, backup and sync, and preferences.') +
      '<div class="card"><h2 style="text-transform:none;letter-spacing:0;">About storage</h2>'+
      '<p style="font-size:13.5px;color:var(--text-dim);margin:0;">Your data is stored in your own Supabase project, protected by row-level security, and loaded fresh from there every time you sign in. Use the backup below for an extra offline copy.</p></div>'+
      recurringSection +
      migrationCard +
      '<div class="card"><h2 style="text-transform:none;letter-spacing:0;">App lock (local)</h2>'+
      '<p style="font-size:13px;color:var(--text-dim);margin:0 0 10px;">A simple screen PIN for this app on this device. It is not encryption or real authentication — it only stops a casual glance; anyone using the browser\'s developer tools can bypass it.</p>'+
      (pin
        ? '<div class="field-row"><span class="k">Status</span><span class="v">PIN set</span></div>'+
          '<div style="display:flex;gap:8px;margin-top:12px;">'+
          '<button class="mini-btn" onclick="openSetPinModal()">Change PIN</button>'+
          '<button class="mini-btn" onclick="removeAppPin()">Remove PIN</button></div>'
        : '<button class="mini-btn primary" onclick="openSetPinModal()">Set a PIN</button>')+
      '</div>'+
      '<div class="card"><h2 style="text-transform:none;letter-spacing:0;">Backup &amp; restore</h2>'+
      '<p style="font-size:13px;color:var(--text-dim);margin:0 0 10px;">Export a JSON file with your properties, rooms, tenants, bonds, rent schedules, payments, bills (including allocations) and notification status. Import it to restore — this replaces the data currently on this device.</p>'+
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">'+
      '<button class="mini-btn primary" onclick="exportBackup()">Export backup (.json)</button>'+
      '<button class="mini-btn" onclick="document.getElementById(\'backup-file-input\').click()">Import backup</button>'+
      '</div>'+
      '<input type="file" id="backup-file-input" accept="application/json" hidden onchange="handleImportBackup(event)" />'+
      (backupStatusMessage ? '<p id="backup-status" style="font-size:12px;color:var(--text-dim);margin:8px 0 0;">'+esc(backupStatusMessage)+'</p>' : '<p id="backup-status" style="font-size:12px;color:var(--text-dim);margin:8px 0 0;"></p>')+
      '</div>'+
      '<div class="card"><h2 style="text-transform:none;letter-spacing:0;">Account</h2>'+
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">'+
      '<button class="mini-btn" onclick="openChangePasswordModal()">Change password</button>'+
      '<button class="mini-btn" onclick="signOutAndReload()">Sign out</button>'+
      '</div></div>';
  }

  function openChangePasswordModal(){
    document.getElementById('change-password-new').value = '';
    document.getElementById('change-password-confirm').value = '';
    document.getElementById('change-password-error').hidden = true;
    document.getElementById('change-password-modal').hidden = false;
  }
  window.openChangePasswordModal = openChangePasswordModal;

  function closeChangePasswordModal(){
    document.getElementById('change-password-modal').hidden = true;
  }
  window.closeChangePasswordModal = closeChangePasswordModal;

  async function saveChangePassword(){
    var newPw = document.getElementById('change-password-new').value;
    var confirmPw = document.getElementById('change-password-confirm').value;
    var errorEl = document.getElementById('change-password-error');
    if (!newPw || newPw.length < 8){
      errorEl.textContent = 'The new password must be at least 8 characters.';
      errorEl.hidden = false;
      return;
    }
    if (newPw !== confirmPw){
      errorEl.textContent = 'The two passwords don\'t match.';
      errorEl.hidden = false;
      return;
    }
    var saveBtn = document.querySelector('#change-password-modal .mini-btn.primary');
    var originalLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    errorEl.hidden = true;
    try {
      await auth.updatePassword(newPw);
      // Saves the copy visible in Users (if this account is Administrator/Super Admin) — the
      // same thing a reset done by the Super Admin does, so "Users" doesn't end up out of date.
      if (currentProfile){
        try { await profileService.forceSetPassword(currentProfile.id, newPw); } catch(_e){ /* best-effort */ }
      }
      closeChangePasswordModal();
      showToast('Password updated.', 'success');
    } catch(err){
      errorEl.textContent = friendlyErrorMessage(err);
      errorEl.hidden = false;
    } finally {
      if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = originalLabel; }
    }
  }
  window.saveChangePassword = saveChangePassword;

  function renderMore(){
    var items = NAV.filter(function(i){ return !i.primary; });
    var rows = items.map(function(item){
      return '<a href="'+item.hash+'">'+svg(item.icon)+'<span>'+item.label+'</span>'+svg('chevron','class="chev"')+'</a>';
    }).join('');
    return pageHeader('More', 'Everything else, in one place.') + '<div class="more-list">'+rows+'</div>';
  }

  function accessDeniedPage(){
    return pageHeader('Access denied', "You don't have permission to view this page.") +
      '<div class="card"><p style="font-size:13.5px;color:var(--text-dim);margin:0;">If you think this is a mistake, ask your Super Admin to check your role.</p></div>';
  }

  /* ============ Maintenance (shared page: staff see/manage every request, tenants see and
   * report only their own — RLS enforces this, the UI just adapts what it offers) ============ */
  var MAINTENANCE_STATUS_ORDER = ['reported','assigned','in_progress','waiting','completed','verified','closed','cancelled','rejected'];
  var MAINTENANCE_STATUS_BADGE = { reported:'due', assigned:'upcoming', in_progress:'neutral', waiting:'due', completed:'paid', verified:'paid', closed:'neutral', cancelled:'neutral', rejected:'overdue' };
  var MAINTENANCE_STATUS_LABEL = { reported:'Reported', assigned:'Assigned', in_progress:'In Progress', waiting:'Waiting', completed:'Completed', verified:'Verified', closed:'Closed', cancelled:'Cancelled', rejected:'Rejected' };
  var MAINTENANCE_PRIORITY_ORDER = ['low','medium','high','urgent'];
  var MAINTENANCE_PRIORITY_BADGE = { low:'neutral', medium:'upcoming', high:'due', urgent:'overdue' };
  var MAINTENANCE_PRIORITY_LABEL = { low:'Low', medium:'Medium', high:'High', urgent:'Urgent' };
  var MAINTENANCE_CATEGORY_LABEL = { plumbing:'Plumbing', electrical:'Electrical', appliance:'Appliance', pest_control:'Pest control', cleaning:'Cleaning', structural:'Structural', other:'Other' };
  // Statuses that mean the request is no longer active — a due_date in the past no longer counts
  // as "overdue" once a request lands in one of these (matches the completed/not_completed
  // convention used elsewhere for task_index rows).
  var MAINTENANCE_DONE_STATUSES = ['completed','verified','closed','cancelled','rejected'];

  function renderMaintenance(){
    var staff = isStaff();
    var rows = maintenanceRequests.slice().sort(function(a,b){ return (b.createdAt||'').localeCompare(a.createdAt||''); });
    var listHtml = rows.length === 0
      ? '<div class="card"><p style="font-size:13.5px;color:var(--text-dim);margin:0;">No maintenance requests yet.</p></div>'
      : rows.map(function(m){
          var p = propertyOf(m.propertyId);
          var r = m.roomId ? roomOf(m.roomId) : null;
          var t = m.tenantId ? tenantOf(m.tenantId) : null;
          var isOverdue = m.dueDate && m.dueDate < TODAY && MAINTENANCE_DONE_STATUSES.indexOf(m.status) === -1;
          var photoCount = (m.photosBefore||[]).length + (m.photosDuring||[]).length + (m.photosAfter||[]).length;
          return '<div class="card" style="cursor:pointer;" onclick="openMaintenanceModal(\''+m.id+'\')">'+
            '<div class="detail-head" style="margin-top:0;align-items:center;">'+
            '<h2 style="margin:0;font-size:14px;">'+esc(m.title)+'</h2>'+
            badge(MAINTENANCE_STATUS_BADGE[m.status]||'neutral', MAINTENANCE_STATUS_LABEL[m.status]||m.status)+
            '</div>'+
            '<p style="font-size:12.5px;color:var(--text-dim);margin:2px 0;">'+
            (p ? esc(p.name) : '') + (r ? ' · '+esc(r.name) : '') + (t ? ' · '+esc(t.fullName) : '') +
            '</p>'+
            '<p style="font-size:11.5px;color:var(--text-faint);margin:0;">'+
            (MAINTENANCE_CATEGORY_LABEL[m.category]||m.category) + ' · Priority: ' + (MAINTENANCE_PRIORITY_LABEL[m.priority]||m.priority) + ' · ' + shortDate((m.createdAt||'').slice(0,10)) +
            (photoCount ? ' · 📷 '+photoCount : '') +
            (m.dueDate ? ' · ' + (isOverdue ? badge('overdue','Due '+shortDate(m.dueDate)) : 'Due '+shortDate(m.dueDate)) : '') +
            '</p>'+
            '</div>';
        }).join('');
    return pageHeader('Maintenance', staff ? 'Every property\'s open and past requests.' : 'Report a problem and track its status.') +
      '<button class="mini-btn primary" style="margin-bottom:12px;" onclick="openMaintenanceModal(null)">'+(staff?'New request':'Report a problem')+'</button>'+
      listHtml;
  }

  var maintenanceModalEditId = null;
  function onMaintenancePropertyChange(){
    var propId = document.getElementById('maintenance-property').value;
    var roomSelect = document.getElementById('maintenance-room');
    var propRooms = rooms.filter(function(r){ return r.propertyId === propId; });
    roomSelect.innerHTML = '<option value="">— Not specific to a room —</option>' +
      propRooms.map(function(r){ return '<option value="'+r.id+'">'+esc(r.name)+'</option>'; }).join('');
  }
  window.onMaintenancePropertyChange = onMaintenancePropertyChange;

  function openMaintenanceModal(id){
    maintenanceModalEditId = id || null;
    var m = id ? maintenanceRequests.find(function(x){ return x.id===id; }) : null;
    // Consume-once: only a brand-new (!id) open picks up a pending "Create Maintenance Task from
    // finding" prefill; opening an existing request always clears any stray leftover one.
    var prefill = (!id && maintenanceModalPrefill) ? maintenanceModalPrefill : null;
    if (id) maintenanceModalPrefill = null;
    var staff = isStaff();
    document.getElementById('maintenance-modal-title').textContent = m ? 'Maintenance request' : 'Report a problem';
    document.getElementById('maintenance-property-row').hidden = !staff;
    document.getElementById('maintenance-room-row').hidden = !staff;
    document.getElementById('maintenance-status-row').hidden = !(staff && m);
    document.getElementById('maintenance-due-date-row').hidden = !(staff && m);
    document.getElementById('maintenance-assigned-to-row').hidden = !(staff && m);
    document.getElementById('maintenance-resolution-notes-row').hidden = !(staff && m);
    var sourceNoteEl = document.getElementById('maintenance-modal-source-note');
    if (sourceNoteEl){
      var sourceComment = m ? findingCommentForMaintenanceRequest(m.id) : null;
      if (sourceComment){
        var excerpt = sourceComment.comment.length > 140 ? sourceComment.comment.slice(0, 140) + '…' : sourceComment.comment;
        sourceNoteEl.innerHTML = 'Created from inspection finding: "' + esc(excerpt) + '"';
        sourceNoteEl.hidden = false;
      } else {
        sourceNoteEl.hidden = true;
      }
    }
    if (staff){
      var propSelect = document.getElementById('maintenance-property');
      propSelect.innerHTML = properties.map(function(p){ return '<option value="'+p.id+'">'+esc(p.name)+'</option>'; }).join('');
      propSelect.value = m ? m.propertyId : (prefill ? prefill.propertyId : (properties[0] ? properties[0].id : ''));
      onMaintenancePropertyChange();
      if (m && m.roomId) document.getElementById('maintenance-room').value = m.roomId;
      else if (prefill && prefill.roomId) document.getElementById('maintenance-room').value = prefill.roomId;
    }
    document.getElementById('maintenance-title').value = m ? m.title : (prefill ? prefill.title : '');
    document.getElementById('maintenance-title').disabled = !!(m && !staff);
    document.getElementById('maintenance-description').value = m ? (m.description||'') : (prefill ? prefill.description : '');
    document.getElementById('maintenance-description').disabled = !!(m && !staff);
    document.getElementById('maintenance-category').value = m ? m.category : 'other';
    document.getElementById('maintenance-category').disabled = !!(m && !staff);
    var prioritySelect = document.getElementById('maintenance-priority');
    prioritySelect.innerHTML = MAINTENANCE_PRIORITY_ORDER.map(function(v){ return '<option value="'+v+'">'+MAINTENANCE_PRIORITY_LABEL[v]+'</option>'; }).join('');
    prioritySelect.value = m ? m.priority : (prefill ? prefill.priority : 'medium');
    prioritySelect.disabled = !!(m && !staff);
    var statusSelect = document.getElementById('maintenance-status');
    statusSelect.innerHTML = MAINTENANCE_STATUS_ORDER.map(function(v){ return '<option value="'+v+'">'+MAINTENANCE_STATUS_LABEL[v]+'</option>'; }).join('');
    statusSelect.value = m ? m.status : 'reported';
    document.getElementById('maintenance-due-date').value = m && m.dueDate ? m.dueDate : '';
    document.getElementById('maintenance-assigned-to').value = m ? (m.assignedTo || '') : '';
    document.getElementById('maintenance-resolution-notes').value = m ? (m.resolutionNotes || '') : '';
    document.getElementById('maintenance-photo-before').value = '';
    document.getElementById('maintenance-photo-during').value = '';
    document.getElementById('maintenance-photo-after').value = '';
    var docsRow = document.getElementById('maintenance-documents-row');
    if (docsRow){
      docsRow.hidden = !(staff && m);
      if (staff && m){
        var hasTenant = !!m.tenantId;
        document.getElementById('maintenance-documents-no-tenant').hidden = hasTenant;
        document.getElementById('maintenance-documents-attach').hidden = !hasTenant;
        var docTypeSelect = document.getElementById('maintenance-doc-type');
        docTypeSelect.innerHTML = Object.keys(DOC_TYPE_LABEL).map(function(k){
          return '<option value="'+k+'">'+esc(DOC_TYPE_LABEL[k])+'</option>';
        }).join('');
        document.getElementById('maintenance-doc-file').value = '';
        renderMaintenanceDocumentsList(m.id);
      }
    }
    document.getElementById('maintenance-modal-error').hidden = true;
    document.getElementById('maintenance-modal').hidden = false;
    var saveBtn = document.querySelector('#maintenance-modal .mini-btn.primary');
    if (saveBtn) saveBtn.hidden = false;
    renderMaintenancePhotosPreview('before', m ? (m.photosBefore||[]) : (prefill ? prefill.photosBefore : []));
    renderMaintenancePhotosPreview('during', m ? (m.photosDuring||[]) : []);
    renderMaintenancePhotosPreview('after', m ? (m.photosAfter||[]) : []);
  }
  window.openMaintenanceModal = openMaintenanceModal;

  /** Documents attached to a maintenance request via entity_links (relation 'attached_to',
   *  from_table='tenant_documents'). Reads the already-loaded `entityLinks`/`tenantDocuments`
   *  in-memory arrays (same pattern as findingCommentForMaintenanceRequest above) rather than
   *  a fresh entityLinkService.getLinksFor() round-trip, since entity_links is loaded whole at
   *  bootstrap and already kept in sync on write elsewhere in this file. */
  function renderMaintenanceDocumentsList(requestId){
    var box = document.getElementById('maintenance-documents-list');
    if (!box) return;
    var links = entityLinks.filter(function(l){
      return l.fromTable==='tenant_documents' && l.toTable==='maintenance_requests' && l.toId===requestId;
    });
    if (!links.length){
      box.innerHTML = '<p style="font-size:12.5px;color:var(--text-dim);margin:0;">No documents attached.</p>';
      return;
    }
    box.innerHTML = links.map(function(l){
      var doc = tenantDocuments.find(function(d){ return d.id===l.fromId; });
      if (!doc) return '';
      return '<div class="field-row"><span class="k">'+esc(doc.fileName||doc.docType)+' — '+esc(DOC_TYPE_LABEL[doc.docType]||'Other')+'</span>'+
        '<span class="v"><button class="text-link" onclick="viewReceipt(\'documents\',\''+doc.storagePath+'\')">View</button></span></div>';
    }).join('');
  }
  window.renderMaintenanceDocumentsList = renderMaintenanceDocumentsList;

  /** Staff-only "Attach document" control inside the maintenance modal (only shown once a
   *  request has a tenant_id — see openMaintenanceModal — since tenant_documents.tenant_id is
   *  NOT NULL). Reuses confirmAddDocument's upload path (storageService.uploadDocument +
   *  tenantDocumentService.create), then records the association via entityLinkService so the
   *  document shows up here without any tenant_documents schema change. */
  async function confirmAddMaintenanceDocument(){
    var requestId = maintenanceModalEditId;
    var m = requestId ? maintenanceRequests.find(function(x){ return x.id===requestId; }) : null;
    if (!m || !m.tenantId) return;
    var fileInput = document.getElementById('maintenance-doc-file');
    var file = fileInput.files && fileInput.files[0];
    if (!file) return;
    var docType = document.getElementById('maintenance-doc-type').value;
    try {
      var storagePath = await storageService.uploadDocument(m.tenantId, file);
      var saved = await tenantDocumentService.create({ tenantId: m.tenantId, docType: docType, storagePath: storagePath, fileName: file.name || 'document' });
      tenantDocuments.push(saved);
      var newLink = await entityLinkService.linkEntities('tenant_documents', saved.id, 'maintenance_requests', requestId, 'attached_to');
      entityLinks.push(newLink);
      fileInput.value = '';
      renderMaintenanceDocumentsList(requestId);
      showToast('Document attached.', 'success');
      await refreshOperationsReadModels();
    } catch(err){
      showToast('Could not attach this document. ' + friendlyErrorMessage(err), 'error');
    }
  }
  window.confirmAddMaintenanceDocument = confirmAddMaintenanceDocument;

  /** Shows one stage's ("before"/"during"/"after") already-uploaded photos as small thumbnails
   *  (signed URLs, loaded async) above that stage's file picker, so re-opening a request doesn't
   *  look like it lost its photos. Each stage gets its own lightbox group, so Previous/Next inside
   *  the lightbox stays scoped to the stage the user opened. */
  function renderMaintenancePhotosPreview(stage, existingPaths){
    var box = document.getElementById('maintenance-photos-' + stage + '-preview');
    if (!box) return;
    box.innerHTML = '';
    var groupId = 'lbg' + (++lightboxGroupSeq);
    (existingPaths||[]).forEach(function(path, idx){
      var img = document.createElement('img');
      img.style.cssText = 'width:52px;height:52px;object-fit:cover;border-radius:6px;border:1px solid var(--border);cursor:pointer;background:var(--surface-2,#eee);';
      img.title = 'Open photo';
      registerLightboxImg(img, 'maintenance-photos', path, groupId, idx);
      getCachedSignedUrl('maintenance-photos', path, 600).then(function(url){ img.src = url; }).catch(function(){ /* ignore a single broken thumbnail */ });
      box.appendChild(img);
    });
  }

  function closeMaintenanceModal(){
    document.getElementById('maintenance-modal').hidden = true;
    maintenanceModalEditId = null;
    maintenanceModalPrefill = null;
  }
  window.closeMaintenanceModal = closeMaintenanceModal;

  async function saveMaintenanceForm(){
    // Captured before closeMaintenanceModal() (called below on success) clears it — this is the
    // one read that decides whether a "Create Issue" link gets recorded for this save.
    var prefill = maintenanceModalPrefill;
    var title = document.getElementById('maintenance-title').value.trim();
    var description = document.getElementById('maintenance-description').value.trim();
    var category = document.getElementById('maintenance-category').value;
    var priority = document.getElementById('maintenance-priority').value;
    var status = document.getElementById('maintenance-status').value;
    var errorEl = document.getElementById('maintenance-modal-error');
    if (!title){
      errorEl.textContent = 'Add a short title for the problem.';
      errorEl.hidden = false;
      return;
    }

    var propertyId, roomId, tenantId;
    var existing = maintenanceModalEditId ? maintenanceRequests.find(function(x){ return x.id===maintenanceModalEditId; }) : null;
    if (isStaff()){
      propertyId = document.getElementById('maintenance-property').value;
      roomId = document.getElementById('maintenance-room').value || null;
      if (!propertyId){
        errorEl.textContent = 'Choose a property.';
        errorEl.hidden = false;
        return;
      }
      tenantId = existing ? existing.tenantId : (prefill ? prefill.tenantId : null);
    } else {
      var myTenant = myTenantRecord();
      if (!myTenant){
        errorEl.textContent = 'Your account is not linked to a tenant record yet — ask your Super Admin.';
        errorEl.hidden = false;
        return;
      }
      propertyId = myTenant.propertyId;
      roomId = myTenant.roomId || null;
      tenantId = myTenant.id;
    }

    var photoFilesBefore = document.getElementById('maintenance-photo-before').files;
    var photoFilesDuring = document.getElementById('maintenance-photo-during').files;
    var photoFilesAfter = document.getElementById('maintenance-photo-after').files;
    var saveBtn = document.querySelector('#maintenance-modal .mini-btn.primary');
    var originalLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    errorEl.hidden = true;
    try {
      var photosBefore = existing ? (existing.photosBefore || []).slice() : (prefill ? (prefill.photosBefore || []).slice() : []);
      var photosDuring = existing ? (existing.photosDuring || []).slice() : [];
      var photosAfter = existing ? (existing.photosAfter || []).slice() : [];
      if (photoFilesBefore && photoFilesBefore.length){
        photosBefore = photosBefore.concat(await storageService.uploadMaintenancePhotos(photoFilesBefore));
      }
      if (photoFilesDuring && photoFilesDuring.length){
        photosDuring = photosDuring.concat(await storageService.uploadMaintenancePhotos(photoFilesDuring));
      }
      if (photoFilesAfter && photoFilesAfter.length){
        photosAfter = photosAfter.concat(await storageService.uploadMaintenancePhotos(photoFilesAfter));
      }
      var dueDate = existing ? existing.dueDate : null;
      var assignedTo = existing ? existing.assignedTo : null;
      var resolutionNotes = existing ? existing.resolutionNotes : '';
      if (isStaff() && existing){
        dueDate = document.getElementById('maintenance-due-date').value || null;
        assignedTo = document.getElementById('maintenance-assigned-to').value.trim() || null;
        resolutionNotes = document.getElementById('maintenance-resolution-notes').value.trim();
      }
      var draft = { propertyId:propertyId, roomId:roomId, tenantId:tenantId, title:title, description:description,
        category:category, priority:priority, photosBefore:photosBefore, photosDuring:photosDuring, photosAfter:photosAfter,
        status: existing ? status : 'reported',
        dueDate:dueDate, assignedTo:assignedTo, resolutionNotes:resolutionNotes };
      if (existing){
        var saved = await maintenanceService.update(existing.id, draft);
        Object.assign(existing, saved);
        if (isStaff() && status !== existing.status){
          // handled by Object.assign above already updating status; notify the tenant who reported it, if linked.
        }
        var reporterTenant = existing.tenantId ? tenantOf(existing.tenantId) : null;
        if (isStaff() && reporterTenant && reporterTenant.authUserId){
          await notificationService.notify(reporterTenant.authUserId, 'Maintenance update: ' + existing.title,
            'Status is now: ' + (MAINTENANCE_STATUS_LABEL[existing.status] || existing.status), 'maintenance_requests', existing.id);
        }
      } else {
        var created = await maintenanceService.create(draft);
        maintenanceRequests.unshift(created);
        if (prefill && prefill.sourceCommentId){
          var newLink = await entityLinkService.linkEntities('inspection_comments', prefill.sourceCommentId, 'maintenance_requests', created.id, 'created_from');
          entityLinks.push(newLink);
        }
      }
      closeMaintenanceModal();
      showToast('Maintenance request saved.', 'success');
      await refreshOperationsReadModels();
      render();
    } catch(err){
      errorEl.textContent = friendlyErrorMessage(err);
      errorEl.hidden = false;
    } finally {
      if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = originalLabel; }
    }
  }
  window.saveMaintenanceForm = saveMaintenanceForm;

  /* ============ Cleaning organizer + trash agenda ============
   * cleaningTasks: one row per (room, scheduled date) — "it's this room's turn on this date",
   * generated as a weekly rotation, round-robin over the property's own rooms (see
   * ensureCleaningDutiesUpToDate), adjustable per week from the Cleaning calendar
   * (reassignDutyRoom) so each room's turn repeats every N weeks (N = rooms in the property).
   * cleaningSubmissions: the tenant's photos of how it turned out (a task can have more than one,
   * if they add photos more than once). cleaningComments: the admin's observations on those
   * photos.
   * trashSchedule: property-level (not per-room) — which bin type is collected, from a reference
   * date, repeating every `intervalDays` days (not every property has this set up at all). */
  var TRASH_TYPE_LABEL = { garbage:'Garbage (red bin)', recycling:'Recycling (yellow bin)', organic:'Organic (green bin)' };
  var TRASH_TYPE_DOT = { garbage:'🔴', recycling:'🟡', organic:'🟢' };
  var NOTIFICATION_CATEGORY_META = {
    check_in: { emoji: '🏠', label: 'Check-in' },
    check_out: { emoji: '🚪', label: 'Check-out' },
    rent: { emoji: '💰', label: 'Rent' },
    bills: { emoji: '💳', label: 'Bills' },
    cleaning: { emoji: '🧹', label: 'Cleaning' },
    bins: { emoji: '🗑️', label: 'Bins' },
    house_rules: { emoji: '🏡', label: 'House rules' },
    important_notice: { emoji: '⚠️', label: 'Important notice' },
    general_announcement: { emoji: '📢', label: 'General announcement' },
    payment_report: { emoji: '💳', label: 'Payment report' }
  };
  /** The next pickup date on/after `asOfIso` for a trash_schedule entry. */
  function nextTrashPickupIso(entry, asOfIso){
    if (!entry.referenceDate || !entry.intervalDays) return null;
    var diffDays = daysBetween(entry.referenceDate, asOfIso);
    if (diffDays <= 0) return entry.referenceDate; // reference date is today or still ahead
    var cyclesPassed = Math.ceil(diffDays / entry.intervalDays);
    return stepDateIso(entry.referenceDate, cyclesPassed * entry.intervalDays);
  }
  function trashScheduleListHtml(propertyId, clickable){
    var entries = trashSchedule.filter(function(x){ return x.propertyId===propertyId; })
      .map(function(x){ return { entry:x, next: nextTrashPickupIso(x, TODAY) }; })
      .sort(function(a,b){ return (a.next||'').localeCompare(b.next||''); });
    if (entries.length===0) return '<p style="font-size:13.5px;color:var(--text-dim);margin:0;">No trash collection set up for this property yet.</p>';
    return entries.map(function(e){
      var x = e.entry;
      return '<div class="field-row"'+(clickable?' style="cursor:pointer;" onclick="openTrashModal(\''+x.propertyId+'\',\''+x.id+'\')"':'')+'>'+
        '<span class="k">'+(TRASH_TYPE_LABEL[x.trashType]||x.trashType)+'</span>'+
        '<span class="v" style="font-weight:400;">Next: '+shortDate(e.next)+' · every '+x.intervalDays+' days'+(x.notes?' · '+esc(x.notes):'')+'</span>'+
        '</div>';
    }).join('');
  }
  function cleaningTaskSubmissions(taskId){ return cleaningSubmissions.filter(function(s){ return s.taskId===taskId; }); }
  function cleaningTaskComments(taskId){ return cleaningComments.filter(function(c){ return c.taskId===taskId; }); }

  /* ============ Cleaning duty (weekly) + Bin duty (fortnightly): independent containers ============
   * weekly_duties is Cleaning's own (room, period) container; bin_duties is Bin OUT's own,
   * separate one — they used to share one container, but Cleaning and Bin OUT now advance
   * (independently, on different cadences) through a room order that's derived on the fly by
   * round-robin over the property's own rooms (roomsOf, sorted by name) rather than an
   * admin-maintained list; see ensureCleaningDutiesUpToDate/ensureBinDutiesUpToDate below. The
   * admin can override any not-yet-past week's suggested room directly from the Cleaning calendar
   * (renderCleaningStaff) via weeklyDutyService.updateRoom/binDutyService.updateRoom. Neither ever
   * reads the other's status —
   * every card/row/notification reads cleaningTaskEffectiveStatus() and binOutTaskEffectiveStatus()
   * independently. Both are pure functions of stored status + TODAY, computed on read (same
   * pattern as billEffectiveStatus) — 'overdue'/'due_today'/'upcoming' are never written to the
   * DB; only 'in_progress'/'completed'/'not_completed' are ever persisted, by an explicit action. */
  function weeklyDutyOf(id){ return weeklyDuties.find(function(w){ return w.id===id; }); }
  function binDutyOf(id){ return binDuties.find(function(w){ return w.id===id; }); }
  function binOutTasksOfBinDuty(binDutyId){ return binOutTasks.filter(function(b){ return b.binDutyId===binDutyId; }); }
  function cleaningTaskOfWeeklyDuty(weeklyDutyId){ return cleaningTasks.find(function(t){ return t.weeklyDutyId===weeklyDutyId; }); }

  /** Cleaning's effective status: 'completed'/'not_completed' are terminal once set; otherwise
   *  'overdue' once the weekly_duty's period has ended, else the stored 'pending'/'in_progress'. */
  function cleaningTaskEffectiveStatus(task){
    if (task.status === 'completed' || task.status === 'not_completed') return task.status;
    var wd = weeklyDutyOf(task.weeklyDutyId);
    if (wd && wd.periodEnd < TODAY) return 'overdue';
    return task.status;
  }

  /** Mirrors cleaningTaskEffectiveStatus/binOutTaskEffectiveStatus, generalized for any
   *  task_index row: 'overdue' is derived from due_date + TODAY, never stored. */
  function taskIndexEffectiveStatus(row){
    if (row.statusFamily === 'completed' || row.statusFamily === 'not_completed') return row.statusFamily;
    if (row.dueDate && row.dueDate < TODAY) return 'overdue';
    return row.statusFamily; // 'open' or 'in_progress'
  }

  /** Bin OUT's effective status: 'completed'/'not_completed' are terminal once set; otherwise
   *  derived purely from today vs. pickupDate. */
  function binOutTaskEffectiveStatus(task){
    if (task.status === 'completed' || task.status === 'not_completed') return task.status;
    if (task.pickupDate < TODAY) return 'overdue';
    if (task.pickupDate === TODAY) return 'due_today';
    return 'upcoming';
  }

  var CLEANING_STATUS_BADGE = { pending:['neutral','Pending'], in_progress:['due','In Progress'], completed:['paid','Completed'], overdue:['overdue','Overdue'], not_completed:['move','Not Completed'] };
  var BIN_OUT_STATUS_BADGE = { upcoming:['upcoming','Upcoming'], due_today:['due','Due Today'], completed:['paid','Completed'], overdue:['overdue','Overdue'], not_completed:['move','Not Completed'] };
  function cleaningStatusBadgeHtml(task){ var m = CLEANING_STATUS_BADGE[cleaningTaskEffectiveStatus(task)] || ['neutral', task.status]; return badge(m[0], m[1]); }
  function binOutStatusBadgeHtml(task){ var m = BIN_OUT_STATUS_BADGE[binOutTaskEffectiveStatus(task)] || ['neutral', task.status]; return badge(m[0], m[1]); }
  var lightboxGroupSeq = 0;
  /** Renders thumbnails for one photo set. All photos passed in a single call form one gallery —
   *  clicking any of them opens the lightbox with Previous/Next across just that set. */
  function photoThumbsHtml(bucket, photoPaths){
    if (!photoPaths || !photoPaths.length) return '';
    var groupId = 'lbg' + (++lightboxGroupSeq);
    return photoPaths.map(function(path, idx){
      return '<img class="lazy-thumb" data-bucket="'+esc(bucket)+'" data-path="'+esc(path)+'" data-group="'+groupId+'" data-index="'+idx+'" style="width:56px;height:56px;object-fit:cover;border-radius:6px;border:1px solid var(--border);cursor:pointer;background:var(--surface-2,#eee);" />';
    }).join('');
  }
  function cleaningPhotoThumbsHtml(photoPaths){ return photoThumbsHtml('cleaning-photos', photoPaths); }

  function renderCleaning(){
    return isStaff() ? renderCleaningStaff() : renderCleaningTenant();
  }

  /** Read-only history row for a past (already-ended) week — no select, just what happened. */
  function cleaningDutyRow(duty){
    var r = roomOf(duty.roomId);
    var occupant = tenants.find(function(x){ return x.roomId===duty.roomId && !tenantHasMovedOut(x); });
    var cleaningTask = cleaningTaskOfWeeklyDuty(duty.id);
    return '<div class="card" style="cursor:pointer;" onclick="openCleaningDetailModal(\''+(cleaningTask?cleaningTask.id:'')+'\')">'+
      '<div class="detail-head" style="margin-top:0;align-items:center;">'+
      '<h2 style="margin:0;font-size:14px;">'+esc(r?r.name:'—')+' · '+esc(occupant?occupant.fullName:'Vacant')+'</h2>'+
      (cleaningTask?cleaningStatusBadgeHtml(cleaningTask):'')+
      '</div>'+
      '<p style="font-size:12.5px;color:var(--text-dim);margin:4px 0 0;">'+shortDate(duty.periodStart)+' – '+shortDate(duty.periodEnd)+'</p>'+
      '</div>';
  }

  function binDutyRow(duty){
    var r = roomOf(duty.roomId);
    var occupant = tenants.find(function(x){ return x.roomId===duty.roomId && !tenantHasMovedOut(x); });
    var binTasks = binOutTasksOfBinDuty(duty.id).sort(function(a,b){ return a.pickupDate.localeCompare(b.pickupDate); });
    var binCellHtml = binTasks.length===0 ? '<span style="color:var(--text-faint);font-size:12.5px;">—</span>' :
      binTasks.map(function(bt){ return '<span style="cursor:pointer;display:inline-block;margin:2px 4px 2px 0;" onclick="event.stopPropagation();openBinOutDetailModal(\''+bt.id+'\')">'+binOutStatusBadgeHtml(bt)+'</span>'; }).join('');
    return '<div class="card">'+
      '<div class="detail-head" style="margin-top:0;align-items:center;">'+
      '<h2 style="margin:0;font-size:14px;">'+esc(r?r.name:'—')+' · '+esc(occupant?occupant.fullName:'Vacant')+'</h2>'+
      '</div>'+
      '<p style="font-size:12.5px;color:var(--text-dim);margin:4px 0;">'+shortDate(duty.periodStart)+' – '+shortDate(duty.periodEnd)+'</p>'+
      '<div class="field-row"><span class="k">Bin OUT</span><span class="v">'+binCellHtml+'</span></div>'+
      '</div>';
  }

  var cleaningStaffPropertyFilter = 'all';
  function setCleaningStaffPropertyFilter(v){ cleaningStaffPropertyFilter = v; renderPreservingScroll(); }
  window.setCleaningStaffPropertyFilter = setCleaningStaffPropertyFilter; // inline onchange= runs in global scope — must be exposed here

  /** Real month-grid calendar for the Cleaning page — its own month cursor, separate from the
   *  Dashboard's (var calendarMonth) and reusing the same buildMonthGrid/.cal-* pattern. Starts on
   *  the current month. */
  var cleaningCalendarMonth = TODAY.slice(0,7);
  function cleaningCalendarShiftMonth(delta){
    var year = parseInt(cleaningCalendarMonth.slice(0,4), 10);
    var month = parseInt(cleaningCalendarMonth.slice(5,7), 10) - 1;
    var d = new Date(year, month + delta, 1);
    cleaningCalendarMonth = d.getFullYear() + '-' + pad2(d.getMonth()+1);
    renderPreservingScroll();
  }
  window.cleaningCalendarShiftMonth = cleaningCalendarShiftMonth;
  function cleaningCalendarGoToday(){ cleaningCalendarMonth = TODAY.slice(0,7); renderPreservingScroll(); }
  window.cleaningCalendarGoToday = cleaningCalendarGoToday;

  /** One property's month grid: a Cleaning pill on the Monday each weekly_duty starts, and a Bin
   *  OUT pill on every date trashPickupsInWindow says a bin is actually due for that property
   *  (skipped entirely when the property doesn't need Bin OUT — binDutyRequired===false). Today
   *  or a future date's pill is a real <button> that opens the reassign modal; a past date's pill
   *  is inert (plain text) — it's history, not something left to plan. */
  /** The weekly (cleaning) duty whose week contains `iso` — the same single source of truth the
   *  Roster table uses for both Aseo and Bin, so the calendar never disagrees with it. */
  function weeklyDutyForDate(propId, iso){
    return weeklyDuties.find(function(d){ return d.propertyId===propId && iso >= d.periodStart && iso <= d.periodEnd; }) || null;
  }

  function propertyCleaningMonthGridHtml(p, monthStr){
    var propId = p.id;
    var cells = buildMonthGrid(monthStr);
    var gridStart = cells.find(function(c){ return !!c; });
    var gridEnd = cells.slice().reverse().find(function(c){ return !!c; });
    var pickupsByDate = {};
    if (p.binDutyRequired !== false && gridStart && gridEnd){
      trashPickupsInWindow(propId, gridStart, gridEnd).forEach(function(x){ pickupsByDate[x.pickupDate] = x.binTypes; });
    }

    var cellsHtml = '<div class="cal-grid cal-days">' + cells.map(function(iso){
      if (!iso) return '<div class="cal-daycell empty"></div>';
      var dayNum = parseInt(iso.slice(8,10), 10);
      var isToday = iso === TODAY;
      var pillsHtml = '';

      var cd = weeklyDuties.find(function(d){ return d.propertyId===propId && nextWeekdayIso(d.periodStart, 0)===iso; });
      if (cd){
        var isPast = cd.periodEnd < TODAY;
        var r1 = roomOf(cd.roomId);
        var label = '🧹 ' + (r1?r1.name:'—');
        pillsHtml += isPast
          ? '<span class="cal-pill cleaning past">'+esc(label)+'</span>'
          : '<button type="button" class="cal-pill cleaning" onclick="openWeekReassignModal(\'cleaning\',\''+cd.id+'\')">'+esc(label)+'</button>';
      }

      var binTypesToday = pickupsByDate[iso];
      if (binTypesToday && binTypesToday.length){
        var bd = weeklyDutyForDate(propId, iso);
        var r2 = bd ? roomOf(bd.roomId) : null;
        var binIcons = '<span class="bin-icons">'+binTypesToday.map(function(bt){ return binIconSvg(bt, 14); }).join('')+'</span>';
        var binLabel = binIcons + esc(r2?r2.name:'—');
        var binIsPast = bd && bd.periodEnd < TODAY;
        pillsHtml += (bd && !binIsPast)
          ? '<button type="button" class="cal-pill bin" onclick="openWeekReassignModal(\'cleaning\',\''+bd.id+'\')">'+binLabel+'</button>'
          : '<span class="cal-pill bin past">'+binLabel+'</span>';
      }

      return '<div class="cal-daycell'+(isToday ? ' today' : '')+'"><div class="cal-daynum">'+dayNum+'</div>'+pillsHtml+'</div>';
    }).join('') + '</div>';

    return cellsHtml;
  }

  /** The simple roster table the admin actually wants: one row per week, Aseo (the Sunday inside
   *  that week — some properties' weeklyDuty periods run Mon→Sun, others Sun→Sat, so the Sunday
   *  is located with nextWeekdayIso rather than assumed to be periodStart or periodEnd), Bin (that
   *  week's Wednesday, found the same way) with its actual colors from trash_schedule for that
   *  exact date, and the single Room both operations use that week. Cleaning's weekly rotation is
   *  the source of truth for the room; Bin reuses it rather than reading its own (fortnightly)
   *  bin_duties container, since the two are meant to always match for a given week. Clicking a
   *  row opens the same reassign modal as before (Room + Date), which still cascades forward. */
  function propertyScheduleTableHtml(p){
    var propId = p.id;
    var showBin = p.binDutyRequired !== false;
    var rows = weeklyDuties.filter(function(d){ return d.propertyId===propId; })
      .sort(function(a,b){ return a.periodStart.localeCompare(b.periodStart); });
    if (!rows.length) return '<p style="font-size:13px;color:var(--text-dim);margin:0;">No cleaning weeks scheduled yet.</p>';
    var bodyRows = rows.map(function(d){
      var isPast = d.periodEnd < TODAY;
      var room = roomOf(d.roomId);
      var roomName = room ? room.name : '—';
      var aseoDate = nextWeekdayIso(d.periodStart, 0); // Sunday within this week
      var binDate = nextWeekdayIso(d.periodStart, 3); // Wednesday within this week
      var binTypes = showBin ? trashPickupsInWindow(propId, binDate, binDate).reduce(function(acc,x){ return acc.concat(x.binTypes); }, []) : [];
      var binTypesHtml = binTypes.length ? binTypes.map(function(bt){
        return '<span class="bin-dot" title="'+esc(TRASH_TYPE_LABEL[bt]||bt)+'">'+binIconSvg(bt, 22)+'</span>';
      }).join('') : '—';
      var clickable = !isPast;
      var rowAttrs = clickable ? ' class="roster-row" onclick="openWeekReassignModal(\'cleaning\',\''+d.id+'\')" tabindex="0" role="button"' : ' class="roster-row past"';
      return '<tr'+rowAttrs+'>'+
        '<td>'+shortDate(aseoDate)+'</td>'+
        (showBin ? '<td>'+shortDate(binDate)+'</td><td>'+binTypesHtml+'</td>' : '')+
        '<td>'+esc(roomName)+'</td>'+
        '</tr>';
    }).join('');
    return '<div class="roster-table-wrap"><table class="roster-table">'+
      '<thead><tr><th>Aseo</th>'+(showBin?'<th>Bin</th><th>Tipo</th>':'')+'<th>Habitación</th></tr></thead>'+
      '<tbody>'+bodyRows+'</tbody></table></div>';
  }

  /** A plain-text agenda for the same month the grid above shows — one row per day that has a
   *  Cleaning or Bin OUT event, spelling out what the pill's icon only hints at: the date, which
   *  operation it is (Cleaning, or Bin OUT naming every color due that day), and which room it
   *  falls to. Reads the same weeklyDuties/trashPickupsInWindow data as the grid, so the two never
   *  disagree — this is just the same information written out in full. */
  function propertyAgendaListHtml(p, monthStr){
    var propId = p.id;
    var cells = buildMonthGrid(monthStr);
    var gridStart = cells.find(function(c){ return !!c; });
    var gridEnd = cells.slice().reverse().find(function(c){ return !!c; });
    if (!gridStart || !gridEnd) return '';
    var pickupsByDate = {};
    if (p.binDutyRequired !== false){
      trashPickupsInWindow(propId, gridStart, gridEnd).forEach(function(x){ pickupsByDate[x.pickupDate] = x.binTypes; });
    }
    var rows = [];
    cells.forEach(function(iso){
      if (!iso) return;
      var cd = weeklyDuties.find(function(d){ return d.propertyId===propId && nextWeekdayIso(d.periodStart, 0)===iso; });
      if (cd){
        var r1 = roomOf(cd.roomId);
        rows.push({ date: iso, operation: 'Cleaning', room: r1 ? r1.name : '—' });
      }
      var binTypesToday = pickupsByDate[iso];
      if (binTypesToday && binTypesToday.length){
        var bd = weeklyDutyForDate(propId, iso);
        var r2 = bd ? roomOf(bd.roomId) : null;
        var opLabel = 'Bin OUT — ' + binTypesToday.map(function(bt){ return TRASH_TYPE_LABEL[bt] || bt; }).join(', ');
        rows.push({ date: iso, operation: opLabel, room: r2 ? r2.name : '—' });
      }
    });
    if (!rows.length) return '<p style="font-size:12.5px;color:var(--text-dim);margin:10px 0 0;">No Cleaning or Bin OUT dates this month.</p>';
    return '<div style="margin-top:10px;">' + rows.map(function(r){
      return '<div class="field-row"><span class="k">'+shortDate(r.date)+'</span>'+
        '<span class="v" style="font-weight:400;text-align:right;">'+esc(r.operation)+' · '+esc(r.room)+'</span></div>';
    }).join('') + '</div>';
  }

  /** Grouped by property, same convention as Inspection's staff view — an admin with several
   *  properties thinks property by property. The "View" filter narrows this to one property at a
   *  time. Each property shows a real month calendar (◀ ▶ to navigate, current month by default)
   *  with a pill for Cleaning on the week it starts and a pill for Bin OUT on each date something's
   *  actually due — the room already filled in by ensureCleaningDutiesUpToDate/
   *  ensureBinDutiesUpToDate's round-robin, adjustable from today onward by clicking a pill
   *  (openWeekReassignModal → reassignDutyRoom, which also re-rolls every later week). A short
   *  read-only history sits below for the last 10 weeks. */
  function renderCleaningStaff(){
    var sortedProps = properties.slice().sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); });
    var visibleProps = cleaningStaffPropertyFilter==='all' ? sortedProps : sortedProps.filter(function(p){ return p.id===cleaningStaffPropertyFilter; });
    var filterHtml = '<div class="form-row" style="margin-bottom:14px;"><label for="cleaning-staff-property-filter">View</label>'+
      '<select id="cleaning-staff-property-filter" onchange="setCleaningStaffPropertyFilter(this.value)">'+
      '<option value="all"'+(cleaningStaffPropertyFilter==='all'?' selected':'')+'>All properties</option>'+
      sortedProps.map(function(p){ return '<option value="'+p.id+'"'+(cleaningStaffPropertyFilter===p.id?' selected':'')+'>'+esc(p.name)+'</option>'; }).join('')+
      '</select></div>';

    var year = parseInt(cleaningCalendarMonth.slice(0,4), 10);
    var month = parseInt(cleaningCalendarMonth.slice(5,7), 10) - 1;
    var monthLabel = CALENDAR_MONTH_NAMES[month] + ' ' + year;
    var toolbarHtml = '<div class="cal-toolbar">'+
      '<button class="mini-btn" type="button" onclick="cleaningCalendarShiftMonth(-1)" aria-label="Previous month">‹</button>'+
      '<div class="cal-month-label">'+monthLabel+'</div>'+
      '<button class="mini-btn" type="button" onclick="cleaningCalendarShiftMonth(1)" aria-label="Next month">›</button>'+
      '<button class="mini-btn" type="button" onclick="cleaningCalendarGoToday()" style="margin-left:auto;">Today</button>'+
      '</div>';
    var weekdayHtml = '<div class="cal-grid">' + ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(function(w){
      return '<div class="cal-weekday">'+w+'</div>';
    }).join('') + '</div>';
    var legendHtml = '<div class="cal-legend">'+
      '<span><span class="dot" style="background:var(--status-paid);"></span>Cleaning</span>'+
      '<span><span class="dot" style="background:var(--status-upcoming);"></span>Bin OUT</span>'+
      ['garbage','recycling','organic'].map(function(bt){
        return '<span>'+binIconSvg(bt, 16)+'&nbsp;'+esc((TRASH_TYPE_LABEL[bt]||bt).replace(/ \(.*\)$/,''))+'</span>';
      }).join('')+
      '</div>';

    var sectionsHtml = visibleProps.map(function(p){
      var propId = p.id;
      var propRooms = roomsOf(propId);
      var calendarHtml;
      if (propRooms.length===0){
        calendarHtml = '<p style="font-size:13px;color:var(--text-dim);margin:0;">No rooms in this property yet.</p>';
      } else {
        calendarHtml = '<div class="card">'+toolbarHtml+weekdayHtml+propertyCleaningMonthGridHtml(p, cleaningCalendarMonth)+legendHtml+
          (p.binDutyRequired===false ? '<p style="font-size:12px;color:var(--text-faint);margin:10px 0 0;">This property doesn\'t need Bin OUT duty.</p>' : '')+
          '</div>'+
          '<div class="card" style="margin-top:10px;">'+
          '<h3 style="margin:0 0 10px;font-size:11.5px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.04em;">Roster</h3>'+
          propertyScheduleTableHtml(p)+
          '</div>';
      }

      var cleaningPast = weeklyDuties.filter(function(w){ return w.propertyId===propId && w.periodEnd < TODAY; })
        .sort(function(a,b){ return b.periodEnd.localeCompare(a.periodEnd); }).slice(0, 10);
      var binPast = binDuties.filter(function(w){ return w.propertyId===propId && w.periodEnd < TODAY; })
        .sort(function(a,b){ return b.periodEnd.localeCompare(a.periodEnd); }).slice(0, 10);
      var historyHtml = (cleaningPast.length===0 && binPast.length===0) ? '' :
        '<h3 style="margin:14px 0 8px;font-size:11.5px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.04em;">History</h3>'+
        cleaningPast.map(cleaningDutyRow).join('') + binPast.map(binDutyRow).join('');

      return '<h2 style="font-size:12.5px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.04em;margin:18px 0 8px;">'+esc(p.name)+'</h2>'+
        calendarHtml + historyHtml;
    }).join('');

    return pageHeader('Cleaning & Bin OUT', "Monthly roster — click a week's Cleaning or Bin OUT pill to reassign it (and every week after it).") +
      filterHtml +
      (sectionsHtml || '<div class="card"><p style="font-size:13.5px;color:var(--text-dim);margin:0;">No properties yet.</p></div>') +
      '<p style="font-size:12px;color:var(--text-faint);margin:14px 0 0;">The trash pickup schedule itself (which dates, which colors) still lives on each property\'s page (Properties → open a property).</p>';
  }

  /** Quick-reassign popup opened from a calendar pill: one room select, scoped to whichever
   *  property the clicked duty belongs to. Saving cascades — see reassignDutyRoom. */
  var weekReassignKind = null; // 'cleaning' | 'bin'
  var weekReassignDutyId = null;
  function openWeekReassignModal(kind, dutyId){
    var duty = kind==='cleaning' ? weeklyDutyOf(dutyId) : binDutyOf(dutyId);
    if (!duty) return;
    weekReassignKind = kind;
    weekReassignDutyId = dutyId;
    document.getElementById('week-reassign-title').textContent =
      (kind==='cleaning' ? '🧹 Cleaning' : '🗑️ Bin OUT') + ' — ' + shortDate(duty.periodStart) + ' – ' + shortDate(duty.periodEnd);
    var select = document.getElementById('week-reassign-room');
    var propRooms = roomsOf(duty.propertyId).slice().sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); });
    select.innerHTML = propRooms.map(function(r){ return '<option value="'+r.id+'"'+(r.id===duty.roomId?' selected':'')+'>'+esc(r.name)+'</option>'; }).join('');
    document.getElementById('week-reassign-date').value = duty.periodStart;
    document.getElementById('week-reassign-modal').hidden = false;
  }
  window.openWeekReassignModal = openWeekReassignModal;
  function closeWeekReassignModal(){ document.getElementById('week-reassign-modal').hidden = true; }
  window.closeWeekReassignModal = closeWeekReassignModal;
  function saveWeekReassignForm(){
    var roomId = document.getElementById('week-reassign-room').value;
    var newDate = document.getElementById('week-reassign-date').value;
    if (!roomId || !newDate || !weekReassignDutyId) return;
    closeWeekReassignModal();
    reassignDutyRoom(weekReassignKind, weekReassignDutyId, roomId, newDate);
  }
  window.saveWeekReassignForm = saveWeekReassignForm;

  /** Reassigns one calendar week's room AND/OR date, and cascades both changes forward: every
   *  later week for that property (same kind) is re-rolled by continuing the round-robin from the
   *  newly chosen room, exactly like ensureCleaningDutiesUpToDate/ensureBinDutiesUpToDate would
   *  generate it — "pick this week's room and shift the remaining weeks accordingly." When
   *  `newPeriodStart` moves the edited week's start date, every week in the chain (the edited one
   *  and all later ones) is shifted by that same number of days, so the weekly/fortnightly cadence
   *  between them stays unbroken instead of leaving a gap or an overlap. Weeks before the edited
   *  one are never touched. Updates each duty's linked task(s) too so both stay consistent. */
  async function reassignDutyRoom(kind, dutyId, roomId, newPeriodStart){
    try {
      var duties = kind==='cleaning' ? weeklyDuties : binDuties;
      var edited = duties.find(function(d){ return d.id===dutyId; });
      if (!edited) return;
      var deltaDays = newPeriodStart ? daysBetween(edited.periodStart, newPeriodStart) : 0;
      var roomOrder = roomsOf(edited.propertyId).slice().sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); }).map(function(r){ return r.id; });
      var chain = duties.filter(function(d){ return d.propertyId===edited.propertyId && d.periodStart >= edited.periodStart; })
        .sort(function(a,b){ return a.periodStart.localeCompare(b.periodStart); });

      var currentRoom = roomId;
      for (var i=0; i<chain.length; i++){
        var d = chain[i];
        var newRoom = (i===0) ? roomId : nextRoomInOrder(roomOrder, currentRoom);
        var newStart = deltaDays ? stepDateIso(d.periodStart, deltaDays) : d.periodStart;
        var newEnd = deltaDays ? stepDateIso(d.periodEnd, deltaDays) : d.periodEnd;
        if (kind === 'cleaning'){
          var savedDuty = await weeklyDutyService.updateRoom(d.id, newRoom);
          if (deltaDays) savedDuty = await weeklyDutyService.updatePeriod(d.id, newStart, newEnd);
          weeklyDuties = weeklyDuties.map(function(w){ return w.id===savedDuty.id ? savedDuty : w; });
          var task = cleaningTaskOfWeeklyDuty(d.id);
          if (task){
            var savedTask = await cleaningService.updateTaskRoom(task.id, newRoom);
            if (deltaDays) savedTask = await cleaningService.updateTaskDate(task.id, newEnd);
            cleaningTasks = cleaningTasks.map(function(t){ return t.id===savedTask.id ? savedTask : t; });
          }
        } else {
          var savedBinDuty = await binDutyService.updateRoom(d.id, newRoom);
          if (deltaDays) savedBinDuty = await binDutyService.updatePeriod(d.id, newStart, newEnd);
          binDuties = binDuties.map(function(w){ return w.id===savedBinDuty.id ? savedBinDuty : w; });
          var savedBinTasks = await binOutTaskService.updateTasksRoom(d.id, newRoom);
          if (deltaDays) savedBinTasks = await binOutTaskService.shiftTasksByDays(d.id, deltaDays);
          var savedIds = savedBinTasks.map(function(t){ return t.id; });
          binOutTasks = binOutTasks.map(function(t){ return savedIds.indexOf(t.id)>=0 ? savedBinTasks.find(function(s){ return s.id===t.id; }) : t; });
        }
        currentRoom = newRoom;
      }
      showToast(deltaDays ? 'Roster updated — dates and following weeks re-rolled too.' : 'Roster updated — following weeks re-rolled too.', 'success');
      render();
    } catch(err){
      showToast(friendlyErrorMessage(err), 'error');
      render();
    }
  }
  window.reassignDutyRoom = reassignDutyRoom;

  function binOutTaskCardHtml(task){
    var typeLabels = task.binTypes.map(function(bt){ return TRASH_TYPE_LABEL[bt] || bt; }).join(' & ');
    var effStatus = binOutTaskEffectiveStatus(task);
    var canComplete = effStatus !== 'completed' && effStatus !== 'not_completed';
    var evidenceHtml = task.evidencePhotoPath ? '<div style="margin-top:8px;">'+photoThumbsHtml('bin-out-evidence', [task.evidencePhotoPath])+'</div>' : '';
    return '<div class="card">'+
      '<div class="detail-head" style="margin-top:0;align-items:center;"><h2 style="margin:0;font-size:14px;">🗑️ '+esc(typeLabels)+'</h2>'+binOutStatusBadgeHtml(task)+'</div>'+
      '<p style="font-size:12.5px;color:var(--text-dim);margin:2px 0 0;">Bin OUT: '+shortDate(task.pickupDate)+'</p>'+
      evidenceHtml +
      (canComplete ? '<button class="mini-btn primary" style="margin-top:10px;" onclick="openBinOutCompleteModal(\''+task.id+'\')">Mark Bin OUT completed</button>' : '')+
      '</div>';
  }

  function cleaningDutyCardHtml(duty){
    var cleaningTask = cleaningTaskOfWeeklyDuty(duty.id);
    if (!cleaningTask) return '';
    var subs = cleaningTaskSubmissions(cleaningTask.id);
    var comments = cleaningTaskComments(cleaningTask.id);
    var photosHtml = subs.length===0 ? '' :
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">'+subs.map(function(s){ return cleaningPhotoThumbsHtml(s.photoPaths); }).join('')+'</div>';
    var commentsHtml = comments.length===0 ? '' :
      '<div style="margin-top:8px;display:flex;flex-direction:column;gap:4px;">'+comments.map(function(c){
        return '<p style="font-size:12.5px;color:var(--text-dim);margin:0;">💬 '+esc(c.comment)+'</p>';
      }).join('')+'</div>';
    return '<div class="card">'+
      '<div class="detail-head" style="margin-top:0;align-items:center;"><h2 style="margin:0;font-size:14px;">🧹 Cleaning</h2>'+cleaningStatusBadgeHtml(cleaningTask)+'</div>'+
      '<p style="font-size:12.5px;color:var(--text-dim);margin:2px 0 0;">'+shortDate(duty.periodStart)+' – '+shortDate(duty.periodEnd)+'</p>'+
      photosHtml + commentsHtml +
      '<button class="mini-btn primary" style="margin-top:10px;" onclick="openCleaningSubmitModal(\''+cleaningTask.id+'\')">'+(subs.length?'Add more photos':'Add photos')+'</button>'+
      '</div>';
  }

  function binDutyCardHtml(duty){
    var binTasks = binOutTasksOfBinDuty(duty.id).sort(function(a,b){ return a.pickupDate.localeCompare(b.pickupDate); });
    return '<h2 style="font-size:12.5px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.04em;margin:18px 0 8px;">Bin OUT · '+shortDate(duty.periodStart)+' – '+shortDate(duty.periodEnd)+'</h2>'+
      binTasks.map(binOutTaskCardHtml).join('');
  }

  /** Wheelie-bin illustration (inline SVG, no external image) — dark body with the lid in the
   *  bin's own colour: red Garbage, yellow Recycling, green Organic, as used in Australian councils. */
  var TRASH_TYPE_LID = { garbage:'#e0413a', recycling:'#f2b705', organic:'#3fae5a' };
  function binIconSvg(type, px){
    var lid = TRASH_TYPE_LID[type] || '#9aa3a0';
    px = px || 34;
    return '<svg class="bin-icon" width="'+px+'" height="'+px+'" viewBox="0 0 48 48" role="img" aria-label="'+esc(TRASH_TYPE_LABEL[type]||type)+'">'+
      '<rect x="12" y="9" width="24" height="3" rx="1.5" fill="'+lid+'" opacity=".55"/>'+
      '<path d="M9 12h30l-1.2 4H10.2z" fill="'+lid+'"/>'+
      '<path d="M11.5 16h25l-2.6 24.5a2 2 0 0 1-2 1.8H16.1a2 2 0 0 1-2-1.8z" fill="#3b4a45"/>'+
      '<path d="M17 20l1.2 17M24 20v17M31 20l-1.2 17" stroke="#56675f" stroke-width="1.6" stroke-linecap="round"/>'+
      '<circle cx="15.5" cy="42.5" r="3" fill="#232c29"/><circle cx="15.5" cy="42.5" r="1.1" fill="#8b9692"/>'+
      '<rect x="19" y="17.5" width="10" height="4" rx="1" fill="'+lid+'" opacity=".9"/>'+
      '</svg>';
  }

  /** Tenant's read-only month grid of their property: same data and placement as the admin
   *  calendar (Cleaning on the week's Sunday, Bin OUT on each pickup date, room from the weekly
   *  roster), but the tenant's own turns are highlighted as "You" and everyone else's are dimmed. */
  function tenantCleaningMonthGridHtml(p, monthStr, myRoomId){
    var propId = p.id;
    var cells = buildMonthGrid(monthStr);
    var gridStart = cells.find(function(c){ return !!c; });
    var gridEnd = cells.slice().reverse().find(function(c){ return !!c; });
    var pickupsByDate = {};
    if (p.binDutyRequired !== false && gridStart && gridEnd){
      trashPickupsInWindow(propId, gridStart, gridEnd).forEach(function(x){ pickupsByDate[x.pickupDate] = x.binTypes; });
    }
    return '<div class="cal-grid cal-days">' + cells.map(function(iso){
      if (!iso) return '<div class="cal-daycell empty"></div>';
      var pillsHtml = '';
      var cd = weeklyDuties.find(function(d){ return d.propertyId===propId && nextWeekdayIso(d.periodStart, 0)===iso; });
      if (cd){
        var mine1 = cd.roomId===myRoomId;
        var r1 = roomOf(cd.roomId);
        pillsHtml += '<span class="cal-pill cleaning '+(mine1?'mine':'other')+(iso<TODAY?' past':'')+'">🧹 '+esc(mine1?'You':(r1?r1.name:'—'))+'</span>';
      }
      var types = pickupsByDate[iso];
      if (types && types.length){
        var bd = weeklyDutyForDate(propId, iso);
        var mine2 = bd && bd.roomId===myRoomId;
        var r2 = bd ? roomOf(bd.roomId) : null;
        var icons = types.map(function(bt){ return binIconSvg(bt, 14); }).join('');
        pillsHtml += '<span class="cal-pill bin '+(mine2?'mine':'other')+(iso<TODAY?' past':'')+'"><span class="bin-icons">'+icons+'</span>'+esc(mine2?'You':(r2?r2.name:'—'))+'</span>';
      }
      var hasMine = pillsHtml.indexOf(' mine')>=0;
      return '<div class="cal-daycell'+(iso===TODAY?' today':'')+(hasMine?' has-mine':'')+'"><div class="cal-daynum">'+parseInt(iso.slice(8,10),10)+'</div>'+pillsHtml+'</div>';
    }).join('') + '</div>';
  }

  /** One card per week the tenant's room is on duty, from the current week forward (oldest
   *  first): the Cleaning turn (Sunday) with its photo upload, and every Bin OUT pickup that week
   *  with the bin illustrations and — when a Bin OUT task exists for that date — its status and
   *  "Mark completed" button. */
  function tenantWeekCardHtml(p, duty){
    var aseoDate = nextWeekdayIso(duty.periodStart, 0);
    var isCurrent = duty.periodStart <= TODAY && duty.periodEnd >= TODAY;
    var cleaningTask = cleaningTaskOfWeeklyDuty(duty.id);
    var subs = cleaningTask ? cleaningTaskSubmissions(cleaningTask.id) : [];
    var photosHtml = subs.length===0 ? '' :
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">'+subs.map(function(s){ return cleaningPhotoThumbsHtml(s.photoPaths); }).join('')+'</div>';
    var cleaningHtml = '<div class="duty-row">'+
      '<div class="duty-art cleaning-art">🧹</div>'+
      '<div class="duty-body">'+
        '<div class="duty-title">Cleaning <span class="duty-date">'+shortDate(aseoDate)+'</span>'+(cleaningTask?cleaningStatusBadgeHtml(cleaningTask):'')+'</div>'+
        '<div class="duty-sub">Common areas · week '+shortDate(duty.periodStart)+' – '+shortDate(duty.periodEnd)+'</div>'+
        photosHtml+
        (cleaningTask ? '<button class="mini-btn primary" style="margin-top:8px;" onclick="openCleaningSubmitModal(\''+cleaningTask.id+'\')">'+(subs.length?'Add more photos':'Add photos')+'</button>' : '')+
      '</div></div>';

    var binHtml = '';
    if (p && p.binDutyRequired !== false){
      binHtml = trashPickupsInWindow(p.id, duty.periodStart, duty.periodEnd).map(function(x){
        var task = binOutTasks.find(function(b){ return b.propertyId===p.id && b.pickupDate===x.pickupDate; });
        var effStatus = task ? binOutTaskEffectiveStatus(task) : null;
        var canComplete = task && effStatus !== 'completed' && effStatus !== 'not_completed';
        var names = x.binTypes.map(function(bt){ return (TRASH_TYPE_LABEL[bt]||bt).replace(/ \(.*\)$/,''); }).join(' & ');
        return '<div class="duty-row">'+
          '<div class="duty-art bin-art">'+x.binTypes.map(function(bt){ return binIconSvg(bt, 34); }).join('')+'</div>'+
          '<div class="duty-body">'+
            '<div class="duty-title">Bin OUT <span class="duty-date">'+shortDate(x.pickupDate)+'</span>'+(task?binOutStatusBadgeHtml(task):'')+'</div>'+
            '<div class="duty-sub">'+esc(names)+' — put out the night before</div>'+
            (canComplete ? '<button class="mini-btn primary" style="margin-top:8px;" onclick="openBinOutCompleteModal(\''+task.id+'\')">Mark Bin OUT completed</button>' : '')+
          '</div></div>';
      }).join('');
    }
    return '<div class="card tenant-week'+(isCurrent?' current':'')+'">'+
      '<div class="tenant-week-head">'+(isCurrent?'<span class="week-chip">This week</span>':'')+
      '<span>'+shortDate(duty.periodStart)+' – '+shortDate(duty.periodEnd)+'</span></div>'+
      cleaningHtml + binHtml +
      '</div>';
  }

  function renderCleaningTenant(){
    var t = myTenantRecord();
    if (!t || !t.roomId){
      return pageHeader('Cleaning', '') + '<div class="card"><p style="font-size:13.5px;color:var(--text-dim);margin:0;">Your account isn\'t linked to a room yet — ask your Super Admin.</p></div>';
    }
    var p = properties.find(function(x){ return x.id===t.propertyId; }) || { id: t.propertyId };
    // Most recent (current week) first, then the future weeks in order.
    var myWeeks = weeklyDuties.filter(function(w){ return w.roomId===t.roomId && w.periodEnd >= TODAY; })
      .sort(function(a,b){ return a.periodStart.localeCompare(b.periodStart); });

    var year = parseInt(cleaningCalendarMonth.slice(0,4), 10);
    var month = parseInt(cleaningCalendarMonth.slice(5,7), 10) - 1;
    var toolbarHtml = '<div class="cal-toolbar">'+
      '<button class="mini-btn" type="button" onclick="cleaningCalendarShiftMonth(-1)" aria-label="Previous month">‹</button>'+
      '<div class="cal-month-label">'+CALENDAR_MONTH_NAMES[month]+' '+year+'</div>'+
      '<button class="mini-btn" type="button" onclick="cleaningCalendarShiftMonth(1)" aria-label="Next month">›</button>'+
      '<button class="mini-btn" type="button" onclick="cleaningCalendarGoToday()" style="margin-left:auto;">Today</button>'+
      '</div>';
    var weekdayHtml = '<div class="cal-grid">' + ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(function(w){
      return '<div class="cal-weekday">'+w+'</div>';
    }).join('') + '</div>';
    var legendHtml = '<div class="cal-legend">'+
      '<span><span class="dot" style="background:var(--accent);"></span>Your turn</span>'+
      '<span>🧹&nbsp;Cleaning</span>'+
      (p.binDutyRequired===false ? '' : ['garbage','recycling','organic'].map(function(bt){
        return '<span>'+binIconSvg(bt, 16)+'&nbsp;'+esc((TRASH_TYPE_LABEL[bt]||bt).replace(/ \(.*\)$/,''))+'</span>';
      }).join(''))+
      '</div>';
    var calendarHtml = '<div class="card">'+toolbarHtml+weekdayHtml+tenantCleaningMonthGridHtml(p, cleaningCalendarMonth, t.roomId)+legendHtml+'</div>';

    var weeksHtml = myWeeks.length===0
      ? '<div class="card"><p style="font-size:13.5px;color:var(--text-dim);margin:0;">No upcoming turns for your room yet.</p></div>'
      : myWeeks.map(function(w){ return tenantWeekCardHtml(p, w); }).join('');

    var sectionTitle = function(txt){ return '<h2 style="font-size:12.5px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.04em;margin:18px 0 8px;">'+txt+'</h2>'; };
    return pageHeader('My Weekly Responsibilities', "Your room's cleaning and bin turns.") +
      '<button class="mini-btn" style="margin-bottom:14px;" onclick="openCleaningHistoryModal()">Cleaning history</button>'+
      calendarHtml +
      sectionTitle('My turns') + weeksHtml +
      sectionTitle('Property trash calendar') +
      '<div class="card">'+trashScheduleListHtml(t.propertyId, false)+'</div>';
  }

  /** Monday of the week containing `iso` (Mon–Sun weeks, matching the calendar grid). */
  function startOfWeekIso(iso){
    var d = new Date(iso + 'T00:00:00');
    var daysSinceMonday = (d.getDay() + 6) % 7; // Mon=0..Sun=6
    return stepDateIso(iso, -daysSinceMonday);
  }

  /** Every trash_schedule pickup date for `propertyId` that falls within [periodStart, periodEnd],
   *  grouped by date (bins collected the same day become one Bin OUT task, per spec). Reuses
   *  nextTrashPickupIso's cycle math, walked forward across the window instead of just once. */
  function trashPickupsInWindow(propertyId, periodStart, periodEnd){
    var entries = trashSchedule.filter(function(x){ return x.propertyId===propertyId; });
    var byDate = {}; // isoDate -> [trashType, ...]
    for (var i=0; i<entries.length; i++){
      var entry = entries[i];
      var d = nextTrashPickupIso(entry, periodStart);
      var guard = 0;
      while (d && d <= periodEnd && guard++ < 50){
        if (d >= periodStart){
          if (!byDate[d]) byDate[d] = [];
          byDate[d].push(entry.trashType);
        }
        d = stepDateIso(d, entry.intervalDays);
      }
    }
    return Object.keys(byDate).sort().map(function(d){ return { pickupDate: d, binTypes: byDate[d] }; });
  }

  /** Shared by both generators below: given a property's rooms (sorted by name — the natural,
   *  no-setup-required order the calendar's round-robin suggestion follows) and the room id last
   *  assigned, returns the next room after it, wrapping around. A room no longer in the property
   *  (e.g. removed) restarts the cycle from the top rather than erroring. */
  function nextRoomInOrder(roomOrder, lastRoomId){
    var lastIdx = lastRoomId ? roomOrder.indexOf(lastRoomId) : -1;
    return roomOrder[(lastIdx + 1 + roomOrder.length) % roomOrder.length];
  }

  var CALENDAR_HORIZON_DAYS = 56; // 8 weeks — keeps the calendar always showing 8 editable weeks ahead

  /** Extends each property's Cleaning schedule with weekly_duty (+ its cleaning_tasks row) slots
   *  so the calendar always has CALENDAR_HORIZON_DAYS of future weeks to show, suggesting each new
   *  slot's room by round-robin over the property's own rooms (sorted by name), continuing from
   *  whichever room was last assigned — the admin can still override any of these from the
   *  calendar (reassignDutyRoom). Safe to call repeatedly (on bootstrap, after a reassignment): a
   *  no-op once every property is already generated through the horizon. */
  async function ensureCleaningDutiesUpToDate(){
    var horizonEnd = stepDateIso(TODAY, CALENDAR_HORIZON_DAYS);
    var newRows = []; // [{propertyId, roomId, periodStart, periodEnd}]
    for (var i=0; i<properties.length; i++){
      var propId = properties[i].id;
      var roomOrder = roomsOf(propId).slice().sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); }).map(function(r){ return r.id; });
      if (roomOrder.length===0) continue;
      var propDuties = weeklyDuties.concat(newRows).filter(function(w){ return w.propertyId===propId; });
      var lastDuty = propDuties.reduce(function(best, w){ return (!best || w.periodEnd > best.periodEnd) ? w : best; }, null);
      var guard = 0;
      while (guard++ < 20){
        var nextStart = lastDuty ? stepDateIso(lastDuty.periodEnd, 1) : startOfWeekIso(TODAY);
        if (lastDuty && nextStart > horizonEnd) break; // already generated through the horizon
        var nextEnd = stepDateIso(nextStart, 6);
        var row = { propertyId: propId, roomId: nextRoomInOrder(roomOrder, lastDuty?lastDuty.roomId:null), periodStart: nextStart, periodEnd: nextEnd };
        newRows.push(row);
        lastDuty = row;
        if (nextStart > horizonEnd) break;
      }
    }
    if (!newRows.length) return;

    var createdDuties = await weeklyDutyService.createTasksBulk(newRows);
    weeklyDuties = weeklyDuties.concat(createdDuties);

    var newCleaningRows = createdDuties.map(function(w){
      return { propertyId: w.propertyId, roomId: w.roomId, weeklyDutyId: w.id, scheduledDate: w.periodEnd };
    });
    var createdCleaning = await cleaningService.createTasksBulk(newCleaningRows);
    cleaningTasks = cleaningTasks.concat(createdCleaning);
  }

  /** Mirrors ensureCleaningDutiesUpToDate, but for Bin OUT: a 14-day (fortnightly) cycle,
   *  advancing through the same round-robin order independently of Cleaning's weekly one — so at
   *  any given time the two duties can (and usually will) land on different rooms. Each new
   *  bin_duty then gets its own bin_out_tasks rows, one per trash_schedule pickup date inside that
   *  fortnight (trashPickupsInWindow, unchanged). */
  async function ensureBinDutiesUpToDate(){
    var horizonEnd = stepDateIso(TODAY, CALENDAR_HORIZON_DAYS);
    var newRows = []; // [{propertyId, roomId, periodStart, periodEnd}]
    for (var i=0; i<properties.length; i++){
      if (properties[i].binDutyRequired === false) continue; // this property has no bins to take out
      var propId = properties[i].id;
      var roomOrder = roomsOf(propId).slice().sort(function(a,b){ return (a.name||'').localeCompare(b.name||''); }).map(function(r){ return r.id; });
      if (roomOrder.length===0) continue;
      var propDuties = binDuties.concat(newRows).filter(function(w){ return w.propertyId===propId; });
      var lastDuty = propDuties.reduce(function(best, w){ return (!best || w.periodEnd > best.periodEnd) ? w : best; }, null);
      var guard = 0;
      while (guard++ < 20){
        var nextStart = lastDuty ? stepDateIso(lastDuty.periodEnd, 1) : startOfWeekIso(TODAY);
        if (lastDuty && nextStart > horizonEnd) break; // already generated through the horizon
        var nextEnd = stepDateIso(nextStart, 13);
        var row = { propertyId: propId, roomId: nextRoomInOrder(roomOrder, lastDuty?lastDuty.roomId:null), periodStart: nextStart, periodEnd: nextEnd };
        newRows.push(row);
        lastDuty = row;
        if (nextStart > horizonEnd) break;
      }
    }
    if (!newRows.length) return;

    var createdDuties = await binDutyService.createTasksBulk(newRows);
    binDuties = binDuties.concat(createdDuties);

    var newBinOutRows = [];
    for (var j=0; j<createdDuties.length; j++){
      var duty = createdDuties[j];
      var pickups = trashPickupsInWindow(duty.propertyId, duty.periodStart, duty.periodEnd);
      for (var k=0; k<pickups.length; k++){
        newBinOutRows.push({ binDutyId: duty.id, propertyId: duty.propertyId, roomId: duty.roomId, pickupDate: pickups[k].pickupDate, binTypes: pickups[k].binTypes });
      }
    }
    if (newBinOutRows.length){
      var createdBinOut = await binOutTaskService.createTasksBulk(newBinOutRows);
      binOutTasks = binOutTasks.concat(createdBinOut);
    }
  }

  /** A guarded status write (cleaningService/binOutTaskService only update while the stored status
   *  is still the expected prior one) matched 0 rows: someone else changed the task first. Refetch
   *  that task list so the view shows the real current state, then re-render. */
  function isStaleStatusError(err){ return !!err && err.code === cleaningService.STALE_STATUS_CODE; }
  async function reloadAfterStaleStatus(kind, message){
    showToast(message || 'This task was already updated elsewhere — reloading.', 'info');
    try {
      if (kind === 'binOut') binOutTasks = await binOutTaskService.getAll();
      else cleaningTasks = await cleaningService.getAllTasks();
    } catch(e){ /* keep the local copy — render() below still refreshes the view */ }
    render();
  }

  /* ---- Staff: task detail — view submitted photos, comment, mark reviewed ---- */
  var cleaningDetailTaskId = null;
  function openCleaningDetailModal(taskId){
    cleaningDetailTaskId = taskId;
    var task = cleaningTasks.find(function(t){ return t.id===taskId; });
    if (!task) return;
    var p = propertyOf(task.propertyId), r = roomOf(task.roomId);
    document.getElementById('cleaning-detail-title').textContent = (r?r.name:'Room') + ' · ' + shortDate(task.scheduledDate);
    var subs = cleaningTaskSubmissions(taskId);
    var comments = cleaningTaskComments(taskId);
    var effStatus = cleaningTaskEffectiveStatus(task);
    var body = '<div class="field-row"><span class="k">Property</span><span class="v">'+esc(p?p.name:'—')+'</span></div>'+
      '<div class="field-row"><span class="k">Status</span><span class="v">'+cleaningStatusBadgeHtml(task)+'</span></div>'+
      (subs.length===0
        ? '<p style="font-size:13px;color:var(--text-dim);margin:10px 0 0;">No photos submitted yet.</p>'
        : subs.map(function(s){
            var tn = tenantOf(s.tenantId);
            return '<div style="margin-top:12px;"><p style="font-size:12px;color:var(--text-faint);margin:0 0 4px;">'+esc(tn?tn.fullName:'Tenant')+' · '+shortDate((s.createdAt||'').slice(0,10))+(s.note?' — '+esc(s.note):'')+'</p>'+
              '<div style="display:flex;gap:6px;flex-wrap:wrap;">'+cleaningPhotoThumbsHtml(s.photoPaths)+'</div></div>';
          }).join(''))+
      (comments.length===0 ? '' : '<div style="margin-top:14px;"><p style="font-size:12px;color:var(--text-faint);margin:0 0 4px;">Comments</p>'+
        comments.map(function(c){ return '<p style="font-size:12.5px;color:var(--text-dim);margin:0 0 4px;">💬 '+esc(c.comment)+' <span style="color:var(--text-faint);">· '+shortDate((c.createdAt||'').slice(0,10))+'</span></p>'; }).join('')+'</div>');
    document.getElementById('cleaning-detail-body').innerHTML = body;
    document.getElementById('cleaning-detail-comment').value = '';
    document.getElementById('cleaning-detail-review-btn').hidden = task.status==='completed';
    document.getElementById('cleaning-detail-not-completed-btn').hidden = effStatus!=='overdue';
    document.getElementById('cleaning-detail-modal-error').hidden = true;
    document.getElementById('cleaning-detail-modal').hidden = false;
    hydrateLazyThumbs();
  }
  window.openCleaningDetailModal = openCleaningDetailModal;

  function closeCleaningDetailModal(){ document.getElementById('cleaning-detail-modal').hidden = true; cleaningDetailTaskId = null; }
  window.closeCleaningDetailModal = closeCleaningDetailModal;

  async function saveCleaningComment(){
    var comment = document.getElementById('cleaning-detail-comment').value.trim();
    var errorEl = document.getElementById('cleaning-detail-modal-error');
    if (!comment){ errorEl.textContent = 'Write a comment first.'; errorEl.hidden = false; return; }
    var task = cleaningTasks.find(function(t){ return t.id===cleaningDetailTaskId; });
    if (!task) return;
    try {
      var created = await cleaningService.addComment(task.id, task.propertyId, task.roomId, currentProfile ? currentProfile.id : null, comment);
      cleaningComments.push(created);
      var subs = cleaningTaskSubmissions(task.id);
      var reporterTenant = subs.length ? tenantOf(subs[subs.length-1].tenantId) : (currentTenantOf(task.roomId));
      if (reporterTenant && reporterTenant.authUserId){
        await notificationService.notify(reporterTenant.authUserId, 'New comment on your cleaning photos', comment, 'cleaning_tasks', task.id);
      }
      showToast('Comment added.', 'success');
      await refreshOperationsReadModels();
      openCleaningDetailModal(task.id);
      render();
    } catch(err){
      errorEl.textContent = friendlyErrorMessage(err);
      errorEl.hidden = false;
    }
  }
  window.saveCleaningComment = saveCleaningComment;

  async function markCleaningTaskReviewed(){
    var task = cleaningTasks.find(function(t){ return t.id===cleaningDetailTaskId; });
    if (!task) return;
    try {
      var saved = await cleaningService.setTaskStatus(task.id, 'completed', ['pending','in_progress']);
      Object.assign(task, saved);
      closeCleaningDetailModal();
      showToast('Marked as completed.', 'success');
      await refreshOperationsReadModels();
      render();
    } catch(err){
      if (isStaleStatusError(err)){ closeCleaningDetailModal(); await reloadAfterStaleStatus('cleaning'); return; }
      showToast('Could not update status. ' + friendlyErrorMessage(err), 'error');
    }
  }
  window.markCleaningTaskReviewed = markCleaningTaskReviewed;

  async function markCleaningNotCompletedConfirm(){
    var task = cleaningTasks.find(function(t){ return t.id===cleaningDetailTaskId; });
    if (!task) return;
    var r = roomOf(task.roomId);
    openConfirmModal('Mark as not completed?', 'This closes out ' + esc(r?r.name:'this room') + "'s overdue cleaning turn without it having been done. This cannot be undone from here.", async function(){
      try {
        var saved = await cleaningService.markNotCompleted(task.id);
        Object.assign(task, saved);
        closeCleaningDetailModal();
        showToast('Marked as not completed.', 'success');
        await refreshOperationsReadModels();
        render();
      } catch(err){
        if (isStaleStatusError(err)){ closeCleaningDetailModal(); await reloadAfterStaleStatus('cleaning'); return; }
        showToast('Could not update status. ' + friendlyErrorMessage(err), 'error');
      }
    }, { confirmLabel: 'Mark not completed' });
  }
  window.markCleaningNotCompletedConfirm = markCleaningNotCompletedConfirm;

  /* ---- Staff: Bin OUT task detail — view evidence, mark not completed ---- */
  var binOutDetailTaskId = null;
  async function openBinOutDetailModal(taskId){
    binOutDetailTaskId = taskId;
    var task = binOutTasks.find(function(b){ return b.id===taskId; });
    if (!task) return;
    var p = propertyOf(task.propertyId), r = roomOf(task.roomId);
    var typeLabels = task.binTypes.map(function(bt){ return TRASH_TYPE_LABEL[bt] || bt; }).join(' & ');
    document.getElementById('bin-out-detail-title').textContent = (r?r.name:'Room') + ' · ' + shortDate(task.pickupDate);
    var evidenceHtml = '<p style="font-size:13px;color:var(--text-dim);margin:10px 0 0;">No evidence photo.</p>';
    if (task.evidencePhotoPath){
      evidenceHtml = '<div style="margin-top:10px;">'+photoThumbsHtml('bin-out-evidence', [task.evidencePhotoPath])+'</div>';
    }
    var tenant = task.completedByTenantId ? tenantOf(task.completedByTenantId) : null;
    var body = '<div class="field-row"><span class="k">Property</span><span class="v">'+esc(p?p.name:'—')+'</span></div>'+
      '<div class="field-row"><span class="k">Bins</span><span class="v">'+esc(typeLabels)+'</span></div>'+
      '<div class="field-row"><span class="k">Status</span><span class="v">'+binOutStatusBadgeHtml(task)+'</span></div>'+
      (tenant ? '<div class="field-row"><span class="k">Completed by</span><span class="v">'+esc(tenant.fullName)+'</span></div>' : '') +
      evidenceHtml;
    document.getElementById('bin-out-detail-body').innerHTML = body;
    document.getElementById('bin-out-detail-not-completed-btn').hidden = binOutTaskEffectiveStatus(task)!=='overdue';
    document.getElementById('bin-out-detail-modal').hidden = false;
    hydrateLazyThumbs();
  }
  window.openBinOutDetailModal = openBinOutDetailModal;

  function closeBinOutDetailModal(){ document.getElementById('bin-out-detail-modal').hidden = true; binOutDetailTaskId = null; }
  window.closeBinOutDetailModal = closeBinOutDetailModal;

  async function markBinOutNotCompletedConfirm(){
    var task = binOutTasks.find(function(b){ return b.id===binOutDetailTaskId; });
    if (!task) return;
    var r = roomOf(task.roomId);
    openConfirmModal('Mark as not completed?', 'This closes out ' + esc(r?r.name:'this room') + "'s overdue Bin OUT without it having been done. This cannot be undone from here.", async function(){
      try {
        var saved = await binOutTaskService.markNotCompleted(task.id);
        Object.assign(task, saved);
        closeBinOutDetailModal();
        showToast('Marked as not completed.', 'success');
        await refreshOperationsReadModels();
        render();
      } catch(err){
        if (isStaleStatusError(err)){ closeBinOutDetailModal(); await reloadAfterStaleStatus('binOut'); return; }
        showToast('Could not update status. ' + friendlyErrorMessage(err), 'error');
      }
    }, { confirmLabel: 'Mark not completed' });
  }
  window.markBinOutNotCompletedConfirm = markBinOutNotCompletedConfirm;

  /* ---- Tenant: submit cleaning photos ---- */
  var cleaningSubmitTaskId = null;
  function openCleaningSubmitModal(taskId){
    cleaningSubmitTaskId = taskId;
    document.getElementById('cleaning-submit-photos').value = '';
    document.getElementById('cleaning-submit-note').value = '';
    document.getElementById('cleaning-submit-modal-error').hidden = true;
    document.getElementById('cleaning-submit-modal').hidden = false;
  }
  window.openCleaningSubmitModal = openCleaningSubmitModal;

  function closeCleaningSubmitModal(){ document.getElementById('cleaning-submit-modal').hidden = true; cleaningSubmitTaskId = null; }
  window.closeCleaningSubmitModal = closeCleaningSubmitModal;

  async function saveCleaningSubmitForm(){
    var task = cleaningTasks.find(function(t){ return t.id===cleaningSubmitTaskId; });
    var errorEl = document.getElementById('cleaning-submit-modal-error');
    var t = myTenantRecord();
    if (!task || !t){ errorEl.textContent = 'Could not find this cleaning task.'; errorEl.hidden = false; return; }
    var files = document.getElementById('cleaning-submit-photos').files;
    if (!files || !files.length){ errorEl.textContent = 'Add at least one photo.'; errorEl.hidden = false; return; }
    var note = document.getElementById('cleaning-submit-note').value.trim();
    var saveBtn = document.querySelector('#cleaning-submit-modal .mini-btn.primary');
    var originalLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Uploading…'; }
    try {
      var photoPaths = await storageService.uploadCleaningPhotos(files);
      var created = await cleaningService.createSubmission(task.id, task.propertyId, task.roomId, t.id, photoPaths, note);
      cleaningSubmissions.push(created);
      // Uploading photos is a free-standing, optional action — it never changes the task's
      // status. Only the admin (markCleaningTaskReviewed/markCleaningNotCompletedConfirm) does.
      closeCleaningSubmitModal();
      showToast('Photos submitted.', 'success');
      await refreshOperationsReadModels();
      render();
    } catch(err){
      errorEl.textContent = friendlyErrorMessage(err);
      errorEl.hidden = false;
    } finally {
      if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = originalLabel; }
    }
  }
  window.saveCleaningSubmitForm = saveCleaningSubmitForm;

  /* ---- Tenant: cleaning history (every photo they've ever submitted, across all past turns) ---- */
  function openCleaningHistoryModal(){
    var t = myTenantRecord();
    var body = document.getElementById('cleaning-history-body');
    if (!t){
      body.innerHTML = '<p style="font-size:13px;color:var(--text-dim);margin:0;">No room linked to your account.</p>';
      document.getElementById('cleaning-history-modal').hidden = false;
      return;
    }
    var mySubs = cleaningSubmissions.filter(function(s){ return s.tenantId===t.id; }).sort(function(a,b){ return (b.createdAt||'').localeCompare(a.createdAt||''); });
    body.innerHTML = mySubs.length===0
      ? '<p style="font-size:13px;color:var(--text-dim);margin:0;">No cleaning photos submitted yet.</p>'
      : mySubs.map(function(s){
          return '<div style="margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid var(--border);">'+
            '<p style="font-size:12px;color:var(--text-faint);margin:0 0 4px;">'+shortDate((s.createdAt||'').slice(0,10))+(s.note?' — '+esc(s.note):'')+'</p>'+
            '<div style="display:flex;gap:6px;flex-wrap:wrap;">'+cleaningPhotoThumbsHtml(s.photoPaths)+'</div></div>';
        }).join('');
    document.getElementById('cleaning-history-modal').hidden = false;
    hydrateLazyThumbs();
  }
  window.openCleaningHistoryModal = openCleaningHistoryModal;

  function closeCleaningHistoryModal(){ document.getElementById('cleaning-history-modal').hidden = true; }
  window.closeCleaningHistoryModal = closeCleaningHistoryModal;

  /* ---- Tenant: mark Bin OUT completed (optional evidence photo, no admin review) ---- */
  var binOutCompleteTaskId = null;
  function openBinOutCompleteModal(taskId){
    binOutCompleteTaskId = taskId;
    document.getElementById('bin-out-complete-photo').value = '';
    document.getElementById('bin-out-complete-modal-error').hidden = true;
    document.getElementById('bin-out-complete-modal').hidden = false;
  }
  window.openBinOutCompleteModal = openBinOutCompleteModal;

  function closeBinOutCompleteModal(){ document.getElementById('bin-out-complete-modal').hidden = true; binOutCompleteTaskId = null; }
  window.closeBinOutCompleteModal = closeBinOutCompleteModal;

  async function saveBinOutCompleteForm(){
    var task = binOutTasks.find(function(b){ return b.id===binOutCompleteTaskId; });
    var errorEl = document.getElementById('bin-out-complete-modal-error');
    var t = myTenantRecord();
    if (!task || !t){ errorEl.textContent = 'Could not find this Bin OUT task.'; errorEl.hidden = false; return; }
    var files = document.getElementById('bin-out-complete-photo').files;
    var saveBtn = document.querySelector('#bin-out-complete-modal .mini-btn.primary');
    var originalLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    try {
      var photoPath = (files && files.length) ? await storageService.uploadBinOutEvidencePhoto(files[0]) : null;
      var saved = await binOutTaskService.markCompleted(task.id, t.id, photoPath);
      Object.assign(task, saved);
      closeBinOutCompleteModal();
      showToast('Bin OUT marked completed.', 'success');
      await refreshOperationsReadModels();
      render();
    } catch(err){
      if (isStaleStatusError(err)){ closeBinOutCompleteModal(); await reloadAfterStaleStatus('binOut'); return; }
      errorEl.textContent = friendlyErrorMessage(err);
      errorEl.hidden = false;
    } finally {
      if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = originalLabel; }
    }
  }
  window.saveBinOutCompleteForm = saveBinOutCompleteForm;

  /* ---- Staff: trash agenda entries (property-level, opened from the property's own page) ---- */
  function onTrashTypeChange(){
    // Prefills the usual interval for the chosen bin type — the admin can still override it.
    var type = document.getElementById('trash-type').value;
    var intervalInput = document.getElementById('trash-interval');
    if (!trashModalEditId && trashService.TRASH_TYPE_DEFAULT_INTERVAL[type] != null){
      intervalInput.value = trashService.TRASH_TYPE_DEFAULT_INTERVAL[type];
    }
  }
  window.onTrashTypeChange = onTrashTypeChange;

  var trashModalEditId = null, trashModalPropertyId = null;
  function openTrashModal(propertyId, id){
    trashModalPropertyId = propertyId;
    trashModalEditId = id || null;
    var x = id ? trashSchedule.find(function(i){ return i.id===id; }) : null;
    document.getElementById('trash-modal-title').textContent = x ? 'Edit trash collection' : 'Add trash collection';
    document.getElementById('trash-type').value = x ? x.trashType : 'garbage';
    document.getElementById('trash-reference-date').value = x ? x.referenceDate : nextWeekdayIso(TODAY, 1);
    document.getElementById('trash-interval').value = x ? x.intervalDays : trashService.TRASH_TYPE_DEFAULT_INTERVAL.garbage;
    document.getElementById('trash-notes').value = x ? (x.notes||'') : '';
    document.getElementById('trash-delete-btn').hidden = !x;
    document.getElementById('trash-modal-error').hidden = true;
    document.getElementById('trash-modal').hidden = false;
  }
  window.openTrashModal = openTrashModal;

  function closeTrashModal(){ document.getElementById('trash-modal').hidden = true; trashModalEditId = null; trashModalPropertyId = null; }
  window.closeTrashModal = closeTrashModal;

  async function saveTrashForm(){
    var trashType = document.getElementById('trash-type').value;
    var referenceDate = document.getElementById('trash-reference-date').value;
    var intervalDays = parseInt(document.getElementById('trash-interval').value, 10);
    var notes = document.getElementById('trash-notes').value.trim();
    var errorEl = document.getElementById('trash-modal-error');
    if (!trashModalPropertyId || !referenceDate || !isFinite(intervalDays) || intervalDays < 1){
      errorEl.textContent = 'Enter a pickup date and a valid interval (in days).';
      errorEl.hidden = false;
      return;
    }
    var draft = { propertyId:trashModalPropertyId, trashType:trashType, referenceDate:referenceDate, intervalDays:intervalDays, notes:notes };
    try {
      if (trashModalEditId){
        var saved = await trashService.update(trashModalEditId, draft);
        var existing = trashSchedule.find(function(x){ return x.id===trashModalEditId; });
        if (existing) Object.assign(existing, saved);
      } else {
        var created = await trashService.create(draft);
        trashSchedule.push(created);
      }
      closeTrashModal();
      showToast('Trash collection saved.', 'success');
      render();
    } catch(err){
      errorEl.textContent = friendlyErrorMessage(err);
      errorEl.hidden = false;
    }
  }
  window.saveTrashForm = saveTrashForm;

  async function deleteTrashEntryConfirm(){
    if (!trashModalEditId) return;
    if (!window.confirm('Remove this entry from the trash agenda?')) return;
    try {
      await trashService.remove(trashModalEditId);
      trashSchedule = trashSchedule.filter(function(x){ return x.id!==trashModalEditId; });
      closeTrashModal();
      showToast('Removed.', 'success');
      render();
    } catch(err){
      showToast('Could not remove. ' + friendlyErrorMessage(err), 'error');
    }
  }
  window.deleteTrashEntryConfirm = deleteTrashEntryConfirm;

  /* ============ Inspection: move-in / move-out condition photos ============ */
  var INSPECTION_TYPE_LABEL = { move_in:'Move-in', move_out:'Move-out' };
  function inspectionSubmissionsFor(tenantId, type){
    return inspectionSubmissions.filter(function(s){ return s.tenantId===tenantId && s.type===type; });
  }
  function inspectionCommentsFor(tenantId, type){
    return inspectionComments.filter(function(c){ return c.tenantId===tenantId && c.type===type; });
  }
  /** canAdd: tenant or admin can attach more photos to this move-in/move-out set (both use the
   *  same submit flow — inspectionService.create doesn't care who's calling).
   *  canComment: admin can leave/see an observation on these photos (mirrors cleaning's
   *  per-task comments — see inspection_comments). Tenants always see existing comments
   *  read-only, same as they do on cleaning photos. */
  // Traffic-light tags on inspection comments (finding_severity column) — reuses the same
  // badge color tokens as Maintenance's priority badges (MAINTENANCE_PRIORITY_BADGE above),
  // not new colors: 'attention' ~ 'high' priority (orange/due), 'failed' ~ 'urgent' (red/overdue).
  var INSPECTION_SEVERITY_BADGE = { attention:'due', failed:'overdue' };
  var INSPECTION_SEVERITY_LABEL = { attention:'🟠 Attention', failed:'🔴 Failed' };

  /* ---------- Create Issue: turn a severity-tagged inspection comment into a linked Maintenance
   * Task (see entityLinkService.js + docs/superpowers/plans/2026-09-28-property-operations-
   * phase2-inspection.md Task 3). Phase 2 shipped Maintenance-only here since Cleaning had no
   * ad-hoc single-task creation entry point at the time (the Cleaning calendar only ever edits an
   * already-scheduled week's room, see reassignDutyRoom). Phase 4 adds the "Create Cleaning
   * Task" counterpart below (createCleaningTaskFromFinding / cleaningTaskIdFromFinding), once
   * cleaningService.createAdHocTask existed to back it. ---------- */
  /** The maintenance_requests id already created from this inspection comment, if any (a finding
   *  is only ever turned into one task — the button is replaced by a click-through once linked). */
  function maintenanceRequestIdFromFinding(commentId){
    var link = entityLinks.find(function(l){ return l.fromTable==='inspection_comments' && l.fromId===commentId && l.toTable==='maintenance_requests'; });
    return link ? link.toId : null;
  }
  /** The source inspection comment a given maintenance request was created from, if any. */
  function findingCommentForMaintenanceRequest(requestId){
    var link = entityLinks.find(function(l){ return l.toTable==='maintenance_requests' && l.toId===requestId && l.fromTable==='inspection_comments'; });
    if (!link) return null;
    return inspectionComments.find(function(c){ return c.id===link.fromId; }) || null;
  }

  /** Set by createMaintenanceTaskFromFinding(), consumed once by the next openMaintenanceModal(null)
   *  call, and cleared on close/save — carries the values a "Create Maintenance Task" click pre-fills
   *  that openMaintenanceModal has no other way to receive (it takes only an id). */
  var maintenanceModalPrefill = null;

  function createMaintenanceTaskFromFinding(commentId){
    var c = inspectionComments.find(function(x){ return x.id===commentId; });
    if (!c) return;
    // Same tenant+type's submissions only (Review Focus #1) — a tenant can have both move_in and
    // move_out submissions, never mix them in.
    var matchingPhotos = inspectionSubmissionsFor(c.tenantId, c.type).reduce(function(paths, s){
      return paths.concat(s.photoPaths || []);
    }, []);
    var t = tenantOf(c.tenantId);
    maintenanceModalPrefill = {
      propertyId: c.propertyId,
      roomId: c.roomId,
      tenantId: c.tenantId,
      title: (INSPECTION_TYPE_LABEL[c.type] || 'Inspection') + ' finding' + (t ? ' — ' + t.fullName : ''),
      description: 'From inspection finding: ' + c.comment,
      priority: c.findingSeverity === 'failed' ? 'high' : 'medium',
      photosBefore: matchingPhotos.slice(), // references to the same storage paths, never re-uploaded (Review Focus #5)
      sourceCommentId: c.id
    };
    openMaintenanceModal(null);
  }
  window.createMaintenanceTaskFromFinding = createMaintenanceTaskFromFinding;

  /** The cleaning_tasks id already created from this inspection comment, if any (mirrors
   *  maintenanceRequestIdFromFinding above — a finding can independently spawn both a
   *  Maintenance task and a Cleaning task, they're unrelated entity_links rows). */
  function cleaningTaskIdFromFinding(commentId){
    var link = entityLinks.find(function(l){ return l.fromTable==='inspection_comments' && l.fromId===commentId && l.toTable==='cleaning_tasks'; });
    return link ? link.toId : null;
  }

  /** "Create Cleaning Task" — Phase 4's counterpart to createMaintenanceTaskFromFinding above.
   *  Unlike Maintenance, cleaning_tasks has no title/description/priority/tenant_id columns
   *  (see cleaningService.createAdHocTask(propertyId, roomId, dueDate)), so there's no
   *  prefill-modal step here: the task is created directly from propertyId/roomId plus a
   *  default due date (3 days out — a reasonable default, not specified by the spec). The exact
   *  same inspectionSubmissionsFor(tenantId, type) photo-matching call Phase 2 already uses for
   *  Maintenance is reused here too (Review Focus #2 — no re-derivation), even though
   *  cleaning_tasks has nowhere to persist photos; it's surfaced only as a photo count in the
   *  confirmation toast. The finding's "why" is never copied onto the cleaning task — it's
   *  read back later purely via the entity_links -> inspection_comments relationship (see
   *  cleaningTaskIdFromFinding above and inspectionSectionHtml's "→ Cleaning task created" link). */
  async function createCleaningTaskFromFinding(commentId){
    var c = inspectionComments.find(function(x){ return x.id===commentId; });
    if (!c) return;
    // Same tenant+type's submissions only (Review Focus #1/#2) — identical call to
    // createMaintenanceTaskFromFinding's, not re-derived.
    var matchingPhotos = inspectionSubmissionsFor(c.tenantId, c.type).reduce(function(paths, s){
      return paths.concat(s.photoPaths || []);
    }, []);
    var d = new Date(TODAY+'T00:00:00');
    d.setDate(d.getDate() + 3);
    var dueDate = toIsoLocal(d);
    try {
      var created = await cleaningService.createAdHocTask(c.propertyId, c.roomId, dueDate);
      cleaningTasks.push(created);
      var newLink = await entityLinkService.linkEntities('inspection_comments', c.id, 'cleaning_tasks', created.id, 'created_from');
      entityLinks.push(newLink);
      showToast('Cleaning task created for ' + shortDate(dueDate) + ' (' + matchingPhotos.length + ' photo(s) on file for this finding).', 'success');
      await refreshOperationsReadModels();
      render();
    } catch(err){
      showToast('Could not create cleaning task. ' + friendlyErrorMessage(err), 'error');
    }
  }
  window.createCleaningTaskFromFinding = createCleaningTaskFromFinding;

  /** Staff-only "Attach document" control per finding-tagged inspection comment (see
   *  inspectionSectionHtml). Reuses confirmAddDocument's/confirmAddMaintenanceDocument's upload
   *  path (storageService.uploadDocument + tenantDocumentService.create), then records the
   *  association via entityLinkService so the document shows up here without any
   *  tenant_documents schema change. Unlike Maintenance, inspection_comments.tenant_id is always
   *  present (NOT NULL), so no tenant-id guard is needed. */
  async function confirmAddInspectionDocument(commentId, tenantId){
    var fileInput = document.getElementById('inspection-doc-file-'+commentId);
    var file = fileInput && fileInput.files && fileInput.files[0];
    if (!file) return;
    var docType = document.getElementById('inspection-doc-type-'+commentId).value;
    try {
      var storagePath = await storageService.uploadDocument(tenantId, file);
      var saved = await tenantDocumentService.create({ tenantId: tenantId, docType: docType, storagePath: storagePath, fileName: file.name || 'document' });
      tenantDocuments.push(saved);
      var newLink = await entityLinkService.linkEntities('tenant_documents', saved.id, 'inspection_comments', commentId, 'attached_to');
      entityLinks.push(newLink);
      showToast('Document attached.', 'success');
      await refreshOperationsReadModels();
      openInspectionDetailModal(tenantId);
    } catch(err){
      showToast('Could not attach this document. ' + friendlyErrorMessage(err), 'error');
    }
  }
  window.confirmAddInspectionDocument = confirmAddInspectionDocument;

  function inspectionSectionHtml(tenantId, type, canAdd, canComment){
    var subs = inspectionSubmissionsFor(tenantId, type);
    var comments = inspectionCommentsFor(tenantId, type);
    var photosHtml = subs.length===0 ? '<p style="font-size:12.5px;color:var(--text-dim);margin:0;">No photos yet.</p>' :
      subs.map(function(s){
        return '<div style="margin-bottom:8px;">'+
          (s.note ? '<p style="font-size:12px;color:var(--text-faint);margin:0 0 4px;">'+esc(s.note)+' · '+shortDate((s.createdAt||'').slice(0,10))+'</p>' : '<p style="font-size:11px;color:var(--text-faint);margin:0 0 4px;">'+shortDate((s.createdAt||'').slice(0,10))+'</p>')+
          '<div style="display:flex;gap:6px;flex-wrap:wrap;">'+photoThumbsHtml('inspection-photos', s.photoPaths)+'</div></div>';
      }).join('');
    var commentsHtml = comments.length===0 ? '' :
      '<div style="margin-top:8px;display:flex;flex-direction:column;gap:4px;">'+comments.map(function(c){
        var sevBadge = c.findingSeverity ? ' '+badge(INSPECTION_SEVERITY_BADGE[c.findingSeverity]||'neutral', INSPECTION_SEVERITY_LABEL[c.findingSeverity]||c.findingSeverity) : '';
        // "Create Issue" — staff-only (canComment), and only for findings (severity set). Once
        // linked, show a click-through instead of the button (a finding creates at most one task).
        var issueHtml = '';
        if (canComment && c.findingSeverity){
          var linkedRequestId = maintenanceRequestIdFromFinding(c.id);
          issueHtml = linkedRequestId
            ? ' <a href="#" onclick="event.preventDefault();openMaintenanceModal(\''+linkedRequestId+'\')" style="font-size:12px;">→ Maintenance task created</a>'
            : ' <button class="mini-btn" style="padding:2px 8px;font-size:12px;" onclick="createMaintenanceTaskFromFinding(\''+c.id+'\')">Create Maintenance Task</button>';
        }
        // "Create Cleaning Task" — same staff-only/finding-tagged gate as Create Maintenance
        // Task above, and independent of it (a finding can spawn both).
        var cleaningHtml = '';
        if (canComment && c.findingSeverity){
          var linkedCleaningTaskId = cleaningTaskIdFromFinding(c.id);
          cleaningHtml = linkedCleaningTaskId
            ? ' <a href="#" onclick="event.preventDefault();openCleaningDetailModal(\''+linkedCleaningTaskId+'\')" style="font-size:12px;">→ Cleaning task created</a>'
            : ' <button class="mini-btn" style="padding:2px 8px;font-size:12px;" onclick="createCleaningTaskFromFinding(\''+c.id+'\')">Create Cleaning Task</button>';
        }
        // "Attach document" — staff-only (canComment), and only for findings (severity set), same
        // gate as "Create Issue" above. inspection_comments.tenant_id is always NOT NULL (unlike
        // Maintenance's optional tenant_id), so no disable-case is needed here.
        var docsHtml = '';
        if (canComment && c.findingSeverity){
          var attachedLinks = entityLinks.filter(function(l){
            return l.fromTable==='tenant_documents' && l.toTable==='inspection_comments' && l.toId===c.id;
          });
          var attachedHtml = attachedLinks.map(function(l){
            var doc = tenantDocuments.find(function(d){ return d.id===l.fromId; });
            if (!doc) return '';
            return '<div class="field-row"><span class="k">'+esc(doc.fileName||doc.docType)+' — '+esc(DOC_TYPE_LABEL[doc.docType]||'Other')+'</span>'+
              '<span class="v"><button class="text-link" onclick="viewReceipt(\'documents\',\''+doc.storagePath+'\')">View</button></span></div>';
          }).join('');
          var docTypeOptionsHtml = Object.keys(DOC_TYPE_LABEL).map(function(k){
            return '<option value="'+k+'">'+esc(DOC_TYPE_LABEL[k])+'</option>';
          }).join('');
          docsHtml = '<div style="margin:2px 0 4px 16px;">'+attachedHtml+
            '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:4px;">'+
              '<input type="file" id="inspection-doc-file-'+c.id+'" accept="image/*,application/pdf" style="max-width:160px;" />'+
              '<select id="inspection-doc-type-'+c.id+'">'+docTypeOptionsHtml+'</select>'+
              '<button class="mini-btn" style="padding:2px 8px;font-size:12px;" onclick="confirmAddInspectionDocument(\''+c.id+'\',\''+tenantId+'\')">Attach document</button>'+
            '</div></div>';
        }
        return '<p style="font-size:12.5px;color:var(--text-dim);margin:0;">💬 '+esc(c.comment)+sevBadge+' <span style="color:var(--text-faint);">· '+shortDate((c.createdAt||'').slice(0,10))+'</span>'+issueHtml+cleaningHtml+'</p>'+docsHtml;
      }).join('')+'</div>';
    var commentFormHtml = !canComment ? '' :
      '<div class="form-row" style="margin-top:10px;">'+
        '<label for="inspection-comment-input-'+type+'">Add a comment / observation</label>'+
        '<textarea id="inspection-comment-input-'+type+'"></textarea>'+
      '</div>'+
      '<div class="form-row">'+
        '<label for="inspection-comment-severity-'+type+'">Severity</label>'+
        '<select id="inspection-comment-severity-'+type+'">'+
          '<option value="">None (plain comment)</option>'+
          '<option value="attention">🟠 Attention</option>'+
          '<option value="failed">🔴 Failed</option>'+
        '</select>'+
      '</div>'+
      '<button class="mini-btn" onclick="saveInspectionComment(\''+tenantId+'\',\''+type+'\')">Add comment</button>';
    return '<div class="card" style="margin-bottom:10px;">'+
      '<div class="detail-head" style="margin-top:0;align-items:center;"><h2 style="margin:0;font-size:14px;">'+INSPECTION_TYPE_LABEL[type]+' photos</h2>'+
      (canAdd ? '<button class="mini-btn primary" onclick="openInspectionSubmitModal(\''+tenantId+'\',\''+type+'\')">'+(subs.length?'Add more photos':'Add photos')+'</button>' : '')+
      '</div>'+photosHtml+commentsHtml+commentFormHtml+'</div>';
  }

  function renderInspection(){
    if (isStaff()) return renderInspectionStaff();
    var t = myTenantRecord();
    if (!t) return pageHeader('Inspection', '') + '<div class="card"><p style="font-size:13.5px;color:var(--text-dim);margin:0;">Your account isn\'t linked to a tenant record yet — ask your Super Admin.</p></div>';
    if (!t.roomId) return pageHeader('Inspection', '') + '<div class="card"><p style="font-size:13.5px;color:var(--text-dim);margin:0;">Your account isn\'t linked to a room yet — ask your Super Admin.</p></div>';
    return pageHeader('Inspection', 'Photos of the room when you moved in, and again when you move out.') +
      inspectionSectionHtml(t.id, 'move_in', true, false) +
      inspectionSectionHtml(t.id, 'move_out', true, false);
  }

  /** Grouped by property (each with a header), same convention as Cleaning's staff view —
   *  matches how the admin actually thinks about their portfolio, property by property. */
  function renderInspectionStaff(){
    var activeTenants = tenants.filter(function(t){ return t.rentAmount > 0; });
    var byProperty = {};
    activeTenants.forEach(function(t){
      (byProperty[t.propertyId] || (byProperty[t.propertyId] = [])).push(t);
    });
    var propIds = Object.keys(byProperty).sort(function(a,b){
      var pa = propertyOf(a), pb = propertyOf(b);
      return (pa?pa.name:'').localeCompare(pb?pb.name:'');
    });
    if (!propIds.length) return pageHeader('Inspection', "Move-in and move-out condition photos, per tenant.") +
      '<div class="card"><p style="font-size:13.5px;color:var(--text-dim);margin:0;">No tenants yet.</p></div>';
    var sectionsHtml = propIds.map(function(propId){
      var p = propertyOf(propId);
      var tenantsHere = byProperty[propId].slice().sort(function(a,b){ return (a.fullName||'').localeCompare(b.fullName||''); });
      var rows = tenantsHere.map(function(t){
        var r = t.roomId ? roomOf(t.roomId) : null;
        var moveIn = inspectionSubmissionsFor(t.id, 'move_in').length;
        var moveOut = inspectionSubmissionsFor(t.id, 'move_out').length;
        return '<div class="card" style="cursor:pointer;" onclick="openInspectionDetailModal(\''+t.id+'\')">'+
          '<div class="detail-head" style="margin-top:0;align-items:center;"><h2 style="margin:0;font-size:14px;">'+esc(t.fullName)+'</h2></div>'+
          '<p style="font-size:12.5px;color:var(--text-dim);margin:2px 0;">'+(r?esc(r.name):'—')+'</p>'+
          '<p style="font-size:11.5px;color:var(--text-faint);margin:0;">Move-in: '+moveIn+' photo submission'+(moveIn!==1?'s':'')+' · Move-out: '+moveOut+' photo submission'+(moveOut!==1?'s':'')+'</p>'+
          '</div>';
      }).join('');
      return '<h2 style="font-size:12.5px;color:var(--text-dim);text-transform:uppercase;letter-spacing:.04em;margin:18px 0 8px;">'+esc(p?p.name:'—')+'</h2>'+rows;
    }).join('');
    return pageHeader('Inspection', "Move-in and move-out condition photos, per property.") + sectionsHtml;
  }

  function openInspectionDetailModal(tenantId){
    var t = tenantOf(tenantId);
    if (!t) return;
    document.getElementById('inspection-detail-title').textContent = t.fullName;
    document.getElementById('inspection-detail-body').innerHTML =
      inspectionSectionHtml(tenantId, 'move_in', true, true) + inspectionSectionHtml(tenantId, 'move_out', true, true);
    document.getElementById('inspection-detail-modal-error').hidden = true;
    document.getElementById('inspection-detail-modal').hidden = false;
    hydrateLazyThumbs();
  }
  window.openInspectionDetailModal = openInspectionDetailModal;

  async function saveInspectionComment(tenantId, type){
    var input = document.getElementById('inspection-comment-input-'+type);
    var comment = input ? input.value.trim() : '';
    var errorEl = document.getElementById('inspection-detail-modal-error');
    if (!comment){ errorEl.textContent = 'Write a comment first.'; errorEl.hidden = false; return; }
    var t = tenantOf(tenantId);
    if (!t){ errorEl.textContent = 'Could not find this tenant.'; errorEl.hidden = false; return; }
    var severityInput = document.getElementById('inspection-comment-severity-'+type);
    var severity = severityInput ? severityInput.value : '';
    try {
      var created = await inspectionService.addComment(t.propertyId, t.roomId, t.id, type, currentProfile ? currentProfile.id : null, comment, severity || null);
      inspectionComments.push(created);
      if (t.authUserId){
        await notificationService.notify(t.authUserId, 'New comment on your '+(INSPECTION_TYPE_LABEL[type]||'').toLowerCase()+' photos', comment, 'inspection_submissions', t.id);
      }
      showToast('Comment added.', 'success');
      await refreshOperationsReadModels();
      openInspectionDetailModal(tenantId);
      render();
    } catch(err){
      errorEl.textContent = friendlyErrorMessage(err);
      errorEl.hidden = false;
    }
  }
  window.saveInspectionComment = saveInspectionComment;

  function closeInspectionDetailModal(){ document.getElementById('inspection-detail-modal').hidden = true; }
  window.closeInspectionDetailModal = closeInspectionDetailModal;

  var inspectionSubmitTenantId = null, inspectionSubmitType = null;
  function openInspectionSubmitModal(tenantId, type){
    inspectionSubmitTenantId = tenantId;
    inspectionSubmitType = type;
    document.getElementById('inspection-submit-title').textContent = 'Add ' + (INSPECTION_TYPE_LABEL[type]||'').toLowerCase() + ' photos';
    document.getElementById('inspection-submit-photos').value = '';
    document.getElementById('inspection-submit-note').value = '';
    document.getElementById('inspection-submit-modal-error').hidden = true;
    document.getElementById('inspection-submit-modal').hidden = false;
  }
  window.openInspectionSubmitModal = openInspectionSubmitModal;

  function closeInspectionSubmitModal(){ document.getElementById('inspection-submit-modal').hidden = true; inspectionSubmitTenantId = null; inspectionSubmitType = null; }
  window.closeInspectionSubmitModal = closeInspectionSubmitModal;

  async function saveInspectionSubmitForm(){
    var errorEl = document.getElementById('inspection-submit-modal-error');
    var t = tenantOf(inspectionSubmitTenantId);
    if (!t || !inspectionSubmitType){ errorEl.textContent = 'Something went wrong — close and try again.'; errorEl.hidden = false; return; }
    var files = document.getElementById('inspection-submit-photos').files;
    if (!files || !files.length){ errorEl.textContent = 'Add at least one photo.'; errorEl.hidden = false; return; }
    var note = document.getElementById('inspection-submit-note').value.trim();
    var saveBtn = document.querySelector('#inspection-submit-modal .mini-btn.primary');
    var originalLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Uploading…'; }
    try {
      var photoPaths = await storageService.uploadInspectionPhotos(files);
      var created = await inspectionService.create(t.propertyId, t.roomId, t.id, inspectionSubmitType, photoPaths, note);
      inspectionSubmissions.push(created);
      closeInspectionSubmitModal();
      showToast('Photos submitted.', 'success');
      await refreshOperationsReadModels();
      render();
    } catch(err){
      errorEl.textContent = friendlyErrorMessage(err);
      errorEl.hidden = false;
    } finally {
      if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = originalLabel; }
    }
  }
  window.saveInspectionSubmitForm = saveInspectionSubmitForm;

  /* ============ Users (Super Admin only) ============ */
  var ROLE_LABEL = { super_admin:'Super Admin', administrator:'Administrator', tenant:'Tenant' };

  var usersViewTab = 'administrator'; // 'administrator' | 'super_admin' | 'tenant'
  function setUsersViewTab(tab){ usersViewTab = tab; renderPreservingScroll(); }
  window.setUsersViewTab = setUsersViewTab;

  function renderUsers(){
    if (!isSuperAdmin()) return accessDeniedPage();
    var USERS_TABS = [['administrator','Admins'],['super_admin','Super Admins'],['tenant','Tenants']];
    var tabsHtml = '<div class="filter-chips" style="margin-bottom:10px;">' + USERS_TABS.map(function(tb){
      var count = allProfiles.filter(function(p){ return p.role===tb[0]; }).length;
      return '<button class="chip'+(usersViewTab===tb[0]?' active':'')+'" onclick="setUsersViewTab(\''+tb[0]+'\')">'+tb[1]+' ('+count+')</button>';
    }).join('') + '</div>';
    var scopedProfiles = allProfiles.filter(function(p){ return p.role === usersViewTab; });
    var rows = scopedProfiles.map(function(p){
      var phoneLogin = isPhoneLoginProfile(p);
      var identityLine = phoneLogin ? ('Logs in with: '+esc(p.phone||'—')) : (esc(p.email)+(p.phone?' · '+esc(p.phone):''));
      var assignHtml = '';
      if (p.role === 'administrator'){
        var assignedIds = propertyAssignments.filter(function(a){ return a.profileId===p.id; }).map(function(a){ return a.propertyId; });
        assignHtml = '<div style="margin-top:8px;"><div style="font-size:11.5px;color:var(--text-faint);margin-bottom:4px;">Assigned properties</div>'+
          '<div style="display:flex;flex-wrap:wrap;gap:6px;">'+
          properties.map(function(prop){
            var checked = assignedIds.indexOf(prop.id) > -1;
            return '<label style="display:flex;align-items:center;gap:4px;font-size:12px;border:1px solid var(--border);border-radius:8px;padding:4px 8px;">'+
              '<input type="checkbox" '+(checked?'checked':'')+' onchange="togglePropertyAdmin(\''+p.id+'\',\''+prop.id+'\',this.checked)" />'+esc(prop.name)+'</label>';
          }).join('') +
          (properties.length===0 ? '<span style="font-size:12px;color:var(--text-faint);">No properties yet.</span>' : '')+
          '</div></div>';
      }
      return '<div class="card"><div class="detail-head" style="margin-top:0;align-items:center;">'+
        '<h2 style="margin:0;font-size:14px;">'+esc((p.firstName+' '+p.lastName).trim() || p.email)+'</h2>'+
        badge(p.isActive ? 'paid' : 'overdue', p.isActive ? 'Active' : 'Deactivated')+
        '</div>'+
        '<p style="font-size:12.5px;color:var(--text-dim);margin:2px 0;">'+identityLine+'</p>'+
        (p.currentPassword
          ? '<div style="display:flex;align-items:center;gap:8px;margin:4px 0;">'+
            '<span style="font-size:11.5px;color:var(--text-faint);">Password:</span>'+
            '<span class="pw-mask" data-pw="'+esc(p.currentPassword)+'" data-shown="0" style="font-family:monospace;font-size:12.5px;letter-spacing:1px;">••••••••</span>'+
            '<button type="button" class="mini-btn" style="padding:2px 8px;font-size:11px;" onclick="togglePasswordVisible(this)">Show</button>'+
            '<button type="button" class="mini-btn" style="padding:2px 8px;font-size:11px;" onclick="copyPasswordToClipboard(this)">Copy</button>'+
            '</div>'
          : '<p style="font-size:11.5px;color:var(--text-faint);margin:4px 0;">No saved password yet — use Reset password to set one.</p>')+
        '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:6px;">'+
        '<select onchange="changeUserRole(\''+p.id+'\',this.value)" '+(p.authUserId===currentProfile.authUserId?'disabled title="You can\'t change your own role"':'')+'>'+
        ['super_admin','administrator','tenant'].map(function(r){ return '<option value="'+r+'"'+(r===p.role?' selected':'')+'>'+ROLE_LABEL[r]+'</option>'; }).join('')+
        '</select>'+
        '<button class="mini-btn" onclick="toggleUserActive(\''+p.id+'\','+(!p.isActive)+')" '+(p.authUserId===currentProfile.authUserId?'disabled title="You can\'t deactivate yourself"':'')+'>'+(p.isActive?'Deactivate':'Activate')+'</button>'+
        '<button class="mini-btn" onclick="resetUserPassword(\''+p.id+'\')">Set / reset password</button>'+
        (phoneLogin ? '' : '<button class="mini-btn" onclick="sendUserPasswordResetEmail(\''+p.id+'\')">Email reset link</button>')+
        '<button class="mini-btn" onclick="openEditUserModal(\''+p.id+'\')">Edit</button>'+
        '<button class="mini-btn" style="color:var(--status-overdue);" onclick="confirmDeleteUser(\''+p.id+'\')" '+(p.authUserId===currentProfile.authUserId?'disabled title="You can\'t delete your own account"':'')+'>Delete</button>'+
        '</div>'+assignHtml+'</div>';
    }).join('');
    return pageHeader('Users', 'Every account and its role. Only a Super Admin sees this page.') +
      '<button class="mini-btn primary" style="margin-bottom:12px;" onclick="openUserModal()">Create user</button>'+
      tabsHtml +
      (rows || '<div class="card"><p style="font-size:13.5px;color:var(--text-dim);margin:0;">No '+ (USERS_TABS.find(function(tb){return tb[0]===usersViewTab;})||['','users'])[1].toLowerCase() +' yet.</p></div>');
  }

  async function togglePropertyAdmin(profileId, propertyId, assign){
    try {
      if (assign){
        var created = await profileService.assignProperty(profileId, propertyId);
        propertyAssignments.push(created);
      } else {
        await profileService.unassignProperty(profileId, propertyId);
        propertyAssignments = propertyAssignments.filter(function(a){ return !(a.profileId===profileId && a.propertyId===propertyId); });
      }
      showToast(assign ? 'Property assigned.' : 'Property unassigned.', 'success');
    } catch(err){
      showToast('Could not update the assignment. ' + friendlyErrorMessage(err), 'error');
      render();
    }
  }
  window.togglePropertyAdmin = togglePropertyAdmin;

  /** Shows/hides the plaintext password stashed next to a user (Users page) — hidden by default
   *  so it isn't left on-screen by accident, revealed on tap. */
  function togglePasswordVisible(btn){
    var span = btn.previousElementSibling;
    if (!span || !span.classList.contains('pw-mask')) return;
    var shown = span.getAttribute('data-shown') === '1';
    if (shown){
      span.textContent = '••••••••';
      span.setAttribute('data-shown', '0');
      btn.textContent = 'Show';
    } else {
      span.textContent = span.getAttribute('data-pw') || '';
      span.setAttribute('data-shown', '1');
      btn.textContent = 'Hide';
    }
  }
  window.togglePasswordVisible = togglePasswordVisible;

  function copyPasswordToClipboard(btn){
    var span = btn.parentElement.querySelector('.pw-mask');
    var pw = span ? span.getAttribute('data-pw') : '';
    if (!pw) return;
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(pw).then(function(){ showToast('Password copied.', 'success'); })
        .catch(function(){ showToast('Could not copy — press and hold the password to copy it manually.', 'error'); });
    } else {
      showToast('Could not copy — press and hold the password to copy it manually.', 'error');
    }
  }
  window.copyPasswordToClipboard = copyPasswordToClipboard;

  async function changeUserRole(profileId, role){
    try {
      var saved = await profileService.setRole(profileId, role);
      Object.assign(allProfiles.find(function(p){ return p.id===profileId; }), saved);
      showToast('Role updated.', 'success');
    } catch(err){
      showToast('Could not update the role. ' + friendlyErrorMessage(err), 'error');
      render();
    }
  }
  window.changeUserRole = changeUserRole;

  async function toggleUserActive(profileId, nextActive){
    try {
      var saved = await profileService.setActive(profileId, nextActive);
      Object.assign(allProfiles.find(function(p){ return p.id===profileId; }), saved);
      showToast(nextActive ? 'User activated.' : 'User deactivated.', 'success');
      renderPreservingScroll();
    } catch(err){
      showToast('Could not update this user. ' + friendlyErrorMessage(err), 'error');
    }
  }
  window.toggleUserActive = toggleUserActive;

  var editUserProfileId = null;
  function openEditUserModal(profileId){
    var p = allProfiles.find(function(x){ return x.id===profileId; });
    if (!p) return;
    editUserProfileId = profileId;
    var phoneLogin = isPhoneLoginProfile(p);
    document.getElementById('edit-user-first-name').value = p.firstName || '';
    document.getElementById('edit-user-last-name').value = p.lastName || '';
    document.getElementById('edit-user-email').value = phoneLogin ? '' : (p.email || '');
    document.getElementById('edit-user-email-row').hidden = phoneLogin;
    document.getElementById('edit-user-phone').value = p.phone || '';
    document.getElementById('edit-user-phone-label').textContent = phoneLogin ? 'Phone number (this is how they log in)' : 'Phone (optional)';
    document.getElementById('edit-user-phone-hint').hidden = !phoneLogin;
    document.getElementById('edit-user-modal-error').hidden = true;
    document.getElementById('edit-user-modal').hidden = false;
  }
  window.openEditUserModal = openEditUserModal;

  function closeEditUserModal(){
    document.getElementById('edit-user-modal').hidden = true;
    editUserProfileId = null;
  }
  window.closeEditUserModal = closeEditUserModal;

  async function saveEditUserForm(){
    if (!editUserProfileId) return;
    var p = allProfiles.find(function(x){ return x.id===editUserProfileId; });
    if (!p) return;
    var phoneLogin = isPhoneLoginProfile(p);
    var firstName = document.getElementById('edit-user-first-name').value.trim();
    var lastName = document.getElementById('edit-user-last-name').value.trim();
    var email = document.getElementById('edit-user-email').value.trim();
    var phone = document.getElementById('edit-user-phone').value.trim();
    var errorEl = document.getElementById('edit-user-modal-error');
    if (!firstName){
      errorEl.textContent = 'Add a first name.';
      errorEl.hidden = false;
      return;
    }
    if (phoneLogin){
      if (phoneDigitsOnly(phone).length < 8){
        errorEl.textContent = 'Add a valid phone number, with country code.';
        errorEl.hidden = false;
        return;
      }
    } else if (!email || !email.includes('@')){
      errorEl.textContent = 'Add a valid email.';
      errorEl.hidden = false;
      return;
    }
    var saveBtn = document.querySelector('#edit-user-modal .mini-btn.primary');
    var originalLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    errorEl.hidden = true;
    try {
      var updated = await profileService.updateUser(editUserProfileId, { firstName:firstName, lastName:lastName, phone:phone, email: phoneLogin ? undefined : email });
      if (updated) Object.assign(p, updated);
      closeEditUserModal();
      showToast('User updated.', 'success');
      render();
    } catch(err){
      errorEl.textContent = friendlyErrorMessage(err);
      errorEl.hidden = false;
    } finally {
      if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = originalLabel; }
    }
  }
  window.saveEditUserForm = saveEditUserForm;

  async function confirmDeleteUser(profileId){
    var p = allProfiles.find(function(x){ return x.id===profileId; });
    if (!p) return;
    var name = (p.firstName + ' ' + p.lastName).trim() || p.email || 'this user';
    if (!window.confirm('Delete ' + name + '\'s login? This can\'t be undone. ' + (p.role==='tenant' ? 'Their tenant record and payment history stay — just the login is removed.' : ''))) return;
    try {
      var result = await profileService.deleteUser(profileId);
      allProfiles = allProfiles.filter(function(x){ return x.id !== profileId; });
      if (result && result.warning) showToast(result.warning, 'error');
      else showToast('User deleted.', 'success');
      render();
    } catch(err){
      showToast('Could not delete this user. ' + friendlyErrorMessage(err), 'error');
    }
  }
  window.confirmDeleteUser = confirmDeleteUser;

  /** The Super Admin sets, changes or resets the password of ANY user (Administrator or
   *  Tenant) directly — no email reset link is sent to anyone anymore. Instead,
   *  after saving the new password, the option to share it over WhatsApp is offered (using the
   *  phone number saved on the profile), just like the rest of the app shares things with tenants. */
  async function resetUserPassword(profileId){
    var target = allProfiles.find(function(p){ return p.id===profileId; });
    if (!target) return;
    var label = (target.firstName + ' ' + target.lastName).trim() || target.email || 'this user';
    var newPw = window.prompt('Set a password for ' + label + ' (at least 8 characters). You\'ll get the chance to send it to them over WhatsApp next.');
    if (!newPw) return;
    if (newPw.length < 8){ showToast('Password must be at least 8 characters.', 'error'); return; }
    try {
      await profileService.forceSetPassword(profileId, newPw);
      target.currentPassword = newPw;
      showToast('Password saved.', 'success');
      render();
      offerPasswordWhatsAppShare(target, newPw);
    } catch(err){
      showToast('Could not update the password. ' + friendlyErrorMessage(err), 'error');
    }
  }
  /** Offers to share the newly assigned password over WhatsApp — uses the native share sheet
   *  when available (same as "Share to WhatsApp group" in Bills); otherwise, opens a direct
   *  WhatsApp chat with the phone number saved on the profile; if there's no saved phone number,
   *  just notes that it needs to be copied by hand (it's already saved and visible in Users). */
  async function offerPasswordWhatsAppShare(profile, newPassword){
    var loginId = isPhoneLoginProfile(profile) ? profile.phone : profile.email;
    var name = (profile.firstName + ' ' + profile.lastName).trim() || 'there';
    var message = 'Hi ' + name + ', your Manager login was updated.\n' +
      'Username: ' + loginId + '\nPassword: ' + newPassword + '\n\nKeep this somewhere safe.';
    if (navigator.share){
      try { await navigator.share({ text: message, title: 'Manager login' }); return; }
      catch(e){ /* user cancelled the share sheet — fall through to the direct link below */ }
    }
    var digits = phoneDigitsForWhatsApp(profile.phone);
    if (digits){
      window.open(whatsAppBusinessLink('https://wa.me/' + digits + '?text=' + encodeURIComponent(message)), '_blank', 'noopener');
    } else {
      showToast('No phone number saved for ' + name + ' — copy the password from Users to send it another way.', 'info');
    }
  }
  window.resetUserPassword = resetUserPassword;

  /** Alternative to "Set / reset password" for a user with an email (Administrator/Super
   *  Admin) — instead of the Super Admin making up and sharing a new password, it sends them the
   *  standard Supabase link so the person can choose their own new password. */
  async function sendUserPasswordResetEmail(profileId){
    var p = allProfiles.find(function(x){ return x.id===profileId; });
    if (!p || !p.email) return;
    try {
      await profileService.sendPasswordReset(p.email);
      showToast('Password reset email sent to ' + p.email + '.', 'success');
    } catch(err){
      showToast('Could not send the reset email. ' + friendlyErrorMessage(err), 'error');
    }
  }
  window.sendUserPasswordResetEmail = sendUserPasswordResetEmail;

  function onUserRoleChange(){
    var role = document.getElementById('user-role').value;
    var isTenant = role === 'tenant';
    var row = document.getElementById('user-tenant-link-row');
    row.hidden = !isTenant;
    document.getElementById('user-email-row').hidden = isTenant;
    document.getElementById('user-phone-label').textContent = isTenant ? 'Phone number (this is how they log in)' : 'Phone (optional)';
    document.getElementById('user-phone-hint').hidden = !isTenant;
    if (isTenant){
      var select = document.getElementById('user-tenant-link');
      var unlinked = tenants.filter(function(t){ return !t.authUserId; });
      select.innerHTML = '<option value="">— Not linked yet —</option>' +
        unlinked.map(function(t){ return '<option value="'+t.id+'">'+esc(t.fullName)+'</option>'; }).join('');
    }
  }
  window.onUserRoleChange = onUserRoleChange;

  /** Picking a tenant to link auto-fills their name/phone already on file, so the Super Admin
   *  doesn't have to retype what's already in the Tenants page. */
  function onUserTenantLinkChange(){
    var tenantId = document.getElementById('user-tenant-link').value;
    if (!tenantId) return;
    var t = tenantOf(tenantId);
    if (!t) return;
    var nameParts = (t.fullName || '').trim().split(/\s+/);
    document.getElementById('user-first-name').value = nameParts[0] || '';
    document.getElementById('user-last-name').value = nameParts.slice(1).join(' ');
    if (t.phone) document.getElementById('user-phone').value = t.phone;
  }
  window.onUserTenantLinkChange = onUserTenantLinkChange;

  /** 8 characters, without 0/O/1/l/I (they're easy to confuse when copied by hand or over WhatsApp/email). */
  function generatePassword(len){
    len = len || 8;
    var chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    var out = '';
    for (var i=0;i<len;i++) out += chars.charAt(Math.floor(Math.random()*chars.length));
    return out;
  }
  function regenerateUserPassword(){
    document.getElementById('user-password').value = generatePassword(8);
  }
  window.regenerateUserPassword = regenerateUserPassword;

  function openUserModal(){
    document.getElementById('user-first-name').value = '';
    document.getElementById('user-last-name').value = '';
    document.getElementById('user-email').value = '';
    document.getElementById('user-phone').value = '';
    document.getElementById('user-password').value = generatePassword(8);
    document.getElementById('user-role').value = 'administrator';
    onUserRoleChange();
    document.getElementById('user-modal-error').hidden = true;
    document.getElementById('user-modal').hidden = false;
  }
  window.openUserModal = openUserModal;

  function closeUserModal(){
    document.getElementById('user-modal').hidden = true;
  }
  window.closeUserModal = closeUserModal;

  async function saveUserForm(){
    var firstName = document.getElementById('user-first-name').value.trim();
    var lastName = document.getElementById('user-last-name').value.trim();
    var email = document.getElementById('user-email').value.trim();
    var phone = document.getElementById('user-phone').value.trim();
    var password = document.getElementById('user-password').value;
    var role = document.getElementById('user-role').value;
    var isTenant = role === 'tenant';
    var tenantId = isTenant ? (document.getElementById('user-tenant-link').value || null) : null;
    var errorEl = document.getElementById('user-modal-error');
    if (!firstName){
      errorEl.textContent = 'Add a first name.';
      errorEl.hidden = false;
      return;
    }
    if (isTenant){
      if (phoneDigitsOnly(phone).length < 8){
        errorEl.textContent = 'Add a valid phone number, with country code — that\'s what this tenant will log in with.';
        errorEl.hidden = false;
        return;
      }
    } else if (!email || !email.includes('@')){
      errorEl.textContent = 'Add a valid email.';
      errorEl.hidden = false;
      return;
    }
    if (!password || password.length < 8){
      errorEl.textContent = 'The initial password must be at least 8 characters.';
      errorEl.hidden = false;
      return;
    }
    var saveBtn = document.querySelector('#user-modal .mini-btn.primary');
    var originalLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Creating…'; }
    errorEl.hidden = true;
    try {
      var result = await profileService.createUser({ email: isTenant ? undefined : email, password:password, firstName:firstName, lastName:lastName, phone:phone, role:role, tenantId:tenantId });
      allProfiles = await profileService.getAll();
      if (tenantId){
        var t = tenantOf(tenantId);
        if (t) t.authUserId = (result && result.userId) || t.authUserId;
      }
      closeUserModal();
      if (result && result.warning){
        showToast(result.warning, 'error');
      } else if (!isTenant && email){
        showToast('User created. Opening email to send their login…', 'success');
        offerNewUserEmailShare(email, (firstName + ' ' + lastName).trim(), password);
      } else if (isTenant){
        showToast('Tenant login created, deactivated — activate it in Users when you\'re ready for them to get notifications.', 'success');
      } else {
        showToast('User created. Share the login and password with them directly.', 'success');
      }
      render();
    } catch(err){
      errorEl.textContent = friendlyErrorMessage(err);
      errorEl.hidden = false;
    } finally {
      if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = originalLabel; }
    }
  }
  window.saveUserForm = saveUserForm;

  /** After creating an Administrator/Super Admin (email login), offers to send them their
   *  credentials by email — same pattern as offerPasswordWhatsAppShare: uses the native share sheet
   *  when available (Mail can be picked right there), otherwise opens a direct mailto:. */
  async function offerNewUserEmailShare(email, name, password){
    var subject = 'Your Manager login';
    var message = 'Hi ' + (name || 'there') + ', your Manager account was created.\n' +
      'Email: ' + email + '\nPassword: ' + password + '\n\nKeep this somewhere safe.';
    if (navigator.share){
      try { await navigator.share({ text: message, title: subject }); return; }
      catch(e){ /* user cancelled the share sheet — fall through to mailto: below */ }
    }
    window.open('mailto:' + encodeURIComponent(email) + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(message), '_blank');
  }

  /* ============ Audit log (Super Admin only) ============ */
  var auditLogRows = null; // lazy-loaded on first visit
  function renderAuditLog(){
    if (!isSuperAdmin()) return accessDeniedPage();
    if (auditLogRows === null){
      loadAuditLog();
      return pageHeader('Audit log', 'Every change to payments, bills, tenants, rooms, properties and roles.') +
        '<div class="card"><p style="font-size:13.5px;color:var(--text-dim);margin:0;">Loading…</p></div>';
    }
    var rows = auditLogRows.map(function(r){
      return '<div class="card">'+
        '<p style="font-size:12.5px;margin:0 0 2px;"><strong>'+esc(r.action)+'</strong> on <strong>'+esc(r.table_name)+'</strong></p>'+
        '<p style="font-size:11.5px;color:var(--text-faint);margin:0;">'+new Date(r.created_at).toLocaleString()+'</p>'+
        '</div>';
    }).join('');
    return pageHeader('Audit log', 'Every change to payments, bills, tenants, rooms, properties and roles. Showing the latest 100.') +
      (rows || '<div class="card"><p style="font-size:13.5px;color:var(--text-dim);margin:0;">No changes recorded yet.</p></div>');
  }
  async function loadAuditLog(){
    try {
      auditLogRows = await auditService.getRecent(100);
    } catch(_e){
      auditLogRows = [];
    }
    render();
  }

  /* ============ Tenant portal: read-only views of the tenant's own data (RLS already limits
   * every array below to just this person — see myTenantRecord()) ============ */
  /** Tenant-facing "My Bond" — same underlying data as moveOutSettlementCardHtml, worded for the
   *  tenant and never showing a total as final until status is completed (spec section 11: "Do
   *  not show the settlement as final until the administrator approves it"). */
  function renderTenantMyBondHtml(t){
    var bond = bondOf(t.id);
    var settlement = moveOutSettlementOf(t.id);
    if (!bond && !settlement) return '';
    var rows = bond ? '<div class="field-row"><span class="k">Original bond</span><span class="v">'+money(bond.amountPaid)+'</span></div>' : '';
    if (!settlement){
      return '<div class="card"><h2>My Bond</h2>'+rows+
        '<button class="mini-btn primary" onclick="startMoveOutProcess(\''+t.id+'\')">Start Move-Out Process</button></div>';
    }
    if (settlement.status === 'completed'){
      var lines = (bond && bond.discounts || []).filter(function(d){ return d.settlementId === settlement.id; });
      return '<div class="card"><h2>My Bond</h2>'+
        '<div class="field-row"><span class="k">Status</span><span class="v">Move-Out Completed</span></div>'+rows+
        '<h3 style="font-size:12.5px;">Deductions</h3>'+
        lines.map(function(d){ return '<div class="field-row"><span class="k">'+esc(d.label)+'</span><span class="v">-'+money(d.amount)+'</span></div>'; }).join('')+
        (bond ? '<div class="field-row"><span class="k" style="font-weight:650;">Final refund</span><span class="v" style="font-weight:650;">'+money(round2(bond.amountPaid - (bond.deduction || 0) - (bond.amountReturned || 0)))+'</span></div>' : '')+ // same basis as computeSettlementTotals (subtracts amount already returned)
        '<div class="field-row"><span class="k">Approved</span><span class="v">'+fullDate(settlement.approvedAt)+'</span></div></div>';
    }
    var candidates = computeCandidateDeductions(t.id);
    // Only in_progress recomputes live; a pending_approval proposal shows the FROZEN totals
    // stored on the settlement row at Calculate time (same as the admin card).
    var totals = settlement.status === 'pending_approval'
      ? { totalDeductions: settlement.totalDeductions, bondRefund: settlement.bondRefund }
      : computeSettlementTotals(bond, settlement.manualDeductions, candidates);
    var statusLabel = settlement.status === 'in_progress' ? 'Move-Out in Progress' : 'Settlement pending approval';
    return '<div class="card"><h2>My Bond</h2>'+
      '<div class="field-row"><span class="k">Status</span><span class="v">'+esc(statusLabel)+'</span></div>'+rows+
      '<h3 style="font-size:12.5px;">Deductions (estimated)</h3>'+
      (candidates.rentAmount > 0 ? '<div class="field-row"><span class="k">Rent</span><span class="v">'+money(candidates.rentAmount)+'</span></div>' : '')+
      candidates.billLines.map(function(l){ return '<div class="field-row"><span class="k">'+esc(billTypeLabel(l.billType))+'</span><span class="v">'+money(l.amount)+'</span></div>'; }).join('')+
      settlement.manualDeductions.map(function(d){ return '<div class="field-row"><span class="k">'+esc(d.description)+'</span><span class="v">'+money(d.amount)+'</span></div>'; }).join('')+
      '<div class="field-row"><span class="k">Total deductions</span><span class="v">'+money(totals.totalDeductions)+'</span></div>'+
      '<div class="field-row"><span class="k" style="font-weight:650;">Estimated refund</span><span class="v" style="font-weight:650;">'+(totals.bondRefund!=null?money(totals.bondRefund):'—')+'</span></div>'+
      '<p style="font-size:11.5px;color:var(--text-faint);margin:6px 0 0;">Pending administrator approval — this is not final.</p></div>';
  }
  function renderTenantDashboard(){
    var t = myTenantRecord();
    if (!t) return pageHeader('My Dashboard', '') + '<div class="card"><p style="font-size:13.5px;color:var(--text-dim);margin:0;">Your account isn\'t linked to a tenant record yet — ask your Super Admin.</p></div>';
    var p = propertyOf(t.propertyId);
    var r = t.roomId ? roomOf(t.roomId) : null;
    var myAllocations = [];
    bills.forEach(function(b){
      if (isTenantHiddenProvider(b.provider)) return;
      (b.allocations||[]).forEach(function(a){ if (a.tenantId===t.id) myAllocations.push({ bill:b, alloc:a }); });
    });
    var unpaidAllocations = myAllocations.filter(function(x){ return !x.alloc.paid; }).sort(function(a,b){ return (a.bill.dueDate||'').localeCompare(b.bill.dueDate||''); });
    var outstanding = unpaidAllocations.reduce(function(s,x){ return s+x.alloc.amount; }, 0);
    var outstandingBreakdown = unpaidAllocations.length === 0 ? '' :
      '<details class="outstanding-breakdown"><summary style="cursor:pointer;font-size:12.5px;color:var(--text-dim);">What this includes ('+unpaidAllocations.length+')</summary>'+
      unpaidAllocations.map(function(x){
        return '<div class="field-row" style="padding-left:12px;"><span class="k" style="font-size:12.5px;">'+esc(x.bill.provider||x.bill.billType||'Bill')+' · due '+shortDate(x.bill.dueDate)+'</span><span class="v" style="font-size:12.5px;">'+money(x.alloc.amount)+'</span></div>';
      }).join('')+
      '</details>';
    return pageHeader('My Dashboard', 'Welcome back, '+esc(t.fullName)+'.') +
      '<div class="card">'+
      '<div class="field-row"><span class="k">Property</span><span class="v">'+(p?esc(p.address||p.name):'—')+'</span></div>'+
      '<div class="field-row"><span class="k">Room</span><span class="v">'+(r?esc(r.name):'—')+'</span></div>'+
      '<div class="field-row"><span class="k">Rent</span><span class="v">'+money(t.rentAmount)+' / '+esc(t.rentFrequency)+'</span></div>'+
      '<div class="field-row"><span class="k">Outstanding bill balance</span><span class="v">'+money(outstanding)+'</span></div>'+
      outstandingBreakdown+
      '</div>'+
      tenantRentHistoryHtml(t.id) +
      renderTenantMyBondHtml(t);
  }

  function renderTenantPayments(){
    var t = myTenantRecord();
    var rows = t ? paymentRecords.filter(function(x){ return x.tenantId===t.id; }).sort(function(a,b){ return (b.date||'').localeCompare(a.date||''); }) : [];
    var body = rows.length === 0
      ? '<div class="card"><p style="font-size:13.5px;color:var(--text-dim);margin:0;">No payments recorded yet.</p></div>'
      : rows.map(function(pmt){
          return '<div class="card"><div class="field-row"><span class="k">'+shortDate(pmt.date)+'</span><span class="v">'+money(pmt.amount)+'</span></div></div>';
        }).join('');
    return pageHeader('My Payments', 'Rent payments on file. You can view these — only staff can change them.') + body;
  }

  var MONTH_NAMES_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  function monthYearLabel(ym){
    var parts = (ym||'').split('-');
    var name = MONTH_NAMES_FULL[parseInt(parts[1],10)-1] || '';
    return name + ' ' + parts[0];
  }

  async function viewTenantBillReceipt(billId, btn){
    var originalLabel = btn ? btn.textContent : '';
    if (btn){ btn.disabled = true; btn.textContent = 'Opening…'; }
    try {
      var url = await billService.getTenantReceiptUrl(billId);
      if (url) window.open(url, '_blank');
      else showToast('No document is attached to this bill.', 'info');
    } catch(err){
      showToast('Could not open the invoice. ' + friendlyErrorMessage(err), 'error');
    } finally {
      if (btn){ btn.disabled = false; btn.textContent = originalLabel; }
    }
  }
  window.viewTenantBillReceipt = viewTenantBillReceipt;

  /** The tenant sees the full breakdown of EACH bill (provider, total amount, their share, period,
   *  due date, whether it's paid, and the original invoice) grouped by month — most recent to
   *  oldest — so it's easy to find "the one from such-and-such month" instead of a flat list. They only
   *  see their own allocation row (bill_allocations RLS already limits it to that) — not what the
   *  other tenants in the house paid or owe. */
  /** Whether "bill ÷ totalOccupancyFactor × occupancyFactor" actually reconstructs the stored
   *  amount for this allocation row. It only does when every present-that-period tenant has a
   *  row (no exclusions, no one moving in/out mid-period changing the day-by-day mix) AND the
   *  amount wasn't hand-edited after picking the Occupancy method — both real possibilities the
   *  simple flat formula doesn't represent (day-prorated computeOccupancyFactorAllocationRows
   *  can legitimately produce a different amount per tenant than that single ratio implies). See
   *  review finding I1/I2 on docs/superpowers/plans/2026-09-27-bill-occupancy-factor.md. */
  function occupancyFormulaMatches(bill, alloc){
    if (alloc.occupancyFactor == null || !alloc.totalOccupancyFactor) return false;
    var expected = round2(bill.amount * alloc.occupancyFactor / alloc.totalOccupancyFactor);
    return Math.abs(expected - alloc.amount) <= 0.02;
  }

  function renderTenantBills(){
    var t = myTenantRecord();
    var myAllocations = [];
    if (t){
      bills.forEach(function(b){
        if (isTenantHiddenProvider(b.provider)) return;
        (b.allocations||[]).forEach(function(a){ if (a.tenantId===t.id) myAllocations.push({ bill:b, alloc:a }); });
      });
    }
    if (!myAllocations.length){
      return pageHeader('My Bills', 'Your share of each shared bill — electricity, water, gas, internet and more.') +
        '<div class="card"><p style="font-size:13.5px;color:var(--text-dim);margin:0;">No shared bills yet.</p></div>';
    }
    var byMonth = {};
    myAllocations.forEach(function(x){
      var ym = (x.bill.billingPeriodStart || x.bill.issueDate || x.bill.dueDate || '').slice(0,7) || 'unknown';
      (byMonth[ym] = byMonth[ym] || []).push(x);
    });
    var months = Object.keys(byMonth).sort().reverse();
    var body = months.map(function(ym){
      var rowsHtml = byMonth[ym]
        .sort(function(a,b){ return (b.bill.billingPeriodStart||'').localeCompare(a.bill.billingPeriodStart||''); })
        .map(function(x){
          var b = x.bill, a = x.alloc;
          var payStatus = allocationPaymentStatus(a);
          var reportActionHtml = '';
          if (payStatus === 'unpaid' || payStatus === 'rejected'){
            reportActionHtml = '<button class="mini-btn" style="margin-top:10px;" onclick="openPaymentReportModal(\''+b.id+'\',\''+a.tenantId+'\')">I made this payment</button>';
          } else if (payStatus === 'pending_verification'){
            reportActionHtml = '<p style="font-size:12px;color:var(--text-faint);margin:10px 0 0;">Payment verification pending</p>';
          }
          var rejectionHtml = '';
          if (payStatus === 'rejected'){
            var lastReport = paymentReportsForAllocation(a.id)[0];
            rejectionHtml = '<div class="field-row"><span class="k">Payment could not be verified</span><span class="v" style="color:var(--status-overdue);">'+esc(lastReport.rejectionReason||'')+'</span></div>';
          }
          return '<div class="card">'+
            '<div class="detail-head" style="margin-top:0;align-items:center;"><h2 style="margin:0;font-size:14px;">'+esc(billTypeLabel(b.billType))+(b.provider?' — '+esc(b.provider):'')+'</h2>'+
            (a.paid ? badge('paid','Paid'+(a.paidVia==='bond_deduction' ? ' · Paid from bond' : '')) : payStatus==='pending_verification' ? badge('upcoming','Pending verification') : badge('due','Pending'))+'</div>'+
            '<div class="field-list">'+
            '<div class="field-row"><span class="k">Total bill</span><span class="v">'+money(b.amount)+'</span></div>'+
            '<div class="field-row"><span class="k">Your share</span><span class="v">'+money(a.amount)+'</span></div>'+
            '<div class="field-row"><span class="k">Period</span><span class="v">'+shortDate(b.billingPeriodStart)+' – '+shortDate(b.billingPeriodEnd)+'</span></div>'+
            (b.dueDate ? '<div class="field-row"><span class="k">Due date</span><span class="v">'+shortDate(b.dueDate)+'</span></div>' : '')+
            (a.paid && a.paidDate ? '<div class="field-row"><span class="k">Paid on</span><span class="v">'+shortDate(a.paidDate)+'</span></div>' : '')+
            rejectionHtml+
            '</div>'+
            (occupancyFormulaMatches(b, a) ?
              '<p style="font-size:11.5px;color:var(--text-faint);margin:8px 0 0;">'+
              'Property bill: '+money(b.amount)+' · Total occupancy units: '+a.totalOccupancyFactor.toFixed(1)+
              ' · Your occupancy factor: '+a.occupancyFactor.toFixed(1)+'<br>'+
              money(b.amount)+' ÷ '+a.totalOccupancyFactor.toFixed(1)+' × '+a.occupancyFactor.toFixed(1)+' = '+money(a.amount)+
              '</p>' : (a.occupancyFactor != null ?
              '<p style="font-size:11.5px;color:var(--text-faint);margin:8px 0 0;">Your occupancy factor: '+a.occupancyFactor.toFixed(1)+
              ' — prorated by the days you (and others) were at the property during this period.</p>' : ''))+
            (b.receiptPath ? '<button class="mini-btn" style="margin-top:10px;" onclick="viewTenantBillReceipt(\''+b.id+'\', this)">View invoice</button>' : '')+
            reportActionHtml+
            '</div>';
        }).join('');
      return '<h3 style="font-size:12.5px;text-transform:none;letter-spacing:0;color:var(--text-dim);margin:16px 0 8px;">'+(ym==='unknown'?'No date on file':esc(monthYearLabel(ym)))+'</h3>'+rowsHtml;
    }).join('');
    return pageHeader('My Bills', 'Your share of each shared bill — electricity, water, gas, internet and more.') + body;
  }

  /* ---------- Tenant: "I made this payment" report modal ---------- */
  var paymentReportModalTarget = null; // { allocationId, billId, tenantId }
  var paymentReportModalProofPath = null;
  function openPaymentReportModal(billId, tenantId){
    var b = billOf(billId);
    var alloc = b && b.allocations && b.allocations.find(function(a){ return a.tenantId===tenantId; });
    if (!alloc) return;
    paymentReportModalTarget = { allocationId: alloc.id, billId: billId, tenantId: tenantId };
    paymentReportModalProofPath = null;
    document.getElementById('payment-report-modal-sub').textContent = (b.provider||'') + ' • ' + money(alloc.amount);
    document.getElementById('payment-report-date').value = TODAY;
    document.getElementById('payment-report-method').value = 'bank_transfer';
    document.getElementById('payment-report-reference').value = '';
    document.getElementById('payment-report-proof-status').textContent = '';
    document.getElementById('payment-report-modal-error').hidden = true;
    document.getElementById('payment-report-modal').hidden = false;
  }
  function closePaymentReportModal(){
    document.getElementById('payment-report-modal').hidden = true;
    paymentReportModalTarget = null;
    paymentReportModalProofPath = null;
  }
  function triggerPaymentReportProofUpload(){
    document.getElementById('payment-report-proof-input').click();
  }
  async function handlePaymentReportProofFile(event){
    var file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file || !paymentReportModalTarget) return;
    try {
      var path = await storageService.uploadReceipt('report-' + paymentReportModalTarget.allocationId, file);
      paymentReportModalProofPath = path;
      document.getElementById('payment-report-proof-status').textContent = 'Proof attached ✓';
    } catch(err){
      showToast('Could not attach the proof. ' + friendlyErrorMessage(err), 'error');
    }
  }
  async function submitPaymentReport(){
    var target = paymentReportModalTarget;
    var errorEl = document.getElementById('payment-report-modal-error');
    if (!target) return;
    var paymentDate = document.getElementById('payment-report-date').value || null;
    var paymentMethod = document.getElementById('payment-report-method').value || null;
    var reference = document.getElementById('payment-report-reference').value.trim() || null;
    try {
      var created = await paymentReportService.create({
        allocationId: target.allocationId,
        billId: target.billId,
        tenantId: target.tenantId,
        paymentDate: paymentDate,
        paymentMethod: paymentMethod,
        reference: reference,
        proofPath: paymentReportModalProofPath
      });
      paymentReports.unshift(created);
      closePaymentReportModal();
      showToast('Payment reported — pending verification.', 'success');
      render();
    } catch(err){
      // The DB's one-pending-report-per-allocation unique index (payment_reports_one_pending_per_alloc)
      // is what actually prevents a duplicate report — surface its violation as a friendly message
      // instead of the raw Postgres constraint error friendlyErrorMessage would otherwise return.
      if (err && /payment_reports_one_pending_per_alloc/.test(err.message || '')){
        errorEl.textContent = 'You already have a pending report for this bill — wait for it to be reviewed.';
      } else {
        errorEl.textContent = friendlyErrorMessage(err);
      }
      errorEl.hidden = false;
    }
  }
  window.openPaymentReportModal = openPaymentReportModal;
  window.closePaymentReportModal = closePaymentReportModal;
  window.triggerPaymentReportProofUpload = triggerPaymentReportProofUpload;
  window.handlePaymentReportProofFile = handlePaymentReportProofFile;
  window.submitPaymentReport = submitPaymentReport;

  /** Tenant self-upload: file input + a doc_type select limited to the two tenant-safe types
   *  ('id','other') — must match tenant_documents_tenant_insert's RLS check exactly, so no other
   *  DOC_TYPE_LABEL keys are offered here (lease/invoice/technician_report/warranty stay
   *  staff-only, added via the staff doc-modal/confirmAddDocument). */
  var TENANT_DOC_TYPES = ['id', 'other'];
  async function confirmAddTenantDocument(){
    var t = myTenantRecord();
    if (!t) return;
    var fileInput = document.getElementById('tenant-doc-file');
    var file = fileInput && fileInput.files && fileInput.files[0];
    if (!file){ showToast('Choose a file to upload.', 'error'); return; }
    var docType = document.getElementById('tenant-doc-type').value;
    var btn = document.getElementById('tenant-doc-upload-btn');
    var originalLabel = btn ? btn.textContent : '';
    if (btn){ btn.disabled = true; btn.textContent = 'Uploading…'; }
    try {
      var storagePath = await storageService.uploadDocument(t.id, file);
      var saved = await tenantDocumentService.create({ tenantId: t.id, docType: docType, storagePath: storagePath, fileName: file.name || 'document' });
      tenantDocuments.push(saved);
      var uploadedProperty = propertyOf(t.propertyId);
      var assignedAdminIds = propertyAssignments.filter(function(a){ return a.propertyId===t.propertyId; }).map(function(a){ return a.profileId; });
      var staffToNotify = allProfiles.filter(function(p){
        if (!p.isActive || !p.authUserId) return false;
        if (p.role === 'super_admin') return true;
        return p.role === 'administrator' && assignedAdminIds.indexOf(p.id) > -1;
      });
      for (var si=0; si<staffToNotify.length; si++){
        await notificationService.notify(staffToNotify[si].authUserId, 'New document uploaded',
          (t.fullName || 'A tenant') + ' uploaded a ' + (DOC_TYPE_LABEL[docType] || docType) +
          ' document' + (uploadedProperty ? ' at ' + uploadedProperty.name : '') + '.', 'tenant_documents', saved.id);
      }
      showToast('Document uploaded.', 'success');
      await refreshOperationsReadModels();
      render();
    } catch(err){
      showToast('Could not upload this document. ' + friendlyErrorMessage(err), 'error');
    } finally {
      if (btn){ btn.disabled = false; btn.textContent = originalLabel; }
    }
  }
  window.confirmAddTenantDocument = confirmAddTenantDocument;

  function renderTenantDocuments(){
    var t = myTenantRecord();
    var myDocs = t ? tenantDocuments.filter(function(d){ return d.tenantId===t.id; }) : [];
    var body = myDocs.length === 0
      ? '<div class="card"><p style="font-size:13.5px;color:var(--text-dim);margin:0;">No documents uploaded yet.</p></div>'
      : myDocs.map(function(d){
          return '<div class="card"><div class="field-row"><span class="k">'+esc(d.fileName||d.docType)+'</span>'+
            '<span class="v"><button class="text-link" onclick="viewReceipt(\'documents\',\''+d.storagePath+'\')">View</button></span></div></div>';
        }).join('');
    var uploadBox = '<div class="card" style="margin-bottom:10px;">'+
      '<div class="form-row"><label for="tenant-doc-file">File</label>'+
      '<input id="tenant-doc-file" type="file" accept="image/*,application/pdf" /></div>'+
      '<div class="form-row"><label for="tenant-doc-type">Document type</label>'+
      '<select id="tenant-doc-type">'+TENANT_DOC_TYPES.map(function(k){
        return '<option value="'+k+'">'+esc(DOC_TYPE_LABEL[k])+'</option>';
      }).join('')+'</select></div>'+
      '<button type="button" class="mini-btn primary" id="tenant-doc-upload-btn" onclick="confirmAddTenantDocument()">Upload document</button>'+
      '</div>';
    return pageHeader('My Documents', 'Your rental agreement, receipts and other files.') + uploadBox + body;
  }

  /* ============ PHASE 15 — CRUD: properties, rooms, tenants, bonds ============ */
  var crudIdSeq = 0;
  function genId(prefix){
    crudIdSeq++;
    return prefix + '-' + Date.now() + '-' + crudIdSeq;
  }

  /** Re-populates the property/tenant <select> elements that were filled in once when the page loaded. */
  function refreshStaticSelects(){
    var reviewPropertySelect = document.getElementById('review-property');
    if (reviewPropertySelect){
      var prevVal = reviewPropertySelect.value;
      reviewPropertySelect.innerHTML = properties.map(function(p){
        return '<option value="'+p.id+'">'+esc(p.name)+'</option>';
      }).join('');
      if (properties.some(function(p){ return p.id===prevVal; })) reviewPropertySelect.value = prevVal;
    }
    var recurringPropertySelect = document.getElementById('recurring-property');
    if (recurringPropertySelect){
      var prevRecVal = recurringPropertySelect.value;
      recurringPropertySelect.innerHTML = properties.map(function(p){
        return '<option value="'+p.id+'">'+esc(p.name)+'</option>';
      }).join('');
      if (properties.some(function(p){ return p.id===prevRecVal; })) recurringPropertySelect.value = prevRecVal;
    }
    var docTenantSelect = document.getElementById('doc-tenant');
    if (docTenantSelect){
      var prevTenantVal = docTenantSelect.value;
      docTenantSelect.innerHTML = tenants.filter(function(t){ return t.rentAmount>0; }).map(function(t){
        return '<option value="'+t.id+'">'+esc(t.fullName)+'</option>';
      }).join('');
      if (tenants.some(function(t){ return t.id===prevTenantVal; })) docTenantSelect.value = prevTenantVal;
    }
  }

  /* ---------- Generic confirmation modal (deleting a property/room/tenant) ---------- */
  var confirmModalAction = null;
  function openConfirmModal(title, body, action, opts){
    document.getElementById('confirm-modal-title').textContent = title;
    document.getElementById('confirm-modal-body').textContent = body;
    var errEl = document.getElementById('confirm-modal-error');
    errEl.hidden = true; errEl.textContent = '';
    var btn = document.getElementById('confirm-modal-confirm-btn');
    btn.textContent = (opts && opts.confirmLabel) || 'Confirm';
    btn.className = 'mini-btn' + (opts && opts.danger ? ' danger' : ' primary');
    confirmModalAction = action;
    document.getElementById('confirm-modal').hidden = false;
  }
  function closeConfirmModal(){
    document.getElementById('confirm-modal').hidden = true;
    confirmModalAction = null;
  }
  /** The action can return {blocked:true, message} (or a Promise of that) to show an error without closing the modal (e.g. "has rooms", or a network/server error). */
  async function runConfirmModalAction(){
    if (typeof confirmModalAction === 'function'){
      var btn = document.getElementById('confirm-modal-confirm-btn');
      var originalLabel = btn ? btn.textContent : '';
      if (btn){ btn.disabled = true; btn.textContent = 'Deleting…'; }
      try {
        var result = await confirmModalAction();
        if (result && result.blocked){
          var errEl = document.getElementById('confirm-modal-error');
          errEl.textContent = result.message;
          errEl.hidden = false;
          if (btn){ btn.disabled = false; btn.textContent = originalLabel; }
          return;
        }
      } catch(err){
        var errEl2 = document.getElementById('confirm-modal-error');
        errEl2.textContent = friendlyErrorMessage(err);
        errEl2.hidden = false;
        if (btn){ btn.disabled = false; btn.textContent = originalLabel; }
        return;
      }
    }
    closeConfirmModal();
  }
  window.closeConfirmModal = closeConfirmModal;
  window.runConfirmModalAction = runConfirmModalAction;

  /* ---------- Property form ---------- */
  var propertyModalEditId = null;
  function onPropertyPaymentMethodChange(){
    var method = document.getElementById('property-payment-method').value;
    document.getElementById('property-bpay-fields').hidden = method !== 'bpay';
    document.getElementById('property-bank-fields').hidden = method !== 'bank_transfer';
  }
  window.onPropertyPaymentMethodChange = onPropertyPaymentMethodChange;

  // The day of the month (1-31) only makes sense when the payment to the real estate is monthly —
  // if it's fortnightly, the next due date is computed from last_lease_payment_date + 14.
  function onPropertyLeaseFrequencyChange(){
    var freq = document.getElementById('property-lease-frequency').value;
    document.getElementById('property-lease-day-row').hidden = freq === 'fortnightly';
  }
  window.onPropertyLeaseFrequencyChange = onPropertyLeaseFrequencyChange;

  function onPropertyParkingChange(){
    var checked = document.getElementById('property-has-parking').checked;
    document.getElementById('property-parking-fields').hidden = !checked;
  }
  window.onPropertyParkingChange = onPropertyParkingChange;

  function openPropertyModal(propertyId){
    propertyModalEditId = propertyId || null;
    var p = propertyId ? propertyOf(propertyId) : null;
    document.getElementById('property-modal-title').textContent = p ? 'Edit property' : 'Add property';
    document.getElementById('property-name').value = p ? p.name : '';
    document.getElementById('property-address').value = p ? p.address : '';
    document.getElementById('property-bedrooms').value = p ? p.bedrooms : '';
    document.getElementById('property-bathrooms').value = p ? p.bathrooms : '';
    document.getElementById('property-notes').value = p ? (p.notes||'') : '';
    document.getElementById('property-whatsapp-group').value = p ? (p.whatsappGroupLink||'') : '';
    document.getElementById('property-bin-duty-required').checked = p ? (p.binDutyRequired !== false) : true;
    var parkingTenantSelect = document.getElementById('property-parking-tenant');
    var propertyTenants = p ? roomsOf(p.id).map(function(r){ return currentTenantOf(r.id); }).filter(Boolean) : [];
    parkingTenantSelect.innerHTML = '<option value="">— Not charged to anyone —</option>' +
      propertyTenants.map(function(t){ return '<option value="'+t.id+'">'+esc(t.fullName)+'</option>'; }).join('');
    document.getElementById('property-has-parking').checked = !!(p && p.hasParking);
    document.getElementById('property-parking-cost').value = (p && p.parkingCost != null) ? p.parkingCost : '';
    parkingTenantSelect.value = (p && p.parkingTenantId) ? p.parkingTenantId : '';
    onPropertyParkingChange();
    document.getElementById('property-lease-frequency').value = (p && p.leasePaymentFrequency==='fortnightly') ? 'fortnightly' : 'monthly';
    document.getElementById('property-lease-day').value = (p && p.leasePaymentDay) ? p.leasePaymentDay : '';
    document.getElementById('property-lease-amount').value = (p && p.leasePaymentAmount != null) ? p.leasePaymentAmount : '';
    document.getElementById('property-lease-end').value = (p && p.leaseEndDate) ? p.leaseEndDate : '';
    document.getElementById('property-inspection-date').value = (p && p.nextInspectionDate) ? p.nextInspectionDate : '';
    document.getElementById('property-payment-method').value = (p && p.leasePaymentMethod) ? p.leasePaymentMethod : '';
    document.getElementById('property-bpay-biller').value = p ? (p.bpayBillerCode||'') : '';
    document.getElementById('property-bpay-reference').value = p ? (p.bpayReference||'') : '';
    document.getElementById('property-bank-name').value = p ? (p.bankAccountName||'') : '';
    document.getElementById('property-bank-bsb').value = p ? (p.bankBsb||'') : '';
    document.getElementById('property-bank-account').value = p ? (p.bankAccountNumber||'') : '';
    onPropertyPaymentMethodChange();
    onPropertyLeaseFrequencyChange();
    document.getElementById('property-modal-error').hidden = true;
    document.getElementById('property-modal').hidden = false;
  }
  function closePropertyModal(){
    document.getElementById('property-modal').hidden = true;
    propertyModalEditId = null;
  }
  async function savePropertyForm(){
    var name = document.getElementById('property-name').value.trim();
    var address = document.getElementById('property-address').value.trim();
    var bedrooms = parseInt(document.getElementById('property-bedrooms').value, 10);
    var bathrooms = parseInt(document.getElementById('property-bathrooms').value, 10);
    var notes = document.getElementById('property-notes').value.trim();
    var whatsappGroupLink = document.getElementById('property-whatsapp-group').value.trim();
    var binDutyRequired = document.getElementById('property-bin-duty-required').checked;
    var hasParking = document.getElementById('property-has-parking').checked;
    var parkingCostRaw = document.getElementById('property-parking-cost').value;
    var parkingCost = parkingCostRaw ? parseFloat(parkingCostRaw) : null;
    var parkingTenantId = document.getElementById('property-parking-tenant').value || null;
    var errorEl = document.getElementById('property-modal-error');
    if (!name || !address || !isFinite(bedrooms) || bedrooms<0 || !isFinite(bathrooms) || bathrooms<0){
      errorEl.textContent = 'Add a name, address, and bedrooms/bathrooms as whole numbers of 0 or more.';
      errorEl.hidden = false;
      return;
    }
    if (whatsappGroupLink && whatsappGroupLink.indexOf('chat.whatsapp.com') === -1){
      errorEl.textContent = 'The WhatsApp group link should look like https://chat.whatsapp.com/... — copy it from the group\'s "Invite to group via link" option.';
      errorEl.hidden = false;
      return;
    }
    if (hasParking && parkingCostRaw && (!isFinite(parkingCost) || parkingCost < 0)){
      errorEl.textContent = 'The parking cost must be a valid number of 0 or more.';
      errorEl.hidden = false;
      return;
    }

    // All these fields are optional (a property may not have a lease of its own between the
    // admin and a real estate) — they're only validated if the admin started filling them in.
    var leasePaymentFrequency = document.getElementById('property-lease-frequency').value === 'fortnightly' ? 'fortnightly' : 'monthly';
    var leaseDayRaw = document.getElementById('property-lease-day').value;
    var leasePaymentDay = (leaseDayRaw && leasePaymentFrequency==='monthly') ? parseInt(leaseDayRaw, 10) : null;
    var leaseAmountRaw = document.getElementById('property-lease-amount').value;
    var leasePaymentAmount = leaseAmountRaw ? parseFloat(leaseAmountRaw) : null;
    var leaseEndDate = document.getElementById('property-lease-end').value || null;
    var nextInspectionDate = document.getElementById('property-inspection-date').value || null;
    var leasePaymentMethod = document.getElementById('property-payment-method').value || null;
    var bpayBillerCode = document.getElementById('property-bpay-biller').value.trim();
    var bpayReference = document.getElementById('property-bpay-reference').value.trim();
    var bankAccountName = document.getElementById('property-bank-name').value.trim();
    var bankBsb = document.getElementById('property-bank-bsb').value.trim();
    var bankAccountNumber = document.getElementById('property-bank-account').value.trim();

    if (leasePaymentFrequency === 'monthly' && leaseDayRaw && (!isFinite(leasePaymentDay) || leasePaymentDay < 1 || leasePaymentDay > 31)){
      errorEl.textContent = 'The rent payment day must be a number from 1 to 31.';
      errorEl.hidden = false;
      return;
    }
    if (leaseAmountRaw && (!isFinite(leasePaymentAmount) || leasePaymentAmount <= 0)){
      errorEl.textContent = "The lease amount to pay must be a valid number greater than 0.";
      errorEl.hidden = false;
      return;
    }
    if (leasePaymentMethod === 'bpay' && (!bpayBillerCode || !bpayReference)){
      errorEl.textContent = 'Add the BPay biller code and reference number, or switch the payment method.';
      errorEl.hidden = false;
      return;
    }
    if (leasePaymentMethod === 'bank_transfer' && (!bankAccountName || !bankBsb || !bankAccountNumber)){
      errorEl.textContent = 'Add the account name, BSB and account number, or switch the payment method.';
      errorEl.hidden = false;
      return;
    }

    var saveBtn = document.querySelector('#property-modal .mini-btn.primary');
    var originalLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    errorEl.hidden = true;
    try {
      var existingForEdit = propertyModalEditId ? propertyOf(propertyModalEditId) : null;
      var draft = { name:name, address:address, bedrooms:bedrooms, bathrooms:bathrooms, notes:notes,
        whatsappGroupLink:whatsappGroupLink, binDutyRequired:binDutyRequired,
        hasParking:hasParking, parkingCost:hasParking?parkingCost:null, parkingTenantId:hasParking?parkingTenantId:null,
        leasePaymentDay:leasePaymentDay, leasePaymentAmount:leasePaymentAmount, leaseEndDate:leaseEndDate,
        leasePaymentFrequency:leasePaymentFrequency, nextInspectionDate:nextInspectionDate,
        // last_lease_payment_date is only changed via the "Mark lease payment as paid" button —
        // this form doesn't touch it, so the value it already had is preserved.
        lastLeasePaymentDate: existingForEdit ? existingForEdit.lastLeasePaymentDate : null,
        leasePaymentMethod:leasePaymentMethod,
        bpayBillerCode: leasePaymentMethod==='bpay' ? bpayBillerCode : '',
        bpayReference: leasePaymentMethod==='bpay' ? bpayReference : '',
        bankAccountName: leasePaymentMethod==='bank_transfer' ? bankAccountName : '',
        bankBsb: leasePaymentMethod==='bank_transfer' ? bankBsb : '',
        bankAccountNumber: leasePaymentMethod==='bank_transfer' ? bankAccountNumber : '' };
      if (propertyModalEditId){
        var existing = propertyOf(propertyModalEditId);
        var saved = await propertyService.update(propertyModalEditId, draft);
        Object.assign(existing, saved);
      } else {
        var created = await propertyService.create(draft);
        properties.push(created);
      }
      refreshStaticSelects();
      closePropertyModal();
      showToast('Property saved successfully.', 'success');
      render();
    } catch(err){
      errorEl.textContent = 'Could not save this property. ' + friendlyErrorMessage(err);
      errorEl.hidden = false;
    } finally {
      if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = originalLabel; }
    }
  }
  function deletePropertyConfirm(propertyId){
    var p = propertyOf(propertyId);
    if (!p) return;
    openConfirmModal('Delete property', 'Delete "'+p.name+'"? This cannot be undone.', async function(){
      var propRooms = roomsOf(propertyId);
      if (propRooms.length > 0){
        return { blocked:true, message:'This property still has '+propRooms.length+' room(s). Delete those first.' };
      }
      await propertyService.remove(propertyId);
      properties = properties.filter(function(x){ return x.id!==propertyId; });
      refreshStaticSelects();
      location.hash = '#/properties';
      showToast('Property deleted.', 'success');
      render();
    }, { confirmLabel:'Delete', danger:true });
  }
  window.openPropertyModal = openPropertyModal;
  window.closePropertyModal = closePropertyModal;
  window.savePropertyForm = savePropertyForm;
  window.deletePropertyConfirm = deletePropertyConfirm;

  /* ---------- Room form ---------- */
  var roomModalEditId = null;
  var roomModalPropertyId = null;
  var includedBillModalRoomId = null;
  var includedBillModalEditId = null; // null = adding a new entry
  function openRoomModal(propertyId, roomId){
    roomModalPropertyId = propertyId;
    roomModalEditId = roomId || null;
    var r = roomId ? rooms.find(function(x){ return x.id===roomId; }) : null;
    document.getElementById('room-modal-title').textContent = r ? 'Edit room' : 'Add room';
    document.getElementById('room-name').value = r ? r.name : '';
    document.getElementById('room-modal-error').hidden = true;
    var roomModalEl = document.getElementById('room-modal');
    // Stack above another already-open modal (e.g. quickAddRoomFromTenantForm opens
    // this on top of #tenant-modal) — both share the same base z-index in source
    // order, so without this the modal opened first would still paint on top.
    var tenantModalOpen = document.getElementById('tenant-modal') && !document.getElementById('tenant-modal').hidden;
    roomModalEl.style.zIndex = tenantModalOpen ? '60' : '';
    roomModalEl.hidden = false;
  }
  function closeRoomModal(){
    var roomModalEl = document.getElementById('room-modal');
    roomModalEl.hidden = true;
    roomModalEl.style.zIndex = '';
    roomModalEditId = null; roomModalPropertyId = null;
  }
  async function saveRoomForm(){
    var name = document.getElementById('room-name').value.trim();
    var errorEl = document.getElementById('room-modal-error');
    if (!name){
      errorEl.textContent = 'Room name is required.';
      errorEl.hidden = false;
      return;
    }
    var saveBtn = document.querySelector('#room-modal .mini-btn.primary');
    var originalLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    errorEl.hidden = true;
    try {
      if (roomModalEditId){
        var r = rooms.find(function(x){ return x.id===roomModalEditId; });
        var saved = await roomService.update(roomModalEditId, { name:name });
        if (r) Object.assign(r, saved);
      } else {
        var created = await roomService.create({ propertyId: roomModalPropertyId, name: name });
        rooms.push(created);
      }
      closeRoomModal();
      showToast('Room saved successfully.', 'success');
      // If "Add tenant" was left open underneath (quickAddRoomFromTenantForm), refresh its
      // Room dropdown in place and select the new room, instead of losing that in-progress form.
      var tenantModalEl = document.getElementById('tenant-modal');
      var tenantPropertySelect = document.getElementById('tenant-property');
      if (tenantModalEl && !tenantModalEl.hidden && tenantPropertySelect && created && tenantPropertySelect.value === created.propertyId){
        document.getElementById('tenant-room').innerHTML = tenantRoomOptionsHtml(created.propertyId, created.id);
      } else {
        render();
      }
    } catch(err){
      errorEl.textContent = 'Could not save this room. ' + friendlyErrorMessage(err);
      errorEl.hidden = false;
    } finally {
      if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = originalLabel; }
    }
  }
  function deleteRoomConfirm(roomId){
    var r = rooms.find(function(x){ return x.id===roomId; });
    if (!r) return;
    openConfirmModal('Delete room', 'Delete "'+r.name+'"? This cannot be undone.', async function(){
      var occupied = tenants.some(function(t){ return t.roomId===roomId; });
      if (occupied){
        return { blocked:true, message:'This room has a tenant assigned. Move or delete that tenant first.' };
      }
      await roomService.remove(roomId);
      rooms = rooms.filter(function(x){ return x.id!==roomId; });
      showToast('Room deleted.', 'success');
      render();
    }, { confirmLabel:'Delete', danger:true });
  }
  window.openRoomModal = openRoomModal;
  window.closeRoomModal = closeRoomModal;
  window.saveRoomForm = saveRoomForm;
  window.deleteRoomConfirm = deleteRoomConfirm;

  /* ---------- Included bill form ---------- */
  function openIncludedBillModal(roomId, entryId){
    includedBillModalRoomId = roomId;
    includedBillModalEditId = entryId || null;
    var e = entryId ? roomIncludedBills.find(function(x){ return x.id===entryId; }) : null;
    document.getElementById('included-bill-modal-title').textContent = e ? 'Edit included bill' : 'Add included bill';
    document.getElementById('included-bill-label').value = e ? e.label : '';
    document.getElementById('included-bill-amount').value = e ? e.amount : '';
    document.getElementById('included-bill-frequency').value = e ? e.frequency : 'weekly';
    document.getElementById('included-bill-start').value = e ? e.startDate : TODAY;
    document.getElementById('included-bill-end').value = e ? (e.endDate || '') : '';
    document.getElementById('included-bill-modal-error').hidden = true;
    document.getElementById('included-bill-modal').hidden = false;
  }
  function closeIncludedBillModal(){
    document.getElementById('included-bill-modal').hidden = true;
    includedBillModalRoomId = null;
    includedBillModalEditId = null;
  }
  async function saveIncludedBillForm(){
    var label = document.getElementById('included-bill-label').value.trim();
    var amountRaw = document.getElementById('included-bill-amount').value;
    var amount = parseFloat(amountRaw);
    var frequency = document.getElementById('included-bill-frequency').value;
    var startDate = document.getElementById('included-bill-start').value;
    var endDate = document.getElementById('included-bill-end').value || null;
    var errorEl = document.getElementById('included-bill-modal-error');
    if (!label){ errorEl.textContent = 'Label is required.'; errorEl.hidden = false; return; }
    if (!amountRaw || !isFinite(amount) || amount <= 0){ errorEl.textContent = 'Enter an amount greater than 0.'; errorEl.hidden = false; return; }
    if (!startDate){ errorEl.textContent = 'Start date is required.'; errorEl.hidden = false; return; }
    if (endDate && endDate < startDate){ errorEl.textContent = 'End date cannot be before the start date.'; errorEl.hidden = false; return; }
    var saveBtn = document.querySelector('#included-bill-modal .mini-btn.primary');
    var originalLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    errorEl.hidden = true;
    try {
      var payload = { roomId: includedBillModalRoomId, label: label, amount: amount, frequency: frequency, startDate: startDate, endDate: endDate };
      if (includedBillModalEditId){
        var saved = await roomIncludedBillService.update(includedBillModalEditId, payload);
        var idx = roomIncludedBills.findIndex(function(x){ return x.id===includedBillModalEditId; });
        if (idx > -1) roomIncludedBills[idx] = saved;
      } else {
        var created = await roomIncludedBillService.create(payload);
        roomIncludedBills.push(created);
      }
      closeIncludedBillModal();
      showToast('Included bill saved.', 'success');
      renderPreservingScroll();
    } catch(err){
      errorEl.textContent = 'Could not save this included bill. ' + friendlyErrorMessage(err);
      errorEl.hidden = false;
    } finally {
      if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = originalLabel; }
    }
  }
  /** Ends an arrangement as of today rather than deleting it, so past profit
   *  figures that relied on it stay explainable (see plan Task 5, Step 4). */
  async function endIncludedBill(entryId){
    var e = roomIncludedBills.find(function(x){ return x.id===entryId; });
    if (!e) return;
    var newEndDate = stepDateIso(TODAY, -1);
    if (newEndDate < e.startDate){
      showToast('This bill started today, so it can\'t be ended today — delete it instead if it was added by mistake.', 'error');
      return;
    }
    try {
      var saved = await roomIncludedBillService.update(entryId, Object.assign({}, e, { endDate: newEndDate }));
      var idx = roomIncludedBills.findIndex(function(x){ return x.id===entryId; });
      if (idx > -1) roomIncludedBills[idx] = saved;
      showToast('Included bill ended.', 'success');
      renderPreservingScroll();
    } catch(err){
      showToast('Could not end this included bill. ' + friendlyErrorMessage(err), 'error');
    }
  }
  function deleteIncludedBillConfirm(entryId){
    var e = roomIncludedBills.find(function(x){ return x.id===entryId; });
    if (!e) return;
    openConfirmModal('Delete included bill', 'Delete "'+e.label+'"? This cannot be undone — if this bill just stopped applying, use "End" instead so past profit figures stay explainable.', async function(){
      await roomIncludedBillService.remove(entryId);
      roomIncludedBills = roomIncludedBills.filter(function(x){ return x.id!==entryId; });
      showToast('Included bill deleted.', 'success');
      renderPreservingScroll();
    }, { confirmLabel:'Delete', danger:true });
  }
  window.openIncludedBillModal = openIncludedBillModal;
  window.closeIncludedBillModal = closeIncludedBillModal;
  window.saveIncludedBillForm = saveIncludedBillForm;
  window.endIncludedBill = endIncludedBill;
  window.deleteIncludedBillConfirm = deleteIncludedBillConfirm;

  /** A room row with edit/delete actions (only in Property detail; the Properties list doesn't have them). */
  function roomLine(r, propertyId){
    var t = currentTenantOf(r.id);
    var isPaying = t && t.rentAmount>0;
    var tenantLabel = isPaying
      ? esc(t.fullName)+' · $'+t.rentAmount+'/'+(t.rentFrequency==='weekly'?'week':t.rentFrequency)
      : (t ? esc(t.fullName) : 'Vacant');
    var inner = '<span class="rname">'+esc(r.name)+'</span><span class="rtenant">'+tenantLabel+'</span>';
    var linkOrDiv = isPaying
      ? '<a class="room-row linked" href="#/tenants/'+t.id+'">'+inner+'</a>'
      : '<div class="room-row">'+inner+'</div>';
    var hasAnyTenant = !!t;
    return '<div class="room-line">'+linkOrDiv+
      '<button type="button" class="icon-mini-btn" title="Room activity" '+
      'onclick="event.preventDefault();event.stopPropagation();openRoomActivityModal(\''+r.id+'\')">🕘</button>'+
      '<button type="button" class="icon-mini-btn" title="Edit room" '+
      'onclick="event.preventDefault();event.stopPropagation();openRoomModal(\''+propertyId+'\',\''+r.id+'\')">✎</button>'+
      (isSuperAdmin() ? '<button type="button" class="icon-mini-btn danger" title="Delete room"'+(hasAnyTenant?' disabled':'')+' '+
      'onclick="event.preventDefault();event.stopPropagation();deleteRoomConfirm(\''+r.id+'\')">✕</button>' : '')+
      '</div>';
  }

  /* ---------- Tenant form ---------- */
  var tenantModalEditId = null;
  function tenantPropertyOptionsHtml(selectedId){
    return properties.map(function(p){
      return '<option value="'+p.id+'"'+(p.id===selectedId?' selected':'')+'>'+esc(p.name)+'</option>';
    }).join('');
  }
  function tenantRoomOptionsHtml(propertyId, selectedRoomId){
    var propRooms = roomsOf(propertyId);
    if (propRooms.length===0) return '<option value="">No rooms — add one first</option>';
    return propRooms.map(function(r){
      return '<option value="'+r.id+'"'+(r.id===selectedRoomId?' selected':'')+'>'+esc(r.name)+'</option>';
    }).join('');
  }
  function onTenantPropertyChange(){
    var propertyId = document.getElementById('tenant-property').value;
    document.getElementById('tenant-room').innerHTML = tenantRoomOptionsHtml(propertyId, null);
  }
  /** Lets the user add a room without leaving the "Add tenant" form — opens the Room
   *  modal on top of it for whichever property is currently selected; saveRoomForm()
   *  detects the tenant modal is still open underneath and refreshes its Room dropdown
   *  in place instead of requiring the user to back out and start over. */
  function quickAddRoomFromTenantForm(){
    var propertyId = document.getElementById('tenant-property').value;
    if (!propertyId) return;
    openRoomModal(propertyId);
  }
  window.quickAddRoomFromTenantForm = quickAddRoomFromTenantForm;
  function paymentDayOptionsHtml(frequency, selected){
    var opts = '', d;
    if (frequency==='monthly'){
      for (d=1; d<=31; d++){ opts += '<option value="'+d+'"'+(d===selected?' selected':'')+'>Day '+d+'</option>'; }
      return opts;
    }
    var days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    return days.map(function(dayName, idx){
      return '<option value="'+idx+'"'+(idx===selected?' selected':'')+'>'+dayName+'</option>';
    }).join('');
  }
  function onTenantFrequencyChange(){
    var freq = document.getElementById('tenant-rent-frequency').value;
    document.getElementById('tenant-payment-day').innerHTML = paymentDayOptionsHtml(freq, freq==='monthly'?1:1);
  }
  function openTenantModal(tenantId, opts){
    tenantModalEditId = tenantId || null;
    var t = tenantId ? tenantOf(tenantId) : null;
    document.getElementById('tenant-modal-title').textContent = t ? 'Edit tenant' : 'Add tenant';
    document.getElementById('tenant-fullname').value = t ? t.fullName : '';
    document.getElementById('tenant-phone').value = t ? (t.phone||'') : '';
    document.getElementById('tenant-email').value = t ? (t.email||'') : '';
    var defaultPropertyId = t ? t.propertyId : ((opts && opts.propertyId) || (properties[0] && properties[0].id) || '');
    document.getElementById('tenant-property').innerHTML = tenantPropertyOptionsHtml(defaultPropertyId);
    document.getElementById('tenant-room').innerHTML = tenantRoomOptionsHtml(defaultPropertyId, t ? t.roomId : null);
    document.getElementById('tenant-movein').value = t ? t.moveInDate : TODAY;
    document.getElementById('tenant-moveout-expected').value = (t && t.expectedMoveOutDate) ? t.expectedMoveOutDate : '';
    document.getElementById('tenant-moveout-actual').value = (t && t.actualMoveOutDate) ? t.actualMoveOutDate : '';
    document.getElementById('tenant-rent-amount').value = t ? t.rentAmount : '';
    document.getElementById('tenant-rent-frequency').value = t ? t.rentFrequency : 'weekly';
    document.getElementById('tenant-payment-day').innerHTML = paymentDayOptionsHtml(t ? t.rentFrequency : 'weekly', t ? t.paymentDay : 1);
    var excluded = (t && Array.isArray(t.excludedBillTypes)) ? t.excludedBillTypes : [];
    document.getElementById('tenant-excluded-billtypes').innerHTML = BILL_TYPES.map(function(bt){
      return '<label><input type="checkbox" value="'+bt+'"'+(excluded.indexOf(bt)>=0?' checked':'')+'/><span>'+esc(billTypeLabel(bt))+'</span></label>';
    }).join('');
    document.getElementById('tenant-occupancy-factor').value = (t && t.billOccupancyFactor > 0) ? t.billOccupancyFactor : 1;
    document.getElementById('tenant-notes').value = t ? (t.notes||'') : '';
    document.getElementById('tenant-modal-error').hidden = true;
    document.getElementById('tenant-modal').hidden = false;
  }
  function closeTenantModal(){
    document.getElementById('tenant-modal').hidden = true;
    tenantModalEditId = null;
  }
  async function saveTenantForm(){
    var fullName = document.getElementById('tenant-fullname').value.trim();
    var phone = document.getElementById('tenant-phone').value.trim();
    var email = document.getElementById('tenant-email').value.trim();
    var propertyId = document.getElementById('tenant-property').value;
    var roomId = document.getElementById('tenant-room').value;
    var moveInDate = document.getElementById('tenant-movein').value;
    var expectedMoveOutDate = document.getElementById('tenant-moveout-expected').value;
    var actualMoveOutDate = document.getElementById('tenant-moveout-actual').value;
    var rentAmount = parseFloat(document.getElementById('tenant-rent-amount').value);
    var rentFrequency = document.getElementById('tenant-rent-frequency').value;
    var paymentDay = parseInt(document.getElementById('tenant-payment-day').value, 10);
    var notes = document.getElementById('tenant-notes').value.trim();
    var excludedBillTypes = Array.prototype.slice.call(document.querySelectorAll('#tenant-excluded-billtypes input:checked')).map(function(el){ return el.value; });
    var billOccupancyFactor = parseFloat(document.getElementById('tenant-occupancy-factor').value);
    var errorEl = document.getElementById('tenant-modal-error');

    if (!fullName || !propertyId || !roomId || !moveInDate || !isFinite(rentAmount) || rentAmount<0 || !isFinite(paymentDay)){
      errorEl.textContent = 'Add a name, property, room, move-in date and a valid rent amount (0 or more).';
      errorEl.hidden = false;
      return;
    }
    if (!isFinite(billOccupancyFactor) || billOccupancyFactor <= 0){
      errorEl.textContent = 'Bill occupancy factor must be a number greater than 0.';
      errorEl.hidden = false;
      return;
    }
    if (email && email.indexOf('@')===-1){
      errorEl.textContent = "That email address doesn't look right.";
      errorEl.hidden = false;
      return;
    }
    if (expectedMoveOutDate && expectedMoveOutDate < moveInDate){
      errorEl.textContent = "Expected move-out can't be before the move-in date.";
      errorEl.hidden = false;
      return;
    }
    if (actualMoveOutDate && actualMoveOutDate < moveInDate){
      errorEl.textContent = "Actual move-out can't be before the move-in date.";
      errorEl.hidden = false;
      return;
    }
    var newMoveOutForCompare = actualMoveOutDate || expectedMoveOutDate || null;
    var conflict = overlappingRoomTenant(roomId, moveInDate, newMoveOutForCompare, tenantModalEditId);
    if (conflict){
      var conflictEnd = conflict.actualMoveOutDate || conflict.expectedMoveOutDate;
      errorEl.textContent = 'That room is already assigned to ' + conflict.fullName + ' from ' + shortDate(conflict.moveInDate) +
        (conflictEnd ? ' to ' + shortDate(conflictEnd) : ' (no move-out date set)') +
        ' — that overlaps with the dates you entered. Adjust the dates, or set an actual move-out date for ' + conflict.fullName + ' first.';
      errorEl.hidden = false;
      return;
    }

    var draft = { fullName:fullName, propertyId:propertyId, roomId:roomId, moveInDate:moveInDate,
      rentAmount:rentAmount, rentFrequency:rentFrequency, paymentDay:paymentDay, excludedBillTypes:excludedBillTypes,
      billOccupancyFactor:billOccupancyFactor };
    if (phone) draft.phone = phone;
    if (email) draft.email = email;
    if (expectedMoveOutDate) draft.expectedMoveOutDate = expectedMoveOutDate;
    if (actualMoveOutDate) draft.actualMoveOutDate = actualMoveOutDate;
    if (notes) draft.notes = notes;

    var saveBtn = document.querySelector('#tenant-modal .mini-btn.primary');
    var originalLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    errorEl.hidden = true;
    try {
      var tenantObj;
      if (tenantModalEditId){
        tenantObj = tenantOf(tenantModalEditId);
        var saved = await tenantService.update(tenantModalEditId, draft);
        // wipe optional fields the reference app deletes when cleared, then reapply what came back
        delete tenantObj.phone; delete tenantObj.email; delete tenantObj.expectedMoveOutDate;
        delete tenantObj.actualMoveOutDate; delete tenantObj.notes;
        Object.assign(tenantObj, saved);
      } else {
        tenantObj = await tenantService.create(draft);
        tenants.push(tenantObj);
        if (tenantObj.authUserId){
          try {
            await notificationService.notifyOnce(
              tenantObj.authUserId,
              'checkin:' + tenantObj.id,
              'Welcome — your check-in time',
              'Your check-in time is 3:00 PM. Please make sure you arrive after the designated check-in time.',
              'tenants', tenantObj.id,
              { category: 'check_in', propertyId: tenantObj.propertyId, tenantId: tenantObj.id, createdByProfileId: currentProfile ? currentProfile.id : null }
            );
          } catch(_e){ console.error('check-in notification failed', _e); }
        }
      }

      // rentService reads from rentSchedules, not directly from tenant.rentAmount/rentFrequency:
      // the tenant's schedule needs to stay in sync with what's saved here.
      var schedule = rentSchedules.find(function(s){ return s.tenantId===tenantObj.id; });
      if (rentAmount > 0){
        var scheduleDraft = { tenantId: tenantObj.id, frequency: rentFrequency, amount: rentAmount, startDate: moveInDate };
        var savedSchedule = await rentScheduleService.upsertForTenant(schedule, scheduleDraft);
        if (schedule) Object.assign(schedule, savedSchedule);
        else rentSchedules.push(savedSchedule);
      } else if (schedule){
        await rentScheduleService.remove(schedule.id);
        rentSchedules = rentSchedules.filter(function(s){ return s.tenantId!==tenantObj.id; });
      }

      recomputeRentCharges();
      refreshStaticSelects();
      closeTenantModal();
      location.hash = '#/tenants/' + tenantObj.id;

      try { await ensureCleaningDutiesUpToDate(); } catch(_e){ console.error('ensureCleaningDutiesUpToDate failed', _e); }
      try { await ensureBinDutiesUpToDate(); } catch(_e){ console.error('ensureBinDutiesUpToDate failed', _e); }
      try { await refreshOperationsReadModels(); } catch(_e){ console.error('refreshOperationsReadModels failed', _e); }

      // Move-out settlement is never automatic — see startMoveOutProcess / the "Move-Out
      // Settlement" card on the tenant page. Saving the tenant form (even with an actual
      // move-out date) never touches bills or the bond.
      showToast('Tenant saved successfully.', 'success');
      render();
    } catch(err){
      errorEl.textContent = 'Could not save this tenant. ' + friendlyErrorMessage(err);
      errorEl.hidden = false;
    } finally {
      if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = originalLabel; }
    }
  }
  function deleteTenantConfirm(tenantId){
    var t = tenantOf(tenantId);
    if (!t) return;
    openConfirmModal('Delete tenant', 'Delete "'+t.fullName+'" and their bond/rent schedule? This cannot be undone.', async function(){
      // Dependents must go first: bonds/rent_schedules/payments/bill_allocations all
      // reference tenants.id, and the tenant row can't be deleted while they still do.
      await bondService.removeByTenant(tenantId);
      bonds = bonds.filter(function(x){ return x.tenantId!==tenantId; });
      await rentScheduleService.removeByTenant(tenantId);
      rentSchedules = rentSchedules.filter(function(x){ return x.tenantId!==tenantId; });
      await paymentService.removeByTenant(tenantId);
      paymentRecords = paymentRecords.filter(function(x){ return x.tenantId!==tenantId; });
      await tenantService.remove(tenantId);
      tenants = tenants.filter(function(x){ return x.id!==tenantId; });
      recomputeRentCharges();
      refreshStaticSelects();
      location.hash = '#/tenants';
      showToast('Tenant deleted.', 'success');
      render();
    }, { confirmLabel:'Delete', danger:true });
  }
  /** Saves a tenant's new active/inactive status — doesn't delete anything, just takes them out
   *  of (or puts them back into) the list of active tenants in the Tenants tab. */
  async function setTenantActive(tenantId, isActiveValue){
    var t = tenantOf(tenantId);
    if (!t) return;
    try {
      var saved = await tenantService.update(tenantId, Object.assign({}, t, { isActive: isActiveValue }));
      tenants = tenants.map(function(x){ return x.id===saved.id ? saved : x; });
      render();
      showToast(isActiveValue ? 'Tenant reactivated.' : 'Tenant deactivated — hidden from the active tenants list.', 'success');
    } catch(err){
      showToast('Could not update the tenant. ' + friendlyErrorMessage(err), 'error');
    }
  }
  /** "Deactivate tenant" / "Reactivate tenant" button on the detail page. Reactivating is immediate. To
   *  deactivate: if the tenant has ALREADY moved out (actual move-out recorded) and doesn't owe
   *  anything on rent or bills, that's the normal case — it's just confirmed. If they don't yet
   *  have an actual move-out date, or they DO owe something, that's an inconsistency (someone
   *  still current, or who left an outstanding balance, is about to be hidden), so it's
   *  explained before letting the user confirm anyway. */
  function toggleTenantActiveConfirm(tenantId){
    var t = tenantOf(tenantId);
    if (!t) return;
    if (t.isActive === false){
      setTenantActive(tenantId, true);
      return;
    }
    var movedOut = !!(t.actualMoveOutDate && t.actualMoveOutDate <= TODAY);
    var owesNothing = tenantOwesNothing(t);
    if (movedOut && owesNothing){
      openConfirmModal('Deactivate tenant', 'Hide '+t.fullName+' from the active tenants list? Their data and rent/bill history stay saved — you can reactivate them anytime.',
        function(){ return setTenantActive(tenantId, false); }, { confirmLabel:'Deactivate' });
    } else {
      var reasons = [];
      if (!movedOut) reasons.push('doesn\'t have an actual move-out date recorded yet');
      if (!owesNothing) reasons.push('still has rent or bills pending');
      openConfirmModal('Deactivate tenant', t.fullName+' '+reasons.join(' and ')+'. Deactivating will still hide them from the active tenants list — are you sure?',
        function(){ return setTenantActive(tenantId, false); }, { confirmLabel:'Deactivate anyway', danger:true });
    }
  }
  window.toggleTenantActiveConfirm = toggleTenantActiveConfirm;
  window.onTenantPropertyChange = onTenantPropertyChange;
  window.onTenantFrequencyChange = onTenantFrequencyChange;
  window.openTenantModal = openTenantModal;
  window.closeTenantModal = closeTenantModal;
  window.saveTenantForm = saveTenantForm;
  window.deleteTenantConfirm = deleteTenantConfirm;

  /* ---------- Bond form (accessible from Tenant detail) ---------- */
  var bondModalTenantId = null;
  var bondDiscountRowSeq = 0;
  /** One row of the dynamic discounts list: a description + an amount, removable — used to build
   *  up an itemized breakdown of what's being deducted from the bond (cleaning, damage, etc.)
   *  instead of a single unlabeled number. */
  function bondDiscountRowHtml(rowId, label, amount){
    return '<div class="form-row form-row-2" id="'+rowId+'" style="align-items:flex-end;gap:8px;margin-bottom:6px;">'+
      '<div style="flex:2;"><input type="text" class="bond-discount-label" placeholder="Reason (e.g. Cleaning)" value="'+esc(label||'')+'" /></div>'+
      '<div style="flex:1;display:flex;gap:6px;align-items:center;">'+
      '<input type="number" min="0" step="0.01" class="bond-discount-amount" placeholder="0.00" value="'+(amount||amount===0?amount:'')+'" oninput="recomputeBondDiscountTotal()" style="flex:1;" />'+
      '<button type="button" class="icon-mini-btn danger" title="Remove" onclick="removeBondDiscountRow(\''+rowId+'\')">✕</button>'+
      '</div></div>';
  }
  function addBondDiscountRow(label, amount){
    var rowId = 'bond-discount-row-' + (++bondDiscountRowSeq);
    var container = document.getElementById('bond-discount-rows');
    container.insertAdjacentHTML('beforeend', bondDiscountRowHtml(rowId, label, amount));
    recomputeBondDiscountTotal();
  }
  window.addBondDiscountRow = addBondDiscountRow;
  function removeBondDiscountRow(rowId){
    var row = document.getElementById(rowId);
    if (row) row.remove();
    recomputeBondDiscountTotal();
  }
  window.removeBondDiscountRow = removeBondDiscountRow;
  function readBondDiscountRows(){
    var rows = document.querySelectorAll('#bond-discount-rows > div');
    var discounts = [];
    rows.forEach(function(row){
      var label = row.querySelector('.bond-discount-label').value.trim();
      var amount = parseFloat(row.querySelector('.bond-discount-amount').value);
      if (!isFinite(amount) || amount <= 0) return; // skip empty/blank rows rather than erroring
      discounts.push({ label: label || 'Discount', amount: round2(amount) });
    });
    return discounts;
  }
  function recomputeBondDiscountTotal(){
    var discounts = readBondDiscountRows();
    var total = round2(discounts.reduce(function(s,d){ return s+d.amount; }, 0));
    document.getElementById('bond-deduction-total').value = total;
    document.getElementById('bond-discount-empty').hidden = document.querySelectorAll('#bond-discount-rows > div').length > 0;
  }
  window.recomputeBondDiscountTotal = recomputeBondDiscountTotal;

  function openBondModal(tenantId){
    bondModalTenantId = tenantId;
    var b = bondOf(tenantId);
    document.getElementById('bond-modal-title').textContent = b ? 'Edit bond' : 'Add bond';
    document.getElementById('bond-required').value = b ? b.amountRequired : '';
    document.getElementById('bond-paid').value = b ? b.amountPaid : 0;
    document.getElementById('bond-returned').value = b ? b.amountReturned : 0;
    document.getElementById('bond-status').value = b ? b.status : 'pending';
    document.getElementById('bond-discount-rows').innerHTML = '';
    var existingDiscounts = (b && b.discounts && b.discounts.length) ? b.discounts
      : (b && b.deduction > 0 ? [{ label:'Deduction', amount:b.deduction }] : []); // migrate an old single-number deduction into the list, the first time it's opened
    existingDiscounts.forEach(function(d){ addBondDiscountRow(d.label, d.amount); });
    recomputeBondDiscountTotal();
    document.getElementById('bond-modal-error').hidden = true;
    document.getElementById('bond-modal').hidden = false;
  }
  function closeBondModal(){
    document.getElementById('bond-modal').hidden = true;
    bondModalTenantId = null;
  }
  async function saveBondForm(){
    var required = parseFloat(document.getElementById('bond-required').value);
    var paid = parseFloat(document.getElementById('bond-paid').value);
    var returned = parseFloat(document.getElementById('bond-returned').value);
    var discounts = readBondDiscountRows();
    var deduction = round2(discounts.reduce(function(s,d){ return s+d.amount; }, 0));
    if (!isFinite(paid)) paid = 0;
    if (!isFinite(returned)) returned = 0;
    var status = document.getElementById('bond-status').value;
    var errorEl = document.getElementById('bond-modal-error');
    if (!isFinite(required) || required<0 || !isFinite(paid) || paid<0 || returned<0){
      errorEl.textContent = 'All amounts must be 0 or more.';
      errorEl.hidden = false;
      return;
    }
    var draft = { tenantId: bondModalTenantId, amountRequired:required, amountPaid:paid, amountReturned:returned, deduction:deduction, discounts:discounts, status:status };
    var saveBtn = document.querySelector('#bond-modal .mini-btn.primary');
    var originalLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    errorEl.hidden = true;
    try {
      var existing = bondOf(bondModalTenantId);
      if (existing){
        var saved = await bondService.update(existing.id, draft);
        Object.assign(existing, saved);
      } else {
        bonds.push(await bondService.create(draft));
      }
      // Review Focus item 5: if this tenant has a COMPLETED move-out settlement, log this edit
      // to its (otherwise locked) timeline instead of silently letting the correction go
      // unrecorded — appendTimelineEntry only ever writes the timeline column, so it's exempt
      // from the lock trigger (see move_out_settlements' prevent_settlement_edit_after_lock).
      var completedSettlement = moveOutSettlementOf(bondModalTenantId);
      if (completedSettlement && completedSettlement.status === 'completed'){
        try {
          await moveOutSettlementService.appendTimelineEntry(completedSettlement.id, {
            at: new Date().toISOString(), action: 'Manual bond adjustment after move-out completion.'
          });
        } catch(_e){ console.error('appendTimelineEntry failed', _e); }
      }
      closeBondModal();
      showToast('Bond saved successfully.', 'success');
      render();
    } catch(err){
      errorEl.textContent = 'Could not save this bond. ' + friendlyErrorMessage(err);
      errorEl.hidden = false;
    } finally {
      if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = originalLabel; }
    }
  }
  window.openBondModal = openBondModal;
  window.closeBondModal = closeBondModal;
  window.saveBondForm = saveBondForm;

  /* ---------- Global search (topbar) ---------- */
  function openSearchModal(){
    document.getElementById('search-modal-input').value = '';
    document.getElementById('search-modal-results').innerHTML = '';
    document.getElementById('search-modal').hidden = false;
    setTimeout(function(){ document.getElementById('search-modal-input').focus(); }, 0);
  }
  function closeSearchModal(){
    document.getElementById('search-modal').hidden = true;
  }
  function runSearch(query){
    var box = document.getElementById('search-modal-results');
    var q = query.trim().toLowerCase();
    if (!q){ box.innerHTML = ''; return; }
    var propMatches = properties.filter(function(p){
      return p.name.toLowerCase().indexOf(q) > -1 || p.address.toLowerCase().indexOf(q) > -1;
    }).map(function(p){
      return '<a class="search-result-row" href="#/properties/'+p.id+'" onclick="closeSearchModal()">'+
        '<span class="srch-icon">'+svg('building')+'</span>'+
        '<span><div class="name">'+esc(p.name)+'</div><div class="meta">'+esc(p.address)+'</div></span></a>';
    });
    var tenantMatches = tenants.filter(function(t){
      return t.fullName.toLowerCase().indexOf(q) > -1;
    }).map(function(t){
      var p = propertyOf(t.propertyId);
      return '<a class="search-result-row" href="#/tenants/'+t.id+'" onclick="closeSearchModal()">'+
        '<span class="srch-icon">'+svg('tenants')+'</span>'+
        '<span><div class="name">'+esc(t.fullName)+'</div><div class="meta">'+esc(p?p.name:'')+'</div></span></a>';
    });
    // Task dispatch mirrors Phase 0's Dashboard taskLink() category → opener mapping exactly
    // (that function is a local closure inside renderPropertyOperations and isn't reachable
    // from here, so the same dispatch logic is reproduced rather than re-derived).
    var taskMatches = (taskIndexRows||[]).filter(function(r){
      return (r.title||'').toLowerCase().indexOf(q) > -1;
    }).map(function(r){
      var opener = r.category === 'maintenance' ? 'openMaintenanceModal'
        : r.category === 'bin_out' ? 'openBinOutDetailModal'
        : 'openCleaningDetailModal';
      var p = propertyOf(r.propertyId);
      return '<a class="search-result-row" href="#" onclick="event.preventDefault();closeSearchModal();'+opener+'(\''+r.sourceId+'\')">'+
        '<span class="srch-icon">'+svg('document')+'</span>'+
        '<span><div class="name">'+(TASK_CATEGORY_ICON[r.category]||'')+' '+esc(r.title)+'</div><div class="meta">'+esc(p?p.name:'')+'</div></span></a>';
    });
    var docMatches = (tenantDocuments||[]).filter(function(d){
      return (d.fileName||'').toLowerCase().indexOf(q) > -1;
    }).map(function(d){
      var t = tenantOf(d.tenantId);
      var p = t ? propertyOf(t.propertyId) : null;
      return '<a class="search-result-row" href="#" onclick="event.preventDefault();closeSearchModal();viewReceipt(\'documents\',\''+d.storagePath+'\')">'+
        '<span class="srch-icon">'+svg('document')+'</span>'+
        '<span><div class="name">'+esc(d.fileName)+'</div><div class="meta">'+esc(p?p.name:'')+'</div></span></a>';
    });
    var all = propMatches.concat(tenantMatches).concat(taskMatches).concat(docMatches);
    box.innerHTML = all.length
      ? all.join('')
      : '<div class="search-empty">No results match "'+esc(query.trim())+'".</div>';
  }
  window.openSearchModal = openSearchModal;
  window.closeSearchModal = closeSearchModal;
  window.runSearch = runSearch;

  /** Clicking anywhere on a date field opens the calendar picker straight away (browsers only
   *  open it from the small icon by default). Delegated, so it covers every date input in the
   *  app — including ones inside modals rendered later. Typing a date still works. */
  document.addEventListener('click', function(e){
    var el = e.target;
    if (!el || el.tagName !== 'INPUT' || el.disabled || el.readOnly) return;
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (type !== 'date' && type !== 'datetime-local' && type !== 'month' && type !== 'time') return;
    if (typeof el.showPicker !== 'function') return;
    try { el.showPicker(); } catch (err) { /* picker already open or not allowed — ignore */ }
  });

  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && !document.getElementById('search-modal').hidden) closeSearchModal();
  });

  /** The four flat hashes still exist (notification deep-links, old bookmarks) and preset
   *  propertyOperationsTab to match — but only on an actual hash change. Clicking a tab
   *  (setPropertyOperationsTab) re-renders via renderPreservingScroll() without touching
   *  location.hash, so ROUTES[hash] runs again with the SAME hash; without the lastOperationsHash
   *  guard this would force propertyOperationsTab back to the hash's tab on every click,
   *  overriding whichever tab the click just selected. */
  var lastOperationsHash = null;
  function routeToOperationsTab(hash, tab){
    return function(){
      if (lastOperationsHash !== hash) propertyOperationsTab = tab;
      lastOperationsHash = hash;
      return renderPropertyOperations();
    };
  }
  var STAFF_ROUTES = {
    '#/': renderDashboard,
    '#/properties': renderProperties,
    '#/property-operations': routeToOperationsTab('#/property-operations', 'overview'),
    '#/tenants': renderTenants,
    '#/payments': renderPayments,
    '#/bills': renderBills,
    '#/maintenance': routeToOperationsTab('#/maintenance', 'maintenance'),
    '#/cleaning': routeToOperationsTab('#/cleaning', 'cleaning'),
    '#/inspection': routeToOperationsTab('#/inspection', 'inspection'),
    '#/calendar': renderCalendar,
    '#/reports': renderReports,
    '#/profits': renderProfits,
    '#/documents': routeToOperationsTab('#/documents', 'documents'),
    '#/notifications': function(){ return isTenantRole() ? renderNotifications() : renderNotificationsStaff(); },
    '#/users': renderUsers,
    '#/audit-log': renderAuditLog,
    '#/settings': renderSettings,
    '#/more': renderMore
  };
  var TENANT_ROUTES = {
    '#/': renderTenantDashboard,
    '#/payments': renderTenantPayments,
    '#/bills': renderTenantBills,
    '#/documents': renderTenantDocuments,
    '#/maintenance': renderMaintenance,
    '#/cleaning': renderCleaning,
    '#/inspection': renderInspection,
    '#/notifications': function(){ return isTenantRole() ? renderNotifications() : renderNotificationsStaff(); },
    '#/settings': renderSettings,
    '#/more': renderMore
  };
  var ROUTES = STAFF_ROUTES;

  var content = document.getElementById('content');
  function render(preserveScroll){
    var hash = location.hash || '#/';
    var propertyMatch = hash.match(/^#\/properties\/(.+)$/);
    var tenantMatch = hash.match(/^#\/tenants\/(.+)$/);
    var billMatch = hash.match(/^#\/bills\/(.+)$/);
    var html;
    // Staff-only detail pages (full edit/delete UI) — a tenant typing one of these hashes by
    // hand gets sent to their own dashboard instead of the admin view of that record.
    if ((propertyMatch || tenantMatch || billMatch) && isTenantRole()){
      location.hash = '#/';
      return;
    }
    if (propertyMatch) html = renderPropertyDetail(decodeURIComponent(propertyMatch[1])) + propertyActivityTimelineCardHtml(decodeURIComponent(propertyMatch[1]));
    else if (tenantMatch) html = renderTenantDetail(decodeURIComponent(tenantMatch[1])) + tenantActivityTimelineCardHtml(decodeURIComponent(tenantMatch[1]));
    else if (billMatch) html = renderBillDetail(decodeURIComponent(billMatch[1]));
    else html = (ROUTES[hash] || ROUTES['#/'])();
    content.innerHTML = html;
    setActiveNav(hash);
    updateNotifNavBadge();
    hydrateLazyThumbs();
    if (!preserveScroll) window.scrollTo(0,0);
  }

  /** Signed URLs for a private Storage file are short-lived — cached in memory a little under
   *  their real TTL so re-rendering the same page (e.g. after an unrelated toggle) doesn't
   *  re-request one for every thumbnail already on screen. */
  async function getCachedSignedUrl(bucket, path, ttlSeconds){
    var key = bucket + '|' + path;
    var cached = signedUrlCache[key];
    var now = Date.now();
    if (cached && cached.expiresAt > now + 5000) return cached.url;
    var url = await storageService.getSignedUrl(bucket, path, ttlSeconds || 600);
    signedUrlCache[key] = { url: url, expiresAt: now + (ttlSeconds||600)*1000 };
    return url;
  }
  /** Fills in every `<img class="lazy-thumb" data-bucket=".." data-path="..">` placeholder left
   *  by a page's HTML string with its real signed-URL image — used for cleaning photos (and
   *  anywhere else a private-bucket thumbnail needs to show up in a plain list, not a modal).
   *  Clicking any of them opens the full lightbox (see below) instead of a new browser tab. */
  function hydrateLazyThumbs(){
    document.querySelectorAll('img.lazy-thumb[data-path]').forEach(function(img){
      var bucket = img.getAttribute('data-bucket');
      var path = img.getAttribute('data-path');
      if (!bucket || !path) return;
      getCachedSignedUrl(bucket, path, 600).then(function(url){
        img.src = url;
      }).catch(function(){ /* one broken thumbnail shouldn't break the rest of the page */ });
      img.onclick = function(){ openLightboxForThumb(img); };
    });
  }

  /* ============ Image lightbox ============
   * One reusable overlay (markup lives in index.html, outside #content so render() never wipes
   * it) for every photo gallery in the app. A "gallery" is every .lazy-thumb image that shares a
   * data-group value (set by photoThumbsHtml()) — clicking one opens the lightbox positioned on
   * that image, with Previous/Next cycling through the rest of that same group. Photos rendered
   * straight into a modal (not through photoThumbsHtml/hydrateLazyThumbs) can still join in by
   * calling registerLightboxImg(imgEl, bucket, path, group, index). */
  var lightboxItems = [];   // [{bucket, path}]
  var lightboxIndex = 0;
  var lightboxRequestToken = 0; // bumped on every navigation so a slow, stale load can't clobber a newer one
  var lightboxReturnFocusTo = null;

  function registerLightboxImg(imgEl, bucket, path, groupId, index){
    imgEl.classList.add('lazy-thumb');
    imgEl.setAttribute('data-bucket', bucket);
    imgEl.setAttribute('data-path', path);
    imgEl.setAttribute('data-group', groupId);
    imgEl.setAttribute('data-index', String(index));
    imgEl.style.cursor = 'pointer';
    imgEl.onclick = function(){ openLightboxForThumb(imgEl); };
  }
  window.registerLightboxImg = registerLightboxImg;

  function lightboxCollectGroup(groupId){
    var els = Array.prototype.slice.call(document.querySelectorAll('.lazy-thumb[data-group="'+cssEscape(groupId)+'"]'));
    els.sort(function(a,b){ return (parseInt(a.getAttribute('data-index'),10)||0) - (parseInt(b.getAttribute('data-index'),10)||0); });
    return els.map(function(el){ return { bucket: el.getAttribute('data-bucket'), path: el.getAttribute('data-path') }; });
  }
  // Minimal CSS.escape fallback (older WebViews) — group ids are our own 'lbgN' strings, so this
  // only ever needs to handle plain alphanumerics, but stay defensive.
  function cssEscape(s){ return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); }

  function openLightboxForThumb(imgEl){
    var group = imgEl.getAttribute('data-group');
    var bucket = imgEl.getAttribute('data-bucket'), path = imgEl.getAttribute('data-path');
    var items = group ? lightboxCollectGroup(group) : [{ bucket:bucket, path:path }];
    var startIndex = group ? Math.max(0, parseInt(imgEl.getAttribute('data-index'),10)||0) : 0;
    if (items.length===0) items = [{ bucket:bucket, path:path }];
    openLightbox(items, startIndex);
  }

  function openLightbox(items, startIndex){
    if (!items || !items.length) return;
    lightboxItems = items;
    lightboxIndex = Math.max(0, Math.min(items.length-1, startIndex||0));
    lightboxReturnFocusTo = document.activeElement;
    var overlay = document.getElementById('lightbox-overlay');
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    renderLightboxCurrent();
    document.getElementById('lightbox-close').focus();
    document.addEventListener('keydown', lightboxKeyHandler);
  }
  window.openLightbox = openLightbox;

  function closeLightbox(){
    var overlay = document.getElementById('lightbox-overlay');
    if (overlay.hidden) return;
    overlay.hidden = true;
    document.body.style.overflow = '';
    document.removeEventListener('keydown', lightboxKeyHandler);
    lightboxItems = [];
    lightboxIndex = 0;
    lightboxRequestToken++;
    if (lightboxReturnFocusTo && typeof lightboxReturnFocusTo.focus === 'function'){
      try { lightboxReturnFocusTo.focus(); } catch(_e){ /* element may no longer be in the DOM */ }
    }
    lightboxReturnFocusTo = null;
  }
  window.closeLightbox = closeLightbox;

  var LIGHTBOX_NON_CLOSING_IDS = ['lightbox-img','lightbox-close','lightbox-prev','lightbox-next','lightbox-counter'];
  var lightboxSuppressNextClick = false; // set right after a swipe/drag navigates, so the trailing click doesn't also close the viewer
  function closeLightboxOnBackdrop(e){
    if (lightboxSuppressNextClick){ lightboxSuppressNextClick = false; return; }
    // .lightbox-content covers the whole overlay (it's what centers the image), so a click on
    // the dark area around the photo lands on #lightbox-content, #lightbox-overlay, the spinner
    // or the error message — never on the image itself or one of the controls. Closing on
    // anything but that short list is exactly "click outside the image".
    var id = e.target && e.target.id;
    if (LIGHTBOX_NON_CLOSING_IDS.indexOf(id) === -1) closeLightbox();
  }
  window.closeLightboxOnBackdrop = closeLightboxOnBackdrop;

  function lightboxPrev(){
    if (lightboxItems.length < 2) return;
    lightboxIndex = (lightboxIndex - 1 + lightboxItems.length) % lightboxItems.length;
    renderLightboxCurrent();
  }
  window.lightboxPrev = lightboxPrev;

  function lightboxNext(){
    if (lightboxItems.length < 2) return;
    lightboxIndex = (lightboxIndex + 1) % lightboxItems.length;
    renderLightboxCurrent();
  }
  window.lightboxNext = lightboxNext;

  function lightboxKeyHandler(e){
    if (e.key === 'Escape'){ e.preventDefault(); closeLightbox(); }
    else if (e.key === 'ArrowLeft'){ e.preventDefault(); lightboxPrev(); }
    else if (e.key === 'ArrowRight'){ e.preventDefault(); lightboxNext(); }
    else if (e.key === 'Tab'){
      // Simple focus trap so Tab can't escape into the page hiding behind the overlay.
      var overlay = document.getElementById('lightbox-overlay');
      var focusables = Array.prototype.slice.call(overlay.querySelectorAll('button')).filter(function(b){ return b.offsetParent !== null; });
      if (!focusables.length) return;
      var first = focusables[0], last = focusables[focusables.length-1];
      if (e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
    }
  }

  function renderLightboxCurrent(){
    var item = lightboxItems[lightboxIndex];
    if (!item) return;
    var myToken = ++lightboxRequestToken;
    var imgEl = document.getElementById('lightbox-img');
    var spinner = document.getElementById('lightbox-spinner');
    var errorEl = document.getElementById('lightbox-error');
    var counter = document.getElementById('lightbox-counter');
    var prevBtn = document.getElementById('lightbox-prev');
    var nextBtn = document.getElementById('lightbox-next');
    var multi = lightboxItems.length > 1;
    counter.textContent = multi ? (lightboxIndex+1) + ' / ' + lightboxItems.length : '';
    counter.hidden = !multi;
    prevBtn.hidden = !multi;
    nextBtn.hidden = !multi;
    imgEl.hidden = true;
    errorEl.hidden = true;
    spinner.hidden = false;
    getCachedSignedUrl(item.bucket, item.path, 600).then(function(url){
      if (myToken !== lightboxRequestToken) return; // navigated away (or closed) before this loaded
      var probe = new Image();
      probe.onload = function(){
        if (myToken !== lightboxRequestToken) return;
        spinner.hidden = true;
        imgEl.src = url;
        imgEl.alt = 'Photo ' + (lightboxIndex+1) + ' of ' + lightboxItems.length;
        imgEl.hidden = false;
      };
      probe.onerror = function(){
        if (myToken !== lightboxRequestToken) return;
        spinner.hidden = true;
        errorEl.hidden = false;
      };
      probe.src = url;
    }).catch(function(){
      if (myToken !== lightboxRequestToken) return;
      spinner.hidden = true;
      errorEl.hidden = false;
    });
    // Preload the neighbors so Previous/Next feel instant once the signed URL is already cached.
    [1,-1].forEach(function(d){
      var n = lightboxItems[(lightboxIndex + d + lightboxItems.length) % lightboxItems.length];
      if (n && n !== item) getCachedSignedUrl(n.bucket, n.path, 600).then(function(u){ var pre = new Image(); pre.src = u; }).catch(function(){});
    });
  }

  // Pointer-based swipe/drag (covers touch, mouse and pen with one code path): a horizontal
  // drag past the threshold navigates; anything smaller (or more vertical than horizontal, so a
  // vertical scroll/flick doesn't get mistaken for a swipe) is ignored.
  var lightboxPointerStartX = null, lightboxPointerStartY = null, lightboxPointerDown_ = false;
  function lightboxPointerDown(e){
    lightboxPointerDown_ = true;
    lightboxPointerStartX = e.clientX;
    lightboxPointerStartY = e.clientY;
  }
  window.lightboxPointerDown = lightboxPointerDown;
  function lightboxPointerUp(e){
    if (!lightboxPointerDown_) return;
    lightboxPointerDown_ = false;
    var dx = e.clientX - lightboxPointerStartX;
    var dy = e.clientY - lightboxPointerStartY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5){
      lightboxSuppressNextClick = true; // the browser still fires a trailing click after this pointerup
      if (dx > 0) lightboxPrev(); else lightboxNext();
    }
  }
  window.lightboxPointerUp = lightboxPointerUp;

  /* ============ PDF viewer ============
   * A real toolbar-driven viewer built on pdf.js (loaded in index.html as the global
   * `pdfjsLib`), replacing the old bare <iframe>. One reusable overlay — openPdfViewer(url,
   * fileName) opens it from anywhere a PDF is shown (currently openBillDocumentPreview).
   *
   * Layout: a continuous vertical scroll of all pages (like Drive/Acrobat), virtualized — only
   * pages near the viewport actually have pixels drawn to their <canvas> (via
   * IntersectionObserver); pages that scroll far away have their canvas cleared to free memory.
   * Each page also gets a pdf.js "text layer" (invisible, selectable text positioned exactly over
   * the canvas) built lazily on first render — this is what makes search real (matches PDF text,
   * never a fake image-based search) and gives native text selection for free.
   */
  var PDFV_MIN_SCALE = 0.25, PDFV_MAX_SCALE = 5;
  var pdfv = {
    doc: null, url: '', fileName: '', numPages: 0, currentPage: 1,
    scale: 1, baseWidth: 0, baseHeight: 0, rotation: 0, fitMode: 'width',
    pages: [], visiblePages: new Set(), observer: null,
    thumbEls: null, thumbsBuilt: false, thumbsOpen: false, thumbObserver: null,
    searchOpen: false, searchQuery: '', searchMatches: [], searchIndex: -1, searchGen: 0,
    pageTextCache: {}, loadToken: 0, fullscreen: false
  };
  var pdfvReturnFocusTo = null;
  var pdfvRerenderTimer = null;
  var pdfvSearchDebounce = null;

  async function openPdfViewer(url, fileName){
    var overlay = document.getElementById('pdfv-overlay');
    if (!overlay) return;
    if (typeof pdfjsLib === 'undefined'){
      // pdf.js didn't load (CDN blocked/offline) — fall back to a plain new tab instead of
      // showing a broken, uncloseable viewer.
      window.open(url, '_blank', 'noopener');
      if (typeof showToast === 'function') showToast("Couldn't load the PDF viewer — opened the file in a new tab instead.", 'error');
      return;
    }
    pdfvReturnFocusTo = document.activeElement;
    pdfv.url = url;
    pdfv.fileName = fileName || 'document.pdf';
    pdfv.numPages = 0; pdfv.currentPage = 1; pdfv.scale = 1; pdfv.rotation = 0; pdfv.fitMode = 'width';
    pdfv.pages = []; pdfv.visiblePages = new Set(); pdfv.pageTextCache = {};
    pdfv.searchQuery = ''; pdfv.searchMatches = []; pdfv.searchIndex = -1;
    pdfv.thumbsBuilt = false; pdfv.thumbsOpen = false; pdfv.thumbEls = null; pdfv.doc = null;

    document.getElementById('pdfv-title').textContent = pdfv.fileName;
    document.getElementById('pdfv-page-of').textContent = '/ —';
    document.getElementById('pdfv-page-input').value = '';
    document.getElementById('pdfv-pages-inner').innerHTML = '';
    var thumbsPanel = document.getElementById('pdfv-thumbs');
    thumbsPanel.innerHTML = ''; thumbsPanel.hidden = true; thumbsPanel.classList.remove('open');
    var thumbsBackdrop = document.getElementById('pdfv-thumbs-backdrop');
    thumbsBackdrop.hidden = true; thumbsBackdrop.classList.remove('open');
    document.getElementById('pdfv-thumbs-toggle').setAttribute('aria-pressed', 'false');
    pdfvCloseSearch(true);
    document.getElementById('pdfv-error').hidden = true;
    document.getElementById('pdfv-loading-text').textContent = 'Loading PDF…';
    document.getElementById('pdfv-loading').hidden = false;
    document.getElementById('pdfv-zoom-pct').textContent = '100%';
    document.getElementById('pdfv-open-tab').href = url;

    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    // Defensive: remove before adding, in case a previous open's listeners were somehow never
    // cleaned up (e.g. openPdfViewer called again without an intervening close) — keeps these
    // singular instead of silently stacking duplicate handlers.
    document.removeEventListener('keydown', pdfvKeyHandler);
    document.addEventListener('keydown', pdfvKeyHandler);
    var scrollElForWheel = document.getElementById('pdfv-pages-scroll');
    scrollElForWheel.removeEventListener('wheel', pdfvWheelHandler);
    scrollElForWheel.addEventListener('wheel', pdfvWheelHandler, { passive: false });
    document.removeEventListener('fullscreenchange', pdfvFullscreenChangeHandler);
    document.addEventListener('fullscreenchange', pdfvFullscreenChangeHandler);
    window.removeEventListener('resize', pdfvResizeHandler);
    window.addEventListener('resize', pdfvResizeHandler);
    document.getElementById('pdfv-close').focus();

    var myToken = ++pdfv.loadToken;
    try {
      var doc = await pdfjsLib.getDocument({ url: url }).promise;
      if (myToken !== pdfv.loadToken){ try { doc.destroy(); } catch(_e){} return; }
      pdfv.doc = doc;
      pdfv.numPages = doc.numPages;
      var page1 = await doc.getPage(1);
      if (myToken !== pdfv.loadToken) return;
      var base = page1.getViewport({ scale: 1, rotation: 0 });
      pdfv.baseWidth = base.width;
      pdfv.baseHeight = base.height;
      document.getElementById('pdfv-loading').hidden = true;
      pdfvBuildPages();
      pdfv.scale = pdfvComputeFitScale('width');
      pdfv.fitMode = 'width';
      pdfvRecalcPagesLayout();
      pdfvUpdateZoomLabel();
      document.getElementById('pdfv-page-of').textContent = '/ ' + pdfv.numPages;
      document.getElementById('pdfv-page-input').value = '1';
      // One frame so the scroller has real, laid-out page heights before the observer starts
      // measuring intersections against it (otherwise the first read can be against a 0-height box).
      requestAnimationFrame(function(){ if (myToken === pdfv.loadToken) pdfvSetupObserver(); });
    } catch(err){
      if (myToken !== pdfv.loadToken) return;
      console.error('PDF load failed:', err);
      document.getElementById('pdfv-loading').hidden = true;
      var errEl = document.getElementById('pdfv-error');
      errEl.hidden = false;
      errEl.textContent = "Couldn't load this PDF. " + friendlyErrorMessage(err);
    }
  }
  window.openPdfViewer = openPdfViewer;

  function closePdfViewer(){
    var overlay = document.getElementById('pdfv-overlay');
    if (!overlay || overlay.hidden) return;
    pdfv.loadToken++; // invalidates any load/search still in flight
    pdfv.searchGen++;
    overlay.hidden = true;
    document.body.style.overflow = '';
    document.removeEventListener('keydown', pdfvKeyHandler);
    var scrollEl = document.getElementById('pdfv-pages-scroll');
    if (scrollEl) scrollEl.removeEventListener('wheel', pdfvWheelHandler);
    document.removeEventListener('fullscreenchange', pdfvFullscreenChangeHandler);
    window.removeEventListener('resize', pdfvResizeHandler);
    if (document.fullscreenElement && document.exitFullscreen){
      try { document.exitFullscreen(); } catch(_e){}
    }
    if (pdfv.observer){ pdfv.observer.disconnect(); pdfv.observer = null; }
    if (pdfv.currentPageObserver){ pdfv.currentPageObserver.disconnect(); pdfv.currentPageObserver = null; }
    if (pdfv.thumbObserver){ pdfv.thumbObserver.disconnect(); pdfv.thumbObserver = null; }
    pdfv.pages.forEach(function(entry){
      if (entry.renderTask){ try { entry.renderTask.cancel(); } catch(_e){} }
    });
    if (pdfv.doc){ try { pdfv.doc.destroy(); } catch(_e){} pdfv.doc = null; }
    pdfv.pages = [];
    var frame = document.getElementById('pdfv-print-frame');
    if (frame) frame.remove();
    document.getElementById('pdfv-pages-inner').innerHTML = '';
    document.getElementById('pdfv-thumbs').innerHTML = '';
    clearTimeout(pdfvRerenderTimer);
    clearTimeout(pdfvSearchDebounce);
    clearTimeout(pdfvResizeDebounce);
    if (pdfvReturnFocusTo && typeof pdfvReturnFocusTo.focus === 'function'){
      try { pdfvReturnFocusTo.focus(); } catch(_e){}
    }
    pdfvReturnFocusTo = null;
  }
  window.closePdfViewer = closePdfViewer;

  function pdfvBackdropClick(e){
    var t = e.target;
    // Clicking the actual page (to select text, etc.) or any toolbar/search/thumbnail control
    // must never close the viewer — only the dark area around the document counts as "outside".
    if (t.closest && (t.closest('.pdfv-page') || t.closest('.pdfv-toolbar') || t.closest('.pdfv-search-bar') || t.closest('.pdfv-thumbs'))) return;
    closePdfViewer();
  }
  window.pdfvBackdropClick = pdfvBackdropClick;

  function pdfvKeyHandler(e){
    var overlay = document.getElementById('pdfv-overlay');
    if (!overlay || overlay.hidden) return;
    var active = document.activeElement;
    var inSearchInput = active && active.id === 'pdfv-search-input';
    var inPageInput = active && active.id === 'pdfv-page-input';
    if (e.key === 'Escape'){
      e.preventDefault();
      // Layered, like a real app: fullscreen first, then search, then a mobile thumbnails
      // overlay, and only THEN the viewer itself — so "Esc to exit fullscreen" (its own listed
      // requirement) doesn't also blow away the whole viewer in one keystroke.
      if (document.fullscreenElement){
        var exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) exit.call(document);
        return;
      }
      if (pdfv.searchOpen){ pdfvCloseSearch(); return; }
      if (pdfv.thumbsOpen && window.innerWidth <= 820){ pdfvToggleThumbs(); return; }
      closePdfViewer();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')){ e.preventDefault(); pdfvOpenSearch(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')){ e.preventDefault(); pdfvSetScale(pdfv.scale * 1.2); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === '-'){ e.preventDefault(); pdfvSetScale(pdfv.scale / 1.2); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === '0'){ e.preventDefault(); pdfvSetActualSize(); return; }
    if (e.key === 'Tab'){
      var focusables = Array.prototype.slice.call(overlay.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])'))
        .filter(function(el){ return el.offsetParent !== null && !el.disabled; });
      if (!focusables.length) return;
      var first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && active === first){ e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last){ e.preventDefault(); first.focus(); }
      return;
    }
    if (inSearchInput || inPageInput) return; // let normal typing/cursor movement happen
    if (e.key === 'ArrowLeft'){ e.preventDefault(); pdfvPrevPage(); }
    else if (e.key === 'ArrowRight'){ e.preventDefault(); pdfvNextPage(); }
  }

  /* ---- pages: build, layout, render, release (virtualized) ---- */
  function pdfvBuildPages(){
    var inner = document.getElementById('pdfv-pages-inner');
    inner.innerHTML = '';
    pdfv.pages = [];
    for (var n = 1; n <= pdfv.numPages; n++){
      var container = document.createElement('div');
      container.className = 'pdfv-page';
      container.dataset.page = String(n);
      var canvas = document.createElement('canvas');
      container.appendChild(canvas);
      var spinnerWrap = document.createElement('div');
      spinnerWrap.className = 'pdfv-page-spinner-wrap';
      spinnerWrap.innerHTML = '<div class="lightbox-spinner"></div>';
      container.appendChild(spinnerWrap);
      var badge = document.createElement('div');
      badge.className = 'pdfv-page-num-badge';
      badge.textContent = String(n);
      container.appendChild(badge);
      inner.appendChild(container);
      pdfv.pages.push({
        num: n, container: container, canvas: canvas, spinnerWrap: spinnerWrap,
        gen: 0, rendered: false, rendering: false, renderTask: null, renderKey: null,
        textLayerEl: null, textDivs: null, textLayerKey: null
      });
    }
  }

  /** Sizes every page's placeholder box from the shared page-1 dimensions (the common case: a
   *  uniform page size throughout). A page whose real size turns out to differ gets corrected to
   *  its own exact size the moment it actually renders (pdfvRenderPage) — an accepted, minor,
   *  one-time layout nudge for the rare mixed-page-size document, in exchange for never having to
   *  fetch every single page's real dimensions up front (which would defeat the point of not
   *  loading a big PDF's pages all at once). */
  function pdfvRecalcPagesLayout(){
    var rotated = (pdfv.rotation % 180) !== 0;
    var w = Math.round((rotated ? pdfv.baseHeight : pdfv.baseWidth) * pdfv.scale);
    var h = Math.round((rotated ? pdfv.baseWidth : pdfv.baseHeight) * pdfv.scale);
    pdfv.pages.forEach(function(entry){
      entry.container.style.width = w + 'px';
      entry.container.style.height = h + 'px';
    });
  }

  /** Two separate observers, deliberately not one: the render/pre-load observer uses a generous
   *  600px rootMargin so nearby pages are already drawn before they scroll into view — but that
   *  same generous margin makes its intersectionRatio numbers useless for deciding which page is
   *  the "current" one (a page sitting entirely in the 600px buffer above the real viewport can
   *  register a higher ratio, against its enlarged root, than the page actually on screen). A
   *  second observer with NO margin, watching real on-screen visibility only, drives the page
   *  indicator/thumbnail-selection instead — keeping "Page X of Y" accurate while scrolling. */
  function pdfvSetupObserver(){
    if (pdfv.observer) pdfv.observer.disconnect();
    if (pdfv.currentPageObserver) pdfv.currentPageObserver.disconnect();
    var root = document.getElementById('pdfv-pages-scroll');
    pdfv.observer = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        var n = parseInt(e.target.getAttribute('data-page'), 10);
        if (e.isIntersecting){
          pdfv.visiblePages.add(n);
          pdfvRenderPage(n);
        } else {
          pdfv.visiblePages.delete(n);
          if (Math.abs(n - pdfv.currentPage) > 4) pdfvReleasePage(n);
        }
      });
    }, { root: root, rootMargin: '600px 0px 600px 0px', threshold: [0] });

    pdfv.currentPageObserver = new IntersectionObserver(function(entries){
      var bestPage = null, bestRatio = 0;
      entries.forEach(function(e){
        var n = parseInt(e.target.getAttribute('data-page'), 10);
        if (e.isIntersecting && e.intersectionRatio > bestRatio){ bestRatio = e.intersectionRatio; bestPage = n; }
      });
      if (bestPage && bestPage !== pdfv.currentPage){
        pdfv.currentPage = bestPage;
        pdfvUpdatePageIndicator();
        pdfvUpdateThumbSelection();
      }
    }, { root: root, rootMargin: '0px', threshold: [0.1, 0.25, 0.5, 0.75, 0.9] });

    pdfv.pages.forEach(function(entry){
      pdfv.observer.observe(entry.container);
      pdfv.currentPageObserver.observe(entry.container);
    });
  }

  /** Renders (or re-renders, if the scale/rotation changed since last time) one page's canvas,
   *  plus its text layer. Safe to call repeatedly — a no-op if already rendered at the current
   *  scale/rotation. Returns a promise so callers (like search, jumping to a page) can wait for it. */
  function pdfvRenderPage(n){
    var entry = pdfv.pages[n - 1];
    if (!entry) return Promise.resolve();
    var key = pdfv.scale + '@' + pdfv.rotation;
    if (entry.rendered && entry.renderKey === key) return Promise.resolve();
    if (entry.renderTask){ try { entry.renderTask.cancel(); } catch(_e){} entry.renderTask = null; }
    entry.rendering = true;
    var myGen = ++entry.gen;
    var ownerDoc = pdfv.doc;
    return pdfv.doc.getPage(n).then(function(page){
      if (myGen !== entry.gen || pdfv.doc !== ownerDoc) return;
      var viewport = page.getViewport({ scale: pdfv.scale, rotation: pdfv.rotation });
      // Correct this page's box if its real size differs from the shared placeholder assumption.
      entry.container.style.width = Math.round(viewport.width) + 'px';
      entry.container.style.height = Math.round(viewport.height) + 'px';
      var outputScale = window.devicePixelRatio || 1;
      var canvas = entry.canvas;
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = Math.floor(viewport.width) + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';
      var ctx = canvas.getContext('2d');
      var transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
      var task = page.render({ canvasContext: ctx, transform: transform, viewport: viewport });
      entry.renderTask = task;
      return task.promise.then(function(){
        if (myGen !== entry.gen) return;
        entry.renderTask = null;
        entry.rendered = true;
        entry.rendering = false;
        entry.renderKey = key;
        entry.spinnerWrap.hidden = true;
        return pdfvEnsureTextLayer(entry, page, viewport);
      });
    }).catch(function(err){
      entry.rendering = false;
      if (err && err.name === 'RenderingCancelledException') return;
      console.error('PDF page render failed (page ' + n + '):', err);
    });
  }

  function pdfvEnsureTextLayer(entry, page, viewport){
    var key = Math.round(viewport.width) + 'x' + Math.round(viewport.height) + '@' + pdfv.rotation;
    if (entry.textLayerEl && entry.textLayerKey === key) return pdfvHighlightPage(entry);
    if (entry.textLayerEl){ entry.textLayerEl.remove(); entry.textLayerEl = null; entry.textDivs = null; }
    return page.getTextContent().then(function(textContent){
      var div = document.createElement('div');
      div.className = 'textLayer';
      div.style.width = viewport.width + 'px';
      div.style.height = viewport.height + 'px';
      entry.container.appendChild(div);
      entry.textLayerEl = div;
      entry.textLayerKey = key;
      var task = pdfjsLib.renderTextLayer({ textContentSource: textContent, container: div, viewport: viewport });
      return task.promise.then(function(){
        entry.textDivs = Array.prototype.slice.call(div.querySelectorAll('span'));
        return pdfvHighlightPage(entry);
      });
    }).catch(function(err){ console.error('PDF text layer failed (page ' + entry.num + '):', err); });
  }

  /** Frees a far-away page's rendered pixels (and text layer) to keep memory bounded on large
   *  PDFs — it re-renders automatically the moment it scrolls back into range. Also cancels a
   *  page that's still MID-render when it leaves range (fast scrolling through a big PDF) —
   *  without this, a page could finish rendering (and stay fully allocated) long after nobody's
   *  looking at it, because the earlier `!entry.rendered` guard skipped it while `rendering` but
   *  not yet `rendered`. */
  function pdfvReleasePage(n){
    var entry = pdfv.pages[n - 1];
    if (!entry || (!entry.rendered && !entry.rendering)) return;
    if (entry.renderTask){ try { entry.renderTask.cancel(); } catch(_e){} entry.renderTask = null; }
    entry.canvas.width = 0;
    entry.canvas.height = 0;
    entry.rendered = false;
    entry.rendering = false;
    entry.renderKey = null;
    entry.gen++; // belt-and-suspenders: even if cancel() doesn't reject promptly, stale gen checks bail out
    if (entry.textLayerEl){ entry.textLayerEl.remove(); entry.textLayerEl = null; entry.textDivs = null; entry.textLayerKey = null; }
    entry.spinnerWrap.hidden = false;
  }

  function pdfvScheduleRerenderVisible(){
    clearTimeout(pdfvRerenderTimer);
    pdfvRerenderTimer = setTimeout(function(){
      pdfv.pages.forEach(function(entry){
        if (pdfv.visiblePages.has(entry.num) || Math.abs(entry.num - pdfv.currentPage) <= 1){
          pdfvRenderPage(entry.num);
        }
      });
    }, 180);
  }

  /* ---- page navigation ---- */
  function pdfvUpdatePageIndicator(){
    var input = document.getElementById('pdfv-page-input');
    if (input && document.activeElement !== input) input.value = String(pdfv.currentPage);
    var prevBtn = document.getElementById('pdfv-prev'), nextBtn = document.getElementById('pdfv-next');
    if (prevBtn) prevBtn.disabled = pdfv.currentPage <= 1;
    if (nextBtn) nextBtn.disabled = pdfv.currentPage >= pdfv.numPages;
  }
  function pdfvGoToPage(n){
    n = Math.max(1, Math.min(pdfv.numPages, n));
    var entry = pdfv.pages[n - 1];
    if (entry) entry.container.scrollIntoView({ block: 'start' });
    pdfv.currentPage = n;
    pdfvUpdatePageIndicator();
    pdfvUpdateThumbSelection();
    if (pdfv.thumbsOpen) pdfvScrollThumbIntoView(n);
    return pdfvRenderPage(n);
  }
  window.pdfvPrevPage = function pdfvPrevPage(){ pdfvGoToPage(pdfv.currentPage - 1); };
  window.pdfvNextPage = function pdfvNextPage(){ pdfvGoToPage(pdfv.currentPage + 1); };
  window.pdfvGoToPageInput = function pdfvGoToPageInput(){
    var input = document.getElementById('pdfv-page-input');
    var n = parseInt(input.value, 10);
    if (!n || n < 1 || n > pdfv.numPages){ input.value = String(pdfv.currentPage); return; }
    pdfvGoToPage(n);
  };
  window.pdfvPageInputKeydown = function pdfvPageInputKeydown(e){
    if (e.key === 'Enter'){ e.preventDefault(); window.pdfvGoToPageInput(); e.target.blur(); }
  };

  /* ---- zoom ---- */
  function pdfvComputeFitScale(mode){
    var scrollEl = document.getElementById('pdfv-pages-scroll');
    var availW = Math.max(50, scrollEl.clientWidth - 24);
    var availH = Math.max(50, scrollEl.clientHeight - 40);
    var rotated = (pdfv.rotation % 180) !== 0;
    var w = rotated ? pdfv.baseHeight : pdfv.baseWidth;
    var h = rotated ? pdfv.baseWidth : pdfv.baseHeight;
    if (mode === 'width') return availW / w;
    return Math.min(availW / w, availH / h);
  }
  function pdfvUpdateZoomLabel(){
    var el = document.getElementById('pdfv-zoom-pct');
    if (el) el.textContent = Math.round(pdfv.scale * 100) + '%';
  }
  /** Zoom that keeps a specific screen point (the cursor, for +/-/Ctrl+wheel) anchored to the
   *  same content underneath it — the page you're looking at never jumps. */
  function pdfvSetScale(newScale, anchorClientX, anchorClientY){
    newScale = Math.max(PDFV_MIN_SCALE, Math.min(PDFV_MAX_SCALE, newScale));
    if (Math.abs(newScale - pdfv.scale) < 0.001) return;
    var scrollEl = document.getElementById('pdfv-pages-scroll');
    var rect = scrollEl.getBoundingClientRect();
    var ax = anchorClientX != null ? anchorClientX : rect.left + rect.width / 2;
    var ay = anchorClientY != null ? anchorClientY : rect.top + rect.height / 2;
    var contentX = (ax - rect.left) + scrollEl.scrollLeft;
    var contentY = (ay - rect.top) + scrollEl.scrollTop;
    var ratio = newScale / pdfv.scale;
    pdfv.scale = newScale;
    pdfv.fitMode = 'custom';
    pdfvRecalcPagesLayout();
    scrollEl.scrollLeft = contentX * ratio - (ax - rect.left);
    scrollEl.scrollTop = contentY * ratio - (ay - rect.top);
    pdfvUpdateZoomLabel();
    pdfvScheduleRerenderVisible();
  }
  /** Zoom triggered from a button/menu/keyboard shortcut (no cursor position involved) — keeps
   *  the current PAGE in view (scrolled to its top) rather than anchoring to an arbitrary point. */
  function pdfvApplyScaleKeepingCurrentPage(newScale){
    var pageToKeep = pdfv.currentPage;
    pdfv.scale = Math.max(PDFV_MIN_SCALE, Math.min(PDFV_MAX_SCALE, newScale));
    pdfvRecalcPagesLayout();
    pdfvUpdateZoomLabel();
    var entry = pdfv.pages[pageToKeep - 1];
    if (entry) entry.container.scrollIntoView({ block: 'start' });
    pdfvScheduleRerenderVisible();
  }
  window.pdfvZoomIn = function pdfvZoomIn(){ pdfvSetScale(pdfv.scale * 1.2); };
  window.pdfvZoomOut = function pdfvZoomOut(){ pdfvSetScale(pdfv.scale / 1.2); };
  window.pdfvSetFit = function pdfvSetFit(mode){
    pdfv.fitMode = mode;
    pdfvApplyScaleKeepingCurrentPage(pdfvComputeFitScale(mode));
    pdfvCloseZoomMenu();
  };
  window.pdfvSetActualSize = function pdfvSetActualSize(){
    pdfv.fitMode = 'custom';
    pdfvApplyScaleKeepingCurrentPage(1);
    pdfvCloseZoomMenu();
  };
  window.pdfvToggleZoomMenu = function pdfvToggleZoomMenu(){
    var menu = document.getElementById('pdfv-zoom-menu');
    var btn = document.getElementById('pdfv-zoom-pct');
    var open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open){
      setTimeout(function(){ document.addEventListener('click', pdfvZoomMenuOutsideClick); }, 0);
    }
  };
  function pdfvCloseZoomMenu(){
    var menu = document.getElementById('pdfv-zoom-menu');
    if (menu) menu.hidden = true;
    var btn = document.getElementById('pdfv-zoom-pct');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', pdfvZoomMenuOutsideClick);
  }
  function pdfvZoomMenuOutsideClick(e){
    var menu = document.getElementById('pdfv-zoom-menu');
    var btn = document.getElementById('pdfv-zoom-pct');
    if (menu && !menu.contains(e.target) && e.target !== btn) pdfvCloseZoomMenu();
  }
  function pdfvWheelHandler(e){
    if (!e.ctrlKey && !e.metaKey) return; // plain wheel/trackpad scroll passes through untouched
    e.preventDefault();
    var factor = e.deltaY < 0 ? 1.1 : (1 / 1.1);
    pdfvSetScale(pdfv.scale * factor, e.clientX, e.clientY);
  }
  /** Window resize / orientation change (rotating a tablet, resizing the browser): if the user is
   *  on "Fit width" or "Fit page" (not a manual zoom level), re-fit to the new size so the layout
   *  never ends up too big/small or cut off. A manual zoom ('custom') is left alone — resizing the
   *  window shouldn't silently change a zoom level the user picked on purpose. */
  var pdfvResizeDebounce = null;
  function pdfvResizeHandler(){
    clearTimeout(pdfvResizeDebounce);
    pdfvResizeDebounce = setTimeout(function(){
      if (!pdfv.doc) return;
      if (pdfv.fitMode === 'width' || pdfv.fitMode === 'page'){
        pdfvApplyScaleKeepingCurrentPage(pdfvComputeFitScale(pdfv.fitMode));
      }
    }, 200);
  }

  /* ---- rotation ---- */
  window.pdfvRotate = function pdfvRotate(delta){
    pdfv.rotation = ((pdfv.rotation + delta) % 360 + 360) % 360;
    var pageToKeep = pdfv.currentPage;
    pdfvRecalcPagesLayout();
    pdfv.pages.forEach(function(entry){
      entry.rendered = false; entry.renderKey = null;
      if (entry.textLayerEl){ entry.textLayerEl.remove(); entry.textLayerEl = null; entry.textDivs = null; entry.textLayerKey = null; }
    });
    var entry = pdfv.pages[pageToKeep - 1];
    if (entry) entry.container.scrollIntoView({ block: 'start' });
    pdfvScheduleRerenderVisible();
    if (pdfv.thumbsBuilt) pdfvBuildThumbs();
  };

  /* ---- thumbnails (lazy, own IntersectionObserver on the side panel) ---- */
  window.pdfvToggleThumbs = function pdfvToggleThumbs(){
    pdfv.thumbsOpen = !pdfv.thumbsOpen;
    var panel = document.getElementById('pdfv-thumbs');
    var backdrop = document.getElementById('pdfv-thumbs-backdrop');
    var btn = document.getElementById('pdfv-thumbs-toggle');
    panel.hidden = !pdfv.thumbsOpen;
    panel.classList.toggle('open', pdfv.thumbsOpen);
    backdrop.hidden = !pdfv.thumbsOpen;
    backdrop.classList.toggle('open', pdfv.thumbsOpen);
    btn.setAttribute('aria-pressed', String(pdfv.thumbsOpen));
    if (pdfv.thumbsOpen){
      if (!pdfv.thumbsBuilt) pdfvBuildThumbs();
      pdfvScrollThumbIntoView(pdfv.currentPage);
    }
  };
  function pdfvBuildThumbs(){
    pdfv.thumbsBuilt = true;
    var panel = document.getElementById('pdfv-thumbs');
    panel.innerHTML = '';
    pdfv.thumbEls = [];
    for (var n = 1; n <= pdfv.numPages; n++){
      (function(n){
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pdfv-thumb';
        btn.setAttribute('aria-label', 'Go to page ' + n);
        var ph = document.createElement('div');
        ph.className = 'pdfv-thumb-placeholder';
        btn.appendChild(ph);
        var label = document.createElement('div');
        label.className = 'pdfv-thumb-num';
        label.textContent = String(n);
        btn.appendChild(label);
        btn.addEventListener('click', function(){
          pdfvGoToPage(n);
          if (window.innerWidth <= 820) window.pdfvToggleThumbs();
        });
        panel.appendChild(btn);
        pdfv.thumbEls.push({ num: n, btn: btn, placeholder: ph, canvas: null, rendered: false, rendering: false });
      })(n);
    }
    pdfvUpdateThumbSelection();
    if (pdfv.thumbObserver) pdfv.thumbObserver.disconnect();
    pdfv.thumbObserver = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if (e.isIntersecting) pdfvRenderThumb(parseInt(e.target.getAttribute('data-thumb-page'), 10));
      });
    }, { root: panel, rootMargin: '300px 0px 300px 0px' });
    pdfv.thumbEls.forEach(function(t){ t.btn.setAttribute('data-thumb-page', String(t.num)); pdfv.thumbObserver.observe(t.btn); });
  }
  function pdfvRenderThumb(n){
    var t = pdfv.thumbEls && pdfv.thumbEls[n - 1];
    if (!t || t.rendered || t.rendering || !pdfv.doc) return;
    t.rendering = true;
    var ownerDoc = pdfv.doc;
    pdfv.doc.getPage(n).then(function(page){
      if (pdfv.doc !== ownerDoc) return;
      var targetW = 118;
      var baseViewport = page.getViewport({ scale: 1, rotation: pdfv.rotation });
      var scale = targetW / baseViewport.width;
      var viewport = page.getViewport({ scale: scale, rotation: pdfv.rotation });
      var canvas = document.createElement('canvas');
      var outputScale = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = Math.floor(viewport.width) + 'px';
      canvas.style.height = Math.floor(viewport.height) + 'px';
      var ctx = canvas.getContext('2d');
      var transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
      return page.render({ canvasContext: ctx, transform: transform, viewport: viewport }).promise.then(function(){
        if (pdfv.doc !== ownerDoc || !t.placeholder.parentNode) return;
        t.placeholder.replaceWith(canvas);
        t.canvas = canvas;
        t.rendered = true;
        t.rendering = false;
      });
    }).catch(function(){ t.rendering = false; });
  }
  function pdfvUpdateThumbSelection(){
    if (!pdfv.thumbEls) return;
    pdfv.thumbEls.forEach(function(t){ t.btn.classList.toggle('current', t.num === pdfv.currentPage); });
  }
  function pdfvScrollThumbIntoView(n){
    var t = pdfv.thumbEls && pdfv.thumbEls[n - 1];
    if (t) t.btn.scrollIntoView({ block: 'nearest' });
  }

  /* ---- search (real PDF text via pdf.js text content — never image/OCR-based) ---- */
  window.pdfvToggleSearch = function pdfvToggleSearch(){
    if (pdfv.searchOpen) pdfvCloseSearch(); else pdfvOpenSearch();
  };
  function pdfvOpenSearch(){
    pdfv.searchOpen = true;
    document.getElementById('pdfv-search-bar').hidden = false;
    document.getElementById('pdfv-search-toggle').setAttribute('aria-pressed', 'true');
    var input = document.getElementById('pdfv-search-input');
    input.focus();
    input.select();
  }
  function pdfvCloseSearch(silent){
    pdfv.searchOpen = false;
    pdfv.searchGen++;
    var bar = document.getElementById('pdfv-search-bar');
    if (bar) bar.hidden = true;
    var toggle = document.getElementById('pdfv-search-toggle');
    if (toggle) toggle.setAttribute('aria-pressed', 'false');
    var input = document.getElementById('pdfv-search-input');
    if (input) input.value = '';
    pdfv.searchQuery = ''; pdfv.searchMatches = []; pdfv.searchIndex = -1;
    pdfvUpdateSearchCount('');
    pdfvHighlightAllRendered();
    if (!silent){
      var closeBtn = document.getElementById('pdfv-close');
      if (closeBtn) closeBtn.focus();
    }
  }
  window.pdfvCloseSearch = pdfvCloseSearch;
  function pdfvUpdateSearchCount(text){
    var el = document.getElementById('pdfv-search-count');
    if (el) el.textContent = text;
  }
  window.pdfvSearchInput = function pdfvSearchInput(){
    var q = document.getElementById('pdfv-search-input').value;
    clearTimeout(pdfvSearchDebounce);
    pdfvSearchDebounce = setTimeout(function(){ pdfvRunSearch(q.trim()); }, 300);
  };
  window.pdfvSearchKeydown = function pdfvSearchKeydown(e){
    if (e.key === 'Enter'){
      e.preventDefault();
      clearTimeout(pdfvSearchDebounce);
      var q = document.getElementById('pdfv-search-input').value.trim();
      if (q === pdfv.searchQuery && pdfv.searchMatches.length){
        if (e.shiftKey) pdfvSearchPrev(); else pdfvSearchNext();
      } else {
        pdfvRunSearch(q);
      }
    }
  };
  function pdfvSearchPrev(){ if (pdfv.searchMatches.length) pdfvGoToMatch(pdfv.searchIndex - 1); }
  function pdfvSearchNext(){ if (pdfv.searchMatches.length) pdfvGoToMatch(pdfv.searchIndex + 1); }
  window.pdfvSearchPrev = pdfvSearchPrev;
  window.pdfvSearchNext = pdfvSearchNext;

  async function pdfvRunSearch(query){
    var myGen = ++pdfv.searchGen;
    pdfv.searchQuery = query;
    if (!query){
      pdfv.searchMatches = []; pdfv.searchIndex = -1;
      pdfvUpdateSearchCount('');
      pdfvHighlightAllRendered();
      return;
    }
    pdfvUpdateSearchCount('Searching…');
    var needle = query.toLowerCase();
    var matches = [];
    var anyText = false;
    for (var n = 1; n <= pdfv.numPages; n++){
      if (myGen !== pdfv.searchGen) return;
      var text = pdfv.pageTextCache[n];
      if (text === undefined){
        try {
          var page = await pdfv.doc.getPage(n);
          var tc = await page.getTextContent();
          text = tc.items.map(function(it){ return it.str; }).join(' ');
        } catch(_e){ text = ''; }
        pdfv.pageTextCache[n] = text;
      }
      if (myGen !== pdfv.searchGen) return;
      if (text && text.trim()) anyText = true;
      var lower = text.toLowerCase();
      var idx = 0, k = 0;
      while (true){
        var found = lower.indexOf(needle, idx);
        if (found === -1) break;
        matches.push({ page: n, occurrence: k });
        k++;
        idx = found + needle.length;
      }
      if (n % 20 === 0) pdfvUpdateSearchCount(matches.length + ' results so far…');
    }
    if (myGen !== pdfv.searchGen) return;
    pdfv.searchMatches = matches;
    pdfvHighlightAllRendered();
    if (matches.length === 0){
      pdfv.searchIndex = -1;
      pdfvUpdateSearchCount(anyText ? '0 results' : 'No searchable text — this looks like a scanned document');
      return;
    }
    pdfvGoToMatch(0);
  }
  function pdfvGoToMatch(idx){
    if (!pdfv.searchMatches.length) return;
    idx = ((idx % pdfv.searchMatches.length) + pdfv.searchMatches.length) % pdfv.searchMatches.length;
    pdfv.searchIndex = idx;
    var m = pdfv.searchMatches[idx];
    pdfvUpdateSearchCount((idx + 1) + ' of ' + pdfv.searchMatches.length);
    pdfv.currentPage = m.page;
    pdfvUpdatePageIndicator();
    pdfvUpdateThumbSelection();
    var entry = pdfv.pages[m.page - 1];
    if (entry) entry.container.scrollIntoView({ block: 'start' });
    pdfvRenderPage(m.page).then(function(){ pdfvScrollToOccurrence(m.page, m.occurrence); });
  }
  function pdfvScrollToOccurrence(pageNum, occurrence){
    var entry = pdfv.pages[pageNum - 1];
    if (!entry || !entry.textLayerEl) return;
    document.querySelectorAll('.pdfv-hit-current').forEach(function(el){ el.classList.remove('pdfv-hit-current'); });
    var marks = entry.textLayerEl.querySelectorAll('mark.pdfv-hit');
    var mark = marks[occurrence];
    if (mark){ mark.classList.add('pdfv-hit-current'); mark.scrollIntoView({ block: 'center' }); }
  }
  function pdfvHighlightAllRendered(){
    pdfv.pages.forEach(function(entry){ if (entry.textDivs) pdfvHighlightPage(entry); });
  }
  function pdfvHighlightPage(entry){
    if (!entry.textDivs) return;
    var q = pdfv.searchQuery;
    var needle = q ? q.toLowerCase() : '';
    entry.textDivs.forEach(function(span){
      if (span.dataset.orig === undefined) span.dataset.orig = span.textContent;
      var orig = span.dataset.orig;
      if (!needle){ span.textContent = orig; return; }
      var lower = orig.toLowerCase();
      if (lower.indexOf(needle) === -1){ span.textContent = orig; return; }
      var out = '', i = 0;
      while (true){
        var idx = lower.indexOf(needle, i);
        if (idx === -1){ out += esc(orig.slice(i)); break; }
        out += esc(orig.slice(i, idx)) + '<mark class="pdfv-hit">' + esc(orig.slice(idx, idx + needle.length)) + '</mark>';
        i = idx + needle.length;
      }
      span.innerHTML = out;
    });
    // Re-mark whichever occurrence is "current" if it happens to be on this page.
    if (pdfv.searchIndex >= 0){
      var m = pdfv.searchMatches[pdfv.searchIndex];
      if (m && m.page === entry.num){
        var marks = entry.textLayerEl.querySelectorAll('mark.pdfv-hit');
        var mark = marks[m.occurrence];
        if (mark) mark.classList.add('pdfv-hit-current');
      }
    }
  }

  /* ---- fullscreen, download, print ---- */
  window.pdfvToggleFullscreen = function pdfvToggleFullscreen(){
    var el = document.getElementById('pdfv-overlay');
    if (!document.fullscreenElement){
      var req = el.requestFullscreen || el.webkitRequestFullscreen;
      if (req) req.call(el);
    } else {
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) exit.call(document);
    }
  };
  function pdfvFullscreenChangeHandler(){
    pdfv.fullscreen = !!document.fullscreenElement;
    var btn = document.getElementById('pdfv-fullscreen');
    if (btn) btn.setAttribute('aria-pressed', String(pdfv.fullscreen));
  }
  window.pdfvDownload = async function pdfvDownload(){
    try {
      var resp = await fetch(pdfv.url);
      var blob = await resp.blob();
      var blobUrl = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = blobUrl;
      a.download = pdfv.fileName || 'document.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function(){ URL.revokeObjectURL(blobUrl); }, 4000);
    } catch(_err){
      // Cross-origin fetch blocked or offline — falling back still gets the file in front of them.
      window.open(pdfv.url, '_blank', 'noopener');
    }
  };
  window.pdfvPrint = function pdfvPrint(){
    var existing = document.getElementById('pdfv-print-frame');
    if (existing) existing.remove();
    var frame = document.createElement('iframe');
    frame.id = 'pdfv-print-frame';
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    frame.src = pdfv.url;
    document.body.appendChild(frame);
    frame.onload = function(){
      try { frame.contentWindow.focus(); frame.contentWindow.print(); }
      catch(_e){ window.open(pdfv.url, '_blank', 'noopener'); }
    };
  };

  /* ---- mobile swipe-to-change-page (touch only; mouse/trackpad keep native scroll + Ctrl+wheel zoom) ---- */
  var pdfvPointerStartX = null, pdfvPointerStartY = null, pdfvPointerActive = false, pdfvPointerId = null;
  window.pdfvPointerDown = function pdfvPointerDown(e){
    if (e.pointerType !== 'touch' || e.isPrimary === false) return;
    pdfvPointerActive = true;
    pdfvPointerId = e.pointerId;
    pdfvPointerStartX = e.clientX;
    pdfvPointerStartY = e.clientY;
  };
  window.pdfvPointerUp = function pdfvPointerUp(e){
    if (!pdfvPointerActive || e.pointerId !== pdfvPointerId) return;
    pdfvPointerActive = false;
    // Only swipe-navigate when not zoomed in past fit-width — otherwise a horizontal drag is for
    // panning around a zoomed page, which the container's native touch-scroll already handles.
    var fitW = pdfvComputeFitScale('width');
    if (pdfv.scale > fitW * 1.05) return;
    var dx = e.clientX - pdfvPointerStartX;
    var dy = e.clientY - pdfvPointerStartY;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.8){
      if (dx > 0) window.pdfvPrevPage(); else window.pdfvNextPage();
    }
  };

  /** Same as render(), but without scrolling back to the top — for actions like changing a
   *  table's sort order or a filter, where the user wants to keep looking at what they were already viewing. */
  function renderPreservingScroll(){
    var y = window.scrollY;
    render(true);
    window.scrollTo(0, y);
  }
  /** Re-fetches the task_index/activity_log read models so the Dashboard/Timeline reflect
   *  whatever just changed in the 8 source tables they're derived from. Call after any mutation
   *  to those source tables, and after bootstrapData()'s own weekly-duty-generation side effects. */
  async function refreshOperationsReadModels(){
    taskIndexRows = await taskIndexService.getAll();
    activityLogRows = await activityLogService.getAll();
  }

  /* ============ Async bootstrap: load everything from Supabase in parallel, then render ============ */
  async function bootstrapData(){
    var results = await Promise.all([
      propertyService.getAll(isTenantRole()),
      roomService.getAll(),
      tenantService.getAll(),
      bondService.getAll(),
      rentScheduleService.getAll(),
      paymentService.getAll(),
      billService.getAll(),
      billAllocationService.getAll(),
      tenantDocumentService.getAll(),
      maintenanceService.getAll(),
      notificationService.getAll(),
      recurringBillService.getAll(),
      cleaningService.getAllTasks(),
      cleaningService.getAllSubmissions(),
      cleaningService.getAllComments(),
      trashService.getAll(),
      inspectionService.getAll(),
      inspectionService.getAllComments(),
      paymentReportService.getAll(),
      moveOutSettlementService.getAll(),
      weeklyDutyService.getAll(),
      binOutTaskService.getAll(),
      taskIndexService.getAll(),
      activityLogService.getAll(),
      entityLinkService.getAll(),
      roomIncludedBillService.getAll(),
      binDutyService.getAll()
    ]);
    properties = results[0];
    rooms = results[1];
    tenants = results[2];
    bonds = results[3];
    rentSchedules = results[4];
    paymentRecords = results[5];
    var billRows = results[6];
    var allocationRows = results[7];
    bills = billRows.map(function(b){
      b.allocations = allocationRows.filter(function(a){ return a.billId === b.id; });
      return b;
    });
    tenantDocuments = results[8];
    maintenanceRequests = results[9];
    notificationsList = results[10];
    recurringBills = results[11];
    cleaningTasks = results[12];
    cleaningSubmissions = results[13];
    cleaningComments = results[14];
    trashSchedule = results[15];
    inspectionSubmissions = results[16];
    inspectionComments = results[17];
    paymentReports = results[18];
    moveOutSettlements = results[19];
    weeklyDuties = results[20];
    binOutTasks = results[21];
    taskIndexRows = results[22];
    activityLogRows = results[23];
    entityLinks = results[24];
    roomIncludedBills = results[25];
    binDuties = results[26];
    if (isSuperAdmin()){
      try { allProfiles = await profileService.getAll(); } catch(_e){ allProfiles = []; }
      try { propertyAssignments = await profileService.getPropertyAssignments(); } catch(_e){ propertyAssignments = []; }
    }
    try { await generateDueRecurringBills(); } catch(_e){ console.error('generateDueRecurringBills failed', _e); }
    try { await checkMissingBillsNotifications(); } catch(_e){ console.error('checkMissingBillsNotifications failed', _e); }
    try { await ensureCleaningDutiesUpToDate(); } catch(_e){ console.error('ensureCleaningDutiesUpToDate failed', _e); }
    try { await ensureBinDutiesUpToDate(); } catch(_e){ console.error('ensureBinDutiesUpToDate failed', _e); }
    try { await refreshOperationsReadModels(); } catch(_e){ console.error('refreshOperationsReadModels failed', _e); }
    recomputeRentCharges();
    // Must run after recomputeRentCharges() — its rent-reminder rules read the freshly computed
    // rentCharges array, which doesn't exist yet at the point the other automatic checks above run.
    try { await ensureAutomaticNotifications(); } catch(_e){ console.error('ensureAutomaticNotifications failed', _e); }
    refreshStaticSelects();
  }
  window.bootstrapData = bootstrapData;

  /** Lightweight toast for success/error feedback on async actions, reusing the app's existing visual language. */
  /** `action`, if given, is { label, onClick } and renders as a small inline button on the
   *  toast (e.g. "Undo") — clicking it runs onClick and dismisses the toast immediately. */
  function showToast(message, kind, action){
    var el = document.getElementById('toast');
    if (!el) { return; }
    el.innerHTML = '';
    var msgSpan = document.createElement('span');
    msgSpan.textContent = message;
    el.appendChild(msgSpan);
    if (action && action.label && action.onClick){
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-action';
      btn.textContent = action.label;
      btn.onclick = function(){
        el.hidden = true; el.className = 'toast';
        clearTimeout(showToast._t);
        action.onClick();
      };
      el.appendChild(btn);
    }
    el.className = 'toast ' + (kind || 'info') + ' show';
    el.hidden = false;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function(){ el.hidden = true; el.className = 'toast'; }, action ? 6000 : 3200);
  }
  window.showToast = showToast;

  function startRouter(){
    window.addEventListener('hashchange', render);
    render();
  }

  /** True if any form modal is open — we don't want a background automatic data
   *  refresh to wipe out what someone is typing in the middle of filling out a form. */
  function anyModalOpen(){
    return Array.prototype.some.call(document.querySelectorAll('.modal-overlay'), function(el){ return !el.hidden; });
  }

  var isRefreshingData = false;
  /** Fetches ALL data from Supabase again and re-renders — so two administrators
   *  working at the same time (e.g. the Super Admin and Geraldine) always see the same thing,
   *  without relying on someone closing the tab entirely. Skips the refresh if a modal is
   *  open (a partly filled-out form) or if one is already in progress. */
  async function refreshAllData(){
    if (isRefreshingData || anyModalOpen()) return;
    isRefreshingData = true;
    try {
      await bootstrapData();
      render(true); // preserves scroll position — this is a silent refresh, not a navigation
    } catch(err){
      console.error('refreshAllData failed', err);
    } finally {
      isRefreshingData = false;
    }
  }
  window.refreshAllData = refreshAllData;

  var autoRefreshSetupDone = false;
  /** Three triggers to keep everything synced "immediately" between users, without
   *  anyone having to close and reopen the tab:
   *  1) When returning to this tab (switching apps and coming back, or unlocking the phone).
   *  2) When restored from Safari's back-forward cache (navigating "back" doesn't reload
   *     the JS by default — so fresh data is forced anyway).
   *  3) A poll every 60s while the tab is visible, in case someone else made a change and
   *     this tab stayed open and visible that whole time without losing focus. */
  function setupAutoRefresh(){
    if (autoRefreshSetupDone) return;
    autoRefreshSetupDone = true;
    document.addEventListener('visibilitychange', function(){
      if (document.visibilityState === 'visible') refreshAllData();
    });
    window.addEventListener('pageshow', function(e){
      if (e.persisted) refreshAllData();
    });
    setInterval(function(){
      if (document.visibilityState === 'visible') refreshAllData();
    }, 60000);
  }

  /* ============ Auth gate: sign in before loading/rendering any app data ============ */
  // Self-signup is gone — accounts are created by a Super Admin (Users page), who hands the
  // person their email + initial password directly. This form is sign-in only now.
  /** Tenants log in with their phone number, not an email (see PHONE_LOGIN_SUFFIX above) — the
   *  same conversion the create-user Edge Function does when it creates their login. Anything
   *  with an "@" is treated as a real email (Administrator/Super Admin) and used as-is. */
  function loginIdentifierToEmail(raw){
    var trimmed = (raw || '').trim();
    if (trimmed.indexOf('@') > -1) return trimmed;
    return phoneDigitsOnly(trimmed) + PHONE_LOGIN_SUFFIX;
  }

  async function submitAuthForm(){
    var rawInput = document.getElementById('auth-email').value.trim();
    var password = document.getElementById('auth-password').value;
    var errorEl = document.getElementById('auth-error');
    var btn = document.getElementById('auth-submit-btn');
    if (!rawInput || !password){
      errorEl.textContent = 'Enter your email or phone number, and your password.';
      errorEl.hidden = false;
      return;
    }
    var originalLabel = btn.textContent;
    btn.disabled = true; btn.textContent = 'Signing in…';
    errorEl.hidden = true;
    try {
      await auth.signIn(loginIdentifierToEmail(rawInput), password);
      await enterApp();
    } catch(err){
      errorEl.textContent = friendlyErrorMessage(err);
      errorEl.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = originalLabel;
    }
  }
  window.submitAuthForm = submitAuthForm;

  async function requestAuthPasswordReset(){
    var rawInput = document.getElementById('auth-email').value.trim();
    var errorEl = document.getElementById('auth-error');
    if (!rawInput){
      errorEl.textContent = 'Enter your email or phone number above first, then tap "Forgot password?" again.';
      errorEl.hidden = false;
      return;
    }
    if (rawInput.indexOf('@') === -1){
      errorEl.textContent = "Tenants log in with a phone number, so there's no email to send a reset link to — ask your Super Admin to set you a new password.";
      errorEl.hidden = false;
      return;
    }
    var btn = document.getElementById('auth-toggle-link');
    var originalLabel = btn ? btn.textContent : '';
    if (btn){ btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
      await profileService.sendPasswordReset(rawInput);
      errorEl.textContent = "If that email has an account, we've sent a temporary password to it — check your inbox, sign in with it, then change your password from Settings.";
      errorEl.hidden = false;
    } catch(err){
      errorEl.textContent = friendlyErrorMessage(err);
      errorEl.hidden = false;
    } finally {
      if (btn){ btn.disabled = false; btn.textContent = originalLabel; }
    }
  }
  window.requestAuthPasswordReset = requestAuthPasswordReset;

  async function signOutAndReload(){
    try { await auth.signOut(); } catch(e){ /* ignore */ }
    location.reload();
  }
  window.signOutAndReload = signOutAndReload;

  /** The topbar button (visible on any page, for any role) — confirms before
   *  signing out so an accidental tap doesn't kick someone out mid-task. */
  function confirmSignOut(){
    if (window.confirm('Sign out?')) signOutAndReload();
  }
  window.confirmSignOut = confirmSignOut;

  async function enterApp(){
    document.getElementById('auth-screen').hidden = true;
    document.getElementById('app-loading-screen').hidden = false;
    try {
      currentProfile = await profileService.getMyProfile();
      if (!currentProfile){
        throw new Error('Your account has no profile set up yet. Ask your Super Admin to check your access.');
      }
      if (!currentProfile.isActive){
        throw new Error('Your account has been deactivated. Ask your Super Admin to reactivate it.');
      }
      await bootstrapData();
    } catch(err){
      document.getElementById('app-loading-screen').hidden = true;
      document.getElementById('auth-screen').hidden = false;
      document.getElementById('auth-error').textContent = friendlyErrorMessage(err);
      document.getElementById('auth-error').hidden = false;
      try { await auth.signOut(); } catch(_e){ /* ignore */ }
      currentProfile = null;
      return;
    }
    buildNavDom(isTenantRole() ? TENANT_NAV : STAFF_NAV);
    ROUTES = isTenantRole() ? TENANT_ROUTES : STAFF_ROUTES;
    document.getElementById('app-loading-screen').hidden = true;
    document.querySelector('.shell').hidden = false;
    startRouter();
    setupAutoRefresh();
    if (getAppPin()){
      document.getElementById('lock-screen').hidden = false;
      document.getElementById('lock-pin-input').focus();
    }
  }

  function roleLabel(role){
    return role==='super_admin' ? 'Super Admin' : role==='administrator' ? 'Administrator' : 'Tenant';
  }

  // A "reset your password" email link lets supabase-js automatically create a
  // valid session as soon as the page loads (detectSessionInUrl) — without this, that person
  // would go straight into the app with their OLD password without realizing they never got to
  // change it. Detects that case (the PASSWORD_RECOVERY event) and opens the change-password
  // modal as soon as they enter.
  var pendingPasswordRecovery = false;
  auth.onAuthStateChange(function(event){
    if (event !== 'PASSWORD_RECOVERY') return;
    if (currentProfile) openChangePasswordModal(); // enterApp() has already finished — open it right away
    else pendingPasswordRecovery = true; // not yet — initAuthGate checks this as soon as it enters
  });

  async function initAuthGate(){
    var session;
    try { session = await auth.getSession(); } catch(e){ session = null; }
    if (session){
      await enterApp();
      if (pendingPasswordRecovery && currentProfile){
        pendingPasswordRecovery = false;
        openChangePasswordModal();
      }
    } else {
      document.getElementById('auth-screen').hidden = false;
    }
  }
  initAuthGate();

  var signoutBtn = document.getElementById('signout-btn');
  if (signoutBtn) signoutBtn.innerHTML = svg('logout');

  /* ============ Theme toggle (independent of the host's theme) ============ */
  var root = document.documentElement;
  var themeBtn = document.getElementById('theme-toggle');
  var STORAGE_KEY = 'belmont-manager-theme';

  function systemPrefersDark(){
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function getStoredTheme(){
    try { return localStorage.getItem(STORAGE_KEY); } catch(e){ return null; }
  }
  function storeTheme(t){
    try { localStorage.setItem(STORAGE_KEY, t); } catch(e){ /* ignore */ }
  }
  function applyTheme(t){
    root.setAttribute('data-theme', t);
    themeBtn.innerHTML = svg(t==='dark' ? 'sun' : 'moon');
  }
  var initial = getStoredTheme() || (systemPrefersDark() ? 'dark' : 'light');
  applyTheme(initial);
  themeBtn.addEventListener('click', function(){
    var next = root.getAttribute('data-theme')==='dark' ? 'light' : 'dark';
    applyTheme(next);
    storeTheme(next);
  });

  /* ============ App lock (PHASE 14): shown after loading the data if a PIN is saved (see enterApp()) ============ */
  var lockPinInput = document.getElementById('lock-pin-input');
  lockPinInput.addEventListener('keydown', function(e){ if (e.key === 'Enter') attemptUnlock(); });
})();
