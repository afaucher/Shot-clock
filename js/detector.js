// Shot detection core. Pure logic, no DOM: feed it RGBA pixels of the
// region-of-interest (the gap between spout and cup) once per frame.
//
// Pipeline per frame:
//   1. Background subtraction against a model captured while "armed"
//      -> which pixels are espresso stream right now (mask, coverage).
//   2. Flow present/absent with hold times -> start / end events.
//   3. Mean colour of stream pixels -> CIELAB, smoothed over time.
//   4. Blonding = "paleness" (L* minus chroma) rising a set amount above
//      the lowest paleness seen in this shot. Dark red-brown, caramel and
//      orange are all saturated, so paleness stays flat through them even
//      though lightness climbs a lot; blonde is the only phase that is both
//      light AND washed-out. Being relative to the shot itself makes it
//      tolerant of camera white balance / lighting differences.

export const DEFAULTS = {
  pixelThreshold: 40,   // RGB distance from background to count as stream
  flowCoverage: 0.04,   // fraction of ROI pixels that must be stream = "flowing"
  dripCoverage: 0.004,  // fainter sign of liquid (single drips) used to backdate start
  dripLookbackMs: 4000, // how far back a drip may backdate the timer
  startHoldMs: 250,     // flow must persist this long to count as started
  endHoldMs: 1500,      // flow absent this long = shot over
  settleMs: 1500,       // ignore colour for this long after first flow (drips)
  smoothingMs: 400,     // EMA time constant for colour
  blondeDelta: 25,      // paleness rise above the shot's minimum = blonde
  blondeHoldMs: 400,    // must stay blonde this long before alerting
  bgAdapt: 0.03,        // background learning rate while armed and idle
  calibFrames: 10,      // frames averaged to build the initial background
  minStreamPixels: 12,  // need at least this many stream pixels to read colour
};

// ---- colour helpers -------------------------------------------------------

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linToSrgb8(v) {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
}

// Linear sRGB (0..1) -> CIELAB (D65)
export function linearRgbToLab(r, g, b) {
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const Z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  const L = 116 * fy - 16, A = 500 * (fx - fy), B = 200 * (fy - fz);
  const C = Math.hypot(A, B);
  return { L, a: A, b: B, C, h: (Math.atan2(B, A) * 180 / Math.PI + 360) % 360, P: L - C };
}

export function srgb8ToLab(r, g, b) {
  return linearRgbToLab(LIN[r], LIN[g], LIN[b]);
}

// ---- detector -------------------------------------------------------------

export class ShotDetector {
  constructor(opts = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    this.reset();
  }

  setOptions(opts) { Object.assign(this.opts, opts); }

  reset() {
    this.state = 'idle';      // idle | calibrating | armed | pouring | done
    this.bg = null;           // Float32Array RGB background model
    this.bgW = 0; this.bgH = 0;
    this.calibCount = 0;
    this.mask = null;
    this._clearShot();
  }

  _clearShot() {
    this.t0 = null;           // timer start (s)
    this.tEnd = null;         // timer end (s)
    this.tFlowFirst = null;   // first frame stream seen
    this.tFlowLast = null;    // last frame stream seen
    this.flowSince = null;    // candidate start of continuous flow
    this.firstSign = null;    // first faint drip seen while armed
    this.lastSign = null;
    this.flowConfirmed = false;
    this.externalStart = false;
    this.smooth = null;       // smoothed linear RGB {r,g,b}
    this.smoothLab = null;
    this.refP = null;         // lowest smoothed paleness after settling
    this.blondeSince = null;
    this.blondeAt = null;     // elapsed seconds at blonde alert
    this.lastT = null;
    this.samples = [];        // [{t, L, C, h, P, rgb:[r,g,b], coverage}]
  }

  // Begin calibrating the background. Call when nothing is pouring.
  arm() {
    this.reset();
    this.state = 'calibrating';
  }

