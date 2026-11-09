// app.js — wires everything together: login, scanner -> cart, bottom sheets, checkout, settings.

import { Scanner } from './scanner.js';
import { setStateProvider, publishCart, publishSale, openCustomerDisplay } from './display.js';
import { startInfobar, searchPlaces, setWeatherLocation, useDeviceLocation, weatherLocation } from './infobar.js';
import { receiptSettings, saveReceiptSettings, printReceipt, rememberLastSale, lastSale, sampleSale, openDrawer, checkHelper } from './receipt.js';
import { unlockAudio, beepOk, beepUnknown, beepSale } from './feedback.js';
import {
  cart, settings, saveSettings, addProduct, addManual, updateLine, removeLine, clearCart,
  itemCount, totals, money, parseMoney, toDollars, roundCash, MAX_QTY, MAX_SALE_CENTS,
} from './cart.js';
import {
  products, lookup, loadProductsFromCache, refreshProducts, saveProductLocally, categories,
  enqueue, flush, startSyncLoop, onSyncChange, setAuthLostHandler, api, syncState, clearLocalProducts,
} from './store.js';

// ---- Tunables -------------------------------------------------------------------------------
const SAME_CODE_MS = 1500;   // ignore the same barcode for this long after it was added
const GAP_MS = 500;          // an item held still in view only counts once; it must leave the
                             // frame for this long before it can be scanned again (set 0 to disable)
const FLASH_MS = 1200;       // how long the green "added" banner stays up
const WEDGE_GAP_MS = 60;     // USB/Bluetooth scanners "type" much faster than this between keys
const WEDGE_MIN_LEN = 3;     // ignore shorter bursts

// ---- Tiny DOM helpers -----------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let toastTimer;
function toast(msg, bad = false, ms = 2200) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('bad', bad);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

let scanner = null;
let appStarted = false;
let demoMode = false;

// =============================================================================================
// Boot & login
// =============================================================================================
async function boot() {
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  // Audio can only start after a tap; unlock on the first touch anywhere.
  document.addEventListener('pointerdown', unlockAudio, { once: true, capture: true });

  try {
    const s = await api('/api/session');
    demoMode = !!s.demo;
    if (s.authenticated) { localStorage.setItem('pos_authed', '1'); startApp(); }
    else showLogin();
  } catch {
    // Offline? If we've logged in on this phone before, run from the local cache.
    if (localStorage.getItem('pos_authed')) { startApp(); toast('Offline — will sync later', true); }
    else showLogin('You are offline. Connect to log in.');
  }
}

function showLogin(message = '') {
  $('login').hidden = false;
  $('loginError').textContent = message;
  $('demoHint').hidden = !demoMode;
  setTimeout(() => $('password').focus(), 50);
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  unlockAudio();
  const btn = e.submitter || $('loginForm').querySelector('button');
  btn.disabled = true;
  $('loginError').textContent = '';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('password').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Login failed');
    localStorage.setItem('pos_authed', '1');
    $('password').value = '';
    $('login').hidden = true;
    if (appStarted) { flush(); refreshProducts().catch(() => {}); } else startApp();
  } catch (err) {
    $('loginError').textContent = err.message === 'Failed to fetch' ? 'No connection' : err.message;
  } finally {
    btn.disabled = false;
  }
});

setAuthLostHandler(() => {
  localStorage.removeItem('pos_authed');
  showLogin('Session expired — please log in again. Your cart and unsynced sales are kept.');
});

// =============================================================================================
// Main app
// =============================================================================================
async function startApp() {
  appStarted = true;
  $('login').hidden = true;
  $('app').hidden = false;
  renderCart();
  updateDrawerButton();
  startInfobar();
  if (demoMode) toast('Demo mode: data is stored on the dev server, not Google Sheets', false, 3500);

  // 1) Products from IndexedDB: instant, works offline.
  await loadProductsFromCache().catch(() => {});

  // 2) Camera on immediately.
  scanner = new Scanner({ video: $('video'), roiEl: $('roi'), onDetect: onScan });
  window.__scanner = scanner; // handy for debugging in the console
  startCamera();

  // 3) Fresh product list + background sync.
  refreshProducts().then((n) => updateProductInfo(n)).catch((err) => {
    if (products.size === 0) toast('Could not load products: ' + err.message, true, 4000);
  });
  startSyncLoop();
}

async function startCamera() {
  const msg = $('camMsg');
  // Camera switched off in Settings (e.g. a PC with a USB scanner): scanner mode only.
  if (!settings.cameraEnabled || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    scanner.stopCamera();
    msg.hidden = true;
    setScannerMode(true);
    return;
  }
  setScannerMode(false);
  msg.hidden = false;
  msg.textContent = 'Starting camera…';
  try {
    await scanner.start();
    msg.hidden = true;
    $('torchBtn').hidden = !scanner.torchSupported;
  } catch (err) {
    const name = err && err.name;
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      // No camera on this device: that's fine, use a barcode scanner instead.
      msg.hidden = true;
      setScannerMode(true);
      return;
    }
    msg.textContent = (name === 'NotAllowedError'
      ? 'Camera permission is blocked. Allow camera access for this site in your browser settings, then tap here.'
      : !window.isSecureContext ? 'The camera needs HTTPS. Open the https:// address.'
      : 'Camera error: ' + (err.message || name) + ' — tap to retry.')
      + ' A USB/Bluetooth barcode scanner still works.';
  }
}
$('camMsg').addEventListener('click', () => startCamera());

