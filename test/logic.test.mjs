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

test('pieces turned differently do not join, and turned groups do not lock', () => {
  const a = { x: 10, y: 10, r: 1, locked: false, members: [0] };
  const b = { x: 10, y: 10, r: 0, locked: false, members: [1] };
  const st = board(2, 2, [a, b]);
  assert.equal(settle(b, st).joined, 0);
  const c = { x: 1, y: 1, r: 2, locked: false, members: [3] };
  st.groups.push(c);
  st.groupOf[3] = c;
  assert.equal(settle(c, st).locked, false);
  b.r = 1;
  assert.equal(settle(b, st).joined, 1);
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

import { applyPatch } from '../public/js/logic.js';

test('a patch replaces the groups its pieces were in', () => {
  const state = { groups: [{ x: 5, y: 5, r: 0, locked: false, members: [0] }, { x: 9, y: 9, r: 0, locked: false, members: [1] }], tray: [2, 3] };
  applyPatch(state, { groups: [{ x: 9, y: 9, r: 0, locked: false, members: [1, 0] }] });
  assert.equal(state.groups.length, 1);
  assert.deepEqual(state.groups[0].members.sort(), [0, 1]);
  assert.deepEqual(state.tray, [2, 3]);
});

test('a patch moves pieces out of and back into the tray', () => {
  const state = { groups: [{ x: 1, y: 1, r: 2, locked: false, members: [4] }], tray: [2, 3], rot: [0, 0, 0, 0, 0] };
  applyPatch(state, { groups: [{ x: 7, y: 7, r: 0, members: [2] }], trayRemove: [2], trayAdd: [{ i: 4, r: 2 }] });
  assert.deepEqual(state.tray, [4, 3]);
  assert.equal(state.rot[4], 2);
  assert.deepEqual(state.groups.map((g) => g.members), [[2]]);
});

test('patches from two players touching different pieces both survive', () => {
  const state = { groups: [], tray: [0, 1, 2] };
  applyPatch(state, { groups: [{ x: 1, y: 1, members: [0] }], trayRemove: [0] });
  applyPatch(state, { groups: [{ x: 2, y: 2, members: [2] }], trayRemove: [2] });
  assert.deepEqual(state.tray, [1]);
  assert.equal(state.groups.length, 2);
});

test('settle never joins a group another player is holding', () => {
  const a = { x: 100, y: 50, locked: false, members: [0] };
  const b = { x: 101, y: 50, locked: false, members: [1] };
  const groupOf = [a, b, null, null];
  const groups = [a, b];
  const r = settle(a, { groups, groupOf, cols: 2, rows: 2, tol: 5, busy: (o) => o === b });
  assert.equal(r.joined, 0);
  assert.equal(groups.length, 2);
});

test('a piece dropped into the tray stays where it was dropped', () => {
  const state = { groups: [{ x: 1, y: 1, r: 0, locked: false, members: [9] }], tray: [1, 2, 3, 4] };
  applyPatch(state, { trayAdd: [{ i: 9, r: 0, at: 2 }] });
  assert.deepEqual(state.tray, [1, 2, 9, 3, 4]);
});

test('a rearranged tray keeps pieces others added meanwhile', () => {
  const state = { groups: [], tray: [1, 2, 3, 7] }; // 7 arrived after the reorder was made
  applyPatch(state, { trayOrder: [3, 1, 2, 5] }); // 5 has since left the tray
  assert.deepEqual(state.tray, [3, 1, 2, 7]);
});
