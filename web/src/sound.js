// Sound effects synthesised with the Web Audio API (no audio files to download).
// iOS only allows audio after a user gesture, so unlock() is called on the first tap.

let ctx = null;
let master = null;
let noiseBuf = null;
let volume = 0.7;
let muted = false;

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = muted ? 0 : volume;
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp);
  comp.connect(ctx.destination);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return ctx;
}

/** Call from a user gesture (tap / click) so browsers let audio start. */
export function unlockAudio() {
  const c = ensure();
  if (c && c.state === 'suspended') c.resume();
}

export function setVolume(v) {
  volume = Math.max(0, Math.min(1, v));
  if (master) master.gain.value = muted ? 0 : volume;
}

export function setMuted(m) {
  muted = !!m;
  if (master) master.gain.value = muted ? 0 : volume;
}

/* ------------------------------------------------------------------ building blocks */

function tone(t, freq, dur, { type = 'sine', gain = 0.3, attack = 0.005, slide = 0, out = master } = {}) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(out);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(t, dur, { freq = 1200, q = 1, gain = 0.3, type = 'bandpass', sweep = 0, attack = 0.002 } = {}) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (sweep) f.frequency.exponentialRampToValueAtTime(freq * sweep, t + dur);
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f);
  f.connect(g);
  g.connect(master);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

/** Short wooden knock: filtered click plus a quickly falling body tone. */
function knock(t, pitch = 1, gain = 0.5) {
  noise(t, 0.05, { freq: 1800 * pitch, q: 3, gain: gain * 0.6 });
  tone(t, 320 * pitch, 0.09, { type: 'triangle', gain: gain * 0.5, slide: 0.5 });
}

function thud(t, gain = 0.6) {
  tone(t, 110, 0.22, { gain, slide: 0.45 });
  noise(t, 0.12, { freq: 300, q: 0.7, gain: gain * 0.5, type: 'lowpass' });
}

/* ------------------------------------------------------------------ effects */

const EFFECTS = {
  click(t) { tone(t, 880, 0.05, { type: 'triangle', gain: 0.12 }); },
  road(t) { knock(t, 1.0); knock(t + 0.1, 1.15, 0.4); },
  settlement(t) {
    thud(t, 0.5);
    knock(t + 0.12, 1.2, 0.45); knock(t + 0.24, 1.25, 0.4); knock(t + 0.36, 1.3, 0.35);
    tone(t + 0.45, 660, 0.25, { gain: 0.08 });
  },
  city(t) {
    thud(t, 0.75);
    noise(t + 0.05, 0.2, { freq: 900, q: 0.8, gain: 0.35 }); // stones settling
    knock(t + 0.18, 0.8, 0.5); knock(t + 0.3, 0.85, 0.45);
    [523, 659, 784].forEach((f, i) => tone(t + 0.42 + i * 0.09, f, 0.5, { type: 'triangle', gain: 0.12 }));
  },
  robber(t) {
    tone(t, 70, 0.9, { type: 'sawtooth', gain: 0.12, attack: 0.25, slide: 0.7 });
    noise(t, 0.7, { freq: 200, q: 2, gain: 0.18, sweep: 3, attack: 0.3 });
    thud(t + 0.55, 0.7);
  },
  steal(t) {
    noise(t, 0.22, { freq: 800, q: 1.5, gain: 0.25, sweep: 5 });
    tone(t + 0.18, 1320, 0.18, { type: 'square', gain: 0.05 });
    tone(t + 0.24, 1760, 0.22, { type: 'square', gain: 0.04 });
  },
  dice(t) {
    // rattle in the hand, then two landings
    for (let i = 0; i < 9; i++) knock(t + i * 0.045 + Math.random() * 0.02, 1.6 + Math.random() * 0.5, 0.18);
    knock(t + 0.62, 1.1, 0.5); knock(t + 0.7, 1.3, 0.45);
    knock(t + 0.86, 1.2, 0.25); knock(t + 0.93, 1.4, 0.2);
    knock(t + 1.04, 1.3, 0.12);
  },
  turn(t) { tone(t, 784, 0.35, { gain: 0.14 }); tone(t + 0.14, 1175, 0.5, { gain: 0.12 }); },
  trade(t) { [1568, 2093, 1760].forEach((f, i) => tone(t + i * 0.06, f, 0.16, { type: 'square', gain: 0.04 })); },
  card(t) { noise(t, 0.12, { freq: 3000, q: 0.6, gain: 0.25, sweep: 0.4 }); },
  buy(t) { EFFECTS.trade(t); EFFECTS.card(t + 0.18); },
  knight(t) {
    noise(t, 0.3, { freq: 2500, q: 4, gain: 0.2, sweep: 1.6 }); // blade
    tone(t + 0.05, 2400, 0.4, { type: 'triangle', gain: 0.05 });
  },
  win(t) {
    [523, 659, 784, 1047].forEach((f, i) => tone(t + i * 0.13, f, 0.45, { type: 'triangle', gain: 0.16 }));
    [523, 659, 784].forEach((f) => tone(t + 0.6, f, 1.2, { type: 'triangle', gain: 0.1 }));
  },
  lose(t) { [392, 330, 262].forEach((f, i) => tone(t + i * 0.2, f, 0.5, { type: 'triangle', gain: 0.12 })); },
  error(t) { tone(t, 150, 0.16, { type: 'square', gain: 0.06 }); },
  chat(t) { tone(t, 1200, 0.07, { gain: 0.1, slide: 1.3 }); },
  tick(t) { knock(t, 2.2, 0.12); },
};

/** Plays a named effect now (no-op if audio is unavailable or muted). */
export function play(name, delay = 0) {
  if (muted || !EFFECTS[name]) return;
  const c = ensure();
  if (!c || c.state !== 'running') return;
  EFFECTS[name](c.currentTime + 0.01 + delay);
}

export const SOUND_NAMES = Object.keys(EFFECTS);