// Phones may suspend the camera when the app is backgrounded; revive it on return.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && scanner && appStarted && settings.cameraEnabled && scanner.running) {
    scanner.ensureAlive().catch(() => startCamera());
  }
});

// ---- Scanner mode (no camera): big "ready" panel for USB/Bluetooth scanners ----------------
function setScannerMode(on) {
  $('scanner').classList.toggle('wedge-mode', on);
  $('wedgePanel').hidden = !on;
  $('torchBtn').hidden = true;
  updateWedgeFocus();
}

/** Scans only reach the app while its window has keyboard focus. Show when it doesn't. */
function updateWedgeFocus() {
  const focused = document.hasFocus();
  $('wedgePanel').classList.toggle('unfocused', !focused);
  $('wedgeTitle').textContent = focused ? 'Ready — scan an item' : 'Click here, then scan';
  $('wedgeSub').textContent = focused
    ? 'USB or Bluetooth barcode scanner'
    : 'This window must be active for the scanner to type into it';
}
window.addEventListener('focus', updateWedgeFocus);
window.addEventListener('blur', updateWedgeFocus);
$('wedgePanel').addEventListener('click', () => {
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  window.focus();
  updateWedgeFocus();
});

// =============================================================================================
// Scanning
// =============================================================================================
// `last` remembers the most recent code so one physical scan never adds twice.
let last = { code: null, acceptedAt: -1e9, seenAt: -1e9, used: false };

function onScan(code, format) {
  code = String(code).trim();
  if (!code) return;
  const now = performance.now();
  if (code === last.code) {
    const newPresentation = now - last.seenAt >= GAP_MS;  // was it out of view for a moment?
    last.seenAt = now;
    if (newPresentation) last.used = false;
    if (last.used) return;                               // same item still sitting in view
    if (now - last.acceptedAt < SAME_CODE_MS) return;    // too soon after the last add
  }
  last = { code, acceptedAt: now, seenAt: now, used: true };
  handleCode(code, format);
}

/** Called for camera scans, manual entry and keyboard-wedge scanners. */
function handleCode(code) {
  code = String(code ?? '').replace(/[\s\u0000-\u001f\u007f]/g, '').slice(0, 64);   // scanners can add spaces/CR
  if (!code) return;
  if (editMode) {                       // Settings > Edit a product: open the editor, don't sell
    setEditMode(false);
    const p = lookup(code);
    beepOk();
    if (p) openProductForm('edit', p);
    else openProductForm('new', { barcode: code });
    return;
  }
  const product = lookup(code);
  if (product) {
    const line = addProduct(product);
    beepOk();
    showFlash(product.name, line.unitCents);
    renderCart(true);
  } else {
    beepUnknown();
    flashROI('miss');
    openProductForm('new', { barcode: code });
  }
}

let flashTimer;
function showFlash(name, cents) {
  $('flashName').textContent = name;
  $('flashPrice').textContent = money(cents);
  const f = $('flash');
  f.hidden = true; void f.offsetWidth; f.hidden = false; // restart the animation
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { f.hidden = true; }, FLASH_MS);
  flashROI('hit');
}
function flashROI(cls) {
  const roi = $('roi');
  roi.classList.add(cls);
  setTimeout(() => roi.classList.remove(cls), 350);
}

// Torch
let torchOn = false;
$('torchBtn').addEventListener('click', async () => {
  torchOn = !torchOn;
  try { await scanner.setTorch(torchOn); $('torchBtn').classList.toggle('on', torchOn); }
  catch { torchOn = false; toast('Flashlight not available', true); }
});

// Tap-to-focus (tap anywhere on the camera picture)
$('scanner').addEventListener('click', (e) => {
  if (!scanner || e.target.closest('button, form, .cam-msg, .flash')) return;
  const v = $('video');
  const box = v.getBoundingClientRect();
  const vw = v.videoWidth, vh = v.videoHeight;
  if (!vw) return;
  const scale = Math.max(box.width / vw, box.height / vh);
  const x = ((e.clientX - box.left) - (box.width - vw * scale) / 2) / (vw * scale);
  const y = ((e.clientY - box.top) - (box.height - vh * scale) / 2) / (vh * scale);
  scanner.focusAt(Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))).then((ok) => {
    if (!ok) return;
    const ring = $('focusRing');
    ring.style.left = (e.clientX - box.left) + 'px';
    ring.style.top = (e.clientY - box.top) + 'px';
    ring.hidden = true; void ring.offsetWidth; ring.hidden = false;
  });
});

// Manual barcode entry (fallback when the camera can't read a code)
$('manualBtn').addEventListener('click', () => {
  const form = $('manualForm');
  form.hidden = !form.hidden;
  if (!form.hidden) $('manualInput').focus();
});
$('manualForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = $('manualInput').value.trim();
  if (!code) return;
  $('manualInput').value = '';
  $('manualForm').hidden = true;
  $('manualInput').blur();
  last = { code, acceptedAt: performance.now(), seenAt: performance.now(), used: true };
  handleCode(code);
});

