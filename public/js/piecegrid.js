// Full-screen view of the tray: every remaining piece in a scrollable grid, as All, Edges
// or Color. Press and hold a piece (or drag it with a mouse) to move it: the small tray
// keeps whatever view and order you leave here. Tap pieces to select them, then place them
// on the table or move them to the front of the tray.
// Drawn on one canvas with virtual scrolling so 1000 pieces stay light on memory.

import { TRAYS } from './textures.js';
import { sfx } from './sound.js';

let savedSize = 92;
try {
  savedSize = parseFloat(localStorage.getItem('pt-grid')) || 92;
} catch {}

export class PieceGrid {
  constructor(els, { onClose } = {}) {
    this.els = els; // { panel, scroll, canvas, spacer, place, front, size, views: { all, edges, color } }
    this.onClose = onClose;
    this.ctx = els.canvas.getContext('2d');
    this.size = savedSize;
    this.selected = [];
    this.raf = 0;
    els.scroll.addEventListener('scroll', () => this.redraw(), { passive: true });
    els.canvas.addEventListener('click', (e) => this.onTap(e));
    els.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    els.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    els.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    els.canvas.addEventListener('pointercancel', () => this.endDrag());
    // While a piece is lifted, a finger moving must move the piece, not scroll the grid.
    els.canvas.addEventListener('touchmove', (e) => this.drag?.active && e.preventDefault(), { passive: false });
    els.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    els.size.addEventListener('input', () => {
      this.size = parseFloat(els.size.value);
      try {
        localStorage.setItem('pt-grid', String(this.size));
      } catch {}
      this.layout();
    });
    for (const [view, btn] of Object.entries(els.views)) btn.addEventListener('click', () => this.setView(view));
    els.front.addEventListener('click', () => {
      const list = this.selected;
      this.close();
      if (list.length) this.game.moveToFront(list);
    });
    els.place.addEventListener('click', () => {
      const list = this.selected;
      this.close();
      if (list.length) this.game.placeMany(list);
    });
    this.ro = new ResizeObserver(() => !els.panel.hidden && this.layout());
    this.ro.observe(els.scroll);
  }

  open(game) {
    this.game = game;
    this.selected = [];
    this.els.panel.hidden = false;
    this.els.size.value = this.size;
    this.els.scroll.scrollTop = 0;
    this.refresh();
  }

  close() {
    this.els.panel.hidden = true;
    this.onClose?.();
  }

  get isOpen() {
    return !this.els.panel.hidden;
  }

  // The grid and the small tray always show the same view.
  setView(view) {
    this.game.setTrayView(view);
    this.els.scroll.scrollTop = 0;
    this.refresh();
  }

  refresh() {
    const g = this.game;
    const list = g.trayList();
    this.list = list;
    this.selected = this.selected.filter((i) => list.includes(i));
    for (const [view, btn] of Object.entries(this.els.views)) btn.classList.toggle('on', g.trayView === view);
    // Same color as the tray on the table.
    this.tray = TRAYS[g.trayColor];
    this.els.scroll.style.background = this.tray.color;
    this.updateFooter();
    this.layout();
  }

  updateFooter() {
    const n = this.selected.length;
    this.els.place.disabled = n === 0;
    this.els.place.textContent = n ? `Place ${n} on table` : 'Tap pieces to select';
    this.els.front.hidden = n === 0;
  }

  layout() {
    const r = this.els.scroll.getBoundingClientRect();
    if (!r.width) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.w = r.width;
    this.h = r.height;
    this.dpr = dpr;
    this.pad = 10;
    this.cols = Math.max(3, Math.floor((this.w - this.pad * 2) / this.size));
    this.cell = (this.w - this.pad * 2) / this.cols;
    const rows = Math.ceil(this.list.length / this.cols);
    const contentH = this.pad * 2 + rows * this.cell + 8;
    const c = this.els.canvas;
    c.width = Math.round(this.w * dpr);
    c.height = Math.round(this.h * dpr);
    c.style.height = `${this.h}px`;
    this.els.spacer.style.height = `${Math.max(0, contentH - this.h)}px`;
    this.redraw();
  }

