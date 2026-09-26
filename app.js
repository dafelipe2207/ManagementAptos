// app.js — orchestration layer: auth gate, initial async load from Supabase,
// render()/router wiring. Business logic and rendering below are adapted
// from artifact/index.html, preserved as closely as possible; the main
// structural change is that persistence now goes through the async
// services/* modules instead of synchronous localStorage.
import * as auth from './lib/auth.js?v=2';
import { friendlyErrorMessage } from './lib/errors.js';
import * as propertyService from './services/propertyService.js?v=2';
import * as roomService from './services/roomService.js';
import * as tenantService from './services/tenantService.js?v=3';
import * as bondService from './services/bondService.js';
import * as rentScheduleService from './services/rentScheduleService.js';
import * as paymentService from './services/paymentService.js';
import * as billService from './services/billService.js?v=3';
import * as billAllocationService from './services/billAllocationService.js?v=2';
import * as tenantDocumentService from './services/tenantDocumentService.js';
import * as storageService from './services/storageService.js';
import * as aiService from './services/aiService.js?v=3';
import * as migrationService from './services/migrationService.js';
import * as profileService from './services/profileService.js?v=5';
import * as maintenanceService from './services/maintenanceService.js';
import * as notificationService from './services/notificationService.js';
import * as auditService from './services/auditService.js';
import * as recurringBillService from './services/recurringBillService.js';

