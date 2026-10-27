import { db, requestPersistence } from './db.js';
import { cloud } from './sync.js';
import { preparePhoto, loadBlobImage, puzzleImage } from './image.js';
import { Cut, chooseGrid } from './geometry.js';
import { shuffled } from './logic.js';
import { FORMAT_VERSION, canOpen } from './format.js';
import { Game, BACKGROUNDS, MATS, TRAYS, DEFAULT_BG } from './game.js';
import { swatchURL, matSwatchURL } from './textures.js';
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
    syncNow(); // re-renders if another device changed anything
  }
}

// ---------------- library ----------------

// Which puzzles the library shows: 'progress', 'done' or 'all'.
let libFilter = 'progress';

async function renderLibrary() {
  const list = (await db.list()).sort((a, b) => b.updatedAt - a.updatedAt);
  const done = list.filter((r) => r.done);
  const going = list.filter((r) => !r.done);
  $('#empty').hidden = list.length > 0;

  // Most recent unfinished puzzle gets a big "continue" card.
  const current = going[0];
  const cont = $('#continue');
  cont.hidden = !current;
  if (current) {
    const pct = Math.floor((current.placed / current.total) * 100);
    cont.replaceChildren(el('a', { className: 'continue-card', href: `#/play/${encodeURIComponent(current.id)}` },
      el('div', { className: 'continue-img' }, el('img', { src: current.thumb, alt: '' })),
      el('div', { className: 'continue-body' },
        el('div', { className: 'eyebrow', textContent: 'Pick up where you left off' }),
        el('div', { className: 'continue-title', textContent: current.name }),
        el('div', { className: 'card-meta', textContent: `${current.placed} / ${current.total} pieces · ${fmtTime(current.elapsed)}` }),
        el('div', { className: 'progress big' }, el('i', { style: `width:${pct}%` }))),
      el('span', { className: 'primary continue-btn', textContent: current.elapsed > 0 ? 'Resume' : 'Start' })));
  }

  if (libFilter === 'progress' && !going.length) libFilter = 'all';
  if (libFilter === 'done' && !done.length) libFilter = 'all';
  $('#library-head').hidden = list.length === 0;
  const filters = [['progress', 'In progress', going.length], ['done', 'Finished', done.length], ['all', 'All', list.length]];
  $('#lib-filters').replaceChildren(...filters.filter(([, , n]) => n).map(([key, label, n]) => {
    const b = el('button', { className: 'filter' + (key === libFilter ? ' on' : ''), type: 'button' },
      label, el('span', { textContent: n }));
    b.addEventListener('click', () => {
      libFilter = key;
      renderLibrary();
    });
    return b;
  }));

  const shown = libFilter === 'progress' ? going : libFilter === 'done' ? done : list;
  const grid = $('#library-grid');
  grid.hidden = list.length === 0; // the empty state covers it
  grid.replaceChildren();
  for (const rec of shown) {
    const pct = Math.floor((rec.placed / rec.total) * 100);
    const meta = rec.done ? `Finished in ${fmtTime(rec.elapsed)}` : `${rec.placed} / ${rec.total} pieces`;
    const del = el('button', { className: 'card-del', title: 'Delete puzzle', ariaLabel: 'Delete puzzle', innerHTML: ICONS.trash });
    del.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirm(`Delete “${rec.name}”? This can’t be undone.`)) return;
      await db.remove(rec.id);
      cloud.remove(rec.id);
      renderLibrary();
    });
    const card = el('a', { className: 'card', href: `#/play/${encodeURIComponent(rec.id)}` },
      el('div', { className: 'card-img' },
        el('img', { src: rec.thumb, alt: '' }),
        rec.done ? el('span', { className: 'badge done', textContent: '✓ Finished' }) : null),
      rec.done ? null : el('div', { className: 'progress' }, el('i', { style: `width:${pct}%` })),
      el('div', { className: 'card-body' },
        el('div', { className: 'card-title', textContent: rec.name }),
        el('div', { className: 'card-meta', textContent: meta })),
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
    v: FORMAT_VERSION,
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
    cloud.pushNow(id); // uploads the photo + puzzle in the background
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
let dirty = false;
let lastActive = 0;
const IDLE_MS = 120_000;

async function openGame(id) {
  if (game && rec?.id === id) return;
  await closeGame();
  $('#play-loading').hidden = false;
  // Pick up newer progress from another device first (but don't wait forever offline).
  await Promise.race([cloud.refresh(id), new Promise((r) => setTimeout(r, 3000))]);
  rec = await db.get(id);
  const blob = rec && ((await db.getImage(id)) || (await cloud.fetchImage(id)));
  if (!rec || !blob) {
    $('#play-loading').hidden = true;
    location.hash = '#/';
    return;
  }
  if (!canOpen(rec)) {
    $('#play-loading').hidden = true;
    rec = null;
    alert('This puzzle was saved by a newer version of Poozles. Reload the page (or update the app) to open it.');
    location.hash = '#/';
    return;
  }
  $('#play-title').textContent = rec.name;
  dirty = false;
  lastActive = performance.now();
  cloud.openId = id;
  const img = await loadBlobImage(blob);
  await new Promise((r) => requestAnimationFrame(r)); // let the loading state paint
  game = new Game($('#board'), rec, img, {
    onChange(state) {
      Object.assign(rec, state);
      dirty = true;
      updateHud();
      scheduleSave();
    },
    onActivity() {
      lastActive = performance.now();
    },
    onSelection: showSelection,
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
  cloud.flush();
  cloud.openId = null;
  $('#conflict').hidden = true;
  game.destroy();
  game = null;
  rec = null;
  closeMenu();
  if (pieceGrid?.isOpen) pieceGrid.close();
  $('#complete').hidden = true;
  $('#select-hint').hidden = true;
  $('#btn-select').classList.remove('on');
  $('#toast').hidden = true;
}

function onTick() {
  const now = performance.now();
  // The clock only runs while she's actually puzzling (paused after 2 idle minutes), so
  // a device left open in the background never saves over progress made elsewhere.
  if (rec && !rec.done && !document.hidden && now - lastActive < IDLE_MS) {
    rec.elapsed += Math.min(now - lastTick, 5000);
    dirty = true;
    if (Math.floor(rec.elapsed / 1000) % 15 === 0) scheduleSave();
  }
  lastTick = now;
  updateHud();
}

function updateHud() {
  if (!rec || !game) return;
  const placed = game.placed();
  $('#play-progress').textContent = `${placed} / ${rec.total}`;
  $('#play-line').style.width = `${(placed / rec.total) * 100}%`;
  $('#play-time').textContent = fmtTime(rec.elapsed);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
}

async function saveNow() {
  clearTimeout(saveTimer);
  if (!rec || !dirty) return;
  dirty = false;
  rec.v ??= FORMAT_VERSION;
  rec.updatedAt = Date.now();
  try {
    await db.put(structuredClone(rec));
    cloud.queuePush(rec.id);
  } catch (e) {
    console.warn('save failed', e);
  }
}

// Another device saved the open puzzle more recently.
function onConflict(id) {
  if (rec?.id === id) $('#conflict').hidden = false;
}

async function resolveConflict(load) {
  $('#conflict').hidden = true;
  if (!rec) return;
  const id = rec.id;
  if (load) {
    dirty = false; // drop this device's copy
    await cloud.pull(id).catch(() => {});
    await closeGame();
    await openGame(id);
  } else {
    dirty = true; // re-save ours as the newest
    await saveNow();
    cloud.flush();
  }
}

async function syncNow() {
  const changed = await cloud.syncAll({ openId: rec?.id ?? null, onConflict });
  if (changed && !screens.library.hidden) renderLibrary();
}

const CLOUD_TEXT = {
  synced: '☁︎ Synced',
  saving: 'Saving…',
  offline: 'Offline · saved on this device',
  update: 'Reload to update Poozles',
  'signed-out': 'Sign in to sync',
};

function showCloud(s) {
  const pill = $('#cloud-status');
  const mini = $('#play-cloud');
  const text = CLOUD_TEXT[s];
  pill.hidden = !text;
  pill.textContent = text || '';
  pill.title = cloud.email || '';
  pill.dataset.state = s;
  mini.textContent = text ? ` · ${s === 'synced' ? '☁︎' : text}` : '';
  mini.title = text || '';
  $('#hero-signin').hidden = s !== 'signed-out';
}

// ---------------- sign-in ----------------

let signinReady = null;

function loadScript(src) {
  return new Promise((resolve, reject) => document.head.append(el('script', { src, async: true, onload: resolve, onerror: reject })));
}

// Load Apple's and Google's sign-in buttons the first time the sheet opens.
async function prepareSignIn() {
  const cfg = await cloud.config();
  const tasks = [];
  if (cfg.appleServicesId) {
    tasks.push(loadScript('https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js').then(() => {
      $('#appleid-signin').hidden = false;
      AppleID.auth.init({ clientId: cfg.appleServicesId, scope: 'name email', redirectURI: `${location.origin}/`, usePopup: true });
    }));
  }
  if (cfg.googleClientId) {
    tasks.push(loadScript('https://accounts.google.com/gsi/client').then(() => {
      google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: (r) => finishSignIn('google', r.credential) });
      google.accounts.id.renderButton($('#google-btn'), { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', width: 280 });
    }));
  }
  $('#signin-dev').hidden = !cfg.dev;
  await Promise.allSettled(tasks);
  if (!cfg.appleServicesId && !cfg.googleClientId && !cfg.dev) $('#signin-error').textContent = 'Sign-in isn’t available right now.';
}

function openSignIn() {
  signinReady ??= prepareSignIn();
  $('#signin-error').textContent = '';
  $('#signin').hidden = false;
}

async function finishSignIn(provider, idToken) {
  $('#signin-error').textContent = '';
  if (!(await cloud.signIn(provider, idToken))) {
    $('#signin-error').textContent = 'Sign-in didn’t work. Please try again.';
    return;
  }
  $('#signin').hidden = true;
  syncNow();
}

function openAccount() {
  $('#account-email').textContent = cloud.email;
  $('#account').hidden = false;
}

async function signOut(deleteAccount) {
  if (deleteAccount && !confirm('Delete your Poozles account? Your puzzles and photos will be erased from every device. This can’t be undone.')) return;
  if (!(await cloud.signOut({ deleteAccount }))) {
    alert('Couldn’t delete your account right now. Please try again when you’re online.');
    return;
  }
  location.hash = '#/';
  location.reload();
}

function syncToggles() {
  $('#btn-ghost').classList.toggle('on', game.ghost);
  $('#btn-edges').classList.toggle('on', game.edgesOnly);
  $('#btn-sound').classList.toggle('on', sfx.enabled);
  $('#btn-sound').querySelector('span').textContent = sfx.enabled ? 'Sound on' : 'Sound off';
  for (const b of document.querySelectorAll('.swatch[data-bg]')) b.classList.toggle('on', b.dataset.bg === game.bg);
  for (const b of document.querySelectorAll('.swatch[data-mat]')) b.classList.toggle('on', b.dataset.mat === game.mat);
  for (const b of document.querySelectorAll('.swatch[data-tray]')) b.classList.toggle('on', b.dataset.tray === game.trayColor);
  $('#btn-tray-rows').classList.toggle('on', game.trayRows === 2);
  $('#tray-size').value = game.trayScale;
  const colour = game.traySort === 'colour';
  $('#tray-sort').textContent = colour ? '● Sorted by colour' : 'Sort by colour';
  $('#tray-sort').classList.toggle('on', colour);
}

// Selecting several pieces: highlight the button and explain what to do.
function showSelection({ mode, groups, pieces }) {
  $('#btn-select').classList.toggle('on', mode);
  const hint = $('#select-hint');
  hint.hidden = !mode && groups === 0;
  if (hint.hidden) return;
  const touch = matchMedia('(pointer: coarse)').matches;
  $('#select-text').textContent = groups
    ? `${pieces} piece${pieces === 1 ? '' : 's'} selected · drag one to move them all`
    : touch
      ? 'Tap pieces or drag a box around them · two fingers to move the table'
      : 'Click pieces or drag a box around them';
}

let toastTimer = 0;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
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
  $('#btn-select').addEventListener('click', () => game.setSelectMode(!game.selectMode));
  $('#select-done').addEventListener('click', () => game.setSelectMode(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && game && (game.selectMode || game.selected.size)) game.setSelectMode(false);
  });
  $('#btn-tidy').addEventListener('click', () => {
    const n = game.tidy();
    toast(n ? `Sent ${n} loose piece${n === 1 ? '' : 's'} back to the tray` : 'No loose pieces to tidy up');
  });
  $('#tray-sort').addEventListener('click', () => {
    game.setTraySort(game.traySort === 'colour' ? 'mixed' : 'colour');
    syncToggles();
  });
  $('#btn-zoom-in').addEventListener('click', () => game.zoomBy(1.4));
  $('#btn-zoom-out').addEventListener('click', () => game.zoomBy(1 / 1.4));
  $('#btn-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    for (const b of document.querySelectorAll('.swatch[data-bg]:not([style])')) b.style.backgroundImage = `url(${swatchURL(b.dataset.bg)})`;
    for (const b of document.querySelectorAll('.swatch[data-mat]:not([style])')) b.style.backgroundImage = `url(${matSwatchURL(b.dataset.mat)})`;
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
  for (const [key, { label, color }] of Object.entries(TRAYS)) {
    const b = el('button', { className: 'swatch', title: label, ariaLabel: label, style: `background:${color}` });
    b.dataset.tray = key;
    b.addEventListener('click', () => {
      game.setTrayColor(key);
      syncToggles();
    });
    $('#trays').append(b);
  }
  for (const [key, { label }] of Object.entries(MATS)) {
    const b = el('button', { className: 'swatch', title: label, ariaLabel: label });
    b.dataset.mat = key;
    b.addEventListener('click', () => {
      game.setMat(key);
      syncToggles();
    });
    $('#mats').append(b);
  }
  $('#btn-tray-rows').addEventListener('click', () => {
    game.setTrayRows(game.trayRows === 2 ? 1 : 2);
    syncToggles();
  });
  $('#tray-size').addEventListener('input', (e) => game.setTrayScale(parseFloat(e.target.value)));
  $('#btn-sound').addEventListener('click', () => {
    sfx.enabled = !sfx.enabled;
    syncToggles();
  });
  $('#complete-close').addEventListener('click', () => ($('#complete').hidden = true));

  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) {
      await saveNow();
      cloud.flush();
    } else {
      lastTick = performance.now();
      syncNow();
    }
  });
  window.addEventListener('focus', () => syncNow());
  window.addEventListener('pagehide', () => {
    saveNow();
    cloud.flush();
  });
  setInterval(() => !document.hidden && syncNow(), 120_000);
  $('#conflict-load').addEventListener('click', () => resolveConflict(true));
  $('#conflict-keep').addEventListener('click', () => resolveConflict(false));
  $('#cloud-status').addEventListener('click', () => {
    if (cloud.status === 'signed-out') openSignIn();
    else if (cloud.status === 'update') location.reload();
    else if (cloud.email) openAccount();
  });
  $('#hero-signin').addEventListener('click', openSignIn);
  $('#btn-account').addEventListener('click', () => (cloud.email ? openAccount() : openSignIn()));
  $('#signin-cancel').addEventListener('click', () => ($('#signin').hidden = true));
  $('#signin-dev').addEventListener('click', () => finishSignIn('dev'));
  document.addEventListener('AppleIDSignInOnSuccess', (e) => finishSignIn('apple', e.detail.authorization.id_token));
  document.addEventListener('AppleIDSignInOnFailure', (e) => {
    if (e.detail?.error !== 'popup_closed_by_user') $('#signin-error').textContent = 'Apple sign-in didn’t work. Please try again.';
  });
  $('#account-close').addEventListener('click', () => ($('#account').hidden = true));
  $('#account-signout').addEventListener('click', () => signOut(false));
  $('#account-delete').addEventListener('click', () => signOut(true));
  cloud.onConflict = onConflict;
  cloud.onLocalChange = () => !screens.library.hidden && renderLibrary();
  cloud.onStatus(showCloud);
  // Stop iOS Safari from zooming the whole page on pinch / double-tap outside the board.
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
}

// Handy for debugging in the browser console.
window.puzzle = () => game;

wire();
route();
cloud.init().then(syncNow);
