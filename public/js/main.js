import { db, requestPersistence } from './db.js';
import { cloud } from './sync.js';
import { preparePhoto, loadBlobImage, puzzleImage } from './image.js';
import { Cut, chooseGrid } from './geometry.js';
import { shuffled } from './logic.js';
import { FORMAT_VERSION, canOpen } from './format.js';
import { Room } from './room.js';
import { app, site, post as postNative } from './native.js';
import { Game, BACKGROUNDS, MATS, TRAYS, DEFAULT_BG } from './game.js';
import { swatchURL, matSwatchURL } from './textures.js';
import { PieceGrid } from './piecegrid.js';
import { sfx } from './sound.js';

const $ = (s) => document.querySelector(s);
const screens = {
  welcome: $('#screen-welcome'), library: $('#screen-library'), new: $('#screen-new'), play: $('#screen-play'),
};
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

// Poozles asks everyone to sign in; signed-out visitors get the welcome page. This device
// remembers that someone signed in, so the library still opens offline or before the
// server has answered.
const SIGNED_IN_KEY = 'pz-signed-in';
function rememberSignedIn(on) {
  try {
    if (on) localStorage.setItem(SIGNED_IN_KEY, '1');
    else localStorage.removeItem(SIGNED_IN_KEY);
  } catch {}
}
// "Not now" on the sign-in sheet: play as a guest, with puzzles kept only on this
// device. They upload to the account if the guest signs in later.
const GUEST_KEY = 'pz-guest';
function setGuest(on) {
  try {
    if (on) localStorage.setItem(GUEST_KEY, '1');
    else localStorage.removeItem(GUEST_KEY);
  } catch {}
}
function isGuest() {
  try {
    return localStorage.getItem(GUEST_KEY) === '1';
  } catch {
    return false;
  }
}
function needsSignIn() {
  if (isGuest() && !cloud.email) return false;
  if (cloud.status === 'signed-out') return true;
  if (cloud.status !== 'checking') return false;
  try {
    return localStorage.getItem(SIGNED_IN_KEY) !== '1';
  } catch {
    return true;
  }
}
let startAfterSignIn = false; // "Choose a photo" was tapped while signed out

async function route() {
  const h = location.hash || '#/';
  if (needsSignIn()) {
    await closeGame();
    show('welcome');
    if (h === '#/new') {
      startAfterSignIn = true;
      openSignIn('Sign in to start a puzzle.');
    }
    return;
  }
  if (!h.startsWith('#/play/')) await closeGame();
  if (h === '#/new') {
    show('new');
    resetNew();
  } else if (h.startsWith('#/play/')) {
    show('play');
    await openGame(decodeURIComponent(h.slice(7)));
  } else {
    show('library');
    syncNow(); // re-renders if another device changed anything
    await renderLibrary();
  }
}

// ---------------- library ----------------

// Which puzzles the library shows: 'progress', 'done' or 'all'.
let libFilter = 'progress';

