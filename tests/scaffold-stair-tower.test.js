// The stair tower: 14 x 7 ft on ten standards, a landing at each end and two
// flights side by side between them, placed by the Stair tool as a block is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { ScaffoldState } from '../src/scaffold/workspace/state.js';
import { planStairTower, STAIR_TOWER, flightsForRise } from '../src/scaffold/workspace/planning.js';
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
  const flightLb = 2 * STAIR_TOWER.stringerLb + 9 * STAIR_TOWER.treadLb;
  assert.equal(s.stairFlightWeightLb(f), flightLb);
  const before = Object.fromEntries(legs.map(l => [l.id, l.deadLb]));
  s.remove(f.id);
  const moved = s.takeoff().legs.filter(l => Math.abs(before[l.id] - l.deadLb) > 1e-6);
  assert.equal(moved.length, 4);
  for (const l of moved) assert.ok(Math.abs(before[l.id] - l.deadLb - flightLb / 4) < 1e-6);
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
  assert.equal(s.braces.size, 2 * 4 + 2 * 2 + 2, 'four handrails a flight, one up each end face a flight, and one on the side opposite each flight');
  // A block placed beside it lays no rails round the stair's landings.
  assert.equal(s.plankBays().every(d => d.stair), true);
});

test('the standards stop where they are needed: rail height at the top landing, the last ledgers at the other end', () => {
  for (const [heightFt, topEnd] of [[14.5, -1], [8, 1]]) { // two flights end at the left, one at the right
    const { s } = place(heightFt);
    const flights = s.stairs.size;
    const topLanding = flights * 4;
    for (const c of s.standards.values()) {
      const top = s.standardLifts(c);
      if (Math.sign(c.x) === topEnd) assert.ok(top >= topLanding + 2 && top <= topLanding + 3, `at the top landing a standard reaches its rails: lift ${top}`);
      else assert.equal(top, topLanding, 'at the other end it stops at the last ledgers, with nothing standing up past them');
    }
    // Every ledger and brace still ends on a rosette its standard has.
    const tops = new Map([...s.standards.values()].map(c => [`${c.x},${c.y}`, s.standardTopZ(c)]));
    const near = p => { let best = null; for (const c of s.standards.values()) { const d = Math.hypot(c.x - p[0], c.y - p[1]); if (!best || d < best.d) best = { d, c }; } return best.c; };
    for (const m of [...s.ledgers.values(), ...s.braces.values()]) for (const p of [m.a, m.b]) {
      const c = near(p);
      assert.ok(p[2] <= tops.get(`${c.x},${c.y}`) + 1e-6, `a member at ${p[2].toFixed(2)} ft is above the top of its standard`);
    }
  }
});

test('handrails hang inside the tower, and treads stop at the inside faces of the stringers', async () => {
  const { s } = place();
  // Every handrail diagonal is set off its face toward the flight it guards: none is outside the 7 ft width.
  const along = [...s.braces.values()].filter(b => Math.abs(b.a[1] - b.b[1]) < 1e-6);
  const rails = along.filter(b => Math.abs(b.a[1]) < 3.5);
  assert.equal(rails.length, 8);
  // The other two along the long sides are the braces opposite the flights: outside their face, on the
  // side the flight is not on, from landing height to landing height, leaning the other way from the flight.
  const opposite = along.filter(b => Math.abs(b.a[1]) > 3.5);
  assert.equal(opposite.length, 2);
  for (const f of s.stairs.values()) {
    const flightSide = Math.sign(f.lower[1][1]);
    const b = opposite.find(o => Math.abs(Math.min(o.a[2], o.b[2]) - f.z0) < 1e-6);
    assert.ok(b, 'one for this flight');
    assert.equal(Math.sign(b.a[1]), -flightSide, 'on the long side the flight is not on');
    assert.ok(Math.abs(Math.max(b.a[2], b.b[2]) - f.z1) < 1e-6);
    const [lowEnd, highEnd] = b.a[2] < b.b[2] ? [b.a, b.b] : [b.b, b.a];
    assert.ok(Math.abs(lowEnd[0] - f.upper[0][0]) < 1e-6 && Math.abs(highEnd[0] - f.lower[0][0]) < 1e-6, 'low where the flight is high, high where it is low');
  }
  for (const b of rails) assert.ok(Math.abs(b.a[1]) < 3.5, `a handrail at y = ${b.a[1]} is outside the tower`);
  const { buildStairFlight, stairStringerLines, STRINGER_WIDTH_IN } = await import('../src/scaffold/workspace/parts.js');
  const f = [...s.stairs.values()][0];
  const meshes = buildStairFlight(f, null);
  const [l0, l1] = stairStringerLines(f);
  const inner = [Math.min(l0[0][1], l1[0][1]) + STRINGER_WIDTH_IN / 24, Math.max(l0[0][1], l1[0][1]) - STRINGER_WIDTH_IN / 24];
  const treads = meshes.slice(2);
  assert.equal(treads.length, 9);
  for (const t of treads) {
    const lo = t.position.y - t.scale.y / 2, hi = t.position.y + t.scale.y / 2;
    assert.ok(lo >= inner[0] - 1e-6 && hi <= inner[1] + 1e-6, `a tread from ${lo} to ${hi} runs past a stringer (${inner})`);
    assert.ok(Math.abs(lo - inner[0]) < 1e-6 && Math.abs(hi - inner[1]) < 1e-6, 'and it reaches both');
  }
});

