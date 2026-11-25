// The stair tower: 14 x 7 ft on ten standards, a landing at each end and two
// flights side by side between them, placed by the Stair tool as a block is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { ScaffoldState } from '../src/scaffold/workspace/state.js';
import { planStairTower, STAIR_TOWER } from '../src/scaffold/workspace/planning.js';
import { deriveBom } from '../src/scaffold/workspace/bom.js';
import { CATALOG } from '../src/scaffold/workspace/catalog.js';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { Tools } = await import('../src/scaffold/workspace/tools.js');
const STD = CATALOG.standards.parts.map(p => p.lengthFt);
const planFor = (s, heightFt) => planStairTower({ heightFt }, { liftZ: l => s.liftZ(l), showBaseCollar: s.base.showBaseCollar, standardLengthsFt: STD });
function place(heightFt = 14.5, center = { x: 0, y: 0 }, rotationSteps = 0) {
  const s = new ScaffoldState({});
  const el = { addEventListener() {}, removeEventListener() {} };
  const tools = new Tools({ scene: new THREE.Scene(), renderer: { domElement: el }, invalidate() {} }, s);
  tools.tool = 'stair';
  tools.stairSettings.heightFt = heightFt;
  tools.placeBlockAt({ plan: tools._blockPlan(), center, snapped: false, rotationSteps });
  return { s, tools };
}

test('ten standards: four down each long side and one mid-width on each landing line', () => {
  const s = new ScaffoldState({});
  const plan = planFor(s, 14.5);
  const at = plan.standards.map(p => `${p.x},${p.y}`).sort();
  assert.deepEqual(at, ['-3.5,-3.5', '-3.5,0', '-3.5,3.5', '-7,-3.5', '-7,3.5', '3.5,-3.5', '3.5,0', '3.5,3.5', '7,-3.5', '7,3.5'].sort());
  assert.deepEqual([plan.widthFt, plan.depthFt], [14, 7]);
});

test('the height is the top landing: a flight for every four rosettes under it, one at least', () => {
  const s = new ScaffoldState({});
  assert.ok(Math.abs((s.liftZ(4) - s.liftZ(0)) - 6.5625) < 1e-9, 'a flight climbs 6 ft 6 3/4 in');
  assert.equal(planFor(s, 3).flightCount, 1);
  assert.equal(planFor(s, s.liftZ(4) + 0.01).flightCount, 1);
  assert.equal(planFor(s, s.liftZ(8) + 0.01).flightCount, 2);
  assert.equal(planFor(s, s.liftZ(12) + 0.01).flightCount, 3);
  const plan = planFor(s, s.liftZ(12) + 0.01);
  assert.deepEqual(plan.deckLifts, [0, 4, 8, 12]);
  assert.equal(plan.requiredLift, 14, 'standards two rosettes over the top landing');
  assert.ok(plan.topLift >= 14, 'picked to reach it');
  // Landings alternate ends, flights alternate halves and directions.
  assert.deepEqual(plan.decks.map(d => Math.sign(d.x0 + d.x1)), [-1, 1, -1, 1]);
  assert.deepEqual(plan.flights.map(f => [f.lower[0].x, f.upper[0].x, f.lower[1].y]), [[-3.5, 3.5, -3.5], [3.5, -3.5, 3.5], [-3.5, 3.5, -3.5]]);
  assert.equal(plan.flights.every(f => f.toLift - f.lift === 4 && f.treads === STAIR_TOWER.treadsPerFlight), true);
});

test('placed, it is ten legs carrying everything on the parts list', () => {
  const { s } = place();
  assert.equal(s.standards.size, 10);
  assert.equal(s.stairs.size, 2);
  assert.equal(s.plankBays().length, 3, 'a landing at the foot and one at the top of each flight');
  assert.equal(s.guardrails.size, 0, 'its rails are ledgers of its own');
  const bom = deriveBom(s);
  const stairs = bom.lineItems.filter(r => r.category === 'Stairs');
  assert.deepEqual(stairs.map(r => r.quantity).sort((a, b) => a - b), [2, 2, 18], 'two left and two right stringers, eighteen treads');
  const legs = s.takeoff().legs;
  assert.equal(legs.length, 10);
  const total = legs.reduce((sum, l) => sum + l.deadLb, 0);
  assert.ok(Math.abs(total - bom.summary.totalWeightLb) < 0.5, `legs ${total} against the parts list ${bom.summary.totalWeightLb}`);
  assert.equal(legs.every(l => l.liveLb === 0), true, 'no live load until one is placed');
  // A flight's weight goes to the four standards its two ledgers hang on.
  const f = [...s.stairs.values()][0];
  assert.equal(s.stairFlightWeightLb(f), 2 * 65 + 9 * 12);
  const before = Object.fromEntries(legs.map(l => [l.id, l.deadLb]));
  s.remove(f.id);
  const moved = s.takeoff().legs.filter(l => Math.abs(before[l.id] - l.deadLb) > 1e-6);
  assert.equal(moved.length, 4);
  for (const l of moved) assert.ok(Math.abs(before[l.id] - l.deadLb - 238 / 4) < 1e-6);
  s.undo();
  assert.equal(s.stairs.size, 2);
});

test('the landings are railed on their outer sides and open where the flights come and go', () => {
  const { s } = place();
  const z = lift => s.liftZ(lift);
  const has = (ax, ay, bx, by, lift) => [...s.ledgers.values()].some(l => Math.abs(l.a[2] - z(lift)) < 1e-6
    && ((l.a[0] === ax && l.a[1] === ay && l.b[0] === bx && l.b[1] === by) || (l.b[0] === ax && l.b[1] === ay && l.a[0] === bx && l.a[1] === by)));
  // The landing at lift 4 is at the right-hand end.
  for (const lift of [5, 6]) {
    assert.ok(has(7, -3.5, 7, 3.5, lift), 'across its end');
    assert.ok(has(3.5, -3.5, 7, -3.5, lift) && has(3.5, 3.5, 7, 3.5, lift), 'down its two sides');
    assert.equal(has(3.5, -3.5, 3.5, 0, lift) || has(3.5, 0, 3.5, 3.5, lift), false, 'nothing across the flights');
  }
  // The top landing (lift 8, left-hand end): the half no flight leaves from is closed.
  for (const lift of [9, 10]) {
    assert.ok(has(-3.5, 0, -3.5, -3.5, lift));
    assert.equal(has(-3.5, 0, -3.5, 3.5, lift), false, 'the flight arrives on the other half');
  }
  // Handrails: two diagonals beside each flight on the outside and two on the middle standards.
  assert.equal(s.braces.size, 2 * 4 + 2 * 2, 'four a flight, and one up each end face a flight');
  // A block placed beside it lays no rails round the stair's landings.
  assert.equal(s.plankBays().every(d => d.stair), true);
});

test('turned a quarter turn it stands 7 ft wide and 14 ft deep, and placing it twice adds nothing', () => {
  const { s, tools } = place(14.5, { x: 0, y: 0 }, 1);
  const xs = [...s.standards.values()].map(c => c.x), ys = [...s.standards.values()].map(c => c.y);
  assert.deepEqual([Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)], [7, 14]);
  const before = [s.standards.size, s.ledgers.size, s.braces.size, s.stairs.size, s.planks.size];
  tools.placeBlockAt({ plan: tools._blockPlan(), center: { x: 0, y: 0 }, snapped: false, rotationSteps: 1 });
  assert.deepEqual([s.standards.size, s.ledgers.size, s.braces.size, s.stairs.size, s.planks.size], before);
});
