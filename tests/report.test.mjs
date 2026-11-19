// node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../js/report.js';

// Fake tracker with one or two streams whose lightness L(t) and paleness P(t)
// follow the given functions of shot time, sampled at 15 fps.
function fakeTracker({ duration = 25, ended = true, streams }) {
  return {
    shotStart: 10, tEnd: ended ? 10 + duration : null, blondeAt: null,
    streams: streams.map((s, k) => {
      const samples = [];
      for (let t = s.from ?? 0; t < duration; t += 1 / 15) {
        const L = s.L(t), P = s.P(t);
        samples.push({ t: 10 + t, L, C: L - P, P, rgb: [Math.round(L * 2.5), Math.round(L * 1.5), Math.round(L)] });
      }
      return { id: k + 1, cx: 80 + 60 * k, established: true, samples };
    }),
  };
}
const early = { L: (t) => (t < 3 ? 20 + 8 * t : 45), P: (t) => 2 + 0.1 * t };            // light by 3 s, flat after
const steady = { L: (t) => (t < 3 ? 18 : 18 + 1.6 * (t - 3)), P: (t) => (t < 3 ? -10 : -10 + 1.2 * (t - 3)) };

test('early-and-flat shot gets the fast-flow note', () => {
  const r = buildReport(fakeTracker({ streams: [early, early] }), { target: 25 });
  assert.equal(r.timing, 'on target');
  assert.ok(r.notes.some((n) => n.kind === 'warn' && /fast flow/.test(n.text)), JSON.stringify(r.notes));
  assert.equal(r.balance.verdict, 'even');
});

test('steadily lightening shot gets the good note, no warnings', () => {
  const r = buildReport(fakeTracker({ streams: [steady, steady] }), { target: 25 });
  assert.ok(r.notes.some((n) => n.kind === 'good'), JSON.stringify(r.notes));
  assert.ok(!r.notes.some((n) => n.kind === 'warn'));
});

test('spouts that differ in timing and change are flagged uneven', () => {
  const late = { L: (t) => (t < 8 ? 18 : 18 + 2 * (t - 8)), P: (t) => (t < 8 ? -10 : -10 + 2.5 * (t - 8)) };
  const r = buildReport(fakeTracker({ streams: [early, late] }), { target: 25 });
  assert.equal(r.balance.verdict, 'uneven');
  assert.equal(r.streams[0].label, 'Left');
});

test('a stopped measurement reports a minimum, not a timing verdict', () => {
  const r = buildReport(fakeTracker({ ended: false, duration: 18, streams: [steady] }), { target: 25 });
  assert.equal(r.endedBy, 'stopped');
  assert.equal(r.timing, null);
  assert.ok(r.notes.some((n) => /minimum/.test(n.text)));
});

test('timing verdicts against the target', () => {
  assert.equal(buildReport(fakeTracker({ duration: 19, streams: [steady] }), { target: 25 }).timing, '6.0 s short');
  assert.equal(buildReport(fakeTracker({ duration: 30, streams: [steady] }), { target: 25 }).timing, '5.0 s long');
});

test('a stream first seen mid-shot gets no timing measures', () => {
  const r = buildReport(fakeTracker({ streams: [{ ...steady, from: 8 }] }), { target: 25 });
  assert.equal(r.streams[0].profile.caramelAt, null);
  assert.equal(r.streams[0].profile.earlyShare, null);
});

test('fast and slow shots are called out; every report carries the scale/roast caveat', () => {
  const steady = { L: (t) => (t < 3 ? 18 : 18 + 1.6 * (t - 3)), P: (t) => (t < 3 ? -10 : -10 + 1.2 * (t - 3)) };
  const fast = buildReport(fakeTracker({ duration: 16, streams: [steady] }), { target: 25 });
  assert.ok(fast.notes.some((n) => /ran fast/.test(n.text)));
  const slow = buildReport(fakeTracker({ duration: 40, streams: [steady] }), { target: 25 });
  assert.ok(slow.notes.some((n) => /ran long/.test(n.text)));
  assert.match(fast.caveat, /scale/);
});

test('spouts starting out of step are flagged even when they then develop alike', () => {
  const steady = { L: (t) => (t < 3 ? 18 : 18 + 1.6 * (t - 3)), P: (t) => (t < 3 ? -10 : -10 + 1.2 * (t - 3)) };
  const r = buildReport(fakeTracker({ streams: [steady, { ...steady, from: 2.5 }] }), { target: 25 });
  assert.ok(r.notes.some((n) => /started 2\.5 s before/.test(n.text)), JSON.stringify(r.notes));
});
