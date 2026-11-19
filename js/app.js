import { StreamTracker, TRACKER_DEFAULTS } from './tracker.js';
import { sounds, unlockAudio } from './audio.js';
import { buildReport } from './report.js';

const $ = (id) => document.getElementById(id);
const el = {
  status: $('status'), stage: $('stage'), view: $('view'), hint: $('hint'), video: $('video'),
  btnCamera: $('btnCamera'), fileInput: $('fileInput'), lblFile: $('lblFile'), btnArm: $('btnArm'), btnStop: $('btnStop'),
  timer: $('timer'), swatches: $('swatches'), phase: $('phase'), blondeAt: $('blondeAt'),
  meterFill: $('meterFill'), chart: $('chart'),
  optDelta: $('optDelta'), outDelta: $('outDelta'), optTarget: $('optTarget'), optStreams: $('optStreams'),
  optSound: $('optSound'), optSpeech: $('optSpeech'), optMask: $('optMask'),
  btnTest: $('btnTest'), camInfo: $('camInfo'), perfInfo: $('perfInfo'), history: $('history'),
};

const AREA = 270 * 480;      // working resolution (pixels) the tracker is tuned for
const STREAM_COLORS = ['#f3e9df', '#7fc8f8', '#ffd166', '#c39bd3'];
const proc = document.createElement('canvas');
const pctx = proc.getContext('2d', { willReadFrequently: true });
const vctx = el.view.getContext('2d');

// ---------------------------------------------------------------- storage
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
}

const settings = Object.assign({
  blondeDelta: TRACKER_DEFAULTS.blondeDelta,
  targetAt: 25,
  maxStreams: 2,
  sound: false,       // alerts (sounds, vibration, flash): off by default, the app reports
  speech: false,
  showMask: true,
}, load('shotclock.settings.v3', {}));

let cv = null;
let tracker = null;
let source = null;          // 'camera' | 'file'
let camTrack = null;
let wakeLock = null;
let lastPip = null;
let targetFired = false;
let startAnnounced = false;
let lastResult = null;
let alertTimer = null;
let procMs = 0;
let lastFrameT = null;
const eventLog = [];

// ------------------------------------------------------------ OpenCV.js
function loadOpenCv() {
  return new Promise((resolve, reject) => {
    const script = $('cvScript');
    const ready = () => {
      const m = window.cv;
      if (!m) return false;
      const done = () => {
        // This Emscripten build's `then` resolves to itself; drop it so the
        // module can be passed through promises without hanging.
        delete m.then;
        resolve(m);
      };
      if (m.Mat) done(); else m.onRuntimeInitialized = done;
      return true;
    };
    if (!ready()) {
      script.addEventListener('load', () => { if (!ready()) reject(new Error('OpenCV.js did not initialise')); });
      script.addEventListener('error', () => reject(new Error('could not load vendor/opencv-4.10.0.js')));
    }
  });
}

// --------------------------------------------------------------- settings UI
function bindSettings() {
  el.optDelta.value = settings.blondeDelta;
  el.optTarget.value = settings.targetAt;
  el.optStreams.value = String(settings.maxStreams);
  el.optSound.checked = settings.sound;
  el.optSpeech.checked = settings.speech;
  el.optMask.checked = settings.showMask;
  const sync = () => {
    settings.blondeDelta = +el.optDelta.value;
    settings.targetAt = Math.max(0, +el.optTarget.value || 0);
    settings.maxStreams = Math.max(1, Math.min(3, +el.optStreams.value || 2));
    settings.sound = el.optSound.checked;
    settings.speech = el.optSpeech.checked;
    settings.showMask = el.optMask.checked;
    el.outDelta.textContent = settings.blondeDelta;
    tracker?.setOptions({ blondeDelta: settings.blondeDelta, maxStreams: settings.maxStreams });
    sounds.enabled = settings.sound;
    sounds.speech = settings.speech;
    save('shotclock.settings.v3', settings);
  };
  for (const k of ['optDelta', 'optTarget', 'optStreams', 'optSound', 'optSpeech', 'optMask']) {
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
    el.camInfo.textContent = `Video file: ${el.video.videoWidth}×${el.video.videoHeight}, ${el.video.duration.toFixed(1)} s. `
      + 'Arm plays it from the beginning; the first second should show no coffee.';
  }, { once: true });
}

