// Google Sheets client, against a fake Google API (global fetch is replaced).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fresh, setEnv, call } from './helpers.mjs';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const SA = JSON.stringify({ client_email: 'pos@test.iam.gserviceaccount.com', private_key: KEY_PEM });

/** A fake Sheets backend with Products + Sales tabs. `script` can inject failures. */
function fakeGoogle({ tabs = ['Products', 'Sales'], products = [], sales = [], failures = [] } = {}) {
  const state = { tabs: [...tabs], products: products.map((r) => [...r]), sales: sales.map((r) => [...r]), calls: [], headers: {}, tokenCalls: 0, formats: [] };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    state.calls.push({ method: init.method || 'GET', path: url.pathname, query: url.search, body });
    const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

    if (url.host === 'oauth2.googleapis.com') {
      state.tokenCalls++;
      const jwt = new URLSearchParams(String(init.body)).get('assertion');
      const [h, p, sig] = jwt.split('.');
      const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, 'base64url'));
      const claims = JSON.parse(Buffer.from(p, 'base64url'));
      state.claims = claims;
      return ok ? reply(200, { access_token: 'tok', expires_in: 3600 }) : reply(400, { error: 'invalid_grant' });
    }
    assert.equal(init.headers.Authorization, 'Bearer tok');
    const f = failures.shift();
    if (f) return reply(f, { error: { message: `fake ${f}` } });

    const path = decodeURIComponent(url.pathname.replace(/^\/v4\/spreadsheets\/[^/:]+/, ''));
    if (path === '' ) return reply(200, { sheets: state.tabs.map((title, i) => ({ properties: { title, sheetId: i } })) });
    if (path === ':batchUpdate') {
      const replies = body.requests.map((r) => { if (r.addSheet) { state.tabs.push(r.addSheet.properties.title); return { addSheet: { properties: { title: r.addSheet.properties.title, sheetId: state.tabs.length - 1 } } }; } state.formats.push(r); return {}; });
      return reply(200, { replies });
    }
    if (path === '/values:batchGet') {
      const ranges = url.searchParams.getAll('ranges');
      return reply(200, { valueRanges: ranges.map((r) => ({ values: state.headers[r.split('!')[0]] ? [state.headers[r.split('!')[0]]] : [] })) });
    }
    if (path === '/values:batchUpdate') {
      for (const d of body.data) {
        const [tab, cell] = d.range.split('!');
        if (cell === 'A1') { state.headers[tab] = d.values[0]; continue; }
        const m = cell.match(/^([A-Z])(\d+)/); const row = Number(m[2]) - 2; const col = m[1].charCodeAt(0) - 65;
        d.values[0].forEach((v, i) => { state.products[row][col + i] = v; });
      }
      state.lastInput = body.valueInputOption;
      return reply(200, {});
    }
    if (path === '/values/Products!A2:F' || path === '/values/Products!A2:A') return reply(200, { values: state.products.map((r) => (path.endsWith(':A') ? [r[0]] : r.slice(0, 6))) });
    if (path === '/values/Sales!A2:A') return reply(200, { values: state.sales.map((r) => [r[0]]) });
    if (path.endsWith(':append')) {
      const tab = path.split('/values/')[1].split('!')[0];
      state[tab === 'Products' ? 'products' : 'sales'].push(...body.values);
      state.lastAppendInput = url.searchParams.get('valueInputOption');
      return reply(200, {});
    }
    return reply(404, { error: { message: 'unknown ' + path } });
  };
  state.restore = () => { globalThis.fetch = realFetch; };
  return state;
}

const ENV = { SHEET_ID: 'sheet123', GOOGLE_SERVICE_ACCOUNT_JSON: SA };

