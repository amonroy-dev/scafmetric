import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeAdjacencyScaleFt, computeLiftAxes, findNearestAlongAxis,
  getAdjacentCandidates, maxProjFor, findClosestUnoccupiedTarget,
  computeBatchPlan, chooseBayLayout, planStandardSegmentsForHeight, planBlock,
  PERP_TOL_FT, BRACE_DELTA_LIFT,
} from '../src/scaffold/workspace/planning.js';

// A 3x2 grid of standards at 7 ft spacing, all on one lift.
function grid(spacing = 7, nx = 3, ny = 2, level = 4) {
  const nodes = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      nodes.push({ x: i * spacing, y: j * spacing, z: 10, level, columnId: `S${i}-${j}` });
    }
  }
  return nodes;
}

test('adjacency scale finds the bay spacing', () => {
  assert.ok(Math.abs(computeAdjacencyScaleFt(grid(7)) - 7) < 1e-9);
  assert.ok(Math.abs(computeAdjacencyScaleFt(grid(5)) - 5) < 1e-9);
  assert.equal(computeAdjacencyScaleFt([{ x: 0, y: 0 }]), Infinity);
});

test('lift axes recover the grid directions, including a rotated grid', () => {
  const axes = computeLiftAxes(grid(7), 7);
  assert.ok(axes);
  // axisA and axisB are unit and perpendicular
  assert.ok(Math.abs(Math.hypot(axes.axisA.x, axes.axisA.y) - 1) < 1e-9);
  const dot = axes.axisA.x * axes.axisB.x + axes.axisA.y * axes.axisB.y;
  assert.ok(Math.abs(dot) < 1e-9, 'axes perpendicular');

  // rotate the whole grid 30 degrees; axes must rotate with it
  const a = Math.PI / 6, ca = Math.cos(a), sa = Math.sin(a);
  const rot = grid(7).map(n => ({ ...n, x: n.x * ca - n.y * sa, y: n.x * sa + n.y * ca }));
  const axes2 = computeLiftAxes(rot, 7);
  assert.ok(axes2);
  const ang = Math.abs(Math.atan2(axes2.axisA.y, axes2.axisA.x) % (Math.PI / 2));
  assert.ok(Math.min(ang, Math.PI / 2 - ang) > 0.3, 'axis followed the rotation');
});

test('nearest-along-axis never skips an intermediate standard', () => {
  const nodes = grid(7, 3, 1);
  const src = nodes.find(n => n.x === 0);
  const axes = { axisA: { x: 1, y: 0 }, axisB: { x: 0, y: 1 } };
  const hit = findNearestAlongAxis(src, nodes, axes.axisA, axes.axisB, 1, 100);
  assert.equal(hit.x, 7, 'picked the adjacent standard, not the one at 14');
});

test('perpendicular tolerance rejects off-axis nodes', () => {
  const src = { x: 0, y: 0, columnId: 'A' };
  const far = [{ x: 7, y: PERP_TOL_FT + 0.2, columnId: 'B' }];
  assert.equal(findNearestAlongAxis(src, far, { x: 1, y: 0 }, { x: 0, y: 1 }, 1, 100), null);
  const near = [{ x: 7, y: PERP_TOL_FT - 0.2, columnId: 'B' }];
  assert.ok(findNearestAlongAxis(src, near, { x: 1, y: 0 }, { x: 0, y: 1 }, 1, 100));
});

test('a corner standard has two adjacent candidates, an interior one has four', () => {
  const nodes = grid(7, 3, 3);
  const axes = computeLiftAxes(nodes, 7);
  const mp = maxProjFor(7);
  const corner = nodes.find(n => n.x === 0 && n.y === 0);
  const middle = nodes.find(n => n.x === 7 && n.y === 7);
  assert.equal(getAdjacentCandidates(corner, nodes, axes, mp, null).length, 2);
  assert.equal(getAdjacentCandidates(middle, nodes, axes, mp, null).length, 4);
});

