// app.js — orchestration layer: auth gate, initial async load from Supabase,
// render()/router wiring. Business logic and rendering below are adapted
// from artifact/index.html, preserved as closely as possible; the main
// structural change is that persistence now goes through the async
// services/* modules instead of synchronous localStorage.
import * as auth from './lib/auth.js';
import { friendlyErrorMessage } from './lib/errors.js';
import * as propertyService from './services/propertyService.js';
import * as roomService from './services/roomService.js';
import * as tenantService from './services/tenantService.js';
import * as bondService from './services/bondService.js';
import * as rentScheduleService from './services/rentScheduleService.js';
import * as paymentService from './services/paymentService.js';
import * as billService from './services/billService.js';
import * as billAllocationService from './services/billAllocationService.js';
import * as tenantDocumentService from './services/tenantDocumentService.js';
import * as storageService from './services/storageService.js';
import * as aiService from './services/aiService.js?v=2';
import * as migrationService from './services/migrationService.js';

(function(){
  "use strict";

  /* ============ "Today" — the real current date, computed once at load ============ */
  var TODAY = toIsoLocal(new Date());

  /* ============ In-memory data, populated by bootstrapData() after sign-in ============ */
  var properties = [];
  var rooms = [];
  var tenants = [];
  var bonds = [];
  /**
   * Convierte un objeto Date (construido en hora LOCAL, p.ej. con
   * `new Date(iso+'T00:00:00')`) de vuelta a 'YYYY-MM-DD' usando sus
   * componentes locales. `toISOString()` NO sirve para esto: convierte a
   * UTC primero, así que en cualquier zona horaria con offset positivo
   * (Perth, UTC+8, por ejemplo) una fecha calculada como "30 de septiembre
   * medianoche local" se convierte a "29 de septiembre, 16:00 UTC" y el
   * slice(0,10) devuelve el día equivocado. Todo el cálculo de fechas de la
   * app (rent periods, dueDates, extracción de bills) pasa por aquí.
   */
  function toIsoLocal(d){
    var y = d.getFullYear();
    var m = String(d.getMonth()+1).padStart(2,'0');
    var day = String(d.getDate()).padStart(2,'0');
    return y+'-'+m+'-'+day;
  }

  /** Suma `days` días HÁBILES (de lunes a viernes, sin contar feriados) a una fecha 'YYYY-MM-DD'.
   *  Se usa para calcular una fecha límite de pago por defecto cuando un bill importado con IA
   *  no trae due date impresa/legible — 10 días hábiles después de la fecha de emisión, en vez
   *  de dejar el campo vacío y bloquear el guardado. */
  function addBusinessDays(isoDate, days){
    var d = new Date(isoDate+'T00:00:00');
    var added = 0;
    while (added < days){
      d.setDate(d.getDate()+1);
      var dow = d.getDay(); // 0=domingo, 6=sábado
      if (dow !== 0 && dow !== 6) added++;
    }
    return toIsoLocal(d);
  }

  /**
   * rentService — genera rent charges a partir de un RentSchedule.
   * Aislado del resto de la lógica (sección 35 del brief: servicios propios
   * para "Rent calculations").
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
     * Genera TODOS los periodos desde `schedule.startDate` hasta el primer
     * periodo que empieza después de `asOfIso` (un único periodo "futuro"),
     * respetando la fecha de salida del inquilino si existe (sección 32:
     * nunca generar cargos para cuando el inquilino ya no vive ahí).
     */
    function generateAllPeriods(schedule, tenant, asOfIso){
      var periods = [];
      var cutoff = tenant.actualMoveOutDate || tenant.expectedMoveOutDate || null;
      var cursor = schedule.startDate;
      while (true){
        if (cutoff && cursor > cutoff) break;
        var end = schedule.frequency === 'monthly'
          ? stepDate(addMonths(cursor, 1), -1)
          : stepDate(cursor, periodLengthDays(schedule.frequency) - 1);
        // El alquiler se paga POR ADELANTADO: lo que corresponde a un periodo se debe pagar
        // desde el primer día de ese periodo, no al final — por eso dueDate = periodStart, no
        // periodEnd. Así, si el move-in fue ayer, hoy ese periodo ya aparece "overdue" (1 día
        // atrasado) en vez de esperar a que termine toda la semana/quincena/mes.
        periods.push({ periodStart: cursor, periodEnd: end, dueDate: cursor });
        if (cursor > asOfIso) break;
        cursor = schedule.frequency === 'monthly' ? addMonths(cursor, 1) : stepDate(cursor, periodLengthDays(schedule.frequency));
      }
      return periods;
    }

    function computeStatus(period, amountPaid, remaining, asOfIso){
      if (remaining <= 0.004) return 'paid';
      if (amountPaid > 0) return 'partially_paid';
      if (period.dueDate < asOfIso) return 'overdue';
      if (period.periodStart > asOfIso) return 'upcoming';
      return 'due';
    }

    /** Reparte los pagos de un inquilino contra TODOS sus periodos desde el move-in (no solo
     *  una ventana reciente), en orden cronológico (FIFO), para que cada semana/quincena
     *  atrasada aparezca como su propia fila en Payments. */
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
        var need = amountDue, amountPaid = 0;
        while (need > 0.004 && payIdx < pays.length){
          var take = Math.min(need, payLeft);
          amountPaid += take; need -= take; payLeft -= take;
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
          status: computeStatus(period, amountPaid, remaining, asOfIso)
        };
      });
    }

    return { generateChargesForTenant: generateChargesForTenant };
  })();

  /**
   * FASE 8 — OCR/AI bill extraction (sección de "Import Bill" del brief):
   * la foto/PDF de la factura se envía a la Edge Function `analyze-bill`
   * (services/aiService.js), que llama a Gemini (Google) del lado del
   * servidor para leer el documento de verdad — proveedor, tipo, fechas,
   * importe, y una propiedad sugerida por coincidencia de dirección/nombre
   * contra las propiedades existentes. La clave de la API vive como secret
   * de la Edge Function, nunca en el frontend. El resultado sigue pasando
   * por la misma pantalla de revisión de siempre (cola -> "analizando" ->
   * revisar/editar -> confirmar), así que un error o un dato mal leído
   * siempre se corrige a mano antes de guardar.
   */

  /**
   * FASE 4 — Rent system (sección 9 del brief): los rent charges ya NO se
   * escriben a mano. `rentService` (más abajo) los genera automáticamente a
   * partir de un `RentSchedule` por inquilino (frecuencia, importe, fecha de
   * inicio), aplicando los pagos registrados en orden cronológico (FIFO) para
   * derivar amountPaid/remaining/status. Se genera UN periodo por cada
   * semana/quincena/mes desde el move-in hasta hoy (más uno futuro) — no solo
   * los últimos 3 — para que un inquilino atrasado varios meses muestre cada
   * semana pendiente por separado en Payments, y el administrador sepa
   * exactamente cuál semana está cancelando en cada pago.
   */
  var rentSchedules = [];
  var paymentRecords = [];

  /* ---------- FASE 13: Notifications (estado leído/no-leído persistido; solo estado de UI local, no datos de negocio) ---------- */
  var NOTIF_READ_KEY = 'belmont-manager-notif-read-v1';
  function loadNotifRead(){
    try { var raw = localStorage.getItem(NOTIF_READ_KEY); if (raw) return JSON.parse(raw); } catch(e){ /* ignorar */ }
    return [];
  }
  function saveNotifRead(list){ try { localStorage.setItem(NOTIF_READ_KEY, JSON.stringify(list)); } catch(e){ /* ignorar */ } }
  var notifReadIds = loadNotifRead();

  var rentCharges = [];
  function recomputeRentCharges(){
    rentCharges = tenants
      .filter(function(t){ return t.rentAmount > 0; })
      .reduce(function(acc, t){
        var schedule = rentSchedules.find(function(s){ return s.tenantId===t.id; });
        return acc.concat(rentService.generateChargesForTenant(t, schedule, TODAY, paymentRecords));
      }, [])
      .sort(function(a,b){ return a.periodStart.localeCompare(b.periodStart); });
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
  /** Deshace un pago recién registrado (atajo desde el "Undo" del toast) — para cuando el
   *  administrador se equivocó de fecha, o confirmó un pago que en realidad no se hizo. La
   *  misma corrección también está disponible más tarde desde "View history" (✕ o ✎). */
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
  /** Paga esta charge y cualquier periodo anterior sin pagar del mismo inquilino (el ledger es FIFO).
   *  `date` es la fecha REAL en que el inquilino pagó (puede ser de hace varios días) — no siempre
   *  hoy, por eso openChargePaidModal la pide en vez de asumir TODAY directamente. */
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
    if (amount > charge.remaining) amount = charge.remaining; // no se admite sobrepago
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

  /* ============ dashboardService (misma lógica que src/services/dashboardService.ts) ============ */
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
  /** Cuotas individuales de bills todavía sin pagar cuyo bill ya está vencido (para el dashboard y, más adelante, Reports). */
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
    // Un inquilino atrasado varios meses ahora tiene muchos periodos overdue en rentCharges
    // (uno por semana/quincena, ver generateChargesForTenant) — "Needs attention" se queda con
    // el más reciente de cada inquilino para no repetir una fila por cada semana; el desglose
    // completo semana por semana vive en Payments (con el filtro por tenant).
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
          daysOverdue: c.status==='overdue' ? Math.max(0, daysBetween(c.dueDate, TODAY)) : 0
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
    return rentItems.concat(billItems);
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
   * FASE 10 — Calendar (sección del brief): en vez de una lista de eventos
   * escrita a mano, los eventos del calendario se DERIVAN de los mismos
   * datos que ya generan Payments y Bills (rent charges, bills, tenants),
   * igual que rentService genera los rent charges a partir del schedule.
   * Así el calendario nunca puede quedar desincronizado de un pago
   * registrado o un bill marcado como pagado.
   */
  function buildCalendarEvents(){
    var events = [];
    rentCharges.forEach(function(c){
      if (c.status === 'paid') return; // ya resuelto, no aporta al calendario
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
        // Un bill ya repartido: un evento por CADA cuota de inquilino sin pagar,
        // en vez de un único evento genérico (así cada inquilino ve lo que le toca).
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
      if (t.rentAmount <= 0) return; // owner: no genera eventos de tenancy
      events.push({ date: t.moveInDate, kind: 'move', title: t.fullName + ' — Move-in', href: '#/tenants/' + t.id });
      var moveOut = t.actualMoveOutDate || t.expectedMoveOutDate;
      if (moveOut) events.push({ date: moveOut, kind: 'move', title: t.fullName + ' — Move-out', href: '#/tenants/' + t.id });
    });
    return events;
  }
  function pad2(n){ return n < 10 ? '0'+n : ''+n; }
  /** Cuadrícula de un mes calendario ('YYYY-MM'): null = celda vacía de relleno; Lunes como primer día de la semana. */
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
    inbox:'<path d="M4 12h4l2 3h4l2-3h4"/><path d="M5.5 5h13l3 7v8a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1v-8z"/>'
  };
  function svg(name, extra){
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'+(extra?' '+extra:'')+'>'+ICONS[name]+'</svg>';
  }

  /* ============ Navegación ============ */
  var NAV = [
    { hash:'#/', label:'Dashboard', icon:'dashboard', primary:true },
    { hash:'#/properties', label:'Properties', icon:'building', primary:true },
    { hash:'#/tenants', label:'Tenants', icon:'tenants', primary:true },
    { hash:'#/payments', label:'Payments', icon:'payments', primary:true },
    { hash:'#/bills', label:'Bills', icon:'receipt', primary:false },
    { hash:'#/calendar', label:'Calendar', icon:'calendar', primary:false },
    { hash:'#/reports', label:'Reports', icon:'chart', primary:false },
    { hash:'#/documents', label:'Documents', icon:'document', primary:false },
    { hash:'#/notifications', label:'Notifications', icon:'bell', primary:false },
    { hash:'#/settings', label:'Settings', icon:'settings', primary:false }
  ];
  var MORE = { hash:'#/more', label:'More', icon:'more' };

  var sidebarNav = document.getElementById('sidebar-nav');
  sidebarNav.innerHTML = NAV.map(function(item){
    return '<a href="'+item.hash+'" data-hash="'+item.hash+'">'+svg(item.icon)+item.label+'</a>';
  }).join('');

  var bottomNav = document.getElementById('bottom-nav');
  bottomNav.innerHTML = NAV.filter(function(i){ return i.primary; }).map(function(item){
    return '<a href="'+item.hash+'" data-hash="'+item.hash+'">'+svg(item.icon)+item.label+'</a>';
  }).join('') + '<a href="'+MORE.hash+'" data-hash="'+MORE.hash+'" data-more="1">'+svg(MORE.icon)+MORE.label+'</a>';

  var importPickerBtns = document.querySelectorAll('#import-modal-picker .import-option');
  var IMPORT_OPTIONS = [
    ['camera','Take a photo'],
    ['gallery','Choose from photos'],
    ['pdf','Upload PDF']
  ];
  importPickerBtns.forEach(function(btn, i){
    var opt = IMPORT_OPTIONS[i];
    btn.innerHTML = svg(opt[0]==='pdf' ? 'document' : opt[0]) + '<span>'+opt[1]+'</span>';
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

  /* ============ Páginas ============ */
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
  /** Estado para un id de ruta dinámica que ya no existe (borrado, o link desactualizado). */
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
  function propertyOf(id){ return properties.find(function(p){ return p.id===id; }); }
  function tenantOf(id){ return tenants.find(function(t){ return t.id===id; }); }
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
      '<button class="mini-btn" onclick="openPropertyModal(\''+p.id+'\')">Edit property</button>'+
      '<button class="mini-btn danger" onclick="deletePropertyConfirm(\''+p.id+'\')">Delete property</button>'+
      '</div>'+
      '<div class="card"><div class="field-list">'+
      '<div class="field-row"><span class="k">Bedrooms</span><span class="v">'+p.bedrooms+'</span></div>'+
      '<div class="field-row"><span class="k">Bathrooms</span><span class="v">'+p.bathrooms+'</span></div>'+
      (p.notes ? '<div class="field-row"><span class="k">Notes</span><span class="v" style="font-weight:400;">'+esc(p.notes)+'</span></div>' : '')+
      '</div></div>'+
      '<div class="card"><div class="detail-head" style="margin-top:0;align-items:center;"><h2 style="margin:0;">Rooms</h2>'+
      '<button class="mini-btn primary" onclick="openRoomModal(\''+p.id+'\')">+ Add room</button></div>'+roomsHtml+'</div>'+
      '<div class="card"><h2>Bills</h2>'+
      (propBills.length===0
        ? '<p style="font-size:13.5px;color:var(--text-dim);margin:0;">No bills recorded for this property yet.</p>'
        : propBills.map(billCard).join(''))+
      '</div>';
  }

  function renderTenants(){
    var paying = tenants.filter(function(t){ return t.rentAmount>0; });
    var header = '<div class="detail-head" style="align-items:center;">'+
      pageHeader('Tenants', 'Everyone renting from you, and their lease details.')+
      '<button class="mini-btn primary" style="white-space:nowrap;" onclick="openTenantModal()">+ Add tenant</button></div>';
    if (paying.length === 0){
      return header + emptyState('tenants', 'No tenants yet',
        properties.length === 0
          ? 'Add a property and a room first, then add your first tenant.'
          : 'Add a tenant to start tracking rent, bonds and move-in dates.',
        properties.length === 0
          ? '<a class="mini-btn primary" href="#/properties" style="display:inline-block;">Go to properties</a>'
          : '<button class="mini-btn primary" onclick="openTenantModal()">+ Add tenant</button>');
    }
    var rows = paying.map(function(t){
      var p = propertyOf(t.propertyId);
      return '<a class="card" style="display:block;text-decoration:none;color:inherit;" href="#/tenants/'+t.id+'">'+
        '<div class="row" style="border:none;padding:0;">'+
        '<div class="who"><div class="name">'+esc(t.fullName)+'</div>'+
        '<div class="meta">'+esc(p?p.name:'')+' • Since '+shortDate(t.moveInDate)+'</div></div>'+
        '<div class="amount">$'+t.rentAmount+'<br/><span style="font-weight:400;color:var(--text-faint);text-transform:capitalize;font-size:11.5px;">'+t.rentFrequency+'</span></div>'+
        '</div></a>';
    }).join('');
    return header + rows;
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
    if (t.actualMoveOutDate && t.actualMoveOutDate <= TODAY) tenancyBadge = badge('move', 'Moved out');
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
      (currentCharge ? '<div class="field-row"><span class="k">Current charge</span><span class="v">'+chargeStatusBadge(currentCharge)+'</span></div>' : '')
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
      '<button class="mini-btn danger" onclick="deleteTenantConfirm(\''+t.id+'\')">Delete tenant</button>'+
      '</div>'+
      '<div class="card"><h2>Contact</h2><div class="field-list">'+contactRows+'</div></div>'+
      (rentRows ? '<div class="card"><h2>Rent</h2><div class="field-list">'+rentRows+'</div></div>' : '') +
      (bondRows ? '<div class="card"><h2>Bond</h2><div class="field-list">'+bondRows+'</div></div>' : '') +
      '<div class="card"><h2>Dates</h2><div class="field-list">'+datesRows+'</div></div>'+
      (t.notes ? '<div class="card"><h2>Notes</h2><p style="margin:0;font-size:13.5px;color:var(--text-dim);">'+esc(t.notes)+'</p></div>' : '');
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
  /** Estado efectivo de un bill: si sigue pendiente y ya pasó su fecha de vencimiento, se muestra como overdue. */
  function billEffectiveStatus(b){
    if (b.status === 'paid') return 'paid';
    if (b.dueDate && b.dueDate < TODAY) return 'overdue';
    return b.status;
  }
  /**
   * Importe de un bill que ya está realmente cobrado: si tiene allocations,
   * la suma de las cuotas marcadas como pagadas (soporta pago parcial); si
   * no tiene allocations, el importe completo solo si el bill entero está
   * marcado 'paid' a mano (comportamiento histórico, sin allocations no hay
   * nada más fino que mostrar).
   */
  function billPaidAmount(b){
    if (b.allocations && b.allocations.length){
      return round2(b.allocations.filter(function(a){ return a.paid; }).reduce(function(s,a){ return s+a.amount; }, 0));
    }
    return b.status === 'paid' ? b.amount : 0;
  }
  /** Lo que falta por cobrar de un bill (importe total menos lo ya pagado, nunca negativo). */
  function billOutstandingAmount(b){
    return Math.max(0, round2(b.amount - billPaidAmount(b)));
  }
  function billStatusBadge(b){
    var map = { paid:['paid','Paid'], pending:['due','Pending'], overdue:['overdue','Overdue'], allocated:['upcoming','Allocated'],
      partially_allocated:['due','Partially Allocated'], partially_paid:['due','Partially Paid'] };
    var m = map[billEffectiveStatus(b)] || ['neutral', b.status];
    return badge(m[0], m[1]);
  }
  /** El cargo "actual" es el que contiene hoy; si no hay ninguno, el próximo futuro; si no, el último pasado. */
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
  var PAYMENTS_FILTERS = [['all','All'], ['paid','Paid'], ['due','Due'], ['overdue','Overdue']];
  function setPaymentsFilter(f){ paymentsFilter = f; render(); }
  function setPaymentsTenantFilter(tenantId){ paymentsTenantFilter = tenantId; render(); }
  function chargeMatchesFilter(c, filter){
    if (filter==='paid') return c.status==='paid';
    if (filter==='overdue') return c.status==='overdue';
    if (filter==='due') return c.status==='due' || c.status==='partially_paid';
    return true; // 'all' — incluye también 'upcoming', que no tiene chip propio
  }

  /** Cada obligación de bill pendiente de un inquilino (para mostrarla junto a su alquiler en Payments). */
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

  function renderPayments(){
    var expected = rentCharges.reduce(function(s,c){ return s+c.amountDue; },0);
    var received = rentCharges.reduce(function(s,c){ return s+c.amountPaid; },0);
    var outstanding = rentCharges.reduce(function(s,c){ return s+c.remaining; },0);

    var statHtml = '<div class="stat-grid cols-3">'+
      '<div class="stat"><div class="label">Expected</div><div class="value">'+money(expected)+'</div></div>'+
      '<div class="stat"><div class="label">Received</div><div class="value">'+money(received)+'</div></div>'+
      '<div class="stat"><div class="label">Outstanding</div><div class="value'+(outstanding>0?' warn':'')+'">'+money(outstanding)+'</div></div>'+
      '</div>';

    var chipsHtml = '<div class="filter-chips">' + PAYMENTS_FILTERS.map(function(f){
      return '<button class="chip'+(paymentsFilter===f[0]?' active':'')+'" onclick="setPaymentsFilter(\''+f[0]+'\')">'+f[1]+'</button>';
    }).join('') + '</div>';

    var tenantOptions = '<option value="all"'+(paymentsTenantFilter==='all'?' selected':'')+'>All tenants</option>'+
      tenants.slice().sort(function(a,b){ return a.fullName.localeCompare(b.fullName); }).map(function(t){
        return '<option value="'+t.id+'"'+(paymentsTenantFilter===t.id?' selected':'')+'>'+esc(t.fullName)+'</option>';
      }).join('');
    var tenantFilterHtml = '<div style="margin:10px 0;">'+
      '<label style="font-size:11.5px;color:var(--text-faint);display:block;margin-bottom:4px;">Filter by tenant</label>'+
      '<select class="modal-input" style="max-width:280px;" onchange="setPaymentsTenantFilter(this.value)">'+tenantOptions+'</select>'+
      '</div>';

    var charges = paymentsTenantFilter==='all' ? rentCharges : rentCharges.filter(function(c){ return c.tenantId===paymentsTenantFilter; });
    var filtered = charges.filter(function(c){ return chargeMatchesFilter(c, paymentsFilter); });

    var rows = filtered.length===0
      ? (rentCharges.length===0
          ? emptyState('payments', 'No rent charges yet',
              'Add a tenant with a rent amount and charges will show up here automatically.',
              '<a class="mini-btn primary" href="#/tenants" style="display:inline-block;">Go to tenants</a>')
          : emptyState('payments', 'Nothing in this filter', 'Try a different filter, or choose "All" to see every charge.', ''))
      : filtered.map(function(c){
          var t = tenantOf(c.tenantId);
          var actions = c.status !== 'paid'
            ? '<div style="display:flex;gap:8px;margin-top:10px;">'+
              '<button class="mini-btn primary" onclick="openChargePaidModal(\''+c.id+'\')">Mark as Paid</button>'+
              '<button class="mini-btn" onclick="openPartialModal(\''+c.id+'\')">Partial payment</button>'+
              '</div>'
            : '';
          return '<div class="card">'+
            '<div class="row" style="border:none;padding:0;">'+
            '<div class="who"><div class="name">'+esc(t?t.fullName:'')+'</div>'+
            '<div class="meta">'+shortDate(c.periodStart)+' – '+shortDate(c.periodEnd)+'</div></div>'+
            '<div class="amount">'+money(c.remaining)+'<br/>'+chargeStatusBadge(c)+'</div>'+
            '</div>'+actions+
            '<button class="text-link" onclick="openHistoryModal(\''+c.tenantId+'\')">View history</button>'+
            '</div>';
        }).join('');

    // Bills each tenant still owes a share of — surfaced here too so payments and bill
    // obligations don't live in two disconnected tabs.
    var relevantTenants = paymentsTenantFilter==='all' ? tenants : tenants.filter(function(t){ return t.id===paymentsTenantFilter; });
    var billRows = relevantTenants.reduce(function(acc, t){
      var owed = unpaidBillAllocationsFor(t.id);
      if (!owed.length) return acc;
      var rowsHtml = owed.map(function(o){
        var b = o.bill, a = o.alloc;
        var overdue = b.dueDate && b.dueDate < TODAY;
        return '<div class="alloc-summary-row" style="align-items:center;flex-wrap:wrap;">'+
          '<div class="who"><div>'+esc(b.provider)+'</div><div class="meta">'+(b.dueDate?('Due '+shortDate(b.dueDate)):'No due date')+'</div></div>'+
          '<div style="display:flex;align-items:center;gap:10px;">'+
          (overdue ? badge('overdue','Overdue') : badge('due','Unpaid'))+
          '<b>'+money(a.amount)+'</b>'+
          '<button class="mini-btn primary" onclick="openAllocPaidModal(\''+b.id+'\',\''+t.id+'\')">Mark as paid</button>'+
          '</div></div>';
      }).join('');
      acc.push('<div class="card"><div class="who" style="margin-bottom:6px;"><div class="name">'+esc(t.fullName)+'</div></div>'+rowsHtml+'</div>');
      return acc;
    }, []);
    var billsSectionHtml = billRows.length
      ? '<h3 style="font-size:12.5px;color:var(--text-faint);margin:18px 0 6px;text-transform:uppercase;letter-spacing:.04em;">Bills owed</h3>' + billRows.join('')
      : '';

    return pageHeader('Payments', "What tenants owe, what they've paid, and what's outstanding.") + statHtml + chipsHtml + tenantFilterHtml + rows + billsSectionHtml;
  }

  var billsFilter = 'all';
  var billsPropertyFilter = 'all';
  var BILLS_FILTERS = [['all','All'], ['pending','Pending'], ['overdue','Overdue'], ['partially_paid','Partially Paid'], ['paid','Paid']];
  function setBillsFilter(f){ billsFilter = f; render(); }
  function setBillsPropertyFilter(propertyId){ billsPropertyFilter = propertyId; render(); }
  function billMatchesFilter(b, filter){
    if (filter==='all') return true;
    return billEffectiveStatus(b) === filter;
  }

  /* ---------- Import bill (FASE 7: solo la UI de captura; OCR llega después) ---------- */
  var importQueue = [];
  var pendingImportFile = null;

  function triggerImportInput(kind){
    var inputId = kind==='camera' ? 'import-input-camera' : kind==='gallery' ? 'import-input-gallery' : 'import-input-pdf';
    document.getElementById(inputId).click();
  }
  function handleImportFile(evt){
    var file = evt.target.files && evt.target.files[0];
    evt.target.value = ''; // permite volver a elegir el mismo archivo más tarde
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
    var item = {
      id: 'import-' + Date.now() + '-' + Math.round(Math.random()*1000),
      fileName: pendingImportFile.fileName,
      kind: pendingImportFile.kind,
      previewUrl: pendingImportFile.previewUrl,
      file: pendingImportFile.file,
      addedAt: TODAY,
      status: 'processing', // 'processing' -> 'ready' (con los datos que devolvió la IA, o en blanco si el análisis falló)
      extracted: null,
      aiError: null
    };
    importQueue.push(item);
    pendingImportFile = null;
    document.getElementById('import-modal').hidden = true;
    render();
    analyzeImportedFile(item);
  }
  var BLANK_EXTRACTED_BILL = { propertyId:'', billType:'other', provider:'', invoiceNumber:'', issueDate:'', dueDate:'', billingPeriodStart:'', billingPeriodEnd:'', amount:'' };
  var BILL_TYPES = ['electricity','water','gas','internet','other'];
  /** Envía la foto/PDF a la IA (Gemini, vía la Edge Function analyze-bill) para extraer
   *  proveedor, tipo de servicio, fechas, importe y una propiedad sugerida. Si el análisis
   *  falla (sin red, sin API key configurada del lado del servidor, foto poco clara, etc.) el
   *  item igual queda listo para revisar con los campos en blanco, para completarlos a mano
   *  en vez de quedar atascado. */
  async function analyzeImportedFile(item){
    try {
      var data = await aiService.analyzeBill(item.file, properties, TODAY);
      var current = importQueue.find(function(i){ return i.id===item.id; });
      if (!current) return; // se eliminó de la cola mientras se analizaba
      current.status = 'ready';
      var issueDate = data.issueDate || '';
      var dueDate = data.dueDate || '';
      var dueDateWasGuessed = false;
      if (!dueDate && issueDate){
        // El recibo no traía (o la IA no encontró) una fecha límite de pago legible —
        // se asume 10 días hábiles después de la fecha de emisión en vez de dejarlo en blanco.
        dueDate = addBusinessDays(issueDate, 10);
        dueDateWasGuessed = true;
      }
      current.extracted = {
        propertyId: data.propertyId || '',
        billType: BILL_TYPES.indexOf(data.billType) >= 0 ? data.billType : 'other',
        provider: data.provider || '',
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
      if (!current2) return; // se eliminó de la cola mientras se analizaba
      current2.status = 'ready';
      current2.aiError = friendlyErrorMessage(err);
      current2.extracted = Object.assign({}, BLANK_EXTRACTED_BILL);
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
        ? (item.aiError ? badge('due', 'Needs manual entry') : badge('upcoming', 'Ready to review'))
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

  /** Busca un bill ya guardado que probablemente sea el mismo que se está por guardar:
   *  mismo número de factura (si ambos lo tienen), o mismo proveedor + propiedad + periodo
   *  de facturación. Sirve para avisar antes de guardar un bill repetido por error (ej. subir
   *  la misma foto dos veces, o re-escanear un recibo que ya se había cargado). */
  function findDuplicateBill(propertyId, provider, invoiceNumber, periodStart, periodEnd){
    var providerNorm = (provider || '').trim().toLowerCase();
    var invoiceNorm = (invoiceNumber || '').trim().toLowerCase();
    return bills.find(function(b){
      if (b.propertyId !== propertyId) return false;
      if (invoiceNorm && b.invoiceNumber && b.invoiceNumber.trim().toLowerCase() === invoiceNorm) return true;
      var bProviderNorm = (b.provider || '').trim().toLowerCase();
      return bProviderNorm === providerNorm && bProviderNorm !== '' &&
        b.billingPeriodStart === periodStart && b.billingPeriodEnd === periodEnd;
    });
  }

  /* ---------- Review extracted data (revisar/editar antes de confirmar) ---------- */
  var reviewItemId = null;
  var reviewDuplicateOverride = false; // true una vez que el usuario confirma "Save anyway" sobre un posible duplicado
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
    document.getElementById('review-invoice').value = d.invoiceNumber;
    document.getElementById('review-issue').value = d.issueDate;
    document.getElementById('review-due').value = d.dueDate;
    document.getElementById('review-period-start').value = d.billingPeriodStart;
    document.getElementById('review-period-end').value = d.billingPeriodEnd;
    document.getElementById('review-amount').value = d.amount;
    document.getElementById('review-modal-error').hidden = true;
    document.getElementById('review-modal').hidden = false;
  }
  function closeReviewModal(){
    reviewItemId = null;
    reviewDuplicateOverride = false;
    document.getElementById('review-modal').hidden = true;
  }
  function discardReviewItem(){
    if (reviewItemId) removeImportQueueItem(reviewItemId);
    closeReviewModal();
  }
  async function confirmReviewedBill(){
    var provider = document.getElementById('review-provider').value.trim();
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
      var duplicate = findDuplicateBill(reviewPropertyId, provider, invoiceNumber, periodStart, periodEnd);
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
      invoiceNumber: invoiceNumber,
      issueDate: issueDate,
      dueDate: dueDate,
      billingPeriodStart: periodStart,
      billingPeriodEnd: periodEnd,
      amount: Math.round(amount*100)/100,
      status: 'pending',
      notes: 'Imported from ' + (queueItem.fileName || 'a photo/PDF') + ' (details extracted automatically and reviewed before saving).'
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

      // Auto-allocate: reparte el bill entre los inquilinos que pagan renta en
      // esta propiedad ahora mismo (split 'equal'), en vez de dejarlo sin
      // repartir a la espera de un paso manual aparte.
      var propTenantsForBill = tenantsOfProperty(newBill.propertyId);
      if (propTenantsForBill.length > 0){
        var autoRows = computeAllocationRows(newBill, 'equal');
        var allocRows = autoRows.map(function(r){ return { tenantId:r.tenantId, amount:round2(r.amount), paid:false, paidDate:null }; });
        var savedAllocations = await billAllocationService.replaceForBill(newBill.id, allocRows);
        newBill.allocationMethod = 'equal';
        newBill.status = 'allocated';
        newBill = await billService.update(newBill.id, newBill);
        newBill.allocations = savedAllocations;
      }

      bills.push(newBill);
      removeImportQueueItem(reviewItemId);
      closeReviewModal();
      showToast('Bill saved successfully.', 'success');
      // Paso 7 del flujo (revisar y confirmar el reparto): en vez de aterrizar
      // en el listado de Bills, se abre directamente el detalle del bill recién
      // creado, donde la tarjeta de Allocation ya muestra el reparto por
      // inquilino calculado automáticamente (o el botón "Allocate" si la
      // propiedad no tenía inquilinos pagando).
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

  /* ---------- Bill allocation (FASE 9): repartir un bill entre los inquilinos que ocuparon la propiedad ---------- */
  function tenantsOfProperty(propertyId){
    return tenants.filter(function(t){ return t.propertyId===propertyId && t.rentAmount>0; });
  }
  /** Días de solapamiento (inclusive) entre la estancia de un inquilino y el periodo de un bill. */
  function occupiedDaysInRange(tenant, rangeStart, rangeEnd){
    var tenantEnd = tenant.actualMoveOutDate || tenant.expectedMoveOutDate || rangeEnd;
    var start = tenant.moveInDate > rangeStart ? tenant.moveInDate : rangeStart;
    var end = tenantEnd < rangeEnd ? tenantEnd : rangeEnd;
    var days = daysBetween(start, end) + 1;
    return Math.max(0, days);
  }
  function round2(n){ return Math.round(n*100)/100; }

  var allocationDraft = null; // { billId, method, periodDays, rows:[{tenantId,name,days,amount}] }

  /** Reparte `total` entre `weights` (proporcional), ajustando el redondeo en la fila con mayor peso para que la suma cuadre exacto. */
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

  function computeAllocationRows(bill, method){
    var propTenants = tenantsOfProperty(bill.propertyId);
    var days = propTenants.map(function(t){ return occupiedDaysInRange(t, bill.billingPeriodStart, bill.billingPeriodEnd); });
    var amounts;
    if (method === 'days'){
      amounts = splitByWeights(bill.amount, days);
    } else { // 'equal' y el punto de partida de 'custom'
      amounts = splitByWeights(bill.amount, propTenants.map(function(){ return 1; }));
    }
    return propTenants.map(function(t, i){
      return { tenantId: t.id, name: t.fullName, days: days[i], amount: amounts[i] };
    });
  }

  function openAllocateModal(billId){
    var bill = billOf(billId);
    if (!bill) return;
    var totalDays = daysBetween(bill.billingPeriodStart, bill.billingPeriodEnd) + 1;
    var rows = bill.allocations
      ? bill.allocations.map(function(a){
          var t = tenantOf(a.tenantId);
          return { tenantId:a.tenantId, name:t?t.fullName:a.tenantId,
            days: t?occupiedDaysInRange(t, bill.billingPeriodStart, bill.billingPeriodEnd):0, amount:a.amount };
        })
      : computeAllocationRows(bill, 'equal');
    allocationDraft = { billId: billId, method: bill.allocations ? 'custom' : 'equal', periodDays: totalDays, rows: rows };
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
      // Parte de la última distribución visible en pantalla en vez de resetear a cero.
      allocationDraft.rows = allocationDraft.rows.slice();
    } else {
      allocationDraft.rows = computeAllocationRows(bill, method);
    }
    renderAllocateModal();
  }
  var ALLOCATION_METHOD_NOTES = {
    equal: 'The amount is split equally between every tenant at the property.',
    days: "The amount is split based on how many days each tenant lived there during the bill's period.",
    custom: "Set each tenant's amount by hand. The total must match the bill's amount exactly."
  };
  function renderAllocateModal(){
    if (!allocationDraft) return;
    document.querySelectorAll('#allocate-method-chips .chip').forEach(function(btn, i){
      var methods = ['equal','days','custom'];
      btn.classList.toggle('active', methods[i] === allocationDraft.method);
    });
    document.getElementById('allocate-method-note').textContent = ALLOCATION_METHOD_NOTES[allocationDraft.method] || '';
    document.getElementById('allocate-rows').innerHTML = allocationDraft.rows.map(function(row, i){
      return '<div class="alloc-row"><div class="who"><div>'+esc(row.name)+'</div>'+
        '<div class="meta">'+row.days+' / '+allocationDraft.periodDays+' days occupied</div></div>'+
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
    // Conserva el estado de "pagado" de cada inquilino que ya estaba en la
    // asignación anterior (por tenantId), aunque cambie el importe o el
    // método — reasignar no debería des-marcar como pagado a alguien que ya
    // pagó su parte.
    var oldPaidByTenant = {};
    (bill.allocations || []).forEach(function(a){ oldPaidByTenant[a.tenantId] = { paid: !!a.paid, paidDate: a.paidDate || null }; });
    var newRows = allocationDraft.rows.map(function(r){
      var prev = oldPaidByTenant[r.tenantId];
      return { tenantId:r.tenantId, amount:round2(r.amount), paid: prev ? prev.paid : false, paidDate: prev ? prev.paidDate : null };
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
   * Estado global de un bill derivado de sus cuotas por inquilino: si no
   * tiene allocations, el estado no cambia (sigue 'pending', igual que
   * antes). Si las tiene, se deriva de cuántas están pagadas: ninguna ->
   * 'allocated', todas -> 'paid', algunas -> 'partially_paid'.
   */
  function recomputeBillStatus(bill){
    if (!bill.allocations || !bill.allocations.length) return;
    var total = bill.allocations.length;
    var paidCount = bill.allocations.filter(function(a){ return a.paid; }).length;
    if (paidCount === 0) bill.status = 'allocated';
    else if (paidCount === total) bill.status = 'paid';
    else bill.status = 'partially_paid';
  }
  /** Marca la cuota de un inquilino en un bill como pagada (con la fecha real que el admin indique,
   *  no siempre hoy), y recalcula el estado general del bill. */
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
  /** Corrige un error del administrador: deshace el marcado de "pagado" de la cuota de un
   *  inquilino en un bill (por ejemplo, si se marcó por accidente antes de que el inquilino
   *  pagara de verdad). El comprobante adjunto, si lo hay, se conserva — usar removeReceipt
   *  si también hay que quitarlo. */
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

  /** Quita un comprobante adjunto por error (de un tenant o del propio admin) sin tocar si la
   *  cuota está marcada como pagada — para cuando se subió el archivo equivocado. */
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

  /* ---------- FASE 12: Documents (lease agreements, ID copies, otros) ---------- */
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
      '<div class="who"><div class="name" style="text-transform:capitalize;">'+esc(b.billType)+'</div>'+
      '<div class="meta">'+esc(b.provider)+' • '+esc(p?p.name:'—')+' • '+shortDate(b.billingPeriodStart)+' – '+shortDate(b.billingPeriodEnd)+'</div></div>'+
      '<div class="amount">'+money(b.amount)+'<br/>'+billStatusBadge(b)+(b.adminPaid?' '+badge('paid','Sent to provider'):'')+'</div>'+
      '</div></a>';
  }

  /** Resumen de "lo que los tenants tienen que pagar" para la tabla de Bills: cuántos ya
   *  pagaron su cuota y cuánto se ha cobrado del total. */
  function billTenantPaymentsSummary(b){
    if (b.allocations && b.allocations.length){
      var paidCount = b.allocations.filter(function(a){ return a.paid; }).length;
      return '<div>'+paidCount+'/'+b.allocations.length+' tenants</div>'+
        '<div style="font-size:11px;color:var(--text-faint);font-weight:400;">'+money(billPaidAmount(b))+' of '+money(b.amount)+'</div>';
    }
    return '<span style="color:var(--text-faint);">Not yet allocated</span>';
  }
  /** Resumen de "lo que el administrador tiene que pagarle al proveedor" — el segundo leg del
   *  pago, separado de billTenantPaymentsSummary (ver billReadyForAdminPayment). */
  function billAdminPaymentSummary(b){
    if (b.adminPaid) return badge('paid', 'Paid'+(b.adminPaidDate?(' '+shortDate(b.adminPaidDate)):''));
    return billReadyForAdminPayment(b) ? badge('due','Ready to pay') : badge('neutral','Waiting on tenants');
  }
  function billsTableHtml(list, showPropertyCol){
    var head = '<tr><th>Provider</th>'+(showPropertyCol?'<th>Property</th>':'')+
      '<th>Issue date</th><th>Due date</th><th>Tenant payments</th><th>Payment to provider</th><th>Status</th></tr>';
    var body = list.map(function(b){
      var p = propertyOf(b.propertyId);
      return '<tr class="report-row-link" onclick="location.hash=\'#/bills/'+b.id+'\'">'+
        '<td><div style="font-weight:650;">'+esc(b.provider)+'</div>'+
        '<div style="font-size:11px;color:var(--text-faint);text-transform:capitalize;">'+esc(b.billType)+'</div></td>'+
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

  function renderBills(){
    // Pestaña por propiedad — "All properties" o una específica; el filtro de estado (chips)
    // y las stats se calculan DESPUÉS de aplicar esta, así cada pestaña muestra sus propios
    // números en vez de los del portafolio completo.
    var propertyScoped = billsPropertyFilter==='all' ? bills : bills.filter(function(b){ return b.propertyId===billsPropertyFilter; });
    var propertyTabsHtml = properties.length===0 ? '' : '<div class="filter-chips" style="margin-bottom:10px;">'+
      '<button class="chip'+(billsPropertyFilter==='all'?' active':'')+'" onclick="setBillsPropertyFilter(\'all\')">All properties</button>'+
      properties.slice().sort(function(a,b){ return a.name.localeCompare(b.name); }).map(function(p){
        return '<button class="chip'+(billsPropertyFilter===p.id?' active':'')+'" onclick="setBillsPropertyFilter(\''+p.id+'\')">'+esc(p.name)+'</button>';
      }).join('') + '</div>';

    // "Pending" y "Paid" usan el importe REALMENTE cobrado (billPaidAmount),
    // no un corte todo-o-nada por bill.status: un bill parcialmente pagado
    // aporta su parte cobrada a "Paid" y el resto a "Pending", igual que
    // Reports (billPaidAmount/billOutstandingAmount más arriba).
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

    var filtered = propertyScoped
      .filter(function(b){ return billMatchesFilter(b, billsFilter); })
      .sort(function(a,b){ return (b.dueDate||'').localeCompare(a.dueDate||''); });
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
      '<button class="mini-btn primary" style="display:flex;align-items:center;gap:6px;white-space:nowrap;" onclick="openImportModal()">'+svg('plus','style="width:14px;height:14px;"')+'Add bill</button></div>'+
      importQueueCard() + propertyTabsHtml + statHtml + chipsHtml + rows;
  }

  function renderBillDetail(id){
    var b = billOf(id);
    if (!b){ return pageHeader('Bill not found', '') + notFoundState('Bill', '#/bills', 'Back to bills'); }
    var p = propertyOf(b.propertyId);

    return backLink('#/bills', 'Bills') +
      '<div class="detail-head"><div><h1 class="page-title" style="text-transform:capitalize;">'+esc(b.billType)+'</h1>'+
      '<p class="page-sub">'+esc(b.provider)+'</p></div>'+
      '<div class="occ"><div>'+money(b.amount)+'</div><div class="vacant">'+billStatusBadge(b)+'</div></div></div>'+
      '<div class="card"><div class="field-list">'+
      '<div class="field-row"><span class="k">Property</span><span class="v"><a href="#/properties/'+(p?p.id:'')+'">'+esc(p?p.name:'—')+'</a></span></div>'+
      '<div class="field-row"><span class="k">Provider</span><span class="v">'+esc(b.provider)+'</span></div>'+
      '<div class="field-row"><span class="k">Invoice number</span><span class="v">'+esc(b.invoiceNumber||'—')+'</span></div>'+
      '<div class="field-row"><span class="k">Issue date</span><span class="v">'+(b.issueDate?fullDate(b.issueDate):'—')+'</span></div>'+
      '<div class="field-row"><span class="k">Due date</span><span class="v">'+(b.dueDate?fullDate(b.dueDate):'—')+'</span></div>'+
      '<div class="field-row"><span class="k">Billing period</span><span class="v">'+shortDate(b.billingPeriodStart)+' – '+shortDate(b.billingPeriodEnd)+'</span></div>'+
      '<div class="field-row"><span class="k">Amount</span><span class="v">'+money(b.amount)+'</span></div>'+
      '<div class="field-row"><span class="k">Status</span><span class="v">'+billStatusBadge(b)+'</span></div>'+
      (b.notes ? '<div class="field-row"><span class="k">Notes</span><span class="v" style="font-weight:400;">'+esc(b.notes)+'</span></div>' : '')+
      '</div></div>'+
      billAllocationCard(b);
  }

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
        var t = tenantOf(a.tenantId);
        var paidBit = a.paid
          ? badge('paid', 'Paid'+(a.paidDate ? ' ' + shortDate(a.paidDate) : ''))
          : badge('due', 'Unpaid');
        var actionBtn = a.paid
          ? '<button class="mini-btn" onclick="unmarkAllocationPaid(\''+b.id+'\',\''+a.tenantId+'\')">Mark as unpaid</button>'
          : '<button class="mini-btn primary" onclick="openAllocPaidModal(\''+b.id+'\',\''+a.tenantId+'\')">Mark as paid</button>';
        return '<div class="alloc-summary-row" style="align-items:center;flex-wrap:wrap;">'+
          '<div class="who"><div>'+esc(t?t.fullName:a.tenantId)+'</div>'+receiptLinkHtml(a.receiptPath, b.id, a.tenantId)+'</div>'+
          '<div style="display:flex;align-items:center;gap:10px;">'+
          '<div style="text-align:right;"><div style="font-weight:650;">'+money(a.amount)+'</div>'+paidBit+'</div>'+
          actionBtn+
          '</div></div>';
      }).join('');
      return '<div class="card"><div class="detail-head" style="margin-top:0;align-items:center;">'+
        '<h2 style="margin:0;">Allocation</h2>'+
        '<button class="mini-btn" onclick="openAllocateModal(\''+b.id+'\')">Re-allocate</button></div>'+
        '<p style="font-size:12px;color:var(--text-faint);margin:2px 0 8px;">'+(methodLabel[b.allocationMethod]||'Custom')+'</p>'+
        rows+'</div>'+adminSectionHtml;
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

  /* ---------- FASE 11: Reports ---------- */
  function renderReports(){
    if (properties.length === 0 && tenants.length === 0){
      return pageHeader('Reports', "Expected vs received rent, outstanding balances, bills and occupancy at a glance.") +
        emptyState('chart', 'Nothing to report yet',
          'Once you add properties, tenants and bills, your numbers will show up here.',
          '<a class="mini-btn primary" href="#/properties" style="display:inline-block;">Go to properties</a>');
    }
    var s = getDashboardSummary();
    // Ledger real de bills: suma de lo REALMENTE cobrado por allocation
    // (billPaidAmount) en vez de todo-o-nada por bill.status, para que un
    // bill parcialmente pagado se refleje correctamente en vez de contar
    // como "0% pagado" hasta que la última cuota se marque.
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

  /* ---------- FASE 13: Notifications ---------- */
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

    return pageHeader('Notifications', 'Reminders for rent due dates, overdue payments, bills and move-in/out.') +
      (unreadCount>0 ? '<p style="font-size:12.5px;color:var(--text-dim);margin:0 0 10px;">'+unreadCount+' unread</p>' : '') +
      rows +
      '<div class="card" style="margin-top:14px;"><h2 style="text-transform:none;letter-spacing:0;">About notifications</h2>'+
      "<p style=\"font-size:13px;color:var(--text-dim);margin:0;\">This is an in-app notification centre — check this screen when you open the app. Real push notifications (system alerts even when the app is closed) need a backend and browser permissions, and aren't available yet.</p></div>";
  }

  /* ---------- FASE 14: App lock (PIN local) + Backup/restore ---------- */
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
    // Fallback para cuando no hay capability system (p.ej. abierto directo como file://).
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
      // Importante: render() vuelve a dibujar toda la página (innerHTML), así que
      // el mensaje de estado tiene que vivir en una variable y salir de renderSettings(),
      // no escribirse directo en el <p> viejo — ese nodo desaparece en cuanto render() corre.
      try {
        var data = JSON.parse(reader.result);
        if (!data || typeof data !== 'object') throw new Error('formato inválido');
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
      '<p style="font-size:13px;color:var(--text-dim);margin:0 0 10px;">If this browser still has data saved from an older, offline version of Belmont Manager, this copies it into your Supabase account (new cloud IDs are assigned, and everything is relinked). Your old local data is left untouched as a safety-net backup.</p>'+
      (hasLocalData
        ? '<button class="mini-btn primary" id="migrate-btn" onclick="runLocalMigration()">Migrate local data to cloud</button>'
        : '<p style="font-size:12.5px;color:var(--text-faint);margin:0;">No old local data was found in this browser.</p>')+
      '<div id="migration-status" style="font-size:12px;color:var(--text-dim);margin-top:8px;white-space:pre-wrap;">'+esc(migrationStatusMessage)+'</div>'+
      '</div>';
    return pageHeader('Settings', 'App lock, backup and sync, and preferences.') +
      '<div class="card"><h2 style="text-transform:none;letter-spacing:0;">About storage</h2>'+
      '<p style="font-size:13.5px;color:var(--text-dim);margin:0;">Your data is stored in your own Supabase project, protected by row-level security, and loaded fresh from there every time you sign in. Use the backup below for an extra offline copy.</p></div>'+
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
      '<button class="mini-btn" onclick="signOutAndReload()">Sign out</button></div>';
  }

  function renderMore(){
    var items = NAV.filter(function(i){ return !i.primary; });
    var rows = items.map(function(item){
      return '<a href="'+item.hash+'">'+svg(item.icon)+'<span>'+item.label+'</span>'+svg('chevron','class="chev"')+'</a>';
    }).join('');
    return pageHeader('More', 'Everything else, in one place.') + '<div class="more-list">'+rows+'</div>';
  }

  /* ============ FASE 15 — CRUD: properties, rooms, tenants, bonds ============ */
  var crudIdSeq = 0;
  function genId(prefix){
    crudIdSeq++;
    return prefix + '-' + Date.now() + '-' + crudIdSeq;
  }

  /** Vuelve a poblar los <select> de property/tenant que se llenaron una sola vez al cargar la página. */
  function refreshStaticSelects(){
    var reviewPropertySelect = document.getElementById('review-property');
    if (reviewPropertySelect){
      var prevVal = reviewPropertySelect.value;
      reviewPropertySelect.innerHTML = properties.map(function(p){
        return '<option value="'+p.id+'">'+esc(p.name)+'</option>';
      }).join('');
      if (properties.some(function(p){ return p.id===prevVal; })) reviewPropertySelect.value = prevVal;
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

  /* ---------- Modal genérico de confirmación (delete de property/room/tenant) ---------- */
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
  /** La acción puede devolver {blocked:true, message} (o una Promise de eso) para mostrar un error sin cerrar el modal (p.ej. "tiene habitaciones", o un error de red/servidor). */
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
  function openPropertyModal(propertyId){
    propertyModalEditId = propertyId || null;
    var p = propertyId ? propertyOf(propertyId) : null;
    document.getElementById('property-modal-title').textContent = p ? 'Edit property' : 'Add property';
    document.getElementById('property-name').value = p ? p.name : '';
    document.getElementById('property-address').value = p ? p.address : '';
    document.getElementById('property-bedrooms').value = p ? p.bedrooms : '';
    document.getElementById('property-bathrooms').value = p ? p.bathrooms : '';
    document.getElementById('property-notes').value = p ? (p.notes||'') : '';
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
    var errorEl = document.getElementById('property-modal-error');
    if (!name || !address || !isFinite(bedrooms) || bedrooms<0 || !isFinite(bathrooms) || bathrooms<0){
      errorEl.textContent = 'Add a name, address, and bedrooms/bathrooms as whole numbers of 0 or more.';
      errorEl.hidden = false;
      return;
    }
    var saveBtn = document.querySelector('#property-modal .mini-btn.primary');
    var originalLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    errorEl.hidden = true;
    try {
      var draft = { name:name, address:address, bedrooms:bedrooms, bathrooms:bathrooms, notes:notes };
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

  /** Fila de una habitación con acciones de editar/borrar (solo en Property detail; el listado de Properties no las lleva). */
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
      '<button type="button" class="icon-mini-btn danger" title="Delete room"'+(hasAnyTenant?' disabled':'')+' '+
      'onclick="event.preventDefault();event.stopPropagation();deleteRoomConfirm(\''+r.id+'\')">✕</button>'+
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
    var occupant = currentTenantOf(roomId);
    if (occupant && occupant.id !== tenantModalEditId){
      errorEl.textContent = 'That room already has a tenant assigned.';
      errorEl.hidden = false;
      return;
    }

    var draft = { fullName:fullName, propertyId:propertyId, roomId:roomId, moveInDate:moveInDate,
      rentAmount:rentAmount, rentFrequency:rentFrequency, paymentDay:paymentDay };
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

      // rentService lee de rentSchedules, no de tenant.rentAmount/rentFrequency directamente:
      // hay que mantener el schedule del inquilino sincronizado con lo que se guarda aquí.
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
  window.onTenantPropertyChange = onTenantPropertyChange;
  window.onTenantFrequencyChange = onTenantFrequencyChange;
  window.openTenantModal = openTenantModal;
  window.closeTenantModal = closeTenantModal;
  window.saveTenantForm = saveTenantForm;
  window.deleteTenantConfirm = deleteTenantConfirm;

  /* ---------- Bond form (accesible desde Tenant detail) ---------- */
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

  var ROUTES = {
    '#/': renderDashboard,
    '#/properties': renderProperties,
    '#/tenants': renderTenants,
    '#/payments': renderPayments,
    '#/bills': renderBills,
    '#/calendar': renderCalendar,
    '#/reports': renderReports,
    '#/documents': renderDocuments,
    '#/notifications': renderNotifications,
    '#/settings': renderSettings,
    '#/more': renderMore
  };

  var content = document.getElementById('content');
  function render(){
    var hash = location.hash || '#/';
    var propertyMatch = hash.match(/^#\/properties\/(.+)$/);
    var tenantMatch = hash.match(/^#\/tenants\/(.+)$/);
    var billMatch = hash.match(/^#\/bills\/(.+)$/);
    var html;
    if (propertyMatch) html = renderPropertyDetail(decodeURIComponent(propertyMatch[1]));
    else if (tenantMatch) html = renderTenantDetail(decodeURIComponent(tenantMatch[1]));
    else if (billMatch) html = renderBillDetail(decodeURIComponent(billMatch[1]));
    else html = (ROUTES[hash] || ROUTES['#/'])();
    content.innerHTML = html;
    setActiveNav(hash);
    window.scrollTo(0,0);
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
      tenantDocumentService.getAll()
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

  /* ============ Auth gate: sign in before loading/rendering any app data ============ */
  var authMode = 'signin'; // 'signin' | 'signup'
  function setAuthMode(mode){
    authMode = mode;
    document.getElementById('auth-title').textContent = mode==='signup' ? 'Create your account' : 'Sign in';
    document.getElementById('auth-submit-btn').textContent = mode==='signup' ? 'Create account' : 'Sign in';
    document.getElementById('auth-toggle-link').textContent = mode==='signup' ? 'Already have an account? Sign in' : "First time here? Create an account";
    document.getElementById('auth-error').hidden = true;
  }
  window.setAuthMode = setAuthMode;
  function toggleAuthMode(){ setAuthMode(authMode==='signup' ? 'signin' : 'signup'); }
  window.toggleAuthMode = toggleAuthMode;

  async function submitAuthForm(){
    var email = document.getElementById('auth-email').value.trim();
    var password = document.getElementById('auth-password').value;
    var errorEl = document.getElementById('auth-error');
    var btn = document.getElementById('auth-submit-btn');
    if (!email || !password){
      errorEl.textContent = 'Enter an email and password.';
      errorEl.hidden = false;
      return;
    }
    var originalLabel = btn.textContent;
    btn.disabled = true; btn.textContent = authMode==='signup' ? 'Creating account…' : 'Signing in…';
    errorEl.hidden = true;
    try {
      if (authMode === 'signup'){
        var result = await auth.signUp(email, password);
        if (result.session){
          await enterApp();
        } else {
          errorEl.textContent = 'Account created. Check your email to confirm it, then sign in.';
          errorEl.hidden = false;
          setAuthMode('signin');
        }
      } else {
        await auth.signIn(email, password);
        await enterApp();
      }
    } catch(err){
      errorEl.textContent = friendlyErrorMessage(err);
      errorEl.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = originalLabel;
    }
  }
  window.submitAuthForm = submitAuthForm;

  async function signOutAndReload(){
    try { await auth.signOut(); } catch(e){ /* ignore */ }
    location.reload();
  }
  window.signOutAndReload = signOutAndReload;

  async function enterApp(){
    document.getElementById('auth-screen').hidden = true;
    document.getElementById('app-loading-screen').hidden = false;
    try {
      await bootstrapData();
    } catch(err){
      document.getElementById('app-loading-screen').hidden = true;
      document.getElementById('auth-screen').hidden = false;
      document.getElementById('auth-error').textContent = 'Signed in, but could not load your data. ' + friendlyErrorMessage(err);
      document.getElementById('auth-error').hidden = false;
      return;
    }
    document.getElementById('app-loading-screen').hidden = true;
    document.querySelector('.shell').hidden = false;
    startRouter();
    if (getAppPin()){
      document.getElementById('lock-screen').hidden = false;
      document.getElementById('lock-pin-input').focus();
    }
  }

  async function initAuthGate(){
    var session;
    try { session = await auth.getSession(); } catch(e){ session = null; }
    if (session){
      await enterApp();
    } else {
      document.getElementById('auth-screen').hidden = false;
    }
  }
  initAuthGate();

  /* ============ Theme toggle (independiente del tema del host) ============ */
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

  /* ============ App lock (FASE 14): se muestra tras cargar los datos si hay un PIN guardado (ver enterApp()) ============ */
  var lockPinInput = document.getElementById('lock-pin-input');
  lockPinInput.addEventListener('keydown', function(e){ if (e.key === 'Enter') attemptUnlock(); });
})();
