// Cloud sync with the Puzzle Table Worker. Every device keeps its own full copy in
// IndexedDB (so play is instant and works offline); this module copies changes up to the
// Worker and pulls newer copies down. One person, several devices: for each puzzle the
// most recently saved copy wins.
//
// If the app is served without the Worker (e.g. a plain local web server) the API is
// missing, and the app quietly stays device-only.

import { db } from './db.js';

const PUSH_DELAY = 2500;
const listeners = new Set();
const pushTimers = new Map();
let status = 'checking'; // checking | synced | saving | offline | signed-out | local
let email = null;

class AuthError extends Error {}
class NoBackend extends Error {}

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { credentials: 'same-origin', redirect: 'manual', ...opts });
  } catch {
    throw new TypeError('offline');
  }
  // An expired Access session redirects to the login page instead of answering.
  if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) throw new AuthError();
  const type = res.headers.get('content-type') || '';
  if (res.status === 404 && !type.includes('json')) throw new NoBackend();
  return res;
}

function setStatus(s) {
  status = s;
  for (const fn of listeners) fn(s);
}

function fail(err) {
  if (err instanceof AuthError) setStatus('signed-out');
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
    return status !== 'local' && status !== 'checking';
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
    if (status === 'local') return false;
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

  // Upload a puzzle shortly after it changes (coalesces rapid saves).
  queuePush(id) {
    if (status === 'local') return;
    clearTimeout(pushTimers.get(id));
    pushTimers.set(id, setTimeout(() => this.pushNow(id), PUSH_DELAY));
  },

  async pushNow(id) {
    clearTimeout(pushTimers.get(id));
    pushTimers.delete(id);
    if (status === 'local') return;
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
    if (status === 'local') return;
    try {
      await api(`/api/puzzles/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (err) {
      fail(err);
    }
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
  else if (!res.ok) throw new Error(`save ${res.status}`);
}
