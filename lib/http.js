// lib/http.js — small helpers shared by the API routes. Works on Vercel and in dev-server.js.

/** Read a JSON request body (max 1 MB). */
export async function readJson(req) {
  // Vercel may have parsed the body already.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') return req.body ? JSON.parse(req.body) : {};
    if (Buffer.isBuffer(req.body)) return req.body.length ? JSON.parse(req.body.toString('utf8')) : {};
    return req.body;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/** Send a JSON response that is never cached. */
export function sendJson(res, status, data, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(data));
}

/** Best guess at the caller's IP (Vercel puts it first in x-forwarded-for). */
export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.headers['x-real-ip'] || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** Wrap a handler: enforce the HTTP method and turn thrown errors into JSON responses. */
export function route(method, handler) {
  return async (req, res) => {
    if (req.method !== method) return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: method });
    try {
      await handler(req, res);
    } catch (err) {
      console.error(err);
      const status = err.status || 500;
      sendJson(res, status, { error: status === 500 ? 'Server error: ' + err.message : err.message });
    }
  };
}