// --- landing at a height that is not a whole number of flights ------------------

/** A tower whose top landing is `rosettes` above its foot. */
function towerOf(rosettes) {
  const probe = new ScaffoldState({});
  return place(probe.liftZ(rosettes) + 0.01);
}

test('a flight is four rosettes: one short buries the top flight, one over adds a step, two over a starter stair', () => {
  const s = new ScaffoldState({});
  const at = n => planFor(s, s.liftZ(n) + 0.01);
  const said = n => { const p = at(n); return [p.flightCount, p.adjust, p.deckLifts[p.deckLifts.length - 1]]; };
  assert.deepEqual(said(8), [2, 'none', 8]);
  assert.deepEqual(said(11), [3, 'buried', 11], 'three flights, the top landing a rosette under twelve');
  assert.deepEqual(said(13), [3, 'step', 13]);
  assert.deepEqual(said(15), [4, 'buried', 15]);
  assert.deepEqual(said(18), [4, 'starter', 18]);
  // Every height from one flight up is reached, to the rosette.
  for (let n = 4; n <= 40; n++) assert.equal(said(n)[2], n, `${n} rosettes`);
  // Just under a rosette is the rosette below.
  assert.equal(planFor(s, s.liftZ(11) - 0.01).deckLifts.at(-1), 10);
  // Its landings: every flight four apart but the adjusted one.
  assert.deepEqual(at(11).deckLifts.slice(0, 4), [0, 4, 8, 11]);
  assert.deepEqual(at(13).deckLifts.slice(0, 4), [0, 4, 8, 13]);
  assert.deepEqual(at(18).deckLifts.slice(0, 5), [2, 6, 10, 14, 18], 'the starter lands two rosettes up and the flights go on from there');
});

test('a buried flight hangs a rosette under its landing, loses its lowest treads, and has three planks under it', () => {
  const { s } = towerOf(11);
  const flights = [...s.stairs.values()].sort((a, b) => a.z0 - b.z0);
  assert.equal(flights.length, 3);
  const top = flights[2];
  assert.ok(Math.abs(top.z0 - s.liftZ(7)) < 1e-9, 'its foot is on the rosette under the landing at eight');
  assert.ok(Math.abs(top.z1 - s.liftZ(11)) < 1e-9, 'and it still climbs four');
  assert.equal(top.treads, 6, 'three treads short');
  assert.equal(top.treadFrom, 0.25, 'its treads start where it comes up through the landing');
  assert.deepEqual(flights.slice(0, 2).map(f => [f.treads, f.treadFrom]), [[9, undefined], [9, undefined]]);
  // A ledger for its foot, on its own half of the landing line.
  const footLedgers = [...s.ledgers.values()].filter(l => Math.abs(l.a[2] - s.liftZ(7)) < 1e-9);
  assert.equal(footLedgers.length, 1);
  assert.ok(Math.abs(Math.hypot(footLedgers[0].b[0] - footLedgers[0].a[0], footLedgers[0].b[1] - footLedgers[0].a[1]) - 3.5) < 1e-9);
  // Three 9 in planks the length of the bay at the landing's height, between its stringers.
  const under = s.plankBays().filter(d => Math.abs(d.z - s.liftZ(8)) < 1e-9 && Math.abs((d.x1 - d.x0) - 7) < 1e-9);
  assert.equal(under.length, 1);
  assert.equal(under[0].boards.length, 3);
  assert.ok(Math.abs((under[0].y1 - under[0].y0) - 2.25) < 1e-9);
  const ys = top.lower.map(p => p[1]).sort((a, b) => a - b);
  assert.ok(under[0].y0 > ys[0] && under[0].y1 < ys[1], 'inside the flight\'s own half');
  // Nothing is lost between the parts list and the legs.
  const total = s.takeoff().legs.reduce((sum, l) => sum + l.deadLb, 0);
  assert.ok(Math.abs(total - deriveBom(s).summary.totalWeightLb) < 0.5);
  assert.equal(deriveBom(s).lineItems.find(r => r.description.startsWith('Stair tread')).quantity, 24);
});

