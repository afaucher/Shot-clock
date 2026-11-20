#!/usr/bin/env node
// Regression evaluation of the live tracker on the real clips listed in
// data/clips.json (videos kept outside the repo).
//
//   node tools/eval.mjs --dir ~/shot-clips [--only clip2] [--json] [--opt name=value ...]
//
// For each clip found as <dir>/<id>.mp4 it reports:
//   start    error of the detected first liquid vs the verified time
//   shown    streams shown at once: share of shot frames with more than the
//            number of spouts, and how many distinct streams were ever shown
//   tracked  share of shot frames each of the two most-shown streams was shown
//   colour   share of the shot with colour samples per main stream, longest gap
//   jumps    1 s colour jumps > 12 paleness on the main streams (colour noise)
//   end      detected end vs pump-off (only clips recorded past pump-off)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { track } from './track.mjs';
import { applyAffine, invertAffine } from '../js/tracker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const dir = get('--dir');
if (!dir) { console.error('usage: node tools/eval.mjs --dir FOLDER [--only id] [--json]'); process.exit(1); }
const { clips } = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/clips.json'), 'utf8'));
const LABELS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/stream_labels.json'), 'utf8'));

function median(a) { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; }

async function evalClip(c) {
  const file = path.join(dir, `${c.id}.mp4`);
  if (!fs.existsSync(file)) return null;
  const shownPerFrame = [];
  const shownIds = new Map();     // stream id -> frames shown
  // precision / recall against hand-labelled real streams
  const lab = LABELS.clips[c.id];
  const marks = lab ? Object.entries(lab.marks).map(([t, xs]) => ({ t: +t, xs })).sort((a, b) => a.t - b.t) : [];
  let mi = 0;
  const pr = { shown: 0, correct: 0, labelled: 0, found: 0, wrong: [] };
  const opts = {};
  for (let i = 0; i < args.length; i++) if (args[i] === '--opt') { const [k, v] = args[i + 1].split('='); opts[k] = +v; }
  const out = await track(file, {
    armAt: c.armAt, opts,
    onFrame: (t, res, tr) => {
      while (mi < marks.length && t >= marks[mi].t) {
        const m = marks[mi++];
        const Ti = invertAffine(tr.T);
        const boxes = res.detections.map((d) => {
          const [x, y, w, h] = d.box;
          const pts = [[x, y], [x + w, y + h], [x + w, y], [x, y + h]].map(([px, py]) => applyAffine(Ti, px, py));
          const xs = pts.map((p) => p[0] / tr.W), ys = pts.map((p) => p[1] / tr.H);
          return { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2 };
        });
        const tol = LABELS.tolerance;
        const inBand = (b) => b.cy >= lab.y[0] - tol.y && b.cy <= lab.y[1] + tol.y;
        const hits = new Set();
        for (const b of boxes) {
          pr.shown++;
          const k = m.xs.findIndex((x) => Math.abs(b.cx - x) <= tol.x);
          if (k >= 0 && inBand(b)) { pr.correct++; hits.add(k); } else pr.wrong.push(`${m.t}s@(${b.cx.toFixed(2)},${b.cy.toFixed(2)})`);
        }
        pr.labelled += m.xs.length;
        pr.found += hits.size;
        m.xs.forEach((x, k) => { if (!hits.has(k)) (pr.missed ||= []).push(`${m.t}s@x${x}`); });
      }
      if (tr.shotStart == null || t < tr.shotStart) return;
      const ids = new Set(res.detections.map((d) => d.stream.id));
      shownPerFrame.push(ids.size);
      for (const id of ids) shownIds.set(id, (shownIds.get(id) || 0) + 1);
    },
  });
  const tr = out.tracker;
  const start = out.events.find((e) => e.type === 'start');
  const end = out.events.find((e) => e.type === 'end');
  const frames = shownPerFrame.length || 1;
  const over = shownPerFrame.filter((k) => k > c.spouts).length / frames;
  const everShown = [...shownIds.values()].filter((n) => n >= out.fps * 0.5).length;
  const main = [...tr.streams].sort((a, b) => b.samples.length - a.samples.length).slice(0, c.spouts);
  const shotLen = (end ? end.t : out.frames / out.fps) - (start ? start.t : 0);
  const mainStats = main.map((s) => {
    const ts = s.samples.map((p) => p.t).filter((x) => start && x >= start.t);
    let gap = 0;
    for (let i = 1; i < ts.length; i++) gap = Math.max(gap, ts[i] - ts[i - 1]);
    const covered = new Set(ts.map((x) => Math.floor(x * 2))).size / 2;   // seconds with samples
    // colour jumps: 1 s medians that differ > 12 from both neighbours' medians
    const secs = new Map();
    for (const p of s.samples) { const k = Math.floor(p.t); (secs.get(k) || secs.set(k, []).get(k)).push(p.P); }
    const med = [...secs.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => median(v));
    let jumps = 0;
    for (let i = 1; i < med.length - 1; i++) if (Math.abs(med[i] - med[i - 1]) > 12 && Math.abs(med[i] - med[i + 1]) > 12) jumps++;
    return { cover: covered / shotLen, gap, jumps };
  });
  const tracked = [...shownIds.values()].sort((a, b) => b - a).slice(0, c.spouts).map((n) => n / frames);
  return {
    id: c.id, tracked, pr,
    startErr: start && c.firstLiquid != null ? start.t - c.firstLiquid : null,
    falseStart: !!(start && c.firstLiquid == null),
    expectStart: c.firstLiquid != null,
    over, everShown,
    main: mainStats,
    end: end ? end.t : null,
    pumpOff: c.pump?.off ?? null,
    recordedPastPumpOff: c.recordedPastPumpOff,
    msPerFrame: out.msPerFrame,
  };
}

