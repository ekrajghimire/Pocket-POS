// lib/sheets.js — Google Sheets as the database, via the Sheets REST API and a service account.
// No Google SDK needed: we sign the service-account JWT with Node's crypto and use fetch().
//
// Env vars (server only — never sent to the browser):
//   SHEET_ID                       the long ID in the sheet's URL
//   GOOGLE_SERVICE_ACCOUNT_JSON    the whole JSON key file pasted as one value   (easiest)
//     – or –
//   GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_PRIVATE_KEY
//   TZ_NAME                        optional, default Australia/Sydney (for updated_at stamps)
//
// If none of these are set and you run `npm run dev`, a local JSON file is used instead
// (demo mode) so you can try the app before doing the Google setup.

import crypto from 'node:crypto';
import * as demo from './demo-db.js';

export const PRODUCT_COLUMNS = ['barcode', 'name', 'price', 'cost', 'category', 'stock', 'created_at', 'updated_at'];
export const SALES_COLUMNS = ['sale_id', 'date_time', 'items', 'subtotal', 'gst', 'total', 'payment_type', 'cash_received', 'change'];

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function credentials() {
  let raw = String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (raw.startsWith('GOOGLE_SERVICE_ACCOUNT_JSON=')) raw = raw.slice('GOOGLE_SERVICE_ACCOUNT_JSON='.length).trim();
  if (/^'.*'$/s.test(raw)) raw = raw.slice(1, -1);
  if (raw) {
    let j;
    try { j = JSON.parse(raw); } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON; paste the whole key file, from { to }');
    }
    return { email: j.client_email, key: j.private_key };
  }
  if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    // Env UIs often store newlines as the two characters "\n"; turn them back into newlines.
    return { email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL, key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') };
  }
  return null;
}

const sheetId = () => String(process.env.SHEET_ID || '').trim().replace(/^SHEET_ID=/, '');
export const sheetsConfigured = () => !!(sheetId() && (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_PRIVATE_KEY));
const useDemo = () => !sheetsConfigured() && process.env.POS_DEV === '1' && !process.env.VERCEL;

function assertConfigured() {
  if (!sheetsConfigured()) {
    throw Object.assign(new Error('Google Sheets is not configured (set SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON)'), { status: 500 });
  }
}

// ---------- OAuth access token (cached ~1 hour per server instance) ----------
let token = { value: null, exp: 0 };

