import { ShotDetector, DEFAULTS } from './detector.js';
import { sounds, unlockAudio, PumpListener } from './audio.js';

const $ = (id) => document.getElementById(id);
const el = {
  status: $('status'), stage: $('stage'), view: $('view'), hint: $('hint'), video: $('video'),
  btnCamera: $('btnCamera'), fileInput: $('fileInput'), btnArm: $('btnArm'),
  timer: $('timer'), swatch: $('swatch'), phase: $('phase'), blondeAt: $('blondeAt'),
  meterFill: $('meterFill'), chart: $('chart'),
  optTrigger: $('optTrigger'), optDelta: $('optDelta'), optPix: $('optPix'), optCov: $('optCov'),
  optBackup: $('optBackup'), optSound: $('optSound'), optSpeech: $('optSpeech'), optMask: $('optMask'),
  outDelta: $('outDelta'), outPix: $('outPix'), outCov: $('outCov'),
  btnTest: $('btnTest'), camInfo: $('camInfo'), micInfo: $('micInfo'), history: $('history'),
};

const PROC_W = 320; // processing resolution (width); plenty for a stream
const proc = document.createElement('canvas');
const pctx = proc.getContext('2d', { willReadFrequently: true });
const vctx = el.view.getContext('2d');
const maskCanvas = document.createElement('canvas');
const mctx = maskCanvas.getContext('2d');

// ---------------------------------------------------------------- storage
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
}

const settings = Object.assign({
  trigger: 'flow',
  blondeDelta: DEFAULTS.blondeDelta,
  pixelThreshold: DEFAULTS.pixelThreshold,
  flowCoverage: DEFAULTS.flowCoverage,
  backupAt: 0,
  sound: true,
  speech: true,
  showMask: true,
  roi: { x: 0.42, y: 0.35, w: 0.16, h: 0.35 },
}, load('shotclock.settings', {}));

const detector = new ShotDetector({
  blondeDelta: settings.blondeDelta,
  pixelThreshold: settings.pixelThreshold,
  flowCoverage: settings.flowCoverage,
});
const pump = new PumpListener();

let source = null;          // 'camera' | 'file'
let camTrack = null;
let wakeLock = null;
let backupFired = false;
let lastResult = null;
let alertTimer = null;
const eventLog = [];

// --------------------------------------------------------------- settings UI
function bindSettings() {
  el.optTrigger.value = settings.trigger;
  el.optDelta.value = settings.blondeDelta;
  el.optPix.value = settings.pixelThreshold;
  el.optCov.value = settings.flowCoverage;
  el.optBackup.value = settings.backupAt;
  el.optSound.checked = settings.sound;
  el.optSpeech.checked = settings.speech;
  el.optMask.checked = settings.showMask;
  const sync = () => {
    settings.trigger = el.optTrigger.value;
    settings.blondeDelta = +el.optDelta.value;
    settings.pixelThreshold = +el.optPix.value;
    settings.flowCoverage = +el.optCov.value;
    settings.backupAt = +el.optBackup.value || 0;
    settings.sound = el.optSound.checked;
    settings.speech = el.optSpeech.checked;
    settings.showMask = el.optMask.checked;
    el.outDelta.textContent = settings.blondeDelta;
    el.outPix.textContent = settings.pixelThreshold;
    el.outCov.textContent = Math.round(settings.flowCoverage * 100) + '%';
    detector.setOptions({
      blondeDelta: settings.blondeDelta,
      pixelThreshold: settings.pixelThreshold,
      flowCoverage: settings.flowCoverage,
    });
    sounds.enabled = settings.sound;
    sounds.speech = settings.speech;
    save('shotclock.settings', settings);
  };
  for (const k of ['optTrigger', 'optDelta', 'optPix', 'optCov', 'optBackup', 'optSound', 'optSpeech', 'optMask']) {
    el[k].addEventListener('input', sync);
    el[k].addEventListener('change', sync);
  }
  sync();
}

