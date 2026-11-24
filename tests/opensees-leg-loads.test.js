// The builder's leg loads, checked against OpenSees.
//
// verification/opensees builds each scaffold in cases.mjs as a structural model
// (standards, pin-ended ledgers, every plank a simply supported strip) and has
// OpenSees solve it. The vertical reaction at each base is stored in
// verification/opensees/reference. This test rebuilds the same scaffolds and
// holds the builder's leg loads to those reactions, so the comparison runs on
// every test run without needing Python. To refresh the reference after a
// deliberate change: node verification/opensees/run.mjs --save
//
// A scaffold with side brackets that have a leg behind them is held to the
// "levered" solution, in which the frame under each bracket holds its
// overturning as a pair of forces; every other scaffold to "pinned".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CASES, beamUnderLegs } from '../verification/opensees/cases.mjs';
import { deriveBom } from '../src/scaffold/workspace/bom.js';
import { ScaffoldState } from '../src/scaffold/workspace/state.js';
import { tubeWeightPerFoot } from '../src/scaffold/catalog.js';

const reference = name => JSON.parse(readFileSync(new URL(`../verification/opensees/reference/${name}.json`, import.meta.url), 'utf8'));
// A hundredth of a pound: the reference is a solved stiffness matrix, not a formula.
const LB = 0.02;
const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: builder ${a}, expected ${b}`);

for (const name of Object.keys(CASES)) {
  test(`${name}: every leg matches OpenSees, dead and live`, () => {
    const state = CASES[name]();
    const ref = reference(name);
    const pinned = ref.variants.levered ?? ref.variants.pinned;
    const { legs, totals } = state.takeoff();

    assert.deepEqual(legs.map(l => l.id).sort(), ref.legs.map(l => l.id).sort(), 'the same legs');
    for (const leg of legs) {
      close(leg.deadLb, pinned.dead[leg.id], LB, `dead load on ${leg.id} at ${leg.x}, ${leg.y}`);
      close(leg.liveLb, pinned.live[leg.id], LB, `live load on ${leg.id} at ${leg.x}, ${leg.y}`);
    }
    // Nothing lost and nothing invented on the way down.
    close(totals.deadLb, ref.totals.deadLb, LB, 'total dead load');
    close(totals.liveLb, ref.totals.liveLb, LB, 'total live load');
  });

  test(`${name}: the legs carry every pound in the parts list`, () => {
    const state = CASES[name]();
    const bom = deriveBom(state);
    // The parts list rounds each line to a hundredth of a pound.
    close(state.takeoff().totals.deadLb, bom.summary.totalWeightLb, 0.01 * bom.lineItems.length + 0.01, 'leg dead total against the parts list');
  });
}

test('the beam under a row of legs: reactions, moment and deflection match OpenSees', () => {
  const ref = reference('beam-under-front-legs');
  const { input, analysis } = beamUnderLegs(CASES['three-bay-run-braced']());
  assert.deepEqual(input.pointLoads.map(p => p.locationFt), ref.input.pointLoads.map(p => p.locationFt), 'the legs stand where they did');
  close(analysis.reactions.leftLb, ref.leftLb, 0.001, 'left reaction, lb');
  close(analysis.reactions.rightLb, ref.rightLb, 0.001, 'right reaction, lb');
  for (const s of ref.stations) {
    const at = analysis.at(s.xFt);
    close(at.momentLbIn, s.momentLbIn, 0.05, `moment at ${s.xFt} ft, lb-in`);
    close(at.reducedDeflectionIn, s.deflectionIn, 1e-7, `deflection at ${s.xFt} ft, in`);
  }
});

// --- the three things the OpenSees comparison found, each by hand -------------

const SEG = 9.84375;
function runOfBays(bays, { rails = false, planks = false } = {}) {
  const s = new ScaffoldState({ snapStep: 0 });
  for (let i = 0; i <= bays; i++) for (const y of [0, 3]) s.addStandard(i * 7, y, SEG);
  const z = s.liftZ(4);
  for (let i = 0; i <= bays; i++) s.addLedger([i * 7, 0, z], [i * 7, 3, z]);
  for (let i = 0; i < bays; i++) for (const y of [0, 3]) s.addLedger([i * 7, y, z], [i * 7 + 7, y, z]);
  if (planks) for (let i = 0; i < bays; i++) s.addPlank([i * 7, 0, z], [i * 7 + 7, 3, z]);
  if (rails) s.setDeckGuardrails(z, [s.liftZ(5), s.liftZ(6)]);
  return { s, z };
}
const deadAt = (s, x, y) => s.takeoff().legs.find(l => Math.abs(l.x - x) < 1e-6 && Math.abs(l.y - y) < 1e-6).deadLb;

test('a leg carries its own jack, collar and sill', () => {
  const s = new ScaffoldState({ snapStep: 0 });
  s.addStandard(0, 0, SEG);
  const tube = tubeWeightPerFoot(s.components.standard) * SEG;
  const hardware = s.baseHardwareLb();
  assert.ok(hardware > 10 && hardware < 20, `about 14 lb of base hardware, got ${hardware}`);
  close(s.takeoff().legs[0].deadLb, tube + hardware, 1e-9, 'one standard on its base');

  // Take the sill and collar off and the leg is lighter by exactly their weight.
  const withAll = s.takeoff().legs[0].deadLb;
  s.setBase({ showWoodSill: false, showBaseCollar: false });
  const lighter = s.takeoff().legs[0].deadLb;
  close(withAll - lighter, hardware - s.baseHardwareLb(), 1e-9, 'the sill and collar');
  assert.ok(withAll > lighter);
});

test('a rail past three bays weighs on all four standards, not just the two at its ends', () => {
  const { s, z } = runOfBays(3, { planks: true, rails: true });
  const rails = [...s.guardrails.values()];
  assert.ok(rails.some(g => Math.abs(Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]) - 21) < 1e-6), 'the long sides are drawn as one 21 ft line');
  const pieces = s.guardrailPieces();
  assert.equal(pieces.filter(p => Math.abs(p.lengthFt - 7) < 1e-6).length, 12, 'three 7 ft tubes a side, two rails high, two sides');
  assert.equal(pieces.filter(p => Math.abs(p.lengthFt - 3) < 1e-6).length, 4, 'and a 3 ft tube across each end at each height');
  assert.equal(pieces.some(p => p.lengthFt > 7.01), false, 'no 21 ft tube: nobody makes one');

  // The rails alone: the same scaffold without them, taken away.
  const bare = runOfBays(3, { planks: true }).s;
  const perFt = tubeWeightPerFoot(s.components.ledger);
  const railOn = (x, y) => deadAt(s, x, y) - deadAt(bare, x, y);
  // An end leg holds half a 7 ft rail and half a 3 ft rail at each of two heights.
  close(railOn(0, 0), 2 * perFt * (7 / 2 + 3 / 2), 1e-6, 'end leg');
  // A leg between two bays holds half of each 7 ft rail either side, twice.
  close(railOn(7, 0), 2 * perFt * 7, 1e-6, 'leg between two bays');
  close(railOn(14, 3), 2 * perFt * 7, 1e-6, 'the next one along');
  assert.ok(z > 0);

  // The parts list shows the same pieces.
  const rows = deriveBom(s).lineItems.filter(r => r.category === 'Guardrails');
  assert.deepEqual(rows.map(r => [r.description, r.quantity]).sort(), [['Guardrail rail · 3 ft 0 in', 4], ['Guardrail rail · 7 ft 0 in', 12]]);
});

test('planks weigh on the ledgers at their ends, so a leg under the middle of a side ledger carries none', () => {
  const s = new ScaffoldState({ snapStep: 0 });
  for (const [x, y] of [[0, 0], [3.5, 0], [7, 0], [0, 3], [7, 3]]) s.addStandard(x, y, SEG);
  const z = s.liftZ(4);
  s.addLedger([0, 0, z], [3.5, 0, z]);
  s.addLedger([3.5, 0, z], [7, 0, z]);
  s.addLedger([0, 3, z], [7, 3, z]);
  s.addLedger([0, 0, z], [0, 3, z]);
  s.addLedger([7, 0, z], [7, 3, z]);
  const without = Object.fromEntries(s.takeoff().legs.map(l => [`${l.x},${l.y}`, l.deadLb]));
  s.addPlank([0, 0, z], [7, 3, z]);
  const planksOn = (x, y) => deadAt(s, x, y) - without[`${x},${y}`];

  const deckLb = 21 * s.components.plank.areaWeightLbPerFt2;
  for (const [x, y] of [[0, 0], [7, 0], [0, 3], [7, 3]]) close(planksOn(x, y), deckLb / 4, 1e-6, `corner ${x}, ${y}`);
  close(planksOn(3.5, 0), 0, 1e-9, 'the leg under the middle of the front ledger');
});
