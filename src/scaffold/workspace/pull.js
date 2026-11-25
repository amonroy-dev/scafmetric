// Pulling a scaffold longer or shorter by an end.
//
// ScaffoldPro stretches a block by a handle on its side: the block is one
// object with a width, the drag changes the width, and the bays are laid out
// again, with a rule for the odd bay left over at the end. That needs the
// scaffold to still be the block it was placed as, and it moves standards
// under whatever was built on them since.
//
// Here an end is pulled in whole bays. Dragging the handle on any straight
// outside face out by one bay repeats the last bay as it stands, with its
// ledgers, decks, braces, loads and stair flights, and carries the end's own
// rails, braces and brackets out to the new end. Dragging it in takes the last
// bay away and brings them back. Nothing between is laid out again, so it
// works on a scaffold built by hand as on one placed as a block, on either
// kind of face (an end makes a run longer, a side makes it deeper), and every
// standard that stays is exactly where it was.

// A part is on a line of standards when it is this near it: a brace is set
// about 0.2 ft off its face.
const ON_LINE_FT = 0.4;
const SAME_FT = 0.05;

/**
 * The straight outside end a traced face belongs to, or null when it is not a
 * clean one. `faces` are traceFraming's, `face` one of them with `outside`.
 *
 *   origin   a point on the end's line
 *   n, t     unit vectors out of the scaffold and along the end
 *   span     [from, to] along t from the origin
 *   depthFt  the length of the bay behind the end
 *   handle   where its handle goes: the middle of the end, a step outside it
 *   bays     how many bays deep the scaffold is behind this end (1 or 2+)
 */
export function findEnd(faces, face) {
  if (!face || !face.outside) return null;
  const n = { x: face.normX, y: face.normY }, t = { x: face.dirX, y: face.dirY };
  const origin = { x: face.ax, y: face.ay };
  const u = (x, y) => (x - origin.x) * n.x + (y - origin.y) * n.y;
  const v = (x, y) => (x - origin.x) * t.x + (y - origin.y) * t.y;
  // The outside faces on this line that face the same way, as stretches along it.
  const stretches = [];
  for (const f of faces) {
    if (!f.outside || f.normX * n.x + f.normY * n.y < 0.99) continue;
    if (Math.abs(u(f.ax, f.ay)) > SAME_FT || Math.abs(u(f.bx, f.by)) > SAME_FT) continue;
    const a = v(f.ax, f.ay), b = v(f.bx, f.by);
    stretches.push([Math.min(a, b), Math.max(a, b)]);
  }
  stretches.sort((p, q) => p[0] - q[0]);
  // The run of them that touch end to end and include this face.
  const mine = [Math.min(0, v(face.bx, face.by)), Math.max(0, v(face.bx, face.by))];
  let span = [...mine];
  for (let grew = true; grew;) {
    grew = false;
    for (const s of stretches) {
      if (s[1] < span[0] - SAME_FT || s[0] > span[1] + SAME_FT) continue;
      if (s[0] < span[0] - SAME_FT) { span[0] = s[0]; grew = true; }
      if (s[1] > span[1] + SAME_FT) { span[1] = s[1]; grew = true; }
    }
  }
  // Every standard on the end has one straight behind it, all the same distance back.
  const on = new Map();
  for (const f of faces) for (const [x, y] of [[f.ax, f.ay], [f.bx, f.by]]) {
    if (Math.abs(u(x, y)) <= SAME_FT && v(x, y) >= span[0] - SAME_FT && v(x, y) <= span[1] + SAME_FT) on.set(`${Math.round(x * 100)},${Math.round(y * 100)}`, { x, y });
  }
  const behind = (x, y) => {
    let best = null;
    for (const f of faces) {
      for (const [px, py, qx, qy] of [[f.ax, f.ay, f.bx, f.by], [f.bx, f.by, f.ax, f.ay]]) {
        if (Math.hypot(px - x, py - y) > SAME_FT) continue;
        const back = -((qx - px) * n.x + (qy - py) * n.y), side = Math.abs((qx - px) * t.x + (qy - py) * t.y);
        if (back > 0.5 && side <= SAME_FT && (best === null || back < best.back)) best = { back, x: qx, y: qy };
      }
    }
    return best;
  };
  let depthFt = null, deeper = true;
  for (const c of on.values()) {
    const b = behind(c.x, c.y);
    if (!b) return null;
    if (depthFt === null) depthFt = b.back;
    else if (Math.abs(depthFt - b.back) > SAME_FT) return null;
    if (!behind(b.x, b.y)) deeper = false;
  }
  if (!(depthFt > 0)) return null;
  const mid = (span[0] + span[1]) / 2;
  return {
    origin, n, t, span, depthFt, bays: deeper ? 2 : 1,
    handle: { x: origin.x + t.x * mid + n.x * 1.5, y: origin.y + t.y * mid + n.y * 1.5 },
  };
}

