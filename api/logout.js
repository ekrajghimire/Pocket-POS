// POST /api/logout  ->  clears the session cookie
import { route, sendJson } from '../lib/http.js';
import { clearSessionCookie } from '../lib/auth.js';

export default route('POST', async (req, res) => {
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie(req) });
});
