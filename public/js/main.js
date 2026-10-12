import { db, requestPersistence } from './db.js';
import { preparePhoto, loadBlobImage, puzzleImage } from './image.js';
import { Cut, chooseGrid } from './geometry.js';
import { shuffled } from './logic.js';
import { Game, BACKGROUNDS, DEFAULT_BG } from './game.js';
import { swatchURL, surface } from './textures.js';
import { PieceGrid } from './piecegrid.js';
import { sfx } from './sound.js';

const $ = (s) => document.querySelector(s);
const screens = { library: $('#screen-library'), new: $('#screen-new'), play: $('#screen-play') };
const COUNTS = [
  [24, 'Quick'], [48, 'Easy'], [100, 'Cozy'], [150, 'Relaxed'], [250, 'Classic'], [500, 'Challenge'], [1000, 'Epic'],
];

// Rough solving time, ~18 seconds a piece.
function estimate(n) {
  const min = (n * 18) / 60;
  if (min < 55) return `about ${Math.max(5, Math.round(min / 5) * 5)} min`;
  const h = Math.round((min / 60) * 2) / 2;
  return `about ${String(h).replace('.5', '½')} hour${h > 1 ? 's' : ''}`;
}

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
  const list = (await db.list()).sort((a, b) => b.updatedAt - a.updatedAt);
  const hour = new Date().getHours();
  $('#greeting').textContent = hour < 5 ? 'Up late?' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  const done = list.filter((r) => r.done);
  const placed = list.reduce((n, r) => n + (r.placed || 0), 0);
  const stats = $('#stats');
  stats.replaceChildren();
  if (list.length) {
    const stat = (n, label) => el('div', { className: 'stat' }, el('strong', { textContent: n.toLocaleString() }), el('span', { textContent: label }));
    stats.append(stat(list.length - done.length, 'in progress'), stat(done.length, 'finished'), stat(placed, 'pieces placed'));
  }
  $('#hero-cta').hidden = list.length > 0;

  // Most recent unfinished puzzle gets a big "continue" card.
  const current = list.find((r) => !r.done);
  const cont = $('#continue');
  cont.hidden = !current;
  if (current) {
    const pct = Math.floor((current.placed / current.total) * 100);
    cont.replaceChildren(el('a', { className: 'continue-card', href: `#/play/${encodeURIComponent(current.id)}` },
      el('div', { className: 'continue-img' }, el('img', { src: current.thumb, alt: '' })),
      el('div', { className: 'continue-body' },
        el('div', { className: 'eyebrow dark', textContent: 'Pick up where you left off' }),
        el('div', { className: 'continue-title', textContent: current.name }),
        el('div', { className: 'card-meta', textContent: `${current.placed} of ${current.total} pieces · ${fmtTime(current.elapsed)}` }),
        el('div', { className: 'progress big' }, el('i', { style: `width:${pct}%` })),
        el('span', { className: 'primary continue-btn', textContent: pct ? `Continue · ${pct}%` : 'Start puzzling' }))));
  }

  const grid = $('#library-grid');
  $('#library-heading').hidden = list.length === 0;
  grid.hidden = list.length === 0; // the hero button covers the empty state
  grid.replaceChildren(
    el('a', { className: 'card new-card', href: '#/new' },
      el('span', { className: 'new-icon', innerHTML: ICONS.piece }),
      el('strong', { textContent: 'New puzzle' }),
      el('span', { className: 'card-meta', textContent: 'From any photo' })),
  );
  for (const rec of list) {
    const pct = Math.floor((rec.placed / rec.total) * 100);
    const meta = rec.done ? `Finished in ${fmtTime(rec.elapsed)}` : `${pct}% done`;
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
        el('span', { className: 'badge', innerHTML: `${ICONS.pieceSmall}${rec.total}` }),
        rec.done ? el('span', { className: 'badge done', textContent: '✓ Done' }) : null),
      el('div', { className: 'card-body' },
        el('div', { className: 'card-title', textContent: rec.name }),
        el('div', { className: 'card-meta', textContent: meta }),
        rec.done ? null : el('div', { className: 'progress' }, el('i', { style: `width:${pct}%` }))),
      del);
    grid.append(card);
  }
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
  $('#start-btn').hidden = true;
  $('#new-error').textContent = '';
  $('#rotate-input').checked = false;
  const d = new Date();
  $('#name-input').value = `Puzzle · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  renderChips();
}

function renderChips() {
  const wrap = $('#count-chips');
  wrap.replaceChildren(...COUNTS.map(([n, label]) => {
    const b = el('button', { className: 'chip' + (n === draft.target ? ' on' : ''), type: 'button' },
      el('strong', { textContent: n }), el('span', { textContent: label }));
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
    $('#start-btn').hidden = false;
    renderPreview(true);
  } catch {
    $('#new-error').textContent = 'Sorry, that photo couldn’t be opened. Try a JPEG or PNG.';
  } finally {
    $('#photo-drop').classList.remove('busy');
  }
}

let previewAnim = 0;

// Draw the photo with its jigsaw cut. The cut lines sweep out from the centre like a
// blade going through, slower the first time a photo is chosen.
function renderPreview(first = false) {
  if (!draft.photo) return;
  const { canvas: src, width, height } = draft.photo;
  draft.grid = chooseGrid(width, height, draft.target);
  const { cols, rows } = draft.grid;
  const n = cols * rows;
  $('#count-detail').textContent = `${n} pieces · ${cols} × ${rows} · ${estimate(n)}`;
  $('#start-btn').textContent = `Cut into ${n} pieces`;

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
  const cut = new Cut(cols, rows, cv.width, cv.height, draft.seed);
  const outline = new Path2D();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cut.trace(outline, c, r);
  const R = Math.hypot(cv.width, cv.height) / 2;
  const dur = first ? 900 : 350;
  const t0 = performance.now();
  cancelAnimationFrame(previewAnim);
  const frame = (t) => {
    const p = Math.min(1, Math.max(0, (t - t0) / dur)); // the first frame's timestamp can predate t0
    const e = 1 - Math.pow(1 - p, 3);
    ctx.drawImage(src, 0, 0, cv.width, cv.height);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cv.width / 2, cv.height / 2, Math.max(1, e * R), 0, Math.PI * 2);
    ctx.clip();
    ctx.lineWidth = 1.6 * dpr;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.stroke(outline);
    ctx.lineWidth = 0.8 * dpr;
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.stroke(outline);
    ctx.restore();
    if (p < 1) {
      // a soft glint riding the edge of the cut
      const g = ctx.createRadialGradient(cv.width / 2, cv.height / 2, Math.max(0, e * R - 30 * dpr), cv.width / 2, cv.height / 2, e * R + 4 * dpr);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.85, `rgba(255,255,255,${0.35 * (1 - p)})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cv.width, cv.height);
      previewAnim = requestAnimationFrame(frame);
    }
  };
  previewAnim = requestAnimationFrame(frame);
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
  piece: '<svg viewBox="15 15 70 70" width="44" height="44"><path fill="currentColor" d="M30 30 H44 C40 16 60 16 56 30 H70 V44 C84 40 84 60 70 56 V70 H56 C60 84 40 84 44 70 H30 V56 C40 60 40 40 30 44 Z"/></svg>',
  pieceSmall: '<svg viewBox="15 15 70 70" width="12" height="12"><path fill="currentColor" d="M30 30 H44 C40 16 60 16 56 30 H70 V44 C84 40 84 60 70 56 V70 H56 C60 84 40 84 44 70 H30 V56 C40 60 40 40 30 44 Z"/></svg>',
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

// The front screens sit on the same wooden table as the game.
try {
  document.documentElement.style.setProperty('--wood', `url(${surface('walnut', 512).toDataURL('image/jpeg', 0.85)})`);
} catch {}

// Handy for debugging in the browser console.
window.puzzle = () => game;

wire();
route();
