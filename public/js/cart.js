// cart.js — cart state and money maths.
// All money is handled in integer CENTS inside the app to avoid floating-point errors
// (0.1 + 0.2 !== 0.3). Convert to dollars only when displaying or saving.

const CART_KEY = 'pos_cart_v1';
const SETTINGS_KEY = 'pos_settings_v1';

export const toCents = (dollars) => Math.round(Number(dollars) * 100);
export const toDollars = (cents) => Math.round(cents) / 100;
const fmt = new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' });
export const money = (cents) => fmt.format(toDollars(cents));

/** Parse what the user typed in a price box ("4.5", "$4.50", "4,50") into cents, or null. */
export function parseMoney(text) {
  const clean = String(text ?? '').replace(',', '.').replace(/[^0-9.]/g, '');
  if (!clean || isNaN(Number(clean))) return null;
  return toCents(clean);
}

/** Australian cash rounding: 1c and 2c coins are gone, so cash totals round to the nearest 5c. */
export const roundCash = (cents) => Math.round(cents / 5) * 5;

// ---------- Settings (GST) ----------
export const settings = Object.assign(
  { gstEnabled: true, pricesIncludeGst: true, cameraEnabled: true },
  safeParse(localStorage.getItem(SETTINGS_KEY)),
);
export function saveSettings() { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); }

// ---------- Cart ----------
// Each line: { key, barcode|null, name, unitCents, baseCents, qty }
//   key       = barcode, or "manual-<timestamp>" for manual items
//   baseCents = the product's normal price (so we can show when it was changed for this sale)
export const cart = { lines: safeParse(localStorage.getItem(CART_KEY)) || [] };

function persist() { localStorage.setItem(CART_KEY, JSON.stringify(cart.lines)); }

export function addProduct(product) {
  const key = product.barcode;
  const existing = cart.lines.find((l) => l.key === key);
  if (existing) {
    existing.qty += 1;
    // Move it to the top so the latest scan is always visible.
    cart.lines = [existing, ...cart.lines.filter((l) => l !== existing)];
  } else {
    const cents = toCents(product.price);
    cart.lines.unshift({ key, barcode: product.barcode, name: product.name, unitCents: cents, baseCents: cents, qty: 1 });
  }
  persist();
  return cart.lines[0];
}

export function addManual(name, cents) {
  const line = { key: 'manual-' + Date.now(), barcode: null, name: name || 'Item', unitCents: cents, baseCents: cents, qty: 1 };
  cart.lines.unshift(line);
  persist();
  return line;
}

export function updateLine(key, changes) {
  const line = cart.lines.find((l) => l.key === key);
  if (!line) return;
  Object.assign(line, changes);
  if (line.qty <= 0) removeLine(key);
  persist();
}

export function removeLine(key) {
  cart.lines = cart.lines.filter((l) => l.key !== key);
  persist();
}

export function clearCart() {
  cart.lines = [];
  persist();
}

export function itemCount() { return cart.lines.reduce((n, l) => n + l.qty, 0); }

/** Totals in cents, honouring the GST settings. */
export function totals() {
  const subtotal = cart.lines.reduce((s, l) => s + l.unitCents * l.qty, 0);
  let gst = 0, total = subtotal;
  if (settings.gstEnabled) {
    if (settings.pricesIncludeGst) gst = Math.round(subtotal / 11);      // GST portion of an inclusive price
    else { gst = Math.round(subtotal * 0.1); total = subtotal + gst; }   // add 10% on top
  }
  return { subtotal, gst, total };
}

function safeParse(text) { try { return JSON.parse(text); } catch { return null; } }
