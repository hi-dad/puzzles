import { db, requestPersistence } from './db.js';
import { preparePhoto, loadBlobImage, puzzleImage } from './image.js';
import { Cut, chooseGrid } from './geometry.js';
import { shuffled } from './logic.js';
import { Game, BACKGROUNDS, DEFAULT_BG } from './game.js';
import { swatchURL } from './textures.js';
import { PieceGrid } from './piecegrid.js';
import { sfx } from './sound.js';

const $ = (s) => document.querySelector(s);
const screens = { library: $('#screen-library'), new: $('#screen-new'), play: $('#screen-play') };
const COUNTS = [24, 48, 100, 150, 250, 500, 1000];

function show(name) {
  for (const [k, el] of Object.entries(screens)) el.hidden = k !== name;
}

function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

// ---------------- routing ----------------

async function route() {
  const h = location.hash || '#/';
  if (!h.startsWith('#/play/')) await closeGame();
  if (h === '#/new') {
    show('new');
    resetNew();
  } else if (h.startsWith('#/play/')) {
    show('play');
    await openGame(decodeURIComponent(h.slice(7)));
  } else {
    show('library');
    await renderLibrary();
  }
}

// ---------------- library ----------------

async function renderLibrary() {
  const grid = $('#library-grid');
  const list = (await db.list()).sort((a, b) => b.updatedAt - a.updatedAt);
  grid.replaceChildren(
    el('a', { className: 'card new-card', href: '#/new' },
      el('span', { className: 'plus', textContent: '+' }),
      el('span', { textContent: 'New puzzle' })),
  );
  for (const rec of list) {
    const pct = Math.floor((rec.placed / rec.total) * 100);
    const meta = rec.done ? `Finished in ${fmtTime(rec.elapsed)}` : `${rec.total} pieces · ${pct}%`;
    const del = el('button', { className: 'card-del', title: 'Delete puzzle', ariaLabel: 'Delete puzzle', innerHTML: ICONS.trash });
    del.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirm(`Delete “${rec.name}”? This can’t be undone.`)) return;
      await db.remove(rec.id);
      renderLibrary();
    });
    const card = el('a', { className: 'card', href: `#/play/${encodeURIComponent(rec.id)}` },
      el('div', { className: 'card-img' },
        el('img', { src: rec.thumb, alt: '' }),
        rec.done ? el('span', { className: 'badge', textContent: 'Done' }) : null),
      el('div', { className: 'card-body' },
        el('div', { className: 'card-title', textContent: rec.name }),
        el('div', { className: 'card-meta', textContent: meta }),
        rec.done ? null : el('div', { className: 'progress' }, el('i', { style: `width:${pct}%` }))),
      del);
    grid.append(card);
  }
  $('#library-empty').hidden = list.length > 0;
}

// ---------------- new puzzle ----------------

const draft = { photo: null, target: 100, seed: 0, grid: null };

