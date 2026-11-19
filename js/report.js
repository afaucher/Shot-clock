// Shot quality report: turns the tracker's per-stream colour samples into a
// summary a person can act on. Pure (no DOM), so it runs in Node too.
//
// All colour measurements are relative to each stream itself, because the
// absolute values depend on the setup (backdrop, light, camera). Thresholds
// for the notes are provisional: they come from a handful of real shots.

export const REPORT_RULES = {
  onTargetS: 2,          // within this many seconds of the target = on target
  earlyAtS: 6,           // "how much of the lightening happened by this time"
  earlyShare: 0.8,       // ...at least this share = went light early
  flatSlope: 5,          // paleness rise per 10 s below this after caramel = flat
  steadySlope: 8,        // ...above this = lightened steadily
  unevenCaramelS: 3,     // spouts turning caramel this far apart...
  unevenRise: 12,        // ...AND their paleness changing this differently = uneven
  seenFromStartS: 2,     // timing measures only for streams seen this early
  fastS: 20,             // shot (first drop to end) shorter than this = fast
  slowS: 35,             // ...longer than this = slow
  startGapS: 1.5,        // spouts' first drops this far apart = out of step
  abruptJump: 15,        // (not used for notes yet: see buildReport)
};

function median(a) {
  const s = a.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// 1-second bins of a stream's samples, in shot time.
export function streamSeries(samples, t0, t1) {
  const bins = [];
  for (let s = 0; s < Math.ceil(t1 - t0); s++) bins.push([]);
  for (const p of samples) {
    const k = Math.floor(p.t - t0);
    if (k >= 0 && k < bins.length) bins[k].push(p);
  }
  return bins.map((b, k) => (b.length < 3 ? { t: k + 0.5, n: b.length } : {
    t: k + 0.5, n: b.length,
    L: median(b.map((p) => p.L)), C: median(b.map((p) => p.C)), P: median(b.map((p) => p.P)),
    rgb: [0, 1, 2].map((c) => Math.round(median(b.map((p) => p.rgb[c])))),
  }));
}

// Smooth a per-second series with a 3-point median (skipping gaps).
function smooth(series, key) {
  return series.map((b, i) => {
    const w = [series[i - 1], b, series[i + 1]].filter((x) => x && Number.isFinite(x[key])).map((x) => x[key]);
    return w.length ? median(w) : NaN;
  });
}

function slopePer10s(xs, ys) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([, y]) => Number.isFinite(y));
  if (pts.length < 4) return NaN;
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  let num = 0, den = 0;
  for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) ** 2; }
  return den ? (num / den) * 10 : NaN;
}

// How a single stream developed: when it turned caramel, how much of its
// lightening happened early, and how steadily it got paler afterwards.
export function streamProfile(series, rules = REPORT_RULES, firstSeen = 0) {
  const L = smooth(series, 'L'), P = smooth(series, 'P');
  const t = series.map((b) => b.t);
  const have = L.map((v, i) => (Number.isFinite(v) ? i : -1)).filter((i) => i >= 0);
  if (have.length < 6) return null;
  const first = have.slice(0, 2).map((i) => L[i]);
  const last = have.slice(-3).map((i) => L[i]);
  const Lstart = median(first), Lend = median(last);
  const range = Lend - Lstart;
  // timing measures need the stream from the start (a stream first picked
  // up mid-shot looks "already light" from its first reading)
  const fromStart = firstSeen <= rules.seenFromStartS;
  let caramelAt = null;
  if (fromStart) for (const i of have) if (L[i] >= Lstart + 0.5 * range) { caramelAt = t[i]; break; }
  // share of the total lightening reached by earlyAtS
  const iEarly = have.filter((i) => t[i] <= rules.earlyAtS).pop();
  const earlyShare = fromStart && range > 3 && iEarly != null ? Math.max(0, Math.min(1, (L[iEarly] - Lstart) / range)) : null;
  const from = caramelAt ?? t[have[0]];
  const after = have.filter((i) => t[i] >= from);
  const paleSlope = slopePer10s(after.map((i) => t[i]), after.map((i) => P[i]));
  const Pafter = after.map((i) => P[i]);
  // robust change in paleness: last 3 s vs first 3 s after turning caramel
  const paleRise = Pafter.length >= 6 ? median(Pafter.slice(-3)) - median(Pafter.slice(0, 3)) : null;
  // biggest paleness rise within any 3 s after turning caramel (abrupt vs gradual)
  let jump = null;
  for (let k = 0; k + 3 < Pafter.length; k++) {
    const d = Pafter[k + 3] - Pafter[k];
    if (Number.isFinite(d) && (jump == null || d > jump)) jump = d;
  }
  return {
    Lstart: +Lstart.toFixed(1), Lend: +Lend.toFixed(1),
    caramelAt, earlyShare: earlyShare == null ? null : +earlyShare.toFixed(2),
    paleSlope: Number.isFinite(paleSlope) ? +paleSlope.toFixed(1) : null,
    paleJump: jump == null ? null : +jump.toFixed(1),
    paleRise: paleRise == null ? null : +paleRise.toFixed(1),

  };
}