const MAPS = s => [['standards', s.standards], ['ledgers', s.ledgers], ['trusses', s.trusses], ['braces', s.braces],
  ['guardrails', s.guardrails], ['planks', s.planks], ['brackets', s.brackets], ['stairs', s.stairs]];

/** The points that say where a part is, with heights, for telling two parts in the same place apart from two alike a bay apart. */
function shapeOf(kind, p) {
  if (kind === 'planks') return [[p.x0, p.y0, p.z], [p.x1, p.y1, p.z]];
  if (kind === 'brackets') return [[p.x, p.y, p.z], [p.x + p.dir[0] * p.lengthFt, p.y + p.dir[1] * p.lengthFt, p.z]];
  if (kind === 'stairs') return [...p.lower.map(q => [q[0], q[1], p.z0]), ...p.upper.map(q => [q[0], q[1], p.z1])];
  if (kind === 'standards') return [[p.x, p.y, 0]];
  return [p.a, p.b];
}
const sameShape = (a, b, dx, dy) => a.length === b.length && a.every(p => b.some(q => Math.hypot(p[0] + dx - q[0], p[1] + dy - q[1]) <= SAME_FT && Math.abs((p[2] || 0) - (q[2] || 0)) <= SAME_FT));

/** Sort the parts at an end: on its line, in the bay behind it, and which of those on the line are there only because it is an end. */
function partsAtEnd(state, end) {
  const { origin, n, t, span, depthFt: L } = end;
  const u = p => (p[0] - origin.x) * n.x + (p[1] - origin.y) * n.y;
  const v = p => (p[0] - origin.x) * t.x + (p[1] - origin.y) * t.y;
  const within = p => v(p) >= span[0] - ON_LINE_FT && v(p) <= span[1] + ON_LINE_FT;
  const cap = [], between = [], sideRails = [], shapes = new Map();
  for (const [kind, map] of MAPS(state)) {
    for (const item of map.values()) {
      if (kind === 'standards' && item.bracketId) continue; // goes with its bracket
      const pts = shapeOf(kind, item);
      const anchors = kind === 'brackets' ? [pts[0]] : pts;
      // A rail down a side is one tube line however many bays it passes: it is made longer or shorter, not copied.
      if (kind === 'guardrails' && item.kind === 'rail') {
        const along = Math.abs((item.b[0] - item.a[0]) * n.x + (item.b[1] - item.a[1]) * n.y) > 0.5;
        if (along) {
          for (const key of ['a', 'b']) if (Math.abs(u(item[key])) <= ON_LINE_FT && within(item[key])) sideRails.push({ id: item.id, key });
          continue;
        }
      }
      shapes.set(item.id, { kind, pts });
      if (!anchors.every(within)) continue;
      if (anchors.every(p => Math.abs(u(p)) <= ON_LINE_FT)) cap.push({ id: item.id, kind, pts });
      else if (anchors.every(p => u(p) <= ON_LINE_FT && u(p) >= -L - ON_LINE_FT) && !anchors.every(p => Math.abs(u(p) + L) <= ON_LINE_FT)) between.push({ id: item.id, kind, pts });
    }
  }
  // On the end's line and with no twin a bay back: the end's own rails, braces and brackets.
  let endOnly = cap.filter(c => c.kind !== 'standards' && ![...shapes].some(([id, o]) => id !== c.id && o.kind === c.kind && sameShape(c.pts, o.pts, -n.x * L, -n.y * L)));
  if (end.bays < 2) {
    // One bay deep, the line a bay back is the scaffold's other outside face,
    // and its rails and braces look like twins of this end's. So it goes by
    // what a part is: a rail, a brace, a bracket pointing out of the end, and
    // a ledger at rail height over a deck (within two rosettes above one, and
    // not at a deck's own height) belong to the end.
    const decks = state.plankBays().filter(d => { const c = [(d.x0 + d.x1) / 2, (d.y0 + d.y1) / 2]; return within(c) && u(c) <= 0 && u(c) >= -L; }).map(d => d.z);
    const railHeight = z => !decks.some(d => Math.abs(d - z) <= SAME_FT) && decks.some(d => z - d > SAME_FT && z - d <= 3.6);
    endOnly = cap.filter(c => c.kind === 'guardrails' || c.kind === 'braces'
      || (c.kind === 'brackets' && (c.pts[1][0] - c.pts[0][0]) * n.x + (c.pts[1][1] - c.pts[0][1]) * n.y > 0.5)
      || ((c.kind === 'ledgers' || c.kind === 'trusses') && railHeight(c.pts[0][2])));
  }
  // Standards seated in the brackets that are going.
  const seated = ids => [...state.standards.values()].filter(c => c.bracketId && ids.has(c.bracketId)).map(c => c.id);
  return { cap, between, endOnly, sideRails, seated };
}