const rows = [];
for (const c of clips) {
  if (get('--only') && get('--only') !== c.id) continue;
  const r = await evalClip(c);
  if (!r) { console.log(`${c.id}: not found in ${dir}, skipped`); continue; }
  rows.push(r);
  if (!args.includes('--json')) {
    const m = r.main.map((s) => `${Math.round(s.cover * 100)}%/gap ${s.gap.toFixed(1)}s/jumps ${s.jumps}`).join('  ');
    const tk = r.tracked.map((x) => `${Math.round(x * 100)}%`).join(' ');
    const endTxt = r.recordedPastPumpOff ? (r.end != null ? `end ${r.end.toFixed(1)} (pump off ${r.pumpOff})` : `no end (pump off ${r.pumpOff})`) : (r.end != null ? `end ${r.end.toFixed(1)} (shot still running!)` : 'no end (ok, recording stops mid-shot)');
    const st = !r.expectStart ? (r.falseStart ? 'FALSE START' : 'none (correct)') : r.startErr == null ? 'MISSED' : (r.startErr >= 0 ? '+' : '') + r.startErr.toFixed(2) + ' s';
    const prTxt = r.pr.labelled ? ` | precision ${r.pr.shown ? Math.round(100 * r.pr.correct / r.pr.shown) : '-'}% recall ${Math.round(100 * r.pr.found / r.pr.labelled)}%` : '';
    console.log(`${r.id}: start ${st}${prTxt} | >spouts ${Math.round(r.over * 100)}%, ${r.everShown} shown | tracked ${tk} | colour ${m} | ${endTxt} | ${r.msPerFrame.toFixed(0)} ms/frame`);
  }
}
const tot = rows.reduce((a, r) => ({ shown: a.shown + r.pr.shown, correct: a.correct + r.pr.correct, labelled: a.labelled + r.pr.labelled, found: a.found + r.pr.found }), { shown: 0, correct: 0, labelled: 0, found: 0 });
if (tot.labelled && !args.includes('--json')) {
  console.log(`ALL: precision ${Math.round(100 * tot.correct / Math.max(1, tot.shown))}% (${tot.correct}/${tot.shown} shown boxes on real streams), recall ${Math.round(100 * tot.found / tot.labelled)}% (${tot.found}/${tot.labelled} real streams shown)`);
  if (args.includes('--wrong')) for (const r of rows) if (r.pr.wrong.length) console.log(`  ${r.id} wrong: ${r.pr.wrong.join(' ')}`);
  if (args.includes('--missed')) for (const r of rows) if (r.pr.missed?.length) console.log(`  ${r.id} missed: ${r.pr.missed.join(' ')}`);
}
if (args.includes('--json')) console.log(JSON.stringify(rows, null, 1));