// USB / Bluetooth barcode scanners act like a very fast keyboard: they "type" the code and then
// press Enter (or Tab). We collect keys that arrive within WEDGE_GAP_MS of each other; a human
// typing is much slower, so normal typing is never mistaken for a scan.
// Works on PCs and on phones/tablets with a Bluetooth scanner, with or without the camera.
let wedge = '', wedgeAt = 0;
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
  // Typing in a form field (e.g. the New product form) is left alone.
  if (e.target.matches && e.target.matches('input, textarea, select')) return;
  const now = performance.now();
  if (now - wedgeAt > WEDGE_GAP_MS) wedge = '';
  wedgeAt = now;

  if (e.key === 'Enter' || e.key === 'Tab') {
    if (wedge.length >= WEDGE_MIN_LEN) {
      e.preventDefault();               // don't "click" a focused button or move focus
      const code = wedge;
      wedge = '';
      onWedgeScan(code);
    }
    return;
  }
  if (e.key.length === 1) wedge += e.key;
}, true);

function onWedgeScan(code) {
  code = code.trim();
  if (anySheetOpen()) {
    // A form is open (checkout, edit…). Don't silently drop the scan: tell the user.
    beepUnknown();
    toast('Close the open panel first, then scan again', true);
    return;
  }
  last = { code, acceptedAt: performance.now(), seenAt: performance.now(), used: true };
  handleCode(code);   // deliberate trigger press: no duplicate filtering needed
}

// =============================================================================================
// Cart rendering
// =============================================================================================
function renderCart(bumpFirst = false) {
  const list = $('cartList');
  list.innerHTML = cart.lines.map((l) => {
    const changed = l.unitCents !== l.baseCents;
    return `<li class="line" data-key="${esc(l.key)}">`
      + `<div class="line-main" data-act="edit"><div class="line-name">${esc(l.name)}</div>`
      + `<div class="line-sub"><span class="${changed ? 'changed' : ''}">${money(l.unitCents)}</span>${changed ? ' (was ' + money(l.baseCents) + ')' : ''}</div></div>`
      + `<button class="q" data-act="minus" aria-label="Less">−</button>`
      + `<span class="qty">${l.qty}</span>`
      + `<button class="q" data-act="plus" aria-label="More">+</button>`
      + `<div class="line-total" data-act="edit">${money(l.unitCents * l.qty)}</div>`
      + `</li>`;
  }).join('');
  $('cartEmpty').hidden = cart.lines.length > 0;
  if (bumpFirst && list.firstElementChild) {
    list.firstElementChild.classList.add('bump');
    list.scrollTop = 0;
  }

  const n = itemCount();
  const t = totals();
  $('cartCount').textContent = `${n} item${n === 1 ? '' : 's'}`;
  $('cartTotal').textContent = money(t.total);
  $('gstLine').textContent = gstText(t);
  $('checkoutBtn').disabled = n === 0;
  publishCart(bumpFirst && cart.lines[0] ? cart.lines[0].key : null);   // update the customer display
}

// ---- Customer display (second screen) --------------------------------------------------------
// What the customer sees: built from the cart, already formatted, so customer.js stays simple.
setStateProvider(() => {
  const t = totals();
  return {
    shop: receiptSettings.shopName || '',
    lines: cart.lines.map((l) => ({
      key: l.key, name: l.name, qty: l.qty,
      unit: money(l.unitCents), total: money(l.unitCents * l.qty),
      was: l.unitCents < l.baseCents ? money(l.baseCents) : null,   // show discounts, not mark-ups
    })),
    count: itemCount(),
    total: money(t.total),
    gstText: gstText(t),
  };
});

async function showCustomerDisplay() {
  const r = await openCustomerDisplay();
  if (r === 'blocked') toast('Pop-up blocked: allow pop-ups for this site, then try again', true, 4500);
  else toast('Customer display opened. Drag it to the customer screen if needed, then click it for full screen', false, 4500);
  setTimeout(() => publishCart(), 800);
}
$('custBtn').addEventListener('click', showCustomerDisplay);
$('custDisplayBtn').addEventListener('click', () => { closeSheets(); showCustomerDisplay(); });

// ---- Customer display layout (a damaged part of the customer screen) ----
// Saved in localStorage, which the customer display window (same browser) reads and watches.
// cols = the 5%-wide stripes, counted from the left, that are black on that monitor.
const CD_KEY = 'pos_cdisplay_v2';   // v2: default measured on the shop's screen (40–65%)
const CD_DEFAULT = { on: true, cols: [40, 45, 50, 55, 60], test: false };
function readCd() {
  try { return { ...CD_DEFAULT, ...(JSON.parse(localStorage.getItem(CD_KEY)) || {}) }; } catch { return { ...CD_DEFAULT }; }
}
function saveCd(cfg) {
  try { localStorage.setItem(CD_KEY, JSON.stringify(cfg)); } catch { /* storage blocked */ }
  renderCd();
}
function renderCd() {
  const cfg = readCd();
  $('cdOn').checked = !!cfg.on;
  $('cdTest').checked = !!cfg.test;
  const box = $('cdCols');
  if (!box.childElementCount) {
    for (let n = 0; n < 100; n += 5) {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.col = String(n); b.textContent = String(n);
      box.append(b);
    }
  }
  for (const b of box.children) b.classList.toggle('on', cfg.cols.includes(Number(b.dataset.col)));
  box.classList.toggle('off', !cfg.on);
  if (!cfg.on || !cfg.cols.length) { $('cdInfo').textContent = 'The whole customer screen is used.'; return; }
  const from = Math.min(...cfg.cols), to = Math.max(...cfg.cols) + 5;
  $('cdInfo').textContent = `Kept clear: ${from}% to ${to}% across the screen, counted from the left.`;
}
function stopTestPattern() { const c = readCd(); if (c.test) saveCd({ ...c, test: false }); }
$('cdLayoutBtn').addEventListener('click', () => { renderCd(); openSheet('cdSheet'); });
$('cdOn').addEventListener('change', () => saveCd({ ...readCd(), on: $('cdOn').checked }));
$('cdTest').addEventListener('change', () => saveCd({ ...readCd(), test: $('cdTest').checked }));
$('cdCols').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-col]');
  if (!b) return;
  const n = Number(b.dataset.col), c = readCd();
  const cols = c.cols.includes(n) ? c.cols.filter((x) => x !== n) : [...c.cols, n].sort((a, z) => a - z);
  saveCd({ ...c, cols, on: cols.length ? true : c.on });
});