/**
 * Pull an end out by one bay (`way` +1) or in by one (-1). True when it was
 * done. One undo step with whatever else is in the caller's batch.
 */
export function pullEnd(state, end, way) {
  const { n, depthFt: L } = end;
  const shift = { dx: n.x * L * way, dy: n.y * L * way };
  const { cap, between, endOnly, sideRails, seated } = partsAtEnd(state, end);
  if (!cap.some(c => c.kind === 'standards')) return false;
  if (way < 0 && end.bays < 2) return false; // the last bay is not taken: there would be no scaffold left to have an end
  return state.batch(() => {
    state._pushHistory();
    for (const r of sideRails) {
      const g = state.guardrails.get(r.id);
      if (g) g[r.key] = [g[r.key][0] + shift.dx, g[r.key][1] + shift.dy, g[r.key][2]];
    }
    if (way > 0) {
      const ids = new Set([...between, ...cap].map(c => c.id));
      state.transformParts([...ids, ...seated(ids)], shift, true);
      // What made the old end an end has gone out with the copy.
      const gone = new Set(endOnly.map(c => c.id));
      state.removeMany([...gone, ...seated(gone)]);
    } else {
      const moving = new Set(endOnly.map(c => c.id));
      const going = [...between, ...cap].filter(c => !moving.has(c.id));
      const goingIds = new Set(going.filter(c => c.kind !== 'standards').map(c => c.id));
      state.removeMany([...goingIds, ...seated(goingIds)]);
      // A standard of the old end stays if something else still hangs on it (another run meets it there).
      const used = new Set();
      for (const [kind, map] of MAPS(state)) {
        if (kind === 'standards') continue;
        for (const item of map.values()) {
          const pts = shapeOf(kind, item);
          for (const p of (kind === 'brackets' ? [pts[0]] : pts)) for (const c of going) {
            if (c.kind === 'standards' && Math.hypot(c.pts[0][0] - p[0], c.pts[0][1] - p[1]) <= ON_LINE_FT && !moving.has(item.id)) used.add(c.id);
          }
        }
      }
      state.removeMany(going.filter(c => c.kind === 'standards' && !used.has(c.id)).map(c => c.id));
      state.transformParts([...moving, ...seated(moving)], shift, false);
      // A side rail pulled back to nothing is no rail.
      for (const r of sideRails) {
        const g = state.guardrails.get(r.id);
        if (g && Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]) < SAME_FT) state.guardrails.delete(r.id);
      }
    }
    state._emit();
    return true;
  });
}
