// Tiny synthesized sound effects (no audio files). Web Audio must be unlocked
// from a user gesture on iOS, so the game calls sfx.unlock() on every touch.

let ac = null;
let noise = null;
let enabled = true;
try {
  enabled = localStorage.getItem('pt-sound') !== 'off';
} catch {}

function ensure() {
  if (!ac) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ac = new AC();
    noise = ac.createBuffer(1, ac.sampleRate * 0.2, ac.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ac.state === 'suspended') ac.resume();
  return ac;
}

function knock(freq, dur, vol, delay = 0) {
  if (!enabled || !ensure()) return;
  const t = ac.currentTime + delay;
  const src = ac.createBufferSource();
  src.buffer = noise;
  const bp = ac.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = 5;
  const g = ac.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  src.connect(bp).connect(g).connect(ac.destination);
  src.start(t);
  src.stop(t + dur);
}

function tone(freq, dur, vol, delay = 0) {
  if (!enabled || !ensure()) return;
  const t = ac.currentTime + delay;
  const o = ac.createOscillator();
  o.type = 'triangle';
  o.frequency.value = freq;
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ac.destination);
  o.start(t);
  o.stop(t + dur);
}

import { post } from './native.js';

export const sfx = {
  get enabled() {
    return enabled;
  },
  set enabled(v) {
    enabled = v;
    try {
      localStorage.setItem('pt-sound', v ? 'on' : 'off');
    } catch {}
  },
  unlock: () => enabled && ensure(),
  pick: () => knock(2400, 0.04, 0.25),
  drop: () => knock(900, 0.06, 0.3),
  // In the app, joins and lock-ins also give a little vibration.
  snap: () => {
    knock(2000, 0.05, 0.7);
    knock(1300, 0.07, 0.6, 0.045);
    post('haptic', { kind: 'snap' });
  },
  lock: () => {
    knock(1600, 0.06, 0.7);
    tone(660, 0.25, 0.08, 0.03);
    post('haptic', { kind: 'lock' });
  },
  win: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.5, 0.12, i * 0.12)),
};
