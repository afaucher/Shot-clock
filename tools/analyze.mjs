#!/usr/bin/env node
// Run the Shot Clock detector over a video file, headless, and print the
// timeline. Handy for tuning thresholds against recordings of real shots.
//
//   node tools/analyze.mjs shot.mp4 [--roi x,y,w,h] [--delta 25] [--pix 40]
//                                  [--cov 0.04] [--table] [--json]
//
// --roi is normalised 0..1 (same as the app's box). Default 0.42,0.35,0.16,0.35
// Requires ffmpeg/ffprobe on PATH.
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ShotDetector } from '../js/detector.js';

const PROC_W = 320;

export async function analyze(file, { roi = [0.42, 0.35, 0.16, 0.35], options = {}, onFrame } = {}) {
  const probe = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate',
    '-of', 'json', file,
  ]).toString()).streams[0];
  const [num, den] = probe.r_frame_rate.split('/').map(Number);
  const fps = num / (den || 1);
  const pw = PROC_W, ph = Math.round(PROC_W * probe.height / probe.width);
  const rx = Math.round(roi[0] * pw), ry = Math.round(roi[1] * ph);
  const rw = Math.max(4, Math.min(pw - rx, Math.round(roi[2] * pw)));
  const rh = Math.max(4, Math.min(ph - ry, Math.round(roi[3] * ph)));

  const det = new ShotDetector(options);
  det.arm();
  const events = [];
  const frameBytes = pw * ph * 4;
  const roiBuf = new Uint8ClampedArray(rw * rh * 4);

  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-i', file, '-vf', `scale=${pw}:${ph}`,
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  let pending = Buffer.alloc(0);
  let idx = 0;
  for await (const chunk of ff.stdout) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= frameBytes) {
      const frame = pending.subarray(0, frameBytes);
      for (let y = 0; y < rh; y++) {
        const src = ((ry + y) * pw + rx) * 4;
        roiBuf.set(frame.subarray(src, src + rw * 4), y * rw * 4);
      }
      const t = idx / fps;
      const res = det.process(roiBuf, rw, rh, t);
      for (const ev of res.events) events.push({ ...ev, videoTime: t });
      onFrame?.(t, res, det);
      pending = pending.subarray(frameBytes);
      idx++;
    }
  }
  return { events, samples: det.samples, detector: det, fps, frames: idx };
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--') && !/^[\d.,]+$/.test(a));
  if (!file) {
    console.error('usage: node tools/analyze.mjs VIDEO [--roi x,y,w,h] [--delta N] [--pix N] [--cov F] [--table] [--json]');
    process.exit(1);
  }
  const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const roi = get('--roi')?.split(',').map(Number);
  const options = {};
  if (get('--delta')) options.blondeDelta = +get('--delta');
  if (get('--pix')) options.pixelThreshold = +get('--pix');
  if (get('--cov')) options.flowCoverage = +get('--cov');

  const rows = [];
  let nextRow = 0;
  const out = await analyze(file, {
    roi, options,
    onFrame: (t, res) => {
      if (t >= nextRow) {
        nextRow += 0.5;
        rows.push({ t: t.toFixed(1), state: res.state, phase: res.phase, cover: (res.coverage * 100).toFixed(0) + '%',
          L: res.lab?.L.toFixed(1) ?? '', C: res.lab?.C.toFixed(1) ?? '', pale: res.lab?.P.toFixed(1) ?? '',
          prog: res.progress.toFixed(2), rgb: res.rgb?.join(',') ?? '' });
      }
    },
  });

  if (args.includes('--json')) {
    console.log(JSON.stringify({ events: out.events, samples: out.samples }, null, 1));
    return;
  }
  if (args.includes('--table')) console.table(rows);
  console.log(`${out.frames} frames @ ${out.fps.toFixed(2)} fps`);
  for (const ev of out.events) {
    const extra = ev.elapsed != null ? `  shot time ${ev.elapsed.toFixed(2)} s` : '';
    console.log(`${ev.videoTime.toFixed(2).padStart(7)} s  ${ev.type.padEnd(7)}${extra}`);
  }
  if (!out.events.some((e) => e.type === 'start')) console.log('No shot detected — check --roi, or lower --pix / --cov.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