  // Start the timer from an external trigger (e.g. pump sound) before the
  // first drop is visible. Colour tracking still waits for visible flow.
  externalTrigger(t) {
    if (this.state !== 'armed') return false;
    this.state = 'pouring';
    this.t0 = t;
    this.externalStart = true;
    return true;
  }

  elapsed(t) {
    if (this.t0 == null) return 0;
    if (this.tEnd != null) return this.tEnd - this.t0;
    return Math.max(0, t - this.t0);
  }

  // pixels: RGBA Uint8ClampedArray (w*h*4); t: seconds (monotonic)
  process(pixels, w, h, t) {
    const o = this.opts;
    const n = w * h;
    const events = [];

    if (!this.bg || this.bgW !== w || this.bgH !== h) {
      if (this.state !== 'calibrating' && this.state !== 'idle') {
        // ROI changed mid-shot: start over.
        this.arm();
      }
      this.bg = new Float32Array(n * 3);
      this.bgW = w; this.bgH = h;
      this.calibCount = 0;
      this.mask = new Uint8Array(n);
    }

    if (this.state === 'idle') return this._result(t, 0, null, events);

    if (this.state === 'calibrating') {
      const k = this.calibCount;
      for (let i = 0, j = 0; i < n; i++, j += 3) {
        const p = i * 4;
        this.bg[j] = (this.bg[j] * k + pixels[p]) / (k + 1);
        this.bg[j + 1] = (this.bg[j + 1] * k + pixels[p + 1]) / (k + 1);
        this.bg[j + 2] = (this.bg[j + 2] * k + pixels[p + 2]) / (k + 1);
      }
      this.calibCount++;
      if (this.calibCount >= o.calibFrames) {
        this.state = 'armed';
        events.push({ type: 'armed', t });
      }
      return this._result(t, 0, null, events);
    }

    // --- background subtraction -> mask
    const th2 = o.pixelThreshold * o.pixelThreshold;
    let count = 0, lr = 0, lg = 0, lb = 0;
    const mask = this.mask, bg = this.bg;
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const p = i * 4;
      const r = pixels[p], g = pixels[p + 1], b = pixels[p + 2];
      const dr = r - bg[j], dg = g - bg[j + 1], db = b - bg[j + 2];
      if (dr * dr + dg * dg + db * db > th2) {
        mask[i] = 1; count++;
        lr += LIN[r]; lg += LIN[g]; lb += LIN[b];
      } else {
        mask[i] = 0;
      }
    }
    const coverage = count / n;
    const flowNow = coverage >= o.flowCoverage && count >= o.minStreamPixels;
    const signNow = coverage >= o.dripCoverage && count >= Math.ceil(o.minStreamPixels / 2);
    const mean = count >= o.minStreamPixels ? { r: lr / count, g: lg / count, b: lb / count } : null;

    // Slowly follow lighting drift while waiting for a shot.
    if (this.state === 'armed' && !flowNow) {
      const a = o.bgAdapt;
      for (let i = 0, j = 0; i < n; i++, j += 3) {
        if (mask[i]) continue;
        const p = i * 4;
        bg[j] += (pixels[p] - bg[j]) * a;
        bg[j + 1] += (pixels[p + 1] - bg[j + 1]) * a;
        bg[j + 2] += (pixels[p + 2] - bg[j + 2]) * a;
      }
    }

    // --- flow start / end
    if (signNow) {
      // forget an old isolated blip (noise, a hand passing) after 2 s
      if (this.state === 'armed' && (this.firstSign == null || t - this.lastSign > 2)) this.firstSign = t;
      this.lastSign = t;
    }
    if (flowNow) {
      if (this.flowSince == null) this.flowSince = t;
      this.tFlowLast = t;
    } else {
      this.flowSince = null;
    }

