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
  const a = directions[index].angle;
  const clean = v => (Math.abs(v) < 1e-9 ? 0 : Math.round(v * 1e9) / 1e9);
  return [clean(Math.cos(a)), clean(Math.sin(a))];
}
