// Procedural, seamlessly tiling surface textures (wood planks, felt, linen),
// generated once per surface into a canvas and used as a canvas pattern.

import { mulberry32 } from './geometry.js';

// Value noise on a lattice that wraps every px cells across and py cells down, so
// textures tile. Coordinates are in cells.
function periodicNoise(px, seed, py = px) {
  const rnd = mulberry32(seed);
  const g = new Float32Array(px * py);
  for (let i = 0; i < g.length; i++) g[i] = rnd();
  return (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const i0 = ((xi % px) + px) % px, i1 = (i0 + 1) % px;
    const j0 = ((yi % py) + py) % py, j1 = (j0 + 1) % py;
    const a = g[j0 * px + i0], b = g[j0 * px + i1];
    const c = g[j1 * px + i0], d = g[j1 * px + i1];
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}

// Fractal noise in [0, 1] over a tile of size×size pixels, with `cx` lattice cells
// across and `cy` down at the base octave (cy > cx stretches features horizontally).
function fbm(cx, seed, octaves = 4, cy = cx) {
  const layers = [];
  for (let o = 0; o < octaves; o++) layers.push(periodicNoise(cx << o, seed + o * 101, cy << o));
  return (x, y, size) => {
    let sum = 0, amp = 0.5, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += layers[o]((x * (cx << o)) / size, (y * (cy << o)) / size) * amp;
      norm += amp;
      amp *= 0.5;
    }
    return sum / norm;
  };
}

function canvasOf(size, paint) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  paint(img.data, size);
  ctx.putImageData(img, 0, 0);
  return cv;
}

const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// seamless: one continuous board (no plank grooves, joints or per-plank tint).
function wood(size, light, dark, seed, { seamless = false } = {}) {
  const planks = 4;
  const ph = size / planks;
  const rnd = mulberry32(seed);
  const meta = Array.from({ length: planks }, () => ({
    tint: (rnd() - 0.5) * 0.14,
    phase: rnd() * 60,
    phase2: rnd() * 60,
    joint: Math.floor(rnd() * size),
    len: Math.floor(size * (0.35 + rnd() * 0.3)), // two joints per plank, so the tile wraps cleanly
  }));
  const warp = fbm(2, seed + 1, 4, 16); // long, gentle waves along the board
  const fibre = periodicNoise(8, seed + 2, 700); // fine pores and streaks
  const figure = fbm(3, seed + 3, 3, 10); // broad light/dark figure
  const ringK = (2 * Math.PI * Math.round((0.21 * size) / (2 * Math.PI))) / size;
  return canvasOf(size, (d, s) => {
    for (let y = 0; y < s; y++) {
      const p = Math.floor(y / ph), ly = y - p * ph, m = meta[p];
      for (let x = 0; x < s; x++) {
        const along = (x - m.joint + s) % s;
        const phase = along < m.len ? m.phase : m.phase2;
        const w = warp(x, y, s);
        // A seamless board runs one grain pattern down the whole tile, at a frequency
        // that repeats exactly at the tile edge so no seam shows where it wraps.
        const rings = seamless
          ? Math.sin(y * ringK + w * 16 + meta[0].phase)
          : Math.sin(ly * 0.21 + w * 16 + phase);
        const line = Math.pow(rings * 0.5 + 0.5, 6);
        const f = fibre((x / s) * 8, (y / s) * 700);
        const fig = figure(x, y, s);
        let t = 0.6 - 0.3 * line + 0.24 * (f - 0.5) + 0.3 * (fig - 0.5) + (seamless ? 0 : m.tint);
        if (seamless) {
          // no grooves or joints
        } else if (ly < 2) t -= 0.5; // groove between planks
        else if (ly < 4) t += 0.06;
        const dj = seamless ? Infinity : Math.min(along, s - along, Math.abs(along - m.len));
        if (dj < 1.5) t -= 0.45; // butt joint
        else if (dj < 3) t -= 0.12;
        t = clamp01(t);
        const i = (y * s + x) * 4;
        d[i] = mix(dark[0], light[0], t);
        d[i + 1] = mix(dark[1], light[1], t);
        d[i + 2] = mix(dark[2], light[2], t);
        d[i + 3] = 255;
      }
    }
  });
}

function felt(size, base, seed, strength = 1) {
  const mottle = fbm(6, seed, 4);
  const rnd = mulberry32(seed + 9);
  return canvasOf(size, (d, s) => {
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const v = 1 + ((rnd() - 0.5) * 0.14 + (mottle(x, y, s) - 0.5) * 0.16) * strength;
        const i = (y * s + x) * 4;
        d[i] = base[0] * v;
        d[i + 1] = base[1] * v;
        d[i + 2] = base[2] * v;
        d[i + 3] = 255;
      }
    }
  });
}

