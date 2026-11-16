// node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateSimilarity, invertAffine, applyAffine, labToRgb } from '../js/tracker.js';

function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

test('estimateSimilarity recovers a known motion despite outliers', () => {
  const r = rng(1);
  const ang = 0.05, s = 1.03, tx = 7.5, ty = -4.2;
  const M = [s * Math.cos(ang), -s * Math.sin(ang), tx, s * Math.sin(ang), s * Math.cos(ang), ty, 0, 0, 1];
  const src = [], dst = [];
  for (let i = 0; i < 150; i++) {
    const x = r() * 270, y = r() * 480;
    let [u, v] = applyAffine(M, x, y);
    if (i % 4 === 0) { u += 30 * (r() - 0.5); v += 30 * (r() - 0.5); }   // 25% outliers (e.g. the stream itself)
    else { u += 0.3 * (r() - 0.5); v += 0.3 * (r() - 0.5); }
    src.push(x, y); dst.push(u, v);
  }
  const est = estimateSimilarity(src, dst, 150, 1.5);
  assert.ok(est && est.inliers >= 100, 'enough inliers');
  for (let k = 0; k < 6; k++) assert.ok(Math.abs(est.M[k] - M[k]) < (k % 3 === 2 ? 0.3 : 0.003), `param ${k}: ${est.M[k]} vs ${M[k]}`);
});

test('estimateSimilarity refuses random correspondences', () => {
  const r = rng(2);
  const src = [], dst = [];
  for (let i = 0; i < 60; i++) { src.push(r() * 270, r() * 480); dst.push(r() * 270, r() * 480); }
  assert.equal(estimateSimilarity(src, dst, 60, 1.5), null);
});

test('invertAffine undoes the transform', () => {
  const T = [0.98, -0.12, 14, 0.12, 0.98, -9, 0, 0, 1];
  const Ti = invertAffine(T);
  for (const [x, y] of [[0, 0], [100, 250], [269, 479]]) {
    const [u, v] = applyAffine(T, x, y);
    const [x2, y2] = applyAffine(Ti, u, v);
    assert.ok(Math.abs(x2 - x) < 1e-9 && Math.abs(y2 - y) < 1e-9);
  }
});

test('labToRgb maps neutral greys to equal channels and espresso tones to warm colours', () => {
  const [r, g, b] = labToRgb(50, 0, 0);
  assert.ok(Math.abs(r - g) <= 1 && Math.abs(g - b) <= 1);
  const [cr, cg, cb] = labToRgb(49, 18, 42);   // caramel
  assert.ok(cr > cg && cg > cb, `caramel is warm: ${cr},${cg},${cb}`);
});
