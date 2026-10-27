// Pure board rules (no DOM), shared by the game and tests.
//
// A group is a set of pieces that move together. Its (x, y) is how far the group sits
// from its solved position, so two groups line up exactly when their offsets match,
// and a group at (0, 0) is in its final place in the frame. In rotation mode a group
// also has a quarter-turn count r (0–3): pieces only fit when r matches, and only
// upright (r = 0) groups lock into the frame.

export function neighbors(i, cols, rows) {
  const c = i % cols, r = (i / cols) | 0, out = [];
  if (c > 0) out.push(i - 1);
  if (c < cols - 1) out.push(i + 1);
  if (r > 0) out.push(i - cols);
  if (r < rows - 1) out.push(i + cols);
  return out;
}

export function shuffled(n, rnd = Math.random) {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Snap a dropped group into the frame and/or onto matching neighbours, repeatedly.
// Mutates groups/groupOf. Returns what happened so the caller can play feedback.
// `busy(o)` marks groups another player is holding right now; they're never joined.
export function settle(g, { groups, groupOf, cols, rows, tol, busy = () => false }) {
  let joined = 0, locked = false, again = true;
  while (again) {
    again = false;
    if (!g.locked && !(g.r || 0) && Math.abs(g.x) < tol && Math.abs(g.y) < tol) {
      g.x = 0;
      g.y = 0;
      g.locked = true;
      locked = true;
    }
    outer: for (const i of g.members) {
      for (const j of neighbors(i, cols, rows)) {
        const o = groupOf[j];
        if (!o || o === g || busy(o)) continue;
        if ((o.r || 0) === (g.r || 0) && Math.abs(o.x - g.x) < tol && Math.abs(o.y - g.y) < tol) {
          if (o.locked && !g.locked) locked = true;
          if (!g.locked) {
            g.x = o.x;
            g.y = o.y;
          }
          g.locked = g.locked || o.locked;
          for (const k of o.members) {
            g.members.push(k);
            groupOf[k] = g;
          }
          groups.splice(groups.indexOf(o), 1);
          joined++;
          again = true;
          break outer;
        }
      }
    }
  }
  return { joined, locked };
}

export function placedCount(groups) {
  let n = 0;
  for (const g of groups) if (g.locked) n += g.members.length;
  return n;
}

// ---------- playing together ----------
//
// Players send each other patches: the groups their move produced, plus pieces that
// left or went back into the tray. Groups never overlap, and a piece someone is holding
// can't be moved by anyone else, so applying a patch is just "replace whatever groups
// those pieces were in". The live room and every player apply patches with this.
//
// state: { groups: [{ x, y, r, locked, members }], tray: [piece], rot?: [r per piece] }
// patch: { groups?: [...], trayAdd?: [{ i, r, at? }], trayRemove?: [piece], trayOrder?: [piece] }
//   trayAdd `at`: where in the tray the piece was dropped (no `at`: the front).
//   trayOrder: someone rearranged the tray; pieces it doesn't mention keep their order after.
export function applyPatch(state, patch) {
  const touched = new Set();
  for (const g of patch.groups || []) for (const i of g.members) touched.add(i);
  for (const { i } of patch.trayAdd || []) touched.add(i);
  for (const i of patch.trayRemove || []) touched.add(i);
  state.groups = state.groups.filter((g) => !g.members.some((i) => touched.has(i)));
  state.tray = state.tray.filter((i) => !touched.has(i));
  for (const g of patch.groups || []) {
    state.groups.push({ x: g.x, y: g.y, r: g.r || 0, locked: !!g.locked, members: [...g.members] });
  }
  const adds = patch.trayAdd || [];
  for (const { i } of adds.filter((a) => !Number.isInteger(a.at)).reverse()) state.tray.unshift(i);
  for (const { i, at } of adds.filter((a) => Number.isInteger(a.at))) state.tray.splice(Math.min(at, state.tray.length), 0, i);
  if (state.rot) for (const { i, r } of adds) state.rot[i] = r || 0;
  if (Array.isArray(patch.trayOrder)) {
    const inTray = new Set(state.tray);
    const ordered = patch.trayOrder.filter((i) => inTray.has(i));
    const listed = new Set(ordered);
    state.tray = [...ordered, ...state.tray.filter((i) => !listed.has(i))];
  }
  return state;
}
