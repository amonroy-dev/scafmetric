// Which way a side bracket points, as ScaffoldPro's bracketPlacement.ts and
// PlaceBracketTool decide it.
//
// A bracket goes square to a run of ledgers. The directions a rosette offers
// are the ones square to the runs through it (or through its standard, or the
// plan axes on a standard with no ledgers yet), less any a ledger or another
// bracket already takes. The default is the one pointing most nearly out of
// the run's own middle; R steps on round the rest in angle order, and the step
// is kept, so the same turn holds for the row you are about to place.
//
// Pure math, no three.js.

const SAME_DIR_RAD = 0.05;
const ON_POINT_FT = 0.01;

const norm = a => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
function angleGap(a, b) {
  const d = Math.abs(norm(a) - norm(b));
  return Math.min(d, 2 * Math.PI - d);
}
function axisGap(a, b) {
  const d = Math.abs((((a - b) % Math.PI) + Math.PI) % Math.PI);
  return Math.min(d, Math.PI - d);
}

/** Bearings of the ledgers leaving a point (and, with `column`, anywhere up its standard). */
function ledgerBearings(node, ledgers, column) {
  const out = [];
  for (const l of ledgers) {
    for (const [p, q] of [[l.a, l.b], [l.b, l.a]]) {
      if (Math.hypot(p[0] - node.x, p[1] - node.y) > ON_POINT_FT) continue;
      if (!column && Math.abs(p[2] - node.z) > ON_POINT_FT) continue;
      const dx = q[0] - p[0], dy = q[1] - p[1];
      if (Math.hypot(dx, dy) > 0.1) out.push(Math.atan2(dy, dx));
    }
  }
  return out;
}

/**
 * The middle of the run this standard belongs to: every standard reachable
 * from it through ledgers, at any lift. A job with two towers has two middles,
 * so a bracket on one never points away from the other.
 */
export function runCentroid(node, ledgers, standards) {
  const key = (x, y) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
  const adj = new Map();
  const link = (p, q) => {
    const a = key(p[0], p[1]), b = key(q[0], q[1]);
    if (a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b); adj.get(b).add(a);
  };
  for (const l of ledgers) link(l.a, l.b);
  const start = key(node.x, node.y);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) for (const n of adj.get(queue.shift()) || []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  const members = standards.filter(s => seen.has(key(s.x, s.y)));
  const pool = members.length > 1 ? members : standards;
  if (!pool.length) return { x: node.x, y: node.y };
  return {
    x: pool.reduce((a, s) => a + s.x, 0) / pool.length,
    y: pool.reduce((a, s) => a + s.y, 0) / pool.length,
  };
}

/**
 * The directions a bracket on this rosette may point, in angle order, each
 * marked primary when it is square to the strongest run through the rosette.
 */
export function bracketDirections(node, { ledgers = [], brackets = [] } = {}) {
  let edges = ledgerBearings(node, ledgers, false);
  if (!edges.length) edges = ledgerBearings(node, ledgers, true);
  const axes = [];
  for (const b of edges) {
    const hit = axes.find(a => axisGap(a.angle, b) < SAME_DIR_RAD);
    if (hit) hit.count++;
    else axes.push({ angle: ((b % Math.PI) + Math.PI) % Math.PI, count: 1 });
  }
  if (!axes.length) axes.push({ angle: 0, count: 0 }, { angle: Math.PI / 2, count: 0 });
  const top = Math.max(...axes.map(a => a.count));

  const candidates = [];
  for (const axis of axes) {
    for (const turn of [Math.PI / 2, -Math.PI / 2]) {
      const angle = norm(axis.angle + turn);
      const existing = candidates.find(c => angleGap(c.angle, angle) < SAME_DIR_RAD);
      if (existing) existing.primary ||= axis.count === top;
      else candidates.push({ angle, primary: axis.count === top });
    }
  }
  // Taken: a ledger leaving this rosette that way, or a bracket already on it.
  const taken = [
    ...ledgerBearings(node, ledgers, false),
    ...brackets
      .filter(k => Math.hypot(k.x - node.x, k.y - node.y) < ON_POINT_FT && Math.abs(k.z - node.z) < ON_POINT_FT)
      .map(k => Math.atan2(k.dir[1], k.dir[0])),
  ];
  return candidates
    .filter(c => !taken.some(t => angleGap(t, c.angle) < SAME_DIR_RAD))
    .sort((a, b) => a.angle - b.angle);
}

/**
 * The direction to use: the primary one pointing most nearly out of the run's
 * middle, then `turn` steps on round the free ones. [dx, dy], or null when the
 * rosette has no free direction.
 */
