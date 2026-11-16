// Alert sounds + optional pump-noise trigger via microphone.

let ctx = null;

// Must be called from a user gesture (click) at least once so browsers
// allow sound later when the alert fires unattended.
export function unlockAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

function tone(freq, start, dur, { type = 'square', gain = 0.35 } = {}) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gain, start + 0.01);
  g.gain.setValueAtTime(gain, start + dur - 0.02);
  g.gain.linearRampToValueAtTime(0, start + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

export const sounds = {
  enabled: true,
  speech: true,
  log: [],      // for tests / debugging

  start() {
    this.log.push('start');
    if (!this.enabled || !unlockAudio()) return;
    const t = ctx.currentTime;
    tone(660, t, 0.08, { type: 'sine', gain: 0.25 });
  },

  end() {
    this.log.push('end');
    if (!this.enabled || !unlockAudio()) return;
    const t = ctx.currentTime;
    tone(660, t, 0.08, { type: 'sine', gain: 0.25 });
    tone(440, t + 0.12, 0.12, { type: 'sine', gain: 0.25 });
  },

  blonde() {
    this.log.push('blonde');
    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 400]);
    if (!this.enabled || !unlockAudio()) return;
    const t = ctx.currentTime;
    for (let i = 0; i < 3; i++) tone(1046, t + i * 0.22, 0.15, { gain: 0.45 });
    if (this.speech && 'speechSynthesis' in window) {
      setTimeout(() => {
        try {
          const u = new SpeechSynthesisUtterance('Blonding. Cut the shot.');
          u.rate = 1.1;
          speechSynthesis.speak(u);
        } catch { /* ignore */ }
      }, 700);
    }
  },

  backup() {
    this.log.push('backup');
    if (!this.enabled || !unlockAudio()) return;
    const t = ctx.currentTime;
    tone(784, t, 0.3, { gain: 0.4 });
    tone(784, t + 0.4, 0.3, { gain: 0.4 });
  },
};

// Detects pump start from microphone: energy in the low band (vibratory
// pumps hum at 50/60 Hz and harmonics; rotary pumps add broadband noise)
// rising well above the noise floor measured while armed.
export class PumpListener {
  constructor({ riseDb = 10, holdMs = 200, lowHz = 40, highHz = 700 } = {}) {
    this.riseDb = riseDb;
    this.holdMs = holdMs;
    this.lowHz = lowHz;
    this.highHz = highHz;
    this.stream = null;
    this.analyser = null;
    this.buf = null;
    this.floorSamples = [];
    this.floor = null;
    this.above = null;
    this.level = -120;
  }

  async start() {
    unlockAudio();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const src = ctx.createMediaStreamSource(this.stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.3;
    src.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.frequencyBinCount);
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((tr) => tr.stop());
    this.stream = null;
    this.analyser = null;
  }

  get active() { return !!this.analyser; }

  // Begin a fresh noise-floor measurement.
  recalibrate() {
    this.floorSamples = [];
    this.floor = null;
    this.above = null;
  }

  // Returns the onset time (s) once when the pump is detected, else null.
  // Call every frame.
  // `listening` = detector is armed and waiting for a shot.
  poll(t, listening) {
    if (!this.analyser) return null;
    this.analyser.getFloatFrequencyData(this.buf);
    const binHz = ctx.sampleRate / this.analyser.fftSize;
    const lo = Math.max(1, Math.floor(this.lowHz / binHz));
    const hi = Math.min(this.buf.length - 1, Math.ceil(this.highHz / binHz));
    let p = 0;
    for (let i = lo; i <= hi; i++) p += Math.pow(10, this.buf[i] / 10);
    this.level = 10 * Math.log10(p + 1e-12);

    if (!listening) { this.above = null; return null; }

    if (this.floor == null) {
      this.floorSamples.push(this.level);
      if (this.floorSamples.length >= 30) {
        const s = [...this.floorSamples].sort((a, b) => a - b);
        this.floor = s[Math.floor(s.length / 2)];
      }
      return null;
    }
    if (this.level > this.floor + this.riseDb) {
      if (this.above == null) this.above = t;
      if ((t - this.above) * 1000 >= this.holdMs) {
        const onset = this.above;
        this.above = null;
        return onset;
      }
    } else {
      this.above = null;
      // keep following slow changes in room noise
      this.floor += (this.level - this.floor) * 0.01;
    }
    return null;
  }
}