function resetNew() {
  draft.photo = null;
  draft.target = 100;
  $('#photo-input').value = '';
  $('#preview-wrap').hidden = true;
  $('#photo-drop').hidden = false;
  $('#new-options').hidden = true;
  $('#start-btn').disabled = true;
  $('#new-error').textContent = '';
  $('#rotate-input').checked = false;
  const d = new Date();
  $('#name-input').value = `Puzzle · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  renderChips();
}

function renderChips() {
  const wrap = $('#count-chips');
  wrap.replaceChildren(...COUNTS.map((n) => {
    const b = el('button', { className: 'chip' + (n === draft.target ? ' on' : ''), textContent: n, type: 'button' });
    b.addEventListener('click', () => {
      draft.target = n;
      renderChips();
      renderPreview();
    });
    return b;
  }));
}

async function onPhoto(file) {
  if (!file) return;
  $('#new-error').textContent = '';
  $('#photo-drop').classList.add('busy');
  try {
    draft.photo = await preparePhoto(file);
    draft.seed = (Math.random() * 2 ** 31) | 0;
    $('#photo-drop').hidden = true;
    $('#preview-wrap').hidden = false;
    $('#new-options').hidden = false;
    $('#start-btn').disabled = false;
    renderPreview();
  } catch {
    $('#new-error').textContent = 'Sorry, that photo couldn’t be opened. Try a JPEG or PNG.';
  } finally {
    $('#photo-drop').classList.remove('busy');
  }
}

function renderPreview() {
  if (!draft.photo) return;
  const { canvas: src, width, height } = draft.photo;
  draft.grid = chooseGrid(width, height, draft.target);
  const { cols, rows } = draft.grid;
  $('#count-detail').textContent = `${cols * rows} pieces · ${cols} × ${rows}`;

  const cv = $('#preview-canvas');
  const box = $('#preview-wrap').getBoundingClientRect();
  const maxW = box.width || 600, maxH = Math.min(window.innerHeight * 0.45, 520);
  const k = Math.min(maxW / width, maxH / height);
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(width * k), h = Math.round(height * k);
  cv.style.width = `${w}px`;
  cv.style.height = `${h}px`;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const ctx = cv.getContext('2d');
  ctx.drawImage(src, 0, 0, cv.width, cv.height);
  const cut = new Cut(cols, rows, cv.width, cv.height, draft.seed);
  const outline = new Path2D();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cut.trace(outline, c, r);
  ctx.lineWidth = 1.6 * dpr;
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.stroke(outline);
  ctx.lineWidth = 0.8 * dpr;
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.stroke(outline);
}

async function startPuzzle() {
  if (!draft.photo) return;
  $('#start-btn').disabled = true;
  const { cols, rows } = draft.grid;
  const now = Date.now();
  const id = crypto.randomUUID?.() ?? `${now}-${Math.random().toString(36).slice(2)}`;
  const rotate = $('#rotate-input').checked;
  const rec = {
    id,
    name: $('#name-input').value.trim() || 'Puzzle',
    createdAt: now,
    updatedAt: now,
    cols,
    rows,
    total: cols * rows,
    seed: draft.seed,
    imgW: 0,
    imgH: 0,
    thumb: draft.photo.thumb,
    elapsed: 0,
    placed: 0,
    done: false,
    bg: DEFAULT_BG,
    ghost: false,
    tray: shuffled(cols * rows),
    groups: [],
    rotate,
    rot: rotate ? Array.from({ length: cols * rows }, () => (Math.random() * 4) | 0) : undefined,
  };
  try {
    const pic = await puzzleImage(draft.photo, cols);
    rec.imgW = pic.width;
    rec.imgH = pic.height;
    await db.putImage(id, pic.blob);
    await db.put(rec);
    requestPersistence();
    location.hash = `#/play/${encodeURIComponent(id)}`;
  } catch {
    $('#new-error').textContent = 'Couldn’t save the puzzle on this device (storage may be full).';
    $('#start-btn').disabled = false;
  }
}

// ---------------- play ----------------

let game = null;
let rec = null;
let pieceGrid = null;
let saveTimer = 0;
let tick = 0;
let lastTick = 0;

async function openGame(id) {
  if (game && rec?.id === id) return;
  await closeGame();
  rec = await db.get(id);
  const blob = rec && (await db.getImage(id));
  if (!rec || !blob) {
    location.hash = '#/';
    return;
  }
  $('#play-title').textContent = rec.name;
  $('#play-loading').hidden = false;
  const img = await loadBlobImage(blob);
  await new Promise((r) => requestAnimationFrame(r)); // let the loading state paint
  game = new Game($('#board'), rec, img, {
    onChange(state) {
      Object.assign(rec, state);
      updateHud();
      scheduleSave();
    },
    onComplete() {
      saveNow();
      showComplete();
    },
  });
  $('#play-loading').hidden = true;
  syncToggles();
  updateHud();
  lastTick = performance.now();
  tick = setInterval(onTick, 1000);
}

async function closeGame() {
  if (!game) return;
  clearInterval(tick);
  await saveNow();
  game.destroy();
  game = null;
  rec = null;
  closeMenu();
  if (pieceGrid?.isOpen) pieceGrid.close();
  $('#complete').hidden = true;
}

function onTick() {
  const now = performance.now();
  if (rec && !rec.done && !document.hidden) {
    rec.elapsed += Math.min(now - lastTick, 5000);
    if (Math.floor(rec.elapsed / 1000) % 15 === 0) scheduleSave();
  }
  lastTick = now;
  updateHud();
}

function updateHud() {
  if (!rec || !game) return;
  $('#play-progress').textContent = `${game.placed()} / ${rec.total}`;
  $('#play-time').textContent = fmtTime(rec.elapsed);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (!rec) return;
  rec.updatedAt = Date.now();
  try {
    await db.put(structuredClone(rec));
  } catch (e) {
    console.warn('save failed', e);
  }
}

