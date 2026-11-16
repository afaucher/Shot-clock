// Alert sounds.

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