test('one-click ledger target is the closest open neighbour, and skips occupied ones', () => {
  const nodes = grid(7, 3, 1);
  const src = nodes.find(n => n.x === 0);
  const t1 = findClosestUnoccupiedTarget(src, nodes, () => true);
  assert.equal(t1.x, 7);
  // once that pair is taken there is nothing else adjacent to this corner
  const t2 = findClosestUnoccupiedTarget(src, nodes, c => c.x !== 7);
  assert.equal(t2, null, 'does not skip over the occupied bay');
});

test('batch plan covers every bay once with no duplicates', () => {
  const nodes = grid(7, 3, 2); // 3x2 grid -> 4 ledgers along x, 3 along y = 7
  const plan = computeBatchPlan(nodes, null);
  assert.equal(plan.length, 7, `expected 7 ledgers, got ${plan.length}`);
  const keys = new Set(plan.map(p => [p.a.columnId, p.b.columnId].sort().join('|')));
  assert.equal(keys.size, plan.length, 'no duplicate pairs');
});

test('batch plan honours already-placed ledgers', () => {
  const nodes = grid(7, 3, 2);
  const all = computeBatchPlan(nodes, null);
  const taken = all[0];
  const plan = computeBatchPlan(nodes, (a, b) => {
    const k = [a.columnId, b.columnId].sort().join('|');
    return k !== [taken.a.columnId, taken.b.columnId].sort().join('|');
  });
  assert.equal(plan.length, all.length - 1);
});

test('bay layout prefers about 7 ft bays', () => {
  const l21 = chooseBayLayout(21);
  assert.equal(l21.bays, 3);
  assert.ok(Math.abs(l21.spacingFt - 7) < 1e-9);
  const l14 = chooseBayLayout(14);
  assert.equal(l14.bays, 2);
  // a short run stays a single bay
  assert.equal(chooseBayLayout(5).bays, 1);
  // never below the 2 ft minimum spacing
  for (const total of [3, 9, 17, 33, 48]) {
    const l = chooseBayLayout(total);
    assert.ok(l.spacingFt >= 2 - 1e-9, `${total} -> ${l.spacingFt}`);
    assert.ok(Math.abs(l.bays * l.spacingFt - total) < 1e-9, 'bays cover the run exactly');
  }
});

test('standard stacking fits within the target height, largest first', () => {
  const lengths = [9.84375, 6.5625, 4.921875, 3.28125, 1.640625];
  const segs = planStandardSegmentsForHeight(20, lengths);
  const total = segs.reduce((a, b) => a + b, 0);
  assert.ok(total <= 20 + 1e-9, `overshot: ${total}`);
  assert.ok(total > 16, `too short: ${total}`);
  for (let i = 1; i < segs.length; i++) assert.ok(segs[i] <= segs[i - 1], 'largest first');
  // target shorter than the smallest part still returns something placeable
  assert.equal(planStandardSegmentsForHeight(0.5, lengths).length, 1);
});

test('planBlock lays out a grid with ledgers, bracing and a deck', () => {
  const plan = planBlock({
    x0: 0, y0: 0, x1: 21, y1: 14, heightFt: 20,
    standardLengthsFt: [9.84375, 6.5625, 4.921875, 3.28125, 1.640625],
    ledgerLengthsFt: [10, 8, 7, 6, 5, 4, 3.5, 3, 2],
    maxLevel: 8,
  });
  assert.equal(plan.layoutX.bays, 3);
  assert.equal(plan.layoutY.bays, 2);
  assert.equal(plan.standards.length, 4 * 3, '4 x-lines by 3 y-lines');
  assert.ok(plan.ledgers.length > 0);
  assert.ok(plan.braces.length > 0);
  assert.equal(plan.decks.length, 1);
  // every brace rises exactly BRACE_DELTA_LIFT levels
  for (const b of plan.braces) assert.equal(b.toLevel - b.level, BRACE_DELTA_LIFT);
  // a degenerate rect produces nothing
  assert.equal(planBlock({ x0: 0, y0: 0, x1: 0.1, y1: 0.1, heightFt: 10, standardLengthsFt: [6.5], ledgerLengthsFt: [7] }), null);
});