  redraw() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.draw());
  }

  draw() {
    this.raf = 0;
    const { ctx, dpr, cell, pad, cols, game } = this;
    if (!this.list || !game) return;
    const list = this.order();
    const lifted = this.drag?.active ? this.list[this.drag.from] : null;
    const top = this.els.scroll.scrollTop;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.tray.color;
    ctx.fillRect(0, 0, this.w, this.h);
    if (!list.length) {
      ctx.fillStyle = this.tray.ink;
      ctx.font = '500 15px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(game.edgesOnly ? 'No edge pieces left in the tray' : 'The tray is empty', this.w / 2, 60);
      return;
    }
    const { cut } = game;
    const k = (cell - 10) / (Math.max(cut.pw, cut.ph) * 1.62);
    const first = Math.max(0, Math.floor((top - pad) / cell) * cols);
    const last = Math.min(list.length - 1, Math.ceil((top + this.h - pad) / cell) * cols + cols - 1);
    const sel = new Set(this.selected);
    for (let j = first; j <= last; j++) {
      const idx = list[j];
      if (idx === lifted) continue; // drawn under the finger instead
      const cx = pad + (j % cols + 0.5) * cell;
      const cy = pad + (Math.floor(j / cols) + 0.5) * cell - top;
      if (sel.has(idx)) {
        ctx.fillStyle = 'rgba(239,90,76,0.12)';
        roundRect(ctx, cx - cell / 2 + 3, cy - cell / 2 + 3, cell - 6, cell - 6, 12);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#EF5A4C';
        ctx.stroke();
      }
      const pc = game.pieces[idx];
      const w = pc.canvas.width * k, h = pc.canvas.height * k;
      const r = game.rotate ? game.rot[idx] : 0;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.3)';
      ctx.shadowBlur = 5 * dpr;
      ctx.shadowOffsetY = 2 * dpr;
      ctx.translate(cx, cy);
      if (r) ctx.rotate((r * Math.PI) / 2);
      ctx.drawImage(pc.canvas, -w / 2, -h / 2, w, h);
      ctx.restore();
      if (sel.has(idx)) {
        const n = this.selected.indexOf(idx) + 1;
        const bx = cx + cell / 2 - 16, by = cy - cell / 2 + 16;
        ctx.fillStyle = '#EF5A4C';
        ctx.beginPath();
        ctx.arc(bx, by, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = '700 11px -apple-system, system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(n), bx, by + 0.5);
      }
    }
    if (lifted != null) {
      const pc = game.pieces[lifted];
      const w = pc.canvas.width * k * 1.15, h = pc.canvas.height * k * 1.15;
      const r = game.rotate ? game.rot[lifted] : 0;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.5)';
      ctx.shadowBlur = 14 * dpr;
      ctx.shadowOffsetY = 8 * dpr;
      ctx.translate(this.drag.cx, this.drag.cy);
      if (r) ctx.rotate((r * Math.PI) / 2);
      ctx.drawImage(pc.canvas, -w / 2, -h / 2, w, h);
      ctx.restore();
    }
  }

  // Grid slot under a pointer event (or null), plus the point in canvas coordinates.
  hit(e) {
    const rect = this.els.canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const x = cx - this.pad, y = cy + this.els.scroll.scrollTop - this.pad;
    let j = null;
    if (x >= 0 && y >= 0 && Math.floor(x / this.cell) < this.cols) {
      j = Math.floor(y / this.cell) * this.cols + Math.floor(x / this.cell);
    }
    return { j, cx, cy };
  }

  // ---------- moving pieces around the tray ----------

  onDown(e) {
    sfx.unlock(); // iPhones only allow sound that starts from a touch
    const { j, cx, cy } = this.hit(e);
    if (j == null || j >= this.list.length) return;
    const mouse = e.pointerType === 'mouse';
    this.drag = { id: e.pointerId, from: j, over: j, x0: cx, y0: cy, cx, cy, mouse, active: false };
    if (!mouse) this.drag.timer = setTimeout(() => this.lift(), 350);
  }

  lift() {
    const d = this.drag;
    if (!d) return;
    d.active = true;
    try {
      this.els.canvas.setPointerCapture(d.id);
    } catch {}
    sfx.pick(); // same sound as picking a piece up on the table
    navigator.vibrate?.(10);
    this.redraw();
  }

  onMove(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const { j, cx, cy } = this.hit(e);
    d.cx = cx;
    d.cy = cy;
    if (!d.active) {
      const moved = Math.hypot(cx - d.x0, cy - d.y0);
      if (!d.mouse) {
        if (moved > 10) this.endDrag(); // a scroll, not a press-and-hold
        return;
      }
      if (moved <= 6) return;
      this.lift(); // a mouse drag lifts straight away
    }
    if (j != null) d.over = Math.min(j, this.list.length - 1);
    // Near the top or bottom edge, scroll so the piece can travel further.
    const edge = 50;
    if (cy < edge) this.els.scroll.scrollTop -= 12;
    else if (cy > this.h - edge) this.els.scroll.scrollTop += 12;
    this.redraw();
  }

  onUp(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    if (d.active) {
      this.skipClick = true; // the click that follows a move isn't a tap
      sfx.drop();
      if (d.over !== d.from) {
        this.game.reorderTray(this.order());
        this.refresh();
      }
    }
    this.endDrag();
  }

  endDrag() {
    clearTimeout(this.drag?.timer);
    this.drag = null;
    this.redraw();
  }

  // The tray order with the lifted piece moved to where it's hovering.
  order() {
    const d = this.drag;
    if (!d?.active) return this.list;
    const arr = this.list.slice();
    const [idx] = arr.splice(d.from, 1);
    arr.splice(d.over, 0, idx);
    return arr;
  }

  onTap(e) {
    if (this.skipClick) {
      this.skipClick = false;
      return;
    }
    const { j } = this.hit(e);
    if (j == null || j >= this.list.length) return;
    const idx = this.list[j];
    const at = this.selected.indexOf(idx);
    if (at >= 0) this.selected.splice(at, 1);
    else this.selected.push(idx);
    this.updateFooter();
    this.redraw();
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
