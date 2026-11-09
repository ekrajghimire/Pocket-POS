// receipt.js — printable receipts / tax invoices.
//
// Printing uses the browser's normal print dialog, so it works with any printer the device
// can already print to: USB/network thermal receipt printers (58 mm or 80 mm), office printers,
// AirPrint (iPhone/iPad) and Android printing. The layout is plain text-style so it looks
// right on narrow thermal paper.
//
// Shop details are saved on each device (Settings > Receipt settings).

const KEY = 'pos_receipt_v1';
const LAST_SALE_KEY = 'pos_last_sale_v1';

export const receiptSettings = Object.assign(
  {
    shopName: 'Pocket POS', address: '', address2: '', abn: '', phone: '', footer: 'Thank you for visiting us', paper: '80', autoPrint: false,
    drawerEnabled: false,   // a cash drawer is plugged into this device's receipt printer
    drawerOnCash: true,     // pop it automatically for cash sales
    drawerMethod: 'print',  // 'print' = print a slip (printer driver opens the drawer)
                            // 'helper' = Pocket POS Drawer Helper on this PC (no paper)
  },
  safeParse(localStorage.getItem(KEY)),
);
export function saveReceiptSettings() { localStorage.setItem(KEY, JSON.stringify(receiptSettings)); }

export function rememberLastSale(sale) { localStorage.setItem(LAST_SALE_KEY, JSON.stringify(sale)); }
export function lastSale() { return safeParse(localStorage.getItem(LAST_SALE_KEY)); }

const fmt = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
const $$ = (dollars) => fmt.format(Number(dollars) || 0);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const row = (left, right, cls = '') => `<div class="r-row ${cls}"><span>${left}</span><span>${right}</span></div>`;

