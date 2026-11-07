// GET /api/session  ->  { authenticated, demo }   (lets the app decide: login screen or scanner)
import { route, sendJson } from '../lib/http.js';
import { hasValidSession, isDemo } from '../lib/auth.js';

export default route('GET', async (req, res) => {
  sendJson(res, 200, { authenticated: hasValidSession(req), demo: isDemo() });
});