async function accessToken() {
  if (token.value && Date.now() < token.exp - 60_000) return token.value;
  const { email, key } = credentials();
  const now = Math.floor(Date.now() / 1000);
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(key).toString('base64url');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Google auth failed: ' + (data.error_description || data.error || res.status));
  token = { value: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return token.value;
}

/** Call the Sheets API, retrying on rate limits (429) and server errors with backoff. */
async function sheetsApi(path, { method = 'GET', query = {}, body } = {}) {
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId()}${path}`);
  for (const [k, v] of Object.entries(query)) {
    for (const item of [].concat(v)) url.searchParams.append(k, item);
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 4) {
      const text = await res.text();
      let msg = text;
      try { msg = JSON.parse(text).error.message; } catch { /* keep raw text */ }
      if (res.status === 403 || res.status === 404) msg += ' — is the sheet shared with the service account email, and is SHEET_ID right?';
      throw new Error(`Google Sheets ${res.status}: ${msg}`);
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 300)); // 0.5s,1s,2s,4s
  }
}

const range = (r) => `/values/${encodeURIComponent(r)}`;

/** "2026-11-07 14:05:09" in the shop's time zone. */
function nowStamp() {
  return new Date().toLocaleString('sv-SE', { timeZone: process.env.TZ_NAME || 'Australia/Sydney' });
}

// ---------- One-time setup: create tabs + header rows if missing ----------
let ensured = null;
function ensureSheets() {
  if (!ensured) ensured = doEnsureSheets().catch((err) => { ensured = null; throw err; });
  return ensured;
}

async function doEnsureSheets() {
  const meta = await sheetsApi('', { query: { fields: 'sheets.properties(sheetId,title)' } });
  const ids = Object.fromEntries((meta.sheets || []).map((s) => [s.properties.title, s.properties.sheetId]));

  const tabs = { Products: PRODUCT_COLUMNS, Sales: SALES_COLUMNS };
  const missing = Object.keys(tabs).filter((t) => ids[t] === undefined);
  if (missing.length) {
    const r = await sheetsApi(':batchUpdate', { method: 'POST', body: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) } });
    for (const reply of r.replies) if (reply.addSheet) ids[reply.addSheet.properties.title] = reply.addSheet.properties.sheetId;
  }

  const headers = await sheetsApi('/values:batchGet', { query: { ranges: ['Products!1:1', 'Sales!1:1'] } });
  const needHeader = Object.keys(tabs).filter((t, i) => !(headers.valueRanges[i].values || []).length);
  if (!needHeader.length) return;

  await sheetsApi('/values:batchUpdate', {
    method: 'POST',
    body: { valueInputOption: 'RAW', data: needHeader.map((t) => ({ range: `${t}!A1`, values: [tabs[t]] })) },
  });
  // Freeze + bold the header row, and format Products column A (barcode) as plain TEXT
  // so leading zeros are never lost — even when you type barcodes into the sheet by hand.
  const requests = [];
  for (const t of needHeader) {
    requests.push({ updateSheetProperties: { properties: { sheetId: ids[t], gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } });
    requests.push({ repeatCell: { range: { sheetId: ids[t], startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } });
  }
  if (needHeader.includes('Products')) {
    requests.push({ repeatCell: { range: { sheetId: ids.Products, startColumnIndex: 0, endColumnIndex: 1 }, cell: { userEnteredFormat: { numberFormat: { type: 'TEXT' } } }, fields: 'userEnteredFormat.numberFormat' } });
  }
  await sheetsApi(':batchUpdate', { method: 'POST', body: { requests } });
}

// ---------- Products ----------
const numOrNull = (v) => (v === '' || v === undefined || v === null || isNaN(Number(v)) ? null : Number(v));

export async function readProducts() {
  if (useDemo()) return demo.readProducts();
  assertConfigured();
  await ensureSheets();
  const r = await sheetsApi(range('Products!A2:F'), { query: { valueRenderOption: 'UNFORMATTED_VALUE' } });
  return (r.values || [])
    .filter((row) => row[0] !== undefined && String(row[0]).trim() !== '')
    .map((row) => ({
      barcode: String(row[0]).trim(),
      name: String(row[1] ?? '').trim(),
      price: numOrNull(row[2]) ?? 0,
      cost: numOrNull(row[3]),
      category: String(row[4] ?? '').trim(),
      stock: numOrNull(row[5]),
    }));
}

/**
 * Insert new products / update existing ones (matched by barcode).
 * Batched: at most 3 API calls no matter how many products are sent.
 */
export async function upsertProducts(list) {
  if (!list.length) return { inserted: 0, updated: 0 };
  if (useDemo()) return demo.upsertProducts(list);
  assertConfigured();
  await ensureSheets();

  const col = await sheetsApi(range('Products!A2:A'), { query: { valueRenderOption: 'UNFORMATTED_VALUE' } });
  const rowOf = new Map();
  (col.values || []).forEach((r, i) => { if (r[0] !== undefined) rowOf.set(String(r[0]).trim(), i + 2); });

  const latest = new Map(list.map((p) => [p.barcode, p])); // de-duplicate: last write wins
  const now = nowStamp();
  const updates = [];
  const appends = [];
  for (const p of latest.values()) {
    const fields = [p.name, p.price, p.cost ?? '', p.category ?? '', p.stock ?? ''];
    const row = rowOf.get(p.barcode);
    if (row) {
      updates.push({ range: `Products!B${row}:F${row}`, values: [fields] });
      updates.push({ range: `Products!H${row}`, values: [[now]] });
    } else {
      appends.push([p.barcode, ...fields, p.created_at || now, now]);
    }
  }
  // RAW = store exactly what we send, so "0123" stays the text "0123".
  if (updates.length) await sheetsApi('/values:batchUpdate', { method: 'POST', body: { valueInputOption: 'RAW', data: updates } });
  if (appends.length) {
    await sheetsApi(`${range('Products!A:H')}:append`, {
      method: 'POST', query: { valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS' }, body: { values: appends },
    });
  }
  return { inserted: appends.length, updated: updates.length / 2 };
}

// ---------- Sales ----------

/** Append sales. Sales whose sale_id is already in the sheet are skipped, so retries are safe. */
export async function appendSales(sales) {
  if (!sales.length) return { inserted: 0 };
  if (useDemo()) return demo.appendSales(sales);
  assertConfigured();
  await ensureSheets();

  const col = await sheetsApi(range('Sales!A2:A'));
  const existing = new Set((col.values || []).map((r) => String(r[0])));
  const rows = sales
    .filter((s) => !existing.has(s.sale_id))
    .map((s) => [s.sale_id, s.date_time, JSON.stringify(s.items), s.subtotal, s.gst, s.total, s.payment_type, s.cash_received ?? '', s.change ?? '']);
  if (rows.length) {
    // USER_ENTERED so date_time becomes a real date you can sort/filter/pivot on.
    await sheetsApi(`${range('Sales!A:I')}:append`, {
      method: 'POST', query: { valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS' }, body: { values: rows },
    });
  }
  return { inserted: rows.length };
}