export function chooseBracketDirection(node, directions, centroid, turn = 0) {
  if (!directions.length) return null;
  const preferred = directions.filter(d => d.primary);
  const pool = preferred.length ? preferred : directions;
  let outward = pool[0];
  const ax = node.x - centroid.x, ay = node.y - centroid.y;
  if (ax * ax + ay * ay > 1e-6) {
    let best = -Infinity;
    for (const d of pool) {
      const along = Math.cos(d.angle) * ax + Math.sin(d.angle) * ay;
      if (along > best) { best = along; outward = d; }
    }
  }
  const n = directions.length;
  const index = (directions.indexOf(outward) + (((Math.round(turn) % n) + n) % n)) % n;
  return unitVector(directions[index].angle);
}

/** [dx, dy] for an angle, with the rounding noise taken off. */
function unitVector(angle) {
  const clean = v => (Math.abs(v) < 1e-9 ? 0 : Math.round(v * 1e9) / 1e9);
  return [clean(Math.cos(angle)), clean(Math.sin(angle))];
}

// --- SHIFT: a bracket on every standard along the run ------------------------
// As ScaffoldPro's PlaceBracketTool: Shift widens one rosette to the whole run
// at that height, each bracket facing the way the hovered one does.

/** How far from a height a rosette may sit and still be the one at that height. */
export const ROSETTE_LEVEL_TOLERANCE_FT = 0.8;
// The next standard of a run is the one most nearly straight ahead, within this.
const ROW_HEADING_TOLERANCE_RAD = Math.PI / 12;
// A bracket along the run faces "the same way" within this of the hovered one.
const ALIGNED_TOLERANCE_RAD = Math.PI / 4;

/**
 * The standards along the run through this one, in order, as plan points.
 *
 * Walked along the ledgers (at any lift) out from the standard both ways,
 * setting off along `runAxisRad` and following the run round gentle bends, so
 * the row is the whole run and not only the part ahead of where you pointed.
 * It stops where the run turns a corner: the standard there belongs to it, the
 * ones round the corner do not. As ScaffoldPro's collectBracketRunRow.
 */
export function bracketRunRow(node, runAxisRad, ledgers, standards) {
  const key = (x, y) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
  const at = new Map(standards.map(s => [key(s.x, s.y), { x: s.x, y: s.y }]));
  const start = key(node.x, node.y);
  if (!at.has(start)) return [];

  const neighbours = new Map();
  const link = (from, to) => {
    const p = at.get(from), q = at.get(to);
    if (!p || !q || from === to) return; // only standards make a run
    let list = neighbours.get(from);
    if (!list) neighbours.set(from, list = []);
    if (!list.some(n => n.key === to)) list.push({ key: to, bearing: Math.atan2(q.y - p.y, q.x - p.x) });
  };
  for (const l of ledgers) {
    const a = key(l.a[0], l.a[1]), b = key(l.b[0], l.b[1]);
    link(a, b);
    link(b, a);
  }

  const visited = new Set([start]);
  const walk = setOff => {
    const out = [];
    let current = start, heading = setOff;
    for (;;) {
      let next = null, best = ROW_HEADING_TOLERANCE_RAD;
      for (const n of neighbours.get(current) || []) {
        if (visited.has(n.key)) continue;
        const gap = angleGap(n.bearing, heading);
        if (gap <= best) { best = gap; next = n; }
      }
      if (!next) break;
      visited.add(next.key);
      out.push(at.get(next.key));
      current = next.key;
      heading = next.bearing;
    }
    return out;
  };
  const after = walk(runAxisRad);
  const before = walk(runAxisRad + Math.PI);
  return [...before.reverse(), at.get(start), ...after];
}

/**
 * The rosette at a height among these nodes: the nearest, or null when none
 * is within tolerance (the run steps, or that standard stops short).
 */
export function rosetteAtHeight(nodes, z, toleranceFt = ROSETTE_LEVEL_TOLERANCE_FT) {
  let best = null, gap = Infinity;
  for (const n of nodes) {
    const d = Math.abs(n.z - z);
    if (d < gap) { gap = d; best = n; }
  }
  return best && gap <= toleranceFt ? best : null;
}

/**
 * Of a rosette's free directions, the one facing the way `referenceAngle`
 * does, as [dx, dy]; null when none is within 45 degrees of it. A standard at
 * the end of a run has directions square to two runs; left to choose for
 * itself it would face down the return while the rest of the row faced out.
 */
export function alignedBracketDirection(directions, referenceAngle) {
  let best = null, gap = ALIGNED_TOLERANCE_RAD;
  for (const d of directions) {
    const g = angleGap(d.angle, referenceAngle);
    if (g <= gap) { gap = g; best = d; }
  }
  return best ? unitVector(best.angle) : null;
}
