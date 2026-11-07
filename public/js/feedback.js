// feedback.js — beep + vibration after a scan.
// Browsers only allow audio after a user tap, so call unlockAudio() from a tap handler
// (we do it on login and on the first touch anywhere).

let ctx = null;

export function unlockAudio() {
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch { /* no audio available */ }
}

function tone(freq, ms, when = 0, volume = 0.25) {
  if (!ctx) return;
  const t = ctx.currentTime + when;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + ms / 1000 + 0.02);
}

/** Short high beep: product found and added. */
export function beepOk() {
  tone(2200, 70);
  if (navigator.vibrate) navigator.vibrate(40);
}

/** Two low beeps: barcode not in the database. */
export function beepUnknown() {
  tone(600, 90);
  tone(450, 120, 0.12);
  if (navigator.vibrate) navigator.vibrate([60, 60, 60]);
}

/** Sale completed. */
export function beepSale() {
  tone(1500, 80);
  tone(2200, 120, 0.1);
  if (navigator.vibrate) navigator.vibrate(80);
}
