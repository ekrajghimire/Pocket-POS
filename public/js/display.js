// display.js — POS side of the Customer Display.
//
// The customer display is a second window (customer.html), usually full-screen on a second
// monitor facing the customer. The POS window sends it the cart over a BroadcastChannel:
// instant, works offline, no server involved. Both windows must be in the same browser on
// the same computer.

const channel = 'BroadcastChannel' in window ? new BroadcastChannel('pocketpos-display') : null;
let getState = () => null;       // set by app.js: returns the current cart snapshot
let customerWin = null;

/** app.js tells us how to build the current cart snapshot. */
export function setStateProvider(fn) { getState = fn; }

/** Send the current cart (call after every change). */
export function publishCart(highlightKey = null) {
  if (!channel) return;
  const state = getState();
  if (state) channel.postMessage({ type: 'state', ...state, highlight: highlightKey });
}

/** Tell the display a sale finished (shows "Thank you" and the change). */
export function publishSale(info) {
  if (channel) channel.postMessage({ type: 'sale', ...info });
}

// When the customer display opens (or reloads) it says hello; reply with the current cart.
if (channel) {
  channel.addEventListener('message', (e) => { if (e.data && e.data.type === 'hello') publishCart(); });
}

/**
 * Open the customer display. On Chrome/Edge with two monitors it asks permission once to
 * "manage windows on all your displays", then opens straight onto the other screen.
 */
export async function openCustomerDisplay() {
  let features = 'popup,width=1024,height=640';
  try {
    if ('getScreenDetails' in window) {
      const details = await window.getScreenDetails();
      const other = details.screens.find((s) => s !== details.currentScreen);
      if (other) {
        features = `popup,left=${other.availLeft},top=${other.availTop},width=${other.availWidth},height=${other.availHeight}`;
      }
    }
  } catch { /* permission refused or not supported: open a normal window to drag across */ }

  if (customerWin && !customerWin.closed) { customerWin.focus(); return 'focused'; }
  customerWin = window.open('/customer.html', 'pocketpos-customer', features);
  return customerWin ? 'opened' : 'blocked';
}
