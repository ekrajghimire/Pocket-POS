import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanProduct, cleanSale } from '../api/sync.js';

const sale = (over = {}) => ({
  sale_id: 'S20261108-114700-K3F9QZ', date_time: '2026-11-08 11:47:00',
  items: [{ barcode: '9300601000001', name: 'Milk 2L', qty: 2, price: 3.5, line_total: 7 },
          { barcode: '', name: 'Manual item', qty: 1, price: 1.25, line_total: 1.25 }],
  subtotal: 8.25, gst: 0.75, total: 8.25, payment_type: 'Cash', cash_received: 10, change: 1.75, ...over,
});
const product = (over = {}) => ({ barcode: '0012345', name: 'Bread', price: 4.5, cost: 2, category: 'Bakery', stock: 10, ...over });

test('valid sale and product pass unchanged', () => {
  assert.equal(typeof cleanSale(sale()), 'object');
  assert.equal(cleanSale(sale()).items.length, 2);
  assert.deepEqual(cleanProduct(product()), { ...product(), created_at: undefined });
  assert.equal(cleanProduct(product()).barcode, '0012345', 'leading zeros kept');
});

test('GST modes: inclusive (total = subtotal), added (total = subtotal + gst), off', () => {
  assert.equal(typeof cleanSale(sale()), 'object');
  assert.equal(typeof cleanSale(sale({ gst: 0.83, total: 9.08 })), 'object');
  assert.equal(typeof cleanSale(sale({ gst: 0, total: 8.25 })), 'object');
  assert.equal(typeof cleanSale(sale({ gst: null, total: 8.25 })), 'object');
  assert.equal(typeof cleanSale(sale({ total: 8.27, payment_type: 'Card', cash_received: null, change: null })), 'object', 'rounding tolerance');
});

test('formula injection into cells Sheets evaluates is impossible', () => {
  for (const id of ['=HYPERLINK("http://evil")', '+1+1', '-1', '-A1', '@SUM(A1)', 'S 1', 'S1;', 'x'.repeat(61), '', 7]) {
    assert.equal(cleanSale(sale({ sale_id: id })), 'bad sale_id', String(id));
  }
  for (const dt of ['=NOW()', '2026-11-08', '2026-11-08T11:47:00', '2026-11-08 11:47:00x', '+2026-11-08 11:47:00']) {
    assert.equal(cleanSale(sale({ date_time: dt })), 'bad date_time', dt);
  }
  for (const pt of ['=1', 'cash', 'Bitcoin', '', null]) assert.equal(cleanSale(sale({ payment_type: pt })), 'bad payment_type');
});

test('money and quantity bounds', () => {
  const one = (i) => cleanSale(sale({ items: [i], subtotal: Math.abs(i.line_total) || 0, total: Math.abs(i.line_total) || 0, gst: 0, cash_received: null, change: null }));
  assert.equal(one({ name: 'a', qty: 0, price: 1, line_total: 0 }), 'bad item qty');
  assert.equal(one({ name: 'a', qty: -1, price: 1, line_total: -1 }), 'bad item qty');
  assert.equal(one({ name: 'a', qty: 1.5, price: 1, line_total: 1.5 }), 'bad item qty');
  assert.equal(one({ name: 'a', qty: 100001, price: 1, line_total: 100001 }), 'bad item qty');
  assert.equal(one({ name: 'a', qty: '2', price: 1, line_total: 2 }), 'bad item qty');
  assert.equal(one({ name: 'a', qty: 1, price: -1, line_total: -1 }), 'bad item price');
  assert.equal(one({ name: 'a', qty: 1, price: NaN, line_total: 0 }), 'bad item price');
  assert.equal(one({ name: 'a', qty: 1, price: Infinity, line_total: 1 }), 'bad item price');
  assert.equal(one({ name: 'a', qty: 1, price: '5', line_total: 5 }), 'bad item price');
  assert.equal(one({ name: 'a', qty: 1, price: 2e6, line_total: 2e6 }), 'bad item price');
  assert.match(one({ name: 'a', qty: 9999, price: 99999.99, line_total: 999899900.01 }), /^bad (totals|item price)$/, 'line over $100M');
  assert.equal(typeof one({ name: 'free', qty: 1, price: 0, line_total: 0 }), 'object', '$0 item allowed');
});

