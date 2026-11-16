// Live stream tracker: finds and follows espresso streams in a (possibly
// hand-held) camera feed, starts the shot clock at the first liquid, samples
// each stream's colour, and watches for blonding.
//
// Port of research/track_streams.py. Pass in an initialised OpenCV.js `cv`
// object, so the same code runs in the browser and in Node (tools/track.mjs).
//
// Per frame (RGBA at working resolution, ~270 px wide):
//   1. Register to a reference frame taken at arm() (KLT + similarity/RANSAC),
//      so camera shake is cancelled without drift.
//   2. Thin vertical line map in Lab (either polarity).
//   3. "New lines" = line map minus the reference line map dilated by a few px:
//      edges that were there before the shot cancel even under parallax.
//   4. Persistence -> connected components (tall, thin) -> detections.
//   5. Flow score: frame-to-frame change inside a detection vs a ring around
//      it. Falling coffee keeps changing; reflections/edges only move with the
//      camera. Only "flowing" tracks become streams.
//   6. Shot start: a stream that stays present (10 of last 15 frames) for 2 s
//      starts the clock, backdated to its first appearance.
//   7. Colour per stream, blonding relative to each stream's own baseline.

export const TRACKER_DEFAULTS = {
  width: 270,            // working width (px)
  refLearnS: 1.0,        // learn the reference line map for this long after arm()
  newThreshold: 3.0,     // persistence threshold for "new line" evidence
  flowMin: 1.4,          // median flow score for a track to count as liquid
  confirmS: 2.0,         // a stream must stay present this long to start the clock
  lookbackS: 3.0,        // max backdating before the present-run start
  endS: 2.0,             // no flowing stream for this long = shot over
  settleS: 2.0,          // ignore colour for blonding baseline in the first seconds
  smoothS: 1.0,          // median window for stream colour
  blondeDelta: 15,       // paleness rise above a stream's baseline = blonde
  blondeHoldS: 1.0,      // must stay blonde this long
};

// ---------------------------------------------------------------- geometry
// Similarity transform (scale+rotation+translation) as a 3x3 row-major array.
const I3 = () => [1, 0, 0, 0, 1, 0, 0, 0, 1];

function mul3(A, B) {
  const C = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    }
  }
  return C;
}

export function invertAffine(T) {
  const [a, b, c, d, e, f] = T;
  const det = a * e - b * d;
  const ia = e / det, ib = -b / det, id = -d / det, ie = a / det;
  return [ia, ib, -(ia * c + ib * f), id, ie, -(id * c + ie * f), 0, 0, 1];
}

export function applyAffine(T, x, y) {
  return [T[0] * x + T[1] * y + T[2], T[3] * x + T[4] * y + T[5]];
}

// Least-squares similarity mapping src -> dst over the given indices.
function fitSimilarity(src, dst, idx) {
  let mx = 0, my = 0, nx = 0, ny = 0;
  for (const i of idx) { mx += src[2 * i]; my += src[2 * i + 1]; nx += dst[2 * i]; ny += dst[2 * i + 1]; }
  const k = idx.length;
  mx /= k; my /= k; nx /= k; ny /= k;
  let sxx = 0, sa = 0, sb = 0;
  for (const i of idx) {
    const sx = src[2 * i] - mx, sy = src[2 * i + 1] - my;
    const dx = dst[2 * i] - nx, dy = dst[2 * i + 1] - ny;
    sxx += sx * sx + sy * sy;
    sa += sx * dx + sy * dy;
    sb += sx * dy - sy * dx;
  }
  if (sxx < 1e-9) return null;
  const a = sa / sxx, b = sb / sxx;
  return [a, -b, nx - (a * mx - b * my), b, a, ny - (b * mx + a * my), 0, 0, 1];
}