test('first run creates missing tabs, headers, bold/frozen rows and TEXT barcode column', async () => {
  setEnv(ENV);
  const g = fakeGoogle({ tabs: ['Sheet1'] });
  try {
    const s = await fresh('../lib/sheets.js');
    assert.deepEqual(await s.readProducts(), []);
    assert.deepEqual(g.tabs, ['Sheet1', 'Products', 'Sales']);
    assert.deepEqual(g.headers.Products, s.PRODUCT_COLUMNS);
    assert.deepEqual(g.headers.Sales, s.SALES_COLUMNS);
    assert.ok(g.formats.some((r) => r.repeatCell?.cell.userEnteredFormat.numberFormat?.type === 'TEXT'));
    assert.ok(g.formats.some((r) => r.updateSheetProperties));
    assert.equal(g.claims.scope, 'https://www.googleapis.com/auth/spreadsheets');
    assert.equal(g.claims.iss, 'pos@test.iam.gserviceaccount.com');
    // second call: no setup again, token reused
    const before = g.calls.length;
    await s.readProducts();
    assert.equal(g.calls.length - before, 1);
    assert.equal(g.tokenCalls, 1);
  } finally { g.restore(); }
});

test('readProducts parses rows, keeps leading zeros, skips blanks', async () => {
  setEnv(ENV);
  const g = fakeGoogle({ products: [['0012', 'A', 1.5, '', 'Cat', 3], ['', 'blank'], [930001, 'Num', '2', 1, '', ''], ['  77 ', 'Trim', 'x']] });
  g.headers.Products = ['h']; g.headers.Sales = ['h'];
  try {
    const s = await fresh('../lib/sheets.js');
    const p = await s.readProducts();
    assert.equal(p.length, 3);
    assert.deepEqual(p[0], { barcode: '0012', name: 'A', price: 1.5, cost: null, category: 'Cat', stock: 3 });
    assert.equal(p[1].barcode, '930001'); assert.equal(p[1].price, 2);
    assert.equal(p[2].barcode, '77'); assert.equal(p[2].price, 0, 'bad price -> 0');
  } finally { g.restore(); }
});

test('upsert updates existing rows and appends new ones, RAW, deduped', async () => {
  setEnv(ENV);
  const g = fakeGoogle({ products: [['0012', 'Old', 1, '', '', '', 'c', 'u']] });
  g.headers.Products = ['h']; g.headers.Sales = ['h'];
  try {
    const s = await fresh('../lib/sheets.js');
    const r = await s.upsertProducts([
      { barcode: '0012', name: 'New name', price: 2, cost: null, category: '', stock: null },
      { barcode: '555', name: '=HYPERLINK("x")', price: 3, cost: 1, category: 'C', stock: 4 },
      { barcode: '555', name: 'Last wins', price: 3.5, cost: 1, category: 'C', stock: 4 },
    ]);
    assert.deepEqual(r, { inserted: 1, updated: 1 });
    assert.equal(g.products[0][1], 'New name'); assert.equal(g.products[0][2], 2);
    assert.equal(g.products[1][0], '555'); assert.equal(g.products[1][1], 'Last wins');
    assert.equal(g.lastInput, 'RAW'); assert.equal(g.lastAppendInput, 'RAW', 'product text is never evaluated as a formula');
  } finally { g.restore(); }
});

test('appendSales skips sale_ids already in the sheet (safe retries)', async () => {
  setEnv(ENV);
  const g = fakeGoogle({ sales: [['S1']] });
  g.headers.Products = ['h']; g.headers.Sales = ['h'];
  try {
    const s = await fresh('../lib/sheets.js');
    const mk = (id) => ({ sale_id: id, date_time: '2026-11-08 10:00:00', items: [{ name: '=1+1', qty: 1, price: 1, line_total: 1 }], subtotal: 1, gst: 0, total: 1, payment_type: 'Card', cash_received: null, change: null });
    assert.deepEqual(await s.appendSales([mk('S1'), mk('S2')]), { inserted: 1 });
    assert.equal(g.sales.length, 2);
    assert.equal(g.sales[1][0], 'S2');
    assert.ok(g.sales[1][2].startsWith('['), 'items JSON starts with [ so it is never a formula');
    assert.deepEqual(await s.appendSales([]), { inserted: 0 });
  } finally { g.restore(); }
});

