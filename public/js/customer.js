// customer.js — the Customer Display window (customer.html).
// Shows what the POS window broadcasts: the cart while scanning, "Thank you + change" after a
// sale, and a welcome screen when idle. It only displays; it can't change anything.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const THANKS_MS = 10000;   // how long "Thank you / Change" stays up

let thanksTimer = null;
let lastStateAt = 0;

function show(id) {
  for (const s of ['idle', 'live', 'thanks']) $(s).hidden = s !== id;
}

function renderState(st) {
  lastStateAt = Date.now();
  $('noLink').hidden = true;
  $('idleShop').textContent = st.shop || 'Welcome';
  $('shop').textContent = st.shop || '';
  // A new sale started while "Thank you" is showing: switch straight back to the cart.
  if (st.lines.length && !$('thanks').hidden) { clearTimeout(thanksTimer); thanksTimer = null; }
  if (thanksTimer) return;
  if (!st.lines.length) { show('idle'); return; }

  $('items').innerHTML = st.lines.map((l) => `
    <li class="${l.key === st.highlight ? 'new' : ''}">
      <span class="name">${esc(l.name)}</span>
      <span class="c">${l.qty}</span>
      <span class="r">${esc(l.unit)}${l.was ? `<s>${esc(l.was)}</s>` : ''}</span>
      <span class="r strong">${esc(l.total)}</span>
    </li>`).join('');
  $('count').textContent = `${st.count} item${st.count === 1 ? '' : 's'}`;
  $('total').textContent = st.total;
  $('gst').textContent = st.gstText || '';
  show('live');
  $('items').scrollTop = 0;   // newest item is at the top
}

function renderSale(s) {
  $('tTotal').textContent = s.total;
  $('tPaidRow').hidden = !s.paid;
  $('tPaidLabel').textContent = s.payment === 'Cash' ? 'Cash' : `Paid by ${s.payment}`;
  $('tPaid').textContent = s.paid || '';
  $('tChangeRow').hidden = !s.change;
  $('tChange').textContent = s.change || '';
  show('thanks');
  clearTimeout(thanksTimer);
  thanksTimer = setTimeout(() => { thanksTimer = null; show('idle'); }, THANKS_MS);
}

if ('BroadcastChannel' in window) {
  const ch = new BroadcastChannel('pocketpos-display');
  ch.onmessage = (e) => {
    const m = e.data || {};
    if (m.type === 'state') renderState(m);
    else if (m.type === 'sale') renderSale(m);
  };
  ch.postMessage({ type: 'hello' });            // ask the POS for the current cart
  // If no POS answers, say so (helps when this page is opened on its own).
  setTimeout(() => { if (!lastStateAt) $('noLink').hidden = false; }, 2500);
} else {
  $('noLink').hidden = false;
  $('noLink').textContent = 'This browser cannot link to Pocket POS. Use Chrome or Edge.';
}

// Full screen needs one click in this window (browser rule).
function goFullscreen() {
  if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
}
document.addEventListener('click', goFullscreen);
document.addEventListener('fullscreenchange', () => { $('fsHint').hidden = !!document.fullscreenElement; });
if (!document.documentElement.requestFullscreen) $('fsHint').hidden = true;