function syncToggles() {
  $('#btn-ghost').classList.toggle('on', game.ghost);
  $('#btn-edges').classList.toggle('on', game.edgesOnly);
  $('#btn-sound').classList.toggle('on', sfx.enabled);
  $('#btn-sound').querySelector('span').textContent = sfx.enabled ? 'Sound on' : 'Sound off';
  for (const b of document.querySelectorAll('.swatch')) b.classList.toggle('on', b.dataset.bg === game.bg);
  $('#tray-size').value = game.trayScale;
}

function closeMenu() {
  $('#menu').hidden = true;
}

function showComplete() {
  $('#complete-img').src = rec.thumb;
  $('#complete-stats').textContent = `${rec.total} pieces in ${fmtTime(rec.elapsed)}`;
  const conf = $('#confetti');
  conf.replaceChildren();
  const colors = ['#e76f51', '#f4a261', '#e9c46a', '#2a9d8f', '#8ab17d', '#f6f1e7'];
  for (let i = 0; i < 90; i++) {
    conf.append(el('i', {
      style: `left:${Math.random() * 100}%;background:${colors[i % colors.length]};` +
        `animation-delay:${Math.random() * 0.8}s;animation-duration:${2.2 + Math.random() * 1.8}s;` +
        `transform:rotate(${Math.random() * 360}deg)`,
    }));
  }
  $('#complete').hidden = false;
}

// ---------------- wiring ----------------

const ICONS = {
  trash: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
};

function wire() {
  window.addEventListener('hashchange', route);
  $('#photo-input').addEventListener('change', (e) => onPhoto(e.target.files[0]));
  const drop = $('#photo-drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    onPhoto(e.dataTransfer.files[0]);
  });
  $('#change-photo').addEventListener('click', () => $('#photo-input').click());
  $('#start-btn').addEventListener('click', startPuzzle);
  window.addEventListener('resize', () => !screens.new.hidden && renderPreview());

  $('#btn-ghost').addEventListener('click', () => {
    game.setGhost(!game.ghost);
    syncToggles();
  });
  $('#btn-edges').addEventListener('click', () => {
    game.setEdgesOnly(!game.edgesOnly);
    syncToggles();
  });
  $('#btn-fit').addEventListener('click', () => game.fit());
  const grid = new PieceGrid({
    panel: $('#pieces-panel'), scroll: $('#pieces-scroll'), canvas: $('#pieces-canvas'), spacer: $('#pieces-spacer'),
    title: $('#pieces-title'), place: $('#pieces-place'), clear: $('#pieces-clear'), size: $('#pieces-size'),
    edges: $('#pieces-edges'), sortMixed: $('#sort-mixed'), sortColour: $('#sort-colour'),
  }, { onClose: () => syncToggles() });
  pieceGrid = grid;
  $('#btn-pieces').addEventListener('click', () => grid.open(game));
  $('#pieces-close').addEventListener('click', () => grid.close());
  $('#btn-zoom-in').addEventListener('click', () => game.zoomBy(1.4));
  $('#btn-zoom-out').addEventListener('click', () => game.zoomBy(1 / 1.4));
  $('#btn-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    for (const b of document.querySelectorAll('.swatch:not([style])')) b.style.backgroundImage = `url(${swatchURL(b.dataset.bg)})`;
    $('#menu').hidden = !$('#menu').hidden;
  });
  document.addEventListener('pointerdown', (e) => {
    if (!$('#menu').hidden && !e.target.closest('#menu, #btn-menu')) closeMenu();
  });
  const swatches = $('#swatches');
  for (const [key, { label }] of Object.entries(BACKGROUNDS)) {
    const b = el('button', { className: 'swatch', title: label, ariaLabel: `${label} table` });
    b.dataset.bg = key;
    b.addEventListener('click', () => {
      game.setBackground(key);
      syncToggles();
    });
    swatches.append(b);
  }
  $('#tray-size').addEventListener('input', (e) => game.setTrayScale(parseFloat(e.target.value)));
  $('#btn-sound').addEventListener('click', () => {
    sfx.enabled = !sfx.enabled;
    syncToggles();
  });
  $('#complete-close').addEventListener('click', () => ($('#complete').hidden = true));

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) saveNow();
    else lastTick = performance.now();
  });
  window.addEventListener('pagehide', saveNow);
  // Stop iOS Safari from zooming the whole page on pinch / double-tap outside the board.
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
}

// Handy for debugging in the browser console.
window.puzzle = () => game;

wire();
route();
