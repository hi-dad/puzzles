import test from 'node:test';
import assert from 'node:assert/strict';
import { settle, neighbors, placedCount, shuffled } from '../public/js/logic.js';
import { chooseGrid } from '../public/js/geometry.js';

function board(cols, rows, groups) {
  const groupOf = new Array(cols * rows).fill(null);
  for (const g of groups) for (const i of g.members) groupOf[i] = g;
  return { groups, groupOf, cols, rows, tol: 5 };
}

test('neighbors respects grid bounds', () => {
  assert.deepEqual(neighbors(0, 3, 2).sort(), [1, 3]);
  assert.deepEqual(neighbors(4, 3, 2).sort(), [1, 3, 5]);
});

test('dropping near a neighbour joins the groups at its offset', () => {
  const a = { x: 100, y: 50, locked: false, members: [0] };
  const b = { x: 103, y: 48, locked: false, members: [1] };
  const st = board(2, 2, [a, b]);
  const r = settle(b, st);
  assert.equal(r.joined, 1);
  assert.equal(st.groups.length, 1);
  assert.deepEqual([b.x, b.y], [100, 50]);
  assert.deepEqual(b.members.sort(), [0, 1]);
  assert.equal(st.groupOf[0], b);
});

test('non-adjacent pieces at the same offset do not join', () => {
  const a = { x: 10, y: 10, locked: false, members: [0] };
  const b = { x: 10, y: 10, locked: false, members: [3] };
  const st = board(2, 2, [a, b]);
  assert.equal(settle(b, st).joined, 0);
});

test('near the frame locks in place, and locking cascades through neighbours', () => {
  const a = { x: 0, y: 0, locked: true, members: [0] };
  const b = { x: 3, y: -2, locked: false, members: [1] };
  const st = board(2, 2, [a, b]);
  const r = settle(b, st);
  assert.ok(r.locked);
  assert.equal(b.locked, true);
  assert.deepEqual([b.x, b.y], [0, 0]);
  assert.equal(placedCount(st.groups), 2);
});

test('a locked group never moves when an unlocked one joins it', () => {
  const a = { x: 0, y: 0, locked: true, members: [0] };
  const b = { x: 4, y: 4, locked: false, members: [1] };
  const st = board(2, 2, [a, b]);
  settle(a, st);
  assert.deepEqual([a.x, a.y], [0, 0]);
  assert.equal(a.members.length, 2);
});

test('chooseGrid gets close to the target with near-square pieces', () => {
  const { cols, rows } = chooseGrid(4000, 3000, 100);
  assert.ok(Math.abs(cols * rows - 100) <= 12, `${cols}x${rows}`);
  const pieceAspect = 4000 / cols / (3000 / rows);
  assert.ok(pieceAspect > 0.8 && pieceAspect < 1.25);
});

test('shuffled is a permutation', () => {
  assert.deepEqual(shuffled(50).sort((a, b) => a - b), Array.from({ length: 50 }, (_, i) => i));
});
