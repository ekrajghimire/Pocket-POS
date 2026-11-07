// scanner.js — the speed-critical part.
//
// How it works:
//  1. Open the rear camera ONCE at 1280x720 and keep the stream alive for the whole session.
//  2. On every new video frame (~30 fps) copy ONLY the centred "region of interest" (the box
//     you see on screen) into a small canvas.
//  3. Decode that crop with the native BarcodeDetector (fast, hardware-accelerated on Android
//     and macOS Chrome) or, if it's missing (e.g. iPhone Safari), with ZXing running in a Web
//     Worker so the UI never stutters.
//  4. Call onDetect(code, format). Debouncing and cart logic live in app.js.

// Only the formats a shop needs. Fewer formats = faster decoding.
const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'];

// Largest crop we decode (in video pixels). Bigger is slower; 1D barcodes need ~2px per bar.
const MAX_CROP_WIDTH = 960;

export class Scanner {
  /**
   * @param {object} opts
   * @param {HTMLVideoElement} opts.video
   * @param {HTMLElement} opts.roiEl   the on-screen ROI box (we read its position)
   * @param {(code:string, format:string)=>void} opts.onDetect
   */
  constructor({ video, roiEl, onDetect }) {
    this.video = video;
    this.roiEl = roiEl;
    this.onDetect = onDetect;
    this.stream = null;
    this.track = null;
    this.running = false;
    this.paused = false;
    this.busy = false;
    this.lastDecodeAt = 0;
    this.minInterval = 33;            // ms between decodes (~30 fps)
    this.engine = 'none';             // 'native' | 'zxing'
    this.detector = null;
    this.worker = null;
    this.workerSeq = 0;
    this.workerWaiters = new Map();
    this.crop = null;                 // {sx, sy, sw, sh} in video pixels
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true, alpha: false });
    this.code39Candidate = null;      // Code 39 has no checksum, so we require 2 matching reads

    // Recompute the crop rectangle whenever layout changes.
    this._onResize = () => this.computeCrop();
    window.addEventListener('resize', this._onResize);
    video.addEventListener('loadedmetadata', this._onResize);
  }

  /** Open the camera (if not already open), pick a decoder and start the loop. */
  async start() {
    if (!this.detector && !this.worker) await this.initDecoder();
    await this.openCamera();
    if (!this.running) {
      this.running = true;
      this.scheduleNext();
    }
  }

  async openCamera() {
    if (this.track && this.track.readyState === 'live') return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },   // rear camera
        width: { ideal: 1280 },                 // 720p: sharp enough, fast to process. No 4K.
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
    });
    this.track = this.stream.getVideoTracks()[0];
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});

    // Continuous autofocus where the browser lets us ask for it (mostly Android Chrome).
    const caps = this.capabilities();
    if (caps.focusMode && caps.focusMode.includes('continuous')) {
      await this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    }
    // If the OS kills the camera (e.g. app backgrounded on iOS), reopen it when we come back.
    this.track.addEventListener('ended', () => { this.track = null; });
    this.computeCrop();
  }

  /** Restart the camera only if it died (called when the app becomes visible again). */
  async ensureAlive() {
    if (!this.track || this.track.readyState !== 'live') {
      await this.openCamera();
    } else if (this.video.paused) {
      await this.video.play().catch(() => {});
    }
  }

  /** Force a full camera restart (Settings > Restart camera). */
  async restart() {
    this.stopCamera();
    await this.openCamera();
  }

  stopCamera() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
  }

  capabilities() {
    try { return (this.track && this.track.getCapabilities) ? this.track.getCapabilities() : {}; }
    catch { return {}; }
  }

  get torchSupported() { return !!this.capabilities().torch; }

  async setTorch(on) {
    if (!this.torchSupported) return false;
    await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
    return true;
  }

  /** Tap-to-focus. x,y are 0..1 relative to the video frame. Best effort: many phones ignore it. */
  async focusAt(x, y) {
    if (!this.track) return false;
    const caps = this.capabilities();
    const supported = navigator.mediaDevices.getSupportedConstraints ? navigator.mediaDevices.getSupportedConstraints() : {};
    const adv = {};
    if (supported.pointsOfInterest) adv.pointsOfInterest = [{ x, y }];
    if (caps.focusMode && caps.focusMode.includes('single-shot')) adv.focusMode = 'single-shot';
    else if (caps.focusMode && caps.focusMode.includes('continuous')) adv.focusMode = 'continuous';
    if (!Object.keys(adv).length) return false;
    try {
      await this.track.applyConstraints({ advanced: [adv] });
      if (adv.focusMode === 'single-shot' && caps.focusMode.includes('continuous')) {
        setTimeout(() => this.track && this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}), 2500);
      }
      return true;
    } catch { return false; }
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }

  /**
   * Work out which part of the video frame sits under the on-screen ROI box.
   * The <video> uses object-fit: cover, so it is scaled and centre-cropped; undo that maths.
   */
  computeCrop() {
    const v = this.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    const box = v.getBoundingClientRect();
    const roi = this.roiEl.getBoundingClientRect();
    const scale = Math.max(box.width / vw, box.height / vh);
    const offX = (box.width - vw * scale) / 2;
    const offY = (box.height - vh * scale) / 2;
    let sx = (roi.left - box.left - offX) / scale;
    let sy = (roi.top - box.top - offY) / scale;
    let sw = roi.width / scale;
    let sh = roi.height / scale;
    // Clamp to the frame.
    sx = Math.max(0, sx); sy = Math.max(0, sy);
    sw = Math.min(vw - sx, sw); sh = Math.min(vh - sy, sh);
    const outScale = Math.min(1, MAX_CROP_WIDTH / sw);
    this.crop = { sx: Math.round(sx), sy: Math.round(sy), sw: Math.round(sw), sh: Math.round(sh) };
    this.canvas.width = Math.round(sw * outScale);
    this.canvas.height = Math.round(sh * outScale);
  }

  /** Choose the fastest available decoder. */
  async initDecoder() {
    if ('BarcodeDetector' in window) {
      try {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        const formats = NATIVE_FORMATS.filter((f) => supported.includes(f));
        if (formats.length) {
          this.detector = new window.BarcodeDetector({ formats });
          this.engine = 'native';
          this.minInterval = 33;
          return;
        }
      } catch { /* fall through to ZXing */ }
    }
    // Fallback: ZXing in a worker (loads /vendor/zxing.min.js, or the CDN copy).
    this.worker = new Worker('/js/zxing-worker.js');
    this.worker.onmessage = (e) => {
      const waiter = this.workerWaiters.get(e.data.id);
      if (waiter) { this.workerWaiters.delete(e.data.id); waiter(e.data); }
    };
    this.engine = 'zxing';
    this.minInterval = 50; // ~20 fps is plenty for the software decoder
  }

  scheduleNext() {
    if (!this.running) return;
    // requestVideoFrameCallback fires once per *new* camera frame (no wasted decodes).
    if (this.video.requestVideoFrameCallback) this.video.requestVideoFrameCallback(() => this.tick());
    else requestAnimationFrame(() => this.tick());
  }

  async tick() {
    const now = performance.now();
    if (!this.paused && !this.busy && this.video.readyState >= 2 && now - this.lastDecodeAt >= this.minInterval) {
      this.lastDecodeAt = now;
      this.busy = true;
      try {
        const hit = await this.decodeFrame();
        if (hit && !this.paused) this.accept(hit.text, hit.format);
      } catch (err) {
        // A failed frame is normal; just log unexpected errors once in a while.
        if (Math.random() < 0.01) console.warn('decode error', err);
      } finally {
        this.busy = false;
      }
    }
    this.scheduleNext();
  }

  accept(text, format) {
    // Code 39 has no check digit, so a single read can be wrong. Require two identical reads.
    if (format === 'code_39') {
      if (this.code39Candidate !== text) { this.code39Candidate = text; return; }
      this.code39Candidate = null;
    }
    this.onDetect(text, format);
  }

  /** Grab the ROI from the current frame and decode it. Returns {text, format} or null. */
  async decodeFrame() {
    if (!this.crop) this.computeCrop();
    if (!this.crop) return null;
    const { sx, sy, sw, sh } = this.crop;
    const { width, height } = this.canvas;
    this.ctx.drawImage(this.video, sx, sy, sw, sh, 0, 0, width, height);

    if (this.engine === 'native') {
      const found = await this.detector.detect(this.canvas);
      if (!found.length) return null;
      return { text: found[0].rawValue, format: found[0].format };
    }

    // ZXing worker: send raw pixels (transferred, not copied).
    const img = this.ctx.getImageData(0, 0, width, height);
    const id = ++this.workerSeq;
    const result = await new Promise((resolve) => {
      this.workerWaiters.set(id, resolve);
      this.worker.postMessage({ id, width, height, buffer: img.data.buffer }, [img.data.buffer]);
    });
    if (result.error) throw new Error(result.error);
    return result.text ? { text: result.text, format: result.format } : null;
  }

  /** Debug helper: returns the current ROI crop as a data URL (used by tests). */
  snapshotROI() { return this.canvas.toDataURL('image/png'); }
}
