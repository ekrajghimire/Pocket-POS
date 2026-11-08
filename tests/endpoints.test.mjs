import test from 'node:test';
import assert from 'node:assert/strict';
import { call, fresh, setEnv } from './helpers.mjs';
import { hashPassword, createSessionCookie } from '../lib/auth.js';

const HASH = hashPassword('open sesame');
const ENV = { PASSWORD_HASH: HASH, SESSION_SECRET: 'k'.repeat(40) };
const cookie = () => createSessionCookie({ headers: {} }).split(';')[0];

// login.js imports lib/auth.js, whose rate-limit memory is shared; use a fresh IP per test.
let ipN = 0;
const ip = () => ({ 'x-forwarded-for': `203.0.113.${++ipN}` });

test('login: correct password sets a secure 30-day cookie', async () => {
  setEnv(ENV);
  const { default: login } = await import('../api/login.js');
  const r = await call(login, { method: 'POST', headers: ip(), body: { password: 'open sesame' } });
  assert.equal(r.statusCode, 200);
  const c = r.headers['set-cookie'];
  assert.match(c, /^pos_session=\d+\.[\w-]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=2592000; Secure$/);
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('login: wrong/empty/odd passwords are 401 and set no cookie', async () => {
  setEnv(ENV);
  const { default: login } = await import('../api/login.js');
  for (const body of [{ password: 'nope' }, { password: '' }, {}, { password: 123 }, { password: ['open sesame'] },
    { password: 'x'.repeat(201) }, 'not json', null]) {
    const r = await call(login, { method: 'POST', headers: ip(), body: body === null ? 'null' : body });
    assert.equal(r.statusCode, 401, JSON.stringify(body));
    assert.equal(r.headers['set-cookie'], undefined);
    assert.equal(r.json.error, 'Wrong password');
  }
});

test('login: 6th attempt from one IP is 429 with Retry-After, even with the right password', async () => {
  setEnv(ENV);
  const { default: login } = await import('../api/login.js');
  const h = ip();
  for (let i = 0; i < 5; i++) assert.equal((await call(login, { method: 'POST', headers: h, body: { password: 'bad' } })).statusCode, 401);
  const r = await call(login, { method: 'POST', headers: h, body: { password: 'open sesame' } });
  assert.equal(r.statusCode, 429);
  assert.ok(Number(r.headers['retry-after']) > 0);
  assert.match(r.json.error, /Too many attempts/);
});

test('login: parallel guesses cannot slip past the limit', async () => {
  setEnv(ENV);
  const { default: login } = await fresh('../api/login.js');
  const h = ip();
  const results = await Promise.all(Array.from({ length: 20 }, () => call(login, { method: 'POST', headers: h, body: { password: 'guess' } })));
  const checked = results.filter((r) => r.statusCode === 401).length;
  assert.ok(checked <= 5, `${checked} passwords were checked`);
});

test('login: GET is 405; unset PASSWORD_HASH is a 500 without secrets', async () => {
  setEnv(ENV);
  const { default: login } = await import('../api/login.js');
  assert.equal((await call(login, { method: 'GET', headers: ip() })).statusCode, 405);
  setEnv({ SESSION_SECRET: 'x' });
  const o = console.error; console.error = () => {};
  const r = await call(login, { method: 'POST', headers: ip(), body: { password: 'a' } });
  console.error = o;
  assert.equal(r.statusCode, 500);
  assert.match(r.json.error, /PASSWORD_HASH is not set/);
});

test('session + logout endpoints', async () => {
  setEnv(ENV);
  const { default: session } = await import('../api/session.js');
  const { default: logout } = await import('../api/logout.js');
  assert.deepEqual((await call(session, { headers: { cookie: cookie() } })).json, { authenticated: true, demo: false });
  assert.deepEqual((await call(session, {})).json, { authenticated: false, demo: false });
  const r = await call(logout, { method: 'POST' });
  assert.match(r.headers['set-cookie'], /pos_session=; .*Max-Age=0/);
});

test('products endpoint requires a session', async () => {
  setEnv(ENV);
  const { default: products } = await import('../api/products.js');
  assert.equal((await call(products, {})).statusCode, 401);
});

// ---------- weather ----------
function fakeMeteo() {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => {
    const url = new URL(String(u)); calls.push(url);
    const j = (s, d) => new Response(JSON.stringify(d), { status: s });
    if (url.host === 'geocoding-api.open-meteo.com') {
      if (url.searchParams.get('name') === 'boom') return j(500, { error: true, reason: 'down' });
      return j(200, { results: [{ name: '<img src=x onerror=alert(1)>', admin1: 'NSW', postcodes: ['2170'], latitude: -33.9, longitude: 150.9 }] });
    }
    if (url.searchParams.get('latitude') === '1.000') return j(400, { error: true, reason: 'bad' });
    return j(200, { current: { temperature_2m: 24.4, apparent_temperature: 25.6, relative_humidity_2m: 40, weather_code: 3, is_day: 1 }, daily: { temperature_2m_max: [28.6], temperature_2m_min: [15.2] } });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('weather: needs a session', async () => {
  setEnv(ENV);
  const { default: w } = await fresh('../api/weather.js');
  assert.equal((await call(w, { url: '/api/weather?lat=-33&lon=151' })).statusCode, 401);
});

test('weather: current conditions, AU-only search, 10-minute cache', async () => {
  setEnv(ENV);
  const m = fakeMeteo();
  try {
    const { default: w } = await fresh('../api/weather.js');
    const r = await call(w, { url: '/api/weather?lat=-33.92&lon=150.92', headers: { cookie: cookie() } });
    assert.equal(r.statusCode, 200);
    assert.deepEqual({ ...r.json, at: 0 }, { temp: 24, feels: 26, humidity: 40, code: 3, isDay: true, description: 'Overcast', hi: 29, lo: 15, at: 0 });
    await call(w, { url: '/api/weather?lat=-33.921&lon=150.919', headers: { cookie: cookie() } });
    assert.equal(m.calls.length, 1, 'second call served from cache');

    const s = await call(w, { url: '/api/weather?q=Liverpool', headers: { cookie: cookie() } });
    assert.equal(s.json.places[0].state, 'NSW 2170');
    assert.equal(m.calls[1].searchParams.get('countryCode'), 'AU');
    assert.equal(m.calls[1].searchParams.get('name'), 'Liverpool');
  } finally { m.restore(); }
});

test('weather: input validation and upstream errors', async () => {
  setEnv(ENV);
  const m = fakeMeteo();
  try {
    const { default: w } = await fresh('../api/weather.js');
    const get = (q) => call(w, { url: '/api/weather' + q, headers: { cookie: cookie() } });
    for (const q of ['', '?lat=&lon=', '?lat=-33', '?lat=91&lon=0', '?lat=0&lon=181', '?lat=abc&lon=1', '?lat=Infinity&lon=1', '?q=a', '?q=' + 'x'.repeat(61)]) {
      assert.equal((await get(q)).statusCode, 400, q);
    }
    assert.equal(m.calls.length, 0, 'nothing sent upstream for bad input');
    const o = console.error; console.error = () => {};
    assert.equal((await get('?q=boom')).statusCode, 502);
    assert.equal((await get('?lat=1&lon=1')).statusCode, 502);
    console.error = o;
    assert.equal((await call(w, { method: 'POST', url: '/api/weather' })).statusCode, 405);
  } finally { m.restore(); }
});