(function(){
  "use strict";

  /* ============ "Today" — the real current date, computed once at load ============ */
  var TODAY = toIsoLocal(new Date());

  /* ============ In-memory data, populated by bootstrapData() after sign-in ============ */
  var properties = [];
  var rooms = [];
  var tenants = [];
  var bonds = [];
  /* Role/session state — set once by enterApp() right after sign-in, before anything else
   * loads. currentProfile is the signed-in user's own profiles row (role, name, active status);
   * allProfiles/maintenanceRequests/notificationsList are populated by bootstrapData(). RLS is
   * what actually enforces who can see what — these helpers just drive what the UI *offers*. */
  var currentProfile = null;
  var allProfiles = [];
  var propertyAssignments = []; // [{id, propertyId, profileId}] — which Administrator sees which property (super_admin only, loaded in bootstrapData)
  var maintenanceRequests = [];
  var notificationsList = [];
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
  async function recordPayment(tenantId, amount, date){
    amount = Math.round(amount*100)/100;
    if (!(amount > 0)) return null;
    try {
      var saved = await paymentService.create({ tenantId:tenantId, amount:amount, date: date || TODAY });
      paymentRecords.push(saved);
      recomputeRentCharges();
      showToast('Payment recorded.', 'success', { label:'Undo', onClick: function(){ undoRecordedPayment(saved.id); } });
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

  /* ============ dashboardService (same logic as src/services/dashboardService.ts) ============ */
  function isRoomOccupied(room){
    return tenants.some(function(t){
      if (t.roomId !== room.id || t.rentAmount <= 0) return false;
      var movedIn = t.moveInDate <= TODAY;
      var movedOut = t.actualMoveOutDate ? t.actualMoveOutDate <= TODAY : false;
      return movedIn && !movedOut;
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
            href: '#/bills/' + b.id
          });
        });
      } else {
        events.push({
          date: b.dueDate,
          kind: kind,
          title: b.provider + ' — Bill due',
          href: '#/bills/' + b.id
        });
      }
    });
    tenants.forEach(function(t){
      if (t.rentAmount <= 0) return; // owner: doesn't generate tenancy events
      events.push({ date: t.moveInDate, kind: 'move', title: t.fullName + ' — Move-in', href: '#/tenants/' + t.id });
      var moveOut = t.actualMoveOutDate || t.expectedMoveOutDate;
      if (moveOut) events.push({ date: moveOut, kind: 'move', title: t.fullName + ' — Move-out', href: '#/tenants/' + t.id });
    });
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
    render();
  }
  function calendarGoToday(){ calendarMonth = TODAY.slice(0,7); render(); }
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
    { hash:'#/maintenance', label:'Maintenance', icon:'document', primary:false },
    { hash:'#/calendar', label:'Calendar', icon:'calendar', primary:false },
    { hash:'#/documents', label:'Documents', icon:'document', primary:false },
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
    { hash:'#/notifications', label:'Notifications', icon:'bell', primary:false },
    { hash:'#/settings', label:'Settings', icon:'settings', primary:false }
  ];
  var NAV = STAFF_NAV;
  var MORE = { hash:'#/more', label:'More', icon:'more' };

  function buildNavDom(navList){
    NAV = navList.filter(function(i){ return !i.superAdminOnly || (currentProfile && currentProfile.role === 'super_admin'); });
    var sidebarNavEl = document.getElementById('sidebar-nav');
    sidebarNavEl.innerHTML = NAV.map(function(item){
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
      ['Properties', String(s.totalProperties), false],
      ['Occupied rooms', String(s.occupiedRooms), false],
      ['Vacant rooms', String(s.vacantRooms), false],
      ['Overdue payments', String(s.overduePaymentsCount), s.overduePaymentsCount>0],
      ['Rent expected', money(s.totalRentExpected), false],
      ['Rent received', money(s.totalRentReceived), false],
      ['Total outstanding', money(s.totalOutstanding), s.totalOutstanding>0],
      ['Bills pending', String(s.billsPendingCount), false]
    ];

    var statHtml = '<div class="stat-grid">' + stats.map(function(st){
      return '<div class="stat"><div class="label">'+st[0]+'</div><div class="value'+(st[2]?' warn':'')+'">'+st[1]+'</div></div>';
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

  function roomsOf(propertyId){ return rooms.filter(function(r){ return r.propertyId===propertyId; }); }
  function currentTenantOf(roomId){ return tenants.find(function(t){ return t.roomId===roomId; }); }
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
      (p.whatsappGroupLink ? '<a class="mini-btn" href="'+esc(p.whatsappGroupLink)+'" target="_blank" rel="noopener">Open WhatsApp group</a>' : '')+
      '<button class="mini-btn" onclick="openPropertyModal(\''+p.id+'\')">Edit property</button>'+
      (isSuperAdmin() ? '<button class="mini-btn danger" onclick="deletePropertyConfirm(\''+p.id+'\')">Delete property</button>' : '')+
      '</div>'+
      '<div class="card"><div class="field-list">'+
      '<div class="field-row"><span class="k">Bedrooms</span><span class="v">'+p.bedrooms+'</span></div>'+
      '<div class="field-row"><span class="k">Bathrooms</span><span class="v">'+p.bathrooms+'</span></div>'+
      (p.notes ? '<div class="field-row"><span class="k">Notes</span><span class="v" style="font-weight:400;">'+esc(p.notes)+'</span></div>' : '')+
      '</div></div>'+
      leasePaymentCardHtml(p)+
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

    var bondRows = bond ? (
      '<div class="field-row"><span class="k">Bond required</span><span class="v">'+money(bond.amountRequired)+'</span></div>'+
      '<div class="field-row"><span class="k">Bond paid</span><span class="v">'+money(bond.amountPaid)+'</span></div>'+
      '<div class="field-row"><span class="k">Status</span><span class="v">'+esc(BOND_STATUS_LABEL[bond.status]||bond.status)+'</span></div>'
    ) : '';

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
      moveOutSettlementHtml(t) +
      (t.notes ? '<div class="card"><h2>Notes</h2><p style="margin:0;font-size:13.5px;color:var(--text-dim);">'+esc(t.notes)+'</p></div>' : '');
  }

  /** When a tenant leaves (or is about to leave), computes an ESTIMATE of how much bond should
   *  be refunded: it takes their average daily rate from bills already invoiced (allocated amount
   *  / occupied days in those same bills) and projects it over the days between the last
   *  already-invoiced period and the move-out date — which don't yet have a real bill. It adds
   *  whatever is already invoiced and unpaid (that IS a real amount, not an estimate) and subtracts
   *  all of that from the paid bond. It never replaces the real bill once it arrives: it's only a
   *  projection to guide the administrator in the meantime. */
  function computeMoveOutEstimate(t){
    var moveOutDate = t.actualMoveOutDate || t.expectedMoveOutDate;
    if (!moveOutDate) return null;
    var bond = bondOf(t.id);
    var bondPaid = bond ? bond.amountPaid : 0;

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
    var estimatedReturn = round2(bondPaid - totalEstimatedOwed);
    var outstandingRent = rentCharges
      .filter(function(c){ return c.tenantId===t.id && c.remaining > 0.004; })
      .reduce(function(s,c){ return s + c.remaining; }, 0);

    return {
      moveOutDate: moveOutDate, isActual: !!t.actualMoveOutDate, hasBond: !!bond,
      bondPaid: bondPaid, lines: lines,
      totalUnpaid: round2(totalUnpaid), totalEstimatedGap: round2(totalEstimatedGap),
      totalEstimatedOwed: totalEstimatedOwed, estimatedReturn: estimatedReturn,
      outstandingRent: round2(outstandingRent)
    };
  }

  function moveOutSettlementHtml(t){
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
      '<div class="field-row"><span class="k" style="font-weight:650;">Estimated bond to return</span><span class="v" style="font-weight:650;">'+money(est.estimatedReturn)+'</span></div>';
    return '<div class="card"><h2>Move-out settlement</h2>'+
      '<p style="font-size:11.5px;color:var(--text-faint);margin:0 0 8px;">Below, each service shows what\'s already charged and unpaid (a real amount) separately from what\'s estimated from the average for days not billed yet. Update it once the real bills for the final days arrive.'+
      (est.outstandingRent > 0 ? ' Doesn\'t include the '+money(est.outstandingRent)+' still owed on rent — that\'s separate from this bond/bills estimate.' : '')+
      '</p>'+
      '<div class="field-list">'+rows+'</div></div>';
  }

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
    var tenantFilterHtml = '<div style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0;align-items:flex-end;">'+
      '<div style="flex:1;min-width:160px;">'+
      '<label style="font-size:11.5px;color:var(--text-faint);display:block;margin-bottom:4px;">Filter by property</label>'+
      '<select class="modal-input" onchange="setPaymentsPropertyFilter(this.value)">'+propertyOptions+'</select>'+
      '</div>'+
      '<div style="flex:1;min-width:160px;">'+
      '<label style="font-size:11.5px;color:var(--text-faint);display:block;margin-bottom:4px;">Filter by tenant</label>'+
      '<select class="modal-input" onchange="setPaymentsTenantFilter(this.value)">'+tenantOptions+'</select>'+
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
    function dueSectionHtml(list, nextCharge){
      if (list.length) return '<div class="field-list">'+list.map(pendingRow).join('')+'</div>';
      var note = 'Nothing due right now.';
      if (nextCharge){
        note += ' Next: '+shortDate(nextCharge.periodStart)+' – '+shortDate(nextCharge.periodEnd)+' · '+money(nextCharge.amountDue)+
          ' (due '+shortDate(nextCharge.dueDate)+' — already paid)';
      }
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
    // A tenant who's moved out (or been deactivated) and is fully settled has nothing left to
    // track here, so they drop off the list entirely — only kept around while they still owe
    // rent or a bill. A currently-active tenant always stays, even with zero charges yet, so
    // the admin can see them (and their next upcoming period, added below) from day one.
    // Picking a specific tenant from the dropdown always shows that one regardless.
    var groupTenants = (paymentsPropertyFilter==='all' ? tenants : tenantPool).filter(function(t){
        if (paymentsTenantFilter !== 'all') return paymentsTenantFilter === t.id;
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
          var paidTotal = paid.reduce(function(s,c){ return s+c.amountDue; }, 0);
          var billsTotal = owedBills.reduce(function(s,o){ return s+o.alloc.amount; }, 0);
          // rentCharges (unfiltered by the chip/date-sort above) is sorted most-future-first,
          // so the tenant's first match here is always their next period — paid or not —
          // regardless of which filter chip is currently selected. Only meaningful for a
          // tenant who's still active; a moved-out tenant kept on the list because they owe
          // a bill has no real "next period" — their last generated charge is history, not
          // upcoming — so it's left out for them.
          var allTenantCharges = rentCharges.filter(function(c){ return c.tenantId===t.id; });
          var nextCharge = (!tenantHasMovedOut(t) && allTenantCharges.length) ? allTenantCharges[0] : null;
          return '<div class="card">'+
            '<div class="detail-head" style="margin-top:0;"><h2 style="margin:0;font-size:14px;">'+esc(t.fullName)+
            (prop?' <span style="font-weight:400;color:var(--text-faint);font-size:11.5px;">· '+esc(prop.name)+'</span>':'')+'</h2></div>'+
            '<h3 style="font-size:12px;text-transform:none;letter-spacing:0;color:var(--text-dim);margin:8px 0 6px;">Due ('+pending.length+') · '+money(pendingTotal)+'</h3>'+
            dueSectionHtml(pending, nextCharge)+
            '<h3 style="font-size:12px;text-transform:none;letter-spacing:0;color:var(--text-dim);margin:14px 0 6px;">Paid ('+paid.length+') · '+money(paidTotal)+'</h3>'+
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

    var saveBtn = document.querySelector('#review-modal .mini-btn.primary');
    var originalLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    errorEl.hidden = true;
    try {
      var saved = await billService.update(editingBillId, updated);
      bills = bills.map(function(x){ return x.id===saved.id ? saved : x; });

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

      closeReviewModal();
      render();
      showToast(
        'Bill updated.' +
        ((amountChanged || periodChanged) ? ' The amount or billing period changed — use "Re-allocate" below if the tenant shares need to be recalculated.' : '') +
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
  window.saveEditedBill = saveEditedBill;
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

  function computeAllocationRows(bill, method){
    if (method === 'days') return computeDailyRoomAllocationRows(bill);
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
      var autoRows = computeAllocationRows(newBill, 'days');
      var allocRows = autoRows.map(function(r){
        if (r.isAdmin) return { tenantId:null, isAdmin:true, amount:round2(r.amount), paid:true, paidDate:TODAY };
        var amt = round2(r.amount);
        var owesNothing = amt <= 0;
        return { tenantId:r.tenantId, amount:amt, paid:owesNothing, paidDate: owesNothing ? TODAY : null };
      });
      var savedAllocations = await billAllocationService.replaceForBill(newBill.id, allocRows);
      newBill.allocationMethod = 'days';
      newBill.status = 'allocated';
      newBill = await billService.update(newBill.id, newBill);
      newBill.allocations = savedAllocations;
    }
    return newBill;
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
      render();
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
      var methods = ['equal','days','custom'];
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
      var metaText = row.isAdmin ? "Paid by you, not the tenants" : (row.days+' / '+allocationDraft.periodDays+' days occupied');
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
    // Preserves the "paid" status of each tenant who was already in the
    // previous allocation (by tenantId), even if the amount or method
    // changes — reallocating shouldn't un-mark as paid someone who already
    // paid their share.
    var oldPaidByTenant = {};
    (bill.allocations || []).forEach(function(a){ oldPaidByTenant[a.isAdmin ? 'admin' : a.tenantId] = { paid: !!a.paid, paidDate: a.paidDate || null }; });
    var newRows = allocationDraft.rows.map(function(r){
      if (r.isAdmin){
        var prevAdmin = oldPaidByTenant.admin;
        // No one else owes the administrator's share — it's considered covered as soon as it's saved.
        return { tenantId:null, isAdmin:true, amount:round2(r.amount), paid:true, paidDate: (prevAdmin && prevAdmin.paidDate) || TODAY };
      }
      var amt = round2(r.amount);
      if (amt <= 0){
        // They don't owe anything (e.g. excluded from this service, or the admin set
        // $0 by hand) — it's considered settled on its own, without asking the admin to mark it as paid.
        var prevZero = oldPaidByTenant[r.tenantId];
        return { tenantId:r.tenantId, amount:0, paid:true, paidDate: (prevZero && prevZero.paidDate) || TODAY };
      }
      var prev = oldPaidByTenant[r.tenantId];
      return { tenantId:r.tenantId, amount:amt, paid: prev ? prev.paid : false, paidDate: prev ? prev.paidDate : null };
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
  async function markAllocationPaid(billId, tenantId, date){
    var bill = billOf(billId);
    if (!bill || !bill.allocations) return;
    var alloc = bill.allocations.find(function(a){ return a.tenantId===tenantId; });
    if (!alloc) return;
    var paidDate = date || TODAY;
    try {
      await billAllocationService.markPaid(alloc.id, paidDate);
      alloc.paid = true;
      alloc.paidDate = paidDate;
      recomputeBillStatus(bill);
      var savedAllocations = bill.allocations;
      await persistBill(bill);
      bill.allocations = savedAllocations;
      showToast('Marked as paid.', 'success', { label:'Undo', onClick: function(){ unmarkAllocationPaid(billId, tenantId); } });
      render();
    } catch(err){
      showToast('Could not mark this as paid. ' + friendlyErrorMessage(err), 'error');
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
  function openAllocPaidModal(billId, tenantId){
    var bill = billOf(billId);
    var alloc = bill && bill.allocations && bill.allocations.find(function(a){ return a.tenantId===tenantId; });
    if (!alloc) return;
    var t = tenantOf(tenantId);
    allocPaidModalTarget = { billId: billId, tenantId: tenantId };
    document.getElementById('alloc-paid-modal-sub').textContent = (t?t.fullName:'') + ' • ' + money(alloc.amount);
    var dateInput = document.getElementById('alloc-paid-modal-date');
    dateInput.value = TODAY; // editable: the tenant may have paid on an earlier day than today
    document.getElementById('alloc-paid-modal').hidden = false;
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
  async function markBillAdminPaid(billId){
    var bill = billOf(billId);
    if (!bill) return;
    if (!billReadyForAdminPayment(bill)){
      showToast('Tenants need to finish paying their share before you can pay the provider.', 'error');
      return;
    }
    try {
      bill.adminPaid = true;
      bill.adminPaidDate = TODAY;
      await persistBill(bill);
      showToast('Marked as paid to the provider.', 'success');
      render();
    } catch(err){
      showToast('Could not mark this as paid. ' + friendlyErrorMessage(err), 'error');
    }
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

  var DOC_TYPE_LABEL = { lease:'Lease agreement', id:'ID copy', other:'Other' };
  function renderDocuments(){
    var tenantDocsHtml = tenantDocuments.length === 0
      ? emptyState('document', 'No tenant documents yet',
          'Save a lease agreement, ID copy or other file for a tenant.',
          '<button class="mini-btn primary" onclick="openDocModal()">+ Add document</button>')
      : '<div class="card">' + tenantDocuments.map(function(d){
          var t = tenantOf(d.tenantId);
          return '<div class="row" style="border:none;padding:8px 0;">'+
            '<div class="who"><div class="name">'+esc(t?t.fullName:'—')+' — '+esc(DOC_TYPE_LABEL[d.docType]||'Other')+'</div>'+
            '<div class="meta">'+esc(d.fileName)+' • added '+shortDate(d.addedAt)+'</div></div>'+
            '<button class="del" title="Remove" onclick="removeTenantDocument(\''+d.id+'\')">✕</button></div>';
        }).join('') + '</div>';

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
  var BILLS_SORT_DEFAULT_DIR = { provider:'asc', property:'asc', issueDate:'desc', dueDate:'desc', tenantPayments:'desc', providerPayment:'desc', status:'asc' };
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
    cols.push(['issueDate','Issue date'], ['dueDate','Due date'], ['tenantPayments','Tenant payments'], ['providerPayment','Payment to provider'], ['status','Status']);
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
        '<td>'+billTenantPaymentsSummary(b)+'</td>'+
        '<td>'+billAdminPaymentSummary(b)+'</td>'+
        '<td>'+billStatusBadge(b)+'</td>'+
        '</tr>';
    }).join('');
    return '<div class="card"><div class="report-table-wrap"><table class="report-table bills-table"><thead>'+head+'</thead><tbody>'+body+'</tbody></table></div></div>';
  }

  var billsViewTab = 'list'; // 'list' | 'missing'
  function setBillsViewTab(tab){
    billsViewTab = tab;
    render();
  }
  window.setBillsViewTab = setBillsViewTab;
  function billsViewTabsHtml(){
    return '<div class="filter-chips" style="margin-bottom:10px;">'+
      '<button class="chip'+(billsViewTab==='list'?' active':'')+'" onclick="setBillsViewTab(\'list\')">Bills</button>'+
      '<button class="chip'+(billsViewTab==='missing'?' active':'')+'" onclick="setBillsViewTab(\'missing\')">Missing invoices</button>'+
      '</div>';
  }

  function renderBills(){
    return billsViewTabsHtml() + (billsViewTab==='missing' ? renderMissingInvoicesTab() : renderBillsListTab());
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
      importQueueCard() + propertyTabsHtml + billsTimelineHtml() + recurringBillsCardHtml(billsPropertyFilter) + statHtml + chipsHtml + rows;
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
    return predictions.sort(function(a,b){ return b.daysOverdue - a.daysOverdue; });
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
      '<div style="display:flex;gap:8px;margin-bottom:12px;">'+
      '<button class="mini-btn" onclick="openEditBillModal(\''+b.id+'\')">Edit bill</button>'+
      (isSuperAdmin() ? '<button class="mini-btn danger" onclick="deleteBillConfirm(\''+b.id+'\')">Delete bill</button>' : '')+
      '</div>'+
      billAllocationCard(b);
  }

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

  /** Builds the WhatsApp link (wa.me) that opens a chat with the tenant with the
   *  bill's payment notice already drafted — provider, service, amount owed and due date.
   *  The admin only has to review and tap send; nothing is sent automatically. */
  function billAllocationWhatsAppLink(bill, property, tenant, amount){
    var digits = phoneDigitsForWhatsApp(tenant.phone);
    if (!digits) return null;
    var message = 'Hola ' + tenant.fullName + ', te escribo de ' + (property ? property.name : 'la propiedad') +
      ' para avisarte que te corresponde pagar ' + money(amount) + ' por el servicio de ' + bill.billType +
      ' (' + bill.provider + '), del periodo ' + shortDate(bill.billingPeriodStart) + ' al ' + shortDate(bill.billingPeriodEnd) +
      (bill.dueDate ? ('. Fecha límite de pago: ' + shortDate(bill.dueDate)) : '') + '. ¡Gracias!';
    return 'https://wa.me/' + digits + '?text=' + encodeURIComponent(message);
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
      return '• ' + row.name + ': ' + money(row.amount) + (row.paid ? ' (ya pagó)' : '');
    });
    return 'Reparto de la factura de ' + bill.billType + ' (' + bill.provider + ') — ' +
      (property ? property.name : 'la propiedad') + '\n' +
      'Periodo: ' + shortDate(bill.billingPeriodStart) + ' al ' + shortDate(bill.billingPeriodEnd) +
      (bill.dueDate ? ('\nFecha límite de pago: ' + shortDate(bill.dueDate)) : '') + '\n\n' +
      lines.join('\n') +
      '\n\nPor favor confirmen el pago con su comprobante. ¡Gracias!';
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
      var name = bill.receiptPath.split('/').pop() || 'factura';
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
      showToast('Agrega primero el link del grupo de WhatsApp de esta propiedad (Edit property).', 'error');
      return;
    }
    var tenantsForMsg = bill.allocations.filter(function(a){ return !a.isAdmin; }).map(function(a){
      var t = tenantOf(a.tenantId);
      return { name: t ? t.fullName : 'Inquilino', amount: a.amount, paid: !!a.paid };
    });
    var message = billGroupWhatsAppMessage(bill, property, tenantsForMsg);
    var file = await fetchBillReceiptFile(bill);

    try {
      if (file && navigator.canShare && navigator.canShare({ files: [file] })){
        await navigator.share({ files: [file], text: message, title: 'Reparto de factura' });
        return;
      }
      if (navigator.share){
        await navigator.share({ text: message, title: 'Reparto de factura' });
        return;
      }
      throw new Error('not supported');
    } catch (err){
      if (err && err.name === 'AbortError') return; // person cancelled the share sheet — not an error
      try {
        await navigator.clipboard.writeText(message);
        showToast('Tu teléfono no permite compartir directo — copiamos el mensaje, ábrelo y pégalo en el grupo.', 'info');
      } catch (_e){
        showToast('Copia este mensaje a mano y pégalo en el grupo:\n\n' + message, 'info');
      }
      window.open(property.whatsappGroupLink, '_blank', 'noopener');
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
      : '<button class="mini-btn primary" onclick="markBillAdminPaid(\''+b.id+'\')"'+(adminReady?'':' disabled title="Waiting on tenants to pay their share first"')+'>Mark as paid to provider</button>';
    var adminSectionHtml = '<div class="card"><div class="detail-head" style="margin-top:0;align-items:center;">'+
      '<h2 style="margin:0;">Payment to provider</h2></div>'+
      '<p style="font-size:12px;color:var(--text-faint);margin:2px 0 8px;">'+
      (adminReady ? 'All tenants have paid — you can now forward this on to '+esc(b.provider)+'.' : 'Available once every tenant has paid their share.')+
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
        var paidBit = a.paid
          ? badge('paid', 'Paid'+(a.paidDate ? ' ' + shortDate(a.paidDate) : ''))
          : badge('due', 'Unpaid');
        var actionBtn = a.paid
          ? '<button class="mini-btn" onclick="unmarkAllocationPaid(\''+b.id+'\',\''+a.tenantId+'\')">Mark as unpaid</button>'
          : '<button class="mini-btn primary" onclick="openAllocPaidModal(\''+b.id+'\',\''+a.tenantId+'\')">Mark as paid</button>';
        return '<div class="alloc-summary-row" style="align-items:center;flex-wrap:wrap;">'+
          '<div class="who"><div>'+esc(t?t.fullName:a.tenantId)+'</div>'+
          '<div style="display:flex;gap:10px;flex-wrap:wrap;">'+receiptLinkHtml(a.receiptPath, b.id, a.tenantId)+
          (a.paid ? '' : whatsAppButtonHtml(b, p, t, a.amount))+'</div></div>'+
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
  function renderReports(){
    if (properties.length === 0 && tenants.length === 0){
      return pageHeader('Reports', "Expected vs received rent, outstanding balances, bills and occupancy at a glance.") +
        emptyState('chart', 'Nothing to report yet',
          'Once you add properties, tenants and bills, your numbers will show up here.',
          '<a class="mini-btn primary" href="#/properties" style="display:inline-block;">Go to properties</a>');
    }
    var s = getDashboardSummary();
    // Real bill ledger: sums what's ACTUALLY been collected per allocation
    // (billPaidAmount) instead of all-or-nothing by bill.status, so a
    // partially paid bill is reflected correctly instead of counting
    // as "0% paid" until the last share is marked.
    var billsPaidTotal = bills.reduce(function(sum,b){ return sum+billPaidAmount(b); },0);
    var billsOutstandingTotal = bills.reduce(function(sum,b){ return sum+billOutstandingAmount(b); },0);
    var billsOverdueTotal = bills.filter(function(b){ return billEffectiveStatus(b)==='overdue'; })
      .reduce(function(sum,b){ return sum+billOutstandingAmount(b); },0);
    var netCashflow = s.totalRentReceived - billsPaidTotal;
    var occupancyRate = s.occupiedRooms + s.vacantRooms > 0 ? Math.round(100 * s.occupiedRooms / (s.occupiedRooms + s.vacantRooms)) : 0;

    var statHtml = '<div class="stat-grid">'+
      ['Rent expected|'+money(s.totalRentExpected)+'|0',
       'Rent received|'+money(s.totalRentReceived)+'|0',
       'Outstanding|'+money(s.totalOutstanding)+'|'+(s.totalOutstanding>0?1:0),
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

    var billsAmountTotal = bills.reduce(function(sum,b){ return sum+b.amount; },0);
    var billsBreakdownHtml = '<div class="card"><h2>Bills breakdown</h2>'+
      '<div class="bar-row"><div class="bar-label"><span>Paid</span><span>'+money(billsPaidTotal)+'</span></div>'+
      '<div class="bar-track"><div class="bar-fill" style="width:'+(billsAmountTotal? Math.round(100*billsPaidTotal/billsAmountTotal):0)+'%;background:var(--status-paid);"></div></div></div>'+
      '<div class="bar-row"><div class="bar-label"><span>Overdue</span><span>'+money(billsOverdueTotal)+'</span></div>'+
      '<div class="bar-track"><div class="bar-fill" style="width:'+(billsAmountTotal? Math.round(100*billsOverdueTotal/billsAmountTotal):0)+'%;background:var(--status-overdue);"></div></div></div>'+
      '</div>';

    var byTenant = {};
    rentCharges.forEach(function(c){
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
          '<p style="font-size:11.5px;color:var(--text-faint);margin:8px 0 0;">Covers every rent period since move-in, not just the current one.</p>'
        : '<p style="font-size:13.5px;color:var(--text-dim);margin:0;">No rent charges yet — add a paying tenant to see a breakdown here.</p>')+
      '</div>';

    return pageHeader('Reports', 'Expected vs received rent, outstanding balances, bills and occupancy at a glance.') +
      statHtml + occupancyHtml + billsBreakdownHtml + tenantTableHtml;
  }

  /** "Profits" by property: what tenants pay (actual payments, not just what's
   *  billed) minus what the admin pays the real estate for that property, based on its
   *  frequency. In "All time" the lease expense is prorated over the months elapsed since
   *  that property's earliest move-in (or from today, if there are no tenants), since we
   *  don't store an actual lease start date — it's made clear that this is an estimate. */
  var profitsPeriod = 'month'; // 'month' | 'all'
  function setProfitsPeriod(p){ profitsPeriod = p; renderPreservingScroll(); }
  window.setProfitsPeriod = setProfitsPeriod;

  function monthlyLeaseCost(p){
    if (p.leasePaymentAmount == null) return 0;
    // Fortnightly ≈ 26.09 cycles per year (365.25/14) → divided over 12 months.
    return p.leasePaymentFrequency === 'fortnightly' ? p.leasePaymentAmount * (365.25/14) / 12 : p.leasePaymentAmount;
  }

  function renderProfits(){
    if (properties.length === 0){
      return pageHeader('Profits', "What tenants pay you vs what you pay the real estate, per property.") +
        emptyState('chart', 'Nothing to show yet', 'Once you add properties and tenants, profits will show up here.',
          '<a class="mini-btn primary" href="#/properties" style="display:inline-block;">Go to properties</a>');
    }
    var periodChipsHtml = '<div class="filter-chips" style="margin-bottom:10px;">'+
      '<button class="chip'+(profitsPeriod==='month'?' active':'')+'" onclick="setProfitsPeriod(\'month\')">This month</button>'+
      '<button class="chip'+(profitsPeriod==='all'?' active':'')+'" onclick="setProfitsPeriod(\'all\')">All time</button>'+
      '</div>';
    var monthStart = TODAY.slice(0,7)+'-01';

    var rows = properties.slice().sort(function(a,b){ return a.name.localeCompare(b.name); }).map(function(p){
      var propTenants = tenants.filter(function(t){ return t.propertyId===p.id; });
      var tenantIds = propTenants.map(function(t){ return t.id; });
      var propPayments = paymentRecords.filter(function(pay){ return tenantIds.indexOf(pay.tenantId) > -1; });
      var monthlyCost = monthlyLeaseCost(p);
      var income, expense, periodLabel;
      if (profitsPeriod === 'month'){
        income = propPayments.filter(function(pay){ return pay.date >= monthStart; }).reduce(function(s,pay){ return s+pay.amount; }, 0);
        expense = monthlyCost;
        periodLabel = 'this month';
      } else {
        income = propPayments.reduce(function(s,pay){ return s+pay.amount; }, 0);
        var earliestMoveIn = propTenants.reduce(function(min,t){ return (!min || t.moveInDate < min) ? t.moveInDate : min; }, null);
        var months = earliestMoveIn ? Math.max(1, daysBetween(earliestMoveIn, TODAY) / 30.44) : 0;
        expense = monthlyCost * months;
        periodLabel = 'all time (estimated)';
      }
      var profit = round2(income - expense);
      var hasLeaseCost = p.leasePaymentAmount != null;
      return '<div class="card"><div class="detail-head" style="margin-top:0;align-items:center;">'+
        '<h2 style="margin:0;"><a href="#/properties/'+p.id+'" style="color:inherit;text-decoration:none;">'+esc(p.name)+'</a></h2>'+
        '<div style="font-weight:700;font-size:15px;color:'+(profit<0?'var(--status-overdue)':'var(--status-paid)')+';">'+money(profit)+'</div>'+
        '</div>'+
        '<div class="field-list">'+
        '<div class="field-row"><span class="k">Rent collected</span><span class="v">'+money(income)+'</span></div>'+
        '<div class="field-row"><span class="k">Paid to real estate</span><span class="v">'+(hasLeaseCost ? money(expense) : '—')+'</span></div>'+
        '</div>'+
        '<p style="font-size:11px;color:var(--text-faint);margin:8px 0 0;">'+
        (hasLeaseCost ? 'Profit '+periodLabel+' = rent collected − lease cost.' : 'No lease amount set for this property, so this only shows rent collected.')+
        '</p></div>';
    }).join('');

    return pageHeader('Profits', "What tenants pay you vs what you pay the real estate, per property.") +
      periodChipsHtml + rows;
  }

  /* ---------- PHASE 13: Notifications ---------- */
  function notifId(e){ return e.kind + '|' + e.date + '|' + e.title; }
  function isNotifRead(e){ return notifReadIds.indexOf(notifId(e)) > -1; }
  function toggleNotifRead(id){
    var idx = notifReadIds.indexOf(id);
    if (idx > -1) notifReadIds.splice(idx, 1); else notifReadIds.push(id);
    saveNotifRead(notifReadIds);
    render();
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
        return '<div class="notif-row'+(n.isRead?' read':'')+'" style="padding:8px 0;">'+
          '<span style="min-width:0;flex:1;"><div style="font-weight:600;font-size:13.5px;">'+esc(n.title)+'</div>'+
          (n.body ? '<div class="meta" style="font-size:12px;color:var(--text-dim);">'+esc(n.body)+'</div>' : '')+
          '<div class="meta" style="font-size:11px;color:var(--text-faint);">'+shortDate((n.createdAt||'').slice(0,10))+'</div></span>'+
          (n.isRead ? '' : '<button class="notif-dot-btn" title="Mark as read" onclick="markDbNotifRead(\''+n.id+'\')"><span class="notif-dot unread"></span></button>')+
          '</div>';
      }).join('') + '</div>';

    return pageHeader('Notifications', 'Reminders for rent due dates, overdue payments, bills and move-in/out.') +
      dbNotifHtml +
      (unreadCount>0 ? '<p style="font-size:12.5px;color:var(--text-dim);margin:0 0 10px;">'+unreadCount+' unread</p>' : '') +
      rows +
      '<div class="card" style="margin-top:14px;"><h2 style="text-transform:none;letter-spacing:0;">About notifications</h2>'+
      "<p style=\"font-size:13px;color:var(--text-dim);margin:0;\">This is an in-app notification centre — check this screen when you open the app. Real push notifications (system alerts even when the app is closed) need a backend and browser permissions, and aren't available yet.</p></div>";
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
  var MAINTENANCE_STATUS_BADGE = { open:'due', in_progress:'neutral', resolved:'paid', closed:'neutral' };
  var MAINTENANCE_STATUS_LABEL = { open:'Open', in_progress:'In progress', resolved:'Resolved', closed:'Closed' };
  var MAINTENANCE_CATEGORY_LABEL = { plumbing:'Plumbing', electrical:'Electrical', appliance:'Appliance', pest_control:'Pest control', cleaning:'Cleaning', structural:'Structural', other:'Other' };

  function renderMaintenance(){
    var staff = isStaff();
    var rows = maintenanceRequests.slice().sort(function(a,b){ return (b.createdAt||'').localeCompare(a.createdAt||''); });
    var listHtml = rows.length === 0
      ? '<div class="card"><p style="font-size:13.5px;color:var(--text-dim);margin:0;">No maintenance requests yet.</p></div>'
      : rows.map(function(m){
          var p = propertyOf(m.propertyId);
          var r = m.roomId ? roomOf(m.roomId) : null;
          var t = m.tenantId ? tenantOf(m.tenantId) : null;
          return '<div class="card" style="cursor:pointer;" onclick="openMaintenanceModal(\''+m.id+'\')">'+
            '<div class="detail-head" style="margin-top:0;align-items:center;">'+
            '<h2 style="margin:0;font-size:14px;">'+esc(m.title)+'</h2>'+
            badge(MAINTENANCE_STATUS_BADGE[m.status]||'neutral', MAINTENANCE_STATUS_LABEL[m.status]||m.status)+
            '</div>'+
            '<p style="font-size:12.5px;color:var(--text-dim);margin:2px 0;">'+
            (p ? esc(p.name) : '') + (r ? ' · '+esc(r.name) : '') + (t ? ' · '+esc(t.fullName) : '') +
            '</p>'+
            '<p style="font-size:11.5px;color:var(--text-faint);margin:0;">'+
            (MAINTENANCE_CATEGORY_LABEL[m.category]||m.category) + ' · Priority: ' + m.priority + ' · ' + shortDate((m.createdAt||'').slice(0,10)) +
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
    var staff = isStaff();
    document.getElementById('maintenance-modal-title').textContent = m ? 'Maintenance request' : 'Report a problem';
    document.getElementById('maintenance-property-row').hidden = !staff;
    document.getElementById('maintenance-room-row').hidden = !staff;
    document.getElementById('maintenance-status-row').hidden = !(staff && m);
    if (staff){
      var propSelect = document.getElementById('maintenance-property');
      propSelect.innerHTML = properties.map(function(p){ return '<option value="'+p.id+'">'+esc(p.name)+'</option>'; }).join('');
      propSelect.value = m ? m.propertyId : (properties[0] ? properties[0].id : '');
      onMaintenancePropertyChange();
      if (m && m.roomId) document.getElementById('maintenance-room').value = m.roomId;
    }
    document.getElementById('maintenance-title').value = m ? m.title : '';
    document.getElementById('maintenance-title').disabled = !!(m && !staff);
    document.getElementById('maintenance-description').value = m ? (m.description||'') : '';
    document.getElementById('maintenance-description').disabled = !!(m && !staff);
    document.getElementById('maintenance-category').value = m ? m.category : 'other';
    document.getElementById('maintenance-category').disabled = !!(m && !staff);
    document.getElementById('maintenance-priority').value = m ? m.priority : 'normal';
    document.getElementById('maintenance-priority').disabled = !!(m && !staff);
    document.getElementById('maintenance-status').value = m ? m.status : 'open';
    document.getElementById('maintenance-photo').value = '';
    var photoRow = document.getElementById('maintenance-photo').closest('.form-row');
    if (photoRow) photoRow.hidden = !!(m && !staff);
    document.getElementById('maintenance-modal-error').hidden = true;
    document.getElementById('maintenance-modal').hidden = false;
    var saveBtn = document.querySelector('#maintenance-modal .mini-btn.primary');
    if (saveBtn) saveBtn.hidden = !!(m && !staff);
  }
  window.openMaintenanceModal = openMaintenanceModal;

  function closeMaintenanceModal(){
    document.getElementById('maintenance-modal').hidden = true;
    maintenanceModalEditId = null;
  }
  window.closeMaintenanceModal = closeMaintenanceModal;

  async function saveMaintenanceForm(){
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
      tenantId = existing ? existing.tenantId : null;
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

    var photoFile = document.getElementById('maintenance-photo').files[0];
    var saveBtn = document.querySelector('#maintenance-modal .mini-btn.primary');
    var originalLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    errorEl.hidden = true;
    try {
      var photoPath = existing ? existing.photoPath : null;
      if (photoFile){
        photoPath = await storageService.uploadMaintenancePhoto(photoFile);
      }
      var draft = { propertyId:propertyId, roomId:roomId, tenantId:tenantId, title:title, description:description,
        category:category, priority:priority, photoPath:photoPath, status: existing ? status : 'open',
        assignedTo: existing ? existing.assignedTo : null };
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
      }
      closeMaintenanceModal();
      showToast('Maintenance request saved.', 'success');
      render();
    } catch(err){
      errorEl.textContent = friendlyErrorMessage(err);
      errorEl.hidden = false;
    } finally {
      if (saveBtn){ saveBtn.disabled = false; saveBtn.textContent = originalLabel; }
    }
  }
  window.saveMaintenanceForm = saveMaintenanceForm;

  /* ============ Users (Super Admin only) ============ */
  var ROLE_LABEL = { super_admin:'Super Admin', administrator:'Administrator', tenant:'Tenant' };

  function renderUsers(){
    if (!isSuperAdmin()) return accessDeniedPage();
    var rows = allProfiles.map(function(p){
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
      (rows || '<div class="card"><p style="font-size:13.5px;color:var(--text-dim);margin:0;">No users yet.</p></div>');
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
      render();
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
      window.open('https://wa.me/' + digits + '?text=' + encodeURIComponent(message), '_blank', 'noopener');
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
  function renderTenantDashboard(){
    var t = myTenantRecord();
    if (!t) return pageHeader('My Dashboard', '') + '<div class="card"><p style="font-size:13.5px;color:var(--text-dim);margin:0;">Your account isn\'t linked to a tenant record yet — ask your Super Admin.</p></div>';
    var p = propertyOf(t.propertyId);
    var r = t.roomId ? roomOf(t.roomId) : null;
    var myPayments = paymentRecords.filter(function(x){ return x.tenantId===t.id; }).sort(function(a,b){ return (b.paymentDate||'').localeCompare(a.paymentDate||''); });
    var latestPayment = myPayments[0];
    var myAllocations = [];
    bills.forEach(function(b){
      if (isTenantHiddenProvider(b.provider)) return;
      (b.allocations||[]).forEach(function(a){ if (a.tenantId===t.id) myAllocations.push({ bill:b, alloc:a }); });
    });
    var outstanding = myAllocations.filter(function(x){ return !x.alloc.paid; }).reduce(function(s,x){ return s+x.alloc.amount; }, 0);
    return pageHeader('My Dashboard', 'Welcome back, '+esc(t.fullName)+'.') +
      '<div class="card">'+
      '<div class="field-row"><span class="k">Property</span><span class="v">'+(p?esc(p.name):'—')+'</span></div>'+
      '<div class="field-row"><span class="k">Room</span><span class="v">'+(r?esc(r.name):'—')+'</span></div>'+
      '<div class="field-row"><span class="k">Rent</span><span class="v">'+money(t.rentAmount)+' / '+esc(t.rentFrequency)+'</span></div>'+
      '<div class="field-row"><span class="k">Outstanding bill balance</span><span class="v">'+money(outstanding)+'</span></div>'+
      (latestPayment ? '<div class="field-row"><span class="k">Latest payment</span><span class="v">'+money(latestPayment.amount)+' on '+shortDate(latestPayment.paymentDate)+'</span></div>' : '')+
      '</div>'+
      tenantRentHistoryHtml(t.id);
  }

  function renderTenantPayments(){
    var t = myTenantRecord();
    var rows = t ? paymentRecords.filter(function(x){ return x.tenantId===t.id; }).sort(function(a,b){ return (b.paymentDate||'').localeCompare(a.paymentDate||''); }) : [];
    var body = rows.length === 0
      ? '<div class="card"><p style="font-size:13.5px;color:var(--text-dim);margin:0;">No payments recorded yet.</p></div>'
      : rows.map(function(pmt){
          return '<div class="card"><div class="field-row"><span class="k">'+shortDate(pmt.paymentDate)+'</span><span class="v">'+money(pmt.amount)+'</span></div></div>';
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
          return '<div class="card">'+
            '<div class="detail-head" style="margin-top:0;align-items:center;"><h2 style="margin:0;font-size:14px;">'+esc(billTypeLabel(b.billType))+(b.provider?' — '+esc(b.provider):'')+'</h2>'+
            badge(a.paid?'paid':'due', a.paid?'Paid':'Pending')+'</div>'+
            '<div class="field-list">'+
            '<div class="field-row"><span class="k">Total bill</span><span class="v">'+money(b.amount)+'</span></div>'+
            '<div class="field-row"><span class="k">Your share</span><span class="v">'+money(a.amount)+'</span></div>'+
            '<div class="field-row"><span class="k">Period</span><span class="v">'+shortDate(b.billingPeriodStart)+' – '+shortDate(b.billingPeriodEnd)+'</span></div>'+
            (b.dueDate ? '<div class="field-row"><span class="k">Due date</span><span class="v">'+shortDate(b.dueDate)+'</span></div>' : '')+
            (a.paid && a.paidDate ? '<div class="field-row"><span class="k">Paid on</span><span class="v">'+shortDate(a.paidDate)+'</span></div>' : '')+
            '</div>'+
            (b.receiptPath ? '<button class="mini-btn" style="margin-top:10px;" onclick="viewTenantBillReceipt(\''+b.id+'\', this)">View invoice</button>' : '')+
            '</div>';
        }).join('');
      return '<h3 style="font-size:12.5px;text-transform:none;letter-spacing:0;color:var(--text-dim);margin:16px 0 8px;">'+(ym==='unknown'?'No date on file':esc(monthYearLabel(ym)))+'</h3>'+rowsHtml;
    }).join('');
    return pageHeader('My Bills', 'Your share of each shared bill — electricity, water, gas, internet and more.') + body;
  }

  function renderTenantDocuments(){
    var t = myTenantRecord();
    var myDocs = t ? tenantDocuments.filter(function(d){ return d.tenantId===t.id; }) : [];
    var body = myDocs.length === 0
      ? '<div class="card"><p style="font-size:13.5px;color:var(--text-dim);margin:0;">No documents uploaded yet.</p></div>'
      : myDocs.map(function(d){
          return '<div class="card"><div class="field-row"><span class="k">'+esc(d.fileName||d.docType)+'</span>'+
            '<span class="v"><button class="text-link" onclick="viewReceipt(\'documents\',\''+d.storagePath+'\')">View</button></span></div></div>';
        }).join('');
    return pageHeader('My Documents', 'Your rental agreement, receipts and other files.') + body;
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
        whatsappGroupLink:whatsappGroupLink,
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
    var errorEl = document.getElementById('tenant-modal-error');

    if (!fullName || !propertyId || !roomId || !moveInDate || !isFinite(rentAmount) || rentAmount<0 || !isFinite(paymentDay)){
      errorEl.textContent = 'Add a name, property, room, move-in date and a valid rent amount (0 or more).';
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
      rentAmount:rentAmount, rentFrequency:rentFrequency, paymentDay:paymentDay, excludedBillTypes:excludedBillTypes };
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
      showToast('Tenant saved successfully.', 'success');
      location.hash = '#/tenants/' + tenantObj.id;
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
  function openBondModal(tenantId){
    bondModalTenantId = tenantId;
    var b = bondOf(tenantId);
    document.getElementById('bond-modal-title').textContent = b ? 'Edit bond' : 'Add bond';
    document.getElementById('bond-required').value = b ? b.amountRequired : '';
    document.getElementById('bond-paid').value = b ? b.amountPaid : 0;
    document.getElementById('bond-returned').value = b ? b.amountReturned : 0;
    document.getElementById('bond-deduction').value = b ? b.deduction : 0;
    document.getElementById('bond-status').value = b ? b.status : 'pending';
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
    var deduction = parseFloat(document.getElementById('bond-deduction').value);
    if (!isFinite(paid)) paid = 0;
    if (!isFinite(returned)) returned = 0;
    if (!isFinite(deduction)) deduction = 0;
    var status = document.getElementById('bond-status').value;
    var errorEl = document.getElementById('bond-modal-error');
    if (!isFinite(required) || required<0 || !isFinite(paid) || paid<0 || returned<0 || deduction<0){
      errorEl.textContent = 'All amounts must be 0 or more.';
      errorEl.hidden = false;
      return;
    }
    var draft = { tenantId: bondModalTenantId, amountRequired:required, amountPaid:paid, amountReturned:returned, deduction:deduction, status:status };
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
    var all = propMatches.concat(tenantMatches);
    box.innerHTML = all.length
      ? all.join('')
      : '<div class="search-empty">No properties or tenants match "'+esc(query.trim())+'".</div>';
  }
  window.openSearchModal = openSearchModal;
  window.closeSearchModal = closeSearchModal;
  window.runSearch = runSearch;
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && !document.getElementById('search-modal').hidden) closeSearchModal();
  });

  var STAFF_ROUTES = {
    '#/': renderDashboard,
    '#/properties': renderProperties,
    '#/tenants': renderTenants,
    '#/payments': renderPayments,
    '#/bills': renderBills,
    '#/maintenance': renderMaintenance,
    '#/calendar': renderCalendar,
    '#/reports': renderReports,
    '#/profits': renderProfits,
    '#/documents': renderDocuments,
    '#/notifications': renderNotifications,
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
    '#/notifications': renderNotifications,
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
    if (propertyMatch) html = renderPropertyDetail(decodeURIComponent(propertyMatch[1]));
    else if (tenantMatch) html = renderTenantDetail(decodeURIComponent(tenantMatch[1]));
    else if (billMatch) html = renderBillDetail(decodeURIComponent(billMatch[1]));
    else html = (ROUTES[hash] || ROUTES['#/'])();
    content.innerHTML = html;
    setActiveNav(hash);
    if (!preserveScroll) window.scrollTo(0,0);
  }
  /** Same as render(), but without scrolling back to the top — for actions like changing a
   *  table's sort order or a filter, where the user wants to keep looking at what they were already viewing. */
  function renderPreservingScroll(){
    var y = window.scrollY;
    render(true);
    window.scrollTo(0, y);
  }
  /* ============ Async bootstrap: load everything from Supabase in parallel, then render ============ */
  async function bootstrapData(){
    var results = await Promise.all([
      propertyService.getAll(),
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
      recurringBillService.getAll()
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
    if (isSuperAdmin()){
      try { allProfiles = await profileService.getAll(); } catch(_e){ allProfiles = []; }
      try { propertyAssignments = await profileService.getPropertyAssignments(); } catch(_e){ propertyAssignments = []; }
    }
    try { await generateDueRecurringBills(); } catch(_e){ console.error('generateDueRecurringBills failed', _e); }
    try { await checkMissingBillsNotifications(); } catch(_e){ console.error('checkMissingBillsNotifications failed', _e); }
    recomputeRentCharges();
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
    try {
      await profileService.sendPasswordReset(rawInput);
      errorEl.textContent = 'Check your email for a link to reset your password.';
      errorEl.hidden = false;
    } catch(err){
      errorEl.textContent = friendlyErrorMessage(err);
      errorEl.hidden = false;
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