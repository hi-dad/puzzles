// Cloud sync with the Poozles Worker. Every device keeps its own full copy in
// IndexedDB (so play is instant and works offline); this module copies changes up to the
// Worker and pulls newer copies down. One person, several devices: for each puzzle the
// most recently saved copy wins.
//
// If the app is served without the Worker (e.g. a plain local web server) the API is
// missing, and the app quietly stays device-only.

import { db } from './db.js';

// While playing, upload at most every 30 s (each upload is one database write); leaving
// the puzzle, hiding the app or closing the page uploads straight away.
const PUSH_DELAY = 30_000;
const listeners = new Set();
const pushTimers = new Map();
let status = 'checking'; // checking | synced | saving | offline | signed-out | update | local
let email = null;

class AuthError extends Error {}
class UpdateError extends Error {}
class NoBackend extends Error {}

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...opts });
  } catch {
    throw new TypeError('offline');
  }
  if (res.status === 401 || res.status === 403) throw new AuthError();
  const type = res.headers.get('content-type') || '';
  if (res.status === 404 && !type.includes('json')) throw new NoBackend();
  return res;
}

function setStatus(s) {
  status = s;
  for (const fn of listeners) fn(s);
}

// Signed out or no backend: keep everything on this device and don't try the network.
const idle = () => status === 'local' || status === 'signed-out';

function fail(err) {
  if (err instanceof AuthError) setStatus('signed-out');
  else if (err instanceof UpdateError) setStatus('update');
  else if (err instanceof NoBackend) setStatus('local');
  else setStatus('offline');
}

export const cloud = {
  // The puzzle on screen and what to do if another device saved it more recently.
  openId: null,
  onConflict: null,
  // Called when a background upload changed what's stored on this device.
  onLocalChange: null,

  get status() {
    return status;
  },
  get email() {
    return email;
  },
  get on() {
    return !idle() && status !== 'checking';
  },
  onStatus(fn) {
    listeners.add(fn);
    fn(status);
    return () => listeners.delete(fn);
  },

  async init() {
    try {
      const res = await api('/api/me');
      if (!res.ok) throw new NoBackend();
      email = (await res.json()).email;
      setStatus('synced');
    } catch (err) {
      fail(err);
    }
  },

  // Bring this device and the cloud in line. `openId` is the puzzle on screen: it is
  // never overwritten underneath the player; instead `onConflict(id)` is called.
  // Returns true if anything local changed (so the library can re-render).
  async syncAll({ openId = null, onConflict } = {}) {
    if (idle()) return false;
    let changed = false;
    try {
      const res = await api('/api/puzzles');
      if (!res.ok) throw new Error(res.status);
      const remote = await res.json();
      const local = new Map((await db.list()).map((r) => [r.id, r]));
      for (const r of remote) {
        const mine = local.get(r.id);
        local.delete(r.id);
        if (r.deleted) {
          if (mine) {
            if (r.id === openId) continue;
            await db.remove(r.id);
            changed = true;
          }
        } else if (!mine || r.updatedAt > mine.updatedAt) {
          if (r.id === openId) onConflict?.(r.id);
          else if (await pull(r.id)) changed = true;
        } else if (mine.updatedAt > r.updatedAt) {
          await push(mine.id);
        }
      }
      for (const mine of local.values()) await push(mine.id); // never uploaded yet
      setStatus('synced');
    } catch (err) {
      fail(err);
    }
    return changed;
  },

  // Before opening a puzzle: make sure this device has the newest copy.
  async refresh(id) {
    if (!this.on) return;
    try {
      const res = await api('/api/puzzles');
      if (!res.ok) return;
      const r = (await res.json()).find((x) => x.id === id);
      const mine = await db.get(id);
      if (r && !r.deleted && (!mine || r.updatedAt > mine.updatedAt)) await pull(id);
      setStatus('synced');
    } catch (err) {
      fail(err);
    }
  },

  // Load the cloud copy of one puzzle into this device (used to resolve a conflict).
  async pull(id) {
    return pull(id);
  },

  // Upload a puzzle a little after it changes. Changes made while an upload is already
  // scheduled ride along with it, so steady play still uploads every PUSH_DELAY.
  queuePush(id) {
    if (idle() || pushTimers.has(id)) return;
    pushTimers.set(id, setTimeout(() => this.pushNow(id), PUSH_DELAY));
  },

  async pushNow(id) {
    clearTimeout(pushTimers.get(id));
    pushTimers.delete(id);
    if (idle()) return;
    try {
      setStatus('saving');
      await push(id);
      setStatus('synced');
    } catch (err) {
      fail(err);
    }
  },

  // Push everything pending right away (e.g. the page is being hidden).
  flush() {
    for (const id of [...pushTimers.keys()]) this.pushNow(id);
  },

  async remove(id) {
    clearTimeout(pushTimers.get(id));
    pushTimers.delete(id);
    if (idle()) return;
    try {
      await api(`/api/puzzles/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (err) {
      fail(err);
    }
  },

  // Which sign-in buttons this server offers.
  async config() {
    try {
      const res = await api('/api/config');
      return res.ok ? await res.json() : {};
    } catch {
      return {};
    }
  },

  // Start a session with an ID token from Apple or Google ('dev' needs no token).
  // Puzzles made on this device while signed out are uploaded to the account.
  async signIn(provider, idToken, name) {
    const res = await api(`/api/auth/${provider}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken, name }),
    }).catch(() => null);
    if (!res?.ok) return false;
    email = (await res.json()).email;
    setStatus('synced');
    return true;
  },

  // Sign out (or delete the account), then forget this device's copy so the next person
  // to sign in here doesn't inherit it.
  async signOut({ deleteAccount = false } = {}) {
    await Promise.all([...pushTimers.keys()].map((id) => this.pushNow(id)));
    const res = await api(deleteAccount ? '/api/account' : '/api/auth/signout', {
      method: deleteAccount ? 'DELETE' : 'POST',
    }).catch(() => null);
    if (deleteAccount && !res?.ok) return false;
    await db.clear();
    email = null;
    setStatus('signed-out');
    return true;
  },

  // Start playing a puzzle together. Returns { ok, code } or { ok: false, error }.
  async share(id) {
    return post(`/api/puzzles/${encodeURIComponent(id)}/share`);
  },

  // Join a shared puzzle by its invite code. Returns { ok, id } or { ok: false, error }.
  async join(code) {
    return post(`/api/join/${encodeURIComponent(code)}`);
  },

  // A puzzle photo this device is missing.
  async fetchImage(id) {
    if (!this.on) return null;
    try {
      const res = await api(`/api/images/${encodeURIComponent(id)}`);
      if (!res.ok) return null;
      const blob = await res.blob();
      await db.putImage(id, blob, { inCloud: true });
      return blob;
    } catch {
      return null;
    }
  },
};