function stopSource() {
  if (el.video.srcObject) el.video.srcObject.getTracks().forEach((t) => t.stop());
  if (el.video.src) { URL.revokeObjectURL(el.video.src); el.video.removeAttribute('src'); }
  camTrack = null;
  source = null;
  tracker?.reset();
}

function onSourceReady() {
  const vw = el.video.videoWidth, vh = el.video.videoHeight;
  el.stage.style.aspectRatio = `${vw} / ${vh}`;
  const scale = Math.min(1, 960 / Math.max(vw, vh));
  el.view.width = Math.round(vw * scale);
  el.view.height = Math.round(vh * scale);
  // keep the working area constant whatever the aspect ratio
  const w = Math.sqrt(AREA * vw / vh);
  proc.width = Math.round(w / 2) * 2;
  proc.height = Math.round(AREA / w / 2) * 2;
  el.hint.hidden = true;
  el.btnArm.disabled = false;
  setStatus('Press Arm before you start the shot');
  startLoop();
}

function describeCamera() {
  if (!camTrack) return;
  const s = camTrack.getSettings?.() || {};
  const caps = camTrack.getCapabilities?.() || {};
  const lockable = ['exposureMode', 'whiteBalanceMode'].filter((k) => caps[k]?.includes?.('manual'));
  el.camInfo.textContent = `Camera: ${s.width}×${s.height} @ ${Math.round(s.frameRate || 0)} fps. ` +
    (lockable.length ? `Will lock ${lockable.join(', ').replace(/Mode/g, '')} when armed.`
      : 'This camera/browser cannot lock exposure or white balance.');
}

// Freeze auto exposure/white balance so colours are comparable through the shot.
async function lockCamera() {
  if (!camTrack?.getCapabilities) return;
  const caps = camTrack.getCapabilities();
  const cont = {}, manual = {};
  for (const k of ['exposureMode', 'whiteBalanceMode']) {
    if (caps[k]?.includes('continuous')) cont[k] = 'continuous';
    if (caps[k]?.includes('manual')) manual[k] = 'manual';
  }
  try {
    if (Object.keys(cont).length) await camTrack.applyConstraints({ advanced: [cont] });
    await new Promise((r) => setTimeout(r, 500));
    if (Object.keys(manual).length) await camTrack.applyConstraints({ advanced: [manual] });
  } catch { /* best effort */ }
}

// -------------------------------------------------------------------- arm
async function arm() {
  unlockAudio();
  clearAlert();
  targetFired = false;
  startAnnounced = false;
  lastPip = null;
  el.btnArm.disabled = true;
  if (source === 'file') {
    el.video.pause();
    el.video.currentTime = 0;
    await new Promise((r) => el.video.addEventListener('seeked', r, { once: true }));
    lastFrameT = null;
    tracker.arm();
    await el.video.play();
  } else if (source === 'camera') {
    setStatus('Locking camera…');
    await lockCamera();
    tracker.arm();
  }
  el.btnArm.disabled = false;
  el.btnStop.disabled = false;
  el.btnArm.textContent = 'Re-arm';
  setStatus('Hold steady — learning the scene');
}

function stopShot() {
  if (!tracker) return;
  if (tracker.state === 'pouring') {
    tracker.state = 'done';
    tracker.tEnd = lastFrameT ?? tracker.lastT;
    handleEvent({ type: 'end', t: tracker.tEnd, elapsed: tracker.tEnd - tracker.shotStart, manual: true });
  } else if (tracker.state === 'armed' || tracker.state === 'learning') {
    tracker.reset();
    setStatus('Stopped. Press Arm for the next shot.');
  }
  el.btnStop.disabled = true;
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
    if (lastFrameT == null || t > lastFrameT) frame(t);
    if (useRVFC) el.video.requestVideoFrameCallback(tick);
    else requestAnimationFrame(tick);
  };
  if (useRVFC) el.video.requestVideoFrameCallback(tick);
  else requestAnimationFrame(tick);
  const idle = () => {
    if (!source) return;
    if (el.video.paused) drawView();
    requestAnimationFrame(idle);
  };
  requestAnimationFrame(idle);
}

