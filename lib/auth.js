// lib/auth.js — single-password login, signed session cookies and login rate limiting.
// Uses only Node's built-in crypto module (no dependencies).
//
// Env vars:
//   PASSWORD_HASH   created by `npm run hash-password`  (format  scrypt:<salt>:<hash>)
//   SESSION_SECRET  long random string; signs the session cookie
//
// Sessions are stateless: the cookie holds an expiry time plus an HMAC signature.
// Changing PASSWORD_HASH or SESSION_SECRET logs out every device.

import crypto from 'node:crypto';
import { sendJson } from './http.js';

const COOKIE = 'pos_session';
const MAX_AGE = 30 * 24 * 60 * 60; // 30 days, in seconds
const SCRYPT = { N: 16384, r: 8, p: 1 };

/**
 * Read a secret env var and forgive common copy/paste slips: a leading "NAME=",
 * surrounding quotes, and spaces/line breaks picked up from a wrapped Terminal line.
 */
export function envSecret(name) {
  let v = String(process.env[name] || '').trim();
  if (v.startsWith(name + '=')) v = v.slice(name.length + 1);
  v = v.replace(/^['"]|['"]$/g, '');
  return v.replace(/\s+/g, '');
}

/** Demo mode: running locally (npm run dev) with no PASSWORD_HASH configured. Password is "demo". */
export const isDemo = () => !envSecret('PASSWORD_HASH') && process.env.POS_DEV === '1' && !process.env.VERCEL;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, SCRYPT);
  return `scrypt:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

export function verifyPassword(password) {
  const stored = envSecret('PASSWORD_HASH');
  if (!stored) {
    if (isDemo()) return password === 'demo';
    throw new Error('PASSWORD_HASH is not set');
  }
  const [alg, salt, hash, extra] = stored.split(':');
  if (alg !== 'scrypt' || !salt || !hash || extra !== undefined) {
    // Details go to the server log only (Vercel > Logs), never to the browser.
    console.error(`PASSWORD_HASH is malformed: ${stored.length} chars, ${stored.split(':').length} parts, starts with "${alg}"`);
    throw new Error('PASSWORD_HASH is not in the right format. Re-run npm run hash-password and paste only the part after the = sign (see Vercel logs).');
  }
  const expected = Buffer.from(hash, 'base64url');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected);
}

// ---------- Session cookie ----------

function signingKey() {
  const secret = envSecret('SESSION_SECRET') || (isDemo() ? 'demo-only-secret' : '');
  if (!secret) throw new Error('SESSION_SECRET is not set');
  return secret + '|' + envSecret('PASSWORD_HASH');
}
const sign = (value) => crypto.createHmac('sha256', signingKey()).update(value).digest('base64url');

function cookieString(value, maxAge, req) {
  const parts = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
  // Always Secure in production. Only plain http://localhost during `npm run dev` skips it.
  const httpsReq = req.headers['x-forwarded-proto'] === 'https' || (req.socket && req.socket.encrypted);
  if (process.env.POS_DEV !== '1' || httpsReq) parts.push('Secure');
  return parts.join('; ');
}

export function createSessionCookie(req) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  return cookieString(`${exp}.${sign(String(exp))}`, MAX_AGE, req);
}

export function clearSessionCookie(req) {
  return cookieString('', 0, req);
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function hasValidSession(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return false;
  const [exp, sig, extra] = token.split('.');
  if (!/^\d{1,12}$/.test(exp || '') || !sig || extra !== undefined || Number(exp) < Date.now() / 1000) return false;
  const expected = Buffer.from(sign(exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/**
 * Guard for API routes. Returns true if the request may continue; otherwise sends 401/403.
 * Also blocks cross-site POSTs (CSRF) by checking the Origin header.
 */
export function requireSession(req, res) {
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin) {
      let host = null;
      try { host = new URL(origin).host; } catch { /* bad header */ }
      const ourHost = req.headers['x-forwarded-host'] || req.headers.host;
      if (host !== ourHost) { sendJson(res, 403, { error: 'Bad origin' }); return false; }
    }
  }
  if (!hasValidSession(req)) { sendJson(res, 401, { error: 'Not logged in' }); return false; }
  return true;
}

// ---------- Login rate limiting ----------
// 5 failed attempts per IP per 15 minutes, and 30 failures in total per 15 minutes.
// Note: serverless instances don't share memory, so this is per instance. It still makes
// guessing a strong password impractical. For more, enable Vercel's Firewall rate limiting.

const WINDOW_MS = 15 * 60 * 1000;
const PER_IP = 5;
const GLOBAL = 30;
const failures = new Map(); // ip -> {count, first}
let globalFail = { count: 0, first: 0 };

export function loginBlocked(ip) {
  const now = Date.now();
  if (now - globalFail.first > WINDOW_MS) globalFail = { count: 0, first: now };
  const f = failures.get(ip);
  if (f && now - f.first > WINDOW_MS) failures.delete(ip);
  const cur = failures.get(ip);
  if ((cur && cur.count >= PER_IP) || globalFail.count >= GLOBAL) {
    const first = cur && cur.count >= PER_IP ? cur.first : globalFail.first;
    return Math.ceil((first + WINDOW_MS - now) / 1000); // seconds to wait
  }
  return 0;
}

export function recordLoginFailure(ip) {
  const now = Date.now();
  const f = failures.get(ip) || { count: 0, first: now };
  f.count += 1;
  failures.set(ip, f);
  if (now - globalFail.first > WINDOW_MS) globalFail = { count: 0, first: now };
  globalFail.count += 1;
  if (failures.size > 5000) failures.clear(); // keep memory bounded
}

/** After a correct password: forget this IP's failures (and give back the attempt we counted). */
export function clearLoginFailures(ip) {
  failures.delete(ip);
  globalFail.count = Math.max(0, globalFail.count - 1);
}
