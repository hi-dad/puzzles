// Poozles backend: a Cloudflare Worker that serves the app and a small JSON API for
// saving puzzles to the cloud, so the same person sees the same puzzles on every device
// they sign in from.
//
//   GET    /api/config            -> public sign-in settings for the website
//   POST   /api/auth/apple        -> { idToken } from Sign in with Apple; starts a session
//   POST   /api/auth/google       -> { idToken } from Sign in with Google; starts a session
//   POST   /api/auth/dev          -> local development only (needs DEV_EMAIL in .dev.vars)
//   POST   /api/auth/signout      -> ends this device's session
//   GET    /api/me                -> { email }
//   DELETE /api/account           -> deletes everything this person stored
//   GET    /api/puzzles           -> [{ id, updatedAt, deleted }]   (this person's puzzles)
//   GET    /api/puzzles/:id       -> the puzzle record (JSON)
//   PUT    /api/puzzles/:id       -> save a record; 409 if the cloud copy is newer
//   DELETE /api/puzzles/:id       -> delete (leaves a tombstone so other devices follow)
//   GET    /api/images/:id        -> the puzzle photo (JPEG, from R2)
//   PUT    /api/images/:id        -> upload the puzzle photo
//   POST   /api/puzzles/:id/share -> start playing a puzzle together; returns { code }
//   POST   /api/join/:code        -> join a shared puzzle; returns { id }
//   GET    /api/rooms/:id         -> WebSocket into a shared puzzle's live room
//
// Shared puzzles appear in every player's list and are read/written through the same
// routes; "deleting" one only removes that player (see share.js).
//
// Who is asking comes from a session (see auth.js); the verified email is the "owner" key
// for everything stored here. Everything else (the HTML/JS/CSS in /public) is served as
// static assets without running this code.

import { verifySignIn, createSession, sessionEmail, endSession, sessionCookie, saveName, cleanName } from './auth.js';
import { isDowngrade } from '../public/js/format.js';
import { sharedFor, sharedRecord, listShared, share, join, leave, leaveAll, sharedPhotoKey } from './share.js';
import { nameOf } from './auth.js';
export { PuzzleRoom } from './room.js';

const ID = /^[A-Za-z0-9-]{8,64}$/;
const APP_ORIGIN = 'poozles://app'; // the iPhone app's game files (app/Poozles/GameFiles.swift)
const APP_ID = '4J889SV3P4.app.poozles'; // Apple team ID + bundle ID

// Lets the iPhone/iPad app open https://poozles.app/join/... invite links itself.
const APPLE_APP_SITE_ASSOCIATION = { applinks: { details: [{ appIDs: [APP_ID], components: [{ '/': '/join/*' }] }] } };
const MAX_RECORD = 1_500_000; // bytes of JSON per puzzle (1000 pieces ≈ 100 KB)
const MAX_IMAGE = 20_000_000; // bytes per photo

export default {
  async fetch(request, env) {
    // The app's game files live at poozles://app/, so its calls to this API are
    // cross-origin; it signs them with a token (no cookies), so allowing it is safe.
    const fromApp = request.headers.get('origin') === APP_ORIGIN;
    if (fromApp && request.method === 'OPTIONS') return new Response(null, { status: 204, headers: appCors() });
    const res = await route(request, env);
    if (!fromApp || res.status === 101) return res;
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(appCors())) out.headers.set(k, v);
    return out;
  },
};

function appCors() {
  return {
    'access-control-allow-origin': APP_ORIGIN,
    'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-max-age': '86400',
  };
}

