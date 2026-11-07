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
    shopName: 'Pocket POS', address: '', abn: '', phone: '', footer: 'Thank you!', paper: '80', autoPrint: false,
    drawerEnabled: false,   // a cash drawer is plugged into this device's receipt printer
    drawerOnCash: true,     // pop it automatically for cash sales
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

/** "2026-11-07 15:20:31" -> "07/11/2026 3:20 pm" */
function niceDate(text) {
  const d = new Date(String(text).replace(' ', 'T'));
  if (isNaN(d)) return esc(text);
  return d.toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Build the receipt HTML for a sale record (the same object that is saved to the Sales sheet). */
export function receiptHtml(sale) {
  const s = receiptSettings;
  const gst = Number(sale.gst) || 0;
  const exclusive = Number(sale.total) > Number(sale.subtotal) + 0.001;
  // In Australia a document with the seller's ABN and the GST amount works as a tax invoice.
  const title = gst > 0 && s.abn ? 'TAX INVOICE' : 'RECEIPT';

  const header = [
    `<div class="r-shop">${esc(s.shopName || 'Receipt')}</div>`,
    s.address && `<div class="r-center">${esc(s.address)}</div>`,
    s.abn && `<div class="r-center">ABN ${esc(s.abn)}</div>`,
    s.phone && `<div class="r-center">Ph ${esc(s.phone)}</div>`,
    `<div class="r-title">${title}</div>`,
    row(niceDate(sale.date_time), ''),
    row(`No. ${esc(sale.sale_id)}`, ''),
  ].filter(Boolean).join('');

  const items = sale.items.map((i) => {
    const qtyLine = i.qty === 1 ? '' : row(`&nbsp;&nbsp;${i.qty} x ${$$(i.price)}`, '');
    return row(esc(i.name), $$(i.line_total), 'r-item') + qtyLine;
  }).join('');

  const itemCount = sale.items.reduce((n, i) => n + (Number(i.qty) || 0), 0);
  let totals = '';
  if (exclusive) {
    totals += row('Subtotal', $$(sale.subtotal)) + row('GST 10%', $$(gst));
  }
  totals += row('TOTAL', $$(sale.total), 'r-total');
  if (gst > 0 && !exclusive) totals += row('Includes GST', $$(gst));

  let payment = row(`Paid by ${esc(sale.payment_type)}`, '');
  if (sale.payment_type === 'Cash' && sale.cash_received !== null && sale.cash_received !== undefined) {
    const due = Number(sale.cash_received) - Number(sale.change || 0);
    const rounding = Math.round((due - Number(sale.total)) * 100) / 100;
    if (Math.abs(rounding) >= 0.01) payment += row('Cash rounding', (rounding > 0 ? '+' : '−') + $$(Math.abs(rounding)));
    payment += row('Cash', $$(sale.cash_received)) + row('Change', $$(sale.change), 'r-strong');
  }

  return header
    + '<hr>' + items
    + '<hr>' + row(`${itemCount} item${itemCount === 1 ? '' : 's'}`, '') + totals
    + '<hr>' + payment
    + (s.footer ? `<hr><div class="r-center r-footer">${esc(s.footer)}</div>` : '');
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

/**
 * Open the cash drawer.
 *
 * Drawers plugged into a receipt printer (RJ11/RJ12 cable) are opened BY THE PRINTER, and
 * the printer's Windows driver can be set to "open cash drawer" whenever it prints. So to open
 * the drawer we print a tiny slip. This also leaves a paper trail for "no sale" opens.
 * (A printed receipt opens the drawer by itself, so there's no need to call this as well.)
 */
export function openDrawer(reason = 'NO SALE', sale = null) {
  const el = document.getElementById('receipt');
  const paper = receiptSettings.paper;
  el.className = 'receipt slip ' + (paper === '58' ? 'w58' : paper === 'a4' ? 'a4' : 'w80');
  const now = new Date().toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' });
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