// RANSAC similarity estimate (stand-in for cv.estimateAffinePartial2D, which
// OpenCV.js does not ship). Deterministic so runs are reproducible.
export function estimateSimilarity(src, dst, n, thresh = 2.0, iters = 120) {
  if (n < 2) return null;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const t2 = thresh * thresh;
  let best = null, bestCount = 0;
  const all = Array.from({ length: n }, (_, i) => i);
  for (let it = 0; it < iters; it++) {
    const i = Math.floor(rnd() * n);
    let j = Math.floor(rnd() * n);
    if (j === i) j = (j + 1) % n;
    const M = fitSimilarity(src, dst, [i, j]);
    if (!M) continue;
    let count = 0;
    for (let q = 0; q < n; q++) {
      const [x, y] = applyAffine(M, src[2 * q], src[2 * q + 1]);
      const ex = x - dst[2 * q], ey = y - dst[2 * q + 1];
      if (ex * ex + ey * ey < t2) count++;
    }
    if (count > bestCount) { bestCount = count; best = M; }
  }
  if (!best || bestCount < Math.max(3, n * 0.2)) return null;
  const inl = all.filter((q) => {
    const [x, y] = applyAffine(best, src[2 * q], src[2 * q + 1]);
    const ex = x - dst[2 * q], ey = y - dst[2 * q + 1];
    return ex * ex + ey * ey < t2;
  });
  return { M: fitSimilarity(src, dst, inl) || best, inliers: inl.length };
}

function median(arr) {
  if (!arr.length) return NaN;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// sRGB from Lab (for swatches)
export function labToRgb(L, a, b) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t) => (t > 6 / 29 ? t * t * t : 3 * (6 / 29) ** 2 * (t - 4 / 29));
  const X = 0.95047 * inv(fx), Y = inv(fy), Z = 1.08883 * inv(fz);
  const lin = [
    3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 * Y + 0.041556 * Z,
    0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z,
  ];
  return lin.map((v) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
  });
}

// ---------------------------------------------------------------- tracker
class Track {
  constructor(id, cx, t) {
    this.id = id;
    this.cx = cx;
    this.hits = 1;
    this.first = t;
    this.last = t;
    this.recent = [t];
    this.runStart = null;
    this.flows = [];
    this.stream = null;
  }

  // seen for ~0.25 s worth of frames
  confirmed(fps) { return this.hits >= Math.max(3, Math.round(0.27 * fps)); }

  // Seen in about two thirds of the frames of the last `window` seconds,
  // whatever the frame rate (needs at least 3 sightings).
  dense(t, fps, window = 0.5) {
    while (this.recent.length && t - this.recent[0] > window) this.recent.shift();
    return this.recent.length >= Math.max(3, Math.round(window * fps * 0.67));
  }

  // median flow score over the last ~1 s of sightings (at least ~0.33 s)
  flowing(flowMin, fps) {
    const f = this.flows.slice(-Math.max(5, Math.round(fps)));
    return f.length >= Math.max(3, Math.round(fps / 3)) && median(f) >= flowMin;
  }
}

export class StreamTracker {
  constructor(cv, opts = {}) {
    this.cv = cv;
    this.opts = { ...TRACKER_DEFAULTS, ...opts };
    this.mats = [];
    this.W = 0; this.H = 0;
    this.reset();
  }

  setOptions(o) { Object.assign(this.opts, o); }

  // Forget everything (call when the source changes).
  reset() {
    this.state = 'idle';     // idle | learning | armed | pouring | done
    this._clearShot();
    this._freeRef();
  }

  // Start watching for a shot. The next frame becomes the reference, so call
  // it while nothing is flowing; keep the camera roughly still for ~1 s.
  arm() {
    this._clearShot();
    this._freeRef();
    this.state = 'learning';
    this._wantRef = true;
  }

  _clearShot() {
    this.tracks = [];
    this.streams = [];
    this.nextTrackId = 1;
    this.shotStart = null;
    this.candidateStart = null;
    this.confirmedAt = null;
    this.lastFlowT = null;
    this.tEnd = null;
    this.blondeAt = null;
    this.blondeSince = null;
    this.blondeStream = null;
    this.T = I3();
    this.refT0 = null;
    this.lastDetections = [];
    this.lastT = null;
    this.fps = 30;          // measured frame rate (smoothed)
  }

  _freeRef() {
    for (const k of ['refGray', 'prevGray', 'refPts', 'refLinesD']) {
      if (this[k]) { this[k].delete(); this[k] = null; }
    }
    this.refLines = null;
    this.persist = null;
    this.prevLab = null;
  }