function linen(size, base, seed) {
  const warpN = periodicNoise(512, seed, 12);
  const weftN = periodicNoise(12, seed + 1, 512);
  const slub = fbm(6, seed + 2, 3);
  const rnd = mulberry32(seed + 3);
  return canvasOf(size, (d, s) => {
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const a = warpN((x / s) * 512, (y / s) * 12); // vertical threads
        const b = weftN((x / s) * 12, (y / s) * 512); // horizontal threads
        const weave = ((x + y) & 1) * 0.02;
        const v = 1 + (a - 0.5) * 0.1 + (b - 0.5) * 0.1 + (slub(x, y, s) - 0.5) * 0.06 + (rnd() - 0.5) * 0.04 - weave;
        const i = (y * s + x) * 4;
        d[i] = base[0] * v;
        d[i + 1] = base[1] * v;
        d[i + 2] = base[2] * v;
        d[i + 3] = 255;
      }
    }
  });
}

export const SURFACES = {
  honey: { label: 'Honey oak', light: true, make: (s) => wood(s, [214, 158, 100], [146, 94, 52], 41, { seamless: true }) },
  walnut: { label: 'Walnut', light: false, make: (s) => wood(s, [138, 94, 62], [62, 38, 24], 11) },
  oak: { label: 'Oak', light: true, make: (s) => wood(s, [214, 172, 120], [146, 100, 60], 23) },
  felt: { label: 'Green felt', light: false, make: (s) => felt(s, [46, 82, 62], 5) },
  slate: { label: 'Blue felt', light: false, make: (s) => felt(s, [44, 58, 82], 7) },
  night: { label: 'Charcoal', light: false, make: (s) => felt(s, [30, 31, 36], 3, 1.4) },
  linen: { label: 'Linen', light: true, make: (s) => linen(s, [232, 224, 208], 13) },
};

const cache = new Map();
export function surface(key, size = 1024) {
  const id = `${key}:${size}`;
  if (!cache.has(id)) cache.set(id, SURFACES[key].make(size));
  return cache.get(id);
}

// Small preview for the settings swatches.
export function swatchURL(key) {
  return surface(key, 96).toDataURL();
}

// Tray colours. `ink` is the colour of messages written on the tray.
export const TRAYS = {
  ivory: { label: 'Warm ivory tray', color: '#F3EBDD', ink: '#6B5E4E' },
  mist: { label: 'Light grey tray', color: '#ECEEF1', ink: '#5B6170' },
  peach: { label: 'Peach tray', color: '#FFF3EA', ink: '#8A4A3A' },
  white: { label: 'White tray', color: '#FFFFFF', ink: '#6B6560' },
  sand: { label: 'Sand tray', color: '#E9E2D6', ink: '#6B5E4E' },
  sage: { label: 'Sage tray', color: '#CFE0D2', ink: '#3F5A45' },
  sky: { label: 'Sky tray', color: '#C9D6E8', ink: '#3E506B' },
  grey: { label: 'Grey tray', color: '#6E7480', ink: '#F2F2F4' },
  dark: { label: 'Dark tray', color: '#2B2622', ink: '#E9E2D6' },
};

// Puzzle mat colours: the felt inside the frame (grain 0 = perfectly flat) and the solid
// border around it.
export const MATS = {
  dark: { label: 'Dark mat', felt: [52, 46, 40], frame: '#2a231d' },
  light: { label: 'Light mat', felt: [226, 216, 198], frame: '#bfae94' },
  eggshell: { label: 'Eggshell mat', felt: [240, 234, 219], frame: '#cdc3ae', grain: 0.4 },
  white: { label: 'White mat', felt: [252, 252, 250], frame: '#d6d3cc', grain: 0 },
  grey: { label: 'Grey mat', felt: [201, 205, 211], frame: '#a9aeb6', grain: 0.6 },
  slate: { label: 'Slate mat', felt: [78, 86, 99], frame: '#3b424d' },
  navy: { label: 'Navy mat', felt: [40, 52, 75], frame: '#1d2738' },
  charcoal: { label: 'Charcoal mat', felt: [46, 48, 52], frame: '#202226' },
};

export function matFelt(key = 'dark') {
  const id = `mat:${key}`;
  if (!cache.has(id)) cache.set(id, felt(512, MATS[key].felt, 37, MATS[key].grain ?? 1));
  return cache.get(id);
}

export function matSwatchURL(key) {
  return matFelt(key).toDataURL();
}
