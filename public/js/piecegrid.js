// Full-screen view of the tray: every remaining piece in a scrollable grid, optionally
// sorted by colour. Tap pieces to select them, then place them on the table together.
// Drawn on one canvas with virtual scrolling so 1000 pieces stay light on memory.

import { trayFelt } from './textures.js';

let savedSize = 92;
try {
  savedSize = parseFloat(localStorage.getItem('pt-grid')) || 92;
} catch {}

export class PieceGrid {
  constructor(els, { onClose } = {}) {
    this.els = els; // { panel, scroll, canvas, spacer, title, place, clear, size, edges, sortMixed, sortColour }
    this.onClose = onClose;
    this.ctx = els.canvas.getContext('2d');
    this.size = savedSize;
    this.sort = 'mixed';
    this.selected = [];
    this.raf = 0;
    els.scroll.addEventListener('scroll', () => this.redraw(), { passive: true });
    els.canvas.addEventListener('click', (e) => this.onTap(e));
    els.size.addEventListener('input', () => {
      this.size = parseFloat(els.size.value);
      try {
        localStorage.setItem('pt-grid', String(this.size));
      } catch {}
      this.layout();
    });
    els.edges.addEventListener('click', () => {
      this.game.setEdgesOnly(!this.game.edgesOnly);
      this.refresh();
    });
    els.sortMixed.addEventListener('click', () => this.setSort('mixed'));
    els.sortColour.addEventListener('click', () => this.setSort('colour'));
    els.clear.addEventListener('click', () => {
      this.selected = [];
      this.updateFooter();
      this.redraw();
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

  setSort(mode) {
    this.sort = mode;
    this.els.scroll.scrollTop = 0;
    this.refresh();
  }

  refresh() {
    const g = this.game;
    let list = g.trayList();
    if (this.sort === 'colour') {
      const keys = g.colourKeys();
      list = [...list].sort((a, b) => keys[a] - keys[b]);
    }
    this.list = list;
    this.selected = this.selected.filter((i) => list.includes(i));
    this.els.edges.classList.toggle('on', g.edgesOnly);
    this.els.sortMixed.classList.toggle('on', this.sort === 'mixed');
    this.els.sortColour.classList.toggle('on', this.sort === 'colour');
    const what = g.edgesOnly ? 'edge pieces' : 'pieces';
    this.els.title.textContent = `${list.length} ${what} in the tray`;
    this.updateFooter();
    this.layout();
  }

  updateFooter() {
    const n = this.selected.length;
    this.els.place.disabled = n === 0;
    this.els.place.textContent = n ? `Place ${n} on table` : 'Tap pieces to select';
    this.els.clear.hidden = n === 0;
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
    this.pattern = this.ctx.createPattern(trayFelt(), 'repeat');
    this.redraw();
  }

  redraw() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.draw());
  }

  draw() {
    this.raf = 0;
    const { ctx, dpr, cell, pad, cols, list, game } = this;
    if (!list || !game) return;
    const top = this.els.scroll.scrollTop;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.pattern.setTransform(new DOMMatrix([0.8, 0, 0, 0.8, 0, -top % 410]));
    ctx.fillStyle = this.pattern;
    ctx.fillRect(0, 0, this.w, this.h);
    if (!list.length) {
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
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
      const cx = pad + (j % cols + 0.5) * cell;
      const cy = pad + (Math.floor(j / cols) + 0.5) * cell - top;
      if (sel.has(idx)) {
        ctx.fillStyle = 'rgba(255,248,230,0.16)';
        roundRect(ctx, cx - cell / 2 + 3, cy - cell / 2 + 3, cell - 6, cell - 6, 12);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255,248,230,0.85)';
        ctx.stroke();
      }
      const pc = game.pieces[idx];
      const w = pc.canvas.width * k, h = pc.canvas.height * k;
      const r = game.rotate ? game.rot[idx] : 0;
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = 5 * dpr;
      ctx.shadowOffsetY = 2 * dpr;
      ctx.translate(cx, cy);
      if (r) ctx.rotate((r * Math.PI) / 2);
      ctx.drawImage(pc.canvas, -w / 2, -h / 2, w, h);
      ctx.restore();
      if (sel.has(idx)) {
        const n = this.selected.indexOf(idx) + 1;
        const bx = cx + cell / 2 - 16, by = cy - cell / 2 + 16;
        ctx.fillStyle = '#c4553d';
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
  }

  onTap(e) {
    const rect = this.els.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left - this.pad;
    const y = e.clientY - rect.top + this.els.scroll.scrollTop - this.pad;
    if (x < 0 || y < 0) return;
    const j = Math.floor(y / this.cell) * this.cols + Math.floor(x / this.cell);
    if (Math.floor(x / this.cell) >= this.cols || j >= this.list.length) return;
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
