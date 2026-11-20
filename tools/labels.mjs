// Helpers for hand labels from the Shot Labeller artifact (claude.ai), whose
// database holds one document per video in the collection "shots". Dump it
// to a folder of JSON files (one per document) or a single JSON array, then:
//
//   node tools/labels.mjs LABELS --dir FOLDER   # which video file each label set belongs to, and a summary
//
// LABELS is a folder of <doc>.json files, a JSON array of records, or
// { videos: [...] }.
// Labels are matched to videos by file name, then by fingerprint (average
// hashes of 16x16 gray frames at 1, 3 and 5 s, the same as the labeller
// computes), so renamed downloads still match.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv)$/i;

function duration(file) {
  return +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim();
}

export function fingerprint(file) {
  const d = duration(file);
  return [1, 3, 5].map((at) => {
    const t = Math.min(at, Math.max(0, d - 0.1));
    const px = execFileSync('ffmpeg', ['-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
      '-vf', 'scale=16:16:flags=area,format=gray', '-f', 'rawvideo', '-']);
    const mean = px.reduce((a, b) => a + b, 0) / 256;
    let hex = '';
    for (let i = 0; i < 256; i += 4) hex += ((px[i] > mean) << 3 | (px[i + 1] > mean) << 2 | (px[i + 2] > mean) << 1 | (px[i + 3] > mean)).toString(16);
    return hex;
  });
}

function hamming(a, b) {
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { n += x & 1; x >>= 1; } }
  return n;
}
/** Bits that differ between two fingerprints (0..768). Same video: usually < 60. */
export function fingerprintDistance(a, b) {
  return a.reduce((s, h, i) => s + hamming(h, b[i] || ''), 0);
}

/** Map each labelled video to a file in `dir`: { record, file, how } (file null when not found). */
export function matchVideos(exported, dir) {
  const files = fs.readdirSync(dir).filter((f) => VIDEO_EXT.test(f)).map((f) => path.join(dir, f));
  const byName = new Map(files.map((f) => [path.basename(f), f]));
  const prints = new Map();
  const fp = (f) => { if (!prints.has(f)) { try { prints.set(f, fingerprint(f)); } catch { prints.set(f, null); } } return prints.get(f); };
  return exported.videos.map((record) => {
    const named = byName.get(record.name);
    if (named) return { record, file: named, how: 'name' };
    if (!record.fingerprint) return { record, file: null, how: 'no fingerprint' };
    let best = null;
    for (const f of files) {
      const p = fp(f);
      if (!p) continue;
      const d = fingerprintDistance(record.fingerprint, p);
      if (!best || d < best.d) best = { f, d };
    }
    return best && best.d < 120 ? { record, file: best.f, how: `fingerprint (${best.d} bits differ)` } : { record, file: null, how: 'not found' };
  });
}

/**
 * Turn one labelled video into the clip + stream-label shape tools/eval.mjs uses.
 * Each keyframe line becomes a mark { x: centre, y: [top, bottom] }.
 */
export function toEvalClip(record) {
  const ev = record.events || {};
  const first = ev.firstDrop;
  // The live app is armed before the pump; give the tracker 1.5 s of scene
  // before the first drop. A video that starts with coffee already flowing
  // (first drop in the first second) should produce no start.
  const startsMidShot = first == null || first < 1.0;
  const marks = {};
  for (const [t, lines] of Object.entries(record.keyframes || {})) {
    marks[t] = lines.map((l) => ({ x: +((l.x0 + l.x1) / 2).toFixed(3), y: [Math.min(l.y0, l.y1), Math.max(l.y0, l.y1)] }));
  }
  return {
    clip: {
      id: record.name,
      spouts: record.info?.spouts || 2,
      armAt: startsMidShot ? 0.5 : Math.max(0.3, Math.min(1.0, first - 1.5)),
      firstLiquid: startsMidShot ? null : first,
      startsMidShot,
      recordedPastPumpOff: ev.end != null && ev.end < (record.duration || Infinity) - 1,
      pump: ev.end != null ? { off: ev.end } : undefined,
      cut: ev.cut ?? null,
      info: record.info || {},
    },
    labels: { marks },
  };
}

const unwrap = (d) => (d && d.data && d.data.key ? d.data : d);
export function loadExport(src) {
  let videos;
  if (fs.statSync(src).isDirectory()) {
    const files = [];
    const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.json')) files.push(p); } };
    walk(src);
    videos = files.map((f) => unwrap(JSON.parse(fs.readFileSync(f, 'utf8'))));
  } else {
    const data = JSON.parse(fs.readFileSync(src, 'utf8'));
    videos = (Array.isArray(data) ? data : data.videos || data.documents || []).map(unwrap);
  }
  videos = videos.filter((v) => v && v.key && v.events);
  if (!videos.length) throw new Error(`no labelled videos found in ${src}`);
  return { videos };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const di = args.indexOf('--dir');
  const file = args.find((a, i) => !a.startsWith('--') && i !== di + 1);
  if (!file) { console.error('usage: node tools/labels.mjs LABELS [--dir FOLDER]'); process.exit(1); }
  const data = loadExport(file);
  const rows = di >= 0 ? matchVideos(data, args[di + 1]) : data.videos.map((record) => ({ record, file: null, how: '' }));
  let usable = 0, kf = 0, lines = 0;
  for (const { record: r, file: f, how } of rows) {
    const n = Object.keys(r.keyframes || {}).length;
    const l = Object.values(r.keyframes || {}).reduce((a, x) => a + x.length, 0);
    if (!r.info?.skip) { usable++; kf += n; lines += l; }
    const ev = r.events || {};
    console.log(`${r.info?.skip ? 'SKIP ' : ''}${r.name}: first ${ev.firstDrop ?? '-'} end ${ev.end ?? '-'} cut ${ev.cut ?? '-'} | ${n} keyframes, ${l} lines${di >= 0 ? ` | ${f ? path.basename(f) + ' by ' + how : how}` : ''}`);
  }
  console.log(`${usable} usable videos, ${kf} keyframes, ${lines} stream lines`);
}
