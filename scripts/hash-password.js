// npm run hash-password
// Asks for your POS password (typed characters show as *) and prints PASSWORD_HASH and a fresh
// SESSION_SECRET to paste into Vercel's Environment Variables (and .env.local for local testing).

import crypto from 'node:crypto';
import { hashPassword } from '../lib/auth.js';

let pipedLines = null;

/** Read a line from the terminal without showing what is typed. */
function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    if (!stdin.isTTY) {
      // Input is piped in (not a terminal): read all lines once, hand them out one by one.
      pipedLines ||= new Promise((done) => {
        let buf = '';
        stdin.setEncoding('utf8');
        stdin.on('data', (d) => { buf += d; });
        stdin.on('end', () => done(buf.split(/\r?\n/)));
      });
      pipedLines.then((lines) => { process.stdout.write('\n'); resolve(lines.shift() || ''); });
      return;
    }
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {            // Enter: done
          stdin.removeListener('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') {                        // Ctrl+C: quit
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {         // Backspace
          if (value.length) { value = value.slice(0, -1); process.stdout.write('\b \b'); }
          continue;
        }
        if (ch >= ' ') { value += ch; process.stdout.write('*'); }
      }
    };
    stdin.on('data', onData);
  });
}

const pw = await askHidden('Choose a POS password (min 8 characters): ');
const again = await askHidden('Type it again: ');
if (pw !== again) { console.error('\nPasswords do not match. Run it again.'); process.exit(1); }
if (pw.length < 8) { console.error('\nUse at least 8 characters. Run it again.'); process.exit(1); }

console.log('\nAdd these two environment variables (copy everything after the = sign):\n');
console.log(`PASSWORD_HASH=${hashPassword(pw)}`);
console.log(`SESSION_SECRET=${crypto.randomBytes(32).toString('base64url')}\n`);
process.exit(0);
