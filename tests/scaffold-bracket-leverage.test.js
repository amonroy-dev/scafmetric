// The leverage of a side bracket, and what it does to the leg behind.
//
// A load on a bracket stands outside the scaffold. Its weight goes down the
// leg the bracket hangs on. Its overturning is held by a pair of forces: more
// on that leg and the same amount less on the leg behind it, each the
// overturning divided by the distance between the two legs. Enough of it and
// the leg behind is in uplift.
//
// Holding the scaffold down against overturning is another figure again, with
// a margin in it, and the last tests here keep the two apart: a leg's uplift
// is not what it takes to hold it down, and a leg with no uplift can need
// holding down all the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ScaffoldState, ARM_PREFIX, OVERTURNING_FACTOR } from '../src/scaffold/workspace/state.js';
import { tubeWeightPerFoot } from '../src/scaffold/catalog.js';
import { plankBoardWeightLb } from '../src/scaffold/workspace/bom.js';
import { sideBracketTubeLengthFt, sideBracketCentroidOutFt, sideBracketWorldMembers } from '../src/scaffold/workspace/parts.js';
import { loadOnBeamFromLeg, wholePoundsOnLeg, toBeamPointLoads, forBeamForm, beamFromSupports, mapLegsToBeam } from '../src/scaffold/legloads.js';