async function route(request, env) {
  const url = new URL(request.url);
  if (url.pathname === '/.well-known/apple-app-site-association') return json(APPLE_APP_SITE_ASSOCIATION, 200, { 'cache-control': 'public, max-age=3600' });
  // The old workers.dev address forwards to the real one.
  if (url.hostname.endsWith('.workers.dev')) return Response.redirect(`https://poozles.app${url.pathname}${url.search}`, 301);
  // Invite links (/join/CODE) open the app, which picks the code up from ?join=.
  const invite = url.pathname.match(/^\/join\/([A-Za-z0-9]{6})\/?$/);
  if (invite) return Response.redirect(`${url.origin}/?join=${invite[1].toUpperCase()}`, 302);
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
  try {
    const open = await publicApi(request, env, url);
    if (open) return open;
    const email = await sessionEmail(request, env);
    if (!email) return json({ error: 'Not signed in' }, 401);
    return await api(request, env, url, email);
  } catch (err) {
    console.error(err);
    return json({ error: 'Something went wrong' }, 500);
  }
}

// Routes that work without a session. Returns null for anything else.
async function publicApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/config' && method === 'GET') {
    return json({
      appleServicesId: env.APPLE_SERVICES_ID || null,
      googleClientId: env.GOOGLE_WEB_CLIENT_ID || null,
      dev: !!env.DEV_EMAIL,
    });
  }

  const provider = path.match(/^\/api\/auth\/(apple|google|dev)$/)?.[1];
  if (provider && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    // Local development only: any email (to test playing together as two people).
    const who = provider === 'dev'
      ? env.DEV_EMAIL && {
        email: String(body.email || (cleanName(body.name) ? `${cleanName(body.name)}@example.com` : env.DEV_EMAIL)).toLowerCase(),
        name: cleanName(body.name) || 'Dev',
      }
      : await verifySignIn(body.idToken, provider, env);
    if (!who) return json({ error: 'Sign-in failed' }, 401);
    const { email } = who;
    // Apple only shares the name on someone's very first sign-in, from the browser/app.
    await saveName(env, email, who.name || (provider === 'apple' ? cleanName(body.name) : null));
    const token = await createSession(env, email);
    // The website keeps the session in an HttpOnly cookie; the app asks for the token itself.
    return json({ email, ...(body.app ? { token } : {}) }, 200, { 'set-cookie': sessionCookie(token, url) });
  }

  if (path === '/api/auth/signout' && method === 'POST') {
    await endSession(request, env);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(null, url) });
  }

  return null;
}

