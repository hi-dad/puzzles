// The play surface: one canvas holding the board (pan/zoom) and the piece tray.
// Works with touch (iPhone), mouse and Mac trackpad.

import { Cut } from './geometry.js';
import { settle, placedCount } from './logic.js';
import { sfx } from './sound.js';
import { SURFACES, surface, trayFelt, matFelt } from './textures.js';

export const BACKGROUNDS = SURFACES;
export const DEFAULT_BG = 'walnut';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Rotate (x, y) by r quarter turns clockwise (screen coordinates, y down).
function turn(x, y, r) {
  switch (r & 3) {
    case 1: return { x: -y, y: x };
    case 2: return { x: -x, y: -y };
    case 3: return { x: y, y: -x };
    default: return { x, y };
  }
}

export const TRAY_SIZE = { min: 0.7, max: 1.8 };
function savedTrayScale() {
  try {
    const v = parseFloat(localStorage.getItem('pt-tray'));
    if (v >= TRAY_SIZE.min && v <= TRAY_SIZE.max) return v;
  } catch {}
  return 1;
}

export class Game {
  constructor(canvas, rec, img, hooks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingQuality = 'high';
    this.hit = document.createElement('canvas').getContext('2d');
    this.rec = rec;
    this.img = img;
    this.hooks = hooks;
    this.cut = new Cut(rec.cols, rec.rows, rec.imgW, rec.imgH, rec.seed);
    this.n = rec.cols * rec.rows;

    this.pieces = [];
    for (let i = 0; i < this.n; i++) {
      const col = i % rec.cols, row = (i / rec.cols) | 0;
      const { canvas: cv, path, shadow } = this.cut.renderPiece(img, col, row);
      this.pieces.push({ i, col, row, edge: this.cut.isEdge(col, row), canvas: cv, path, shadow });
    }

    this.groupOf = new Array(this.n).fill(null);
    this.rotate = !!rec.rotate;
    this.rot = rec.rot ? [...rec.rot] : new Array(this.n).fill(0); // turn of each piece while in the tray
    this.groups = rec.groups.map((g) => ({ x: g.x, y: g.y, r: g.r || 0, locked: g.locked, members: [...g.members] }));
    for (const g of this.groups) for (const i of g.members) this.groupOf[i] = g;
    this.tray = [...rec.tray];

    this.bg = BACKGROUNDS[rec.bg] ? rec.bg : DEFAULT_BG;
    this.ghost = !!rec.ghost;
    this.edgesOnly = false;
    this.trayScale = savedTrayScale();
    this.cam = { s: 1, x: 0, y: 0 };
    this.trayScroll = 0;
    this.trayVel = 0;
    this.ptrs = new Map();
    this.mode = null;
    this.m = null;
    this.drag = null;
    this.anim = null;
    this.ripples = [];
    this.raf = 0;

    this.bind();
    this.resize();
    this.fit();
  }

  // ---------- layout & camera ----------

  resize() {
    const r = this.canvas.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const prevW = this.w, prevH = this.h;
    this.w = r.width;
    this.h = r.height;
    this.dpr = dpr;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.imageSmoothingQuality = 'high'; // resizing a canvas resets its context state
    this.rect = this.canvas.getBoundingClientRect();
    this.safeBottom = safeAreaBottom();
    const compact = this.w < 600 || this.h < 600;
    this.slot = Math.round((compact ? 76 : 92) * this.trayScale);
    this.trayH = this.slot + 16 + this.safeBottom;
    this.canvas.parentElement.style.setProperty('--tray-h', `${this.trayH}px`);
    if (prevW) {
      // keep the board centred through rotations/resizes
      this.cam.x += (this.w - prevW) / 2;
      this.cam.y += (this.h - prevH) / 2;
    }
    this.clampTray();
    this.redraw();
  }

  setTrayScale(k) {
    this.trayScale = clamp(k, TRAY_SIZE.min, TRAY_SIZE.max);
    try {
      localStorage.setItem('pt-tray', String(this.trayScale));
    } catch {}
    const before = this.boardH;
    this.resize();
    this.cam.y += (this.boardH - before) / 2;
  }

  get boardH() {
    return this.h - this.trayH;
  }

  fit() {
    const pad = 20;
    const s = Math.min((this.w - 2 * pad) / this.rec.imgW, (this.boardH - 2 * pad) / this.rec.imgH) * 0.8;
    this.fitS = s;
    this.texS ??= s; // texture scale reference, fixed so re-fitting never resizes the grain
    this.cam.s = s;
    this.cam.x = (this.w - this.rec.imgW * s) / 2;
    this.cam.y = (this.boardH - this.rec.imgH * s) / 2;
    this.redraw();
  }

