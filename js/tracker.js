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
  rerefScale: 0.04,      // re-reference when the view zooms more than this...
  rerefShift: 0.08,      // ...or shifts more than this fraction of the frame
  newThreshold: 3.0,     // persistence threshold for "new line" evidence
  flowMin: 1.4,          // median flow score to establish a stream (liquid)
  flowKeep: 1.1,         // (legacy) lower flow that keeps a stream live
  maxStreams: 2,         // show/use only the N most confident streams
  weakFactor: 0.8,       // near an established stream, accept evidence down to this
                         // fraction of newThreshold (continues streams, never starts one)
  scoreConfirm: 6,       // track confidence (log-likelihood ratio) to confirm a stream
  scoreKeep: 0,          // confidence below which a confirmed stream is dropped
  swapMargin: 3,         // a challenger must beat an incumbent by this much...
  swapHoldS: 0.5,        // ...for this long to take its place in the top N
  pairWeight: 60,        // penalty per frame-height of top-end mismatch between chosen streams
  stackPenalty: 20,      // a candidate with another stream directly below it is
                         // probably that stream's mirror image in the chrome above
                         // (streams from one portafilter start at about the same height)
  confirmS: 2.0,         // a stream must stay present this long to start the clock
  lookbackS: 3.0,        // max backdating before the present-run start
  endS: 3.0,             // no live stream for this long = shot over
  settleS: 2.0,          // ignore colour for blonding baseline in the first seconds
  smoothS: 1.0,          // median window for stream colour
  blondeDelta: 15,       // paleness rise above a stream's baseline = blonde
  blondeHoldS: 1.0,      // must stay blonde this long
  minContrast: 6,        // a stream must differ this much (ΔE) from its local
                         // background for its colour to be trusted
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
  constructor(id, cx, cy, t) {
    this.id = id;
    this.cx = cx;
    this.cy = cy;
    this.hits = 1;
    this.first = t;
    this.last = t;
    this.recent = [t];
    this.runStart = null;
    this.flows = [];
    this.score = 0;              // running log-likelihood ratio "real stream vs artefact"
    this.peak = 0;
    this.cxHist = [];            // [t, cx] over the last second (anchoring)
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
    this.regInliers = r.inliers;
    return mul3(r.M, pred);
  }

  _register(gray) {
    // Fast path: assume little motion since the last frame and refine against
    // the reference with a deeper pyramid (handles a few px of shake).
    const old = this.T;
    this.regInliers = 0;
    let T = this._refine(gray, this.T, 3);
    if (!T) { T = this._registerSlow(gray); this.slowStreak = (this.slowStreak || 0) + 1; } else this.slowStreak = 0;
    this.T = T;
    // camera motion this frame (px at working resolution) and how much to
    // trust this frame's registration (0..1)
    this.motion = Math.hypot(T[2] - old[2], T[5] - old[5])
      + Math.abs(Math.hypot(T[0], T[3]) - Math.hypot(old[0], old[3])) * Math.max(this.W, this.H);
    this.regConf = Math.max(0.2, Math.min(1, this.regInliers / 60));
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

  // ---- reference ----------------------------------------------------------
  // boxes: regions to keep reference points out of (streams being tracked:
  // features on moving coffee would make registration follow the stream)
  _setReference(gray, t, boxes = []) {
    const cv = this.cv, n = this.W * this.H;
    for (const k of ['refGray', 'prevGray', 'refPts']) if (this[k]) { this[k].delete(); this[k] = null; }
    this.refGray = gray.clone();
    this.prevGray = gray.clone();
    this.refPts = new cv.Mat();
    let mask = this.m.empty;
    if (boxes.length) {
      mask = new cv.Mat(this.H, this.W, cv.CV_8UC1, new cv.Scalar(255));
      for (const [x0, y0, x1, y1] of boxes) {
        cv.rectangle(mask, new cv.Point(x0, y0), new cv.Point(x1, y1), new cv.Scalar(0), -1);
      }
    }
    cv.goodFeaturesToTrack(this.refGray, this.refPts, 200, 0.01, 7, mask, 5);
    if (mask !== this.m.empty) mask.delete();
    this.T = I3();
    this.refT0 = t;
    this.slowStreak = 0;
    this.persist = new Float32Array(n);
    this.prevLab = null;
  }

  // Re-reference mid-shot: the current view becomes the reference. Tracks,
  // streams and persistence move into the new coordinates, and the streams
  // being tracked are masked out of the new reference lines so they are not
  // absorbed into "what was already there".
  _rereference(gray, t) {
    const cv = this.cv, W = this.W, H = this.H;
    const Ti = invertAffine(this.T);              // old reference -> current frame
    const mapX = (x, y) => applyAffine(Ti, x, y);
    // mask every established stream seen recently (not just this frame's
    // detections: a stream missed in this one frame would otherwise be
    // absorbed into the new reference and cancelled)
    // the union of each stream's boxes over the last 1.5 s: a single box often
    // covers only part of a stream, and streams sway
    const keep = [];
    for (const tr of this.tracks) {
      if (!tr.stream?.established || t - tr.last >= 1.5 || !tr.boxes?.length) continue;
      const bs = tr.boxes.map((q) => q[1]);
      const x0 = Math.min(...bs.map((b) => b[0])), y0 = Math.min(...bs.map((b) => b[1]));
      const x1 = Math.max(...bs.map((b) => b[0] + b[2])), y1 = Math.max(...bs.map((b) => b[1] + b[3]));
      keep.push([x0, y0, x1 - x0, y1 - y0]);
    }
    for (const d of this.lastDetections) keep.push(d.box);
    for (const tr of this.tracks) [tr.cx, tr.cy] = mapX(tr.cx, tr.cy);
    for (const s of this.streams) {
      const top = mapX(s.cx, s.top ?? 0)[1];
      const bottom = s.bottom != null ? mapX(s.cx, s.bottom)[1] : null;
      [s.cx, s.cy] = mapX(s.cx, s.cy ?? H / 2);
      s.top = top;
      s.tops = [[t, top]];
      s.bottom = bottom;
      s.bots = bottom != null ? [[t, bottom]] : [];
    }
    const boxes = [];
    for (const box of keep) {
      const [x, y, w, h] = box;
      const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => mapX(px, py));
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      boxes.push([Math.floor(Math.min(...xs)) - 10, Math.floor(Math.min(...ys)) - 10,
        Math.ceil(Math.max(...xs)) + 10, Math.ceil(Math.max(...ys)) + 10]);
    }
    // carry persistence over (warp old-reference map into current coordinates)
    const src = cv.matFromArray(H, W, cv.CV_32F, this.persist);
    const dst = new cv.Mat();
    const M = cv.matFromArray(2, 3, cv.CV_64F, Ti.slice(0, 6));
    cv.warpAffine(src, dst, M, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0));
    const persist = Float32Array.from(dst.data32F);
    src.delete(); dst.delete(); M.delete();
    for (const tr of this.tracks) { tr.box = null; tr.boxes = []; tr.cxHist = []; }   // old coordinates
    this.lastDetections = [];
    this._setReference(gray, this.refT0, boxes);
    this.persist = persist;
    this._pendingRef = boxes;
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
      this._setReference(m.gray, t);
      return this._result(t, events);
    }

    this._register(m.gray);

    // The further the view drifts from the reference (zoom, big shifts while
    // hand-held), the more parallax and newly visible areas look "new".
    // Re-reference when that happens.
    const Tm = this.T;
    const drift = Math.abs(Math.hypot(Tm[0], Tm[3]) - 1) > o.rerefScale
      || Math.hypot(Tm[2], Tm[5]) > o.rerefShift * Math.max(W, H);
    if (drift && (this.state === 'armed' || this.state === 'pouring') && t - (this.lastReref ?? -1e9) > 1.0) {
      this.lastReref = t;
      const flowing = this.streams.some((s) => s.established) || this.tracks.some((tr) => tr.dense(t, fps));
      if (this.state === 'armed' && !flowing) {
        // nothing flowing yet (e.g. still framing the shot): learn the scene again
        this._setReference(m.gray, t);
        this.state = 'learning';
        this.refLines = null;
        if (this.refLinesD) { this.refLinesD.delete(); this.refLinesD = null; }
        this.tracks = [];
        events.push({ type: 'relearn', t });
        return this._result(t, events);
      }
      this._rereference(m.gray, t);
      events.push({ type: 'reref', t });
    }

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

    if (this._pendingRef) {
      // new reference lines from this view, minus the streams being tracked
      const ref = Float32Array.from(lm);
      for (const [bx0, by0, bx1, by1] of this._pendingRef) {
        for (let yy = Math.max(0, by0); yy < Math.min(H, by1); yy++) {
          ref.fill(0, yy * W + Math.max(0, bx0), yy * W + Math.min(W, bx1));
        }
      }
      const refMat = cv.matFromArray(H, W, cv.CV_32F, ref);
      if (this.refLinesD) this.refLinesD.delete();
      this.refLinesD = new cv.Mat();
      cv.dilate(refMat, this.refLinesD, m.dilK);
      refMat.delete();
      this._pendingRef = null;
    }

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
    // Weak evidence may continue an established top-N stream but never start
    // one (as in ByteTrack): near those streams the threshold is lower.
    const near = new Uint8Array(W);
    for (const st of this.streams) {
      if (!st.inTop) continue;
      for (let x = Math.max(0, Math.floor(st.cx - 12)); x <= Math.min(W - 1, Math.ceil(st.cx + 12)); x++) near[x] = 1;
    }
    const weakT = o.weakFactor * o.newThreshold;
    for (let i = 0; i < n; i++) {
      const nw = Math.max(lm[i] - 1.2 * refD[i], 0);
      persist[i] = persist[i] * keep + nw * (1 - keep);
      mask[i] = persist[i] > (near[i % W] ? weakT : o.newThreshold) ? 1 : 0;
    }
    const ncc = cv.connectedComponentsWithStats(m.mask, m.labels, m.stats, m.cents, 8, cv.CV_32S);
    const stats = m.stats.data32S, labels = m.labels.data32S, validE = m.validE.data;

    // ---- detections
    const dets = [];
    for (let k = 1; k < ncc; k++) {
      const x = stats[k * 5], y = stats[k * 5 + 1], w = stats[k * 5 + 2], h = stats[k * 5 + 3], area = stats[k * 5 + 4];
      const nearTop = near[Math.min(W - 1, Math.round(x + w / 2))] === 1;
      // tall and thin; looser near an established stream (sprays, thin late streams)
      const strongShape = h >= 10 && h >= 2 * w && area >= 15;
      if (!strongShape && !(nearTop && o.weakFactor < 1 && h >= 6 && h >= 1.2 * w && area >= 8)) continue;
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
      // per-row background colour from the ring (background changes down the
      // stream: wall, cup interior, rim)
      const rows = y1 - y0;
      const rL = new Float32Array(rows), rA = new Float32Array(rows), rB = new Float32Array(rows), rN = new Float32Array(rows);
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
          if (!near) {
            ringSum += change[i]; ringN++;
            const r = yy - y0;
            rL[r] += Lf[i]; rA[r] += Af[i]; rB[r] += Bf[i]; rN[r]++;
          }
        }
      }
      const around = ringN ? ringSum / ringN : inside;
      const flow = inside / (around + 1);
      // Colour: of the core pixels, keep the half that differs most from the
      // local background (least mixed with it); skip the sample if the stream
      // barely stands out (thin stream over a similar or sunlit background).
      const scored = [];
      for (const i of core) {
        const r = ((i / W) | 0) - y0;
        let n = 0, bl = 0, ba = 0, bb = 0;
        for (let q = Math.max(0, r - 2); q <= Math.min(rows - 1, r + 2); q++) { n += rN[q]; bl += rL[q]; ba += rA[q]; bb += rB[q]; }
        if (!n) continue;
        const dE = Math.hypot(Lf[i] - bl / n, Af[i] - ba / n, Bf[i] - bb / n);
        scored.push([dE, i]);
      }
      scored.sort((p, q) => q[0] - p[0]);
      const keep = scored.slice(0, Math.max(3, scored.length >> 1));
      const contrast = keep.length ? median(keep.map((k) => k[0])) : 0;
      const pix = keep.length ? keep.map((k) => k[1]) : core;
      // share of bright, colourless pixels: specular highlights on chrome take
      // the light's colour; coffee never does
      let hl = 0;
      for (const i of core) if (Lf[i] > 85 && Math.abs(Af[i]) + Math.abs(Bf[i]) < 16) hl++;
      let strongPx = 0;
      for (const i of core) if (persist[i] > o.newThreshold) strongPx++;
      // weak detections keep a stream alive but don't give colour samples
      const weak = !strongShape || strongPx < 0.5 * core.length;
      dets.push({
        cx: x + w / 2, box: [x, y, w, h], core, flow, contrast, highlight: hl / core.length, weak,
        colorOk: contrast >= o.minContrast && !weak,
        L: median(pix.map((i) => Lf[i])), a: median(pix.map((i) => Af[i])), b: median(pix.map((i) => Bf[i])),
      });
    }

    // ---- associate with tracks
    dets.sort((p, q) => q.core.length - p.core.length);
    for (const d of dets) {
      let best = null;
      for (const tr of this.tracks) {
        if (Math.abs(tr.cx - d.cx) >= 12 || tr.last >= t) continue;
        // match in 2D: a reflection straight above a stream has the same x,
        // so x alone lets it take over the stream's identity
        // (compare with everything the track covered in the last ~1.5 s: a
        // stream is often detected in pieces, top half one frame, bottom the next)
        const [, dy, , dh] = d.box;
        let vOk;
        if (tr.boxes?.length) {
          let top = Infinity, bot = -Infinity;
          for (const [, b] of tr.boxes) { top = Math.min(top, b[1]); bot = Math.max(bot, b[1] + b[3]); }
          vOk = Math.min(dy + dh, bot) - Math.max(dy, top) > -6;
        } else {
          vOk = Math.abs(dy + dh / 2 - tr.cy) < dh / 2 + 25;
        }
        if (!vOk) continue;
        if (!best || Math.abs(tr.cx - d.cx) < Math.abs(best.cx - d.cx)) best = tr;
      }
      const cy = d.box[1] + d.box[3] / 2;
      if (!best) {
        best = new Track(this.nextTrackId++, d.cx, cy, t);
        best.box = d.box;
        best.boxes = [[t, d.box]];
        this.tracks.push(best);
      } else {
        best.cx = best.cx * 0.8 + d.cx * 0.2;
        best.cy = best.cy * 0.8 + cy * 0.2;
        best.box = d.box;
        (best.boxes ||= []).push([t, d.box]);
        while (best.boxes.length && t - best.boxes[0][0] > 1.5) best.boxes.shift();
        best.hits++;
        best.last = t;
        best.recent.push(t);
      }
      d.track = best;
      best.flows.push(d.flow);
      if (best.flows.length > 120) best.flows.shift();
      best.matched = d;
      if (best.confirmed(fps) && !best.stream && best.flowing(o.flowMin, fps)) {
        let s = null;
        // join an existing stream only if it lines up in 2D: same column AND
        // overlapping vertically (a mirror image above is a different thing)
        const [, by, , bh] = d.box;
        for (const st of this.streams) {
          if (Math.abs(st.cx - best.cx) >= 20) continue;
          if (st.top != null && st.bottom != null && Math.min(by + bh, st.bottom) - Math.max(by, st.top) < -6) continue;
          if (!s || Math.abs(st.cx - best.cx) < Math.abs(s.cx - best.cx)) s = st;
        }
        if (!s) {
          s = { id: this.streams.length + 1, cx: best.cx, cy: best.cy, top: d.box[1], flows: [], samples: [], baseline: null, smoothP: null, established: false, score: 0, inTop: false };
          this.streams.push(s);
        }
        best.stream = s;
      }
      if (best.stream) {
        // where the stream starts (spout tip): median of the last 2 s, so a
        // stray detection joining the stream can't move it
        const st = best.stream;
        (st.tops ||= []).push([t, d.box[1]]);
        while (st.tops.length && t - st.tops[0][0] > 2) st.tops.shift();
        st.top = median(st.tops.map((q) => q[1]));
        (st.bots ||= []).push([t, d.box[1] + d.box[3]]);
        while (st.bots.length && t - st.bots[0][0] > 2) st.bots.shift();
        st.bottom = median(st.bots.map((q) => q[1]));
        st.lastSeen = t;
        best.stream.flows.push(d.flow);
        if (best.stream.flows.length > 300) best.stream.flows.shift();
      }
    }

    this._score(t, dt);

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
      // Flow establishes a stream; after that it stays live while it keeps
      // being seen in place (hysteresis). Late in a shot streams thin out and
      // run smooth, and moving light around them lowers the flow score, so
      // re-checking flow every frame would drop real streams.
      if (!s || !s.inTop || d.track.score < o.scoreKeep) continue;
      const C = Math.hypot(d.a, d.b);
      d.stream = s;
      d.P = d.L - C;
      d.C = C;
      d.rgb = labToRgb(d.L, d.a, d.b);
      live.push(d);
      if (d.colorOk && (this.state === 'pouring' || this.state === 'armed')) {
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

  // Track confidence as a running log-likelihood ratio (as in radar track
  // scoring / SPRT): each frame adds evidence for or against "real stream",
  // misses cost a little, frames with poor registration count less. Streams
  // are confirmed above scoreConfirm and only the top N are shown and used.
  _score(t, dt) {
    const o = this.opts;
    const k = dt * 15 * (this.regConf ?? 1);        // per 1/15 s, scaled by registration trust
    const still = 1 / (1 + (this.motion || 0) / 2); // 1 when the camera is still
    // streams seen this frame through any of their tracks: a stream often
    // splits into two tracks that take turns, which is not a miss
    const seen = new Set(this.tracks.filter((tr) => tr.matched && tr.last === t && tr.stream).map((tr) => tr.stream));
    for (const tr of this.tracks) {
      const d = tr.matched;
      tr.matched = null;
      let inc;
      if (d && tr.last === t) {
        // flow: liquid keeps changing; positive evidence only counts fully
        // while the camera is still (highlights/parallax change with motion)
        let lf = Math.max(-2, Math.min(2, 2.5 * Math.log(d.flow / 1.3)));
        if (lf > 0) lf *= still;
        // anchoring: a stream hangs from a fixed spout, so its x barely moves
        // in scene coordinates; reflections and highlights drift
        tr.cxHist.push([t, d.cx]);
        while (tr.cxHist.length && t - tr.cxHist[0][0] > 1) tr.cxHist.shift();
        let la = 0;
        if (tr.cxHist.length >= 5) {
          const xs = tr.cxHist.map((h) => h[1]);
          const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
          const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / xs.length);
          la = sd < 1.5 ? 0.3 : sd > 4 ? -0.8 : 0.3 - 1.1 * (sd - 1.5) / 2.5;
        }
        const lh = -Math.min(2, 3 * d.highlight);
        inc = lf + la + lh;
      } else {
        inc = tr.stream && seen.has(tr.stream) ? 0 : -0.4;   // missed this frame
      }
      tr.score = Math.max(-6, Math.min(30, tr.score + inc * k));
      tr.peak = Math.max(tr.peak, tr.score);
    }
    // stream confidence = its best track; confirm, then pick the top N
    for (const s of this.streams) s.score = -Infinity;
    for (const tr of this.tracks) if (tr.stream) tr.stream.score = Math.max(tr.stream.score, tr.score);
    for (const s of this.streams) {
      if (s.score === -Infinity) s.score = -6;
      if (!s.established && s.score >= o.scoreConfirm) s.established = true;
    }
    const eligible = this.streams.filter((s) => s.established && s.score >= o.scoreKeep);
    for (const s of this.streams) if (!eligible.includes(s)) s.inTop = false;
    // Choose the best set of N jointly: confidence + a bonus for incumbents
    // (no flicker) - a penalty when the chosen streams start at very
    // different heights (pair prior: one portafilter, spouts side by side;
    // rejects reflections low in the cup that flicker just like a stream).
    const n = Math.min(o.maxStreams, eligible.length);
    let best = null, bestVal = -Infinity;
    const stackedOver = (p) => this.streams.some((q) => q !== p && (q.established || q.score > 0)
      && q.lastSeen != null && t - q.lastSeen < 1.5 && p.bottom != null && q.top != null
      && Math.abs(q.cx - p.cx) < 14 && q.top >= p.bottom - 4);
    const H = this.H;
    const choose = (startIdx, picked) => {
      if (picked.length === n) {
        let v = 0;
        for (const p of picked) {
          v += p.score + (p.inTop ? o.swapMargin : 0);
          // stacking prior: coffee falls from the spout into the cup; a
          // mirror image in the polished portafilter sits straight above it
          if (stackedOver(p)) v -= o.stackPenalty;
        }
        for (let i = 0; i < picked.length; i++) {
          for (let j = i + 1; j < picked.length; j++) v -= o.pairWeight * Math.abs(picked[i].top - picked[j].top) / H;
        }
        if (v > bestVal) { bestVal = v; best = picked.slice(); }
        return;
      }
      for (let i = startIdx; i < eligible.length; i++) { picked.push(eligible[i]); choose(i + 1, picked); picked.pop(); }
    };
    if (n > 0) choose(0, []);
    const current = eligible.filter((s) => s.inTop);
    const same = best && best.length === current.length && best.every((s) => s.inTop);
    if (!best) {
      this.pendingTop = null;
    } else if (same) {
      this.pendingTop = null;
    } else if (current.length < n && current.every((s) => best.includes(s))) {
      for (const s of best) s.inTop = true;          // only filling empty slots: no wait
      this.pendingTop = null;
    } else {
      const key = best.map((s) => s.id).sort().join(',');
      if (!this.pendingTop || this.pendingTop.key !== key) this.pendingTop = { key, since: t };
      if (t - this.pendingTop.since >= o.swapHoldS) {
        for (const s of eligible) s.inTop = best.includes(s);
        this.pendingTop = null;
      }
    }
  }

  // Blonding per stream: median paleness over the last smoothS seconds,
  // relative to that stream's lowest smoothed paleness after settling.
  _blonde(t, events) {
    const o = this.opts;
    let bestProg = 0, bestStream = null;
    // only the top-N (most confident) streams
    for (const s of this.streams) {
      if (!s.inTop) { s.progress = 0; continue; }
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
