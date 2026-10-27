import test from 'node:test';
import assert from 'node:assert/strict';
import { FORMAT_VERSION, formatOf, canOpen, isDowngrade } from '../public/js/format.js';

test('puzzles saved before versions existed count as version 1', () => {
  assert.equal(formatOf({ id: 'a' }), 1);
  assert.equal(formatOf({ id: 'a', v: 'junk' }), 1);
  assert.equal(formatOf(null), 1);
  assert.equal(formatOf({ v: 3 }), 3);
});

test('this code opens its own format and older ones, not newer ones', () => {
  assert.ok(canOpen({}));
  assert.ok(canOpen({ v: FORMAT_VERSION }));
  assert.ok(!canOpen({ v: FORMAT_VERSION + 1 }));
});

test('a save may never replace a newer format with an older one', () => {
  assert.ok(isDowngrade({ v: 2 }, { v: 1 }));
  assert.ok(isDowngrade({ v: 2 }, {}));
  assert.ok(!isDowngrade({ v: 1 }, { v: 2 }));
  assert.ok(!isDowngrade({ v: 1 }, { v: 1 }));
  assert.ok(!isDowngrade(null, { v: 1 }));
});