// ------------------------------------------------------------------ sources
async function startCamera() {
  unlockAudio();
  stopSource();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
    camTrack = stream.getVideoTracks()[0];
    el.video.srcObject = stream;
    el.video.loop = false;
    await el.video.play();
    source = 'camera';
    onSourceReady();
    describeCamera();
    requestWakeLock();
  } catch (err) {
    setStatus('Camera unavailable: ' + err.message);
  }
}

function openFile(file) {
  unlockAudio();
  stopSource();
  el.video.srcObject = null;
  el.video.src = URL.createObjectURL(file);
  el.video.loop = false;
  el.video.addEventListener('loadeddata', () => {
    source = 'file';
    onSourceReady();
    el.video.pause();
    el.video.currentTime = 0;
    el.camInfo.textContent = `Video file: ${el.video.videoWidth}×${el.video.videoHeight}, ${el.video.duration.toFixed(1)} s. Arm restarts it from the beginning.`;
  }, { once: true });
}

function stopSource() {
  if (el.video.srcObject) el.video.srcObject.getTracks().forEach((t) => t.stop());
  if (el.video.src) { URL.revokeObjectURL(el.video.src); el.video.removeAttribute('src'); }
  camTrack = null;
  source = null;
  detector.reset();
}

function onSourceReady() {
  const vw = el.video.videoWidth, vh = el.video.videoHeight;
  el.stage.style.aspectRatio = `${vw} / ${vh}`;
  const scale = Math.min(1, 960 / vw);
  el.view.width = Math.round(vw * scale);
  el.view.height = Math.round(vh * scale);
  proc.width = PROC_W;
  proc.height = Math.round(PROC_W * vh / vw);
  el.hint.hidden = true;
  el.btnArm.disabled = false;
  setStatus('Box the stream, then Arm');
  startLoop();
}

function describeCamera() {
  if (!camTrack) return;
  const s = camTrack.getSettings?.() || {};
  const caps = camTrack.getCapabilities?.() || {};
  const lockable = ['exposureMode', 'whiteBalanceMode', 'focusMode'].filter((k) => caps[k]?.includes?.('manual'));
  el.camInfo.textContent = `Camera: ${s.width}×${s.height} @ ${Math.round(s.frameRate || 0)} fps. ` +
    (lockable.length ? `Will lock ${lockable.join(', ').replace(/Mode/g, '')} when armed.`
      : 'This camera/browser cannot lock exposure or white balance; keep lighting steady.');
}

// Freeze auto exposure/white balance so the stream colour is comparable
// across the shot. Let it settle on "continuous" first, then lock.
async function lockCamera() {
  if (!camTrack?.getCapabilities) return;
  const caps = camTrack.getCapabilities();
  const keys = ['exposureMode', 'whiteBalanceMode', 'focusMode'];
  const cont = {}, manual = {};
  for (const k of keys) {
    if (caps[k]?.includes('continuous')) cont[k] = 'continuous';
    if (caps[k]?.includes('manual')) manual[k] = 'manual';
  }
  try {
    if (Object.keys(cont).length) await camTrack.applyConstraints({ advanced: [cont] });
    await new Promise((r) => setTimeout(r, 600));
    if (Object.keys(manual).length) await camTrack.applyConstraints({ advanced: [manual] });
  } catch { /* best effort */ }
}

// -------------------------------------------------------------------- arm
async function arm() {
  unlockAudio();
  clearAlert();
  backupFired = false;
  el.btnArm.disabled = true;
  if (source === 'file') {
    el.video.pause();
    el.video.currentTime = 0;
    await new Promise((r) => el.video.addEventListener('seeked', r, { once: true }));
    detector.arm();
    await el.video.play();
  } else if (source === 'camera') {
    setStatus('Locking camera…');
    await lockCamera();
    if (settings.trigger === 'pump') {
      try {
        if (!pump.active) await pump.start();
        pump.recalibrate();
        el.micInfo.textContent = 'Microphone listening for the pump. Keep the room quiet while armed.';
      } catch (err) {
        el.micInfo.textContent = 'Microphone unavailable (' + err.message + '); falling back to first drip.';
      }
    }
    detector.arm();
  }
  el.btnArm.disabled = false;
  el.btnArm.textContent = 'Re-arm';
  setStatus('Calibrating background — keep the box clear');
}

