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