test('a flight hung a rosette high has a step under it: one short plank on two clamp-on brackets', () => {
  const { s } = towerOf(13);
  const flights = [...s.stairs.values()].sort((a, b) => a.z0 - b.z0);
  const top = flights[2];
  assert.equal(top.step, true);
  assert.ok(Math.abs(top.z0 - s.liftZ(9)) < 1e-9 && Math.abs(top.z1 - s.liftZ(13)) < 1e-9, 'from a rosette over the landing at eight');
  assert.equal(top.treads, 9);
  const stairs = deriveBom(s).lineItems.filter(r => r.category === 'Stairs');
  assert.equal(stairs.find(r => /Clamp-on board bracket/.test(r.description)).quantity, 2);
  assert.equal(stairs.find(r => /Step plank/.test(r.description)).quantity, 1);
  assert.equal(s.stairFlightWeightLb(top), 2 * STAIR_TOWER.stringerLb + 9 * STAIR_TOWER.treadLb + 2 * STAIR_TOWER.stepBracketLb + STAIR_TOWER.stepPlankLb);
  const total = s.takeoff().legs.reduce((sum, l) => sum + l.deadLb, 0);
  assert.ok(Math.abs(total - deriveBom(s).summary.totalWeightLb) < 0.5);
});

test('a starter stair comes off the ground to a first landing two rosettes up, and half of it is on the ground', () => {
  const { s } = towerOf(18);
  const flights = [...s.stairs.values()].sort((a, b) => a.z0 - b.z0);
  assert.equal(flights.length, 5);
  const starter = flights[0];
  assert.deepEqual([starter.starter, starter.z0, starter.treads], [true, 0, 4]);
  assert.ok(Math.abs(starter.z1 - s.liftZ(2)) < 1e-9);
  assert.ok(Math.abs(Math.abs(starter.upper[0][0] - starter.lower[0][0]) - 3.5) < 1e-9, 'half the bay long');
  // Nothing is decked at the ground: the lowest deck is the first landing.
  assert.ok(Math.abs(Math.min(...s.plankBays().map(d => d.z)) - s.liftZ(2)) < 1e-9);
  // The flights above it are on alternate halves, the first on the half the starter is not.
  assert.notEqual(Math.sign(flights[1].lower[1][1]), Math.sign(starter.lower[1][1]));
  const stairs = deriveBom(s).lineItems.filter(r => r.category === 'Stairs');
  assert.equal(stairs.filter(r => /Starter stair stringer/.test(r.description)).length, 2);
  assert.equal(stairs.find(r => /Starter stair handrail/.test(r.description)).quantity, 2);
  assert.equal(stairs.find(r => r.description.startsWith('Stair tread')).quantity, 4 * 9 + 4);
  // Its foot is on the ground, so the legs carry all but half of it.
  const legs = s.takeoff().legs.reduce((sum, l) => sum + l.deadLb, 0);
  assert.ok(Math.abs(deriveBom(s).summary.totalWeightLb - legs - s.stairFlightWeightLb(starter) / 2) < 0.5);
  // No part is named by a maker's number.
  for (const r of deriveBom(s).lineItems) assert.equal(/\bU[A-Z]{1,4}\d/.test(r.description), false, r.description);
});

