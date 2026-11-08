import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeReq, fakeRes, fresh, setEnv } from './helpers.mjs';

const auth = await fresh('../lib/auth.js');
const HASH = auth.hashPassword('correct horse battery');
const BASE = { PASSWORD_HASH: HASH, SESSION_SECRET: 's3cret-for-tests-0123456789' };

const cookieOf = (setCookie) => setCookie.split(';')[0];          // "pos_session=..."
const withCookie = (c, extra = {}) => fakeReq({ headers: { cookie: c, ...extra } });

test('hash format is scrypt:salt:hash and salts differ', () => {
  const a = auth.hashPassword('x'); const b = auth.hashPassword('x');
  assert.match(a, /^scrypt:[\w-]{22}:[\w-]{43}$/);
  assert.notEqual(a, b);
});

test('verifyPassword: right, wrong, empty, unicode, long', () => {
  setEnv(BASE);
  assert.equal(auth.verifyPassword('correct horse battery'), true);
  assert.equal(auth.verifyPassword('correct horse batterY'), false);
  assert.equal(auth.verifyPassword(''), false);
  assert.equal(auth.verifyPassword('x'.repeat(5000)), false);
  setEnv({ ...BASE, PASSWORD_HASH: auth.hashPassword('пароль 🔑') });
  assert.equal(auth.verifyPassword('пароль 🔑'), true);
});

test('envSecret forgives NAME=, quotes and wrapped whitespace', () => {
  setEnv({ PASSWORD_HASH: `PASSWORD_HASH="${HASH.slice(0, 20)}\n  ${HASH.slice(20)}"` });
  assert.equal(auth.envSecret('PASSWORD_HASH'), HASH);
});

test('malformed hash: generic error, hash never in the message', () => {
  for (const bad of ['abc', 'scrypt:only', 'bcrypt:a:b', 'scrypt:a:b:c']) {
    setEnv({ ...BASE, PASSWORD_HASH: bad });
    const orig = console.error; console.error = () => {};
    try {
      assert.throws(() => auth.verifyPassword('x'), (e) => !e.message.includes(bad) && /right format/.test(e.message));
    } finally { console.error = orig; }
  }
});

test('missing PASSWORD_HASH throws in production, demo only with POS_DEV and not on Vercel', () => {
  setEnv({});
  assert.throws(() => auth.verifyPassword('demo'), /not set/);
  setEnv({ POS_DEV: '1' });
  assert.equal(auth.verifyPassword('demo'), true);
  setEnv({ POS_DEV: '1', VERCEL: '1' });
  assert.equal(auth.isDemo(), false);
  assert.throws(() => auth.verifyPassword('demo'), /not set/);
});

