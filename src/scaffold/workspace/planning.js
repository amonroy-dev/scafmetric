// Scaffold planning algorithms, ported from the ScaffoldPro / Scaffxiq_v2
// scaffold side. Pure math — no three.js, no DOM — so it is unit-testable.
//
//  - adjacency scale + principal lift axes (handles rotated / irregular grids)
//  - nearest-neighbour targeting that never skips an intermediate standard
//  - one-click ledger targeting and the shift batch plan
//  - which bay edges of a lift are on the outside (perimeter handrails)
//  - bay layout and standard-segment stacking for the Block tool

// Perpendicular tolerance for "colinear" checks (~6 in sideways).
export const PERP_TOL_FT = 0.5;
// A diagonal spans 4 rosette levels.
export const BRACE_DELTA_LIFT = 4;

// 75th-percentile nearest-neighbour distance = the typical bay spacing.
export function computeAdjacencyScaleFt(nodes) {
  if (!nodes || nodes.length < 2) return Infinity;
  const mins = [];
  for (let i = 0; i < nodes.length; i++) {
    let best = Infinity;
    const a = nodes[i];
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const b = nodes[j];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      if (d < best) best = d;
    }
    if (best < Infinity) mins.push(best);
  }
  if (!mins.length) return Infinity;
  mins.sort((x, y) => x - y);
  const idx = Math.max(0, Math.floor(0.75 * (mins.length - 1)));
  return mins[idx];
}

/**
 * Dominant grid direction at a lift, from a 5-degree histogram of the k nearest
 * neighbour directions (sign-folded so v and -v share a bin).
 */
export function computeLiftAxes(nodes, adjacencyScaleFt) {
  if (!nodes || nodes.length < 2) return null;
  const kNearest = 4;
  const maxSampleDist = Number.isFinite(adjacencyScaleFt) ? adjacencyScaleFt * 1.25 : Infinity;
  const bins = 36;
  const counts = new Array(bins).fill(0);
  const sums = Array.from({ length: bins }, () => ({ x: 0, y: 0 }));

  const addDirSample = (dx, dy) => {
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return;
    let ux = dx / len, uy = dy / len;
    if (ux < 0 || (Math.abs(ux) < 1e-12 && uy < 0)) { ux = -ux; uy = -uy; }
    let ang = Math.atan2(uy, ux);
    if (ang < 0) ang += Math.PI;
    const bin = Math.max(0, Math.min(bins - 1, Math.floor((ang / Math.PI) * bins)));
    counts[bin] += 1;
    sums[bin].x += ux;
    sums[bin].y += uy;
  };

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    const dists = [];
    for (let j = 0; j < nodes.length; j++) {
      if (i === j) continue;
      const b = nodes[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      dists.push({ d: Math.hypot(dx, dy), dx, dy });
    }
    dists.sort((p, q) => p.d - q.d);
    for (let k = 0; k < Math.min(kNearest, dists.length); k++) {
      if (dists[k].d > maxSampleDist) break;
      addDirSample(dists[k].dx, dists[k].dy);
    }
  }

  let bestBin = -1, bestCount = 0, bestSumLenSq = 0;
  for (let b = 0; b < bins; b++) {
    const c = counts[b];
    if (!c) continue;
    const sLenSq = sums[b].x ** 2 + sums[b].y ** 2;
    if (c > bestCount || (c === bestCount && sLenSq > bestSumLenSq)) {
      bestCount = c; bestSumLenSq = sLenSq; bestBin = b;
    }
  }
  if (bestBin < 0) return null;
  let ax = sums[bestBin].x, ay = sums[bestBin].y;
  const len = Math.hypot(ax, ay);
  if (len < 1e-5) { ax = 1; ay = 0; } else { ax /= len; ay /= len; }
  return { axisA: { x: ax, y: ay }, axisB: { x: -ay, y: ax } };
}

export function maxProjFor(adjacencyScaleFt) {
  return Math.max((Number.isFinite(adjacencyScaleFt) ? adjacencyScaleFt : 0) * 2.5, 12);
}

/**
 * Nearest node along +/-axis within the perpendicular tolerance. This finds the
 * true geometric neighbour first, so we never skip over an intermediate standard.
 */
export function findNearestAlongAxis(source, nodes, axis, perpAxis, sign, maxProjFt) {
  let best = null, bestProj = Infinity;
  for (const c of nodes) {
    if (c.columnId === source.columnId) continue;
    const dx = c.x - source.x, dy = c.y - source.y;
    const proj = (dx * axis.x + dy * axis.y) * sign;
    if (proj <= 1e-6 || proj > maxProjFt) continue;
    const perp = Math.abs(dx * perpAxis.x + dy * perpAxis.y);
    if (perp > PERP_TOL_FT) continue;
    if (proj < bestProj) { bestProj = proj; best = c; }
  }
  return best;
}

export function getAdjacentCandidates(source, nodes, axes, maxProjFt, canUse) {
  const out = [];
  const aPos = findNearestAlongAxis(source, nodes, axes.axisA, axes.axisB, 1, maxProjFt);
  const aNeg = findNearestAlongAxis(source, nodes, axes.axisA, axes.axisB, -1, maxProjFt);
  const bPos = findNearestAlongAxis(source, nodes, axes.axisB, axes.axisA, 1, maxProjFt);
  const bNeg = findNearestAlongAxis(source, nodes, axes.axisB, axes.axisA, -1, maxProjFt);
  for (const c of [aPos, aNeg, bPos, bNeg]) if (c && (!canUse || canUse(c))) out.push(c);
  return out;
}

/** Closest unoccupied adjacent node at the same lift, or null. */
/**
 * A lift's grid frame: its principal axes and how far a neighbour may be. Both
 * are quadratic in the nodes at the lift, so callers asking for many nodes on
 * one lift compute this once and pass it in. Null when the lift has no grid.
 */
export function liftFrame(nodesAtLift) {
  const scale = computeAdjacencyScaleFt(nodesAtLift);
  const axes = computeLiftAxes(nodesAtLift, scale);
  return axes ? { axes, maxProj: maxProjFor(scale) } : null;
}