// ------------------------------------------------------------------- ROI
let drag = null;
function pointerPos(e) {
  const r = el.view.getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
}
el.view.addEventListener('pointerdown', (e) => {
  if (!source || detector.state === 'pouring') return;
  el.view.setPointerCapture(e.pointerId);
  drag = pointerPos(e);
});
el.view.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const p = pointerPos(e);
  settings.roi = { x: Math.min(drag.x, p.x), y: Math.min(drag.y, p.y), w: Math.abs(p.x - drag.x), h: Math.abs(p.y - drag.y) };
});
el.view.addEventListener('pointerup', () => {
  if (!drag) return;
  drag = null;
  if (settings.roi.w < 0.02 || settings.roi.h < 0.02) return;
  setRoi(settings.roi);
});

function setRoi(roi) {
  settings.roi = roi;
  save('shotclock.settings', settings);
  if (detector.state === 'calibrating' || detector.state === 'armed') detector.arm();
  else if (detector.state === 'done') detector.reset();
}

function roiPixels() {
  const r = settings.roi;
  const x = Math.round(r.x * proc.width), y = Math.round(r.y * proc.height);
  const w = Math.max(4, Math.min(proc.width - x, Math.round(r.w * proc.width)));
  const h = Math.max(4, Math.min(proc.height - y, Math.round(r.h * proc.height)));
  return { x, y, w, h };
}

// ------------------------------------------------------------------ loop
let loopRunning = false;
function startLoop() {
  if (loopRunning) return;
  loopRunning = true;
  const useRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  const tick = (now, meta) => {
    if (!source) { loopRunning = false; return; }
    const t = source === 'file' && meta ? meta.mediaTime : performance.now() / 1000;
    frame(t);
    if (useRVFC) el.video.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  };
  if (useRVFC) el.video.requestVideoFrameCallback(tick);
  else requestAnimationFrame(tick);
  // Keep the UI drawing even when the file is paused (no new frames).
  const idle = () => {
    if (!source) return;
    if (el.video.paused) drawView(roiPixels());
    requestAnimationFrame(idle);
  };
  requestAnimationFrame(idle);
}

function frame(t) {
  if (!el.video.videoWidth) return;
  pctx.drawImage(el.video, 0, 0, proc.width, proc.height);
  const r = roiPixels();
  const img = pctx.getImageData(r.x, r.y, r.w, r.h);
  const res = detector.process(img.data, r.w, r.h, t);

  // Pump-sound trigger (camera only)
  if (source === 'camera' && settings.trigger === 'pump' && pump.active) {
    const onset = pump.poll(t, detector.state === 'armed');
    if (onset != null && detector.externalTrigger(onset)) {
      res.events.push({ type: 'start', t: onset, elapsed: 0, via: 'pump' });
      res.state = detector.state;
    }
  }

  for (const ev of res.events) handleEvent(ev);

  const elapsed = detector.elapsed(t);
  if (settings.backupAt > 0 && detector.state === 'pouring' && !backupFired &&
      detector.blondeAt == null && elapsed >= settings.backupAt) {
    backupFired = true;
    sounds.backup();
    handleEvent({ type: 'backup', t, elapsed });
  }

  lastResult = { ...res, elapsed };
  updateReadout(lastResult);
  drawView(r);
  drawChart();
}