function frame(t) {
  if (!el.video.videoWidth || !tracker) return;
  lastFrameT = t;
  pctx.drawImage(el.video, 0, 0, proc.width, proc.height);
  const img = pctx.getImageData(0, 0, proc.width, proc.height);
  const t0 = performance.now();
  const res = tracker.process(img.data, proc.width, proc.height, t);
  procMs = procMs * 0.9 + (performance.now() - t0) * 0.1;

  for (const ev of res.events) handleEvent(ev);

  const elapsed = tracker.elapsed(t);
  const target = settings.targetAt;
  if (target > 0 && tracker.state === 'pouring' && !targetFired) {
    const left = target - elapsed;
    const sec = Math.ceil(left);
    if (left > 0 && sec <= 3 && sec !== lastPip) {
      lastPip = sec;
      sounds.pip();
    }
    if (left <= 0) {
      targetFired = true;
      sounds.target(target);
      handleEvent({ type: 'target', t, elapsed });
    }
  }

  lastResult = { ...res, elapsed };
  updateReadout(lastResult);
  drawView();
  drawChart();
  el.perfInfo.textContent = `Vision: ${procMs.toFixed(0)} ms/frame at ${proc.width}×${proc.height}, ${tracker.fps.toFixed(0)} fps.`;
}

function handleEvent(ev) {
  eventLog.push(ev);
  switch (ev.type) {
    case 'armed':
      setStatus('Ready — start your shot');
      break;
    case 'relearn':
      setStatus('Camera moved — re-learning the scene, hold steady');
      break;
    case 'start':
      sounds.start();
      startAnnounced = true;
      setStatus('Pouring');
      break;
    case 'blonde': {
      const early = settings.targetAt > 0 && ev.elapsed < settings.targetAt;
      sounds.blonde(early);
      setStatus(early
        ? `Blonding early at ${ev.elapsed.toFixed(1)} s (target ${settings.targetAt} s) — cut the shot`
        : `Blonding at ${ev.elapsed.toFixed(1)} s — cut the shot!`);
      flash(3500);
      break;
    }
    case 'target':
      if (tracker.blondeAt == null) setStatus(`${settings.targetAt} s — target reached`);
      flash(2000);
      break;
    case 'end':
      sounds.end();
      setStatus(`Done — ${ev.elapsed.toFixed(1)} s. Re-arm for the next shot.`);
      el.btnStop.disabled = true;
      saveShot();
      break;
  }
}

function flash(ms) {
  if (!settings.sound) return;        // part of the alerts
  document.body.classList.add('alerting');
  clearTimeout(alertTimer);
  alertTimer = setTimeout(clearAlert, ms);
}
function clearAlert() { document.body.classList.remove('alerting'); }

const PHASES = { idle: 'Idle', learning: 'Learning scene…', armed: 'Ready', pouring: 'Pouring', done: 'Done' };