/** "2026-11-07 15:20:31" -> { date: "2026-11-07", time: "3:20:31 PM" } (same style as the old receipts) */
function splitDate(text) {
  const d = new Date(String(text).replace(' ', 'T'));
  if (isNaN(d)) return { date: esc(text), time: '' };
  const pad = (n) => String(n).padStart(2, '0');
  const h = d.getHours() % 12 || 12;
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${h}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getHours() < 12 ? 'AM' : 'PM'}`,
  };
}
const num = (v) => (Number(v) || 0).toFixed(2);   // 2.5 -> "2.50" (no $ inside the table)
const qtyText = (q) => (Number.isInteger(Number(q)) ? String(q) : Number(q).toFixed(3));
const sumRow = (label, value, cls = '') => `<span class="${cls}">${label}</span><span class="${cls}">${value}</span>`;

/** Build the receipt HTML for a sale record (the same object that is saved to the Sales sheet). */
export function receiptHtml(sale) {
  const s = receiptSettings;
  const gst = Number(sale.gst) || 0;
  const exclusive = Number(sale.total) > Number(sale.subtotal) + 0.001;
  const { date, time } = splitDate(sale.date_time);

  // Shop header (centred)
  const header = [
    `<div class="r-shop">${esc(s.shopName || 'Receipt')}</div>`,
    s.address && `<div class="r-center">${esc(s.address)}</div>`,
    s.address2 && `<div class="r-center">${esc(s.address2)}</div>`,
    s.abn && `<div class="r-center">ABN: ${esc(s.abn)}</div>`,
    s.phone && `<div class="r-center">Ph: ${esc(s.phone)}</div>`,
    // With an ABN and GST, the words "Tax Invoice" make this a valid Australian tax invoice.
    gst > 0 && s.abn && '<div class="r-center r-title">TAX INVOICE</div>',
  ].filter(Boolean).join('');

  // Receipt number, date and time (right-aligned, like the old receipts)
  const meta = `<div class="r-meta">
      <div>Receipt No: ${esc(sale.sale_id)}</div>
      <div>Date: ${date}</div>
      <div>Time: ${time}</div>
    </div>`;

  // Item table: S.N | NAME | QTY | RATE | AMT.
  // On narrow 58 mm paper each item takes two lines: the name, then "qty x rate ... amount".
  // Dashed rules are full-width rows (one continuous line, not one per column).
  const rule = (cols) => `<tr class="rule"><td colspan="${cols}"><div></div></td></tr>`;
  let table;
  if (s.paper === '58') {
    const rows = sale.items.map((i, n) => `<tbody class="item">
        <tr><td class="sn">${n + 1}</td><td colspan="2" class="nm">${esc(i.name)}</td></tr>
        <tr><td></td><td class="qr">${qtyText(i.qty)} x ${num(i.price)}</td><td class="n">${num(i.line_total)}</td></tr>
      </tbody>`).join('');
    table = `<table class="r-items narrow">
        <thead>${rule(3)}<tr><th class="sn">S.N</th><th class="nm">NAME / QTY x RATE</th><th class="n">AMT</th></tr>${rule(3)}</thead>
        ${rows}
        <tbody>${rule(3)}</tbody>
      </table>`;
  } else {
    const rows = sale.items.map((i, n) => `<tr>
        <td class="sn">${n + 1}</td><td class="nm">${esc(i.name)}</td>
        <td class="q">${qtyText(i.qty)}</td><td class="n">${num(i.price)}</td><td class="n">${num(i.line_total)}</td>
      </tr>`).join('');
    table = `<table class="r-items">
        <thead>${rule(5)}<tr><th class="sn">S.N</th><th class="nm">NAME</th><th class="q">QTY</th><th class="n">RATE</th><th class="n">AMT</th></tr>${rule(5)}</thead>
        <tbody>${rows}</tbody>
        <tbody>${rule(5)}</tbody>
      </table>`;
  }

  // Totals (right-aligned)
  let sums = sumRow('Net Amount:', num(sale.subtotal));
  if (gst > 0) sums += sumRow(exclusive ? 'GST (10%):' : 'GST (incl.):', num(gst));
  sums += sumRow('Total:', '$' + num(sale.total), 'r-grand');

  // Payment (same grid as the totals, so everything lines up)
  let pay = '<i class="gap"></i>' + sumRow('Payment:', esc(sale.payment_type));
  if (sale.payment_type === 'Cash' && sale.cash_received !== null && sale.cash_received !== undefined) {
    const due = Number(sale.cash_received) - Number(sale.change || 0);
    const rounding = Math.round((due - Number(sale.total)) * 100) / 100;
    if (Math.abs(rounding) >= 0.01) pay += sumRow('Rounding:', (rounding > 0 ? '+' : '-') + num(Math.abs(rounding)));
    pay += sumRow('Cash:', num(sale.cash_received)) + sumRow('Change:', num(sale.change), 'r-strong');
  }

  return header + meta + table
    + `<div class="r-sum">${sums}${pay}</div>`
    + (s.footer ? `<div class="r-rule"></div><div class="r-center r-footer">${esc(s.footer)}</div>` : '');
}

/** Put the receipt into the hidden #receipt element and open the print dialog. */
export function printReceipt(sale) {
  const el = document.getElementById('receipt');
  const paper = receiptSettings.paper;
  el.className = 'receipt ' + (paper === '58' ? 'w58' : paper === 'a4' ? 'a4' : 'w80');
  el.innerHTML = receiptHtml(sale);
  // Give the browser a moment to lay out the receipt before printing.
  return new Promise((resolve) => setTimeout(() => { window.print(); resolve(); }, 60));
}

// ---- Cash drawer -------------------------------------------------------------------------------
// Drawers plugged into a receipt printer (RJ11/RJ12 cable) are opened BY THE PRINTER. Two ways:
//  'print'  : print a tiny slip; the printer driver's "open drawer before printing" option pops it.
//  'helper' : the Pocket POS Drawer Helper (windows-helper folder) runs on the PC and sends the
//             printer the raw "kick drawer" command. Nothing is printed.

export const HELPER_URL = 'http://127.0.0.1:17777';

async function callHelper(path, method = 'GET') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  try {
    // targetAddressSpace tells Chrome this is a request to this computer (local network access).
    const res = await fetch(HELPER_URL + path, { method, signal: ctrl.signal, cache: 'no-store', targetAddressSpace: 'loopback' });
    if (!res.ok) {
      const bad = await res.json().catch(() => ({}));
      throw new Error(bad.error || `Drawer Helper error ${res.status}`);
    }
    // A 2xx reply means the helper did the job, even if the rest of its reply got cut short.
    const data = await res.json().catch(() => ({ ok: true }));
    if (data.ok === false) throw new Error(data.error || 'Drawer Helper reported a problem');
    return data;
  } catch (err) {
    if (err.name === 'AbortError' || err instanceof TypeError) {
      throw new Error('Drawer Helper is not running on this PC (or Chrome blocked it)');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Ask the helper if it's running. Resolves {ok, printer, pin} or throws. */
export const checkHelper = () => callHelper('/status');

/**
 * Open the drawer. Resolves to 'helper', 'slip' or 'failed'.
 *  - Helper mode: the Drawer Helper opens it and NOTHING is printed. If the helper can't be
 *    reached we report it (onError) and print nothing: with the printer driver's drawer
 *    option off, a slip wouldn't open the drawer anyway.
 *  - Print mode: prints a short slip; the printer driver opens the drawer as it prints.
 */
export async function openDrawer(reason = 'NO SALE', sale = null, { onError = () => {} } = {}) {
  if (receiptSettings.drawerMethod === 'helper') {
    try { await callHelper('/open', 'POST'); return 'helper'; }
    catch (err) { onError(err); return 'failed'; }
  }
  await printDrawerSlip(reason, sale);
  return 'slip';
}

/** Print a short slip; with the driver's cash-drawer option on, printing it opens the drawer. */
export function printDrawerSlip(reason = 'NO SALE', sale = null) {
  const el = document.getElementById('receipt');
  const paper = receiptSettings.paper;
  el.className = 'receipt slip ' + (paper === '58' ? 'w58' : paper === 'a4' ? 'a4' : 'w80');
  const now = new Date().toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' }).toUpperCase();
  el.innerHTML = `<div class="r-title">${esc(reason)}</div>`
    + `<div class="r-center">${esc(now)}</div>`
    + (sale ? row(`No. ${esc(sale.sale_id)}`, '') + row('Total', $$(sale.total))
      + (sale.cash_received != null ? row('Cash', $$(sale.cash_received)) + row('Change', $$(sale.change), 'r-strong') : '') : '');
  return new Promise((resolve) => setTimeout(() => { window.print(); resolve(); }, 60));
}

/** A sample sale for "Print test receipt". */
export function sampleSale() {
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date();
  return {
    sale_id: 'TEST',
    date_time: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:00`,
    items: [
      { barcode: '', name: 'Sample item', qty: 2, price: 3.5, line_total: 7 },
      { barcode: '', name: 'Another item with a long name', qty: 1, price: 12.95, line_total: 12.95 },
    ],
    subtotal: 19.95, gst: 1.81, total: 19.95, payment_type: 'Cash', cash_received: 20, change: 0.05,
  };
}

function safeParse(text) { try { return JSON.parse(text); } catch { return null; } }
