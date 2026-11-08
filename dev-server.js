// dev-server.js — run the whole app locally with zero dependencies:  npm run dev
// Serves /public and routes /api/<name> to api/<name>.js exactly like Vercel does.
// Reads secrets from .env.local (or .env). With no Google settings it runs in DEMO MODE.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;

// --- minimal .env loader (KEY=value per line, optional quotes; values may span lines in "quotes") ---
for (const name of ['.env.local', '.env']) {
  const file = path.join(ROOT, name);
  if (!fs.existsSync(file)) continue;
  const text = fs.readFileSync(file, 'utf8');
  // [ \t]* (not \s*) so an empty value like "PASSWORD_HASH=" never swallows the next line.
  const re = /^[ \t]*([A-Z0-9_]+)[ \t]*=[ \t]*("(?:[^"\\]|\\.)*"|'[^']*'|.*?)[ \t]*$/gm;
  let m;
  while ((m = re.exec(text))) {
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(m[1] in process.env) && v !== '') process.env[m[1]] = v;
  }
  console.log(`Loaded ${name}`);
}
process.env.POS_DEV = '1';

// Apply the same security headers as production (from vercel.json).
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const globalHeaders = (vercel.headers || []).find((h) => h.source === '/(.*)')?.headers || [];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain',
};

const server = http.createServer(async (req, res) => {
  try { await handle(req, res); }
  catch (err) {
    console.error(err);
    if (!res.headersSent) { res.statusCode = 400; res.end('Bad request'); }
  }
});

async function handle(req, res) {
  for (const h of globalHeaders) res.setHeader(h.key, h.value);
  const url = new URL(req.url, 'http://localhost');

  // --- API routes ---
  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.slice(5).replace(/\/$/, '');
    const file = path.join(ROOT, 'api', `${name}.js`);
    if (!/^[a-z-]+$/.test(name) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('{"error":"Not found"}'); }
    try {
      const mod = await import(pathToFileURL(file).href);
      req.query = Object.fromEntries(url.searchParams);
      await mod.default(req, res);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) { res.statusCode = 500; res.end(JSON.stringify({ error: err.message })); }
    }
    return;
  }

  // --- static files ---
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.statusCode = 400; return res.end('Bad request'); }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(PUBLIC, path.normalize(rel));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) { res.statusCode = 403; return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(data);
  });
}

server.listen(PORT, () => {
  const sheets = process.env.SHEET_ID && (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_PRIVATE_KEY);
  const demo = !sheets ? '  (DEMO MODE: Google Sheets not configured — data goes to .data/demo-db.json)' : '';
  const pw = !process.env.PASSWORD_HASH ? '\n  No PASSWORD_HASH set — log in with the password "demo".' : '';
  console.log(`\n  Pocket POS running at http://localhost:${PORT}${demo}${pw}\n`);
});