function updateReadout(res) {
  const provisional = res.state === 'armed' && res.provisional != null;
  el.timer.textContent = (provisional ? res.provisional : res.elapsed).toFixed(1);
  el.timer.classList.toggle('provisional', provisional);
  let phase = PHASES[res.state];
  if (provisional) phase = 'Coffee spotted…';
  if (res.state === 'pouring' && tracker.blondeAt != null) phase = 'Blonde';
  el.phase.textContent = phase;

  // one swatch per stream currently seen
  const dets = res.detections || [];
  const html = dets.slice(0, 4).map((d) => `<span class="swatch" title="stream ${d.stream.id}" style="background:rgb(${d.rgb.join(',')});border-color:${STREAM_COLORS[(d.stream.id - 1) % 4]}"></span>`).join('');
  if (res.state === 'pouring' || res.state === 'armed') el.swatches.innerHTML = html;

  const tgt = settings.targetAt;
  const parts = [];
  if (tgt > 0) parts.push(`target ${tgt} s`);
  if (tracker.blondeAt != null) {
    parts.push(`blonde @ ${tracker.blondeAt.toFixed(1)} s${tgt > 0 && tracker.blondeAt < tgt ? ' (early)' : ''}`);
  }
  el.blondeAt.textContent = parts.join(' · ');
  el.timer.classList.toggle('near', tgt > 0 && res.state === 'pouring' && res.elapsed >= tgt - 3 && res.elapsed < tgt);
  el.meterFill.style.width = Math.min(100, res.progress * 80) + '%';
}

function drawView() {
  const W = el.view.width, H = el.view.height;
  if (!W) return;
  vctx.drawImage(el.video, 0, 0, W, H);
  if (!tracker || !settings.showMask) return;
  const sx = W / proc.width, sy = H / proc.height;
  const dets = lastResult?.detections || [];
  const Ti = tracker.state === 'idle' ? null : invert(tracker.T);
  if (!Ti || !dets.length) return;
  for (const d of dets) {
    const color = STREAM_COLORS[(d.stream.id - 1) % 4];
    vctx.fillStyle = 'rgba(80, 255, 140, 0.8)';
    const step = Math.max(1, Math.floor(d.core.length / 400));
    for (let k = 0; k < d.core.length; k += step) {
      const i = d.core[k];
      const x = i % proc.width, y = (i / proc.width) | 0;
      const fx = Ti[0] * x + Ti[1] * y + Ti[2], fy = Ti[3] * x + Ti[4] * y + Ti[5];
      vctx.fillRect(fx * sx - 1, fy * sy - 1, 2, 2);
    }
    const [bx, by, bw, bh] = d.box;
    const corners = [[bx, by], [bx + bw, by], [bx + bw, by + bh], [bx, by + bh]]
      .map(([x, y]) => [(Ti[0] * x + Ti[1] * y + Ti[2]) * sx, (Ti[3] * x + Ti[4] * y + Ti[5]) * sy]);
    vctx.strokeStyle = color;
    vctx.lineWidth = Math.max(2, W / 360);
    vctx.beginPath();
    corners.forEach(([x, y], k) => (k ? vctx.lineTo(x, y) : vctx.moveTo(x, y)));
    vctx.closePath();
    vctx.stroke();
    vctx.fillStyle = `rgb(${d.rgb.join(',')})`;
    vctx.fillRect(corners[0][0], corners[0][1] - 18, 16, 14);
    vctx.strokeRect(corners[0][0], corners[0][1] - 18, 16, 14);
  }
}

function invert(T) {
  const [a, b, c, d, e, f] = T;
  const det = a * e - b * d;
  const ia = e / det, ib = -b / det, id = -d / det, ie = a / det;
  return [ia, ib, -(ia * c + ib * f), id, ie, -(id * c + ie * f)];
}

