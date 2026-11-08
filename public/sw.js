// sw.js — service worker: caches the app shell so the POS opens instantly and works offline.
// Bump VERSION when you change files and want phones to pick them up sooner
// (they also update in the background on the next launch).
const VERSION = 'pos-v27';
const SHELL = [
  '/', '/index.html', '/css/app.css', '/manifest.webmanifest',
  '/js/app.js', '/js/theme.js', '/js/infobar.js', '/js/weather-icons.js', '/js/scanner.js', '/js/zxing-worker.js', '/js/store.js', '/js/cart.js', '/js/feedback.js', '/js/receipt.js',
  '/icons/icon-192.png', '/icons/icon-512.png',
  '/customer.html', '/css/customer.css', '/js/customer.js', '/js/display.js',
];
const OPTIONAL = ['/vendor/zxing.min.js']; // only exists after `npm run build`

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    await Promise.all(OPTIONAL.map((u) => cache.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) return; // never cache API
  if (url.origin === location.origin && url.pathname.startsWith('/_vercel/')) return; // Vercel Analytics: straight to network

  // Pages: network first (get updates), fall back to the cached copy of THAT page when offline
  // (so the customer display and the POS each keep their own page).
  if (req.mode === 'navigate') {
    const key = url.pathname === '/customer.html' ? '/customer.html' : '/';
    event.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(key, copy)); }
      return res;
    }).catch(async () => (await caches.match(key)) || caches.match('/')));
    return;
  }

  // Static files: serve from cache instantly, refresh in background.
  if (url.origin === location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const cached = await cache.match(req);
      const network = fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || network;
    })());
  }
});