test('retries 429 and 5xx, then succeeds', async () => {
  setEnv(ENV);
  const g = fakeGoogle({ failures: [429, 503] });
  g.headers.Products = ['h']; g.headers.Sales = ['h'];
  try {
    const s = await fresh('../lib/sheets.js');
    assert.deepEqual(await s.readProducts(), []);
  } finally { g.restore(); }
});

test('403 is not retried and explains sharing', async () => {
  setEnv(ENV);
  const g = fakeGoogle({ failures: [403] });
  try {
    const s = await fresh('../lib/sheets.js');
    await assert.rejects(s.readProducts(), /403: fake 403 — is the sheet shared with the service account email/);
    assert.equal(g.calls.filter((c) => !c.path.includes('token')).length, 1);
    // setup is retried on the next call after a failure
    await s.readProducts();
  } finally { g.restore(); }
});

test('not configured: clear error in production, never demo mode on Vercel', async () => {
  setEnv({ VERCEL: '1', POS_DEV: '1' });
  const s = await fresh('../lib/sheets.js');
  await assert.rejects(s.readProducts(), /not configured/);
  setEnv({ SHEET_ID: 'x', GOOGLE_SERVICE_ACCOUNT_JSON: '{not json' });
  const s2 = await fresh('../lib/sheets.js');
  await assert.rejects(s2.readProducts(), (e) => /not valid JSON/.test(e.message) && !e.message.includes('not json'));
});

test('bad key: Google auth error, no key material in the message', async () => {
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  setEnv({ SHEET_ID: 'x', GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'a@b', private_key: other }) });
  const g = fakeGoogle();
  try {
    const s = await fresh('../lib/sheets.js');
    await assert.rejects(s.readProducts(), (e) => /Google auth failed: invalid_grant/.test(e.message) && !e.message.includes('PRIVATE'));
  } finally { g.restore(); }
});

test('/api/sync end to end: valid saved, invalid reported in rejected', async () => {
  const auth = await import('../lib/auth.js');
  const HASH = auth.hashPassword('pw');
  setEnv({ ...ENV, PASSWORD_HASH: HASH, SESSION_SECRET: 'x'.repeat(32) });
  const g = fakeGoogle();
  g.headers.Products = ['h']; g.headers.Sales = ['h'];
  try {
    const { default: sync } = await fresh('../api/sync.js');
    const cookie = auth.createSessionCookie({ headers: {} }).split(';')[0];
    const good = { sale_id: 'S20261108-100000-ABC123', date_time: '2026-11-08 10:00:00', items: [{ barcode: '1', name: 'A', qty: 1, price: 2, line_total: 2 }], subtotal: 2, gst: 0, total: 2, payment_type: 'Card', cash_received: null, change: null };
    const orig = console.warn; console.warn = () => {};
    const r = await call(sync, { method: 'POST', headers: { cookie, origin: 'https://pos.test' }, body: {
      products: [{ barcode: '1', name: 'A', price: 2 }, { barcode: 'bad code', name: 'B', price: 1 }],
      sales: [good, { ...good, sale_id: '=EVIL()' }],
    } });
    console.warn = orig;
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json.products, { inserted: 1, updated: 0 });
    assert.deepEqual(r.json.sales, { inserted: 1 });
    assert.deepEqual(r.json.rejected.map((x) => [x.kind, x.reason, x.id]), [['product', 'bad barcode', 'bad code'], ['sale', 'bad sale_id', '=EVIL()']]);

    assert.equal((await call(sync, { method: 'POST', headers: { origin: 'https://pos.test' }, body: {} })).statusCode, 401);
    assert.equal((await call(sync, { method: 'POST', headers: { cookie, origin: 'https://evil.test' }, body: {} })).statusCode, 403);
    assert.equal((await call(sync, { method: 'POST', headers: { cookie }, body: [] })).statusCode, 400);
    assert.equal((await call(sync, { method: 'POST', headers: { cookie }, body: { sales: Array(501).fill(good) } })).statusCode, 400);
    assert.equal((await call(sync, { method: 'GET', headers: { cookie } })).statusCode, 405);
  } finally { g.restore(); }
});