test('session cookie flags: HttpOnly, Secure, SameSite=Strict, 30 days', () => {
  setEnv(BASE);
  const c = auth.createSessionCookie(fakeReq());
  for (const f of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', `Max-Age=${30 * 86400}`]) assert.ok(c.includes(f), f);
  setEnv({ ...BASE, POS_DEV: '1' });
  assert.ok(!auth.createSessionCookie(fakeReq()).includes('Secure'), 'plain http dev only');
  assert.ok(auth.createSessionCookie(fakeReq({ headers: { 'x-forwarded-proto': 'https' } })).includes('Secure'));
  const cleared = auth.clearSessionCookie(fakeReq());
  assert.match(cleared, /pos_session=;/); assert.match(cleared, /Max-Age=0/);
});

test('session: valid, tampered, expired, forged, wrong secret, garbage', () => {
  setEnv(BASE);
  const good = cookieOf(auth.createSessionCookie(fakeReq()));
  assert.equal(auth.hasValidSession(withCookie(good)), true);
  assert.equal(auth.hasValidSession(withCookie(`other=1; ${good}; x=y`)), true);

  const [, val] = good.split('=');
  const [exp, sig] = val.split('.');
  assert.equal(auth.hasValidSession(withCookie(`pos_session=${Number(exp) + 1}.${sig}`)), false, 'changed expiry');
  assert.equal(auth.hasValidSession(withCookie(`pos_session=${exp}.${sig.slice(0, -1)}A`)), false, 'changed sig');
  assert.equal(auth.hasValidSession(withCookie(`pos_session=${exp}.${sig}.extra`)), false);
  assert.equal(auth.hasValidSession(withCookie('pos_session=9999999999.')), false);
  assert.equal(auth.hasValidSession(withCookie('pos_session=abc.def')), false);
  assert.equal(auth.hasValidSession(withCookie('pos_session=')), false);
  assert.equal(auth.hasValidSession(fakeReq()), false);

  // Expired, even with a correct signature
  const crypto = await_crypto();
  const past = String(Math.floor(Date.now() / 1000) - 10);
  const key = BASE.SESSION_SECRET + '|' + HASH;
  const pastSig = crypto.createHmac('sha256', key).update(past).digest('base64url');
  assert.equal(auth.hasValidSession(withCookie(`pos_session=${past}.${pastSig}`)), false, 'expired');

  // Rotating SESSION_SECRET or PASSWORD_HASH logs everyone out
  setEnv({ ...BASE, SESSION_SECRET: 'different' });
  assert.equal(auth.hasValidSession(withCookie(good)), false);
  setEnv({ ...BASE, PASSWORD_HASH: auth.hashPassword('new') });
  assert.equal(auth.hasValidSession(withCookie(good)), false);
});
import nodeCrypto from 'node:crypto';
function await_crypto() { return nodeCrypto; }

test('no SESSION_SECRET in production throws (no silent default)', () => {
  setEnv({ PASSWORD_HASH: HASH });
  assert.throws(() => auth.createSessionCookie(fakeReq()), /SESSION_SECRET/);
});

test('requireSession: CSRF origin check and 401', () => {
  setEnv(BASE);
  const good = cookieOf(auth.createSessionCookie(fakeReq()));
  const run = (headers, method = 'POST') => {
    const res = fakeRes();
    const ok = auth.requireSession(fakeReq({ method, headers: { cookie: good, ...headers } }), res);
    return { ok, status: res.statusCode };
  };
  assert.deepEqual(run({ origin: 'https://pos.test' }), { ok: true, status: 200 });
  assert.deepEqual(run({}), { ok: true, status: 200 }, 'no Origin (same-origin fetch in some browsers)');
  assert.equal(run({ origin: 'https://evil.test' }).status, 403);
  assert.equal(run({ origin: 'https://pos.test.evil.test' }).status, 403);
  assert.equal(run({ origin: 'null' }).status, 403);
  assert.equal(run({ origin: 'http://pos.test:8080' }).status, 403);
  assert.equal(run({ origin: 'https://evil.test' }, 'GET').status, 200, 'GET is read-only');
  assert.equal(run({ origin: 'https://real.app', 'x-forwarded-host': 'real.app', host: 'internal' }).status, 200);
  const res = fakeRes();
  assert.equal(auth.requireSession(fakeReq({ method: 'POST', headers: { origin: 'https://pos.test' } }), res), false);
  assert.equal(res.statusCode, 401);
});

test('rate limit: 5 per IP, separate IPs, global 30, window expiry, success clears', async (t) => {
  const a = await fresh('../lib/auth.js');
  for (let i = 0; i < 5; i++) { assert.equal(a.loginBlocked('1.1.1.1'), 0); a.recordLoginFailure('1.1.1.1'); }
  const wait = a.loginBlocked('1.1.1.1');
  assert.ok(wait > 890 && wait <= 900, `wait ${wait}`);
  assert.equal(a.loginBlocked('2.2.2.2'), 0, 'other IP unaffected');
  a.clearLoginFailures('1.1.1.1');
  assert.equal(a.loginBlocked('1.1.1.1'), 0);

  const g = await fresh('../lib/auth.js');
  for (let i = 0; i < 30; i++) g.recordLoginFailure(`9.9.9.${i}`);
  assert.ok(g.loginBlocked('8.8.8.8') > 0, 'global limit stops IP rotation');

  const w = await fresh('../lib/auth.js');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  for (let i = 0; i < 5; i++) w.recordLoginFailure('3.3.3.3');
  assert.ok(w.loginBlocked('3.3.3.3') > 0);
  t.mock.timers.tick(15 * 60 * 1000 + 1);
  assert.equal(w.loginBlocked('3.3.3.3'), 0, 'window expired');
});
