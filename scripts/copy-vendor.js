// npm run build  (Vercel runs this automatically on every deploy)
// Copies the ZXing decoder from node_modules into public/vendor so it is served from your own
// domain and cached for offline use. If it's missing, the app falls back to the jsDelivr CDN.

import fs from 'node:fs';
import path from 'node:path';

const src = path.join('node_modules', '@zxing', 'library', 'umd', 'index.min.js');
const dest = path.join('public', 'vendor', 'zxing.min.js');

if (fs.existsSync(src)) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`Copied ZXing -> ${dest}`);
} else {
  console.warn('ZXing not installed (run `npm install`). The app will load it from the CDN instead.');
}