  clampScale(s) {
    return clamp(s, this.fitS * 0.25, Math.max(this.fitS * 14, 2.5));
  }

  zoomAt(x, y, factor) {
    const s = this.clampScale(this.cam.s * factor);
    const wx = (x - this.cam.x) / this.cam.s, wy = (y - this.cam.y) / this.cam.s;
    this.cam.s = s;
    this.cam.x = x - wx * s;
    this.cam.y = y - wy * s;
    this.redraw();
  }

  zoomBy(factor) {
    this.zoomAt(this.w / 2, this.boardH / 2, factor);
  }

  toWorld(x, y) {
    return { x: (x - this.cam.x) / this.cam.s, y: (y - this.cam.y) / this.cam.s };
  }

  // ---------- tray ----------

  trayList() {
    return this.edgesOnly ? this.tray.filter((i) => this.pieces[i].edge) : this.tray;
  }

  clampTray() {
    const max = Math.max(0, this.trayList().length * this.slot + 24 - this.w);
    this.trayScroll = clamp(this.trayScroll, 0, max);
  }

  trayCenterY() {
    return this.h - this.safeBottom - (this.trayH - this.safeBottom) / 2 + 4;
  }

  trayHit(x) {
    const list = this.trayList();
    const k = Math.floor((x + this.trayScroll - 12) / this.slot);
    return k >= 0 && k < list.length ? list[k] : null;
  }

  inTray(y) {
    return y > this.h - this.trayH;
  }

  setEdgesOnly(v) {
    this.edgesOnly = v;
    this.trayScroll = 0;
    this.redraw();
  }

  setGhost(v) {
    this.ghost = v;
    this.changed();
  }

  setBackground(key) {
    this.bg = key;
    this.patterns = null;
    this.changed();
  }

  // ---------- state changes ----------

  pull(idx, p) {
    this.tray.splice(this.tray.indexOf(idx), 1);
    const pc = this.pieces[idx];
    const w = this.toWorld(p.x, p.y);
    const r = this.rotate ? this.rot[idx] : 0;
    const c = turn((pc.col + 0.5) * this.cut.pw, (pc.row + 0.5) * this.cut.ph, r);
    const g = { x: w.x - c.x, y: w.y - c.y, r, locked: false, members: [idx] };
    this.groups.push(g);
    this.groupOf[idx] = g;
    return g;
  }

  // Tap on a tray piece: drop it somewhere visible on the board, beside the frame if possible.
  placeFromTray(idx) {
    const { pw, ph } = this.cut;
    const pad = Math.max(pw, ph) * this.cam.s * 0.8;
    const x = pad + Math.random() * Math.max(1, this.w - 2 * pad);
    const y = pad + Math.random() * Math.max(1, this.boardH - 2 * pad);
    this.pull(idx, { x, y });
    sfx.drop();
    this.changed();
  }

  // Put several tray pieces on the table at once, in a tidy block in the middle of the view.
  placeMany(list) {
    const n = list.length;
    const per = Math.max(1, Math.round(Math.sqrt((n * this.w) / this.boardH)));
    const rows = Math.ceil(n / per);
    const step = Math.max(this.cut.pw, this.cut.ph) * 1.5; // world units between piece centres
    const fit = Math.min((this.w * 0.9) / (per * step), (this.boardH * 0.85) / (rows * step));
    // Zoom so the new pieces are a comfortable size (~70px) but all still fit in view.
    const comfy = 70 / Math.max(this.cut.pw, this.cut.ph);
    const target = this.clampScale(Math.min(fit, Math.max(this.cam.s, comfy)));
    if (Math.abs(target - this.cam.s) > 1e-6) this.zoomAt(this.w / 2, this.boardH / 2, target / this.cam.s);
    const s = step * this.cam.s;
    const x0 = this.w / 2 - ((per - 1) * s) / 2, y0 = this.boardH / 2 - ((rows - 1) * s) / 2;
    list.forEach((idx, k) => this.pull(idx, { x: x0 + (k % per) * s, y: y0 + Math.floor(k / per) * s }));
    sfx.drop();
    this.changed();
  }

