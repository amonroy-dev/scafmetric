// Scaffold planning algorithms, ported from the ScaffoldPro / Scaffxiq_v2
// scaffold side. Pure math — no three.js, no DOM — so it is unit-testable.
//
//  - adjacency scale + principal lift axes (handles rotated / irregular grids)
//  - nearest-neighbour targeting that never skips an intermediate standard
//  - one-click ledger targeting and the shift batch plan
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

/**
 * Plan a whole scaffold block over a ground rectangle: standard grid, segment
 * stacks, ledger runs at each lift, perimeter bracing and a top deck.
 * Returns plain data; the caller turns it into state mutations.
 */
export function planBlock(opts) {
  const {
    x0, y0, x1, y1, heightFt,
    standardLengthsFt, ledgerLengthsFt,
    ledgerEveryNLevels = BRACE_DELTA_LIFT,
    maxLevel = Infinity,
    // The lowest lift: 0 is the base collar's rosette, 1 the standard's first.
    startLevel = 1,
    brace = true,
    deck = true,
  } = opts;

  const minX = Math.min(x0, x1), maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1), maxY = Math.max(y0, y1);
  const widthFt = maxX - minX, depthFt = maxY - minY;
  if (widthFt < 0.5 || depthFt < 0.5) return null;

  const layoutX = chooseBayLayout(widthFt, ledgerLengthsFt);
  const layoutY = chooseBayLayout(depthFt, ledgerLengthsFt);
  const segments = planStandardSegmentsForHeight(heightFt, standardLengthsFt);

  const xs = Array.from({ length: layoutX.bays + 1 }, (_, i) => minX + i * layoutX.spacingFt);
  const ys = Array.from({ length: layoutY.bays + 1 }, (_, i) => minY + i * layoutY.spacingFt);

  const standards = [];
  for (const y of ys) for (const x of xs) standards.push({ x, y, segments: segments.slice() });

  // Ledger lifts as ScaffoldPro lays them: from the lowest rosette (the base
  // collar's when there is one), then every N up.
  const levels = [];
  for (let lv = startLevel; lv <= maxLevel; lv += ledgerEveryNLevels) levels.push(lv);

  const ledgers = [];
  for (const level of levels) {
    for (let j = 0; j < ys.length; j++) {
      for (let i = 0; i < xs.length - 1; i++) {
        ledgers.push({ a: { x: xs[i], y: ys[j] }, b: { x: xs[i + 1], y: ys[j] }, level });
      }
    }
    for (let i = 0; i < xs.length; i++) {
      for (let j = 0; j < ys.length - 1; j++) {
        ledgers.push({ a: { x: xs[i], y: ys[j] }, b: { x: xs[i], y: ys[j + 1] }, level });
      }
    }
  }

  // Perimeter bracing: one diagonal per perimeter bay per lift.
  const braces = [];
  if (brace) {
    // Between consecutive ledger lifts, so each diagonal lands on a ledgered rosette.
    for (let lv = startLevel; lv + ledgerEveryNLevels <= maxLevel; lv += ledgerEveryNLevels) {
      for (let i = 0; i < xs.length - 1; i++) {
        for (const y of [ys[0], ys[ys.length - 1]]) {
          if (ys.length === 1 && y !== ys[0]) continue;
          braces.push({ a: { x: xs[i], y }, b: { x: xs[i + 1], y }, level: lv, toLevel: lv + ledgerEveryNLevels });
        }
      }
      for (let j = 0; j < ys.length - 1; j++) {
        for (const x of [xs[0], xs[xs.length - 1]]) {
          if (xs.length === 1 && x !== xs[0]) continue;
          braces.push({ a: { x, y: ys[j] }, b: { x, y: ys[j + 1] }, level: lv, toLevel: lv + ledgerEveryNLevels });
        }
      }
    }
  }

  const decks = [];
  if (deck && levels.length) {
    const topLevel = levels[levels.length - 1];
    decks.push({ x0: minX, y0: minY, x1: maxX, y1: maxY, level: topLevel });
  }

  return { xs, ys, layoutX, layoutY, segments, standards, ledgers, braces, decks, levels };
}
