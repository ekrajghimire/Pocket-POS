// POST /api/sync  { products: [...], sales: [...] }
// The phone's background queue sends everything it has in one request; we write it to the
// sheet in a handful of batched API calls (keeps us well inside Google's quota).
import { route, readJson, sendJson } from '../lib/http.js';
import { requireSession } from '../lib/auth.js';
import { upsertProducts, appendSales } from '../lib/sheets.js';

const MAX_ITEMS = 500;
const isMoney = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e7;
const optMoney = (v) => v === null || v === undefined || v === '' || isMoney(v);
const str = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

function badRequest(msg) { return Object.assign(new Error(msg), { status: 400 }); }

// Invalid records are skipped (and reported) instead of failing the whole batch; otherwise one
// bad record would block the phone's queue forever.
const rejected = [];
function reject(kind, item) {
  rejected.push({ kind, item: JSON.stringify(item).slice(0, 200) });
  return null;
}

function cleanProduct(p) {
  if (!p || !str(p.barcode, 64) || !str(p.name, 200) || !isMoney(p.price) || !optMoney(p.cost)) {
    return reject('product', p);
  }
  const stock = p.stock === null || p.stock === undefined || p.stock === '' ? null : Number(p.stock);
  return {
    barcode: p.barcode.trim(),
    name: p.name.trim(),
    price: p.price,
    cost: p.cost ?? null,
    category: typeof p.category === 'string' ? p.category.trim().slice(0, 100) : '',
    stock: Number.isFinite(stock) ? stock : null,
    created_at: typeof p.created_at === 'string' ? p.created_at.slice(0, 30) : undefined,
  };
}

function cleanSale(s) {
  if (!s || !str(s.sale_id, 60) || !str(s.date_time, 30) || !Array.isArray(s.items) || !s.items.length
    || !isMoney(s.total) || !isMoney(s.subtotal) || !optMoney(s.gst) || !['Cash', 'Card', 'Other'].includes(s.payment_type)) {
    return reject('sale', s);
  }
  return {
    sale_id: s.sale_id,
    date_time: s.date_time,
    items: s.items.slice(0, 500).map((i) => ({
      barcode: String(i.barcode ?? '').slice(0, 64),
      name: String(i.name ?? '').slice(0, 200),
      qty: Number(i.qty) || 0,
      price: Number(i.price) || 0,
      line_total: Number(i.line_total) || 0,
    })),
    subtotal: s.subtotal,
    gst: s.gst ?? 0,
    total: s.total,
    payment_type: s.payment_type,
    cash_received: optMoney(s.cash_received) ? s.cash_received ?? null : null,
    change: optMoney(s.change) ? s.change ?? null : null,
  };
}

export default route('POST', async (req, res) => {
  if (!requireSession(req, res)) return;
  const body = await readJson(req);
  const products = Array.isArray(body.products) ? body.products : [];
  const sales = Array.isArray(body.sales) ? body.sales : [];
  if (products.length + sales.length > MAX_ITEMS) throw badRequest('Too many items in one sync');

  rejected.length = 0;
  const goodProducts = products.map(cleanProduct).filter(Boolean);
  const goodSales = sales.map(cleanSale).filter(Boolean);
  const bad = rejected.splice(0);
  if (bad.length) console.warn('sync: skipped invalid records', bad);

  // Products first, so a sale never references a product the sheet doesn't have yet.
  const p = await upsertProducts(goodProducts);
  const s = await appendSales(goodSales);
  sendJson(res, 200, { ok: true, products: p, sales: s, rejected: bad });
});
