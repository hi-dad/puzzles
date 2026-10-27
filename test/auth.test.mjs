import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyIdToken } from '../worker/auth.js';

// A stand-in for Apple's and Google's signing keys: tokens are signed with our own key
// pair, and fetch() of the provider's key URL returns its public half.
const pair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true, ['sign', 'verify'],
);
const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
globalThis.fetch = async () => new Response(JSON.stringify({ keys: [jwk] }));

const env = {
  APPLE_SERVICES_ID: 'app.poozles.web', APPLE_BUNDLE_ID: 'app.poozles',
  GOOGLE_WEB_CLIENT_ID: 'web.apps.googleusercontent.com', GOOGLE_IOS_CLIENT_ID: '',
};
const b64 = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');

async function sign(claims, { kid = 'k1', key = pair.privateKey } = {}) {
  const head = `${b64({ alg: 'RS256', kid })}.${b64(claims)}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head));
  return `${head}.${Buffer.from(sig).toString('base64url')}`;
}

const exp = Math.floor(Date.now() / 1000) + 600;
const apple = { iss: 'https://appleid.apple.com', aud: 'app.poozles', email: 'Sam@Example.com', email_verified: 'true', exp };
const google = { iss: 'https://accounts.google.com', aud: 'web.apps.googleusercontent.com', email: 'sam@gmail.com', email_verified: true, exp };

test('a valid Apple token gives the lower-cased email', async () => {
  assert.equal(await verifyIdToken(await sign(apple), 'apple', env), 'sam@example.com');
  assert.equal(await verifyIdToken(await sign({ ...apple, aud: 'app.poozles.web' }), 'apple', env), 'sam@example.com');
});

test('a valid Google token gives the email', async () => {
  assert.equal(await verifyIdToken(await sign(google), 'google', env), 'sam@gmail.com');
});

test('tokens for another app, issuer or provider are refused', async () => {
  assert.equal(await verifyIdToken(await sign({ ...apple, aud: 'com.someone.else' }), 'apple', env), null);
  assert.equal(await verifyIdToken(await sign({ ...apple, iss: 'https://evil.example' }), 'apple', env), null);
  assert.equal(await verifyIdToken(await sign(google), 'apple', env), null);
  assert.equal(await verifyIdToken(await sign(google), 'facebook', env), null);
});

test('expired, unverified-email and email-less tokens are refused', async () => {
  assert.equal(await verifyIdToken(await sign({ ...google, exp: exp - 1200 }), 'google', env), null);
  assert.equal(await verifyIdToken(await sign({ ...google, email_verified: false }), 'google', env), null);
  assert.equal(await verifyIdToken(await sign({ ...google, email: undefined }), 'google', env), null);
});

test('a forged signature or unknown key is refused', async () => {
  const other = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  assert.equal(await verifyIdToken(await sign(google, { key: other.privateKey }), 'google', env), null);
  assert.equal(await verifyIdToken(await sign(google, { kid: 'nope' }), 'google', env), null);
  assert.equal(await verifyIdToken('not.a.token', 'google', env), null);
});

test('a provider with no configured app id refuses everything', async () => {
  assert.equal(await verifyIdToken(await sign(google), 'google', { ...env, GOOGLE_WEB_CLIENT_ID: '' }), null);
});