async function api(request, env, url, owner) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', kind, id?, action?]
  const [, kind, id, action] = parts;
  const method = request.method;
  if (parts.length > 4 || (id !== undefined && kind !== 'join' && !ID.test(id))) return json({ error: 'Not found' }, 404);
  if (action !== undefined && !(kind === 'puzzles' && action === 'share')) return json({ error: 'Not found' }, 404);

  if (kind === 'me' && !id && method === 'GET') return json({ email: owner });

  if (kind === 'join' && id && method === 'POST') {
    const r = await join(env, owner, id);
    return r.id ? json({ id: r.id }) : json({ error: r.error }, r.status);
  }

  if (kind === 'puzzles' && action === 'share' && method === 'POST') {
    const r = await share(env, owner, id);
    return r ? json(r) : json({ error: 'That puzzle hasn’t finished saving to the cloud yet' }, 409);
  }

  if (kind === 'rooms' && id && method === 'GET') {
    if (request.headers.get('upgrade') !== 'websocket') return json({ error: 'Expected a WebSocket' }, 426);
    if (!(await sharedFor(env, id, owner))) return json({ error: 'Not found' }, 404);
    const room = env.ROOMS.get(env.ROOMS.idFromName(id));
    const headers = new Headers(request.headers);
    headers.set('x-puzzle', id);
    headers.set('x-member', owner);
    headers.set('x-name', encodeURIComponent(await nameOf(env, owner)));
    return room.fetch(new Request(request.url, { headers }));
  }

  if (kind === 'account' && !id && method === 'DELETE') {
    await leaveAll(env, owner);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM puzzles WHERE owner = ?').bind(owner),
      env.DB.prepare('DELETE FROM sessions WHERE owner = ?').bind(owner),
    ]);
    const prefix = `${encodeURIComponent(owner)}/`;
    let cursor;
    do {
      const page = await env.PHOTOS.list({ prefix, cursor });
      if (page.objects.length) await env.PHOTOS.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie(null, url) });
  }

  if (kind === 'puzzles' && !id && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT id, updated_at AS updatedAt, deleted FROM puzzles WHERE owner = ?',
    ).bind(owner).all();
    return json([...results.map((r) => ({ ...r, deleted: !!r.deleted })), ...(await listShared(env, owner))]);
  }

  if (kind === 'puzzles' && id) {
    const shared = await sharedFor(env, id, owner);
    if (shared) {
      if (method === 'GET') return json(sharedRecord(shared));
      // The live room saves shared puzzles; players' own uploads are ignored.
      if (method === 'PUT') return json({ ok: true, updatedAt: shared.updated_at });
      if (method === 'DELETE') {
        await leave(env, owner, id);
        return json({ ok: true });
      }
    }

    const row = await env.DB.prepare('SELECT updated_at, deleted, data FROM puzzles WHERE owner = ? AND id = ?')
      .bind(owner, id).first();

    if (method === 'GET') {
      if (!row || row.deleted) return json({ error: 'Not found' }, 404);
      return new Response(row.data, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }

    if (method === 'PUT') {
      const text = await request.text();
      if (text.length > MAX_RECORD) return json({ error: 'Puzzle too large' }, 413);
      let rec;
      try {
        rec = JSON.parse(text);
      } catch {
        return json({ error: 'Bad JSON' }, 400);
      }
      if (rec?.id !== id || !Number.isFinite(rec.updatedAt)) return json({ error: 'Bad puzzle' }, 400);
      if (row?.deleted) return json({ error: 'Deleted on another device' }, 410);
      // Older code must never overwrite a puzzle saved in a newer format.
      if (row && isDowngrade(parseRecord(row.data), rec)) return json({ error: 'Saved by a newer version of Poozles' }, 426);
      // Single person, several devices: keep whichever copy was saved most recently.
      if (row && row.updated_at > rec.updatedAt) return json({ error: 'Newer copy in the cloud', updatedAt: row.updated_at }, 409);
      await env.DB.prepare(
        `INSERT INTO puzzles (owner, id, updated_at, deleted, data) VALUES (?, ?, ?, 0, ?)
         ON CONFLICT (owner, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 0, data = excluded.data`,
      ).bind(owner, id, rec.updatedAt, text).run();
      return json({ ok: true, updatedAt: rec.updatedAt });
    }

    if (method === 'DELETE') {
      await env.DB.prepare(
        `INSERT INTO puzzles (owner, id, updated_at, deleted, data) VALUES (?, ?, ?, 1, '')
         ON CONFLICT (owner, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 1, data = ''`,
      ).bind(owner, id, Date.now()).run();
      await env.PHOTOS.delete(photoKey(owner, id));
      return json({ ok: true });
    }
  }

  if (kind === 'images' && id) {
    const shared = await sharedFor(env, id, owner);
    if (shared && method === 'PUT') return json({ ok: true });
    const key = shared ? sharedPhotoKey(id) : photoKey(owner, id);
    if (method === 'GET') {
      const obj = await env.PHOTOS.get(key);
      if (!obj) return json({ error: 'Not found' }, 404);
      return new Response(obj.body, {
        headers: { 'content-type': obj.httpMetadata?.contentType || 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable' },
      });
    }
    if (method === 'PUT') {
      const type = request.headers.get('content-type') || '';
      const size = Number(request.headers.get('content-length') || 0);
      if (!/^image\/(jpeg|png|webp)$/.test(type)) return json({ error: 'Expected an image' }, 415);
      if (!size || size > MAX_IMAGE) return json({ error: 'Image too large' }, 413);
      await env.PHOTOS.put(key, request.body, { httpMetadata: { contentType: type } });
      return json({ ok: true });
    }
  }

  return json({ error: 'Not found' }, 404);
}

function parseRecord(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function photoKey(owner, id) {
  return `${encodeURIComponent(owner)}/${id}`;
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}
