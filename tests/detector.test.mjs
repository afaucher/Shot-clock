// node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { ShotDetector, srgb8ToLab } from '../js/detector.js';

const W = 24, H = 60, FPS = 30;

// Deterministic noise
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

function makeFrame(rand, stream) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const n = (rand() - 0.5) * 8;
      let r = 80 + n, g = 84 + n, b = 92 + n;
      if (stream) {
        const { rgb, width, drip } = stream;
        const inCol = Math.abs(x - W / 2) < width / 2;
        const inDrop = drip == null || Math.abs(y - drip) < 3;
        if (inCol && inDrop) [r, g, b] = rgb.map((c) => c + n);
      }
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
  }
  return px;
}

const mix = (a, b, u) => a.map((v, i) => v + (b[i] - v) * u);
const DARK = [75, 35, 20], CARAMEL = [170, 100, 50], ORANGE = [200, 115, 45], TAN = [205, 165, 110], BLONDE = [230, 205, 155];

// Shot script: returns stream description at time t (s), or null.
function script(t, { lead = 1, end = 25, blondeFrom = 18 } = {}) {
  const s = t - lead;
  if (s < 0 || s >= end) return null;
  if (s < 1) return { rgb: DARK, width: 3, drip: (s * 120) % H };
  let rgb;
  if (s < 8) rgb = DARK;
  else if (s < 13) rgb = mix(DARK, CARAMEL, (s - 8) / 5);
  else if (s < blondeFrom) rgb = mix(CARAMEL, ORANGE, (s - 13) / (blondeFrom - 13));
  else if (s < blondeFrom + 3) rgb = mix(ORANGE, TAN, (s - blondeFrom) / 3);
  else rgb = mix(TAN, BLONDE, Math.min(1, (s - blondeFrom - 3) / 3));
  return { rgb, width: 6 };
}

function run(opts = {}, scriptOpts = {}, duration = 30) {
  const det = new ShotDetector(opts);
  const rand = rng(7);
  det.arm();
  const events = [];
  for (let f = 0; f < duration * FPS; f++) {
    const t = f / FPS;
    const res = det.process(makeFrame(rand, script(t, scriptOpts)), W, H, t);
    events.push(...res.events);
  }
  return { det, events, byType: Object.fromEntries(events.map((e) => [e.type, e])) };
}

test('paleness is flat from dark to orange and jumps at blonde', () => {
  const P = (c) => srgb8ToLab(...c).P;
  assert.ok(Math.abs(P(CARAMEL) - P(DARK)) < 12);
  assert.ok(Math.abs(P(ORANGE) - P(DARK)) < 12);
  assert.ok(P(TAN) - P(DARK) > 30);
  assert.ok(P(BLONDE) - P(DARK) > 45);
});

test('full shot: start, blonde, end', () => {
  const { byType, det } = run();
  assert.ok(byType.armed, 'armed');
  assert.ok(byType.start, 'started');
  assert.ok(Math.abs(byType.start.t - 1) < 0.3, `start backdated to first drip, got ${byType.start.t}`);
  assert.ok(byType.blonde, 'blonde alert fired');
  // blonding begins 18 s after first drip; allow for smoothing/hold lag
  assert.ok(byType.blonde.elapsed > 17.5 && byType.blonde.elapsed < 20.5, `blonde at ${byType.blonde.elapsed}`);
  assert.ok(byType.end, 'ended');
  assert.ok(Math.abs(byType.end.elapsed - 25) < 0.5, `total ${byType.end.elapsed}`);
  assert.equal(det.state, 'done');
});

test('caramel/orange phase alone never triggers blonde', () => {
  const { byType } = run({}, { blondeFrom: 99, end: 25 });
  assert.ok(byType.start);
  assert.equal(byType.blonde, undefined);
});

test('lower sensitivity value alerts earlier', () => {
  const early = run({ blondeDelta: 12 }).byType.blonde.elapsed;
  const late = run({ blondeDelta: 35 }).byType.blonde.elapsed;
  assert.ok(early < late, `${early} < ${late}`);
});

test('no shot -> no events beyond armed', () => {
  const det = new ShotDetector();
  const rand = rng(3);
  det.arm();
  const types = [];
  for (let f = 0; f < 10 * FPS; f++) types.push(...det.process(makeFrame(rand, null), W, H, f / FPS).events.map((e) => e.type));
  assert.deepEqual(types, ['armed']);
});

test('external (pump) trigger starts timer before first drip', () => {
  const det = new ShotDetector();
  const rand = rng(5);
  det.arm();
  const events = [];
  for (let f = 0; f < 36 * FPS; f++) {
    const t = f / FPS;
    if (f === Math.round(0.5 * FPS) + 20) det.externalTrigger(t); // pump on, ~6 s pre-infusion
    events.push(...det.process(makeFrame(rand, script(t, { lead: 7.2 })), W, H, t).events);
  }
  const flow = events.find((e) => e.type === 'flow');
  assert.ok(flow, 'flow event after pump start');
  assert.ok(flow.elapsed > 5, `pre-infusion ${flow.elapsed}`);
  assert.ok(events.find((e) => e.type === 'blonde'));
  assert.ok(events.find((e) => e.type === 'end'));
});