  // Sort key per piece from its average colour: hue bands, then lightness; greys last.
  colourKeys() {
    if (this.keys) return this.keys;
    const { cols, rows } = this.rec;
    let src = this.img, w = this.rec.imgW, h = this.rec.imgH;
    while (w / 4 > cols) {
      // step down gradually so each output pixel averages its whole piece
      const cv = document.createElement('canvas');
      cv.width = Math.max(cols, Math.round(w / 4));
      cv.height = Math.max(rows, Math.round(h / 4));
      const c = cv.getContext('2d');
      c.imageSmoothingQuality = 'high';
      c.drawImage(src, 0, 0, cv.width, cv.height);
      src = cv;
      w = cv.width;
      h = cv.height;
    }
    const cv = document.createElement('canvas');
    cv.width = cols;
    cv.height = rows;
    const c = cv.getContext('2d');
    c.imageSmoothingQuality = 'high';
    c.drawImage(src, 0, 0, cols, rows);
    const d = c.getImageData(0, 0, cols, rows).data;
    this.keys = [];
    for (let i = 0; i < this.n; i++) {
      const r = d[i * 4] / 255, g = d[i * 4 + 1] / 255, b = d[i * 4 + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
      const sat = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
      let hue = 0;
      if (max !== min) {
        if (max === r) hue = ((g - b) / (max - min) + 6) % 6;
        else if (max === g) hue = (b - r) / (max - min) + 2;
        else hue = (r - g) / (max - min) + 4;
        hue *= 60;
      }
      this.keys.push(sat < 0.15 || l < 0.1 || l > 0.92 ? 1000 + l : Math.floor(hue / 20) * 10 + l * 9);
    }
    return this.keys;
  }

  returnToTray(g) {
    this.groups.splice(this.groups.indexOf(g), 1);
    const idx = g.members[0];
    this.groupOf[idx] = null;
    this.rot[idx] = g.r;
    this.tray.unshift(idx);
    this.trayScroll = 0;
  }

  // Turn a loose group a quarter clockwise around the world point (px, py).
  spin(g, px, py) {
    const q = turn(px - g.x, py - g.y, 4 - g.r); // pivot in the group's own coordinates
    const from = g.r;
    g.r = (g.r + 1) & 3;
    const t = turn(q.x, q.y, g.r);
    g.x = px - t.x;
    g.y = py - t.y;
    g.spin = { px, py, q, from, t0: performance.now() };
    sfx.pick();
    this.drop(g, { x: 0, y: 0 });
  }

  drop(g, p) {
    if (this.inTray(p.y) && g.members.length === 1 && !g.locked) {
      this.returnToTray(g);
      sfx.drop();
      this.changed();
      return;
    }
    const tol = this.cut.T * 0.22;
    const dropped = [...g.members];
    const r = settle(g, { groups: this.groups, groupOf: this.groupOf, cols: this.rec.cols, rows: this.rec.rows, tol });
    if (r.locked) sfx.lock();
    else if (r.joined) sfx.snap();
    else sfx.drop();
    if (r.locked || r.joined) this.ripple(g, dropped, r.locked);
    this.checkDone();
    this.changed();
  }

  // A drop of light where the pieces landed, rippling out across the whole joined section.
  ripple(g, dropped, strong) {
    const { pw, ph, M, T } = this.cut;
    let cx = 0, cy = 0;
    for (const i of dropped) {
      const pc = this.pieces[i];
      cx += (pc.col + 0.5) * pw;
      cy += (pc.row + 0.5) * ph;
    }
    cx /= dropped.length;
    cy /= dropped.length;
    let far = 0;
    for (const i of g.members) {
      const pc = this.pieces[i];
      far = Math.max(far, Math.hypot((pc.col + 0.5) * pw - cx, (pc.row + 0.5) * ph - cy));
    }
    const maxR = Math.min(far + T, T * (strong ? 9 : 6));
    const clip = new Path2D();
    for (const i of g.members) {
      const pc = this.pieces[i];
      if (Math.hypot((pc.col + 0.5) * pw - cx, (pc.row + 0.5) * ph - cy) > maxR + T) continue;
      clip.addPath(pc.path, new DOMMatrix([1, 0, 0, 1, pc.col * pw - M, pc.row * ph - M]));
    }
    this.ripples.push({ g, cx, cy, maxR, clip, strong, t0: performance.now(), dur: 380 + (maxR / T) * 38 });
    this.redraw();
  }

  drawRipples(t) {
    const { ctx, cam, cut } = this;
    this.ripples = this.ripples.filter((rp) => t - rp.t0 < rp.dur && this.groups.includes(rp.g));
    const smooth = (x) => x * x * (3 - 2 * x);
    for (const rp of this.ripples) {
      const k = Math.min(1, Math.max(0, (t - rp.t0) / rp.dur));
      const peak = rp.strong ? 1 : 0.85;
      ctx.save();
      this.groupTransform(rp.g, t);
      // Light catching the cuts between pieces: a wide faint line under a thin bright one
      // (cheaper than a blurred shadow, which can stutter on phones).
      const seam = smooth(Math.min(1, k * 8)) * Math.pow(1 - k, 1.6) * (rp.strong ? 0.75 : 0.55);
      if (seam > 0.01) {
        ctx.strokeStyle = '#fff';
        ctx.globalAlpha = seam * 0.35;
        ctx.lineWidth = 6 / cam.s;
        ctx.stroke(rp.clip);
        ctx.globalAlpha = seam;
        ctx.lineWidth = 1.5 / cam.s;
        ctx.stroke(rp.clip);
        ctx.globalAlpha = 1;
      }
      ctx.clip(rp.clip);
      ctx.globalCompositeOperation = 'screen';
      // the initial splash of light, swelling in then out
      const sk = Math.min(1, k * 2.5);
      const splash = Math.sin(sk * Math.PI) * (1 - sk * 0.4) * peak;
      if (splash > 0.01) {
        const r0 = cut.T * (0.7 + sk * 1.6);
        const sg = ctx.createRadialGradient(rp.cx, rp.cy, 0, rp.cx, rp.cy, r0);
        sg.addColorStop(0, `rgba(255,255,255,${splash})`);
        sg.addColorStop(0.5, `rgba(255,255,255,${splash * 0.35})`);
        sg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = sg;
        ctx.fillRect(rp.cx - r0, rp.cy - r0, r0 * 2, r0 * 2);
      }
      // two expanding rings, like a drop on water; each eases in so nothing pops
      for (const delay of [0, 0.18]) {
        const kk = (k - delay) / (1 - delay);
        if (kk <= 0 || kk >= 1) continue;
        const e = 1 - Math.pow(1 - kk, 3);
        const r = e * rp.maxR;
        const w = cut.T * (0.5 + 0.5 * kk);
        const a = smooth(Math.min(1, kk * 6)) * Math.pow(1 - kk, 1.5) * peak * (delay ? 0.65 : 1);
        if (a < 0.01) continue;
        const inner = Math.max(0, r - w), outer = r + w;
        const rg = ctx.createRadialGradient(rp.cx, rp.cy, inner, rp.cx, rp.cy, outer);
        rg.addColorStop(0, 'rgba(255,255,255,0)');
        rg.addColorStop(0.35, `rgba(255,255,255,${a * 0.4})`);
        rg.addColorStop(0.5, `rgba(255,255,255,${a})`);
        rg.addColorStop(0.65, `rgba(255,255,255,${a * 0.4})`);
        rg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = rg;
        ctx.fillRect(rp.cx - outer, rp.cy - outer, outer * 2, outer * 2);
      }
      ctx.restore();
    }
  }

  checkDone() {
    if (this.rec.done) return;
    // Built the whole picture off to the side: glide it into the frame.
    if (this.tray.length === 0 && this.groups.length === 1 && !this.groups[0].locked && !this.groups[0].r) {
      const g = this.groups[0];
      this.anim = { g, x0: g.x, y0: g.y, t0: performance.now(), dur: 450 };
      this.redraw();
      return;
    }
    if (placedCount(this.groups) === this.n) {
      this.rec.done = true;
      setTimeout(() => {
        sfx.win();
        this.hooks.onComplete?.();
      }, 250);
    }
  }

  placed() {
    return placedCount(this.groups);
  }

  serialize() {
    const r2 = (v) => Math.round(v * 100) / 100;
    return {
      tray: [...this.tray],
      groups: this.groups.map((g) => ({ x: r2(g.x), y: r2(g.y), r: g.r, locked: g.locked, members: [...g.members] })),
      rot: this.rotate ? [...this.rot] : undefined,
      placed: this.placed(),
      done: !!this.rec.done,
      bg: this.bg,
      ghost: this.ghost,
    };
  }

  changed() {
    this.clampTray();
    this.redraw();
    this.hooks.onChange?.(this.serialize());
  }

  // ---------- hit testing ----------

  hitBoard(x, y) {
    const w = this.toWorld(x, y);
    const { pw, ph, M } = this.cut;
    const slop = 10 / this.cam.s;
    let near = null;
    for (let gi = this.groups.length - 1; gi >= 0; gi--) {
      const g = this.groups[gi];
      if (g.locked) continue;
      const u = turn(w.x - g.x, w.y - g.y, 4 - g.r);
      for (const i of g.members) {
        const pc = this.pieces[i];
        const lx = u.x - (pc.col * pw - M), ly = u.y - (pc.row * ph - M);
        if (lx < -slop || ly < -slop || lx > pc.canvas.width + slop || ly > pc.canvas.height + slop) continue;
        if (this.hit.isPointInPath(pc.path, lx, ly)) return g;
        if (!near && Math.abs(lx - M - pw / 2) < pw / 2 + slop && Math.abs(ly - M - ph / 2) < ph / 2 + slop) near = g;
      }
    }
    return near;
  }

  // ---------- input ----------

  bind() {
    const c = this.canvas;
    this.handlers = {
      pointerdown: (e) => this.onDown(e),
      pointermove: (e) => this.onMove(e),
      pointerup: (e) => this.onUp(e),
      pointercancel: (e) => this.onUp(e),
      wheel: (e) => this.onWheel(e),
      gesturestart: (e) => this.onGesture(e),
      gesturechange: (e) => this.onGesture(e),
      gestureend: (e) => e.preventDefault(),
      contextmenu: (e) => e.preventDefault(),
    };
    for (const [k, fn] of Object.entries(this.handlers)) c.addEventListener(k, fn, { passive: false });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(c.parentElement);
  }

  destroy() {
    for (const [k, fn] of Object.entries(this.handlers)) this.canvas.removeEventListener(k, fn);
    this.ro.disconnect();
    cancelAnimationFrame(this.raf);
  }

  pt(e) {
    return { x: e.clientX - this.rect.left, y: e.clientY - this.rect.top };
  }

  onDown(e) {
    e.preventDefault();
    sfx.unlock();
    this.rect = this.canvas.getBoundingClientRect();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {}
    const p = this.pt(e);
    this.ptrs.set(e.pointerId, p);
    this.trayVel = 0;

    if (this.ptrs.size === 2 && this.mode !== 'piece') return this.startPinch();
    if (this.ptrs.size > 1) return;

    if (this.inTray(p.y)) {
      this.mode = 'tray';
      this.m = {
        id: e.pointerId, idx: this.trayHit(p.x), x0: p.x, y0: p.y, scroll0: this.trayScroll,
        scrolling: false, lastX: p.x, lastT: e.timeStamp, vel: 0, mouse: e.pointerType === 'mouse',
      };
      return;
    }
    const g = this.hitBoard(p.x, p.y);
    if (g) this.beginDrag(g, p, e.pointerId);
    else {
      this.mode = 'pan';
      this.m = { id: e.pointerId, lx: p.x, ly: p.y };
    }
  }

  beginDrag(g, p, id) {
    const w = this.toWorld(p.x, p.y);
    this.groups.splice(this.groups.indexOf(g), 1);
    this.groups.push(g);
    this.mode = 'piece';
    this.m = { id, g, gx: w.x - g.x, gy: w.y - g.y, x0: p.x, y0: p.y, moved: false, fromTray: false };
    this.drag = g;
    sfx.pick();
    this.redraw();
  }

  onMove(e) {
    if (!this.ptrs.has(e.pointerId)) return;
    e.preventDefault();
    const p = this.pt(e);
    this.ptrs.set(e.pointerId, p);
    const m = this.m;
    if (this.mode === 'pinch') return this.updatePinch();
    if (!m || m.id !== e.pointerId) return;

    if (this.mode === 'pan') {
      this.cam.x += p.x - m.lx;
      this.cam.y += p.y - m.ly;
      m.lx = p.x;
      m.ly = p.y;
      this.redraw();
    } else if (this.mode === 'piece') {
      const w = this.toWorld(p.x, p.y);
      if (!m.moved && Math.hypot(p.x - m.x0, p.y - m.y0) < 6) return;
      m.moved = true;
      m.g.x = w.x - m.gx;
      m.g.y = w.y - m.gy;
      this.overTray = this.inTray(p.y) && m.g.members.length === 1;
      this.redraw();
    } else if (this.mode === 'tray') {
      const dx = p.x - m.x0, dy = p.y - m.y0;
      if (!m.scrolling && m.idx != null) {
        // Mouse: any drag lifts the piece. Touch: swipe up lifts it, sideways scrolls the tray.
        const lift = m.mouse ? Math.hypot(dx, dy) > 4 : (dy < -8 && -dy > Math.abs(dx)) || !this.inTray(p.y);
        if (lift) {
          const g = this.pull(m.idx, p);
          this.beginDrag(g, p, m.id);
          this.m.moved = true;
          return;
        }
      }
      if (!m.scrolling && Math.abs(dx) > 6) m.scrolling = true;
      if (m.scrolling) {
        this.trayScroll = m.scroll0 - dx;
        this.clampTray();
        const dt = Math.max(1, e.timeStamp - m.lastT);
        m.vel = 0.7 * m.vel + 0.3 * ((p.x - m.lastX) / dt);
        m.lastX = p.x;
        m.lastT = e.timeStamp;
        this.redraw();
      }
    }
  }

  onUp(e) {
    if (!this.ptrs.has(e.pointerId)) return;
    const p = this.ptrs.get(e.pointerId);
    this.ptrs.delete(e.pointerId);

    if (this.mode === 'pinch') {
      if (this.ptrs.size === 1) {
        const [[id, q]] = this.ptrs;
        this.mode = 'pan';
        this.m = { id, lx: q.x, ly: q.y };
      } else if (this.ptrs.size === 0) {
        this.mode = null;
        this.m = null;
      }
      return;
    }
    const m = this.m;
    if (!m || m.id !== e.pointerId) return;

    if (this.mode === 'piece') {
      this.drag = null;
      this.overTray = false;
      if (!m.moved && this.rotate && e.type === 'pointerup') {
        const w = this.toWorld(p.x, p.y);
        this.spin(m.g, w.x, w.y);
      } else this.drop(m.g, p);
    } else if (this.mode === 'tray') {
      if (m.scrolling) {
        this.trayVel = m.vel;
        this.redraw();
      } else if (m.idx != null && e.type === 'pointerup') {
        this.placeFromTray(m.idx);
      }
    }
    this.mode = null;
    this.m = null;
  }

  startPinch() {
    const [a, b] = [...this.ptrs.values()];
    this.mode = 'pinch';
    this.m = {
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
      s0: this.cam.s, x0: this.cam.x, y0: this.cam.y,
    };
  }

  updatePinch() {
    const [a, b] = [...this.ptrs.values()];
    const m = this.m;
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const s = this.clampScale((m.s0 * d) / m.d0);
    const wx = (m.mx - m.x0) / m.s0, wy = (m.my - m.y0) / m.s0;
    this.cam.s = s;
    this.cam.x = mx - wx * s;
    this.cam.y = my - wy * s;
    this.redraw();
  }

  onWheel(e) {
    e.preventDefault();
    this.rect = this.canvas.getBoundingClientRect();
    const p = this.pt(e);
    let dx = e.deltaX, dy = e.deltaY;
    if (e.deltaMode === 1) {
      dx *= 16;
      dy *= 16;
    }
    if (e.ctrlKey || e.metaKey) {
      // trackpad pinch (Chrome/Firefox) or ⌘/ctrl + scroll
      this.zoomAt(p.x, p.y, Math.exp(-dy * 0.01));
    } else if (this.inTray(p.y)) {
      this.trayScroll += Math.abs(dx) > Math.abs(dy) ? dx : dy;
      this.clampTray();
      this.redraw();
    } else {
      this.cam.x -= dx;
      this.cam.y -= dy;
      this.redraw();
    }
  }

  // Safari on Mac reports trackpad pinch as gesture events.
  onGesture(e) {
    e.preventDefault();
    if (this.ptrs.size) return; // touch pinch on iPhone is handled by pointer events
    this.rect = this.canvas.getBoundingClientRect();
    const p = { x: e.clientX - this.rect.left, y: e.clientY - this.rect.top };
    if (e.type === 'gesturestart') this.gs = this.cam.s;
    else this.zoomAt(p.x, p.y, (this.gs * e.scale) / this.cam.s);
  }

  // ---------- rendering ----------

  redraw() {
    if (!this.raf) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  frame(t) {
    this.raf = 0;
    let more = false;
    if (this.trayVel) {
      this.trayScroll -= this.trayVel * 16;
      this.trayVel *= 0.94;
      const before = this.trayScroll;
      this.clampTray();
      if (Math.abs(this.trayVel) < 0.02 || before !== this.trayScroll) this.trayVel = 0;
      else more = true;
    }
    if (this.anim) {
      const a = this.anim;
      const k = Math.min(1, (t - a.t0) / a.dur);
      const e = 1 - Math.pow(1 - k, 3);
      a.g.x = a.x0 * (1 - e);
      a.g.y = a.y0 * (1 - e);
      if (k >= 1) {
        this.anim = null;
        this.drop(a.g, { x: 0, y: 0 });
      } else more = true;
    }
    if (this.ripples.length) more = true;
    for (const g of this.groups) if (g.spin) more = true;
    this.draw(t);
    if (more) this.redraw();
  }

  draw(t) {
    const { ctx, dpr, cam, cut } = this;
    const bg = BACKGROUNDS[this.bg];
    const W = this.rec.imgW, H = this.rec.imgH;
    const pat = this.getPatterns();

    // Table and mat textures are fixed to the board, so they pan and zoom with the pieces.
    // At the fitted zoom the grain is ~2 texels per CSS pixel, crisp on Retina.
    const tex = cam.s / this.texS;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    pat.table.setTransform(new DOMMatrix([0.55 * tex, 0, 0, 0.55 * tex, cam.x, cam.y]));
    ctx.fillStyle = pat.table;
    ctx.fillRect(0, 0, this.w, this.h);
    // soft overhead light
    const vg = ctx.createRadialGradient(this.w / 2, this.boardH * 0.45, Math.min(this.w, this.h) * 0.2,
      this.w / 2, this.boardH * 0.45, Math.hypot(this.w, this.h) * 0.62);
    vg.addColorStop(0, 'rgba(255,240,215,0.06)');
    vg.addColorStop(1, 'rgba(0,0,0,0.38)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, this.w, this.h);

    // the puzzle mat
    ctx.setTransform(dpr * cam.s, 0, 0, dpr * cam.s, dpr * cam.x, dpr * cam.y);
    const pad = Math.max(cut.pw, cut.ph) * 0.06;
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 22 * dpr;
    ctx.shadowOffsetY = 6 * dpr;
    ctx.fillStyle = '#2a231d';
    ctx.fillRect(-pad, -pad, W + 2 * pad, H + 2 * pad);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    // felt surface, with texture at a fixed on-screen size
    pat.mat.setTransform(new DOMMatrix([0.5 / this.texS, 0, 0, 0.5 / this.texS, 0, 0]));
    ctx.fillStyle = pat.mat;
    ctx.fillRect(0, 0, W, H);
    // inner bevel: shadow on the top/left, light catch on the bottom/right
    const b = 3 / cam.s;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, W, b);
    ctx.fillRect(0, 0, b, H);
    ctx.fillStyle = 'rgba(255,235,210,0.08)';
    ctx.fillRect(0, H - b / 2, W, b / 2);
    ctx.fillRect(W - b / 2, 0, b / 2, H);
    ctx.lineWidth = 1 / cam.s;
    ctx.strokeStyle = 'rgba(255,235,210,0.18)';
    ctx.strokeRect(-pad, -pad, W + 2 * pad, H + 2 * pad);
    if (this.ghost) {
      ctx.globalAlpha = 0.32;
      ctx.drawImage(this.img, 0, 0);
      ctx.globalAlpha = 1;
    }

    const view = {
      x0: -cam.x / cam.s, y0: -cam.y / cam.s,
      x1: (this.w - cam.x) / cam.s, y1: (this.h - cam.y) / cam.s,
    };
    for (const g of this.groups) if (g.locked) this.drawGroup(g, view);
    for (const g of this.groups) if (!g.locked && g !== this.drag) this.drawGroup(g, view);
    if (this.drag) this.drawGroup(this.drag, view, this.overTray ? 0.6 : 1, true);
    if (this.ripples.length) this.drawRipples(t);

    this.drawTray();
  }

  // Set the context so drawing at a piece's solved position lands where group g is now.
  groupTransform(g, now) {
    const { ctx } = this;
    const sp = g.spin;
    if (sp) {
      const k = Math.min(1, (now - sp.t0) / 160);
      if (k >= 1) g.spin = null;
      else {
        const e = 1 - Math.pow(1 - k, 2);
        ctx.translate(sp.px, sp.py);
        ctx.rotate((sp.from + e) * Math.PI / 2);
        ctx.translate(-sp.q.x, -sp.q.y);
        return;
      }
    }
    ctx.translate(g.x, g.y);
    if (g.r) ctx.rotate(g.r * Math.PI / 2);
  }

  drawGroup(g, v, alpha = 1, lifted = false) {
    const { ctx, cut } = this;
    const rad = Math.hypot(cut.pw, cut.ph) / 2 + cut.M * 2;
    const visible = g.members.filter((i) => {
      const pc = this.pieces[i];
      const c = turn((pc.col + 0.5) * cut.pw, (pc.row + 0.5) * cut.ph, g.r);
      const cx = g.x + c.x, cy = g.y + c.y;
      return !(cx - rad > v.x1 || cy - rad > v.y1 || cx + rad < v.x0 || cy + rad < v.y0);
    });
    if (!visible.length) return;
    // Shadows first (offset "down" on screen whatever the piece's turn), then the pieces,
    // so a group never shades itself.
    if (!g.locked) {
      const off = turn(0, cut.T * (lifted ? 0.16 : 0.035), 4 - g.r);
      ctx.save();
      this.groupTransform(g, performance.now());
      ctx.translate(off.x, off.y);
      ctx.globalAlpha = alpha * (lifted ? 0.42 : 0.5);
      for (const i of visible) {
        const pc = this.pieces[i], sh = pc.shadow;
        ctx.drawImage(sh.canvas, pc.col * cut.pw - cut.M - sh.pad, pc.row * cut.ph - cut.M - sh.pad,
          sh.canvas.width / sh.scale, sh.canvas.height / sh.scale);
      }
      ctx.restore();
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    this.groupTransform(g, performance.now());
    for (const i of visible) {
      const pc = this.pieces[i];
      ctx.drawImage(pc.canvas, pc.col * cut.pw - cut.M, pc.row * cut.ph - cut.M);
    }
    ctx.restore();
  }

  getPatterns() {
    if (!this.patterns) {
      this.patterns = {
        table: this.ctx.createPattern(surface(this.bg), 'repeat'),
        tray: this.ctx.createPattern(trayFelt(), 'repeat'),
        mat: this.ctx.createPattern(matFelt(), 'repeat'),
        lip: this.ctx.createPattern(surface('walnut'), 'repeat'),
      };
    }
    return this.patterns;
  }

  drawTray() {
    const { ctx, dpr, cut } = this;
    const top = this.h - this.trayH;
    const pat = this.getPatterns();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // felt lining
    pat.tray.setTransform(new DOMMatrix([0.8, 0, 0, 0.8, 0, 0]));
    ctx.fillStyle = pat.tray;
    ctx.fillRect(0, top, this.w, this.trayH);
    if (this.overTray) {
      ctx.fillStyle = 'rgba(255,230,190,0.08)';
      ctx.fillRect(0, top, this.w, this.trayH);
    }
    // shadow cast by the lip onto the felt
    const lipH = 9;
    const sg = ctx.createLinearGradient(0, top + lipH, 0, top + lipH + 18);
    sg.addColorStop(0, 'rgba(0,0,0,0.55)');
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(0, top + lipH, this.w, 18);
    // wooden lip with a rounded highlight
    pat.lip.setTransform(new DOMMatrix([0.35, 0, 0, 0.35, 0, top]));
    ctx.fillStyle = pat.lip;
    ctx.fillRect(0, top, this.w, lipH);
    const lg = ctx.createLinearGradient(0, top, 0, top + lipH);
    lg.addColorStop(0, 'rgba(255,225,180,0.35)');
    lg.addColorStop(0.35, 'rgba(255,225,180,0.05)');
    lg.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = lg;
    ctx.fillRect(0, top, this.w, lipH);
    // the lip also shades the table just above it
    const ug = ctx.createLinearGradient(0, top - 14, 0, top);
    ug.addColorStop(0, 'rgba(0,0,0,0)');
    ug.addColorStop(1, 'rgba(0,0,0,0.35)');
    ctx.fillStyle = ug;
    ctx.fillRect(0, top - 14, this.w, 14);

    const list = this.trayList();
    const cy = this.trayCenterY();
    if (!list.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.font = '500 14px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const msg = this.tray.length ? 'No edge pieces left in the tray' : 'All pieces are on the table';
      ctx.fillText(this.overTray ? 'Drop to put back in the tray' : msg, this.w / 2, cy);
      return;
    }
    const k = (this.slot - 8) / (Math.max(cut.pw, cut.ph) * 1.62);
    const first = Math.max(0, Math.floor((this.trayScroll - 12) / this.slot));
    const last = Math.min(list.length - 1, Math.ceil((this.trayScroll + this.w) / this.slot));
    ctx.shadowColor = 'rgba(0,0,0,0.4)';
    ctx.shadowBlur = 4 * dpr;
    ctx.shadowOffsetY = 2 * dpr;
    for (let j = first; j <= last; j++) {
      const pc = this.pieces[list[j]];
      const cx = 12 + this.slot * (j + 0.5) - this.trayScroll;
      const w = pc.canvas.width * k, h = pc.canvas.height * k;
      const r = this.rotate ? this.rot[pc.i] : 0;
      if (r) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(r * Math.PI / 2);
        ctx.drawImage(pc.canvas, -w / 2, -h / 2, w, h);
        ctx.restore();
      } else ctx.drawImage(pc.canvas, cx - w / 2, cy - h / 2, w, h);
    }
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    if (this.overTray) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.font = '600 13px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Drop to put back in the tray', this.w / 2, top + 16);
    }
  }
}

let probe;
function safeAreaBottom() {
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;bottom:0;height:0;visibility:hidden;padding-bottom:env(safe-area-inset-bottom)';
    document.body.appendChild(probe);
  }
  return parseFloat(getComputedStyle(probe).paddingBottom) || 0;
}
