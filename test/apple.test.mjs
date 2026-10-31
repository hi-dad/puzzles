import test from 'node:test';
import assert from 'node:assert/strict';
import { appleClientSecret, rememberApple, revokeApple } from '../worker/auth.js';

// A stand-in for the .p8 key from Apple.
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');

// Just enough of D1: one apple_tokens table held in a Map.
function fakeDB() {
  const rows = new Map();
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async run() {
      if (sql.includes('INSERT INTO apple_tokens')) rows.set(`${args[0]}|${args[1]}`, { email: args[0], client_id: args[1], refresh_token: args[2] });
      if (sql.includes('DELETE FROM apple_tokens')) for (const [k, r] of rows) if (r.email === args[0]) rows.delete(k);
    },
    async all() {
      return { results: [...rows.values()].filter((r) => r.email === args[0]) };
    },
  });
  return { rows, prepare: (sql) => stmt(sql), batch: async () => [] };
}

function makeEnv() {
  return {
    DB: fakeDB(), APPLE_TEAM_ID: 'TEAM', APPLE_KEY_ID: 'KEY1', APPLE_SERVICES_ID: 'app.poozles.web', APPLE_BUNDLE_ID: 'app.poozles',
    APPLE_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`,
  };
}

function fakeApple(reply) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, form: Object.fromEntries(opts.body) });
    return reply(url);
  };
  return calls;
}

const errors = console.error;
test.beforeEach(() => { console.error = () => {}; });
test.afterEach(() => { console.error = errors; });

test('the client secret is a valid ES256 token for the right client', async () => {
  const [h, p, s] = (await appleClientSecret(makeEnv(), 'app.poozles')).split('.');
  const head = JSON.parse(Buffer.from(h, 'base64url'));
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.deepEqual([head.alg, head.kid, claims.iss, claims.sub, claims.aud], ['ES256', 'KEY1', 'TEAM', 'app.poozles', 'https://appleid.apple.com']);
  assert.ok(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, Buffer.from(s, 'base64url'), new TextEncoder().encode(`${h}.${p}`)));
});

test('a sign-in code is swapped for a refresh token, and deletion revokes it', async () => {
  const env = makeEnv();
  const calls = fakeApple(() => new Response(JSON.stringify({ refresh_token: 'r1' })));
  await rememberApple(env, 'sam@example.com', 'c1', 'app.poozles', 'https://poozles.app/');
  assert.equal(calls[0].url, 'https://appleid.apple.com/auth/token');
  assert.equal(calls[0].form.code, 'c1');
  assert.equal(calls[0].form.redirect_uri, undefined); // the app's codes have none
  assert.equal(env.DB.rows.size, 1);

  await revokeApple(env, 'sam@example.com');
  assert.equal(calls[1].url, 'https://appleid.apple.com/auth/revoke');
  assert.deepEqual([calls[1].form.token, calls[1].form.client_id, calls[1].form.token_type_hint], ['r1', 'app.poozles', 'refresh_token']);
  assert.equal(env.DB.rows.size, 0);
});

test('website codes send the redirect address', async () => {
  const calls = fakeApple(() => new Response(JSON.stringify({ refresh_token: 'r1' })));
  await rememberApple(makeEnv(), 'sam@example.com', 'c1', 'app.poozles.web', 'https://poozles.app/');
  assert.equal(calls[0].form.redirect_uri, 'https://poozles.app/');
});

test('no key or no code: nothing is sent to Apple', async () => {
  const calls = fakeApple(() => new Response('{}'));
  await rememberApple({ ...makeEnv(), APPLE_PRIVATE_KEY: undefined }, 'sam@example.com', 'c1', 'app.poozles', '');
  await rememberApple(makeEnv(), 'sam@example.com', undefined, 'app.poozles', '');
  assert.equal(calls.length, 0);
});

test('Apple being down never stops sign-in or deletion', async () => {
  const env = makeEnv();
  fakeApple(() => { throw new Error('down'); });
  await rememberApple(env, 'sam@example.com', 'c1', 'app.poozles', '');
  assert.equal(env.DB.rows.size, 0);

  await env.DB.prepare('INSERT INTO apple_tokens').bind('sam@example.com', 'app.poozles', 'r1').run();
  await revokeApple(env, 'sam@example.com');
  assert.equal(env.DB.rows.size, 0); // the deletion still finishes
});