function gstText(t) {
  if (!settings.gstEnabled) return '';
  return settings.pricesIncludeGst ? `Incl. GST ${money(t.gst)}` : `Subtotal ${money(t.subtotal)} + GST ${money(t.gst)}`;
}

$('cartList').addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const key = el.closest('.line').dataset.key;
  const line = cart.lines.find((l) => l.key === key);
  if (!line) return;
  if (el.dataset.act === 'plus') updateLine(key, { qty: line.qty + 1 });
  else if (el.dataset.act === 'minus') updateLine(key, { qty: line.qty - 1 });
  else if (el.dataset.act === 'edit') return openEdit(line);
  renderCart();
});

// Clear needs two taps so it can't happen by accident.
let clearArmed = null;
$('clearBtn').addEventListener('click', () => {
  const btn = $('clearBtn');
  if (!cart.lines.length) return;
  if (clearArmed) {
    clearTimeout(clearArmed); clearArmed = null;
    btn.classList.remove('armed'); btn.textContent = 'Clear';
    clearCart(); renderCart();
    return;
  }
  btn.classList.add('armed'); btn.textContent = 'Sure?';
  clearArmed = setTimeout(() => { clearArmed = null; btn.classList.remove('armed'); btn.textContent = 'Clear'; }, 2500);
});

// =============================================================================================
// Bottom sheets
// =============================================================================================
const SHEETS = ['newProductSheet', 'editSheet', 'manualItemSheet', 'checkoutSheet', 'settingsSheet', 'receiptSheet', 'weatherSheet', 'cdSheet'];
const anySheetOpen = () => SHEETS.some((id) => !$(id).hidden);

function openSheet(id) {
  SHEETS.forEach((s) => { $(s).hidden = s !== id; });
  $('sheetBackdrop').hidden = false;
  if (scanner) scanner.pause();   // never add items while a form is open
}

function closeSheets() {
  if (!$('cdSheet').hidden) stopTestPattern();
  SHEETS.forEach((s) => { $(s).hidden = true; });
  $('sheetBackdrop').hidden = true;
  document.activeElement && document.activeElement.blur();
  // Whatever is still in front of the camera must not be re-added the moment we resume.
  const now = performance.now();
  last.seenAt = now; last.used = true;
  if (scanner) scanner.resume();
}

$('sheetBackdrop').addEventListener('click', closeSheets);
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSheets));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && anySheetOpen()) closeSheets(); });

// ---- Product form: add a NEW product, or EDIT an existing one --------------------------------
let productFormMode = 'new';   // 'new' | 'edit'

function openProductForm(mode, product) {
  productFormMode = mode;
  const f = $('newProductSheet');
  f.reset();
  const editing = mode === 'edit';
  $('npTitle').textContent = editing ? 'Edit product' : 'New product';
  $('npSubmit').textContent = editing ? 'Save changes' : 'Save & Add to Cart';
  $('npBarcode').readOnly = editing;    // the barcode identifies the product, so it can't change
  $('npBarcode').value = product.barcode;
  if (editing) {
    $('npName').value = product.name || '';
    $('npPrice').value = product.price != null ? Number(product.price).toFixed(2) : '';
    $('npCost').value = product.cost != null ? Number(product.cost).toFixed(2) : '';
    $('npCategory').value = product.category || '';
    $('npStock').value = product.stock != null ? product.stock : '';
  }
  $('npError').textContent = '';
  $('categoryList').innerHTML = categories().map((c) => `<option value="${esc(c)}">`).join('');
  openSheet('newProductSheet');
  // Note: iOS only shows the keyboard for focus() inside a tap; Android shows it straight away.
  if (editing) { $('npPrice').focus(); $('npPrice').select(); } else $('npName').focus();
}