    if (this.state === 'armed' || (this.state === 'pouring' && !this.flowConfirmed)) {
      if (this.flowSince != null && (t - this.flowSince) * 1000 >= o.startHoldMs) {
        this.flowConfirmed = true;
        this.tFlowFirst = this.flowSince;
        if (this.state === 'armed') {
          this.state = 'pouring';
          // backdate to the first drip if it led into this flow
          const drip = this.firstSign != null && (this.flowSince - this.firstSign) * 1000 <= o.dripLookbackMs
            ? this.firstSign : this.flowSince;
          this.t0 = Math.min(drip, this.flowSince);
          events.push({ type: 'start', t: this.t0, elapsed: 0 });
        } else {
          events.push({ type: 'flow', t: this.tFlowFirst, elapsed: this.tFlowFirst - this.t0 });
        }
      }
    }

    if (this.state === 'pouring' && this.flowConfirmed && !flowNow &&
        this.tFlowLast != null && (t - this.tFlowLast) * 1000 >= o.endHoldMs) {
      this.state = 'done';
      // include the trailing drips as the stream breaks up
      this.tEnd = Math.max(this.tFlowLast, this.lastSign ?? 0);
      events.push({ type: 'end', t: this.tEnd, elapsed: this.tEnd - this.t0 });
    }

    // --- colour tracking
    if (this.state === 'pouring' && this.flowConfirmed && flowNow && mean) {
      const dt = this.lastT == null ? 0 : Math.max(0, t - this.lastT);
      if (!this.smooth) {
        this.smooth = { ...mean };
      } else {
        const a = 1 - Math.exp(-dt * 1000 / o.smoothingMs);
        this.smooth.r += (mean.r - this.smooth.r) * a;
        this.smooth.g += (mean.g - this.smooth.g) * a;
        this.smooth.b += (mean.b - this.smooth.b) * a;
      }
      this.lastT = t;
      const lab = linearRgbToLab(this.smooth.r, this.smooth.g, this.smooth.b);
      this.smoothLab = lab;

      const sinceFlow = (t - this.tFlowFirst) * 1000;
      if (sinceFlow >= o.settleMs) {
        if (this.refP == null || lab.P < this.refP) this.refP = lab.P;
        const progress = (lab.P - this.refP) / o.blondeDelta;
        if (this.blondeAt == null) {
          if (progress >= 1) {
            if (this.blondeSince == null) this.blondeSince = t;
            if ((t - this.blondeSince) * 1000 >= o.blondeHoldMs) {
              this.blondeAt = this.blondeSince - this.t0;
              events.push({ type: 'blonde', t, elapsed: this.blondeAt });
            }
          } else {
            this.blondeSince = null;
          }
        }
      }
      this.samples.push({
        t: t - this.t0, L: lab.L, C: lab.C, h: lab.h, P: lab.P, coverage,
        rgb: [linToSrgb8(mean.r), linToSrgb8(mean.g), linToSrgb8(mean.b)],
      });
    }

    return this._result(t, coverage, mean, events);
  }

  progress() {
    if (this.refP == null || !this.smoothLab) return 0;
    return Math.max(0, (this.smoothLab.P - this.refP) / this.opts.blondeDelta);
  }

  phase() {
    if (this.state === 'idle') return 'Idle';
    if (this.state === 'calibrating') return 'Calibrating';
    if (this.state === 'armed') return 'Ready';
    if (this.state === 'done') return 'Done';
    if (!this.flowConfirmed) return 'Pre-infusion';
    if (this.refP == null) return 'First drips';
    if (this.blondeAt != null) return 'Blonde';
    if (this.progress() >= 0.6) return 'Turning pale';
    return this.smoothLab && this.smoothLab.L < 38 ? 'Dark' : 'Caramel';
  }

  _result(t, coverage, mean, events) {
    return {
      state: this.state,
      phase: this.phase(),
      elapsed: this.elapsed(t),
      coverage,
      rgb: mean ? [linToSrgb8(mean.r), linToSrgb8(mean.g), linToSrgb8(mean.b)] : null,
      lab: this.smoothLab,
      refP: this.refP,
      progress: this.progress(),
      blondeAt: this.blondeAt,
      events,
    };
  }
}