function handleEvent(ev) {
  eventLog.push(ev);
  switch (ev.type) {
    case 'armed':
      setStatus(settings.trigger === 'pump' && pump.active ? 'Ready — listening for the pump' : 'Ready — start your shot');
      break;
    case 'start':
      sounds.start();
      setStatus(ev.via === 'pump' ? 'Pump on — waiting for first drip' : 'Pouring');
      break;
    case 'flow':
      setStatus('Pouring');
      break;
    case 'blonde':
      sounds.blonde();
      setStatus(`Blonding at ${ev.elapsed.toFixed(1)} s — cut the shot!`);
      document.body.classList.add('alerting');
      clearTimeout(alertTimer);
      alertTimer = setTimeout(clearAlert, 3500);
      break;
    case 'end':
      sounds.end();
      setStatus(`Done — ${ev.elapsed.toFixed(1)} s. Re-arm for the next shot.`);
      saveShot();
      break;
    case 'backup':
      setStatus(`Backup alert at ${ev.elapsed.toFixed(0)} s`);
      break;
  }
}

function clearAlert() { document.body.classList.remove('alerting'); }

// --------------------------------------------------------------- drawing
function updateReadout(res) {
  el.timer.textContent = res.elapsed.toFixed(1);
  el.phase.textContent = res.phase;
  if (res.rgb && detector.state === 'pouring') el.swatch.style.background = `rgb(${res.rgb.join(',')})`;
  el.blondeAt.textContent = detector.blondeAt != null ? `blonde @ ${detector.blondeAt.toFixed(1)} s` : '';
  // meter: 80% mark = blonde threshold
  el.meterFill.style.width = Math.min(100, res.progress * 80) + '%';
}

function drawView(r) {
  const W = el.view.width, H = el.view.height;
  vctx.drawImage(el.video, 0, 0, W, H);
  const sx = W / proc.width, sy = H / proc.height;
  const rx = r.x * sx, ry = r.y * sy, rw = r.w * sx, rh = r.h * sy;

  if (settings.showMask && detector.mask && detector.state !== 'idle' && detector.state !== 'calibrating' &&
      detector.mask.length === r.w * r.h) {
    maskCanvas.width = r.w; maskCanvas.height = r.h;
    const mi = mctx.createImageData(r.w, r.h);
    for (let i = 0; i < detector.mask.length; i++) {
      if (detector.mask[i]) { mi.data[i * 4] = 60; mi.data[i * 4 + 1] = 255; mi.data[i * 4 + 2] = 120; mi.data[i * 4 + 3] = 110; }
    }
    mctx.putImageData(mi, 0, 0);
    vctx.imageSmoothingEnabled = false;
    vctx.drawImage(maskCanvas, rx, ry, rw, rh);
    vctx.imageSmoothingEnabled = true;
  }

  const colors = { idle: '#ffffff', calibrating: '#ffd166', armed: '#7bd389', pouring: '#e0a458', done: '#9aa5b1' };
  vctx.lineWidth = Math.max(2, W / 320);
  vctx.strokeStyle = document.body.classList.contains('alerting') ? '#ff4d4d' : colors[detector.state];
  vctx.setLineDash(detector.state === 'idle' ? [8, 6] : []);
  vctx.strokeRect(rx, ry, rw, rh);
  vctx.setLineDash([]);
}