// Settings > Edit a product: the next scan (camera, scanner or typed) opens the editor.
let editMode = false;
function setEditMode(on) {
  editMode = on;
  $('editBanner').hidden = !on;
}
$('editProductModeBtn').addEventListener('click', () => {
  closeSheets();
  setEditMode(true);
  last = { code: null, acceptedAt: -1e9, seenAt: -1e9, used: false };   // allow the item in view
});
$('editBannerCancel').addEventListener('click', (e) => { e.stopPropagation(); setEditMode(false); });
$('npName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('npPrice').focus(); }
});
$('newProductSheet').addEventListener('submit', async (e) => {
  e.preventDefault();
  const barcode = $('npBarcode').value.replace(/\s/g, '');
  const name = $('npName').value.trim();
  if (barcode && !/^[\x21-\x7e]{1,64}$/.test(barcode)) { $('npError').textContent = 'Barcode: letters, numbers and symbols only, up to 64'; return $('npBarcode').focus(); }
  const priceCents = parseMoney($('npPrice').value);
  if (!barcode) return ($('npError').textContent = 'Barcode is required');
  if (!name) { $('npError').textContent = 'Name is required'; return $('npName').focus(); }
  if (priceCents === null) { $('npError').textContent = 'Enter a price (up to $99,999.99)'; return $('npPrice').focus(); }

  const costCents = parseMoney($('npCost').value);
  if ($('npCost').value.trim() && costCents === null) { $('npError').textContent = 'Cost must be a number up to $99,999.99'; return $('npCost').focus(); }
  const stockText = $('npStock').value.trim();
  const product = {
    barcode,
    name,
    price: toDollars(priceCents),
    cost: costCents === null ? null : toDollars(costCents),
    category: $('npCategory').value.trim(),
    stock: stockText === '' || isNaN(Number(stockText)) ? null : Number(stockText),
  };
  if (productFormMode === 'edit') {
    await saveProductLocally(product);   // new price works for the very next scan
    enqueue('product', product);         // updates the existing row in the sheet, in background
    // Cart lines for this product pick up the change, unless their price was set just for this sale.
    for (const l of cart.lines) {
      if (l.barcode !== barcode) continue;
      const custom = l.unitCents !== l.baseCents;
      updateLine(l.key, { name: product.name, baseCents: priceCents, ...(custom ? {} : { unitCents: priceCents }) });
    }
    closeSheets();
    renderCart();
    toast(`Saved · ${product.name} is now ${money(priceCents)}`);
    return;
  }

  await saveProductLocally(product);                                    // instant lookup from now on
  enqueue('product', { ...product, created_at: localDateTime() });       // to the sheet, in background
  const line = addProduct(product);
  beepOk();
  closeSheets();
  last = { code: barcode, acceptedAt: performance.now(), seenAt: performance.now(), used: true };
  showFlash(product.name, line.unitCents);
  renderCart(true);
});

// ---- Edit a cart line -------------------------------------------------------------------------
let editingKey = null;
function openEdit(line) {
  editingKey = line.key;
  $('editName').textContent = line.name;
  $('editQty').value = line.qty;
  $('editPrice').value = toDollars(line.unitCents).toFixed(2);
  $('editProductBtn').hidden = !line.barcode || !lookup(line.barcode);   // manual items aren't products
  openSheet('editSheet');
}
$('editMinus').addEventListener('click', () => { $('editQty').value = Math.max(0, (parseInt($('editQty').value, 10) || 0) - 1); });
$('editPlus').addEventListener('click', () => { $('editQty').value = (parseInt($('editQty').value, 10) || 0) + 1; });
$('editProductBtn').addEventListener('click', () => {
  const line = cart.lines.find((l) => l.key === editingKey);
  const p = line && lookup(line.barcode);
  if (p) openProductForm('edit', p);
});
$('editRemove').addEventListener('click', () => { removeLine(editingKey); closeSheets(); renderCart(); });
$('editSheet').addEventListener('submit', (e) => {
  e.preventDefault();
  const qty = parseInt($('editQty').value, 10);
  const cents = parseMoney($('editPrice').value);
  const changes = {};
  if (!isNaN(qty)) changes.qty = qty;
  if (qty > MAX_QTY) toast(`Quantity limited to ${MAX_QTY}`, true);
  if (cents !== null) changes.unitCents = cents;   // price for THIS sale only; the product isn't changed
  else if ($('editPrice').value.trim()) toast('Price not changed: enter a number up to $99,999.99', true);
  updateLine(editingKey, changes);
  closeSheets();
  renderCart();
});

// ---- Manual item (no barcode) -----------------------------------------------------------------
$('manualItemBtn').addEventListener('click', () => {
  $('manualItemSheet').reset();
  $('miError').textContent = '';
  openSheet('manualItemSheet');
  $('miPrice').focus();
});
$('manualItemSheet').addEventListener('submit', (e) => {
  e.preventDefault();
  const cents = parseMoney($('miPrice').value);
  if (cents === null) { $('miError').textContent = 'Enter a price (up to $99,999.99)'; return; }
  addManual($('miName').value.trim(), cents);
  closeSheets();
  renderCart(true);
});

// ---- Checkout -------------------------------------------------------------------------------
let payType = 'Cash';
$('checkoutBtn').addEventListener('click', () => {
  if (!cart.lines.length) return;
  const t = totals();
  if (t.total > MAX_SALE_CENTS) { toast('Sale total is over $1,000,000 — check the quantities and prices', true, 4000); return; }
  $('coTotal').textContent = money(t.total);
  $('coGst').textContent = gstText(t);
  $('cashIn').value = '';
  $('printOn').checked = !!receiptSettings.autoPrint;   // remembers your last choice
  setPayType('Cash');
  openSheet('checkoutSheet');
});

function setPayType(type) {
  payType = type;
  document.querySelectorAll('#payType button').forEach((b) => b.classList.toggle('on', b.dataset.pay === type));
  $('cashBox').hidden = type !== 'Cash';
  if (type === 'Cash') renderCashHelpers();
}
$('payType').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setPayType(b.dataset.pay); });

function cashDue() { return roundCash(totals().total); }

