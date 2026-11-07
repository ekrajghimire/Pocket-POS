// app.js — wires everything together: login, scanner -> cart, bottom sheets, checkout, settings.

import { Scanner } from './scanner.js';
import { receiptSettings, saveReceiptSettings, printReceipt, rememberLastSale, lastSale, sampleSale, openDrawer } from './receipt.js';
import { unlockAudio, beepOk, beepUnknown, beepSale } from './feedback.js';
import {
  cart, settings, saveSettings, addProduct, addManual, updateLine, removeLine, clearCart,
  itemCount, totals, money, parseMoney, toDollars, roundCash,
} from './cart.js';
import {
  products, lookup, loadProductsFromCache, refreshProducts, saveProductLocally, categories,
  enqueue, flush, startSyncLoop, onSyncChange, setAuthLostHandler, api,
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
  const product = lookup(code);
  if (product) {
    const line = addProduct(product);
    beepOk();
    showFlash(product.name, line.unitCents);
    renderCart(true);
  } else {
    beepUnknown();
    flashROI('miss');
    openNewProduct(code);
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
}

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
const SHEETS = ['newProductSheet', 'editSheet', 'manualItemSheet', 'checkoutSheet', 'settingsSheet', 'receiptSheet'];
const anySheetOpen = () => SHEETS.some((id) => !$(id).hidden);

function openSheet(id) {
  SHEETS.forEach((s) => { $(s).hidden = s !== id; });
  $('sheetBackdrop').hidden = false;
  if (scanner) scanner.pause();   // never add items while a form is open
}

function closeSheets() {
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

// ---- New product -----------------------------------------------------------------------------
function openNewProduct(code) {
  const f = $('newProductSheet');
  f.reset();
  $('npBarcode').value = code;
  $('npError').textContent = '';
  $('categoryList').innerHTML = categories().map((c) => `<option value="${esc(c)}">`).join('');
  openSheet('newProductSheet');
  // Note: iOS only shows the keyboard for focus() inside a tap; Android shows it straight away.
  $('npName').focus();
}
$('npName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('npPrice').focus(); }
});
$('newProductSheet').addEventListener('submit', async (e) => {
  e.preventDefault();
  const barcode = $('npBarcode').value.trim();
  const name = $('npName').value.trim();
  const priceCents = parseMoney($('npPrice').value);
  if (!barcode) return ($('npError').textContent = 'Barcode is required');
  if (!name) { $('npError').textContent = 'Name is required'; return $('npName').focus(); }
  if (priceCents === null) { $('npError').textContent = 'Enter a price'; return $('npPrice').focus(); }

  const costCents = parseMoney($('npCost').value);
  const stockText = $('npStock').value.trim();
  const product = {
    barcode,
    name,
    price: toDollars(priceCents),
    cost: costCents === null ? null : toDollars(costCents),
    category: $('npCategory').value.trim(),
    stock: stockText === '' || isNaN(Number(stockText)) ? null : Number(stockText),
  };
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
  openSheet('editSheet');
}
$('editMinus').addEventListener('click', () => { $('editQty').value = Math.max(0, (parseInt($('editQty').value, 10) || 0) - 1); });
$('editPlus').addEventListener('click', () => { $('editQty').value = (parseInt($('editQty').value, 10) || 0) + 1; });
$('editRemove').addEventListener('click', () => { removeLine(editingKey); closeSheets(); renderCart(); });
$('editSheet').addEventListener('submit', (e) => {
  e.preventDefault();
  const qty = parseInt($('editQty').value, 10);
  const cents = parseMoney($('editPrice').value);
  const changes = {};
  if (!isNaN(qty)) changes.qty = qty;
  if (cents !== null) changes.unitCents = cents;   // price for THIS sale only; the product isn't changed
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
  if (cents === null) { $('miError').textContent = 'Enter a price'; return; }
  addManual($('miName').value.trim(), cents);
  closeSheets();
  renderCart(true);
});

// ---- Checkout -------------------------------------------------------------------------------
let payType = 'Cash';
$('checkoutBtn').addEventListener('click', () => {
  if (!cart.lines.length) return;
  const t = totals();
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
  const received = parseMoney($('cashIn').value);
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
    const received = parseMoney($('cashIn').value);
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
  beepSale();
  toast(change !== null ? `Sale saved · Change ${money(Math.round(change * 100))}` : 'Sale saved', false, 3500);
  const popDrawer = payType === 'Cash' && receiptSettings.drawerEnabled && receiptSettings.drawerOnCash;
  if (wantPrint) printReceipt(sale);            // printing a receipt also opens the drawer (printer driver)
  else if (popDrawer) openDrawer('CASH SALE', sale);
});

// ---- Settings -------------------------------------------------------------------------------
$('menuBtn').addEventListener('click', () => {
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
$('syncNowBtn').addEventListener('click', () => flush());

// ---- Receipts -------------------------------------------------------------------------------
$('reprintBtn').addEventListener('click', () => {
  const sale = lastSale();
  if (!sale) return toast('No sale to reprint yet', true);
  closeSheets();
  printReceipt(sale);
});
$('receiptSetBtn').addEventListener('click', () => {
  const s = receiptSettings;
  $('rsName').value = s.shopName; $('rsAddress').value = s.address; $('rsAbn').value = s.abn;
  $('rsPhone').value = s.phone; $('rsFooter').value = s.footer; $('rsPaper').value = s.paper;
  $('rsDrawer').checked = !!s.drawerEnabled; $('rsDrawerCash').checked = !!s.drawerOnCash;
  openSheet('receiptSheet');
});
function readReceiptForm() {
  Object.assign(receiptSettings, {
    shopName: $('rsName').value.trim(), address: $('rsAddress').value.trim(), abn: $('rsAbn').value.trim(),
    phone: $('rsPhone').value.trim(), footer: $('rsFooter').value.trim(), paper: $('rsPaper').value,
    drawerEnabled: $('rsDrawer').checked, drawerOnCash: $('rsDrawerCash').checked,
  });
  saveReceiptSettings();
  updateDrawerButton();
}

// ---- Cash drawer ----------------------------------------------------------------------------
function updateDrawerButton() { $('drawerBtn').hidden = !receiptSettings.drawerEnabled; }
function noSale() {
  if (!receiptSettings.drawerEnabled) return;
  if (anySheetOpen()) closeSheets();
  openDrawer('NO SALE');
}
$('drawerBtn').addEventListener('click', noSale);
$('testDrawerBtn').addEventListener('click', () => { readReceiptForm(); openDrawer('DRAWER TEST'); });
// F9 opens the drawer from the keyboard (handy next to a USB scanner).
document.addEventListener('keydown', (e) => { if (e.key === 'F9') { e.preventDefault(); noSale(); } });
$('receiptSheet').addEventListener('submit', (e) => { e.preventDefault(); readReceiptForm(); closeSheets(); toast('Receipt settings saved'); });
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
$('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  localStorage.removeItem('pos_authed');
  closeSheets();
  if (scanner) scanner.stopCamera();
  location.reload();
});

function updateProductInfo(n) {
  $('productInfo').textContent = `${n.toLocaleString('en-AU')} products on this phone · decoder: ${scanner ? scanner.engine : '—'}`
    + (demoMode ? ' · DEMO MODE' : '');
}

// ---- Sync indicator ---------------------------------------------------------------------------
onSyncChange((s) => {
  const badge = $('syncBadge');
  badge.className = 'badge ' + (s.status === 'synced' ? '' : s.status === 'offline' ? 'offline' : s.status === 'error' ? 'error' : 'pending');
  $('syncText').textContent =
    s.status === 'synced' ? 'Synced'
    : s.status === 'offline' ? `Offline · ${s.pending} pending`
    : s.status === 'error' ? `${s.pending} pending · retrying`
    : `${s.pending} pending`;
});

// =============================================================================================
// Helpers
// =============================================================================================
const pad = (n) => String(n).padStart(2, '0');
/** "2026-11-07 14:05:09" in the phone's local time (Google Sheets reads this as a date). */
function localDateTime(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function makeSaleId(d = new Date()) {
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `S${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rand}`;
}

boot();