async function post(path) {
  try {
    const res = await api(path, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, ...body };
  } catch {
    return { ok: false, error: 'You’re offline right now.' };
  }
}

async function pull(id) {
  const res = await api(`/api/puzzles/${encodeURIComponent(id)}`);
  if (!res.ok) return false;
  const rec = await res.json();
  if (!(await db.getImage(id))) {
    const img = await api(`/api/images/${encodeURIComponent(id)}`);
    if (!img.ok) return false; // photo not uploaded yet; try again next sync
    await db.putImage(id, await img.blob(), { inCloud: true });
  }
  await db.put(rec);
  return true;
}

async function push(id) {
  const rec = await db.get(id);
  if (!rec) return;
  if (!(await db.imageInCloud(id))) {
    const blob = await db.getImage(id);
    if (!blob) return;
    const res = await api(`/api/images/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': blob.type || 'image/jpeg' },
      body: blob,
    });
    if (!res.ok) throw new Error(`image upload ${res.status}`);
    await db.markImageInCloud(id);
  }
  const res = await api(`/api/puzzles/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rec),
  });
  if (res.status === 409) {
    // Another device saved this puzzle more recently.
    if (id === cloud.openId) cloud.onConflict?.(id);
    else if (await pull(id).catch(() => false)) cloud.onLocalChange?.();
  } else if (res.status === 410) {
    await db.remove(id); // deleted on another device
    cloud.onLocalChange?.();
  }
  else if (res.status === 426) throw new UpdateError(); // the cloud copy is from a newer Poozles
  else if (!res.ok) throw new Error(`save ${res.status}`);
}
