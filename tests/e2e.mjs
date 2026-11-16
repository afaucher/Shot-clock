#!/usr/bin/env node
// Browser end-to-end check using Playwright + Chromium.
//
//   node tests/e2e.mjs [--file shot.webm] [--camera shot.mjpeg] [--shots DIR] [--target 15]
//
// --file    loads the video through the "Video file" button
// --camera  feeds the video as a fake webcam (Chromium flag) and uses "Camera"
// Generate inputs with tests/make_test_video.py.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// require() so a globally installed playwright is found too
const { chromium } = createRequire(import.meta.url)('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const shotsDir = get('--shots');
const TARGET = Number(get('--target') ?? 15);

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css' };
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      const f = p.endsWith('/') ? path.join(p, 'index.html') : p;
      if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function waitForEvent(page, type, timeoutMs) {
  await page.waitForFunction((t) => window.shotClock.eventLog.some((e) => e.type === t), type, { timeout: timeoutMs });
}

async function runCase(name, { launchArgs = [], setup }) {
  const srv = await serve();
  const url = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', ...launchArgs] });
  const context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url);
  // OpenCV.js (~10 MB) must finish loading before a source can be chosen
  await page.waitForFunction(() => window.shotClock?.ready === true, null, { timeout: 60000 });
  try {
    await setup(page);
    // target before the synthetic clip's blonde point, so blonding is not "early"
    await page.fill('#optTarget', String(TARGET));
    await page.waitForFunction(() => !document.getElementById('btnArm').disabled, null, { timeout: 15000 });
    await page.click('#btnArm');
    await waitForEvent(page, 'armed', 10000);
    await waitForEvent(page, 'start', 20000);
    await waitForEvent(page, 'blonde', 35000);
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${name}-blonde.png`) });
    await waitForEvent(page, 'end', 15000);
    await page.waitForTimeout(300);
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${name}-done.png`), fullPage: true });
    const out = await page.evaluate(() => ({
      events: window.shotClock.eventLog.map((e) => ({ type: e.type, elapsed: e.elapsed })),
      sounds: window.shotClock.sounds.log,
      timer: document.getElementById('timer').textContent,
      phase: document.getElementById('phase').textContent,
      history: document.querySelectorAll('#history li .ribbon').length,
    }));
    const ev = Object.fromEntries(out.events.map((e) => [e.type, e]));
    const problems = [];
    const early = ev.blonde.elapsed < TARGET;
    const reached = TARGET < ev.end.elapsed;
    if (!out.sounds.includes(early ? 'blonde-early' : 'blonde')) problems.push(`expected ${early ? 'early ' : ''}blonde alert`);
    const pips = out.sounds.filter((s) => s === 'pip').length;
    const tgt = out.events.find((e) => e.type === 'target');
    if (reached) {
      if (pips !== 3) problems.push(`expected 3 countdown pips, got ${pips}`);
      if (!tgt || Math.abs(tgt.elapsed - TARGET) > 0.2) problems.push(`target fired at ${tgt?.elapsed}`);
    } else if (tgt) {
      problems.push('target fired although the shot ended first');
    }
    if (!out.sounds.includes('start')) problems.push('start sound not played');
    if (out.history < 1) problems.push('shot not saved to history');
    if (errors.length) problems.push('page errors: ' + errors.join(' | '));
    console.log(`[${name}] blonde @ ${ev.blonde.elapsed.toFixed(2)} s, total ${ev.end.elapsed.toFixed(2)} s, ` +
      `timer shows ${out.timer}, phase "${out.phase}", sounds: ${out.sounds.join(',')}`);
    return { name, ok: problems.length === 0, problems, ev };
  } catch (err) {
    if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${name}-fail.png`) });
    const log = await page.evaluate(() => window.shotClock?.eventLog).catch(() => null);
    return { name, ok: false, problems: [err.message.split('\n')[0], 'events: ' + JSON.stringify(log), ...errors] };
  } finally {
    await browser.close();
    srv.close();
  }
}

const cases = [];
const file = get('--file');
const cam = get('--camera');
if (!file && !cam) {
  console.error('usage: node tests/e2e.mjs [--file video.webm] [--camera video.mjpeg] [--shots DIR]');
  process.exit(1);
}
if (file) {
  cases.push(await runCase('file', {
    setup: (page) => page.setInputFiles('#fileInput', path.resolve(file)),
  }));
}
if (cam) {
  cases.push(await runCase('camera', {
    launchArgs: ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${path.resolve(cam)}`,
      '--use-fake-ui-for-media-stream'],
    setup: (page) => page.click('#btnCamera'),
  }));
}

let failed = false;
for (const c of cases) {
  if (!c.ok) { failed = true; console.log(`FAIL ${c.name}:\n  ${c.problems.join('\n  ')}`); }
  else console.log(`PASS ${c.name}`);
}
process.exit(failed ? 1 : 0);