async function renderLibrary() {
  const list = (await db.list()).sort((a, b) => b.updatedAt - a.updatedAt);
  const done = list.filter((r) => r.done);
  const going = list.filter((r) => !r.done);
  libCount = list.length;
  showLibLoading();

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
      const ask = rec.shared
        ? `Remove “${rec.name}” from your puzzles? The others can keep playing it.`
        : `Delete “${rec.name}”? This can’t be undone.`;
      if (!confirm(ask)) return;
      await db.remove(rec.id);
      cloud.remove(rec.id);
      renderLibrary();
    });
    const card = el('a', { className: 'card', href: `#/play/${encodeURIComponent(rec.id)}` },
      el('div', { className: 'card-img' },
        el('img', { src: rec.thumb, alt: '' }),
        rec.done ? el('span', { className: 'badge done', textContent: '✓ Finished' }) : null,
        rec.shared ? el('span', { className: 'badge shared', textContent: 'Shared' }) : null),
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

// Size of the floating buttons on the puzzle screen (Settings → Button size).
function savedButtonSize() {
  try {
    const v = parseFloat(localStorage.getItem('pt-btn'));
    if (v >= 0.85 && v <= 1.5) return v;
  } catch {}
  return 1;
}
function setButtonSize(v) {
  screens.play.style.setProperty('--btn', String(v));
  try {
    localStorage.setItem('pt-btn', String(v));
  } catch {}
}

// ---------------- playing together ----------------

let room = null;
let myPid = null; // this device's player id in the room
let pendingJoin = null; // invite code from a /join/CODE link, used once signed in

function connectRoom(id) {
  let first = true;
  room = new Room(id, {
    init(msg) {
      if (!game || rec?.id !== id) return;
      myPid = msg.you;
      game.remote.clear();
      for (const h of msg.holds) if (h.pieces.length) game.remoteHold(h.pid, h.name, h.color, h.pieces);
      game.loadState(msg.state);
      rec.elapsed = Math.max(rec.elapsed || 0, msg.state.elapsed || 0);
      Object.assign(rec, game.serialize());
      showPlayers(msg.players);
      if (first) {
        first = false;
        $('#play-loading').hidden = true;
        syncToggles();
        lastTick = performance.now();
        tick = setInterval(onTick, 1000);
      }
      updateHud();
    },
    players: (msg) => showPlayers(msg.players),
    hold: (msg) => game?.remoteHold(msg.pid, msg.name, msg.color, msg.pieces),
    release: (msg) => game?.remoteRelease(msg.pid),
    deny: (msg) => game?.denyGrab(msg.pieces),
    drag: (msg) => game?.remoteDrag(msg.groups),
    patch(msg) {
      if (!game) return;
      const moved = [...(game.remote.get(msg.pid)?.pieces || [])];
      game.remoteRelease(msg.pid);
      game.applyRemote(msg.patch, moved);
      if (Number.isFinite(msg.elapsed)) rec.elapsed = Math.max(rec.elapsed, msg.elapsed);
    },
    status(s) {
      $('#play-cloud').textContent = s === 'reconnecting' ? ' · Reconnecting…' : '';
    },
    gone() {
      location.hash = '#/';
      notice('You’re not in this puzzle any more', 'It was removed from your puzzles, maybe on another device.');
      syncNow();
    },
  });
}

// Faces of everyone playing right now (only shown on shared puzzles).
// Who else is here: one face, plus "+2" for the rest (names on hover / long-press).
function showPlayers(players) {
  const wrap = $('#play-players');
  const others = players.filter((p) => p.pid !== myPid);
  const [first, ...rest] = others;
  wrap.replaceChildren(
    ...(first ? [el('span', {
      className: 'player', textContent: (first.name || '?')[0].toUpperCase(), style: `background:${first.color}`,
    })] : []),
    ...(rest.length ? [el('span', { className: 'player more', textContent: `+${rest.length}` })] : []),
  );
  wrap.title = others.map((p) => p.name).join(', ');
  wrap.hidden = others.length === 0;
}

// "Play together": share this puzzle (first time) and show its invite link and code.
async function openShare() {
  closeMenu();
  if (!rec) return;
  if (!cloud.email) {
    openSignIn('Sign in to play this puzzle with others.');
    return;
  }
  let code = rec.shared?.code;
  if (!code) {
    await saveNow();
    await cloud.pushNow(rec.id); // the room needs the latest board and the photo
    const r = await cloud.share(rec.id);
    if (!r.ok) {
      notice('Couldn’t share yet', r.error || 'Please try again in a moment.');
      return;
    }
    code = r.code;
    const id = rec.id;
    await cloud.pull(id);
    await closeGame();
    await openGame(id); // reopen as a shared puzzle, connected to its room
  }
  const link = `${site}/join/${code}`;
  $('#share-code').textContent = code;
  $('#share-link').textContent = link.replace(/^https?:\/\//, '');
  $('#share-native').hidden = !app && !navigator.share;
  $('#share').hidden = false;
  $('#share').dataset.link = link;
}

// A message in the app's own style (in place of the browser's alert box).
function notice(title, text) {
  $('#notice-title').textContent = title;
  $('#notice-text').textContent = text;
  $('#notice').hidden = false;
}

const JOIN_ERRORS = {
  409: ['This puzzle is full', 'It already has 4 players, the most a puzzle can have.'],
  404: ['Code not found', 'Double-check the 6 letters, or ask for the link again.'],
  400: ['Code not found', 'Double-check the 6 letters, or ask for the link again.'],
};

// Returns an error [title, text] or null once joined (and the puzzle is opening).
async function joinByCode(code) {
  const r = await cloud.join(code);
  if (!r.ok) {
    const err = JOIN_ERRORS[r.status] || ['Couldn’t join', 'You might be offline. Please try again in a moment.'];
    notice(...err);
    return err;
  }
  await cloud.syncAll();
  location.hash = `#/play/${encodeURIComponent(r.id)}`;
}

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
    notice('Update Poozles to open this', 'This puzzle was saved by a newer version of Poozles. Reload the page (or update the app) to open it.');
    location.hash = '#/';
    return;
  }
  if (rec.shared && !navigator.onLine) {
    $('#play-loading').hidden = true;
    rec = null;
    notice('You’re offline', 'Shared puzzles need an internet connection. Your own puzzles still work offline.');
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
    ...(rec.shared ? {
      onGrab: (pieces) => room?.hold(pieces),
      onDrag: (groups) => room?.drag(groups),
      onPatch: (patch) => room?.patch(patch, rec.elapsed),
      onRelease: () => room?.release(),
    } : {}),
  });
  if (rec.shared) {
    connectRoom(id);
    return; // the board shows once the room has sent it (see connectRoom)
  }
  $('#play-loading').hidden = true;
  syncToggles();
  updateHud();
  lastTick = performance.now();
  tick = setInterval(onTick, 1000);
}