function drawChart() {
  const c = el.chart;
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.round(c.clientWidth * dpr), ch = Math.round(180 * dpr);
  if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
  const g = c.getContext('2d');
  g.clearRect(0, 0, cw, ch);
  const pad = 6 * dpr, ribbonH = 26 * dpr, axisH = 14 * dpr;
  const plotTop = pad, plotBot = ch - ribbonH - axisH - pad;
  const elapsed = lastResult ? lastResult.elapsed : 0;
  const tMax = Math.max(30, Math.ceil(elapsed + 2), settings.targetAt + 3);
  const X = (t) => pad + (t / tMax) * (cw - 2 * pad);
  const Y = (P) => plotBot - ((Math.max(-30, Math.min(70, P)) + 30) / 100) * (plotBot - plotTop);

  g.fillStyle = '#6f6257';
  g.font = `${10 * dpr}px system-ui`;
  g.strokeStyle = '#2a211b';
  g.lineWidth = 1;
  for (let s = 0; s <= tMax; s += 5) {
    const x = X(s);
    g.beginPath(); g.moveTo(x, plotTop); g.lineTo(x, ch - axisH); g.stroke();
    if (x + 24 * dpr < cw) g.fillText(s + 's', x + 2 * dpr, ch - 3 * dpr);
  }
  if (!tracker || tracker.shotStart == null) return;
  const t0 = tracker.shotStart;
  const most = Math.max(0, ...tracker.streams.map((s) => s.samples.length));
  const streams = tracker.streams.filter((s) => s.samples.length > 3 && s.samples.length >= 0.25 * most);

  // colour ribbon of the stream with the most samples
  const main = streams.slice().sort((a, b) => b.samples.length - a.samples.length)[0];
  if (main) {
    const ribTop = ch - ribbonH - axisH;
    const sm = main.samples;
    const win = [];
    for (let i = 0; i < sm.length; i++) {
      win.push(sm[i].rgb);
      while (win.length > 1 && sm[i].t - sm[i - win.length + 1].t > 0.7) win.shift();
      const tt = sm[i].t - t0;
      if (tt < 0) continue;
      // 0.7 s per-channel median, so single noisy samples don't stripe the ribbon
      const rgb = [0, 1, 2].map((c) => win.map((q) => q[c]).sort((p, q) => p - q)[win.length >> 1]);
      const x0 = X(tt), x1 = i + 1 < sm.length ? X(sm[i + 1].t - t0) : x0 + 2 * dpr;
      g.fillStyle = `rgb(${rgb.join(',')})`;
      g.fillRect(x0, ribTop, Math.max(1, x1 - x0 + 0.5), ribbonH);
    }
  }

  // paleness per stream (1 s median for readability)
  for (const s of streams) {
    g.strokeStyle = STREAM_COLORS[(s.id - 1) % 4];
    g.lineWidth = 1.6 * dpr;
    g.beginPath();
    let started = false;
    const win = [];
    for (const p of s.samples) {
      const tt = p.t - t0;
      win.push(p);
      while (win.length && p.t - win[0].t > 1) win.shift();
      if (tt < 0) continue;
      const med = win.map((q) => q.P).sort((a, b) => a - b)[win.length >> 1];
      if (started) g.lineTo(X(tt), Y(med)); else { g.moveTo(X(tt), Y(med)); started = true; }
    }
    g.stroke();
    if (s.baseline != null) {
      g.setLineDash([5 * dpr, 4 * dpr]);
      g.lineWidth = 1 * dpr;
      const y = Y(s.baseline + tracker.opts.blondeDelta);
      g.beginPath(); g.moveTo(pad, y); g.lineTo(cw - pad, y); g.stroke();
      g.setLineDash([]);
    }
  }

  if (settings.targetAt > 0) {
    const x = X(settings.targetAt);
    g.strokeStyle = '#7bd389';
    g.lineWidth = 1.5 * dpr;
    g.setLineDash([3 * dpr, 3 * dpr]);
    g.beginPath(); g.moveTo(x, plotTop); g.lineTo(x, ch - axisH); g.stroke();
    g.setLineDash([]);
  }
  if (tracker.blondeAt != null) {
    const x = X(tracker.blondeAt);
    g.strokeStyle = '#ff4d4d';
    g.lineWidth = 2 * dpr;
    g.beginPath(); g.moveTo(x, plotTop); g.lineTo(x, ch - axisH); g.stroke();
  }
}

// --------------------------------------------------------------- history
let reportIdx = null;       // which history entry the report panel shows

function saveShot() {
  const report = buildReport(tracker, { target: settings.targetAt, maxStreams: settings.maxStreams });
  const main = tracker.streams.slice().sort((a, b) => b.samples.length - a.samples.length)[0];
  const s = (main?.samples || []).filter((p) => p.t >= tracker.shotStart);
  const N = 48;
  const ribbon = [];
  for (let i = 0; i < N && s.length; i++) ribbon.push(s[Math.floor(i * s.length / N)].rgb);
  const hist = load('shotclock.history', []);
  hist.unshift({ when: Date.now(), total: tracker.elapsed(0), blondeAt: tracker.blondeAt,
    target: settings.targetAt || null, streams: tracker.streams.filter((x) => x.samples.length > 30).length, ribbon,
    report, mine: {} });
  save('shotclock.history', hist.slice(0, 20));
  showReport(0);
}

