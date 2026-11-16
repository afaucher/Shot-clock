#!/usr/bin/env node
// Run the live stream tracker (js/tracker.js + vendored OpenCV.js) over a
// video file, headless, exactly as the browser runs it.
//
//   node tools/track.mjs shot.mp4 [--delta 15] [--json] [--every 1]
//
// Prints events (armed, start, blonde, end) and a per-second colour table.
// Requires ffmpeg/ffprobe. The reference frame is taken at --arm seconds
// (default 1.0; pick a moment with nothing flowing).
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { StreamTracker } from '../js/tracker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function loadCv() {
  const cv = createRequire(import.meta.url)(path.join(ROOT, 'vendor/opencv-4.10.0.js'));
  // Don't `await cv`: this Emscripten build has a `then` that resolves to
  // itself, so awaiting it never finishes. Wait for the runtime instead.
  if (!cv.Mat) await new Promise((r) => { cv.onRuntimeInitialized = r; });
  // ...and drop that `then`, or returning cv from this async function would
  // hit the same endless self-resolution.
  delete cv.then;
  return cv;
}

function probe(file) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height,r_frame_rate:stream_side_data=rotation', '-of', 'json', file]).toString()).streams[0];
  const rot = Math.abs(j.side_data_list?.find((s) => s.rotation != null)?.rotation ?? 0);
  const [num, den] = j.r_frame_rate.split('/').map(Number);
  const [w, h] = rot === 90 || rot === 270 ? [j.height, j.width] : [j.width, j.height];
  return { w, h, fps: num / (den || 1) };
}

export async function track(file, { opts = {}, armAt = 1.0, onFrame } = {}) {
  const cv = await loadCv();
  const { w, h, fps } = probe(file);
  const W = 270, H = Math.round((W * h) / w / 2) * 2;
  const tracker = new StreamTracker(cv, opts);
  const events = [];
  const frameBytes = W * H * 4;
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-i', file, '-vf', `scale=${W}:${H}:flags=area`,
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  let pending = Buffer.alloc(0);
  let idx = 0;
  const t0 = Date.now();
  for await (const chunk of ff.stdout) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= frameBytes) {
      const frame = pending.subarray(0, frameBytes);
      const t = idx / fps;
      if (tracker.state === 'idle' && t >= armAt) tracker.arm();
      const res = tracker.process(frame, W, H, t);
      for (const ev of res.events) events.push({ ...ev, videoTime: t });
      onFrame?.(t, res, tracker);
      pending = pending.subarray(frameBytes);
      idx++;
    }
  }
  const ms = (Date.now() - t0) / idx;
  const out = { events, tracker, fps, frames: idx, msPerFrame: ms, W, H };
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--') && !/^[\d.]+$/.test(a));
  if (!file) {
    console.error('usage: node tools/track.mjs VIDEO [--arm 1.0] [--delta 15] [--json]');
    process.exit(1);
  }
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const opts = {};
  if (get('--delta')) opts.blondeDelta = +get('--delta');
  const rows = [];
  let next = 0;
  const out = await track(file, {
    opts, armAt: get('--arm') ? +get('--arm') : 1.0,
    onFrame: (t, res, tr) => {
      if (t < next) return;
      next += 1;
      const ds = res.detections.map((d) => `#${d.stream.id} P${d.P.toFixed(0)} L${d.L.toFixed(0)} C${d.C.toFixed(0)}`).join('  ');
      rows.push(`${t.toFixed(1).padStart(5)}s ${res.state.padEnd(8)} shot ${res.elapsed.toFixed(1).padStart(5)}  prog ${res.progress.toFixed(2)}  ${ds}`);
    },
  });
  if (args.includes('--json')) {
    console.log(JSON.stringify({ events: out.events, streams: out.tracker.streams.map((s) => ({ id: s.id, cx: s.cx, samples: s.samples })) }));
    return;
  }
  if (!args.includes('--quiet')) console.log(rows.join('\n'));
  console.log(`\n${out.frames} frames @ ${out.fps.toFixed(1)} fps, ${out.W}x${out.H}, ${out.msPerFrame.toFixed(1)} ms/frame (Node)`);
  for (const ev of out.events) {
    const extra = ev.type === 'start' ? `  first liquid at ${ev.t.toFixed(2)} s (confirmed ${ev.confirmedAt.toFixed(2)} s)`
      : ev.elapsed != null ? `  shot time ${ev.elapsed.toFixed(2)} s` : '';
    console.log(`${ev.videoTime.toFixed(2).padStart(7)} s  ${ev.type.padEnd(7)}${extra}`);
  }
  const streams = out.tracker.streams.filter((s) => s.samples.length > 30);
  console.log('streams:', streams.map((s) => `#${s.id} x≈${s.cx.toFixed(0)} (${s.samples.length} samples)`).join(', ') || 'none');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