test('totals must be consistent', () => {
  assert.equal(cleanSale(sale({ items: [{ name: 'a', qty: 2, price: 3.5, line_total: 1 }], subtotal: 1, total: 1 })), 'item line_total does not match qty x price');
  assert.equal(cleanSale(sale({ subtotal: 100, total: 100 })), 'items do not add up to subtotal');
  assert.equal(cleanSale(sale({ total: 0.01 })), 'total does not match subtotal/GST');
  assert.equal(cleanSale(sale({ total: -8.25 })), 'bad totals');
  assert.equal(cleanSale(sale({ cash_received: -1 })), 'bad cash');
});

test('structure: missing/garbage fields', () => {
  for (const bad of [null, 1, 'x', [], {}]) assert.equal(typeof cleanSale(bad), 'string');
  assert.equal(cleanSale(sale({ items: [] })), 'bad items');
  assert.equal(cleanSale(sale({ items: 'x' })), 'bad items');
  assert.equal(cleanSale(sale({ items: [null] })), 'bad item');
  assert.equal(cleanSale(sale({ items: Array(501).fill({ name: 'a', qty: 1, price: 0, line_total: 0 }), subtotal: 0, total: 0 })), 'bad items');
  assert.equal(cleanSale(sale({ items: [{ name: '', qty: 1, price: 1, line_total: 1 }], subtotal: 1, total: 1 })), 'bad item text');
  assert.equal(cleanSale(sale({ items: [{ name: 'a'.repeat(201), qty: 1, price: 1, line_total: 1 }], subtotal: 1, total: 1 })), 'bad item text');
  assert.equal(cleanSale(sale({ items: [{ name: { $gt: '' }, qty: 1, price: 1, line_total: 1 }], subtotal: 1, total: 1 })), 'bad item text');
});

test('product validation', () => {
  for (const b of ['', ' ', 'has space', 'x'.repeat(65), 'tab\t1', 'ünï', null, 123]) assert.equal(cleanProduct(product({ barcode: b })), 'bad barcode', String(b));
  assert.equal(cleanProduct(product({ barcode: '  0123  ' })).barcode, '0123');
  assert.equal(cleanProduct(product({ name: '' })), 'bad name');
  assert.equal(cleanProduct(product({ name: 'x'.repeat(201) })), 'bad name');
  assert.equal(cleanProduct(product({ price: -1 })), 'bad price');
  assert.equal(cleanProduct(product({ price: '4' })), 'bad price');
  assert.equal(cleanProduct(product({ cost: -2 })), 'bad cost');
  assert.equal(cleanProduct(product({ stock: 'lots' })), 'bad stock');
  assert.equal(cleanProduct(product({ stock: 1e10 })), 'bad stock');
  assert.equal(cleanProduct(product({ category: 'x'.repeat(101) })), 'bad category');
  assert.equal(cleanProduct(product({ cost: null, stock: null, category: undefined })).category, '');
  assert.equal(cleanProduct(product({ created_at: '=NOW()' })).created_at, undefined, 'bad created_at dropped');
});

test('control characters are stripped from text', () => {
  const p = cleanProduct(product({ name: 'Mi\u0000lk\u001b[31m\r\n' }));
  assert.equal(p.name, 'Milk[31m');
  const s = cleanSale(sale({ items: [{ name: '\u0007Tea', qty: 1, price: 1, line_total: 1 }], subtotal: 1, total: 1, gst: 0 }));
  assert.equal(s.items[0].name, 'Tea');
});
