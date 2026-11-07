// POST /api/login  { password }  ->  sets the 30-day session cookie
import { route, readJson, sendJson, clientIp } from '../lib/http.js';
import { verifyPassword, createSessionCookie, loginBlocked, recordLoginFailure, clearLoginFailures } from '../lib/auth.js';

export default route('POST', async (req, res) => {
  const ip = clientIp(req);
  const wait = loginBlocked(ip);
  if (wait) {
    return sendJson(res, 429, { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` }, { 'Retry-After': String(wait) });
  }

  const body = await readJson(req).catch(() => ({}));
  const password = typeof body.password === 'string' ? body.password : '';
  const ok = password.length > 0 && password.length <= 200 && verifyPassword(password);

  if (!ok) {
    recordLoginFailure(ip);
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing
    return sendJson(res, 401, { error: 'Wrong password' });
  }
  clearLoginFailures(ip);
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': createSessionCookie(req) });
});
