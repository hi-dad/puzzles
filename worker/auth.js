// Sign-in for Poozles. The website and the iPhone app sign in with Apple or Google; either
// hands us a signed ID token, which is checked against that provider's published keys.
// The verified email is the owner key for everything stored (the same key Cloudflare
// Access used before, so existing puzzles carry over). We then issue our own long-lived
// session: a random token, kept only as a hash in D1, sent back as an HttpOnly cookie for
// the website and as a bearer token for the app.

const PROVIDERS = {
  apple: {
    issuers: ['https://appleid.apple.com'],
    jwks: 'https://appleid.apple.com/auth/keys',
    audiences: (env) => [env.APPLE_SERVICES_ID, env.APPLE_BUNDLE_ID],
  },
  google: {
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    jwks: 'https://www.googleapis.com/oauth2/v3/certs',
    audiences: (env) => [env.GOOGLE_WEB_CLIENT_ID, env.GOOGLE_IOS_CLIENT_ID],
  },
};

export const SESSION_COOKIE = 'pz_session';
const SESSION_MS = 365 * 24 * 3600_000;

// The verified email in a provider's ID token, or null.
export async function verifyIdToken(token, provider, env, now = Date.now()) {
  return (await verifySignIn(token, provider, env, now))?.email ?? null;
}

// { email, name } from a provider's ID token, or null. Google includes the person's name;
// Apple never puts it in the token (the app passes it along on the first sign-in instead).
export async function verifySignIn(token, provider, env, now = Date.now()) {
  const p = PROVIDERS[provider];
  if (!p || typeof token !== 'string') return null;
  const allowed = p.audiences(env).filter(Boolean);
  if (!allowed.length) return null;
  const claims = await verifyJwt(token, p.jwks, now);
  if (!claims || !p.issuers.includes(claims.iss)) return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.some((a) => allowed.includes(a))) return null;
  // Google sends email_verified as a boolean, Apple sometimes as the string "true".
  if (!claims.email || String(claims.email_verified) !== 'true') return null;
  return { email: String(claims.email).toLowerCase(), name: cleanName(claims.given_name || claims.name) };
}

// A first name fit to show other players, or null.
export function cleanName(name) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  return first ? first.slice(0, 24) : null;
}

// Remember a player's display name (other players see it when playing together).
export async function saveName(env, email, name) {
  if (!name) return;
  await ensureSessions(env);
  await env.DB.prepare(
    `INSERT INTO users (email, name) VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET name = excluded.name`,
  ).bind(email, name).run();
}

export async function nameOf(env, email) {
  await ensureSessions(env);
  const row = await env.DB.prepare('SELECT name FROM users WHERE email = ?').bind(email).first();
  return row?.name || 'Player';
}

// ---------- sessions ----------

// The live database predates the sessions and users tables, so they're created on first
// use (same as worker/schema.sql) and deploys need no manual migration.
let sessionsReady = null;
function ensureSessions(env) {
  sessionsReady ??= env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS sessions_owner ON sessions (owner)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS users (email TEXT PRIMARY KEY, name TEXT)'),
  ]).catch((err) => {
    sessionsReady = null;
    throw err;
  });
  return sessionsReady;
}

export async function createSession(env, email) {
  await ensureSessions(env);
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (token_hash, owner, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), email, now, now + SESSION_MS).run();
  return token;
}

// The email of the signed-in person making this request, or null.
export async function sessionEmail(request, env) {
  const token = sessionToken(request);
  if (!token) return null;
  await ensureSessions(env);
  const row = await env.DB.prepare('SELECT owner, expires_at FROM sessions WHERE token_hash = ?')
    .bind(await sha256(token)).first();
  return row && row.expires_at > Date.now() ? row.owner : null;
}

export async function endSession(request, env) {
  const token = sessionToken(request);
  if (!token) return;
  await ensureSessions(env);
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
}

export function sessionCookie(token, url) {
  const secure = url.protocol === 'https:' ? '; Secure' : '';
  const age = token ? Math.floor(SESSION_MS / 1000) : 0;
  return `${SESSION_COOKIE}=${token || ''}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure}`;
}

function sessionToken(request) {
  const auth = request.headers.get('authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim() || null;
  // The iPhone app's live-room WebSocket: "Sec-WebSocket-Protocol: poozles, <token>"
  const [proto, token] = (request.headers.get('sec-websocket-protocol') || '').split(',').map((p) => p.trim());
  if (proto === 'poozles' && token) return token;
  const m = (request.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

// ---------- JWT (RS256) ----------

const jwksCache = new Map(); // url -> { keys, at }

async function providerKeys(url, force = false) {
  const cached = jwksCache.get(url);
  if (!force && cached && Date.now() - cached.at < 3600_000) return cached.keys;
  const keys = (await (await fetch(url)).json()).keys || [];
  jwksCache.set(url, { keys, at: Date.now() });
  return keys;
}

async function verifyJwt(token, jwksUrl, now) {
  try {
    const [h, p, s] = token.split('.');
    const header = JSON.parse(b64text(h));
    const claims = JSON.parse(b64text(p));
    if (header.alg !== 'RS256') return null;
    if (!claims.exp || claims.exp * 1000 < now) return null;
    // Providers rotate keys; an unknown key id means our cached copy is stale.
    let jwk = (await providerKeys(jwksUrl)).find((k) => k.kid === header.kid);
    jwk ??= (await providerKeys(jwksUrl, true)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64bytes(s), new TextEncoder().encode(`${h}.${p}`));
    return ok ? claims : null;
  } catch {
    return null;
  }
}

async function sha256(text) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64bytes(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function b64text(s) {
  return new TextDecoder().decode(b64bytes(s));
}
