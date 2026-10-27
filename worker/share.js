// Playing together. Sharing moves a puzzle out of its owner's private rows into a
// shared_puzzles row that every member reads and writes; members find it in their library
// alongside their own puzzles. While people play, the live room (room.js) holds the board
// and saves it back here.

export const MAX_PLAYERS = 4;
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I/L to misread
const CODE = /^[A-Z2-9]{6}$/;

// Created on first use, like the sessions table, so deploys need no manual migration.
let ready = null;
export function ensureShared(env) {
  ready ??= env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS shared_puzzles (
      id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, updated_at INTEGER NOT NULL, data TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS shared_members (
      puzzle_id TEXT NOT NULL, member TEXT NOT NULL, joined_at INTEGER NOT NULL, PRIMARY KEY (puzzle_id, member))`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS shared_members_member ON shared_members (member)'),
  ]).catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}

export const sharedPhotoKey = (id) => `shared/${id}`;

// The shared puzzle `id` if `email` is one of its players, else null.
export async function sharedFor(env, id, email) {
  await ensureShared(env);
  return env.DB.prepare(
    `SELECT p.id, p.code, p.updated_at, p.data FROM shared_puzzles p
     JOIN shared_members m ON m.puzzle_id = p.id WHERE p.id = ? AND m.member = ?`,
  ).bind(id, email).first();
}

// The puzzle record as players see it: marked shared, with its join code.
export function sharedRecord(row) {
  const rec = JSON.parse(row.data);
  rec.shared = { code: row.code };
  rec.updatedAt = row.updated_at;
  return rec;
}

export async function listShared(env, email) {
  await ensureShared(env);
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.updated_at AS updatedAt FROM shared_puzzles p
     JOIN shared_members m ON m.puzzle_id = p.id WHERE m.member = ?`,
  ).bind(email).all();
  return results.map((r) => ({ ...r, deleted: false, shared: true }));
}

export async function playersOf(env, id) {
  await ensureShared(env);
  const { results } = await env.DB.prepare(
    `SELECT m.member, u.name FROM shared_members m LEFT JOIN users u ON u.email = m.member
     WHERE m.puzzle_id = ? ORDER BY m.joined_at`,
  ).bind(id).all();
  return results.map((r) => ({ email: r.member, name: r.name || 'Player' }));
}

// Turn one of `owner`'s puzzles into a shared one (or return the existing code).
export async function share(env, owner, id) {
  await ensureShared(env);
  const existing = await sharedFor(env, id, owner);
  if (existing) return { code: existing.code };
  const row = await env.DB.prepare('SELECT updated_at, data FROM puzzles WHERE owner = ? AND id = ? AND deleted = 0')
    .bind(owner, id).first();
  if (!row) return null;
  const photo = await env.PHOTOS.get(`${encodeURIComponent(owner)}/${id}`);
  if (!photo) return null; // the photo hasn't finished uploading yet
  await env.PHOTOS.put(sharedPhotoKey(id), photo.body, { httpMetadata: photo.httpMetadata });
  const code = await newCode(env);
  const now = Date.now();
  // The private copy goes away; the shared one keeps the same id, so the owner's devices
  // carry straight on with it.
  await env.DB.batch([
    env.DB.prepare('INSERT INTO shared_puzzles (id, code, updated_at, data) VALUES (?, ?, ?, ?)').bind(id, code, now, row.data),
    env.DB.prepare('INSERT INTO shared_members (puzzle_id, member, joined_at) VALUES (?, ?, ?)').bind(id, owner, now),
    env.DB.prepare('DELETE FROM puzzles WHERE owner = ? AND id = ?').bind(owner, id),
  ]);
  await env.PHOTOS.delete(`${encodeURIComponent(owner)}/${id}`);
  return { code };
}

async function newCode(env) {
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const code = [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
    if (!(await env.DB.prepare('SELECT 1 FROM shared_puzzles WHERE code = ?').bind(code).first())) return code;
  }
}

// Join a shared puzzle by its code. Returns { id } or { error, status }.
export async function join(env, email, rawCode) {
  await ensureShared(env);
  const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!CODE.test(code)) return { error: 'That code doesn’t look right', status: 400 };
  const p = await env.DB.prepare('SELECT id FROM shared_puzzles WHERE code = ?').bind(code).first();
  if (!p) return { error: 'No puzzle with that code', status: 404 };
  if (await sharedFor(env, p.id, email)) return { id: p.id };
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM shared_members WHERE puzzle_id = ?').bind(p.id).first();
  if (n >= MAX_PLAYERS) return { error: `This puzzle already has ${MAX_PLAYERS} players`, status: 409 };
  await env.DB.batch([
    env.DB.prepare('INSERT INTO shared_members (puzzle_id, member, joined_at) VALUES (?, ?, ?)').bind(p.id, email, Date.now()),
    // In case they left this puzzle before: clear the "deleted" marker their devices follow.
    env.DB.prepare('DELETE FROM puzzles WHERE owner = ? AND id = ? AND deleted = 1').bind(email, p.id),
  ]);
  return { id: p.id };
}

// Remove `email` from a shared puzzle (their "delete"). The others keep playing; the last
// player to leave takes the puzzle with them.
export async function leave(env, email, id) {
  await ensureShared(env);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM shared_members WHERE puzzle_id = ? AND member = ?').bind(id, email),
    // A "deleted" marker so this person's other devices drop it too.
    env.DB.prepare(
      `INSERT INTO puzzles (owner, id, updated_at, deleted, data) VALUES (?, ?, ?, 1, '')
       ON CONFLICT (owner, id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 1, data = ''`,
    ).bind(email, id, Date.now()),
  ]);
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM shared_members WHERE puzzle_id = ?').bind(id).first();
  if (n === 0) {
    await env.DB.prepare('DELETE FROM shared_puzzles WHERE id = ?').bind(id).run();
    await env.PHOTOS.delete(sharedPhotoKey(id));
  }
}

// Leave every shared puzzle (account deletion).
export async function leaveAll(env, email) {
  await ensureShared(env);
  const { results } = await env.DB.prepare('SELECT puzzle_id FROM shared_members WHERE member = ?').bind(email).all();
  for (const r of results) await leave(env, email, r.puzzle_id);
}

// The live room saves the board here.
export async function saveShared(env, id, rec) {
  await ensureShared(env);
  await env.DB.prepare('UPDATE shared_puzzles SET updated_at = ?, data = ? WHERE id = ?')
    .bind(rec.updatedAt, JSON.stringify(rec), id).run();
}

export async function loadShared(env, id) {
  await ensureShared(env);
  const row = await env.DB.prepare('SELECT data FROM shared_puzzles WHERE id = ?').bind(id).first();
  return row ? JSON.parse(row.data) : null;
}
