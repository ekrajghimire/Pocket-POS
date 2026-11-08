// zxing-worker.js — software barcode decoder used when the browser has no native
// BarcodeDetector (e.g. iPhone Safari). Runs off the main thread so the UI stays smooth.

// Loaded from our own domain only (copied from node_modules at build time by
// scripts/copy-vendor.js). No CDN: the security policy only allows our own scripts.
const LOCAL = '/vendor/zxing.min.js';

let ZX = null;
let reader = null;
let loadError = null;

try {
  importScripts(LOCAL);
  ZX = self.ZXing;
  const F = ZX.BarcodeFormat;
  const hints = new Map();
  // Restricting formats is the biggest speed win for ZXing.
  hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, [
    F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.QR_CODE,
  ]);
  reader = new ZX.MultiFormatReader();
  reader.setHints(hints);
} catch (err) {
  loadError = 'Could not load the ZXing decoder: ' + (err && err.message);
}

self.onmessage = (e) => {
  const { id, width, height, buffer } = e.data;
  if (loadError) { self.postMessage({ id, error: loadError }); return; }

  // Convert RGBA -> 8-bit luminance (fast integer approximation of 0.3R + 0.59G + 0.11B).
  const rgba = new Uint8ClampedArray(buffer);
  const lum = new Uint8ClampedArray(width * height);
  for (let i = 0, j = 0; j < lum.length; i += 4, j++) {
    lum[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }

  try {
    const source = new ZX.RGBLuminanceSource(lum, width, height);
    const bitmap = new ZX.BinaryBitmap(new ZX.HybridBinarizer(source));
    const result = reader.decodeWithState(bitmap);
    // Match native BarcodeDetector naming: EAN_13 -> ean_13, QR_CODE -> qr_code
    const format = String(ZX.BarcodeFormat[result.getBarcodeFormat()] || '').toLowerCase();
    self.postMessage({ id, text: result.getText(), format });
  } catch {
    self.postMessage({ id, text: null }); // NotFoundException etc. = nothing in this frame
  } finally {
    reader.reset();
  }
};