// ------------------------------------------------------------- report
const rep = {
  panel: $('report'), when: $('repWhen'), dur: $('repDur'), timing: $('repTiming'), streams: $('repStreams'),
  balance: $('repBalance'), notes: $('repNotes'),
  dose: $('noteDose'), yld: $('noteYield'), grind: $('noteGrind'), taste: $('noteTaste'), text: $('noteText'),
};

function showReport(idx) {
  const hist = load('shotclock.history', []);
  const h = hist[idx];
  reportIdx = idx;
  renderHistory();
  if (!h?.report) { rep.panel.hidden = true; return; }
  const r = h.report;
  rep.panel.hidden = false;
  rep.when.textContent = new Date(r.when).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  rep.dur.textContent = `${r.duration.toFixed(1)} s${r.endedBy === 'stopped' ? '+' : ''}`;
  rep.timing.textContent = r.timing ? `${r.timing}${r.target ? ` (target ${r.target} s)` : ''}` : (r.endedBy === 'stopped' ? 'stopped early' : '');
  rep.timing.className = 'pill' + (r.timing === 'on target' ? ' on' : r.timing ? ' off' : '');
  rep.timing.hidden = !rep.timing.textContent;

  rep.streams.innerHTML = '';
  const tMax = Math.max(r.duration + 1, (r.target || 0) + 2, 20);
  for (const s of r.streams) {
    const div = document.createElement('div');
    div.className = 'rep-stream';
    const c = document.createElement('canvas');
    div.appendChild(c);
    const p = s.profile || {};
    const bits = [];
    if (p.caramelAt != null) bits.push(`turned caramel at ${p.caramelAt.toFixed(0)} s`);
    else if (s.firstSeen > 2) bits.push(`seen from ${s.firstSeen.toFixed(0)} s`);
    if (p.earlyShare != null) bits.push(`${Math.round(p.earlyShare * 100)}% of its lightening by 6 s`);
    if (p.paleRise != null) bits.push(`paler by ${p.paleRise.toFixed(0)} through the shot`);
    const txt = document.createElement('p');
    txt.className = 'small';
    txt.innerHTML = `<b>${s.label}</b> · ${bits.join(' · ') || 'not enough data'}`;
    div.appendChild(txt);
    rep.streams.appendChild(div);
    requestAnimationFrame(() => drawRibbon(c, s, tMax, r.target));
  }
  const b = r.balance;
  rep.balance.textContent = b
    ? `Spouts: ${b.verdict}${b.caramelGap != null ? ` · turned caramel ${b.caramelGap.toFixed(0)} s apart` : ''}${b.riseGap != null ? ` · paleness change differs by ${b.riseGap.toFixed(0)}` : ''}`
      + (r.blondeAt != null ? ` · turned pale at ${r.blondeAt.toFixed(1)} s (experimental)` : '')
    : (r.blondeAt != null ? `Turned pale at ${r.blondeAt.toFixed(1)} s (experimental)` : '');
  rep.notes.innerHTML = '';
  for (const n of r.notes) {
    const li = document.createElement('li');
    li.className = n.kind;
    li.textContent = n.text;
    rep.notes.appendChild(li);
  }
  const mine = h.mine || {};
  rep.dose.value = mine.dose ?? '';
  rep.yld.value = mine.yield ?? '';
  rep.grind.value = mine.grind ?? '';
  rep.taste.value = mine.taste ?? '';
  rep.text.value = mine.text ?? '';
}