  _alloc(W, H) {
    const cv = this.cv;
    for (const m of this.mats) m.delete();
    this.W = W; this.H = H;
    const M = (rows, cols, type) => { const m = new cv.Mat(rows, cols, type); this.mats.push(m); return m; };
    this.m = {
      rgba: M(H, W, cv.CV_8UC4), gray: M(H, W, cv.CV_8UC1), warpedGray: M(H, W, cv.CV_8UC1),
      stab: M(H, W, cv.CV_8UC4), rgb: M(H, W, cv.CV_8UC3), lab8: M(H, W, cv.CV_8UC3),
      ones: M(H, W, cv.CV_8UC1), valid: M(H, W, cv.CV_8UC1), validE: M(H, W, cv.CV_8UC1),
      ch: M(H, W, cv.CV_32F), g: M(H, W, cv.CV_32F), dxx: M(H, W, cv.CV_32F), dyy: M(H, W, cv.CV_32F),
      acc: M(H, W, cv.CV_32F), lm: M(H, W, cv.CV_32F), mask: M(H, W, cv.CV_8UC1),
      labels: M(H, W, cv.CV_32S), stats: new cv.Mat(), cents: new cv.Mat(),
      pts: new cv.Mat(), nxt: new cv.Mat(), st: new cv.Mat(), err: new cv.Mat(), empty: new cv.Mat(),
      erodeK: cv.Mat.ones(9, 9, cv.CV_8U), dilK: cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 5)),
      M23: cv.matFromArray(2, 3, cv.CV_64F, [1, 0, 0, 0, 1, 0]),
    };
    for (const k of ['stats', 'cents', 'pts', 'nxt', 'st', 'err', 'empty', 'erodeK', 'dilK', 'M23']) this.mats.push(this.m[k]);
    this.m.ones.setTo(new cv.Scalar(255));
    this.labF = [new Float32Array(W * H), new Float32Array(W * H), new Float32Array(W * H)];
    this.change = new Float32Array(W * H);
    this.criteria = new cv.TermCriteria(cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 30, 0.01);
  }

  dispose() {
    this._freeRef();
    for (const m of this.mats) m.delete();
    this.mats = [];
  }

  // ---- registration -----------------------------------------------------
  _lk(prev, next, ptsMat, win, level) {
    const cv = this.cv, m = this.m;
    cv.calcOpticalFlowPyrLK(prev, next, ptsMat, m.nxt, m.st, m.err, new cv.Size(win, win), level, this.criteria);
    return { p0: ptsMat.data32F, p1: m.nxt.data32F, st: m.st.data, err: m.err.data32F };
  }

  // Refine a predicted transform directly against the reference frame.
  _refine(gray, pred, level) {
    const cv = this.cv, m = this.m;
    m.M23.data64F.set(pred.slice(0, 6));
    cv.warpAffine(gray, m.warpedGray, m.M23, new cv.Size(this.W, this.H), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0));
    const { p0, p1, st, err } = this._lk(this.refGray, m.warpedGray, this.refPts, 15, level);
    const src = [], dst = [];
    for (let i = 0; i < this.refPts.rows; i++) {
      if (st[i] === 1 && err[i] < 20) { src.push(p1[2 * i], p1[2 * i + 1]); dst.push(p0[2 * i], p0[2 * i + 1]); }
    }
    if (src.length < 30) return null;
    const r = estimateSimilarity(src, dst, src.length / 2, 1.5, 60);
    // enough agreeing points for a 4-parameter fit (not a majority: parallax
    // between portafilter and cups means one model never fits every point)
    if (!r || r.inliers < 25) return null;
    return mul3(r.M, pred);
  }

  _register(gray) {
    // Fast path: assume little motion since the last frame and refine against
    // the reference with a deeper pyramid (handles a few px of shake).
    let T = this._refine(gray, this.T, 3);
    if (!T) T = this._registerSlow(gray);
    this.T = T;
    gray.copyTo(this.prevGray);
  }

  // Slow path for big/fast motion: frame-to-frame prediction, then refine.
  _registerSlow(gray) {
    const cv = this.cv, m = this.m;
    let step = I3();
    cv.goodFeaturesToTrack(this.prevGray, m.pts, 150, 0.01, 8, m.empty, 3);
    if (m.pts.rows >= 10) {
      const { p0, p1, st } = this._lk(this.prevGray, gray, m.pts, 21, 3);
      const src = [], dst = [];
      for (let i = 0; i < m.pts.rows; i++) {
        if (st[i] === 1) { src.push(p1[2 * i], p1[2 * i + 1]); dst.push(p0[2 * i], p0[2 * i + 1]); }
      }
      if (src.length >= 20) {
        const r = estimateSimilarity(src, dst, src.length / 2, 2.0);
        if (r) step = r.M;        // maps current -> previous
      }
    }
    const pred = mul3(this.T, step);
    this.slowCount = (this.slowCount || 0) + 1;
    return this._refine(gray, pred, 2) || pred;
  }

  // ---- line map -----------------------------------------------------------
  _lineMap() {
    const cv = this.cv, m = this.m, n = this.W * this.H;
    const acc = m.acc.data32F;
    acc.fill(0);
    const weights = [1.0, 1.4, 1.4];
    for (let c = 0; c < 3; c++) {
      m.ch.data32F.set(this.labF[c]);
      cv.GaussianBlur(m.ch, m.g, new cv.Size(0, 0), 1.3, 1.3, cv.BORDER_DEFAULT);
      cv.Sobel(m.g, m.dxx, cv.CV_32F, 2, 0, 3);
      cv.Sobel(m.g, m.dyy, cv.CV_32F, 0, 2, 3);
      const dxx = m.dxx.data32F, dyy = m.dyy.data32F, w = weights[c];
      for (let i = 0; i < n; i++) {
        const r = (Math.abs(dxx[i]) - 0.8 * Math.abs(dyy[i])) * w;
        if (r > acc[i]) acc[i] = r;
      }
    }
    cv.GaussianBlur(m.acc, m.lm, new cv.Size(0, 0), 0.6, 3, cv.BORDER_DEFAULT);
    const lm = m.lm.data32F, valid = m.validE.data;
    for (let i = 0; i < n; i++) if (!valid[i]) lm[i] = 0;
    return lm;
  }

  // ---- main entry ---------------------------------------------------------
  // rgba: Uint8ClampedArray/Uint8Array of W*H*4; t: seconds (monotonic)
  process(rgba, W, H, t) {
    const cv = this.cv, o = this.opts;
    const events = [];
    if (W !== this.W || H !== this.H) {
      this._alloc(W, H);
      if (this.state !== 'idle') this.arm();
    }
    if (this.state === 'idle') return this._result(t, events);
    const m = this.m, n = W * H;
    if (this.lastT != null && t > this.lastT) {
      this.fps = this.fps * 0.9 + (1 / (t - this.lastT)) * 0.1;
    }
    const dt = this.lastT != null ? Math.min(0.5, Math.max(1e-3, t - this.lastT)) : 1 / 30;
    this.lastT = t;
    const fps = this.fps;
    m.rgba.data.set(rgba);
    cv.cvtColor(m.rgba, m.gray, cv.COLOR_RGBA2GRAY);

    if (this._wantRef) {
      this._wantRef = false;
      this.refGray = m.gray.clone();
      this.prevGray = m.gray.clone();
      this.refPts = new cv.Mat();
      cv.goodFeaturesToTrack(this.refGray, this.refPts, 200, 0.01, 7, m.empty, 5);
      this.T = I3();
      this.refT0 = t;
      this.persist = new Float32Array(n);
      return this._result(t, events);
    }

    this._register(m.gray);
    m.M23.data64F.set(this.T.slice(0, 6));
    const size = new cv.Size(W, H);
    cv.warpAffine(m.rgba, m.stab, m.M23, size, cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    cv.warpAffine(m.ones, m.valid, m.M23, size, cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
    cv.erode(m.valid, m.validE, m.erodeK, new cv.Point(-1, -1), 1, cv.BORDER_CONSTANT, new cv.Scalar(0));
    cv.cvtColor(m.stab, m.rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(m.rgb, m.lab8, cv.COLOR_RGB2Lab);
    const l8 = m.lab8.data, [Lf, Af, Bf] = this.labF;
    const change = this.change;
    const prev = this.prevLab;
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      const L = l8[j] * (100 / 255), A = l8[j + 1] - 128, B = l8[j + 2] - 128;
      change[i] = prev ? Math.abs(L - prev[0][i]) + Math.abs(A - prev[1][i]) + Math.abs(B - prev[2][i]) : 0;
      Lf[i] = L; Af[i] = A; Bf[i] = B;
    }
    if (!this.prevLab) this.prevLab = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    this.prevLab[0].set(Lf); this.prevLab[1].set(Af); this.prevLab[2].set(Bf);

    const lm = this._lineMap();

    if (this.state === 'learning') {
      if (!this.refLines) this.refLines = new Float32Array(n);
      const ref = this.refLines;
      for (let i = 0; i < n; i++) ref[i] = Math.max(ref[i] * 0.98, lm[i]);
      if (t - this.refT0 >= o.refLearnS) {
        const refMat = cv.matFromArray(H, W, cv.CV_32F, ref);
        this.refLinesD = new cv.Mat();
        cv.dilate(refMat, this.refLinesD, m.dilK);
        refMat.delete();
        this.state = 'armed';
        events.push({ type: 'armed', t });
      }
      return this._result(t, events);
    }

    // ---- new lines + persistence
    const refD = this.refLinesD.data32F, persist = this.persist, mask = m.mask.data;
    // persistence with a ~0.2 s time constant (0.85/frame at 30 fps)
    const keep = Math.exp(-dt / 0.2);
    for (let i = 0; i < n; i++) {
      const nw = Math.max(lm[i] - 1.2 * refD[i], 0);
      persist[i] = persist[i] * keep + nw * (1 - keep);
      mask[i] = persist[i] > o.newThreshold ? 1 : 0;
    }
    const ncc = cv.connectedComponentsWithStats(m.mask, m.labels, m.stats, m.cents, 8, cv.CV_32S);
    const stats = m.stats.data32S, labels = m.labels.data32S, validE = m.validE.data;

    // ---- detections
    const dets = [];
    for (let k = 1; k < ncc; k++) {
      const x = stats[k * 5], y = stats[k * 5 + 1], w = stats[k * 5 + 2], h = stats[k * 5 + 3], area = stats[k * 5 + 4];
      if (h < 10 || h < 2 * w || area < 15) continue;
      const compIdx = [], lmv = [];
      for (let yy = y; yy < y + h; yy++) {
        for (let xx = x; xx < x + w; xx++) {
          const i = yy * W + xx;
          if (labels[i] === k) { compIdx.push(i); lmv.push(lm[i]); }
        }
      }
      const thr = median(lmv);
      const core = compIdx.filter((i) => lm[i] >= thr);
      if (core.length < 5) continue;
      // flow score: change inside vs a ring around (excluding dilated component)
      const x0 = Math.max(0, x - 8), y0 = Math.max(0, y - 4), x1 = Math.min(W, x + w + 8), y1 = Math.min(H, y + h + 4);
      let inside = 0;
      for (const i of core) inside += change[i];
      inside /= core.length;
      let ringSum = 0, ringN = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = yy * W + xx;
          if (!validE[i]) continue;
          let near = false;
          for (let dy = -1; dy <= 1 && !near; dy++) {
            const ry = yy + dy;
            if (ry < 0 || ry >= H) continue;
            for (let dx = -2; dx <= 2; dx++) {
              const rx = xx + dx;
              if (rx >= 0 && rx < W && labels[ry * W + rx] === k) { near = true; break; }
            }
          }
          if (!near) { ringSum += change[i]; ringN++; }
        }
      }
      const around = ringN ? ringSum / ringN : inside;
      const flow = inside / (around + 1);
      dets.push({
        cx: x + w / 2, box: [x, y, w, h], core, flow,
        L: median(core.map((i) => Lf[i])), a: median(core.map((i) => Af[i])), b: median(core.map((i) => Bf[i])),
      });
    }

    // ---- associate with tracks
    dets.sort((p, q) => q.core.length - p.core.length);
    for (const d of dets) {
      let best = null;
      for (const tr of this.tracks) {
        if (Math.abs(tr.cx - d.cx) < 12 && tr.last < t && (!best || Math.abs(tr.cx - d.cx) < Math.abs(best.cx - d.cx))) best = tr;
      }
      if (!best) {
        best = new Track(this.nextTrackId++, d.cx, t);
        this.tracks.push(best);
      } else {
        best.cx = best.cx * 0.8 + d.cx * 0.2;
        best.hits++;
        best.last = t;
        best.recent.push(t);
      }
      d.track = best;
      best.flows.push(d.flow);
      if (best.flows.length > 120) best.flows.shift();
      if (best.confirmed(fps) && !best.stream && best.flowing(o.flowMin, fps)) {
        let s = null;
        for (const st of this.streams) if (Math.abs(st.cx - best.cx) < 20 && (!s || Math.abs(st.cx - best.cx) < Math.abs(s.cx - best.cx))) s = st;
        if (!s) {
          s = { id: this.streams.length + 1, cx: best.cx, flows: [], samples: [], baseline: null, smoothP: null };
          this.streams.push(s);
        }
        best.stream = s;
      }
      if (best.stream) {
        best.stream.flows.push(d.flow);
        if (best.stream.flows.length > 300) best.stream.flows.shift();
      }
    }

    // ---- shot start (first liquid), confirmed by a present, flowing stream
    this.candidateStart = null;
    for (const tr of this.tracks) {
      if (tr.dense(t, fps)) {
        if (tr.runStart == null) tr.runStart = t;
        if (tr.flowing(o.flowMin, fps) && (this.candidateStart == null || tr.first < this.candidateStart)) {
          this.candidateStart = Math.max(tr.first, tr.runStart - o.lookbackS);
        }
        if (this.state === 'armed' && t - tr.runStart >= o.confirmS && tr.flowing(o.flowMin, fps)) {
          this.shotStart = Math.max(tr.first, tr.runStart - o.lookbackS);
          this.confirmedAt = t;
          this.state = 'pouring';
          events.push({ type: 'start', t: this.shotStart, confirmedAt: t, elapsed: 0 });
        }
      } else {
        tr.runStart = null;
      }
    }
    this.tracks = this.tracks.filter((tr) => (tr.confirmed(fps) ? t - tr.last < 3 : t - tr.last < 1));

    // ---- colour per stream (only detections that are liquid right now)
    const live = [];
    for (const d of dets) {
      const s = d.track.stream;
      if (!s || s.flows.length < Math.max(5, fps / 2) || median(s.flows) < o.flowMin || !d.track.flowing(o.flowMin, fps)) continue;
      const C = Math.hypot(d.a, d.b);
      d.stream = s;
      d.P = d.L - C;
      d.C = C;
      d.rgb = labToRgb(d.L, d.a, d.b);
      live.push(d);
      if (this.state === 'pouring' || this.state === 'armed') {
        s.samples.push({ t, L: d.L, a: d.a, b: d.b, C, P: d.P, rgb: d.rgb });
        if (s.samples.length > 3000) s.samples.shift();
      }
    }
    if (live.length) this.lastFlowT = t;
    this.lastDetections = live;

    if (this.state === 'pouring') {
      this._blonde(t, events);
      if (this.lastFlowT != null && t - this.lastFlowT >= o.endS) {
        this.state = 'done';
        this.tEnd = this.lastFlowT;
        events.push({ type: 'end', t: this.tEnd, elapsed: this.tEnd - this.shotStart });
      }
    }
    return this._result(t, events);
  }

  // Blonding per stream: median paleness over the last smoothS seconds,
  // relative to that stream's lowest smoothed paleness after settling.
  _blonde(t, events) {
    const o = this.opts;
    let bestProg = 0, bestStream = null;
    for (const s of this.streams) {
      const recent = [];
      for (let i = s.samples.length - 1; i >= 0 && t - s.samples[i].t <= o.smoothS; i--) recent.push(s.samples[i].P);
      if (recent.length < Math.max(3, this.fps * o.smoothS * 0.25)) { s.progress = 0; continue; }
      s.smoothP = median(recent);
      if (t - this.shotStart >= o.settleS) {
        if (s.baseline == null || s.smoothP < s.baseline) s.baseline = s.smoothP;
        s.progress = Math.max(0, (s.smoothP - s.baseline) / o.blondeDelta);
        if (s.progress > bestProg) { bestProg = s.progress; bestStream = s; }
      } else {
        s.progress = 0;
      }
    }
    this.progress = bestProg;
    if (this.blondeAt != null) return;
    if (bestProg >= 1) {
      if (this.blondeSince == null) this.blondeSince = t;
      if (t - this.blondeSince >= o.blondeHoldS) {
        this.blondeAt = this.blondeSince - this.shotStart;
        this.blondeStream = bestStream.id;
        events.push({ type: 'blonde', t, elapsed: this.blondeAt, stream: bestStream.id });
      }
    } else {
      this.blondeSince = null;
    }
  }

  elapsed(t) {
    if (this.shotStart == null) return 0;
    if (this.tEnd != null) return this.tEnd - this.shotStart;
    return Math.max(0, t - this.shotStart);
  }

  // Map a point from reference (stabilised) coordinates to the current frame.
  toFrame(x, y) {
    return applyAffine(invertAffine(this.T), x, y);
  }

  _result(t, events) {
    return {
      state: this.state,
      elapsed: this.elapsed(t),
      provisional: this.state === 'armed' && this.candidateStart != null ? Math.max(0, t - this.candidateStart) : null,
      progress: this.progress || 0,
      blondeAt: this.blondeAt,
      detections: this.lastDetections,
      events,
    };
  }
}
