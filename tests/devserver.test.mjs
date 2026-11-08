// The local dev server must never serve files outside public/ (or .env!).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';

const port = 40000 + Math.floor(Math.random() * 20000);
let child;
test.before(async () => {
  child = spawn(process.execPath, ['dev-server.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port) }, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${port}/`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});
test.after(() => child.kill());

// Raw HTTP so paths like /../ are sent exactly as written (fetch would normalise them).
function raw(path) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
    let data = '';
    s.on('data', (d) => { data += d; }); s.on('end', () => resolve({ status: Number(data.split(' ')[1]), body: data })); s.on('error', reject);
  });
}

test('serves the app', async () => {
  assert.equal((await raw('/')).status, 200);
  assert.equal((await raw('/js/app.js')).status, 200);
});

test('path traversal and odd paths are refused', async () => {
  for (const p of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/%2e%2e/etc/passwd', '/../.env', '/..%5c..%5cpackage.json',
    '/%2e%2e%2f.data/demo-db.json', '/public/../lib/auth.js', '//etc/passwd']) {
    const r = await raw(p);
    assert.ok(![200].includes(r.status) || !/PASSWORD|"name": "pocket-pos"|root:|import crypto/.test(r.body), `${p} -> ${r.status}`);
    assert.ok(!/"name": "pocket-pos"|root:x|import crypto|PASSWORD_HASH=/.test(r.body), p);
  }
});

test('malformed URL encoding is a 400, and the server keeps running', async () => {
  assert.equal((await raw('/%E0%A4%A')).status, 400);
  assert.equal((await raw('/')).status, 200);
});