function drawRibbon(c, s, tMax, target) {
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(c.clientWidth * dpr);
  c.height = Math.round(34 * dpr);
  const g = c.getContext('2d');
  const X = (t) => (t / tMax) * c.width;
  for (const bin of s.series) {
    if (!bin) continue;
    g.fillStyle = `rgb(${bin.rgb.join(',')})`;
    g.fillRect(X(bin.t - 0.5), 0, Math.ceil(X(1)) + 1, c.height);
  }
  g.lineWidth = 2 * dpr;
  if (s.profile?.caramelAt != null) {
    g.strokeStyle = '#f3e9df';
    g.beginPath(); g.moveTo(X(s.profile.caramelAt), 0); g.lineTo(X(s.profile.caramelAt), c.height); g.stroke();
  }
  if (target) {
    g.strokeStyle = '#7bd389';
    g.setLineDash([4 * dpr, 3 * dpr]);
    g.beginPath(); g.moveTo(X(target), 0); g.lineTo(X(target), c.height); g.stroke();
    g.setLineDash([]);
  }
}

function saveMine() {
  if (reportIdx == null) return;
  const hist = load('shotclock.history', []);
  if (!hist[reportIdx]) return;
  hist[reportIdx].mine = {
    dose: rep.dose.value || undefined, yield: rep.yld.value || undefined, grind: rep.grind.value || undefined,
    taste: rep.taste.value || undefined, text: rep.text.value || undefined,
  };
  save('shotclock.history', hist);
}
for (const k of ['dose', 'yld', 'grind', 'taste', 'text']) rep[k].addEventListener('change', saveMine);

function renderHistory() {
  const hist = load('shotclock.history', []);
  el.history.innerHTML = '';
  if (!hist.length) {
    el.history.innerHTML = '<li class="empty">No shots yet.</li>';
    return;
  }
  hist.slice(0, 10).forEach((h, idx) => {
    const li = document.createElement('li');
    if (idx === reportIdx) li.classList.add('selected');
    li.addEventListener('click', () => showReport(idx));
    const when = new Date(h.when).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const warn = h.report?.notes?.find((n) => n.kind === 'warn');
    const timing = h.report?.timing ? ` · ${h.report.timing}` : '';
    const flag = warn ? ' <em class="early">check report</em>' : '';
    li.innerHTML = `<b>${h.total.toFixed(1)} s</b><span>${when}${timing}${flag}</span>`;
    const rib = document.createElement('div');
    rib.className = 'ribbon';
    if (h.ribbon?.length) rib.style.background = `linear-gradient(90deg, ${h.ribbon.map((c) => `rgb(${c.join(',')})`).join(',')})`;
    li.appendChild(rib);
    el.history.appendChild(li);
  });
}

function setStatus(text) { el.status.textContent = text; }

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
    wakeLock?.addEventListener('release', () => { wakeLock = null; });
  } catch { /* optional */ }
}

// ------------------------------------------------------------------ wire up
el.btnCamera.addEventListener('click', startCamera);
el.fileInput.addEventListener('change', () => { if (el.fileInput.files[0]) openFile(el.fileInput.files[0]); });
el.btnArm.addEventListener('click', arm);
el.btnStop.addEventListener('click', stopShot);
el.btnTest.addEventListener('click', () => {
  // play even with alerts off, so you can hear what they would sound like
  unlockAudio();
  const was = sounds.enabled;
  sounds.enabled = true;
  sounds.blonde();
  sounds.enabled = was;
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && source === 'camera' && !wakeLock) requestWakeLock();
});

bindSettings();
renderHistory();

window.shotClock = { sounds, settings, eventLog, showReport, get tracker() { return tracker; }, get result() { return lastResult; } };

loadOpenCv().then((m) => {
  cv = m;
  tracker = new StreamTracker(cv, { blondeDelta: settings.blondeDelta, maxStreams: settings.maxStreams });
  window.shotClock.ready = true;
  el.btnCamera.disabled = false;
  el.fileInput.disabled = false;
  el.lblFile.removeAttribute('aria-disabled');
  setStatus('Choose a source');
}).catch((err) => {
  setStatus('Vision engine failed to load: ' + err.message);
});