export function findClosestUnoccupiedTarget(source, nodesAtLift, canUse, frame = liftFrame(nodesAtLift)) {
  if (!frame) return null;
  const adj = getAdjacentCandidates(source, nodesAtLift, frame.axes, frame.maxProj, canUse);
  let best = null, bestD = Infinity;
  for (const c of adj) {
    const d = Math.hypot(c.x - source.x, c.y - source.y);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/**
 * Every ledger that could be added at this lift: each adjacent pair once, with
 * no duplicates and skipping connections that already exist.
 */
export function computeBatchPlan(nodesAtLift, canUse) {
  const plan = [];
  const scale = computeAdjacencyScaleFt(nodesAtLift);
  const axes = computeLiftAxes(nodesAtLift, scale);
  if (!axes) return plan;
  const maxProj = maxProjFor(scale);
  const planned = new Set();
  const pairKey = (a, b) => [a.columnId, b.columnId].sort().join('|');

  for (const source of nodesAtLift) {
    const use = c => {
      if (planned.has(pairKey(source, c))) return false;
      return !canUse || canUse(source, c);
    };
    for (const neighbor of getAdjacentCandidates(source, nodesAtLift, axes, maxProj, use)) {
      const k = pairKey(source, neighbor);
      if (planned.has(k)) continue;
      planned.add(k);
      plan.push({ a: source, b: neighbor });
    }
  }
  return plan;
}

// --- the outside of a lift -----------------------------------------------------
// ScaffoldPro's ledgerPlacementPlanning.ts, which its Ledger tool uses for
// "Perimeter handrails": the bay edges of a lift, which of them are on the
// outside of the scaffold, and which scaffold each one belongs to.

// How nearly two sides of a bay have to line up for it to be one (15 degrees).
const CELL_ALIGNMENT_COS = Math.cos((15 * Math.PI) / 180);
const CELL_SIDE_EPS_FT = 1e-4;

/** Order-free key for the bay edge between two nodes of one lift. */
export function bayEdgeKey(a, b) {
  return a.columnId < b.columnId ? `${a.columnId}|${b.columnId}` : `${b.columnId}|${a.columnId}`;
}

/**
 * Every bay edge at a lift, each once: [{ key, a, b, lengthFt }]. These are the
 * pairs a SHIFT fill of the lift joins, whether or not a ledger is there yet.
 *
 * `isBay(a, b)` can turn a pair down. Standing next to each other is all the
 * geometry knows, and it is too generous once a scaffold is framed: two runs a
 * few feet apart get "edges" across the open air between them.
 */
export function liftBayEdges(nodesAtLift, frame = liftFrame(nodesAtLift), isBay = null) {
  if (!frame) return [];
  const edges = new Map();
  for (const source of nodesAtLift) {
    for (const c of getAdjacentCandidates(source, nodesAtLift, frame.axes, frame.maxProj, null)) {
      const key = bayEdgeKey(source, c);
      if (edges.has(key)) continue;
      if (isBay && !isBay(source, c)) continue;
      edges.set(key, { key, a: source, b: c, lengthFt: Math.hypot(c.x - source.x, c.y - source.y) });
    }
  }
  return [...edges.values()];
}

function edgesByColumn(edges) {
  const byColumn = new Map();
  const add = (id, e) => { let list = byColumn.get(id); if (!list) byColumn.set(id, list = []); list.push(e); };
  for (const e of edges) { add(e.a.columnId, e); add(e.b.columnId, e); }
  return byColumn;
}

function cosBetween(ax, ay, bx, by) {
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  return la < 1e-6 || lb < 1e-6 ? -1 : (ax * bx + ay * by) / (la * lb);
}

/**
 * The keys of the bay edges on the outside of the scaffold.
 *
 * An edge is inside when a bay stands on each side of it: four edges round
 * four nodes, the two that leave this edge's ends running the same way and the
 * far one running along it. Any other edge is outside, which takes in a single
 * row (no bays at all, every edge exposed).
 *
 * Judged from the bays round each edge and not from a bounding box, so it
 * holds for a scaffold turned in plan, for one with a corner cut out of it,
 * and for a row of standards seated in side brackets one row out from a face.
 *
 * Give it every edge, with or without a ledger on it: leaving out the ones
 * already built would make a finished rail look like a missing bay and turn
 * the edge behind it into an outside one.
 */
export function outsideEdgeKeys(edges) {
  const byColumn = edgesByColumn(edges);
  const keys = new Set(edges.map(e => e.key));
  const other = (e, id) => (e.a.columnId === id ? e.b : e.a);
  const outside = new Set();
  for (const edge of edges) {
    const { a, b } = edge;
    const ex = b.x - a.x, ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-6) continue;
    const ux = ex / len, uy = ey / len;
    let sides = 0; // bit 1: a bay on the left of a->b; bit 2: one on the right
    for (const fromA of byColumn.get(a.columnId) || []) {
      const c = other(fromA, a.columnId);
      if (c.columnId === b.columnId) continue;
      const cx = c.x - a.x, cy = c.y - a.y;
      const sideC = ux * cy - uy * cx;
      if (Math.abs(sideC) <= CELL_SIDE_EPS_FT) continue;
      const bit = sideC > 0 ? 1 : 2;
      if (sides & bit) continue;
      for (const fromB of byColumn.get(b.columnId) || []) {
        const d = other(fromB, b.columnId);
        if (d.columnId === a.columnId || d.columnId === c.columnId) continue;
        const dx = d.x - b.x, dy = d.y - b.y;
        const sideD = ux * dy - uy * dx;
        if (Math.abs(sideD) <= CELL_SIDE_EPS_FT || sideC * sideD <= 0) continue;
        if (!keys.has(bayEdgeKey(c, d))) continue;
        // Not a bow-tie, and not four edges that merely happen to close.
        if (cosBetween(cx, cy, dx, dy) < CELL_ALIGNMENT_COS) continue;
        if (cosBetween(ex, ey, d.x - c.x, d.y - c.y) < CELL_ALIGNMENT_COS) continue;
        sides |= bit;
        break;
      }
      if (sides === 3) break;
    }
    if (sides !== 3) outside.add(edge.key);
  }
  return outside;
}

/**
 * A lift read for its outline: { edges, outside, byColumn, group }.
 *
 *   edges     every bay edge (liftBayEdges)
 *   outside   the keys of those on the outside (outsideEdgeKeys)
 *   byColumn  columnId -> the edges that meet at that node
 *   group     columnId -> a label shared by every node a walk along bay edges
 *             reaches: one scaffold. Two that stand apart have two labels, so
 *             a fill started on one stays on it.
 */
export function planLiftOutline(nodesAtLift, frame = liftFrame(nodesAtLift), isBay = null) {
  const edges = liftBayEdges(nodesAtLift, frame, isBay);
  const byColumn = edgesByColumn(edges);
  const group = new Map();
  for (const start of byColumn.keys()) {
    if (group.has(start)) continue;
    group.set(start, start);
    const queue = [start];
    while (queue.length) {
      const id = queue.pop();
      for (const e of byColumn.get(id)) {
        const next = e.a.columnId === id ? e.b.columnId : e.a.columnId;
        if (group.has(next)) continue;
        group.set(next, start);
        queue.push(next);
      }
    }
  }
  return { edges, outside: outsideEdgeKeys(edges), byColumn, group };
}

/**
 * Split a run into bays. Prefers ~7 ft bays and fewer standards, with catalog
 * ledger fit as a tie-break. Mirrors chooseBayLayout in blockPlanning.ts.
 */
export function chooseBayLayout(totalFt, ledgerLengthsFt = [10, 8, 7, 6, 5, 4, 3.5, 3, 2]) {
  const total = Math.max(0.1, Number.isFinite(totalFt) ? totalFt : 7);
  const minSpacingFt = 2;
  const targetSpacingFt = 7;
  const maxBays = Math.min(20, Math.max(1, Math.ceil(total / minSpacingFt)));
  const closest = ft => ledgerLengthsFt.reduce((best, l) =>
    Math.abs(l - ft) < Math.abs(best - ft) ? l : best, ledgerLengthsFt[0]);

  let bestBays = 1, bestSpacing = total, bestScore = Infinity, bestLedger = closest(total);
  for (let bays = 1; bays <= maxBays; bays++) {
    const spacingFt = total / bays;
    if (bays > 1 && spacingFt < minSpacingFt - 1e-6) continue;
    const ledger = closest(spacingFt);
    const diffIn = Math.abs(ledger - spacingFt) * 12;
    const score = Math.abs(spacingFt - targetSpacingFt) * 8 + bays * 10 + diffIn * 0.25;
    if (score < bestScore) {
      bestScore = score; bestBays = bays; bestSpacing = spacingFt; bestLedger = ledger;
    }
  }
  return { bays: bestBays, spacingFt: bestSpacing, ledgerLengthFt: bestLedger };
}

/**
 * Stack standard segments to reach (without exceeding) a target height.
 * Unbounded knapsack minimising segment count, then preferring larger parts,
 * scored with a per-extra-segment penalty. Mirrors planStandardSegmentsForHeight.
 */
export function planStandardSegmentsForHeight(targetHeightFt, standardLengthsFt) {
  const lengths = [...standardLengthsFt].sort((a, b) => b - a); // largest first
  const safeTarget = Math.max(0.1, Number.isFinite(targetHeightFt) ? targetHeightFt : 10);
  const targetIn = Math.max(1, Math.round(safeTarget * 12));
  const parts = lengths.map(ft => ({ ft, heightIn: Math.max(1, Math.round(ft * 12)) }));
  if (!parts.length) return [];
  const minPartIn = Math.min(...parts.map(p => p.heightIn));
  if (targetIn < minPartIn) return [parts[parts.length - 1].ft];

  const segmentPenaltyIn = 24;
  const bestCount = new Array(targetIn + 1).fill(Infinity);
  const bestVec = new Array(targetIn + 1).fill(null);
  bestCount[0] = 0;
  bestVec[0] = new Array(parts.length).fill(0);

  const vecBetter = (a, b) => {
    if (!b) return true;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return false;
  };

  for (let sum = 0; sum <= targetIn; sum++) {
    const c = bestCount[sum], v = bestVec[sum];
    if (!Number.isFinite(c) || !v) continue;
    for (let pi = 0; pi < parts.length; pi++) {
      const next = sum + parts[pi].heightIn;
      if (next > targetIn) continue;
      const nextCount = c + 1;
      if (nextCount < bestCount[next]) {
        bestCount[next] = nextCount;
        const cand = v.slice();
        cand[pi] = (cand[pi] ?? 0) + 1;
        bestVec[next] = cand;
      } else if (nextCount === bestCount[next]) {
        const cand = v.slice();
        cand[pi] = (cand[pi] ?? 0) + 1;
        if (vecBetter(cand, bestVec[next])) bestVec[next] = cand;
      }
    }
  }

  let bestSum = 0, bestScore = -Infinity;
  for (let sum = minPartIn; sum <= targetIn; sum++) {
    const v = bestVec[sum];
    if (!v) continue;
    const count = bestCount[sum];
    const score = sum - segmentPenaltyIn * (count - 1);
    if (score > bestScore || (score === bestScore && sum > bestSum)) {
      bestScore = score; bestSum = sum;
    }
  }
  const vec = bestVec[bestSum];
  if (!vec) return [parts[parts.length - 1].ft];
  const out = [];
  for (let pi = 0; pi < parts.length; pi++) for (let n = 0; n < vec[pi]; n++) out.push(parts[pi].ft);
  return out; // largest-first
}


// ---------------------------------------------------------------------------
// The Block tool, as ScaffoldPro's PlaceBlockTool lays a block out from its
// recipe (blockPlanning.ts: buildStandardPlan, computeWorkingDeckLiftIndices,
// computeLedgerLiftIndices; PlaceBlockTool.tsx: buildBlockPreviewGeometry).
// ---------------------------------------------------------------------------

// Rosette pitch up a standard, inches. Every catalog standard is a whole
// number of pitches long, so rosettes add up segment by segment.
const ROSETTE_PITCH_IN = 19.6875;

export const BLOCK_BRACE_OPTIONS = ['off', 'slash', 'backslash'];

/** ScaffoldPro's block defaults (its Reset button). */
export const BLOCK_DEFAULTS = Object.freeze({
  widthFt: 7,
  depthFt: 3,
  heightFt: 10,
  plankedLevelsCount: 1,
  includeBaseDeck: false,
  braceFrontBack: 'off',
  braceLeftRight: 'off',
  ledgerEveryN: BRACE_DELTA_LIFT,
  // Rails round every deck, on the rosettes one and two lifts above it.
  guardrails: true,
});

/** Rosettes on one standard segment. */
export function rosettesOnSegment(lengthFt) {
  return Math.max(1, Math.round((lengthFt * 12) / ROSETTE_PITCH_IN));
}

/**
 * Standard segments carrying at least `requiredLift` rosettes: the least
 * overshoot, then the fewest pieces, longest at the bottom.
 */
export function planStandardSegmentsForLift(requiredLift, standardLengthsFt) {
  const need = Math.max(1, Math.round(requiredLift));
  const parts = [...standardLengthsFt].sort((a, b) => b - a).map(ft => ({ ft, n: rosettesOnSegment(ft) }));
  if (!parts.length) return [];
  const maxK = need + Math.max(...parts.map(p => p.n));
  const best = new Array(maxK + 1).fill(null);
  best[0] = [];
  for (let k = 1; k <= maxK; k++) {
    for (const p of parts) {
      if (p.n > k || !best[k - p.n]) continue;
      const cand = [...best[k - p.n], p.ft].sort((a, b) => b - a);
      const cur = best[k];
      if (!cur || cand.length < cur.length || (cand.length === cur.length && cand[0] > cur[0])) best[k] = cand;
    }
  }
  for (let k = need; k <= maxK; k++) if (best[k]) return best[k];
  return [parts[0].ft];
}

/** A plan offset turned a quarter turn `steps` times, as ScaffoldPro's rotateOffset90. */
export function rotateOffset90({ x, y }, steps = 0) {
  const s = ((Math.round(steps) % 4) + 4) % 4;
  if (s === 1) return { x: -y, y: x };
  if (s === 2) return { x: -x, y: -y };
  if (s === 3) return { x: y, y: -x };
  return { x, y };
}

/**
 * Lay a block out from its recipe, centred on the origin, unrotated.
 *
 *   heightFt          the height of the TOP working deck, not of the standards
 *   plankedLevelsCount decks at every fourth lift, counted down from the top one
 *                     that fits under heightFt (plus lift 0 with includeBaseDeck)
 *   standards         long enough to stand two lifts above the top deck, where
 *                     its guardrails go
 *   ledgers           from the lowest rosette (the base collar's when there is
 *                     one) every ledgerEveryN lifts up to the deck height, and
 *                     at every deck so no deck is left without its ledgers
 *   braces            full height, lift pairs four apart, on the faces asked
 *                     for: front/back (the width faces) and left/right
 *
 * `liftZ(lift)` gives a lift's height; `showBaseCollar` says whether lift 0
 * exists. Returns plain data in block-local feet; the caller places it.
 */
export function planBlockRecipe(recipe, { liftZ, showBaseCollar = true, standardLengthsFt, ledgerLengthsFt }) {
  const r = { ...BLOCK_DEFAULTS, ...recipe };
  const widthFt = Math.max(0.5, Number(r.widthFt) || BLOCK_DEFAULTS.widthFt);
  const depthFt = Math.max(0.5, Number(r.depthFt) || BLOCK_DEFAULTS.depthFt);
  const heightFt = Math.max(0.1, Number(r.heightFt) || BLOCK_DEFAULTS.heightFt);
  const layoutX = chooseBayLayout(widthFt, ledgerLengthsFt);
  const layoutY = chooseBayLayout(depthFt, ledgerLengthsFt);
  const halfW = widthFt / 2, halfD = depthFt / 2;
  const xs = Array.from({ length: layoutX.bays + 1 }, (_, i) => i * layoutX.spacingFt - halfW);
  const ys = Array.from({ length: layoutY.bays + 1 }, (_, j) => j * layoutY.spacingFt - halfD);
  const fits = lift => liftZ(lift) <= heightFt + 1e-6;

  // Working decks: top-down from the highest fourth lift under the height.
  const candidates = [];
  if (r.includeBaseDeck && showBaseCollar) candidates.push(0);
  for (let lift = 4; lift < 400 && fits(lift); lift += 4) candidates.push(lift);
  const deckLifts = candidates
    .sort((a, b) => b - a)
    .slice(0, Math.max(0, Math.round(Number(r.plankedLevelsCount) || 0)))
    .sort((a, b) => a - b);
  const topDeck = deckLifts.length ? deckLifts[deckLifts.length - 1] : null;
  const requiredLift = topDeck !== null ? topDeck + 2 : 2;
  const segments = planStandardSegmentsForLift(requiredLift, standardLengthsFt);
  const topLift = segments.reduce((n, ft) => n + rosettesOnSegment(ft), 0);

  const startLift = showBaseCollar ? 0 : 1;
  const everyN = Math.max(1, Math.round(Number(r.ledgerEveryN) || BRACE_DELTA_LIFT));
  const ledgerSet = new Set(deckLifts);
  for (let lift = startLift; lift <= topLift && fits(lift); lift += everyN) ledgerSet.add(lift);
  const ledgerLifts = [...ledgerSet].sort((a, b) => a - b);

  const standards = [];
  for (const y of ys) for (const x of xs) standards.push({ x, y });

  const ledgers = [];
  for (const lift of ledgerLifts) {
    for (const y of ys) for (let i = 0; i < xs.length - 1; i++) ledgers.push({ a: { x: xs[i], y }, b: { x: xs[i + 1], y }, lift });
    for (const x of xs) for (let j = 0; j < ys.length - 1; j++) ledgers.push({ a: { x, y: ys[j] }, b: { x, y: ys[j + 1] }, lift });
  }

  const bracePairs = [];
  for (let lift = startLift; lift + BRACE_DELTA_LIFT <= topLift; lift += BRACE_DELTA_LIFT) bracePairs.push([lift, lift + BRACE_DELTA_LIFT]);
  const braces = [];
  if (r.braceFrontBack !== 'off') {
    for (const faceSign of [1, -1]) {
      const ascending = faceSign === 1 ? r.braceFrontBack === 'slash' : r.braceFrontBack === 'backslash';
      const y = faceSign * halfD;
      for (let i = 0; i < xs.length - 1; i++) {
        const [x0, x1] = ascending ? [xs[i], xs[i + 1]] : [xs[i + 1], xs[i]];
        for (const [lo, hi] of bracePairs) braces.push({ a: { x: x0, y }, b: { x: x1, y }, lift: lo, toLift: hi, normal: { x: 0, y: faceSign } });
      }
    }
  }
  if (r.braceLeftRight !== 'off') {
    for (const faceSign of [1, -1]) {
      const ascending = faceSign === 1 ? r.braceLeftRight === 'slash' : r.braceLeftRight === 'backslash';
      const x = faceSign * halfW;
      for (let j = 0; j < ys.length - 1; j++) {
        const [y0, y1] = ascending ? [ys[j], ys[j + 1]] : [ys[j + 1], ys[j]];
        for (const [lo, hi] of bracePairs) braces.push({ a: { x, y: y0 }, b: { x, y: y1 }, lift: lo, toLift: hi, normal: { x: faceSign, y: 0 } });
      }
    }
  }

  const decks = [];
  for (const lift of deckLifts) {
    for (let j = 0; j < ys.length - 1; j++) for (let i = 0; i < xs.length - 1; i++) {
      decks.push({ x0: xs[i], y0: ys[j], x1: xs[i + 1], y1: ys[j + 1], lift });
    }
  }

  return {
    widthFt, depthFt, heightFt, layoutX, layoutY, xs, ys,
    segments, requiredLift, topLift, deckLifts, ledgerLifts,
    standards, ledgers, braces, decks,
  };
}

export const BLOCK_SNAP_RADIUS_FT = 1.25;

// --- buildings ---------------------------------------------------------------------
// A building is its outline in plan and a height. Scaffold goes round it at a
// set distance off the wall (ScaffoldPro's autoScaffoldAroundBuilding.ts): a
// run of bays along each wall, and a square block the depth of the scaffold
// at each corner to carry it round.

export const BUILDING_DEFAULTS = { heightFt: 20, wallDistanceFt: 1 };
// A wall counts as square to the grid when it is this near it; scaffold runs
// are laid along those and no others, since blocks turn in quarter turns.
const WALL_SQUARE_FT = 0.05;
// A stretch of wall shorter than this, once its corners are taken off, gets no run of its own.
const MIN_RUN_FT = 2;

function polygonArea(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) { const p = points[i], q = points[(i + 1) % points.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}

/**
 * The walls of an outline: [{ a, b, lengthFt, tx, ty, nx, ny, square }], t
 * along the wall and n pointing out of the building.
 */
export function buildingWalls(points) {
  if (!points || points.length < 3) return [];
  const ccw = polygonArea(points) > 0;
  return points.map((a, i) => {
    const b = points[(i + 1) % points.length];
    const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    const tx = dx / len, ty = dy / len;
    const [nx, ny] = ccw ? [ty, -tx] : [-ty, tx];
    return { a, b, lengthFt: len, tx, ty, nx: nx + 0, ny: ny + 0, square: Math.abs(dx) <= WALL_SQUARE_FT || Math.abs(dy) <= WALL_SQUARE_FT };
  });
}

/**
 * Blocks that carry a scaffold `depthFt` deep round a building, `offsetFt` off
 * its walls: [{ center:{x,y}, widthFt, depthFt, rotationSteps, corner }], and
 * how many walls were left out for not being square to the grid.
 *
 * Along each wall one block runs the length of it. At a corner that turns
 * outward the two runs stop at the corner and a square block fills the gap
 * between their ends; at one that turns inward (a notch) each run stops short
 * by the offset and the depth, and the square goes in the angle. Either way
 * the runs and the square share their end standards, so the whole is one
 * chain.
 */
export function planScaffoldRoundBuilding(points, { offsetFt = BUILDING_DEFAULTS.wallDistanceFt, depthFt = 3 } = {}) {
  const walls = buildingWalls(points);
  const off = Math.max(0, Number(offsetFt) || 0), depth = Math.max(0.5, Number(depthFt) || 3);
  const face = off + depth / 2;
  const blocks = [];
  let skipped = 0;
  const n = walls.length;
  // A corner turns outward when the next wall leaves on the far side from the building.
  const outward = i => { const w = walls[(i - 1 + n) % n], v = walls[i]; return w.nx * v.tx + w.ny * v.ty < 0; };
  walls.forEach((w, i) => {
    const prev = walls[(i - 1 + n) % n], next = walls[(i + 1) % n];
    if (w.square && prev.square) {
      const [cx, cy] = w.a;
      blocks.push({ center: { x: cx + (prev.nx + w.nx) * face, y: cy + (prev.ny + w.ny) * face }, widthFt: depth, depthFt: depth, rotationSteps: 0, corner: true });
    }
    if (!w.square) { skipped++; return; }
    // Where the run starts and stops along the wall, measured from its first corner.
    const start = prev.square ? (outward(i) ? -off : off + depth) : 0;
    const end = w.lengthFt - (next.square ? (outward((i + 1) % n) ? -off : off + depth) : 0);
    if (end - start < MIN_RUN_FT) return;
    const mid = (start + end) / 2;
    blocks.push({
      center: { x: w.a[0] + w.tx * mid + w.nx * face, y: w.a[1] + w.ty * mid + w.ny * face },
      widthFt: end - start, depthFt: depth, rotationSteps: Math.abs(w.tx) > 0.5 ? 0 : 1, corner: false,
    });
  });
  return { blocks, skipped };
}

/**
 * Scaffold round a round building, as ScaffoldPro's buildRoundAutoScaffoldPlan:
 * a ring of standards `offsetFt` off the wall and another `depthFt` further
 * out, with as many bays as bring the straight ledger between two inner
 * standards nearest 6 ft and between two outer ones nearest 8 ft.
 * Returns { bays, inner:[[x,y]], outer:[[x,y]], innerChordFt, outerChordFt }.
 */
export function planRoundScaffold(round, { offsetFt = BUILDING_DEFAULTS.wallDistanceFt, depthFt = 3, innerLedgerFt = 6, outerLedgerFt = 8 } = {}) {
  const innerR = Math.max(0.1, Number(round.radiusFt) || 0) + Math.max(0, Number(offsetFt) || 0);
  const outerR = innerR + Math.max(0.5, Number(depthFt) || 3);
  const around = Math.PI * (innerR + outerR);
  const least = Math.max(6, Math.round(around / 12)), most = Math.max(least, Math.round(around / 4));
  let best = null;
  for (let bays = least; bays <= most; bays++) {
    const half = Math.PI / bays;
    const innerChordFt = 2 * innerR * Math.sin(half), outerChordFt = 2 * outerR * Math.sin(half);
    const score = Math.abs(innerChordFt - innerLedgerFt) * 2 + Math.abs(outerChordFt - outerLedgerFt);
    if (!best || score < best.score - 1e-6) best = { bays, innerChordFt, outerChordFt, score };
  }
  const ring = r => Array.from({ length: best.bays }, (_, i) => {
    const a = (i / best.bays) * Math.PI * 2;
    return [round.cx + Math.cos(a) * r, round.cy + Math.sin(a) * r];
  });
  return { bays: best.bays, inner: ring(innerR), outer: ring(outerR), innerChordFt: best.innerChordFt, outerChordFt: best.outerChordFt };
}

/**
 * Where a block centred at `center`, `alongFt` by `acrossFt` in world x and y,
 * should sit to stand `offsetFt` off the nearest wall it is beside: the same
 * centre moved square to that wall, or null when no wall is within reach.
 */
export function snapToWall(center, sizeX, sizeY, buildings, offsetFt, reachFt = 3) {
  let best = null;
  for (const b of buildings) {
    for (const w of buildingWalls(b.points)) {
      if (!w.square) continue;
      const half = Math.abs(w.nx) > 0.5 ? sizeX / 2 : sizeY / 2;
      const along = (center.x - w.a[0]) * w.tx + (center.y - w.a[1]) * w.ty;
      if (along < -half || along > w.lengthFt + half) continue;
      const out = (center.x - w.a[0]) * w.nx + (center.y - w.a[1]) * w.ny;
      const move = offsetFt + half - out;
      if (Math.abs(move) > reachFt || (best && Math.abs(move) >= Math.abs(best.move))) continue;
      best = { move, x: center.x + w.nx * move, y: center.y + w.ny * move };
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

// --- the stair tower -------------------------------------------------------------
// A 14 x 7 ft switchback tower on ten standards: a 3'-6" landing at each end,
// the full 7 ft wide, and between them a 7 ft bay holding two 3'-6" flights
// side by side, one going each way. Four standards down each long side (at
// 0, 3'-6", 10'-6" and 14 ft) and one in the middle of the width on each
// landing line, where the two flights meet.
//
// A flight is a fixed part: it always climbs four rosettes. A top landing that
// is not a whole number of flights up is reached by one adjustment:
//
//   one rosette short   the top flight is buried: its foot hangs a rosette
//                       below the landing it leaves, its lowest treads are left
//                       off, and three planks laid between its stringers carry
//                       the landing out to where its treads come up
//   one rosette over    the top flight is hung a rosette high, with a one-plank
//                       step on two clamp-on brackets making up the first rise
//   two rosettes over   a short starter stair off the ground comes first
//
// Weights are round figures for a takeoff, not any maker's catalogue.
export const STAIR_TOWER = {
  lengthFt: 14, widthFt: 7, landingFt: 3.5,
  // One flight (a pair of 7 ft stringers) climbs four rosettes: 6'-6 3/4".
  flightLifts: 4,
  treadsPerFlight: 9,
  // A rosette of a flight buried under a landing takes three treads with it.
  treadsPerRosette: 3,
  maxBuryRosettes: 2,
  stringerLb: 66,
  treadLb: 12.5,
  // The starter stair: two rosettes, four treads, its own short stringers and handrails.
  starterLifts: 2,
  starterTreads: 4,
  starterRunFt: 3.5,
  starterStringerLb: 29,
  starterHandrailLb: 23,
  // The step under a flight hung high: one 3'-6" plank on two clamp-on brackets.
  stepBracketLb: 4,
  stepPlankLb: 18,
  // The planks carried out under a buried flight: three 9 in boards between its stringers.
  buriedPlankWidthFt: 2.25,
};
export const STAIR_DEFAULTS = { heightFt: 14.5 };

/** What a flight weighs: its two stringers and treads, and what goes with it (a starter's handrails, a step). */
export function stairFlightWeightLb(f) {
  const T = STAIR_TOWER;
  const treads = (f.treads || 0) * T.treadLb;
  if (f.starter) return 2 * T.starterStringerLb + treads + 2 * T.starterHandrailLb;
  return 2 * T.stringerLb + treads + (f.step ? 2 * T.stepBracketLb + T.stepPlankLb : 0);
}

/**
 * How the flights between two landings `gap` rosettes apart climb: a list of
 * 4s (a whole flight), 3s (one buried a rosette) and 5s (one hung a rosette
 * high, with a step), the adjusted ones last. From the foot of the tower
 * (`first`) a starter stair takes up two, and the lowest flight is never
 * buried: there is nothing under the foot to hang it from. Null when the two
 * are too close to put a flight between.
 */
export function flightsForRise(gap, first = false) {
  const F = STAIR_TOWER.flightLifts;
  const whole = n => Array.from({ length: n }, () => F);
  if (first) {
    if (gap === STAIR_TOWER.starterLifts) return { starter: true, rises: [] };
    if (gap < F) return null;
    const k = Math.floor(gap / F), over = gap % F;
    if (over === 0) return { starter: false, rises: whole(k) };
    if (over === 1) return { starter: false, rises: [...whole(k - 1), F + 1] };
    if (over === 2) return { starter: true, rises: whole(k) };
    return { starter: false, rises: [...whole(k), F - 1] };
  }
  if (gap < F - 1) return null;
  const k = Math.floor(gap / F), over = gap % F;
  if (over === 0) return { starter: false, rises: whole(k) };
  if (over === 1) return { starter: false, rises: [...whole(k - 1), F + 1] };
  if (over === 2) return { starter: false, rises: [...whole(k - 1), F - 1, F - 1] };
  return { starter: false, rises: [...whole(k), F - 1] };
}

/**
 * Lay a stair tower out, centred on the origin, unrotated, in the shape
 * planBlockRecipe returns so the Block tool's ghost, snapping and placing take
 * it as they take a block. `heightFt` is the height of the top landing, taken
 * down to the rosette at or under it (one flight up at the least). With
 * `landingsFt`, a list of heights, the tower has a landing on the rosette
 * nearest each one instead (within 10 in of it), the last being the top.
 *
 *   landings   at alternate ends, decked with 7 ft planks across the tower;
 *              the first on the collar's rosette, or with a starter stair two
 *              rosettes up with nothing decked at the ground
 *   flights    from each landing line up to the other, on alternate halves
 *   adjust     'none', 'buried', 'step' or 'starter' (see above)
 *   handrails  two diagonals beside each flight on its outer side and two on
 *              the middle standards, a rosette and two above the stringer
 *   bracing    a diagonal on the long side opposite each flight, leaning the
 *              other way from it, and one up each end face every four rosettes
 *   rails      ledgers one and two rosettes above each landing, round its
 *              three outer sides; and across the half of the top landing no
 *              flight leaves from
 *   standards  at the top landing's end, two rosettes above it for its rails;
 *              at the other end only up to the last ledgers, at the landing's
 *              own height, so that nothing stands up past them with nothing on it
 */
export function planStairTower(recipe, { liftZ, showBaseCollar = true, standardLengthsFt }) {
  const T = STAIR_TOWER;
  const heightFt = Math.max(0.1, Number(recipe && recipe.heightFt) || STAIR_DEFAULTS.heightFt);
  const start = showBaseCollar ? 0 : 1;
  // The rosettes the wanted landings are on, counted up from the foot.
  const wanted = (Array.isArray(recipe && recipe.landingsFt) ? recipe.landingsFt : [])
    .map(Number).filter(h => Number.isFinite(h) && h > 0).sort((a, b) => a - b);
  const pitch = liftZ(start + 1) - liftZ(start);
  let targets;
  if (wanted.length) {
    targets = wanted.map(h => ({ wantFt: h, rise: Math.round((h - liftZ(start)) / pitch) }));
  } else {
    // One height: the rosette at or under it, one flight up at the least.
    let rise = T.flightLifts;
    while (rise < 400 && liftZ(start + rise + 1) <= heightFt + 1e-6) rise++;
    targets = [{ wantFt: heightFt, rise }];
  }
  // Flight by flight up to each wanted landing in turn. One too close above the last to reach is left out.
  let starter = false;
  const rises = [], matched = [], missed = [];
  let reached = 0;
  for (const t of targets) {
    let part = flightsForRise(t.rise - reached, reached === 0);
    // The lowest wanted landing, under one flight up and not a starter's height: one flight up it is.
    if (!part && reached === 0 && !matched.length && t === targets[0]) { t.rise = T.flightLifts; part = flightsForRise(T.flightLifts, true); }
    if (!part) { missed.push(t.wantFt); continue; }
    if (part.starter) starter = true;
    rises.push(...part.rises);
    reached = t.rise;
    matched.push({ wantFt: t.wantFt, lift: start + t.rise });
  }
  const flightCount = rises.length;
  const adjusts = { buried: rises.filter(r => r < T.flightLifts).length, step: rises.filter(r => r > T.flightLifts).length, starter };
  const kinds = ['buried', 'step', 'starter'].filter(k => adjusts[k]);
  const adjust = kinds.length === 0 ? 'none' : kinds.length === 1 ? kinds[0] : 'mixed';

  const first = start + (starter ? T.starterLifts : 0);
  const landingLifts = [first];
  for (let i = 0; i < flightCount; i++) landingLifts.push(landingLifts[i] + rises[i]);
  const topLanding = landingLifts[flightCount];
  const requiredLift = topLanding + 2;
  const segments = planStandardSegmentsForLift(requiredLift, standardLengthsFt);
  const topLift = segments.reduce((n, ft) => n + rosettesOnSegment(ft), 0);

  const halfL = T.lengthFt / 2, halfW = T.widthFt / 2, inner = halfL - T.landingFt;
  const xs = [-halfL, -inner, inner, halfL];
  const ys = [-halfW, 0, halfW];
  // The top landing is at the left-hand end after an even number of flights.
  const topEnd = flightCount % 2 === 0 ? -1 : 1;
  const standards = [];
  const stand = (x, y) => standards.push({ x, y, requiredLift: Math.sign(x) === topEnd ? requiredLift : topLanding });
  for (const y of [-halfW, halfW]) for (const x of xs) stand(x, y);
  stand(-inner, 0); stand(inner, 0);

  const ledgers = [];
  const ledger = (ax, ay, bx, by, lift) => ledgers.push({ a: { x: ax, y: ay }, b: { x: bx, y: by }, lift });
  // The frame: at the foot, and at every landing.
  const ringLifts = [...new Set([start, ...landingLifts])].sort((a, b) => a - b);
  for (const lift of ringLifts) {
    for (const y of [-halfW, halfW]) for (let i = 0; i < 3; i++) ledger(xs[i], y, xs[i + 1], y, lift);
    for (const x of [-halfL, halfL]) ledger(x, -halfW, x, halfW, lift);
    for (const x of [-inner, inner]) { ledger(x, -halfW, x, 0, lift); ledger(x, 0, x, halfW, lift); }
    ledger(-inner, 0, inner, 0, lift);
  }

  const decks = [], flights = [], braces = [];
  landingLifts.forEach((lift, i) => {
    // Landings alternate ends, the first at the left.
    const end = i % 2 === 0 ? -1 : 1;
    const [x0, x1] = end < 0 ? [-halfL, -inner] : [inner, halfL];
    decks.push({ x0, y0: -halfW, x1, y1: halfW, lift });
    // Its rails. A landing on the collar is a step off the ground and has none.
    if (lift > start) {
      for (const up of [1, 2]) {
        ledger(end * halfL, -halfW, end * halfL, halfW, lift + up);
        for (const y of [-halfW, halfW]) ledger(x0, y, x1, y, lift + up);
      }
    }
    const side = i % 2 === 0 ? -1 : 1;
    if (i === flightCount) {
      // Nothing leaves the top landing: close the half the next flight would have used.
      for (const up of [1, 2]) ledger(end * inner, 0, end * inner, side * halfW, lift + up);
      return;
    }
    // The flight up from this landing: away from its end, on the left-hand half going out and the other coming back.
    const from = end * inner, to = -end * inner;
    const buried = Math.max(0, T.flightLifts - rises[i]), raised = Math.max(0, rises[i] - T.flightLifts);
    const foot = lift - buried + raised; // the rosette its stringers hang on at the bottom
    const flight = {
      lower: [{ x: from, y: 0 }, { x: from, y: side * halfW }],
      upper: [{ x: to, y: 0 }, { x: to, y: side * halfW }],
      lift: foot, toLift: foot + T.flightLifts,
      treads: T.treadsPerFlight - buried * T.treadsPerRosette,
    };
    if (buried) {
      // Its treads start where it comes up through the landing, and the landing is carried out to there.
      flight.treadFrom = buried / T.flightLifts;
      const mid = side * halfW / 2, half = T.buriedPlankWidthFt / 2;
      decks.push({ x0: Math.min(from, to), y0: mid - half, x1: Math.max(from, to), y1: mid + half, lift });
    }
    if (raised) flight.step = true;
    // A ledger for its foot where the landing's own is not at that height.
    if (foot !== lift) ledger(from, 0, from, side * halfW, foot);
    flights.push(flight);
    for (const up of [1, 2]) {
      // The outer handrail is hung on the inside of its standards, toward the flight, as the middle one is.
      braces.push({ a: { x: from, y: side * halfW }, b: { x: to, y: side * halfW }, lift: foot + up, toLift: foot + up + T.flightLifts, normal: { x: 0, y: -side } });
      braces.push({ a: { x: from, y: 0 }, b: { x: to, y: 0 }, lift: foot + up, toLift: foot + up + T.flightLifts, normal: { x: 0, y: side } });
    }
    // And a brace on the long side the flight is not on, leaning against it: up
    // from the landing line the flight arrives at to the one it leaves from.
    braces.push({ a: { x: to, y: -side * halfW }, b: { x: from, y: -side * halfW }, lift: foot, toLift: foot + T.flightLifts, normal: { x: 0, y: -side } });
  });
  if (starter) {
    // Up to the first landing from the ground in the bay, on the half the first flight does not leave from.
    flights.unshift({
      lower: [{ x: -inner + T.starterRunFt, y: 0 }, { x: -inner + T.starterRunFt, y: halfW }],
      upper: [{ x: -inner, y: 0 }, { x: -inner, y: halfW }],
      ground: true, starter: true, lift: start, toLift: first, treads: T.starterTreads,
    });
  }
  // A diagonal up each end face, every four rosettes from the foot.
  for (let lift = start; lift + T.flightLifts <= topLanding; lift += T.flightLifts) {
    for (const end of [-1, 1]) {
      braces.push({ a: { x: end * halfL, y: -halfW }, b: { x: end * halfL, y: halfW }, lift, toLift: lift + T.flightLifts, normal: { x: end, y: 0 } });
    }
  }

  return {
    stair: true, widthFt: T.lengthFt, depthFt: T.widthFt, heightFt, xs, ys,
    segments, requiredLift, topLift, deckLifts: landingLifts, ledgerLifts: ringLifts, flightCount, adjust, adjusts,
    // The landings asked for and the rosette each is on; and any left out for being too close above the last.
    matched: matched.map(m => ({ ...m, atFt: liftZ(m.lift) })), missed,
    standards, ledgers, braces, decks, flights,
  };
}

/**
 * Where to put a block whose centre is near `center` so it joins what is
 * already standing, as ScaffoldPro's ghost does: line one of its edge
 * standards up with an existing standard within 1.25 ft, prefer the spot that
 * shares the most standards, and refuse a full overlap (a corner or one face
 * may be shared; the block may not land on top of another).
 */
export function snapBlockCenter(center, plan, rotationSteps, existing) {
  const plain = { x: center.x, y: center.y, snapped: false };
  if (!existing.length) return plain;
  const key = (x, y) => `${Math.round(x * 1000)},${Math.round(y * 1000)}`;
  const taken = new Set(existing.map(p => key(p.x, p.y)));
  const xMin = plan.xs[0], xMax = plan.xs[plan.xs.length - 1];
  const yMin = plan.ys[0], yMax = plan.ys[plan.ys.length - 1];
  const offsets = plan.standards.map(o => rotateOffset90(o, rotationSteps));
  const boundary = plan.standards
    .filter(o => o.x === xMin || o.x === xMax || o.y === yMin || o.y === yMax)
    .map(o => rotateOffset90(o, rotationSteps));
  const maxOverlap = Math.max(plan.xs.length, plan.ys.length);

  let best = null;
  for (const o of boundary) {
    const ix = center.x + o.x, iy = center.y + o.y;
    for (const p of existing) {
      const dist = Math.hypot(p.x - ix, p.y - iy);
      if (dist > BLOCK_SNAP_RADIUS_FT) continue;
      const cx = center.x + (p.x - ix), cy = center.y + (p.y - iy);
      let overlaps = 0;
      for (const q of offsets) if (taken.has(key(cx + q.x, cy + q.y))) overlaps++;
      if (overlaps <= 0 || overlaps > maxOverlap) continue;
      const score = overlaps * 1000 - dist * 10;
      if (!best || score > best.score) best = { x: cx, y: cy, score };
    }
  }
  return best ? { x: best.x, y: best.y, snapped: true } : plain;
}