test('between two landings: whole flights, with a buried one or a step where the distance is not a whole number of them', () => {
  const sum = part => part.rises.reduce((a, b) => a + b, 0) + (part.starter ? 2 : 0);
  // From the foot of the tower.
  assert.deepEqual(flightsForRise(8, true), { starter: false, rises: [4, 4] });
  assert.deepEqual(flightsForRise(9, true), { starter: false, rises: [4, 5] });
  assert.deepEqual(flightsForRise(10, true), { starter: true, rises: [4, 4] });
  assert.deepEqual(flightsForRise(11, true), { starter: false, rises: [4, 4, 3] });
  assert.deepEqual(flightsForRise(2, true), { starter: true, rises: [] }, 'a starter stair alone');
  assert.equal(flightsForRise(3, true), null, 'the lowest flight cannot be buried');
  // Between two landings higher up: no starter, and three rosettes is one buried flight.
  assert.deepEqual(flightsForRise(3), { starter: false, rises: [3] });
  assert.deepEqual(flightsForRise(5), { starter: false, rises: [5] });
  assert.deepEqual(flightsForRise(6), { starter: false, rises: [3, 3] });
  assert.deepEqual(flightsForRise(10), { starter: false, rises: [4, 3, 3] });
  assert.equal(flightsForRise(2), null, 'too close to put a flight between');
  for (let gap = 3; gap <= 40; gap++) assert.equal(sum(flightsForRise(gap)), gap, `${gap} rosettes`);
  for (let gap = 4; gap <= 40; gap++) assert.equal(sum(flightsForRise(gap, true)), gap, `${gap} rosettes from the foot`);
});

test('given several heights the tower has a landing within a foot of each', () => {
  const s = new ScaffoldState({});
  const plan = planStairTower({ landingsFt: [45, 25, 36] }, { liftZ: l => s.liftZ(l), showBaseCollar: true, standardLengthsFt: STD });
  assert.deepEqual(plan.matched.map(m => m.wantFt), [25, 36, 45], 'taken from the bottom up, whatever order they were typed in');
  for (const m of plan.matched) {
    assert.ok(Math.abs(m.atFt - m.wantFt) <= 1, `${m.wantFt} ft is landed on at ${m.atFt.toFixed(2)} ft`);
    assert.ok(plan.deckLifts.includes(m.lift), 'and it is one of the tower\'s landings');
  }
  assert.deepEqual(plan.missed, []);
  assert.equal(plan.deckLifts.at(-1), plan.matched.at(-1).lift, 'the highest is the top');
  // Every flight is a whole one, one buried a rosette, or one with a step.
  const gaps = plan.deckLifts.slice(1).map((l, i) => l - plan.deckLifts[i]);
  assert.ok(gaps.every(g => g >= 3 && g <= 5));
  assert.equal(plan.flights.length, gaps.length);
  assert.equal(plan.adjusts.buried, gaps.filter(g => g === 3).length);
  // Placed, it is one tower with nothing lost between the parts list and the legs.
  const { s: placed, tools } = place(14.5);
  placed.clear();
  tools.stairSettings.landingsFt = [25, 36, 45];
  tools.placeBlockAt({ plan: tools._blockPlan(), center: { x: 0, y: 0 }, snapped: false, rotationSteps: 0 });
  assert.equal(placed.standards.size, 10);
  assert.equal(placed.stairs.size, plan.flights.length);
  const legs = placed.takeoff().legs.reduce((sum, l) => sum + l.deadLb, 0);
  assert.ok(Math.abs(legs - deriveBom(placed).summary.totalWeightLb) < 0.5);
  // Two heights too close to put a flight between: the upper one is left out and said so.
  const close = planStairTower({ landingsFt: [20, 22] }, { liftZ: l => s.liftZ(l), showBaseCollar: true, standardLengthsFt: STD });
  assert.deepEqual([close.matched.map(m => m.wantFt), close.missed], [[20], [22]]);
});

