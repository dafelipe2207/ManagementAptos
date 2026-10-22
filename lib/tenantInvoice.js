// lib/tenantInvoice.js
// The clean invoice given to tenants for a bill that came from the real-estate agency: the same
// values as the agency's invoice (invoice #, folio, dates, amount) but none of the agency's or
// the owner's details (logo, address, phone, ABN, licence, bank account, reference).
// Two layouts, approved by Daniel on 2026-10-21:
//   - 'water':  styled like the Water Corporation bill, with the meter / usage details
//               (needs data.water — meter reads, daily use, tiers…)
//   - 'agency': the agency's own invoice layout (Tax Invoice, Property / Due date / Due box,
//               Description · Included Tax · Amount, Amount paid / Amount due)
// buildHtml(data) returns the page; makePdf(data) turns it into an A4 PDF Blob in the browser
// (html2canvas + jsPDF, loaded on first use).

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
function money(n) {
  const v = Number(n) || 0;
  return '$' + v.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function parts(iso) { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? [+m[1], +m[2], +m[3]] : null; }
/** 19/10/2026 */
function dmy(iso) { const p = parts(iso); return p ? p[2] + '/' + String(p[1]).padStart(2, '0') + '/' + p[0] : ''; }
/** 5/10/2026 (no leading zero on the day, like the agency's "Created date") */
function dmyShort(iso) { const p = parts(iso); return p ? p[2] + '/' + p[1] + '/' + p[0] : ''; }
/** 19 Oct 2026 */
function dMonY(iso) { const p = parts(iso); return p ? p[2] + ' ' + MONTHS[p[1] - 1] + ' ' + p[0] : ''; }
function num(n) { return Number(n || 0).toLocaleString('en-AU'); }

/** Fills the fields a template needs from the bill when tenant_invoice_data doesn't have them. */
export function dataFromBill(bill, property, base) {
  const d = Object.assign({}, base || {});
  const addr = (property && property.address) || '';
  if (!d.invoiceNumber) d.invoiceNumber = bill.invoiceNumber || '';
  if (!d.createdDate) d.createdDate = bill.issueDate || '';
  if (!d.dueDate) d.dueDate = bill.dueDate || '';
  if (d.amount == null) d.amount = bill.amount;
  if (d.amountPaid == null) d.amountPaid = 0;
  if (d.includedTax == null) d.includedTax = 0;
  if (!d.periodStart) d.periodStart = bill.billingPeriodStart || '';
  if (!d.periodEnd) d.periodEnd = bill.billingPeriodEnd || '';
  if (!d.billTo) d.billTo = 'Residents';
  if (!d.addressLine1) d.addressLine1 = addr;
  if (!d.description) {
    const kind = { water: 'Water Usage', electricity: 'Electricity', gas: 'Gas', internet: 'Internet' }[bill.billType] || 'Charges';
    d.description = kind + (d.periodStart ? ' ' + dmy(d.periodStart) + ' - ' + dmy(d.periodEnd) : '');
  }
  if (!d.template) d.template = d.water ? 'water' : 'agency';
  return d;
}

function propertyLine(d) { return [d.addressLine1, d.addressLine2].filter(Boolean).join(', '); }

function agencyHtml(d) {
  const due = Number(d.amount || 0) - Number(d.amountPaid || 0);
  return `
<div class="ti-page ti-agency">
  <div class="a-to">${esc(d.billTo)}<br>${esc(d.addressLine1)}${d.addressLine2 ? '<br>' + esc(d.addressLine2) : ''}</div>
  <div class="a-ti"><h2>Tax Invoice</h2><table>
    ${d.folio ? `<tr><td>Folio:</td><td>${esc(d.folio)}</td></tr>` : ''}
    ${d.createdDate ? `<tr><td>Created date:</td><td>${esc(dmyShort(d.createdDate))}</td></tr>` : ''}
    ${d.invoiceNumber ? `<tr><td>Invoice #:</td><td>${esc(d.invoiceNumber)}</td></tr>` : ''}
  </table></div>
  <table class="a-box"><tr>
    <td style="width:56%">Property<br>${esc(propertyLine(d))}</td>
    <td style="width:22%">Due date<br>${esc(dmy(d.dueDate))}</td>
    <td style="width:22%">Due<br>${money(due)}</td></tr></table>
  <div class="a-items"><table class="a-lines">
    <tr><th>Description</th><th class="r" style="width:30mm">Included Tax</th><th class="r" style="width:30mm">Amount</th></tr>
    <tr><td>${esc(d.description)}</td><td class="r">${money(d.includedTax)}</td><td class="r">${money(d.amount)}</td></tr>
  </table>
  <table class="a-sum"><tr class="paid"><td>Amount paid:</td><td>${money(d.amountPaid)}</td></tr><tr><td>Amount due:</td><td>${money(due)}</td></tr></table>
  </div>
  <div class="a-foot">Page 1 of 1</div>
</div>`;
}

function waterHtml(d) {
  const w = d.water || {};
  const due = Number(d.amount || 0) - Number(d.amountPaid || 0);
  const bars = [w.sameBillLastYearLpd, w.previousBillLpd, w.dailyLitres].map((v) => Number(v) || 0);
  const max = Math.max(1, ...bars);
  // Bars without data (e.g. no bill last year yet) are left out instead of drawn as "0 L/day".
  const BAR_STYLE = ['background:#a8dcf2', 'background:#5aa48f;color:#fff', 'background:#0d6aa8;color:#fff'];
  const BAR_LABEL = ['Same bill last year', 'Previous bill', 'This bill'];
  const shown = [0, 1, 2].filter((i) => bars[i] > 0);
  const h = (v) => Math.max(18, Math.round(v / max * 100)) + '%';
  const tiers = (w.tiers || []).map((t) => `<div class="w-tier${Number(t.tier) === Number(w.tier) ? ' on' : ''}"><b>TIER ${esc(t.tier)}</b><span>${esc(t.range)} · $${Number(t.rate).toFixed(3)}/kL</span></div>`).join('');
  const days = d.periodDays || (w.lastReadDate && w.thisReadDate ? Math.round((Date.parse(w.thisReadDate) - Date.parse(w.lastReadDate)) / 864e5) : '');
  return `
<div class="ti-page ti-water">
  <div class="w-head">
    <div class="w-brand"><div class="w-serif">Water use<br>tax invoice</div><small>${esc(propertyLine(d))}</small></div>
    <table class="w-meta">
      ${d.invoiceNumber ? `<tr><td>INVOICE #</td><td>${esc(d.invoiceNumber)}</td></tr>` : ''}
      ${d.folio ? `<tr><td>FOLIO</td><td>${esc(d.folio)}</td></tr>` : ''}
      ${days ? `<tr><td>WATER USE PERIOD</td><td>${esc(days)} DAYS</td></tr>` : ''}
      ${d.createdDate ? `<tr><td>CREATED DATE</td><td>${esc(dMonY(d.createdDate).toUpperCase())}</td></tr>` : ''}
    </table>
  </div>
  <div class="w-addr">${esc(d.billTo)}<br>${esc(d.addressLine1)}${d.addressLine2 ? '<br>' + esc(d.addressLine2) : ''}</div>
  <div class="w-summary">
    <div>
      <h2 class="w-serif">Your bill summary</h2>
      <p>Here is your <b>water use</b> charge for the home unit at <b>${esc(propertyLine(d))}</b>.</p>
      ${d.periodStart ? `<p>Water use period: <b>${esc(dMonY(d.periodStart))} – ${esc(dMonY(d.periodEnd))}</b></p>` : ''}
    </div>
    <div class="w-pay"><div class="lbl">PLEASE PAY:</div><div class="amt">${money(due)}</div>
      <div class="due"><div class="lbl">DUE BY:</div><b>${esc(dMonY(d.dueDate))}</b></div></div>
  </div>
  <div class="w-card">
    <h3 class="w-serif">Account summary</h3>
    <div class="w-row"><span>Water use charges</span><span>Due ${esc(dMonY(d.dueDate))}</span><span>${money(d.amount)}</span></div>
    <div class="w-row"><span>Amount paid</span><span></span><span>${money(d.amountPaid)}</span></div>
    <div class="w-row total"><span>Amount due</span><span>${money(due)}</span></div>
  </div>
  ${bars.some(Boolean) || tiers ? `<div class="w-two">
    ${bars.some(Boolean) ? `<div class="w-card" style="flex:0 0 74mm">
      <h3 class="w-serif">Daily water use comparison</h3>
      <div class="w-bars">
        ${shown.map((i) => `<div class="w-bar" style="height:${h(bars[i])};${BAR_STYLE[i]}">${num(bars[i])}<span>L/day</span></div>`).join('')}
      </div>
      <div class="w-blabels">${shown.map((i) => `<div>${BAR_LABEL[i]}</div>`).join('')}</div>
    </div>` : ''}
    ${tiers ? `<div class="w-card" style="flex:1">
      <h3 class="w-serif">Water use pricing</h3>
      <div class="w-tiers"><ul>
        ${w.tier ? `<li>You are currently in Tier ${esc(w.tier)}.</li>` : ''}
        ${w.klToNextTier ? `<li>In ${esc(w.klToNextTier)}kL you will enter Tier ${Number(w.tier) + 1}.</li>` : ''}
        ${w.tierResets ? `<li>The tier resets when the bill year ends in ${esc(w.tierResets)}.</li>` : ''}
        ${w.yearToDateKl ? `<li>Total water use this bill year so far: <b>${esc(w.yearToDateKl)}kL</b>.</li>` : ''}
        <li>1,000 litres (L) = 1 kilolitre (kL)</li></ul>
        <div class="w-ladder">${tiers}</div></div>
    </div>` : ''}
  </div>` : ''}
  ${w.estimated ? `<div class="w-card"><h3 class="w-serif">Important information</h3>
    <ul style="margin:0;padding-left:14px"><li>This reading was <b>estimated</b> because the meter could not be read. The estimate is based on the property's water use from the same time last year.</li></ul></div>` : ''}
  <div class="w-blue">
    ${w.meterNumber ? `<h3 class="w-serif">Meter read details</h3>
    <table class="w-meter">
      <tr><th>METER NUMBER</th><th>LAST READ DATE</th><th>METER READ</th><th>THIS READ DATE</th><th>METER READ</th><th>WATER USE (kL)</th></tr>
      <tr><td>${esc(w.meterNumber)}</td><td>${esc(dMonY(w.lastReadDate))}</td><td>${num(w.lastRead)}</td><td>${esc(dMonY(w.thisReadDate))}</td><td>${num(w.thisRead)}</td><td>${esc(w.usageKl)}${w.estimated ? ' Estimated' : ''}</td></tr>
    </table>` : ''}
    ${w.usageKl ? `${w.meterNumber ? '' : '<h3 class="w-serif">Water use</h3>'}<p class="w-used">In this period you used ${esc(w.usageKl)}kL.${w.dailyLitres ? ` Your average daily water use was ${num(w.dailyLitres)}L${w.costPerDay ? ' at $' + Number(w.costPerDay).toFixed(2) + ' per day' : ''}.` : ''}</p>` : ''}
    <h3 class="w-serif">New charges</h3>
    <table class="w-charges">
      <tr><th>CHARGE TYPE</th><th>BASED ON</th><th class="r">INCLUDED TAX</th><th class="r">AMOUNT</th></tr>
      <tr class="grp"><td colspan="4">Water use charges</td></tr>
      <tr><td>${d.periodStart ? esc(dMonY(d.periodStart)) + ' – ' + esc(dMonY(d.periodEnd)) : esc(d.description)}</td><td>${w.usageKl && w.ratePerKl ? esc(w.usageKl) + ' kL at $' + Number(w.ratePerKl).toFixed(4) : ''}</td><td class="r">${money(d.includedTax)}</td><td class="r">${money(d.amount)}</td></tr>
      <tr class="tot"><td colspan="3">Water use charges total</td><td class="r">${money(d.amount)}</td></tr>
      <tr><td colspan="3">Amount paid</td><td class="r">${money(d.amountPaid)}</td></tr>
      <tr class="due"><td colspan="3">Amount due by ${esc(dMonY(d.dueDate))}</td><td class="r">${money(due)}</td></tr>
    </table>
  </div>
  <div class="w-foot"><span>${d.invoiceNumber ? 'Invoice # ' + esc(d.invoiceNumber) + ' · ' : ''}${esc(d.description)}</span><span>Page 1 of 1</span></div>
</div>`;
}

// All rules live under .ti-page so the page can be drawn inside the app without touching it.
const CSS = `
.ti-page{width:794px;height:1123px;position:relative;background:#fff;box-sizing:border-box;font-family:Inter,Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased}
.ti-page *{box-sizing:border-box}
.ti-agency{color:#222;font-family:Arial,Helvetica,sans-serif;font-size:12px}
.ti-agency .a-to{position:absolute;left:113px;top:295px;line-height:1.55}
.ti-agency .a-ti{position:absolute;right:49px;top:272px;text-align:right}
.ti-agency .a-ti h2{font-size:19px;margin:0 0 10px;font-weight:700}
.ti-agency .a-ti table{border-collapse:collapse;margin-left:auto}
.ti-agency .a-ti td{padding:2px 0 2px 18px;font-size:12px;text-align:right}
.ti-agency .a-ti td:last-child{min-width:84px}
.ti-agency .a-box{position:absolute;left:91px;top:404px;width:536px;border-collapse:collapse;border:1px solid #555}
.ti-agency .a-box td{border:1px solid #555;text-align:center;padding:7px 8px;font-size:13px;font-weight:700;line-height:1.55}
.ti-agency .a-items{position:absolute;left:49px;right:49px;top:476px}
.ti-agency table.a-lines{width:100%;border-collapse:collapse}
.ti-agency .a-lines th{font-size:13px;text-align:left;padding:0 0 8px;border-bottom:1px solid #555}
.ti-agency .r{text-align:right !important}
.ti-agency .a-lines td{padding:12px 0;font-size:11px;border-bottom:1px solid #bbb}
.ti-agency table.a-sum{width:360px;margin-left:auto;border-collapse:collapse;margin-top:8px}
.ti-agency .a-sum td{padding:10px 0;font-size:11px}
.ti-agency .a-sum td:first-child{text-align:center}
.ti-agency .a-sum td:last-child{text-align:right}
.ti-agency .a-sum tr.paid td{border-bottom:1px solid #555}
.ti-agency .a-foot{position:absolute;right:12px;bottom:18px;font-size:12px}

.ti-water{color:#1d3550;font-size:11.5px;padding:38px 49px 38px}
.ti-water .w-serif{font-family:"Bitstream Charter",Charter,Georgia,"Times New Roman",serif}
.ti-water .w-head{display:flex;justify-content:space-between;align-items:flex-start}
.ti-water .w-brand .w-serif{font-size:20px;color:#0b4a7a;line-height:1.15}
.ti-water .w-brand small{display:block;font-size:10.5px;color:#5b7690;margin-top:2px}
.ti-water .w-meta{border-collapse:collapse;min-width:257px}
.ti-water .w-meta td{padding:4px 0;border-bottom:1px solid #c9d9e6;font-size:10.5px}
.ti-water .w-meta td:first-child{color:#0d6aa8;font-weight:600;letter-spacing:.3px}
.ti-water .w-meta td:last-child{text-align:right;font-weight:500}
.ti-water .w-addr{margin:24px 0 0 38px;font-weight:700;font-size:11.5px;line-height:1.45;text-transform:uppercase}
.ti-water .w-summary{display:flex;justify-content:space-between;gap:30px;margin-top:20px;align-items:flex-start}
.ti-water .w-summary h2{font-size:20px;margin:0 0 6px;color:#0b4a7a;font-weight:700}
.ti-water .w-summary p{margin:0 0 4px;font-size:12.5px;line-height:1.35}
.ti-water .w-pay{width:234px;background:#0b4a7a;border-radius:13px;padding:10px 5px 5px;color:#fff;text-align:right;flex-shrink:0}
.ti-water .w-pay .lbl{font-size:10px;font-weight:700;letter-spacing:.4px;padding-right:12px}
.ti-water .w-pay .amt{font-size:28px;font-weight:800;padding:0 12px 8px}
.ti-water .w-pay .due{background:#fff;color:#0b4a7a;border-radius:10px;padding:8px 12px}
.ti-water .w-pay .due .lbl{color:#0b4a7a;padding:0}
.ti-water .w-pay .due b{display:block;font-size:25px;font-weight:600;font-family:"Bitstream Charter",Charter,Georgia,serif}
.ti-water .w-card{border:1px solid #c9d9e6;border-radius:10px;padding:10px 14px;margin-top:12px}
.ti-water .w-card h3,.ti-water .w-blue h3{font-size:16.5px;margin:0 0 7px;color:#0b4a7a;font-weight:700}
.ti-water .w-row{display:flex;justify-content:space-between;font-size:12px;padding:3px 0}
.ti-water .w-row.total{font-weight:700;border-top:1px solid #c9d9e6;margin-top:4px;padding-top:5px}
.ti-water .w-two{display:flex;gap:19px}
.ti-water .w-two .w-card{margin-top:12px}
.ti-water .w-bars{display:flex;gap:12px;align-items:flex-end;height:96px;margin-top:3px}
.ti-water .w-bar{width:64px;border-radius:7px 7px 0 0;color:#0b2f4f;font-weight:800;font-size:12px;text-align:center;padding-top:5px;line-height:1.1}
.ti-water .w-bar span{display:block;font-size:10px;font-weight:600}
.ti-water .w-blabels{display:flex;gap:12px;margin-top:4px}
.ti-water .w-blabels div{width:64px;text-align:center;font-size:9px;font-weight:700;color:#0d6aa8;text-decoration:underline}
.ti-water .w-tiers{display:flex;gap:22px;align-items:flex-start}
.ti-water .w-tiers ul{margin:0;padding-left:15px;font-size:10px;line-height:1.5;flex:1}
.ti-water .w-ladder{width:166px;display:flex;flex-direction:column;gap:5px;font-size:9px}
.ti-water .w-tier{display:flex;justify-content:space-between;align-items:center;border-radius:5px;padding:5px 8px;background:#eef7fb}
.ti-water .w-tier.on{background:#0d6aa8;color:#fff}
.ti-water .w-card li{font-size:10px;line-height:1.4}
.ti-water .w-blue{background:#d7eef8;border-radius:10px;padding:10px 14px;margin-top:12px}
.ti-water table.w-meter{width:100%;border-collapse:separate;border-spacing:4px 0;font-size:10px}
.ti-water .w-meter th{text-align:left;font-size:8.8px;font-weight:700;padding:3px 6px}
.ti-water .w-meter td{background:#fff;padding:7px 6px;border-radius:4px}
.ti-water .w-used{margin:8px 0 10px;font-size:10.4px}
.ti-water table.w-charges{width:100%;border-collapse:collapse;font-size:11px;margin-top:4px}
.ti-water .w-charges th{text-align:left;font-size:9px;font-weight:700;padding:4px 0;border-bottom:1px solid #9cc6dc}
.ti-water .w-charges td{padding:4px 0}
.ti-water .w-charges .r{text-align:right}
.ti-water .w-charges .grp td{font-style:italic;font-weight:600;padding-top:9px}
.ti-water .w-charges .tot td{font-style:italic;font-weight:700;border-top:1px solid #9cc6dc}
.ti-water .w-charges .due td{font-weight:800;font-size:13.5px;color:#0b4a7a;border-top:2px solid #0b4a7a;padding-top:8px}
.ti-water .w-foot{position:absolute;left:49px;right:49px;bottom:26px;display:flex;justify-content:space-between;font-size:10px;color:#5b7690}
`;

export function buildHtml(d) {
  return '<style>' + CSS + '</style>' + (d.template === 'water' ? waterHtml(d) : agencyHtml(d));
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.crossOrigin = 'anonymous';
    s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}
let libs = null;
function loadLibs() {
  if (!libs) {
    libs = Promise.all([
      window.html2canvas ? null : loadScript('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js'),
      (window.jspdf && window.jspdf.jsPDF) ? null : loadScript('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js')
    ]).catch((e) => { libs = null; throw e; });
  }
  return libs;
}

/** Draws the invoice off-screen and returns an A4 PDF Blob. */
export async function makePdf(d) {
  await loadLibs();
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;height:1123px;overflow:hidden;background:#fff;z-index:-1;';
  host.innerHTML = buildHtml(d);
  document.body.appendChild(host);
  try {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    const page = host.querySelector('.ti-page');
    const canvas = await window.html2canvas(page, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false, width: 794, height: 1123, windowWidth: 794 });
    const pdf = new window.jspdf.jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, 210, 297);
    pdf.setProperties({ title: 'Invoice ' + (d.invoiceNumber || '') });
    return pdf.output('blob');
  } finally {
    host.remove();
  }
}

export function fileName(d) {
  return 'Invoice-' + String(d.invoiceNumber || 'bill').replace(/[^A-Za-z0-9-]/g, '') + '.pdf';
}