function drawChart() {
  const c = el.chart;
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.round(c.clientWidth * dpr), ch = Math.round(180 * dpr);
  if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
  const g = c.getContext('2d');
  g.clearRect(0, 0, cw, ch);
  const pad = 6 * dpr, ribbonH = 34 * dpr, axisH = 14 * dpr;
  const plotTop = pad, plotBot = ch - ribbonH - axisH - pad;
  const samples = detector.samples;
  const elapsed = lastResult ? lastResult.elapsed : 0;
  const tMax = Math.max(30, Math.ceil(elapsed + 2));
  const X = (t) => pad + (t / tMax) * (cw - 2 * pad);
  // paleness (L* - C*) runs roughly -30 (dark, saturated) .. +80 (pale)
  const Y = (P) => plotBot - ((Math.max(-30, Math.min(80, P)) + 30) / 110) * (plotBot - plotTop);

  // grid + axis labels every 5 s
  g.fillStyle = '#6f6257';
  g.font = `${10 * dpr}px system-ui`;
  g.strokeStyle = '#2a211b';
  g.lineWidth = 1;
  for (let s = 0; s <= tMax; s += 5) {
    const x = X(s);
    g.beginPath(); g.moveTo(x, plotTop); g.lineTo(x, ch - axisH); g.stroke();
    if (x + 24 * dpr < cw) g.fillText(s + 's', x + 2 * dpr, ch - 3 * dpr);
  }

  // colour ribbon
  const ribTop = ch - ribbonH - axisH;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const x0 = X(s.t), x1 = i + 1 < samples.length ? X(samples[i + 1].t) : x0 + 2 * dpr;
    g.fillStyle = `rgb(${s.rgb.join(',')})`;
    g.fillRect(x0, ribTop, Math.max(1, x1 - x0 + 0.5), ribbonH);
  }

  // threshold
  if (detector.refP != null) {
    const y = Y(detector.refP + detector.opts.blondeDelta);
    g.strokeStyle = '#ffd166';
    g.setLineDash([6 * dpr, 4 * dpr]);
    g.beginPath(); g.moveTo(pad, y); g.lineTo(cw - pad, y); g.stroke();
    g.setLineDash([]);
  }

  // lightness line
  if (samples.length > 1) {
    g.strokeStyle = '#f3e9df';
    g.lineWidth = 2 * dpr;
    g.beginPath();
    samples.forEach((s, i) => (i ? g.lineTo(X(s.t), Y(s.P)) : g.moveTo(X(s.t), Y(s.P))));
    g.stroke();
  }

  // blonde marker
  if (detector.blondeAt != null) {
    const x = X(detector.blondeAt);
    g.strokeStyle = '#ff4d4d';
    g.lineWidth = 2 * dpr;
    g.beginPath(); g.moveTo(x, plotTop); g.lineTo(x, ch - axisH); g.stroke();
  }
}

// --------------------------------------------------------------- history
function saveShot() {
  const s = detector.samples;
  const N = 48;
  const ribbon = [];
  for (let i = 0; i < N && s.length; i++) ribbon.push(s[Math.floor(i * s.length / N)].rgb);
  const hist = load('shotclock.history', []);
  hist.unshift({ when: Date.now(), total: detector.elapsed(0), blondeAt: detector.blondeAt, ribbon });
  save('shotclock.history', hist.slice(0, 20));
  renderHistory();
}

function renderHistory() {
  const hist = load('shotclock.history', []);
  el.history.innerHTML = '';
  if (!hist.length) {
    el.history.innerHTML = '<li class="empty">No shots yet.</li>';
    return;
  }
  for (const h of hist.slice(0, 10)) {
    const li = document.createElement('li');
    const when = new Date(h.when).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    li.innerHTML = `<b>${h.total.toFixed(1)} s</b><span>${when}${h.blondeAt != null ? ` · blonde @ ${h.blondeAt.toFixed(1)} s` : ''}</span>`;
    const rib = document.createElement('div');
    rib.className = 'ribbon';
    if (h.ribbon.length) rib.style.background = `linear-gradient(90deg, ${h.ribbon.map((c) => `rgb(${c.join(',')})`).join(',')})`;
    li.appendChild(rib);
    el.history.appendChild(li);
  }
}

function setStatus(text) { el.status.textContent = text; }

// ------------------------------------------------------------------ wire up
el.btnCamera.addEventListener('click', startCamera);
el.fileInput.addEventListener('change', () => { if (el.fileInput.files[0]) openFile(el.fileInput.files[0]); });
el.btnArm.addEventListener('click', arm);
el.btnTest.addEventListener('click', () => { unlockAudio(); sounds.blonde(); });
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && source === 'camera' && !wakeLock) {
    requestWakeLock();
  }
});

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
    wakeLock?.addEventListener('release', () => { wakeLock = null; });
  } catch { /* optional */ }
}

bindSettings();
renderHistory();

// Exposed for automated tests and console tinkering.
window.shotClock = { detector, sounds, settings, setRoi, eventLog, get result() { return lastResult; } };