const SEG = 9.84375;       // the long standard
const POST = 6.5625;       // the 2 m standard
const LIFT = 4;
const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a}, expected ${b}`);
const arm = k => `${ARM_PREFIX}${k.id}`;
const legs = s => Object.fromEntries(s.takeoff().legs.map(l => [`${l.x},${l.y}`, l]));

/** Standards at these plan points, with a ledger at the deck lift between each pair named. */
function scaffold(points, ledgers = []) {
  const s = new ScaffoldState({ snapStep: 0 });
  for (const [x, y] of points) s.addStandard(x, y, SEG);
  const z = s.liftZ(LIFT);
  for (const [a, b] of ledgers) s.addLedger([...a, z], [...b, z]);
  return { s, z };
}
/** One leg at the origin with another `depthFt` behind it, and a ledger between them. */
const frame = (depthFt = 3) => scaffold([[0, 0], [0, depthFt]], [[[0, 0], [0, depthFt]]]);
const bracketLb = (s, reachFt) => tubeWeightPerFoot(s.components.ledger) * sideBracketTubeLengthFt(reachFt);
const postLb = s => tubeWeightPerFoot(s.components.standard) * POST;

test('a bracket\'s own weight acts a little under half way along it', () => {
  for (const reach of [2, 3, 3.5]) {
    // The same thing from the bracket as it is drawn: every tube at its own middle.
    let tube = 0, moment = 0;
    for (const m of sideBracketWorldMembers({ x: 0, y: 0, z: 0 }, [1, 0], reach)) {
      const len = Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1], m.b[2] - m.a[2]);
      tube += len;
      moment += len * (m.a[0] + m.b[0]) / 2;
    }
    const out = sideBracketCentroidOutFt(reach);
    close(out, moment / tube, 1e-12, `${reach} ft bracket`);
    close(tube, sideBracketTubeLengthFt(reach), 1e-12, 'weighing the same tube');
    assert.ok(out > 0.4 * reach && out < 0.5 * reach, `${reach} ft bracket: ${out} ft out`);
  }
});

test('a bracket\'s load goes down the leg it hangs on, and levers on the leg behind: as much more on one as less on the other', () => {
  const { s, z } = frame(3);
  const bare = legs(s);
  const k = s.addBracket({ x: 0, y: 0, z }, [0, -1], 2);
  const hung = legs(s);
  const w = bracketLb(s, 2);
  const turn = w * sideBracketCentroidOutFt(2) / 3; // its weight, part way out, against a leg 3 ft back
  close(hung['0,0'].deadLb - bare['0,0'].deadLb, w + turn, 1e-9, 'the leg it hangs on: its weight and its leverage');
  close(hung['0,3'].deadLb - bare['0,3'].deadLb, -turn, 1e-9, 'the leg behind: that leverage less');
  close(hung['0,3'].lifted.deadLb, turn, 1e-9, 'which the leg behind records as lifted off it');
  assert.equal(hung['0,3'].lifted.liveLb, 0);
  assert.equal(hung['0,0'].lifted, undefined, 'nothing is lifted off the leg in front');

  // A standard in the socket stands at the tip, 2 ft out.
  s.addStandardOnBracket(k.id, POST);
  const seated = legs(s);
  const p = postLb(s);
  close(seated['0,0'].deadLb - hung['0,0'].deadLb, p + p * 2 / 3, 1e-9, 'its weight and two thirds more');
  close(seated['0,3'].deadLb - hung['0,3'].deadLb, -p * 2 / 3, 1e-9, 'two thirds of it off the leg behind');
  close(s.takeoff().totals.deadLb, bare['0,0'].deadLb + bare['0,3'].deadLb + w + p, 1e-9, 'leverage moves load between legs and adds none');
});

test('the further back the leg behind, the less the leverage', () => {
  for (const depth of [3, 5, 7]) {
    const { s, z } = frame(depth);
    const k = s.addBracket({ x: 0, y: 0, z }, [0, -1], 3);
    const before = legs(s);
    s.addStandardOnBracket(k.id, POST);
    const after = legs(s);
    close(after[`0,${depth}`].deadLb - before[`0,${depth}`].deadLb, -postLb(s) * 3 / depth, 1e-9, `${depth} ft back`);
  }
});

test('with no leg behind there is nothing to lever against, and the load stays on the leg it hangs on', () => {
  const tributary = (s, at, others) => {
    const [x, y] = at;
    const before = legs(s);
    const k = s.addBracket({ x, y, z: s.liftZ(LIFT) }, [0, -1], 2);
    s.addStandardOnBracket(k.id, POST);
    const after = legs(s);
    close(after[`${x},${y}`].deadLb - before[`${x},${y}`].deadLb, bracketLb(s, 2) + postLb(s), 1e-9, 'all of it, and no more, on the leg it hangs on');
    for (const o of others) close(after[o].deadLb - before[o].deadLb, 0, 1e-9, `nothing moves on ${o}`);
    for (const l of Object.values(after)) { assert.equal(l.lifted, undefined); assert.equal(l.overturning, undefined); }
  };
  // One leg, standing alone.
  tributary(scaffold([[0, 0]]).s, [0, 0], []);
  // A ledger that runs along the face, not back from it.
  tributary(scaffold([[0, 0], [7, 0]], [[[0, 0], [7, 0]]]).s, [0, 0], ['7,0']);
  // A ledger that runs back at an angle: 2 ft across for 3 ft back is well off square.
  tributary(scaffold([[0, 0], [2, 3]], [[[0, 0], [2, 3]]]).s, [0, 0], ['2,3']);
  // A leg in front of the bracket, the way it points, is not behind it.
  tributary(scaffold([[0, 0], [0, -5]], [[[0, 0], [0, -5]]]).s, [0, 0], ['0,-5']);
  // A leg behind with nothing joining the two.
  tributary(scaffold([[0, 0], [0, 3]]).s, [0, 0], ['0,3']);
});

test('the leg behind is the nearest one a ledger or a truss runs back to', () => {
  // Three legs in a line: the middle one takes the leverage and the far one none.
  const deep = scaffold([[0, 0], [0, 3], [0, 6]], [[[0, 0], [0, 3]], [[0, 3], [0, 6]]]);
  const before = legs(deep.s);
  const k = deep.s.addBracket({ x: 0, y: 0, z: deep.z }, [0, -1], 2);
  deep.s.addStandardOnBracket(k.id, POST);
  const after = legs(deep.s);
  const turning = (bracketLb(deep.s, 2) * sideBracketCentroidOutFt(2) + postLb(deep.s) * 2) / 3;
  close(after['0,3'].deadLb - before['0,3'].deadLb, -turning, 1e-9, 'the leg next behind');
  close(after['0,6'].deadLb - before['0,6'].deadLb, 0, 1e-9, 'the one behind that');
  assert.equal(after['0,6'].lifted, undefined);

  // Joined by a truss and no ledger: the truss is the way back.
  const { s, z } = scaffold([[0, 0], [0, 7]]);
  s.addTruss([0, 0, z], [0, 7, z], 'truss');
  const bare = legs(s);
  const b = s.addBracket({ x: 0, y: 0, z }, [0, -1], 2);
  s.addStandardOnBracket(b.id, POST);
  close(legs(s)['0,7'].deadLb - bare['0,7'].deadLb, -(bracketLb(s, 2) * sideBracketCentroidOutFt(2) + postLb(s) * 2) / 7, 1e-9, 'across the truss');
});

test('brackets on both faces lever against each other, and at a corner each against the leg behind it', () => {
  // Front and back of one frame: a 2 ft bracket with a standard in it one way, a bare 3 ft bracket the other.
  const { s, z } = frame(3);
  const bare = legs(s);
  const front = s.addBracket({ x: 0, y: 0, z }, [0, -1], 2);
  s.addStandardOnBracket(front.id, POST);
  s.addBracket({ x: 0, y: 3, z }, [0, 1], 3);
  const both = legs(s);
  const fromFront = (bracketLb(s, 2) * sideBracketCentroidOutFt(2) + postLb(s) * 2) / 3;
  const fromBack = bracketLb(s, 3) * sideBracketCentroidOutFt(3) / 3;
  close(both['0,0'].deadLb - bare['0,0'].deadLb, bracketLb(s, 2) + postLb(s) + fromFront - fromBack, 1e-9, 'the front leg');
  close(both['0,3'].deadLb - bare['0,3'].deadLb, bracketLb(s, 3) + fromBack - fromFront, 1e-9, 'the back leg');
  close(both['0,3'].lifted.deadLb, fromFront, 1e-9, 'what the front bracket lifts off the back leg');
  close(both['0,0'].lifted.deadLb, fromBack, 1e-9, 'and the back bracket off the front leg');

  // A corner leg with a bracket on each of its two outside faces.
  const corner = scaffold([[0, 0], [0, 3], [7, 0]], [[[0, 0], [0, 3]], [[0, 0], [7, 0]]]);
  const was = legs(corner.s);
  corner.s.addBracket({ x: 0, y: 0, z: corner.z }, [0, -1], 2);
  corner.s.addBracket({ x: 0, y: 0, z: corner.z }, [-1, 0], 2);
  const now = legs(corner.s);
  const w = bracketLb(corner.s, 2), out = sideBracketCentroidOutFt(2);
  close(now['0,3'].deadLb - was['0,3'].deadLb, -w * out / 3, 1e-9, 'the leg 3 ft behind one bracket');
  close(now['7,0'].deadLb - was['7,0'].deadLb, -w * out / 7, 1e-9, 'the leg 7 ft behind the other');
  close(now['0,0'].deadLb - was['0,0'].deadLb, 2 * w + w * out / 3 + w * out / 7, 1e-9, 'the corner leg: both brackets and both leverages');
});

// --- uplift, and what it takes to hold the scaffold down --------------------------

/**
 * Two bays, three legs a row 3 ft apart, a 2 ft bracket on each front leg, the
 * brackets decked from arm to arm and the bracket decks loaded at `psf`. With
 * `behindPsf` the two bays behind are decked and loaded as well.
 */
function loadedRun({ psf = 0, brackets = true, behindPsf = null } = {}) {
  const { s, z } = scaffold(
    [[0, 0], [7, 0], [14, 0], [0, 3], [7, 3], [14, 3]],
    [[[0, 0], [0, 3]], [[7, 0], [7, 3]], [[14, 0], [14, 3]], [[0, 0], [7, 0]], [[7, 0], [14, 0]], [[0, 3], [7, 3]], [[7, 3], [14, 3]]]);
  const loads = [];
  if (behindPsf !== null) {
    for (const x of [0, 7]) loads.push({ deckId: s.addPlank([x, 0, z], [x + 7, 3, z]).id, psf: behindPsf });
  }
  if (brackets) {
    const ks = [0, 7, 14].map(x => s.addBracket({ x, y: 0, z }, [0, -1], 2));
    const side = s.addPlankOnLedger(arm(ks[0]), 1) ? 1 : -1;
    if (side === -1) s.addPlankOnLedger(arm(ks[0]), -1);
    s.addPlankOnLedger(arm(ks[1]), side);
    for (const d of s.plankBays()) if (d.frame.center.y < 0) loads.push({ deckId: d.id, psf });
  }
  s.setDeckLiveLoads(loads.filter(l => l.psf > 0));
  return s;
}

test('the factor against overturning is one and a half', () => {
  assert.equal(OVERTURNING_FACTOR, 1.5);
});

test('enough load on the brackets and the legs behind are in uplift', () => {
  const s = loadedRun({ psf: 100 });
  const without = legs(loadedRun({ brackets: false }));
  const l = legs(s);
  // 100 psf on 7 ft by 2 ft is 1,400 lb a bay, half on each arm, acting 1 ft
  // out, against a leg 3 ft back. The middle arm has a bay either side.
  close(l['7,3'].lifted.liveLb, 1400 / 3, 1e-6, 'live load lifted off the middle back leg');
  close(l['0,3'].lifted.liveLb, 700 / 3, 1e-6, 'and off an end one');
  close(l['7,3'].liveLb, -1400 / 3, 1e-6, 'which is all the live load it has: none is placed behind');
  close(l['7,0'].liveLb, 1400 + 1400 / 3, 1e-6, 'the front leg carries the bracket load and that much more');
  // Dead load lifted: the bracket's own weight part way out, and its share of the boards where they lie.
  const psfPlank = s.components.plank.areaWeightLbPerFt2;
  const boardsLbFt = s.plankBays().find(d => d.frame.center.y < 0 && d.frame.center.x < 7).boards
    .reduce((sum, b) => sum + plankBoardWeightLb(b.widthIn, b.lengthFt, psfPlank) * -b.center[1], 0);
  close(l['0,3'].lifted.deadLb, (bracketLb(s, 2) * sideBracketCentroidOutFt(2) + boardsLbFt / 2) / 3, 1e-6, 'dead load lifted off an end back leg');
  for (const k of ['0,3', '7,3', '14,3']) {
    close(l[k].deadLb, without[k].deadLb - l[k].lifted.deadLb, 1e-9, `${k}: its own dead load, less what is lifted`);
    assert.ok(l[k].deadLb + l[k].liveLb < 0, `${k} is in uplift`);
    assert.ok(wholePoundsOnLeg(l[k]) < 0, 'and reads negative in whole pounds');
  }
  close(s.takeoff().totals.liveLb, 2800, 1e-6, 'every pound of live load still reaches the ground');
});

test('what holds a leg down against overturning is not its uplift: it has the margin in it, and no live load', () => {
  const s = loadedRun({ psf: 100 });
  const without = legs(loadedRun({ brackets: false }));
  for (const k of ['0,3', '7,3', '14,3']) {
    const l = legs(s)[k];
    const turning = l.lifted.deadLb + l.lifted.liveLb;   // what the brackets lift, dead and live
    const resisting = without[k].deadLb;                 // the leg's own dead load: what it had before the brackets
    close(l.overturning.turningLb, turning, 1e-9, `${k}: turning`);
    close(l.overturning.resistingLb, resisting, 1e-9, `${k}: resisting`);
    close(l.overturning.factor, resisting / turning, 1e-12, `${k}: factor`);
    close(l.overturning.holdDownLb, 1.5 * turning - resisting, 1e-9, `${k}: hold-down for 1.5 to 1`);
    // Held down by that much, it stands at 1.5 to 1.
    close((resisting + l.overturning.holdDownLb) / turning, OVERTURNING_FACTOR, 1e-12, `${k}: the margin with the hold-down on`);
    const uplift = -(l.deadLb + l.liveLb);
    assert.ok(uplift > 0);
    close(l.overturning.holdDownLb - uplift, turning / 2, 1e-9, `${k}: the hold-down is half the turning load more than the uplift`);
  }
});

test('a leg with no uplift at all can still need holding down', () => {
  // Load the brackets until they lift four fifths of the middle back leg's own dead load off it.
  const unloaded = legs(loadedRun({ psf: 0 }))['7,3'];
  const resisting = unloaded.overturning.resistingLb;
  const psf = (0.8 * resisting - unloaded.lifted.deadLb) * 3 / 14;
  assert.ok(psf > 0);
  const l = legs(loadedRun({ psf }))['7,3'];
  close(l.overturning.turningLb, 0.8 * resisting, 1e-9, 'four fifths of it lifted');
  assert.ok(l.deadLb + l.liveLb > 0, 'so it still bears down: no uplift');
  close(l.deadLb + l.liveLb, 0.2 * resisting, 1e-9, 'by a fifth of its dead load');
  close(l.overturning.factor, 1.25, 1e-12, 'but 1.25 to 1 is short of 1.5');
  close(l.overturning.holdDownLb, 0.2 * resisting, 1e-9, 'and it takes a hold-down to make it up');
});

test('with a margin of one and a half or better there is nothing to add', () => {
  const l = legs(loadedRun({ psf: 0 }))['7,3'];
  assert.ok(l.overturning.factor > OVERTURNING_FACTOR, `unloaded brackets: ${l.overturning.factor} to 1`);
  assert.equal(l.overturning.holdDownLb, 0);
  // No brackets, no leverage, and no overturning to speak of.
  for (const leg of Object.values(legs(loadedRun({ brackets: false })))) assert.equal(leg.overturning, undefined);
});

test('live load on the deck behind holds a leg down as it stands, and is not counted against overturning', () => {
  const empty = legs(loadedRun({ psf: 100, behindPsf: 0 }))['7,3'];
  const loaded = legs(loadedRun({ psf: 100, behindPsf: 75 }))['7,3'];
  // 75 psf on two 7 ft by 3 ft bays: the middle back leg takes a quarter of each.
  close(loaded.liveLb - empty.liveLb, 2 * 75 * 21 / 4, 1e-6, 'the live load behind is on the leg');
  assert.ok(empty.deadLb + empty.liveLb < 0 && loaded.deadLb + loaded.liveLb > 0, 'enough to take it out of uplift');
  assert.deepEqual(loaded.overturning, empty.overturning, 'and the overturning figures do not move: that load may not be there');
  assert.ok(loaded.overturning.holdDownLb > 0, 'so it still needs holding down');
  // The planks behind are dead load, and those do count.
  const bare = legs(loadedRun({ psf: 100 }))['7,3'];
  assert.ok(empty.overturning.resistingLb > bare.overturning.resistingLb);
  assert.ok(empty.overturning.holdDownLb < bare.overturning.holdDownLb);
});

// --- what a beam under the legs is given ------------------------------------------

test('a beam under the back legs is not given the live load a bracket levers off them', () => {
  const s = loadedRun({ psf: 100, behindPsf: 25 });
  const all = legs(s);
  const back = all['7,3'], front = all['7,0'];
  // With the brackets empty the same leg bears down in full: that is what the beam must take.
  const bracketsEmpty = legs(loadedRun({ psf: 0, behindPsf: 25 }))['7,3'];
  const sent = loadOnBeamFromLeg(back);
  close(sent.liveLb, bracketsEmpty.liveLb, 1e-9, 'live load as if the brackets were empty');
  close(sent.liveLb, back.liveLb + back.lifted.liveLb, 1e-9, 'which is its live load with the leverage put back');
  close(sent.deadLb, back.deadLb, 1e-9, 'dead load as it stands: the brackets are always there');
  assert.ok(sent.liveLb > back.liveLb);
  // The leg the bracket hangs on sends everything it carries.
  assert.deepEqual(loadOnBeamFromLeg(front), { deadLb: front.deadLb, liveLb: front.liveLb });

  // And that is what reaches the beam form, in whole pounds.
  const beam = beamFromSupports([-1, 3], [15, 3]);
  const { imported } = toBeamPointLoads(mapLegsToBeam(s.takeoff().legs.filter(l => l.y === 3), beam));
  assert.equal(imported.length, 3);
  const middle = forBeamForm(imported.find(e => e.legId === back.id));
  assert.deepEqual([middle.deadLb, middle.liveLb, middle.locationFt], [Math.round(back.deadLb), Math.round(bracketsEmpty.liveLb), 8]);
  for (const e of imported) assert.ok(e.deadLb >= 0 && e.liveLb >= 0, 'nothing negative is sent');
});

test('a leg does not pull up on the beam it stands on', () => {
  // Uplift under dead load alone: nothing is sent, not a negative load.
  assert.deepEqual(loadOnBeamFromLeg({ deadLb: -40, liveLb: -300, lifted: { deadLb: 120, liveLb: 300 } }), { deadLb: 0, liveLb: 0 });
  // Dead load positive, live levered off: the dead load, and the live load without the leverage.
  assert.deepEqual(loadOnBeamFromLeg({ deadLb: 90, liveLb: -200, lifted: { deadLb: 10, liveLb: 450 } }), { deadLb: 90, liveLb: 250 });
  // A leg no bracket touches is sent as it is.
  assert.deepEqual(loadOnBeamFromLeg({ deadLb: 150.5, liveLb: 262.5 }), { deadLb: 150.5, liveLb: 262.5 });
  // Whole pounds, negative for uplift, and never a negative zero.
  assert.equal(wholePoundsOnLeg({ deadLb: 97.6, liveLb: -367.5 }), -269);
  assert.ok(Object.is(wholePoundsOnLeg({ deadLb: 0.2, liveLb: -0.3 }), 0));
});
