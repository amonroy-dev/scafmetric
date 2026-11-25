// The outline of a scaffold traced along its ledgers (traceFraming), which is
// what the Brace tool's SHIFT fill and the Ledger tool's Perimeter handrails
// take for "the outside". The case that broke the older test (four standards
// closing a square): blocks of different bay sizes clicked together, where a
// bay has a fifth standard part-way along one side.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { ScaffoldState } from '../src/scaffold/workspace/state.js';
import { traceFraming } from '../src/scaffold/workspace/braces.js';
import { BLOCK_DEFAULTS } from '../src/scaffold/workspace/planning.js';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { Tools } = await import('../src/scaffold/workspace/tools.js');

/**
 * Three blocks as one scaffold: a 21 x 3 ft run, a 3 x 7 ft link standing up
 * off its right-hand end, and a 14 x 3 ft run off the top of the link.
 *
 *            21        35
 *        10   +----+----+
 *         7   +-+--+----+      (24,7) is part-way along the upper run's front
 *             | |
 *   3 +---+---+ |              (21,3) is part-way along the link's left side
 *   0 +---+---+-+
 *     0       21 24
 */
function chain() {
  const s = new ScaffoldState({});
  const el = { addEventListener() {}, removeEventListener() {} };
  const tools = new Tools({ scene: new THREE.Scene(), renderer: { domElement: el }, invalidate() {} }, s);
  const block = (w, d, cx, cy) => {
    tools.blockSettings = { ...BLOCK_DEFAULTS, widthFt: w, depthFt: d, heightFt: 10, guardrails: false };
    tools.placeBlockAt({ plan: tools._blockPlan(), center: { x: cx, y: cy }, snapped: false, rotationSteps: 0 });
  };
  block(21, 3, 10.5, 1.5);
  block(3, 7, 22.5, 3.5);
  block(14, 3, 28, 8.5);
  return { s, tools };
}
const side = (ax, ay, bx, by) => [[ax, ay], [bx, by]].sort((p, q) => p[0] - q[0] || p[1] - q[1]).map(p => p.join(',')).join(' to ');
const OUTLINE = [
  side(0, 0, 7, 0), side(7, 0, 14, 0), side(14, 0, 21, 0), side(21, 0, 24, 0), side(24, 0, 24, 7),
  side(24, 7, 28, 7), side(28, 7, 35, 7), side(35, 7, 35, 10), side(28, 10, 35, 10), side(21, 10, 28, 10),
  side(21, 7, 21, 10), side(21, 3, 21, 7), side(14, 3, 21, 3), side(7, 3, 14, 3), side(0, 3, 7, 3), side(0, 0, 0, 3),
].sort();
const INSIDE = [side(7, 0, 7, 3), side(14, 0, 14, 3), side(21, 0, 21, 3), side(21, 7, 24, 7), side(28, 7, 28, 10)].sort();

test('the outline is traced along the ledgers, cut at every standard on them', () => {
  const { s, tools } = chain();
  const traced = traceFraming(tools._legs(), [...s.ledgers.values()]);
  const names = want => traced.faces.filter(f => f.outside === want).map(f => side(f.ax, f.ay, f.bx, f.by)).sort();
  assert.deepEqual(names(true), OUTLINE);
  assert.deepEqual(names(false), INSIDE);
  assert.equal(traced.framed.size, 16);
  // Every outside face is turned to face out: a step along its normal leaves the scaffold.
  const within = (x, y) => (x > 0 && x < 21 && y > 0 && y < 3) || (x > 21 && x < 24 && y > 0 && y < 7) || (x > 21 && x < 35 && y > 7 && y < 10)
    || (x === 21 && y > 0 && y < 3) || (y === 7 && x > 21 && x < 24);
  for (const f of traced.faces.filter(f => f.outside)) {
    const mx = (f.ax + f.bx) / 2, my = (f.ay + f.by) / 2;
    assert.equal(within(mx + f.normX * 0.5, my + f.normY * 0.5), false, `${side(f.ax, f.ay, f.bx, f.by)} faces in`);
    assert.equal(within(mx - f.normX * 0.5, my - f.normY * 0.5), true, `${side(f.ax, f.ay, f.bx, f.by)} has no bay behind it`);
  }
});

test('a SHIFT brace fill takes every side of the outline and none inside it', () => {
  const { s, tools } = chain();
  const plan = tools._perimeterBracePlan(s.liftZ(2));
  // A brace is set a little outside its face: back on the face, it names the side.
  const r = v => Math.round(v);
  const braced = plan.map(b => side(r(b.a[0]), r(b.a[1]), r(b.b[0]), r(b.b[1]))).sort();
  assert.deepEqual(braced, OUTLINE);
  // And each stands off its face on the outside of it.
  for (const b of plan) {
    const off = [b.a[0] - r(b.a[0]), b.a[1] - r(b.a[1])];
    assert.ok(Math.hypot(...off) > 0.1, 'set off the face');
  }
});

test('Perimeter handrails round the same scaffold: sixteen, and none down the middle of a deck', () => {
  const { s, tools } = chain();
  tools.setPerimeterHandrails(true);
  const from = s.nodes().find(n => n.x === 0 && n.y === 0 && n.level === 5);
  const plan = tools._ledgerFillPlan(from).map(e => side(e.a.x, e.a.y, e.b.x, e.b.y)).sort();
  assert.deepEqual(plan, OUTLINE);
});

test('a loop of ledgers too big to be a bay is a court, and its faces are outside', () => {
  // Four standards 20 ft apart joined by trusses: 400 sq ft inside.
  const cols = [[0, 0], [20, 0], [20, 20], [0, 20]].map(([x, y], i) => ({ id: `c${i}`, x, y }));
  const ring = cols.map((c, i) => ({ a: [c.x, c.y], b: [cols[(i + 1) % 4].x, cols[(i + 1) % 4].y] }));
  assert.equal(traceFraming(cols, ring).faces.filter(f => f.outside).length, 4);
  // A lone ledger, and one hanging off a bay, have open ground on both hands.
  const bay = [[0, 0], [7, 0], [7, 3], [0, 3], [14, 0]].map(([x, y], i) => ({ id: `d${i}`, x, y }));
  const m = (i, j) => ({ a: [bay[i].x, bay[i].y], b: [bay[j].x, bay[j].y] });
  const traced = traceFraming(bay, [m(0, 1), m(1, 2), m(2, 3), m(3, 0), m(1, 4)]);
  assert.equal(traced.faces.length, 5);
  assert.equal(traced.faces.every(f => f.outside), true);
  assert.equal(traceFraming(bay, []).faces.length, 0, 'no ledgers, nothing traced');
});