function renderCashHelpers() {
  const due = cashDue();
  const t = totals().total;
  $('cashDue').textContent = due !== t ? `Cash total rounded to ${money(due)}` : '';
  const notes = [500, 1000, 2000, 5000, 10000].filter((n) => n >= due).slice(0, 4);
  $('quickCash').innerHTML = [`<button type="button" data-cash="${due}">Exact</button>`]
    .concat(notes.filter((n) => n !== due).map((n) => `<button type="button" data-cash="${n}">${money(n)}</button>`)).join('');
  renderChange();
}
$('quickCash').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  $('cashIn').value = toDollars(Number(b.dataset.cash)).toFixed(2);
  renderChange();
});
$('cashIn').addEventListener('input', renderChange);

function renderChange() {
  const out = $('changeOut');
  const received = parseMoney($('cashIn').value, MAX_SALE_CENTS);
  if (received === null) { out.textContent = ''; out.classList.remove('short'); return; }
  const diff = received - cashDue();
  out.textContent = diff >= 0 ? `Change ${money(diff)}` : `Short ${money(-diff)}`;
  out.classList.toggle('short', diff < 0);
}

$('checkoutSheet').addEventListener('submit', (e) => {
  e.preventDefault();
  const t = totals();
  let cashReceived = null, change = null;
  if (payType === 'Cash') {
    const received = parseMoney($('cashIn').value, MAX_SALE_CENTS);
    if (received !== null) {
      if (received < cashDue()) { toast('Cash received is less than the total', true); return; }
      cashReceived = toDollars(received);
      change = toDollars(received - cashDue());
    }
  }
  const sale = {
    sale_id: makeSaleId(),
    date_time: localDateTime(),
    items: cart.lines.map((l) => ({
      barcode: l.barcode || '', name: l.name, qty: l.qty,
      price: toDollars(l.unitCents), line_total: toDollars(l.unitCents * l.qty),
    })),
    subtotal: toDollars(t.subtotal),
    gst: toDollars(t.gst),
    total: toDollars(t.total),
    payment_type: payType,
    cash_received: cashReceived,
    change,
  };
  enqueue('sale', sale);  // saved to IndexedDB now, sent to the Sales sheet in the background
  rememberLastSale(sale);
  const wantPrint = $('printOn').checked;
  if (receiptSettings.autoPrint !== wantPrint) { receiptSettings.autoPrint = wantPrint; saveReceiptSettings(); }
  clearCart();
  closeSheets();
  renderCart();
  publishSale({
    total: money(t.total),
    payment: payType,
    paid: cashReceived !== null ? money(Math.round(cashReceived * 100)) : (payType !== 'Cash' ? money(t.total) : null),
    change: change !== null ? money(Math.round(change * 100)) : null,
  });
  beepSale();
  toast(change !== null ? `Sale saved · Change ${money(Math.round(change * 100))}` : 'Sale saved', false, 3500);
  const popDrawer = payType === 'Cash' && receiptSettings.drawerEnabled && receiptSettings.drawerOnCash;
  if (receiptSettings.drawerMethod === 'helper') {
    // Helper opens the drawer (no paper); the receipt prints separately if wanted.
    if (popDrawer) {
      openDrawer('CASH SALE', sale, { onError: (err) => toast(drawerErrorText(err), true, 5000) });
    }
    if (wantPrint) printReceipt(sale);
  } else if (wantPrint) {
    printReceipt(sale);                          // the printer driver opens the drawer as it prints
  } else if (popDrawer) {
    openDrawer('CASH SALE', sale);               // print a small slip, which opens the drawer
  }
});

// ---- Settings -------------------------------------------------------------------------------
// ---- Weather location -----------------------------------------------------------------------
function openWeatherSheet() {
  $('weatherSheet').reset();
  $('wxResults').innerHTML = '';
  const loc = weatherLocation();
  $('wxMsg').textContent = loc && !loc.off ? `Now showing: ${loc.name}` : 'Choose the suburb to show the weather for.';
  openSheet('weatherSheet');
  $('wxSearch').focus();
}
$('weatherChip').addEventListener('click', openWeatherSheet);
$('weatherSetBtn').addEventListener('click', openWeatherSheet);
$('weatherSheet').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('wxSearch').value.trim();
  if (q.length < 2) { $('wxMsg').textContent = 'Type at least 2 letters, or a 4-digit postcode.'; return; }
  $('wxMsg').textContent = 'Searching…';
  try {
    const places = await searchPlaces(q);
    $('wxMsg').textContent = places.length ? 'Tap your suburb:' : 'No places found. Try another spelling or the postcode.';
    $('wxResults').innerHTML = places.map((p, i) =>
      `<li><button type="button" data-i="${i}">${esc(p.name)} <small>${esc(p.state || '')}</small></button></li>`).join('');
    $('wxResults').onclick = (ev) => {
      const b = ev.target.closest('button[data-i]');
      if (!b) return;
      const p = places[Number(b.dataset.i)];
      setWeatherLocation({ name: p.name, lat: +(+p.lat).toFixed(3), lon: +(+p.lon).toFixed(3) });
      closeSheets();
      toast(`Weather: ${p.name}`);
    };
  } catch (err) { $('wxMsg').textContent = err.message; }
});
$('wxUseLocation').addEventListener('click', async () => {
  $('wxMsg').textContent = 'Getting location…';
  try { const loc = await useDeviceLocation(); closeSheets(); toast(`Weather: ${loc.name}`); }
  catch (err) { $('wxMsg').textContent = err.message; }
});
$('wxOff').addEventListener('click', () => { setWeatherLocation({ off: true }); closeSheets(); toast('Weather hidden. Turn it back on in ☰ → Weather location'); });