async function closeGame() {
  if (!game) return;
  clearInterval(tick);
  room?.close();
  room = null;
  showPlayers([]);
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
    if (!rec.shared) cloud.queuePush(rec.id); // the live room saves shared puzzles
  } catch (e) {
    console.warn('save failed', e);
  }
}

// Another device saved the open puzzle more recently.
function onConflict(id) {
  if (rec?.id === id && !rec.shared) $('#conflict').hidden = false;
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
  syncing++;
  showLibLoading();
  let changed;
  try {
    changed = await cloud.syncAll({ openId: rec?.id ?? null, onConflict });
  } finally {
    syncing--;
  }
  if (changed && !screens.library.hidden) renderLibrary();
  else showLibLoading();
}

// An empty library while puzzles are still downloading (just signed in, or a new
// device) shows "Loading your puzzles…" instead of the first-puzzle invitation.
let syncing = 0;
let libCount = null; // puzzles on this device, once the library has been drawn
function showLibLoading() {
  if (libCount === null) return;
  const loading = libCount === 0 && (syncing > 0 || cloud.status === 'checking');
  $('#lib-loading').hidden = !loading;
  $('#empty').hidden = libCount > 0 || loading;
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
  if (app) {
    // The iPhone app signs in with its own native Apple and Google sheets.
    $('#signin-native-apple').hidden = false;
    $('#signin-native-google').hidden = false;
    $('#signin-dev').hidden = !(await cloud.config()).dev; // only on a test server
    return;
  }
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

function openSignIn(reason) {
  signinReady ??= prepareSignIn();
  $('#signin-reason').textContent = reason || 'Keep your puzzles safe and on all your devices.';
  $('#signin-error').textContent = '';
  $('#signin').hidden = false;
}

async function finishSignIn(provider, idToken, name, code) {
  $('#signin-error').textContent = '';
  if (!(await cloud.signIn(provider, idToken, name, code))) {
    $('#signin-error').textContent = 'Sign-in didn’t work. Please try again.';
    return;
  }
  await afterSignIn();
}

async function afterSignIn() {
  $('#signin').hidden = true;
  rememberSignedIn(true);
  await syncNow();
  if (startAfterSignIn) {
    startAfterSignIn = false;
    location.hash = '#/new';
  }
  if (pendingJoin) {
    const code = pendingJoin;
    pendingJoin = null;
    joinByCode(code);
  }
}

function openAccount() {
  $('#account-email').textContent = cloud.email;
  $('#account').hidden = false;
}

function closeAccount() {
  $('#account').hidden = true;
  $('#account-main').hidden = false;
  $('#account-confirm').hidden = true;
}

// Returns false if the account couldn't be deleted (the confirm step shows why).
async function signOut(deleteAccount) {
  if (!(await cloud.signOut({ deleteAccount }))) return false;
  rememberSignedIn(false);
  setGuest(false);
  location.hash = '#/';
  location.reload();
}

function syncToggles() {
  $('#btn-ghost').classList.toggle('on', game.ghost);
  for (const b of document.querySelectorAll('#tray-views button')) b.classList.toggle('on', b.dataset.view === game.trayView);
  // Select is for touch screens (taps and drags are hard to tell apart) and for rotation
  // puzzles, where a click turns a piece. Otherwise a click on a piece selects it.
  $('#btn-select').hidden = !(game.rotate || matchMedia('(pointer: coarse)').matches);
  $('#btn-size').value = savedButtonSize();
  $('#btn-sound').classList.toggle('on', sfx.enabled);
  $('#btn-sound').querySelector('span').textContent = sfx.enabled ? 'Sound on' : 'Sound off';
  for (const b of document.querySelectorAll('.swatch[data-bg]')) b.classList.toggle('on', b.dataset.bg === game.bg);
  for (const b of document.querySelectorAll('.swatch[data-mat]')) b.classList.toggle('on', b.dataset.mat === game.mat);
  for (const b of document.querySelectorAll('.swatch[data-tray]')) b.classList.toggle('on', b.dataset.tray === game.trayColor);
  $('#btn-tray-rows').classList.toggle('on', game.trayRows === 2);
  $('#tray-size').value = game.trayScale;
}

// Selecting several pieces: highlight the button and explain what to do.
function showSelection({ mode }) {
  $('#btn-select').classList.toggle('on', mode);
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
  const grid = new PieceGrid({
    panel: $('#pieces-panel'), scroll: $('#pieces-scroll'), canvas: $('#pieces-canvas'), spacer: $('#pieces-spacer'),
    place: $('#pieces-place'), front: $('#pieces-front'), size: $('#pieces-size'),
    views: { all: $('#view-all'), edges: $('#view-edges'), color: $('#view-color') },

  }, { onClose: () => syncToggles() });
  pieceGrid = grid;
  $('#btn-pieces').addEventListener('click', () => grid.open(game));
  $('#pieces-close').addEventListener('click', () => grid.close());
  $('#btn-select').addEventListener('click', () => game.setSelectMode(!game.selectMode));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && game && (game.selectMode || game.selected.size)) game.setSelectMode(false);
  });
  $('#btn-tidy').addEventListener('click', () => {
    const n = game.tidy();
    toast(n ? `Sent ${n} loose piece${n === 1 ? '' : 's'} back to the tray` : 'No loose pieces to tidy up');
  });
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
  $('#btn-size').addEventListener('input', (e) => setButtonSize(parseFloat(e.target.value)));
  setButtonSize(savedButtonSize());
  $('#btn-fit').addEventListener('click', () => game.zoomOutAll());
  for (const b of document.querySelectorAll('#tray-views button')) {
    b.addEventListener('click', () => {
      game.setTrayView(b.dataset.view);
      syncToggles();
    });
  }
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
  $('#hero-signin').addEventListener('click', () => openSignIn());
  $('#welcome-signin').addEventListener('click', () => openSignIn());
  $('#welcome-signup').addEventListener('click', () => openSignIn('It’s free. Sign in with Apple or Google to save your puzzles and play with friends.'));
  $('#welcome-start').addEventListener('click', () => {
    startAfterSignIn = true;
    openSignIn('Sign in to start your first puzzle.');
  });
  $('#signin-cancel').addEventListener('click', () => {
    pendingJoin = null; // playing together needs an account
    if (!cloud.email && !isGuest()) {
      setGuest(true);
      gated = needsSignIn();
      if (startAfterSignIn && location.hash !== '#/new') location.hash = '#/new';
      else route();
    }
    startAfterSignIn = false;
  });
  // Switch between the welcome page and the library when sign-in state becomes known.
  let gated = needsSignIn();
  cloud.onStatus((s) => {
    if (s === 'synced') rememberSignedIn(true);
    if (s === 'signed-out') rememberSignedIn(false);
    const now = needsSignIn();
    if (now !== gated) {
      gated = now;
      route();
    }
  });
  $('#btn-account').addEventListener('click', () => (cloud.email ? openAccount() : openSignIn()));
  $('#signin-cancel').addEventListener('click', () => ($('#signin').hidden = true));
  for (const provider of ['apple', 'google']) {
    $(`#signin-native-${provider}`).addEventListener('click', () => {
      $('#signin-error').textContent = '';
      postNative('signIn', { provider });
    });
  }
  $('#signin-dev').addEventListener('click', async () => {
    // Local development only: sign in as anyone, to try playing together in two browsers.
    const name = prompt('Developer sign-in: play as (a first name)', 'Alice');
    if (name) finishSignIn('dev', undefined, name.trim());
  });
  document.addEventListener('AppleIDSignInOnSuccess', (e) => finishSignIn('apple', e.detail.authorization.id_token, e.detail.user?.name?.firstName, e.detail.authorization.code));
  document.addEventListener('AppleIDSignInOnFailure', (e) => {
    if (e.detail?.error !== 'popup_closed_by_user') $('#signin-error').textContent = 'Apple sign-in didn’t work. Please try again.';
  });
  $('#account-close').addEventListener('click', closeAccount);
  $('#btn-share').addEventListener('click', openShare);
  $('#share-close').addEventListener('click', () => ($('#share').hidden = true));
  $('#share-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('#share').dataset.link);
      $('#share-copy').textContent = 'Copied';
      setTimeout(() => ($('#share-copy').textContent = 'Copy link'), 1500);
    } catch {}
  });
  $('#share-native').addEventListener('click', () => {
    if (app) return postNative('share', { title: 'Play Poozles with me', url: $('#share').dataset.link });
    navigator.share?.({ title: 'Play Poozles with me', url: $('#share').dataset.link }).catch(() => {});
  });
  $('#notice-ok').addEventListener('click', () => ($('#notice').hidden = true));
  $('#join-code').addEventListener('click', () => {
    $('#joincode-input').value = '';
    $('#joincode-error').textContent = '';
    $('#joincode').hidden = false;
    $('#joincode-input').focus();
  });
  $('#joincode-cancel').addEventListener('click', () => ($('#joincode').hidden = true));
  $('#joincode-input').addEventListener('input', () => ($('#joincode-error').textContent = ''));
  $('#joincode-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#joincode-input').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(code)) {
      $('#joincode-error').textContent = 'Codes are 6 letters and numbers.';
      return;
    }
    $('#joincode').hidden = true;
    if (cloud.email) joinByCode(code);
    else {
      pendingJoin = code;
      openSignIn('Sign in to join the puzzle.');
    }
  });
  $('#account-signout').addEventListener('click', () => signOut(false));
  $('#account-delete').addEventListener('click', () => {
    $('#account-main').hidden = true;
    $('#account-confirm').hidden = false;
    $('#account-confirm-input').value = '';
    $('#account-confirm-error').textContent = '';
    $('#account-confirm-go').disabled = true;
    $('#account-confirm-input').focus();
  });
  $('#account-confirm-input').addEventListener('input', (e) => {
    $('#account-confirm-go').disabled = e.target.value.trim().toLowerCase() !== 'delete';
  });
  $('#account-confirm-cancel').addEventListener('click', closeAccount);
  $('#account-confirm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if ($('#account-confirm-go').disabled) return;
    $('#account-confirm-go').disabled = true;
    if (!(await signOut(true))) {
      $('#account-confirm-error').textContent = 'Couldn’t delete your account. Please try again when you’re online.';
      $('#account-confirm-go').disabled = false;
    }
  });
  cloud.onConflict = onConflict;
  cloud.onLocalChange = () => !screens.library.hidden && renderLibrary();
  cloud.onStatus(showCloud);
  // iPhone Safari treats a swipe in from the screen's edge as "go back". On the puzzle
  // screen that's nearly always someone dragging a piece or the table, so touches that
  // start right at the edge stay with the game (buttons there still work).
  document.addEventListener('touchstart', (e) => {
    if (screens.play.hidden || e.target.closest?.('a, button, input')) return;
    const x = e.touches[0]?.clientX ?? 0;
    if (x < 24 || x > innerWidth - 24) e.preventDefault();
  }, { passive: false });
  // Stop iOS Safari from zooming the whole page on pinch / double-tap outside the board.
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
}

// Handy for debugging in the browser console.
window.puzzle = () => game;

// An invite link (/join/CODE, forwarded to /?join=CODE): remember the code, tidy the address.
const invite = new URLSearchParams(location.search).get('join');
if (invite) {
  pendingJoin = invite.toUpperCase();
  history.replaceState(null, '', '/#/');
}

// Messages from the iPhone app (see app/Poozles/GameView.swift).
window.poozlesNativeEvent = async (e) => {
  if (e.type === 'signedIn') {
    app.token = e.token;
    await cloud.init();
    await afterSignIn();
  } else if (e.type === 'signInFailed' && !e.cancelled) {
    $('#signin-error').textContent = 'Sign-in didn’t work. Please try again.';
  } else if (e.type === 'join') {
    // An invite link opened the app.
    if (cloud.email) joinByCode(e.code);
    else {
      pendingJoin = e.code;
      openSignIn('Sign in to join the puzzle.');
    }
  }
};

wire();
route();
cloud.init().then(async () => {
  await syncNow();
  if (!pendingJoin) return;
  if (cloud.email) {
    const code = pendingJoin;
    pendingJoin = null;
    joinByCode(code);
  } else openSignIn('Sign in to join the puzzle.');
});
