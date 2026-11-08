// Tiny fakes for Node's req/res so API handlers can be tested without a server.
import { Readable } from 'node:stream';

export function fakeReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const req = Readable.from(chunks);
  req.method = method;
  req.url = url;
  req.headers = { host: 'pos.test', ...headers };
  req.socket = { remoteAddress: '10.0.0.1' };
  return req;
}

export function fakeRes() {
  const res = {
    statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    end(b = '') { this.body = String(b); this.done = true; },
  };
  Object.defineProperty(res, 'json', { get() { try { return JSON.parse(this.body); } catch { return null; } } });
  return res;
}

export async function call(handler, reqOpts) {
  const res = fakeRes();
  await handler(fakeReq(reqOpts), res);
  return res;
}

/** Fresh copy of a module (module-level state such as caches and rate limits starts empty). */
let n = 0;
export const fresh = (rel) => import(new URL(rel, import.meta.url).href + `?v=${++n}`);

export function setEnv(vars) {
  for (const k of ['PASSWORD_HASH', 'SESSION_SECRET', 'POS_DEV', 'VERCEL', 'SHEET_ID', 'GOOGLE_SERVICE_ACCOUNT_JSON',
    'GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY']) delete process.env[k];
  Object.assign(process.env, vars);
}
