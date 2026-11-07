// store.js — local data: product lookup Map, IndexedDB cache, and the background sync queue.
//
// Rules that keep scanning instant:
//  * A scan only ever reads the in-memory Map. It never waits for the network.
//  * The Map is filled from IndexedDB at startup (instant, works offline), then refreshed
//    from the server in the background.
//  * New products and sales go into an "outbox" in IndexedDB and are sent in batches.
//    If the connection drops they wait there and are retried with backoff.

const DB_NAME = 'pocket-pos';
const DB_VERSION = 1;

export const products = new Map();   // barcode -> {barcode, name, price, cost, category, stock}

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('products')) d.createObjectStore('products', { keyPath: 'barcode' });
        if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'id', autoIncrement: true });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

/** Run fn(store) in a transaction and resolve when it commits. */
async function tx(storeName, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    const r = fn(store);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const getAll = (name) => tx(name, 'readonly', (s) => s.getAll());

// ---------- Products ----------

/** Look up a scanned code. Also tries the UPC-A <-> EAN-13 forms (same product, leading 0). */
export function lookup(code) {
  if (products.has(code)) return products.get(code);
  if (/^\d{12}$/.test(code) && products.has('0' + code)) return products.get('0' + code);
  if (/^0\d{12}$/.test(code) && products.has(code.slice(1))) return products.get(code.slice(1));
  return null;
}

export async function loadProductsFromCache() {
  const list = await getAll('products');
  products.clear();
  for (const p of list) products.set(p.barcode, p);
  const meta = await tx('meta', 'readonly', (s) => s.get('productsFetchedAt'));
  return { count: products.size, fetchedAt: meta ? meta.value : null };
}

/** Replace the whole product list (after downloading it from the server). */
export async function replaceProducts(list) {
  // Keep products created on this phone that haven't reached the sheet yet.
  const pending = (await getAll('outbox')).filter((o) => o.type === 'product').map((o) => o.payload);
  products.clear();
  for (const p of list) products.set(p.barcode, p);
  for (const p of pending) products.set(p.barcode, p);
  await tx('products', 'readwrite', (s) => { s.clear(); for (const p of products.values()) s.put(p); });
  await tx('meta', 'readwrite', (s) => s.put({ key: 'productsFetchedAt', value: Date.now() }));
}

export async function saveProductLocally(p) {
  products.set(p.barcode, p);
  await tx('products', 'readwrite', (s) => s.put(p));
}

export function categories() {
  const set = new Set();
  for (const p of products.values()) if (p.category) set.add(p.category);
  return [...set].sort();
}

// ---------- API helper ----------

export class AuthError extends Error {}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  if (res.status === 401) throw new AuthError('Session expired');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/** Download every product from the sheet into memory + IndexedDB. */
export async function refreshProducts() {
  const data = await api('/api/products');
  await replaceProducts(data.products);
  return products.size;
}

// ---------- Outbox / background sync ----------

const listeners = new Set();
export const syncState = { pending: 0, status: 'synced', lastError: null };
export function onSyncChange(fn) { listeners.add(fn); fn(syncState); }
function emit(patch) { Object.assign(syncState, patch); listeners.forEach((fn) => fn(syncState)); }

let flushTimer = null;
let flushing = false;
let backoff = 0;           // ms; grows after failures
let onAuthLost = () => {};
export function setAuthLostHandler(fn) { onAuthLost = fn; }

/** Queue a write ('product' or 'sale'). Returns immediately; sending happens in the background. */
export async function enqueue(type, payload) {
  await tx('outbox', 'readwrite', (s) => s.add({ type, payload, queuedAt: Date.now() }));
  await countPending();
  scheduleFlush(400); // short delay so several quick writes go in ONE request (Sheets quota)
}

async function countPending() {
  const n = await tx('outbox', 'readonly', (s) => s.count());
  emit({ pending: n, status: n ? (navigator.onLine ? 'pending' : 'offline') : 'synced' });
  return n;
}

export function scheduleFlush(delay = 0) {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, delay);
}

export async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    const items = (await getAll('outbox')).slice(0, 200); // max 200 writes per request
    if (!items.length) { emit({ pending: 0, status: 'synced', lastError: null }); return; }
    if (!navigator.onLine) { emit({ status: 'offline' }); return; }
    emit({ status: 'syncing' });

    const body = {
      products: items.filter((i) => i.type === 'product').map((i) => i.payload),
      sales: items.filter((i) => i.type === 'sale').map((i) => i.payload),
    };
    await api('/api/sync', { method: 'POST', body });

    // Success: remove what we sent.
    await tx('outbox', 'readwrite', (s) => { for (const i of items) s.delete(i.id); });
    backoff = 0;
    emit({ lastError: null });
    const left = await countPending();
    if (left) scheduleFlush(0);
  } catch (err) {
    if (err instanceof AuthError) { emit({ status: 'error', lastError: 'Logged out' }); onAuthLost(); return; }
    backoff = Math.min(backoff ? backoff * 2 : 2000, 60000); // 2s, 4s, 8s … max 60s
    emit({ status: navigator.onLine ? 'error' : 'offline', lastError: err.message });
    scheduleFlush(backoff);
  } finally {
    flushing = false;
  }
}

export function startSyncLoop() {
  countPending().then((n) => n && scheduleFlush(0));
  window.addEventListener('online', () => scheduleFlush(0));
  window.addEventListener('offline', () => countPending());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleFlush(0); });
  setInterval(() => { if (syncState.pending && !flushing) scheduleFlush(0); }, 30000);
}