// Build the report from a finished (or stopped) tracker.
export function buildReport(tracker, { target = 25, maxStreams = 2, rules = REPORT_RULES, when = Date.now() } = {}) {
  const t0 = tracker.shotStart;
  if (t0 == null) return null;
  const allT = tracker.streams.flatMap((s) => s.samples.map((p) => p.t));
  const t1 = tracker.tEnd ?? (allT.length ? Math.max(...allT) : t0);
  const duration = Math.max(0, t1 - t0);
  const main = tracker.streams.filter((s) => s.established && s.samples.length > 10)
    .sort((a, b) => b.samples.length - a.samples.length).slice(0, maxStreams)
    .sort((a, b) => a.cx - b.cx);                     // left to right
  const streams = main.map((s, k) => {
    const series = streamSeries(s.samples, t0, t1 + 1);
    const firstSeen = Math.max(0, Math.min(...s.samples.map((p) => p.t)) - t0);
    return { label: main.length === 2 ? (k === 0 ? 'Left' : 'Right') : `Stream ${k + 1}`, firstSeen: +firstSeen.toFixed(1), series, profile: streamProfile(series, rules, firstSeen) };
  });

  const notes = [];
  const diff = target > 0 ? duration - target : null;
  let timing = null;
  const ended = tracker.tEnd != null;
  if (diff != null && ended) {
    timing = Math.abs(diff) <= rules.onTargetS ? 'on target' : diff < 0 ? `${(-diff).toFixed(1)} s short` : `${diff.toFixed(1)} s long`;
  }
  const profs = streams.map((s) => s.profile).filter(Boolean);
  if (profs.length) {
    const early = profs.filter((p) => p.earlyShare != null && p.earlyShare >= rules.earlyShare);
    const flat = profs.filter((p) => p.paleSlope != null && p.paleSlope < rules.flatSlope);
    const steady = profs.filter((p) => p.paleSlope != null && p.paleSlope >= rules.steadySlope);
    if (early.length && early.some((p) => flat.includes(p))) {
      notes.push({ kind: 'warn', text: 'Went light early, then stayed flat. That often means fast flow: a coarser grind, a lighter dose or a light tamp.' });
    } else if (early.length) {
      notes.push({ kind: 'info', text: 'Most of the lightening happened in the first few seconds.' });
    }
    const seenFromStart = profs.some((p) => p.earlyShare != null);
    if (!early.length && steady.length && seenFromStart) {
      notes.push({ kind: 'good', text: 'Stayed dark at first, then got paler steadily through the shot.' });
    }
  }
  let balance = null;
  if (streams.length === 2 && streams.every((s) => s.profile)) {
    const [a, b] = streams.map((s) => s.profile);
    const caramelGap = a.caramelAt != null && b.caramelAt != null ? Math.abs(a.caramelAt - b.caramelAt) : null;
    const riseGap = a.paleRise != null && b.paleRise != null ? Math.abs(a.paleRise - b.paleRise) : null;
    const startGap = Math.abs(streams[0].firstSeen - streams[1].firstSeen);
    balance = { caramelGap, riseGap: riseGap == null ? null : +riseGap.toFixed(1), startGap: +startGap.toFixed(1) };
    // both timing and colour change must differ: either alone is often a
    // sampling or backdrop effect
    const uneven = caramelGap != null && caramelGap > rules.unevenCaramelS && riseGap != null && riseGap > rules.unevenRise;
    balance.verdict = uneven ? 'uneven' : 'even';
    if (uneven) notes.push({ kind: 'warn', text: 'The two spouts developed differently, which can point to uneven extraction (channeling). First check the machine is level, then try WDT and a level tamp.' });
    else if (startGap > rules.startGapS && streams.every((s) => s.firstSeen <= rules.seenFromStartS + rules.startGapS)) {
      notes.push({ kind: 'warn', text: `One spout started ${startGap.toFixed(1)} s before the other. That can come from uneven puck prep or a machine that isn't level; check the level first, then distribution and tamp.` });
    }
  }
  // "Abrupt lightening" is a recognised channeling sign, but with the current
  // colour sampling the 3 s jump (paleJump) fired on the steadiest real shot
  // too, so it is kept as a measurement only, not turned into a note.
  if (ended && duration < rules.fastS) {
    notes.push({ kind: 'warn', text: `This shot ran fast (${duration.toFixed(0)} s from the first drop), which often means the grind is too coarse or the dose is low.` });
  } else if (ended && duration > rules.slowS) {
    notes.push({ kind: 'warn', text: `This shot ran long (${duration.toFixed(0)} s), which often points to a grind that's too fine or a high dose.` });
  }
  if (!ended) {
    notes.push({ kind: 'info', text: 'Measurement stopped before the shot ended, so the total time is a minimum.' });
  }
  if (timing && timing !== 'on target') {
    notes.push({ kind: 'info', text: diff < 0 ? 'Ran short of the target: try a finer grind or a larger dose.' : 'Ran past the target: try a coarser grind or a smaller dose.' });
  }
  const caveat = 'Without a scale, yield and ratio weren\'t checked, and colour timing varies with roast and freshness (light roasts look paler and turn pale sooner), so taste is the final judge.';
  return {
    when, duration: +duration.toFixed(1), target, timing, blondeAt: tracker.blondeAt, caveat,
    endedBy: ended ? 'end' : 'stopped',
    streams: streams.map((s) => ({ label: s.label, firstSeen: s.firstSeen, profile: s.profile,
      series: s.series.map((b) => (b.L == null ? null : { t: b.t, L: +b.L.toFixed(1), P: +b.P.toFixed(1), rgb: b.rgb })) })),
    balance, notes,
  };
}
