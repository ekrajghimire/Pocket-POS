# Pocket POS

**Developed by Manish Ghimire**

A phone-first point-of-sale web app (installable PWA) built around fast, continuous barcode
scanning, with Google Sheets as the database. Plain JavaScript with no frontend framework and
no build step for the app code. It deploys to Vercel.

**Setup:** see [SETUP.md](SETUP.md). **Try it now:** `npm install && npm run dev`, open
http://localhost:3000 and log in with password `demo` (demo mode, no Google needed).

## What it does

- Opens straight into a live rear camera (1280×720, continuous autofocus) that scans non-stop.
- **Known barcode:** beep, vibrate, green flash with name and price, and +1 in the cart in under a frame.
- **Unknown barcode:** scanning pauses and a sheet slides up with the barcode filled in, the cursor in
  Name and the decimal keypad for Price. **Save & Add to Cart** saves it, adds it and goes back to scanning.
- Cart: −/+ quantity, tap a line to set qty or price for this sale or remove it, manual items without
  barcodes, and a two-tap Clear.
- Checkout: Cash / Card / Other. For cash, quick-tender buttons, change due, and Australian 5c cash rounding.
- AUD with an optional 10% GST display (prices GST-inclusive by default, switchable to GST-exclusive).
- Offline-tolerant: products are cached on the phone, and sales and new products queue on the phone and
  sync in batches with retries. A badge shows Synced / pending / Offline.
- Single-password login, 30-day httpOnly + Secure + SameSite=Strict cookie, login rate limiting,
  CSRF origin check, and a strict Content-Security-Policy.

## Why scanning is fast

| Technique | Where |
|---|---|
| Native `BarcodeDetector` when available (Android Chrome, macOS Chrome) | `public/js/scanner.js` → `initDecoder()` |
| ZXing fallback runs in a **Web Worker**, so the UI never janks (iPhone) | `public/js/zxing-worker.js` |
| Only 7 formats: EAN-13/8, UPC-A/E, Code 128, Code 39, QR | both decoders |
| Decodes only the on-screen box (region of interest), mapped through `object-fit: cover` | `computeCrop()` |
| One decode per new camera frame (`requestVideoFrameCallback`, ~30 fps) | `tick()` |
| Camera opened once per session and never restarted between scans | `openCamera()` |
| Product lookup is an in-memory `Map` (loaded from IndexedDB), with no network on scan | `public/js/store.js` → `lookup()` |
| Writes go through an IndexedDB outbox and are batched to the server | `enqueue()` / `flush()` |

**Duplicate protection** (`public/js/app.js`, top): the same barcode is ignored for 1.5 s after it is
added, **and** an item held still in view counts only once. To scan the same item again, move it out of
the box briefly (~0.5 s) and back. Set `GAP_MS = 0` for a purely time-based 1.5 s debounce.

UPC-A (12 digits) and EAN-13 with a leading 0 are treated as the same product, so a code saved from one
phone still matches when another phone's decoder reports the other form.

## File structure

```
Pocket POS/
├── README.md                 ← this file
├── SETUP.md                  ← step-by-step: Google Cloud, sheet, env vars, Vercel, domain, phone
├── package.json              ← scripts: dev, build, hash-password (only dependency: @zxing/library)
├── vercel.json               ← build/output settings + security headers (CSP etc.)
├── .env.example              ← the environment variables you need
├── dev-server.js             ← zero-dependency local server (static files + /api, like Vercel)
│
├── api/                      ← serverless functions (each file = one URL)
│   ├── login.js              POST /api/login     password → session cookie (rate-limited)
│   ├── logout.js             POST /api/logout
│   ├── session.js            GET  /api/session   logged in? demo mode?
│   ├── products.js           GET  /api/products  full product list from the sheet
│   └── sync.js               POST /api/sync      batched new products + sales → sheet
│
├── lib/                      ← server-only code (secrets never reach the browser)
│   ├── auth.js               scrypt password check, signed cookies, rate limiting, CSRF check
│   ├── sheets.js             Google Sheets REST + service-account JWT, auto-creates tabs/headers
│   ├── demo-db.js            local JSON stand-in for Sheets during `npm run dev`
│   └── http.js               small request/response helpers
│
├── public/                   ← everything the phone downloads
│   ├── index.html            all screens: login, scanner + cart, bottom sheets
│   ├── css/app.css           high-contrast mobile UI
│   ├── js/app.js             UI wiring: scan → cart, sheets, checkout, settings, sync badge
│   ├── js/scanner.js         camera + decode loop (the speed-critical part)
│   ├── js/zxing-worker.js    software decoder fallback, in a worker
│   ├── js/store.js           IndexedDB cache, product Map, outbox + background sync
│   ├── js/cart.js            cart state, money in integer cents, GST, cash rounding
│   ├── js/feedback.js        beeps + vibration
│   ├── sw.js                 service worker: offline app shell
│   ├── manifest.webmanifest  PWA manifest (full-screen, portrait)
│   ├── icons/                app icons
│   └── vendor/               (created by `npm run build`) zxing.min.js
│
├── scripts/
│   ├── hash-password.js      prints PASSWORD_HASH + SESSION_SECRET
│   └── copy-vendor.js        copies ZXing into public/vendor at build time
│
└── sheet-template/
    ├── Pocket-POS-template.xlsx   ready-made Products + Sales tabs (upload → Save as Google Sheets)
    ├── Products.csv               header row only
    └── Sales.csv                  header row only
```

## Common tweaks

| Want to… | Change |
|---|---|
| Different duplicate window | `SAME_CODE_MS` / `GAP_MS` at the top of `public/js/app.js` |
| Bigger or smaller scan box | `.roi { width; height }` in `public/css/app.css` |
| More or fewer barcode formats | `NATIVE_FORMATS` in `scanner.js` and the hints list in `zxing-worker.js` |
| Colours | CSS variables at the top of `app.css` |
| Camera / cart split | `.app { grid-template-rows: 44dvh … }` in `app.css` |
| Beep sound | `beepOk()` frequency and length in `feedback.js` |
| Default GST behaviour | `settings` defaults in `public/js/cart.js` |
| Login lockout rules | `WINDOW_MS`, `PER_IP`, `GLOBAL` in `lib/auth.js` |

After changing files in `public/`, bump `VERSION` in `public/sw.js` so phones pick up the update promptly.

## Notes and limits

- **iPhone:** Safari has no native `BarcodeDetector`, so the ZXing worker is used (~20 decodes/s). It is
  still quick for retail barcodes in decent light. iOS ignores flashlight control and tap-to-focus, and only
  opens the keyboard automatically after a tap, so tap the Name field after an unknown scan.
- **Stock** is stored but not decremented on sale. That would need a read-modify-write on every sale. Add it in
  `lib/sheets.js` → `appendSales()` if you want it.
- **Rate limiting** is per serverless instance. That is fine for one shop. For stricter limits, enable Vercel Firewall rules.
- **Scale:** each sync reads the `Sales!A` column to skip duplicates (so retries never double-record a sale).
  That stays fast into the tens of thousands of sales. Archive old rows to another tab yearly if needed.
- Google Sheets API quota is about 60 write requests per minute per user. A sync uses at most 5 requests however
  many items it carries, and quick successive writes are merged into one sync.
# Pocket-POS
