// lib/demo-db.js — stand-in for Google Sheets while trying the app locally (`npm run dev`
// with no Google env vars). Data goes to .data/demo-db.json. Not used in production.

import fs from 'node:fs';
import path from 'node:path';

const FILE = path.join(process.cwd(), '.data', 'demo-db.json');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch {
    // A few sample products so scanning works straight away.
    return {
      products: [
        { barcode: '9300675024235', name: 'Sample Water 600ml', price: 2.5, cost: 0.8, category: 'Drinks', stock: 24 },
        { barcode: '9310072001111', name: 'Sample Chips 175g', price: 4.0, cost: 1.9, category: 'Snacks', stock: 12 },
      ],
      sales: [],
    };
  }
}
function save(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(db, null, 2));
}

export function readProducts() { return load().products; }

export function upsertProducts(list) {
  const db = load();
  let inserted = 0, updated = 0;
  for (const p of list) {
    const i = db.products.findIndex((x) => x.barcode === p.barcode);
    const clean = { barcode: p.barcode, name: p.name, price: p.price, cost: p.cost ?? null, category: p.category || '', stock: p.stock ?? null };
    if (i >= 0) { db.products[i] = clean; updated++; } else { db.products.push(clean); inserted++; }
  }
  save(db);
  return { inserted, updated };
}

export function appendSales(sales) {
  const db = load();
  const ids = new Set(db.sales.map((s) => s.sale_id));
  const fresh = sales.filter((s) => !ids.has(s.sale_id));
  db.sales.push(...fresh);
  save(db);
  return { inserted: fresh.length };
}