test('the height can be made up one chosen way: buried one or two rosettes, a step, or a starter', () => {
  const s = new ScaffoldState({});
  const at = (n, prefer) => { const p = planStairTower({ heightFt: s.liftZ(n) + 0.01, prefer }, { liftZ: l => s.liftZ(l), showBaseCollar: true, standardLengthsFt: STD }); return [p.deckLifts.at(-1), p.adjusts]; };
  // Ten rosettes: a starter and two flights by default; buried, three flights with the top one two rosettes down.
  assert.deepEqual(at(10, 'auto'), [10, { buried: 0, buriedTwo: 0, step: 0, starter: true }]);
  assert.deepEqual(at(10, 'bury'), [10, { buried: 0, buriedTwo: 1, step: 0, starter: false }]);
  assert.deepEqual(at(11, 'bury'), [11, { buried: 1, buriedTwo: 0, step: 0, starter: false }]);
  // A flight is never buried three, so nine rosettes cannot be made by burying:
  // it lands on the nearest it can make, ten, with the top flight two rosettes down.
  assert.deepEqual(at(9, 'bury'), [10, { buried: 0, buriedTwo: 1, step: 0, starter: false }]);
  // A step makes one over and a starter two over; asked for a height each cannot
  // make, each lands on the nearest it can, over or under.
  assert.deepEqual(at(9, 'step')[0], 9);
  assert.deepEqual(at(11, 'step')[0], 12);
  assert.deepEqual(at(10, 'starter')[0], 10);
  assert.deepEqual(at(11, 'starter')[0], 12);
  assert.deepEqual(at(7, 'step')[0], 8);
  assert.equal(flightsForRise(6, true, 'bury').rises.join(), '4,2');
  assert.equal(flightsForRise(2, true, 'bury'), null, 'the lowest flight is never the buried one');
  assert.equal(flightsForRise(5, false, 'bury'), null);

  // Buried two: three treads, half-way up before they start, and its foot two rosettes under the landing.
  const { s: placed, tools } = place(14.5);
  placed.clear();
  tools.stairSettings = { heightFt: placed.liftZ(10) + 0.01, prefer: 'bury' };
  tools.placeBlockAt({ plan: tools._blockPlan(), center: { x: 0, y: 0 }, snapped: false, rotationSteps: 0 });
  const top = [...placed.stairs.values()].sort((a, b) => a.z0 - b.z0).at(-1);
  assert.deepEqual([top.treads, top.treadFrom], [3, 0.5]);
  assert.ok(Math.abs(top.z0 - placed.liftZ(6)) < 1e-9 && Math.abs(top.z1 - placed.liftZ(10)) < 1e-9);
  const legs = placed.takeoff().legs.reduce((sum, l) => sum + l.deadLb, 0);
  assert.ok(Math.abs(legs - deriveBom(placed).summary.totalWeightLb) < 0.5);
});

test('turned a quarter turn it stands 7 ft wide and 14 ft deep, and placing it twice adds nothing', () => {
  const { s, tools } = place(14.5, { x: 0, y: 0 }, 1);
  const xs = [...s.standards.values()].map(c => c.x), ys = [...s.standards.values()].map(c => c.y);
  assert.deepEqual([Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)], [7, 14]);
  const before = [s.standards.size, s.ledgers.size, s.braces.size, s.stairs.size, s.planks.size];
  tools.placeBlockAt({ plan: tools._blockPlan(), center: { x: 0, y: 0 }, snapped: false, rotationSteps: 1 });
  assert.deepEqual([s.standards.size, s.ledgers.size, s.braces.size, s.stairs.size, s.planks.size], before);
});

test('a box drawn round the tower takes its flights, and a stringer is a 6 x 2 tube on edge', async () => {
  const { s, tools } = place();
  const { stairStringerLines, rectTubeBetween, STRINGER_DEPTH_IN, STRINGER_WIDTH_IN } = await import('../src/scaffold/workspace/parts.js');
  const parts = tools._marqueeParts();
  for (const f of s.stairs.values()) {
    const mine = parts.segments.filter(seg => seg.id === f.id);
    assert.equal(mine.length, 2, 'both stringers stand for the flight');
    assert.deepEqual(mine.map(seg => [seg.a[2], seg.b[2]]), [[f.z0, f.z1], [f.z0, f.z1]]);
  }
  const f = [...s.stairs.values()][0];
  const [[a, b]] = stairStringerLines(f);
  assert.ok(Math.abs(Math.abs(a[1] - f.lower[0][1]) - 0.25) < 1e-9, 'a little in from the standards');
  const m = rectTubeBetween(a, b, STRINGER_DEPTH_IN, STRINGER_WIDTH_IN, null);
  assert.deepEqual([STRINGER_DEPTH_IN, STRINGER_WIDTH_IN], [6, 2]);
  assert.ok(Math.abs(m.scale.x - Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])) < 1e-9, 'as long as the flight');
  assert.ok(Math.abs(m.scale.y - 2 / 12) < 1e-9 && Math.abs(m.scale.z - 6 / 12) < 1e-9);
  // On edge: its width lies level.
  const across = new (await import('three')).Vector3(0, 1, 0).applyQuaternion(m.quaternion);
  assert.ok(Math.abs(across.z) < 1e-9);
});