// ---- Theme (Auto / Light / Dark), saved on this device ---------------------------------------
function showThemeChoice() {
  if (!window.PocketTheme) return;
  const mode = window.PocketTheme.getMode();
  const accent = window.PocketTheme.getAccent();
  document.querySelectorAll('#themePick button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  document.querySelectorAll('#accentPick button').forEach((b) => b.classList.toggle('on', b.dataset.accent === accent));
}
$('themePick').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !window.PocketTheme) return;
  window.PocketTheme.setMode(b.dataset.mode);
  showThemeChoice();
});
$('accentPick').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b || !window.PocketTheme) return;
  window.PocketTheme.setAccent(b.dataset.accent);
  showThemeChoice();
});

$('menuBtn').addEventListener('click', () => {
  showThemeChoice();
  updateSyncTimes();
  $('camOn').checked = settings.cameraEnabled;
  $('gstOn').checked = settings.gstEnabled;
  $('gstIncl').checked = settings.pricesIncludeGst;
  updateProductInfo(products.size);
  openSheet('settingsSheet');
});
$('syncBadge').addEventListener('click', () => $('menuBtn').click());
$('camOn').addEventListener('change', () => {
  settings.cameraEnabled = $('camOn').checked;
  saveSettings();
  startCamera();
});
$('gstOn').addEventListener('change', () => { settings.gstEnabled = $('gstOn').checked; saveSettings(); renderCart(); });
$('gstIncl').addEventListener('change', () => { settings.pricesIncludeGst = $('gstIncl').checked; saveSettings(); renderCart(); });
$('refreshBtn').addEventListener('click', async () => {
  const btn = $('refreshBtn');
  btn.disabled = true;
  try { const n = await refreshProducts(); updateProductInfo(n); toast(`Loaded ${n.toLocaleString('en-AU')} products`); }
  catch (err) { toast('Refresh failed: ' + err.message, true); }
  finally { btn.disabled = false; }
});
$('syncNowBtn').addEventListener('click', async () => {
  const btn = $('syncNowBtn');
  btn.disabled = true;
  await flush(true);
  btn.disabled = false;
  if (syncState.status === 'synced') toast('Synced ✓');
  else if (syncState.status === 'offline' || !navigator.onLine) toast("You're offline — it will sync when the connection is back", true, 3500);
  else toast('Could not sync: ' + (syncState.lastError || 'no connection'), true);
});

// ---- "Last synced" / "Products updated" times ------------------------------------------------
/** 1794012345678 -> { when: "Today 10:42 PM", ago: "5 min ago" } */
function whenText(ts) {
  if (!ts) return { when: 'Never', ago: '' };
  const d = new Date(ts);
  const now = new Date();
  const dayStart = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((dayStart(now) - dayStart(d)) / 86400000);
  const time = d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' }).replace(/\s/g, ' ').toUpperCase();
  const day = days === 0 ? 'Today' : days === 1 ? 'Yesterday'
    : d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
  const mins = Math.floor((now - d) / 60000);
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.floor(mins / 60)} h ago` : `${Math.floor(mins / 1440)} d ago`;
  return { when: `${day} ${time}`, ago };
}
function showWhen(el, ts) {
  const { when, ago } = whenText(ts);
  el.replaceChildren(Object.assign(document.createElement('span'), { textContent: when }));
  if (ago) el.append(Object.assign(document.createElement('small'), { textContent: ago }));
}
function updateSyncTimes() {
  showWhen($('lastSyncInfo'), syncState.lastSyncAt);
  showWhen($('productsAtInfo'), syncState.productsAt);
}
// Keep the "x min ago" fresh while Settings is open.
setInterval(() => { if (!$('settingsSheet').hidden) updateSyncTimes(); }, 30000);

// ---- Receipts -------------------------------------------------------------------------------
$('reprintBtn').addEventListener('click', () => {
  const sale = lastSale();
  if (!sale) return toast('No sale to reprint yet', true);
  closeSheets();
  printReceipt(sale);
});
$('receiptSetBtn').addEventListener('click', () => {
  const s = receiptSettings;
  $('rsName').value = s.shopName; $('rsAddress').value = s.address; $('rsAddress2').value = s.address2 || ''; $('rsAbn').value = s.abn;
  $('rsPhone').value = s.phone; $('rsFooter').value = s.footer; $('rsPaper').value = s.paper;
  $('rsDrawer').checked = !!s.drawerEnabled; $('rsDrawerCash').checked = !!s.drawerOnCash;
  $('rsDrawerMethod').value = s.drawerMethod || 'print';
  updateDrawerMethodHint();
  openSheet('receiptSheet');
});
function readReceiptForm() {
  Object.assign(receiptSettings, {
    shopName: $('rsName').value.trim(), address: $('rsAddress').value.trim(), address2: $('rsAddress2').value.trim(), abn: $('rsAbn').value.trim(),
    phone: $('rsPhone').value.trim(), footer: $('rsFooter').value.trim(), paper: $('rsPaper').value,
    drawerEnabled: $('rsDrawer').checked, drawerOnCash: $('rsDrawerCash').checked,
    drawerMethod: $('rsDrawerMethod').value,
  });
  saveReceiptSettings();
  updateDrawerButton();
}

// ---- Cash drawer ----------------------------------------------------------------------------
function updateDrawerButton() { $('drawerBtn').hidden = !receiptSettings.drawerEnabled; }

function drawerErrorText(err) {
  return `Drawer didn't open: ${err.message}. Start "Start Pocket POS Drawer" on this PC, or use the drawer key.`;
}

