// POST /api/sync  { products: [...], sales: [...] }
// The phone's background queue sends everything it has in one request; we write it to the
// sheet in a handful of batched API calls (keeps us well inside Google's quota).
//
// Everything is validated strictly here, because it ends up in your Google Sheet:
//  * text is length-limited and control characters are removed
//  * sale IDs and dates must match the exact format the app creates, so nothing that starts
//    with "=" (a spreadsheet formula) can ever reach a cell that Sheets evaluates
//  * money and quantities have sensible limits, and a sale's lines must add up to its totals
import { route, readJson, sendJson } from '../lib/http.js';
import { requireSession } from '../lib/auth.js';
import { upsertProducts, appendSales } from '../lib/sheets.js';

const MAX_ITEMS = 500;            // records per request
const MAX_PRICE = 1e6;            // $1,000,000 per item
const MAX_TOTAL = 1e8;            // $100,000,000 per sale
const MAX_QTY = 100000;
const TOLERANCE = 0.05;           // 5c for rounding when checking totals

const isMoney = (v, max = MAX_PRICE) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;
const optMoney = (v, max) => v === null || v === undefined || v === '' || isMoney(v, max);
const near = (a, b) => Math.abs(a - b) <= TOLERANCE;
/** Text: string, trimmed, control characters removed, 1..max chars. Returns null if invalid. */
function text(v, max, { allowEmpty = false } = {}) {
  if (typeof v !== 'string') return allowEmpty && (v === undefined || v === null) ? '' : null;
  const t = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if ((!t && !allowEmpty) || t.length > max) return null;
  return t;
}
const BARCODE = /^[\x21-\x7e]{1,64}$/;                       // printable, no spaces
const SALE_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,59}$/;           // e.g. S20261108-114700-K3F9QZ (never starts with - or =)
const DATE_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;   // e.g. 2026-11-08 11:47:00
const PAYMENTS = ['Cash', 'Card', 'Other'];

function badRequest(msg) { return Object.assign(new Error(msg), { status: 400 }); }

/** Returns a clean product, or a string explaining why it was rejected. */
export function cleanProduct(p) {
  if (!p || typeof p !== 'object') return 'not an object';
  const barcode = typeof p.barcode === 'string' ? p.barcode.trim() : '';
  if (!BARCODE.test(barcode)) return 'bad barcode';
  const name = text(p.name, 200);
  if (name === null) return 'bad name';
  if (!isMoney(p.price)) return 'bad price';
  if (!optMoney(p.cost)) return 'bad cost';
  const category = text(p.category, 100, { allowEmpty: true });
  if (category === null) return 'bad category';
  let stock = null;
  if (p.stock !== null && p.stock !== undefined && p.stock !== '') {
    stock = Number(p.stock);
    if (!Number.isFinite(stock) || Math.abs(stock) > 1e9) return 'bad stock';
  }
  const created = typeof p.created_at === 'string' && DATE_TIME.test(p.created_at) ? p.created_at : undefined;
  return { barcode, name, price: p.price, cost: p.cost ?? null, category, stock, created_at: created };
}

/** Returns a clean sale, or a string explaining why it was rejected. */
export function cleanSale(s) {
  if (!s || typeof s !== 'object') return 'not an object';
  if (typeof s.sale_id !== 'string' || !SALE_ID.test(s.sale_id)) return 'bad sale_id';
  if (typeof s.date_time !== 'string' || !DATE_TIME.test(s.date_time)) return 'bad date_time';
  if (!PAYMENTS.includes(s.payment_type)) return 'bad payment_type';
  if (!Array.isArray(s.items) || !s.items.length || s.items.length > 500) return 'bad items';
  if (!isMoney(s.subtotal, MAX_TOTAL) || !isMoney(s.total, MAX_TOTAL) || !optMoney(s.gst, MAX_TOTAL)) return 'bad totals';
  if (!optMoney(s.cash_received, MAX_TOTAL) || !optMoney(s.change, MAX_TOTAL)) return 'bad cash';

  const items = [];
  for (const i of s.items) {
    if (!i || typeof i !== 'object') return 'bad item';
    const name = text(i.name, 200);
    const barcode = text(i.barcode, 64, { allowEmpty: true });
    if (name === null || barcode === null) return 'bad item text';
    if (!Number.isInteger(i.qty) || i.qty < 1 || i.qty > MAX_QTY) return 'bad item qty';
    if (!isMoney(i.price) || !isMoney(i.line_total, MAX_TOTAL)) return 'bad item price';
    if (!near(i.qty * i.price, i.line_total)) return 'item line_total does not match qty x price';
    items.push({ barcode, name, qty: i.qty, price: i.price, line_total: i.line_total });
  }
  const sum = items.reduce((t, i) => t + i.line_total, 0);
  if (!near(sum, s.subtotal)) return 'items do not add up to subtotal';
  const gst = s.gst ?? 0;
  if (!near(s.total, s.subtotal) && !near(s.total, s.subtotal + gst)) return 'total does not match subtotal/GST';

  return {
    sale_id: s.sale_id,
    date_time: s.date_time,
    items,
    subtotal: s.subtotal,
    gst,
    total: s.total,
    payment_type: s.payment_type,
    cash_received: s.cash_received ?? null,
    change: s.change ?? null,
  };
}

export default route('POST', async (req, res) => {
  if (!requireSession(req, res)) return;
  const body = await readJson(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Bad request body');
  const products = Array.isArray(body.products) ? body.products : [];
  const sales = Array.isArray(body.sales) ? body.sales : [];
  if (products.length + sales.length > MAX_ITEMS) throw badRequest('Too many items in one sync');

  // Invalid records are skipped and reported (the app keeps a copy) instead of failing the whole
  // batch; otherwise one bad record would block the phone's queue forever.
  const rejected = [];
  const goodProducts = [];
  for (const p of products) {
    const c = cleanProduct(p);
    if (typeof c === 'string') rejected.push({ kind: 'product', reason: c, id: String(p?.barcode ?? '').slice(0, 64) });
    else goodProducts.push(c);
  }
  const goodSales = [];
  for (const s of sales) {
    const c = cleanSale(s);
    if (typeof c === 'string') rejected.push({ kind: 'sale', reason: c, id: String(s?.sale_id ?? '').slice(0, 60) });
    else goodSales.push(c);
  }
  if (rejected.length) console.warn('sync: skipped invalid records', rejected);

  // Products first, so a sale never references a product the sheet doesn't have yet.
  const p = await upsertProducts(goodProducts);
  const s = await appendSales(goodSales);
  sendJson(res, 200, { ok: true, products: p, sales: s, rejected });
});
