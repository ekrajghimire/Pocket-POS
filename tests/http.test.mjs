import test from 'node:test';
import assert from 'node:assert/strict';
import { call, fakeReq } from './helpers.mjs';
import { readJson, route, clientIp } from '../lib/http.js';

const echo = route('POST', async (req, res) => { const b = await readJson(req); res.statusCode = 200; res.end(JSON.stringify(b)); });
const quiet = async (fn) => { const o = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = o; } };

test('valid JSON, empty body, pre-parsed body', async () => {
  assert.equal((await call(echo, { method: 'POST', body: { a: 1 } })).body, '{"a":1}');
  assert.equal((await call(echo, { method: 'POST' })).body, '{}');
  const req = fakeReq({ method: 'POST' }); req.body = { b: 2 };
  assert.deepEqual(await readJson(req), { b: 2 });
  const req2 = fakeReq({ method: 'POST' }); req2.body = '{"c":3}';
  assert.deepEqual(await readJson(req2), { c: 3 });
});

test('invalid JSON is 400, not 500', async () => {
  for (const bad of ['{', 'nope', '{"a":}', '\u0000']) {
    const r = await quiet(() => call(echo, { method: 'POST', body: bad }));
    assert.equal(r.statusCode, 400, bad); assert.match(r.json.error, /not valid JSON/);
  }
});

test('body over 1 MB is 413', async () => {
  const r = await quiet(() => call(echo, { method: 'POST', body: 'x'.repeat(1_000_001) }));
  assert.equal(r.statusCode, 413);
});

test('wrong method is 405 with Allow', async () => {
  for (const m of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
    const r = await call(echo, { method: m });
    assert.equal(r.statusCode, 405); assert.equal(r.headers.allow, 'POST');
  }
});

test('JSON responses are never cached', async () => {
  const r = await call(echo, { method: 'POST', body: {} });
  // echo writes its own body; check sendJson via a 405
  const r2 = await call(echo, { method: 'GET' });
  assert.equal(r2.headers['cache-control'], 'no-store');
  assert.match(r2.headers['content-type'], /application\/json/);
  assert.ok(r);
});

test('clientIp uses the first forwarded address', () => {
  assert.equal(clientIp(fakeReq({ headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.9' } })), '1.2.3.4');
  assert.equal(clientIp(fakeReq({ headers: { 'x-real-ip': '5.6.7.8' } })), '5.6.7.8');
  assert.equal(clientIp(fakeReq()), '10.0.0.1');
});