async function noSale() {
  if (!receiptSettings.drawerEnabled) return;
  if (anySheetOpen()) closeSheets();
  const how = await openDrawer('NO SALE', null, { onError: (err) => toast(drawerErrorText(err), true, 4500) });
  if (how === 'helper') toast('Drawer opened');
}
$('drawerBtn').addEventListener('click', noSale);

$('testDrawerBtn').addEventListener('click', async () => {
  readReceiptForm();
  const how = await openDrawer('DRAWER TEST', null, { onError: (err) => toast(drawerErrorText(err), true, 4500) });
  if (how === 'helper') toast('Sent "open drawer" to the printer');
});

$('checkHelperBtn').addEventListener('click', async () => {
  try {
    const s = await checkHelper();
    toast(`Drawer Helper is running · printer: ${s.printer || '(none)'}`);
  } catch (err) { toast(err.message, true, 4500); }
});

function updateDrawerMethodHint() {
  const helper = $('rsDrawerMethod').value === 'helper';
  $('drawerMethodHint').textContent = helper
    ? 'Windows PC only: download the helper below, run "Start Pocket POS Drawer", then tap Check. Nothing prints when the drawer opens.'
    : 'Needs the printer driver option "Open drawer before printing" turned on. Prints a short slip each time.';
  $('helperDownload').hidden = !helper;
  $('checkHelperBtn').hidden = !helper;
}
$('rsDrawerMethod').addEventListener('change', updateDrawerMethodHint);
// F9 opens the drawer from the keyboard (handy next to a USB scanner).
document.addEventListener('keydown', (e) => { if (e.key === 'F9') { e.preventDefault(); noSale(); } });
$('receiptSheet').addEventListener('submit', (e) => { e.preventDefault(); readReceiptForm(); closeSheets(); publishCart(); toast('Receipt settings saved'); });
$('testPrintBtn').addEventListener('click', () => {
  readReceiptForm();
  const sale = sampleSale();
  sale.gst = settings.gstEnabled ? sale.gst : 0;
  printReceipt(sale);
});
$('restartCamBtn').addEventListener('click', async () => {
  closeSheets();
  if (settings.cameraEnabled) await scanner.restart().catch(() => {});
  startCamera();
});
let logoutArmed = null;
$('logoutBtn').addEventListener('click', async () => {
  const btn = $('logoutBtn');
  // Unsynced sales: ask for a second tap. They are kept and sent after the next login.
  if (syncState.pending && !logoutArmed) {
    btn.textContent = `${syncState.pending} not synced yet — tap again to log out`;
    logoutArmed = setTimeout(() => { logoutArmed = null; btn.textContent = 'Log out'; }, 4000);
    return;
  }
  clearTimeout(logoutArmed);
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  localStorage.removeItem('pos_authed');
  localStorage.removeItem('pos_last_sale_v1');          // last receipt
  await clearLocalProducts().catch(() => {});           // product list incl. cost prices
  closeSheets();
  if (scanner) scanner.stopCamera();
  location.reload();
});

function updateProductInfo(n) {
  $('productInfo').textContent = `${n.toLocaleString('en-AU')} products on this device · decoder: ${scanner ? scanner.engine : '—'}`
    + (demoMode ? ' · DEMO MODE' : '');
}

// ---- Sync indicator ---------------------------------------------------------------------------
let lastRejectedShown = 0;
onSyncChange((s) => {
  if ($('lastSyncInfo')) updateSyncTimes();
  if (s.lastRejected && s.rejectedCount !== lastRejectedShown) {
    lastRejectedShown = s.rejectedCount;
    toast(`${s.lastRejected} record(s) were refused by the server and kept on this device`, true, 5000);
  }
  // Settings > Products & sync status line
  $('syncInfo').textContent = s.status === 'synced' ? '✓ Everything is saved to the Google Sheet'
    : s.status === 'offline' ? `Offline · ${s.pending} change${s.pending === 1 ? '' : 's'} waiting to sync`
    : s.status === 'error' ? `${s.pending} waiting · retrying${s.lastError ? ' (' + s.lastError + ')' : ''}`
    : `${s.pending} change${s.pending === 1 ? '' : 's'} syncing…`;
  renderBadge(s);
});

// Home screen badge (top-left): Online / Offline. It follows the real connection, so it says
// Offline as soon as Wi-Fi drops, even when nothing is waiting to sync.
function renderBadge(s) {
  const offline = !navigator.onLine || s.status === 'offline';
  const badge = $('syncBadge');
  badge.className = 'badge ' + (offline ? 'offline' : s.status === 'synced' ? '' : s.status === 'error' ? 'error' : 'pending');
  $('syncText').textContent =
    offline ? (s.pending ? `Offline · ${s.pending} pending` : 'Offline')
    : s.status === 'synced' ? 'Online'
    : s.status === 'error' ? `${s.pending} pending · retrying`
    : `${s.pending} pending`;
}
window.addEventListener('online', () => renderBadge(syncState));
window.addEventListener('offline', () => renderBadge(syncState));

// =============================================================================================
// Helpers
// =============================================================================================
const pad = (n) => String(n).padStart(2, '0');
/** "2026-11-07 14:05:09" in the phone's local time (Google Sheets reads this as a date). */
function localDateTime(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function makeSaleId(d = new Date()) {
  const ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => ABC[b % ABC.length]).join('');
  return `S${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rand}`;
}

boot();
