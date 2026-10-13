// Puzzle Table backend: a Cloudflare Worker that serves the app and a small JSON API
// for saving puzzles to the cloud, so the same person sees the same puzzles on every
// device they sign in from.
//
//   GET    /api/me                -> { email }
//   GET    /api/puzzles           -> [{ id, updatedAt, deleted }]   (this person's puzzles)
//   GET    /api/puzzles/:id       -> the puzzle record (JSON)
//   PUT    /api/puzzles/:id       -> save a record; 409 if the cloud copy is newer
//   DELETE /api/puzzles/:id       -> delete (leaves a tombstone so other devices follow)
//   GET    /api/images/:id        -> the puzzle photo (JPEG, from R2)
//   PUT    /api/images/:id        -> upload the puzzle photo
//
// Who is asking comes from Cloudflare Access, which sits in front of the whole Worker:
// nobody reaches it without signing in, and the email it verified is the "owner" key
// for everything stored here. Everything else (the HTML/JS/CSS in /public) is served
// as static assets without running this code.

const ID = /^[A-Za-z0-9-]{8,64}$/;
const MAX_RECORD = 1_500_000; // bytes of JSON per puzzle (1000 pieces ≈ 100 KB)
const MAX_IMAGE = 20_000_000; // bytes per photo

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    const diag = {};
    const email = await signedInEmail(request, env, ctx, diag);
    if (!email) {
      // Say what was (not) received, to tell "Access isn't in front of this Worker" apart
      // from "Access ran but sent no usable identity". No secrets or values are included.
      return json({
        error: 'Not signed in',
        accessRan: !!ctx.access,
        accessAud: !!ctx.access?.aud,
        accessToken: request.headers.has('cf-access-jwt-assertion'),
        accessEmailHeader: request.headers.has('cf-access-authenticated-user-email'),
        accessCookie: (request.headers.get('cookie') || '').includes('CF_Authorization'),
        ...diag,
      }, 401);
    }
    try {
      return await api(request, env, url, email);
    } catch (err) {
      console.error(err);
      return json({ error: 'Something went wrong' }, 500);
    }
  },
};

async function api(request, env, url, owner) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', kind, id?]
  const [, kind, id] = parts;
  const method = request.method;
  if (parts.length > 3 || (id !== undefined && !ID.test(id))) return json({ error: 'Not found' }, 404);

  if (kind === 'me' && !id && method === 'GET') return json({ email: owner });

  if (kind === 'puzzles' && !id && method === 'GET') {
    const { results } = await env.DB.prepare(
      'SELECT id, updated_at AS updatedAt, deleted FROM puzzles WHERE owner = ?',
    ).bind(owner).all();
    return json(results.map((r) => ({ ...r, deleted: !!r.deleted })));
  }

  if (kind === 'puzzles' && id) {
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
    const key = photoKey(owner, id);
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

function photoKey(owner, id) {
  return `${encodeURIComponent(owner)}/${id}`;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

// ---------- identity ----------

// The email Cloudflare Access verified for this request, or null.
async function signedInEmail(request, env, ctx, diag = {}) {
  const token = request.headers.get('cf-access-jwt-assertion');
  // Worker-level Access hands the identity to the Worker directly.
  if (ctx.access) {
    try {
      const who = await ctx.access.getIdentity();
      diag.identityFields = who ? Object.keys(who) : null;
      const e = who?.email || who?.user?.email;
      if (e) return String(e).toLowerCase();
    } catch (err) {
      diag.identityError = String(err?.message || err).slice(0, 200);
      console.error('getIdentity failed', err);
    }
    // Fall back to the signed token Access attached, checked against this Worker's own
    // Access audience and Cloudflare's published signing keys.
    if (token && ctx.access.aud) {
      const iss = peekIssuer(token);
      diag.tokenIssuerOk = !!iss;
      if (iss) {
        const claims = await verifyAccessJwt(token, iss, ctx.access.aud);
        diag.tokenVerified = !!claims;
        if (claims?.email) return String(claims.email).toLowerCase();
      }
    }
    // Access ran in front of this request (ctx.access is only set when it did), and it
    // sets this header itself from the identity it verified.
    const header = request.headers.get('cf-access-authenticated-user-email');
    if (header && header.includes('@')) return header.trim().toLowerCase();
  }
  // Otherwise (hostname-level Access app), verify the signed token Access attaches.
  // Needs TEAM_DOMAIN (https://<team>.cloudflareaccess.com) and POLICY_AUD set as vars.
  if (token && env.TEAM_DOMAIN && env.POLICY_AUD) {
    const claims = await verifyAccessJwt(token, env.TEAM_DOMAIN, env.POLICY_AUD);
    if (claims?.email) return String(claims.email).toLowerCase();
  }
  return null;
}

// The token's issuer, only if it is a Cloudflare Access team domain (signature is
// checked afterwards against that team's keys).
function peekIssuer(token) {
  try {
    const iss = JSON.parse(b64text(token.split('.')[1])).iss;
    return /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(iss) ? iss : null;
  } catch {
    return null;
  }
}

const jwksCache = new Map(); // team domain -> { keys, at }

async function verifyAccessJwt(token, teamDomain, aud) {
  try {
    const [h, p, s] = token.split('.');
    const header = JSON.parse(b64text(h));
    const claims = JSON.parse(b64text(p));
    const team = teamDomain.replace(/\/$/, '');
    if (header.alg !== 'RS256' || claims.iss !== team) return null;
    if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(aud)) return null;
    if (!claims.exp || claims.exp * 1000 < Date.now()) return null;
    let cached = jwksCache.get(team);
    if (!cached || Date.now() - cached.at > 3600_000) {
      cached = { keys: (await (await fetch(`${team}/cdn-cgi/access/certs`)).json()).keys, at: Date.now() };
      jwksCache.set(team, cached);
    }
    const jwk = cached.keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64bytes(s), new TextEncoder().encode(`${h}.${p}`));
    return ok ? claims : null;
  } catch {
    return null;
  }
}

function b64bytes(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function b64text(s) {
  return new TextDecoder().decode(b64bytes(s));
}
