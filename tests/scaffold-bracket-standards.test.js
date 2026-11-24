// Side brackets that carry something: a standard seated in the socket, a deck
// laid from arm to arm, a brace up the outer row. And where all of it goes: a
// bracket is a cantilever off one standard, so its load comes down the leg it
// hangs on, and being out from that leg it levers a little more onto it from
// the leg behind. In this file every front leg has a leg 3 ft behind it and
// the brackets are 2 ft long, so a load at a bracket's tip puts two thirds of
// itself more on the front leg and takes as much off the back one. (The same
// thing is checked against OpenSees, leg by leg, in opensees-leg-loads.test.js;
// the leverage has its own tests in scaffold-bracket-leverage.test.js.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { ScaffoldState, ARM_PREFIX, BRACKET_SEAT_UP_IN, NODE_SPACING_IN } from '../src/scaffold/workspace/state.js';
import { tubeWeightPerFoot } from '../src/scaffold/catalog.js';
import { deriveBom, plankBoardWeightLb } from '../src/scaffold/workspace/bom.js';
import { buildCenterlineModel, LAYERS } from '../src/scaffold/workspace/dxf.js';
import { planPerimeterBraces } from '../src/scaffold/workspace/braces.js';
import { sideBracketTubeLengthFt, sideBracketCentroidOutFt } from '../src/scaffold/workspace/parts.js';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { Tools } = await import('../src/scaffold/workspace/tools.js');

const SEG = 9.84375;       // the long standard
const POST = 6.5625;       // the 2 m standard: four rosettes
const LIFT = 4;            // the deck's lift
const REACH = 2;           // the brackets, tip to standard
const DEPTH = 3;           // front leg to the leg behind it
const close = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a}, expected ${b}`);
const arm = k => `${ARM_PREFIX}${k.id}`;

/** Two bays, three legs a row, ledgers round both bays at the deck lift, and a 2 ft bracket on each front leg. */
function run({ brackets = true, reachFt = 2 } = {}) {
  const s = new ScaffoldState({ snapStep: 0 });
  for (const y of [0, 3]) for (const x of [0, 7, 14]) s.addStandard(x, y, SEG);
  const z = s.liftZ(LIFT);
  for (const x of [0, 7, 14]) s.addLedger([x, 0, z], [x, 3, z]);
  for (const y of [0, 3]) for (const x of [0, 7]) s.addLedger([x, y, z], [x + 7, y, z]);
  const ks = brackets ? [0, 7, 14].map(x => s.addBracket({ x, y: 0, z }, [0, -1], reachFt)) : [];
  return { s, z, ks };
}
const leg = (s, x, y) => s.takeoff().legs.find(l => Math.abs(l.x - x) < 1e-6 && Math.abs(l.y - y) < 1e-6);
const legLoads = s => Object.fromEntries(s.takeoff().legs.map(l => [`${l.x},${l.y}`, { dead: l.deadLb, live: l.liveLb }]));

// --- a standard in a bracket's socket ------------------------------------------

test('a standard seated in a side bracket stands at the tip, with its rosettes on the scaffold\'s lifts', () => {
  const { s, z, ks } = run();
  const seat = s.bracketSeat(ks[0].id);
  assert.deepEqual([seat.x, seat.y, seat.blocked, seat.standard], [0, -2, false, null]);
  close(seat.z, z + BRACKET_SEAT_UP_IN / 12, 1e-12, 'the socket seat');
  close(BRACKET_SEAT_UP_IN, 3.9375, 1e-12, 'which is 3.9375 in above the bracket\'s rosette');

  const post = s.addStandardOnBracket(ks[0].id, POST);
  assert.equal(post.bracketId, ks[0].id);
  assert.deepEqual([post.x, post.y], [0, -2]);
  assert.equal(s.isLeg(post), false, 'it does not stand on the ground');
  close(s.standardBaseZ(post), z + 3.9375 / 12, 1e-12, 'its foot');
  close(s.standardTopZ(post), z + 3.9375 / 12 + POST, 1e-12, 'its top');

  // Its own rosettes: one spacing above the bracket's, then every lift, each
  // exactly where the standards beside it have theirs.
  const own = s.nodes().filter(n => n.columnId === post.id && !n.bracketId);
  assert.deepEqual(own.map(n => n.level), [LIFT + 1, LIFT + 2, LIFT + 3, LIFT + 4]);
  for (const n of own) assert.equal(n.z, s.liftZ(n.level), `lift ${n.level}`);
  close(own[0].z - z, NODE_SPACING_IN / 12, 1e-12, 'first rosette one spacing up');
  // And the bracket's tip rosette is the foot of the same column, so a brace can start from it.
  const foot = s.nodes().find(n => n.bracketId === ks[0].id);
  assert.deepEqual([foot.columnId, foot.level, foot.z], [post.id, LIFT, z]);
  // The tips with nothing in them keep columns of their own.
  assert.ok(s.nodes().find(n => n.bracketId === ks[1].id).columnId.startsWith('tip:'));
});

test('another click on the same socket puts a segment on top; sockets that cannot take one say so', () => {
  const { s, z, ks } = run();
  const post = s.addStandardOnBracket(ks[0].id, POST);
  const seat = s.bracketSeat(ks[0].id);
  assert.equal(seat.standard, post, 'the standard already there');
  close(seat.z, s.standardTopZ(post), 1e-12, 'the next tube starts at its top');
  assert.equal(s.addStandardOnBracket(ks[0].id, 3.28125), post);
  assert.deepEqual(post.segments, [POST, 3.28125]);
  assert.equal(s.standards.size, 7, 'still one standard there');

  // A second bracket one deck up, tip over the same spot. The standard has
  // grown past it, so its tip is one of the standard's rosettes already, and
  // its socket adds to the same standard.
  const upper = s.addBracket({ x: 0, y: 0, z: s.liftZ(LIFT + 4) }, [0, -1], 2);
  assert.equal(s.nodes().some(n => n.bracketId === upper.id), false, 'no second rosette on top of the standard\'s own');
  assert.equal(s.bracketSeat(upper.id).standard, post);

  // The other way round: seated in the upper of two brackets, it blocks the socket below.
  const lone = s.addBracket({ x: 7, y: 0, z: s.liftZ(LIFT + 4) }, [0, -1], 2);
  s.addStandardOnBracket(lone.id, 3.28125);
  assert.equal(s.bracketSeat(ks[1].id).blocked, true);
  assert.equal(s.addStandardOnBracket(ks[1].id, POST), null);

  // And a leg standing where the tip is: that spot is taken from the ground.
  s.addStandard(14, -2, SEG);
  assert.equal(s.bracketSeat(ks[2].id).blocked, true);
  assert.equal(s.addStandardOnBracket(ks[2].id, POST), null);
  assert.ok(z > 0);
});

test('taking a bracket away takes the standard in it and the deck on it, and undo brings them back', () => {
  const { s, ks } = run();
  const post = s.addStandardOnBracket(ks[0].id, POST);
  const deck = s.addPlankOnLedger(arm(ks[0]), 1) || s.addPlankOnLedger(arm(ks[0]), -1);
  assert.ok(deck, 'decked from the first arm to the second');
  s.remove(ks[0].id);
  assert.equal(s.standards.has(post.id), false, 'the standard went with its bracket');
  assert.equal(s.plankPlacements.has(deck.id), false, 'and so did the deck hung on its arm');
  s.undo();
  assert.ok(s.standards.has(post.id) && s.plankPlacements.has(deck.id) && s.brackets.has(ks[0].id));
  // Moving stacks about leaves a seated standard with its bracket.
  assert.deepEqual(s.transformStacks([post.id], 5, 0), []);
  assert.deepEqual([s.standards.get(post.id).x, s.standards.get(post.id).y], [0, -2]);
});

// --- where the load goes ---------------------------------------------------------

test('a standard in a bracket is not a leg: its weight is on the leg the bracket hangs on, levered against the leg behind', () => {
  const { s, ks } = run();
  const before = legLoads(s);
  s.addStandardOnBracket(ks[1].id, POST);
  const after = legLoads(s);
  assert.equal(s.takeoff().legs.length, 6, 'still six legs');
  const tube = tubeWeightPerFoot(s.components.standard) * POST;
  // It stands at the bracket's tip, 2 ft out from a leg with another 3 ft behind it.
  const lever = tube * REACH / DEPTH;
  const expected = { '7,0': tube + lever, '7,3': -lever };
  for (const k of Object.keys(before)) {
    close(after[k].dead - before[k].dead, expected[k] || 0, 1e-9, `leg at ${k}`);
  }
  // No jack, collar or sill under it: the tube and nothing more.
  assert.ok(tube < s.baseHardwareLb() + tube);
  const bom = deriveBom(s);
  assert.equal(bom.lineItems.find(r => r.description === 'Screw jack').quantity, 6, 'six jacks for six legs');
  close(s.takeoff().totals.deadLb, bom.summary.totalWeightLb, 0.01 * bom.lineItems.length, 'every pound in the parts list reaches a leg');
});

test('what hangs on the outer row comes down through the brackets: a ledger between two seated standards', () => {
  const { s, ks } = run();
  const posts = ks.map(k => s.addStandardOnBracket(k.id, POST));
  const before = legLoads(s);
  const up = s.liftZ(LIFT + 2);
  s.addLedger([posts[0].x, posts[0].y, up], [posts[1].x, posts[1].y, up]);
  const after = legLoads(s);
  const half = tubeWeightPerFoot(s.components.ledger) * 7 / 2;
  const lever = half * REACH / DEPTH;
  close(after['0,0'].dead - before['0,0'].dead, half + lever, 1e-9, 'half on the leg behind one end, and its leverage');
  close(after['7,0'].dead - before['7,0'].dead, half + lever, 1e-9, 'half on the leg behind the other, and its leverage');
  close(after['0,3'].dead - before['0,3'].dead, -lever, 1e-9, 'that leverage off the back leg at one end');
  close(after['7,3'].dead - before['7,3'].dead, -lever, 1e-9, 'and at the other');
  for (const k of ['14,0', '14,3']) close(after[k].dead - before[k].dead, 0, 1e-9, `nothing on ${k}`);
});

test('a bracket hung on a seated standard passes its load on down to the leg at the bottom of the chain', () => {
  const { s, ks } = run();
  const post = s.addStandardOnBracket(ks[0].id, POST);
  const before = legLoads(s);
  // A second bracket, off the seated standard, further out again.
  const outer = s.addBracket({ x: post.x, y: post.y, z: s.liftZ(LIFT + 2) }, [0, -1], 2);
  s.addStandardOnBracket(outer.id, 3.28125);
  const after = legLoads(s);
  const bracketLb = tubeWeightPerFoot(s.components.ledger) * sideBracketTubeLengthFt(2);
  const postLb = tubeWeightPerFoot(s.components.standard) * 3.28125;
  const added = bracketLb + postLb;
  // The second bracket hangs 2 ft out and its own weight acts part way along
  // it; the standard in it stands 4 ft out. All of that turns about the one leg.
  const lever = (bracketLb * (REACH + sideBracketCentroidOutFt(2)) + postLb * 2 * REACH) / DEPTH;
  close(after['0,0'].dead - before['0,0'].dead, added + lever, 1e-9, 'all of it on the leg the first bracket hangs on, and its leverage');
  close(after['0,3'].dead - before['0,3'].dead, -lever, 1e-9, 'that leverage off the leg behind');
  for (const k of ['7,0', '14,0', '7,3', '14,3']) close(after[k].dead - before[k].dead, 0, 1e-9, `nothing on ${k}`);
  close(s.takeoff().totals.deadLb, Object.values(before).reduce((a, l) => a + l.dead, 0) + added, 1e-9, 'and nothing lost');
});

// --- decks on the brackets -------------------------------------------------------

test('a deck on side brackets bears on two arms, its boards running along the face from one to the next', () => {
  const { s, z, ks } = run();
  assert.deepEqual(s.bracketArms().map(a => [a.id, a.a, a.b]), ks.map((k, i) => [arm(k), [i * 7, 0, z], [i * 7, -2, z]]));
  assert.equal(s.supportList().length, s.ledgers.size + 3, 'the arms are offered beside the ledgers');
  assert.equal(s.ledgerList().some(l => String(l.id).startsWith(ARM_PREFIX)), false, 'but an arm is never a ledger');

  // An arm drawn toward -y has the next bracket along +x on one side only.
  const side = s.addPlankOnLedger(arm(ks[0]), 1) ? 1 : -1;
  if (side === -1) assert.ok(s.addPlankOnLedger(arm(ks[0]), -1));
  assert.equal(s.addPlankOnLedger(arm(ks[0]), -side), null, 'nothing on the other side of the end bracket');
  const deck = s.plankBays().find(d => d.frame.center.y < 0);
  assert.deepEqual([deck.x0, deck.x1, deck.y0, deck.y1, deck.z], [0, 7, -2, 0, z]);
  assert.deepEqual([Math.abs(deck.frame.along.x), Math.abs(deck.frame.along.y)], [1, 0], 'the boards run along the face');
  close(deck.frame.alongFt, 7, 1e-12, 'from arm to arm');
  // Two nine-inch boards on a 2 ft bracket, each a bay long.
  assert.deepEqual(deck.boards.map(b => b.widthIn), [9, 9]);
  for (const b of deck.boards) { close(b.lengthFt, 7, 0.03, 'board length'); assert.ok(b.center[1] < 0 && b.center[1] > -2); }
  // The parts list has the boards and no new ledger.
  const bom = deriveBom(s);
  assert.equal(bom.lineItems.filter(r => r.category === 'Ledgers').reduce((n, r) => n + r.quantity, 0), 7);
});

test('the deck\'s weight and its live load come down the two legs its brackets hang on, half each, levered against the legs behind', () => {
  const { s, ks } = run();
  const before = legLoads(s);
  const deck = s.addPlankOnLedger(arm(ks[0]), 1) || s.addPlankOnLedger(arm(ks[0]), -1);
  s.setDeckLiveLoad(deck.id, 50);
  const after = legLoads(s);
  const psf = s.components.plank.areaWeightLbPerFt2;
  const boards = s.plankBays().find(d => d.id === deck.id).boards;
  const boardsLb = boards.reduce((sum, b) => sum + plankBoardWeightLb(b.widthIn, b.lengthFt, psf), 0);
  // Each board lies a known distance out from the face (y = 0), and that is
  // how far out its weight acts. The live load is spread over the whole 2 ft.
  const boardsLbFt = boards.reduce((sum, b) => sum + plankBoardWeightLb(b.widthIn, b.lengthFt, psf) * -b.center[1], 0);
  const liveLb = 50 * 7 * REACH / 2;                 // half of 50 psf over 7 ft by 2 ft, on each arm
  const liveLever = liveLb * (REACH / 2) / DEPTH;    // acting 1 ft out, against a leg 3 ft back
  const deadLever = boardsLbFt / 2 / DEPTH;
  for (const x of [0, 7]) {
    close(after[`${x},0`].dead - before[`${x},0`].dead, boardsLb / 2 + deadLever, 1e-6, `plank weight on ${x},0`);
    close(after[`${x},0`].live, liveLb + liveLever, 1e-6, `live load on ${x},0`);
    close(after[`${x},3`].dead - before[`${x},3`].dead, -deadLever, 1e-6, `plank leverage off ${x},3`);
    close(after[`${x},3`].live, -liveLever, 1e-6, `live leverage off ${x},3: a back leg carries none of a bracket, and is relieved by it`);
  }
  for (const k of ['14,0', '14,3']) {
    close(after[k].dead - before[k].dead, 0, 1e-9, `no plank weight on ${k}`);
    close(after[k].live, 0, 1e-9, `no live load on ${k}`);
  }
  close(s.takeoff().totals.liveLb, 50 * 7 * REACH, 1e-6, 'all of the live load, and no more, reaches the ground');
  // With standards seated in the brackets it is the same: they are not legs.
  for (const k of ks) s.addStandardOnBracket(k.id, POST);
  close(leg(s, 0, 0).liveLb, liveLb + liveLever, 1e-6, 'still on the leg the bracket hangs on');
  assert.equal(s.takeoff().legs.length, 6);
});

test('arms pair with the next bracket of their own row, and no further than a plank is long', () => {
  // Brackets two bays apart at 7 ft bays are 14 ft apart: not one deck.
  const far = run();
  far.s.remove(far.ks[1].id);
  assert.equal(far.s.addPlankOnLedger(arm(far.ks[0]), 1), null);
  assert.equal(far.s.addPlankOnLedger(arm(far.ks[0]), -1), null);
  // A bracket on the back face is parallel and at the same lift, and is not a neighbour either.
  const { s, z, ks } = run();
  s.addBracket({ x: 7, y: 3, z }, [0, 1], 2);
  const deck = s.addPlankOnLedger(arm(ks[0]), 1) || s.addPlankOnLedger(arm(ks[0]), -1);
  assert.deepEqual([s.plankBays().find(d => d.id === deck.id).x1, s.plankBays().find(d => d.id === deck.id).y1], [7, 0], 'it paired with the front bracket beside it');
});

test('the row a bracket is in: the same lift, the same way, tips in one line, in order along the face', () => {
  const { s, z, ks } = run();
  const back = s.addBracket({ x: 7, y: 3, z }, [0, 1], 2);
  const higher = s.addBracket({ x: 7, y: 0, z: s.liftZ(LIFT + 4) }, [0, -1], 2);
  const longer = s.addBracket({ x: 0, y: 0, z: s.liftZ(LIFT + 4) }, [0, -1], 3);
  assert.deepEqual(s.bracketRow(ks[1].id).map(k => k.id), ks.map(k => k.id));
  assert.deepEqual(s.bracketRow(back.id).map(k => k.id), [back.id]);
  assert.deepEqual(s.bracketRow(higher.id).map(k => k.id), [higher.id], 'a longer bracket beside it reaches a different line');
  assert.deepEqual(s.bracketRow(longer.id).map(k => k.id), [longer.id]);
  assert.deepEqual(s.bracketRow('nope'), []);
});

test('the drawing export starts a seated standard in its socket, with no jack under it', () => {
  const { s, z, ks } = run();
  const post = s.addStandardOnBracket(ks[0].id, POST);
  const model = buildCenterlineModel(s);
  const own = model.segments.filter(g => g.id === post.id);
  assert.deepEqual(own.map(g => g.layer), [LAYERS.standard]);
  close(own[0].start[2], z + 3.9375 / 12, 1e-12, 'from the socket');
  assert.equal(model.segments.filter(g => g.layer === LAYERS.jack).length, 6, 'a jack under each of the six legs only');
});

// --- the tools ------------------------------------------------------------------

const W = 1000, H = 800;
/** The run seen from straight above, with a Tools on it. */
function fromAbove(opts) {
  const built = run(opts);
  const { s } = built;
  const camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 5000);
  camera.up.set(0, 1, 0);
  camera.position.set(7, 0.5, 70);
  camera.lookAt(7, 0.5, 0);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const bounds = () => ({ left: 0, top: 0, width: W, height: H });
  const el = { style: {}, addEventListener() {}, removeEventListener() {}, getBoundingClientRect: bounds, parentElement: { getBoundingClientRect: bounds, appendChild() {} } };
  const engine = {
    scene: new THREE.Scene(), renderer: { domElement: el }, camera, invalidate() {},
    raycaster: new THREE.Raycaster(), pointer: new THREE.Vector2(), panLock: false, _modifiers: { space: false },
    setPointerFromEvent(e) { this.pointer.set((e.clientX / W) * 2 - 1, -(e.clientY / H) * 2 + 1); },
    groundPlane: new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
    groundPoint(out = new THREE.Vector3()) { this.raycaster.setFromCamera(this.pointer, this.camera); return this.raycaster.ray.intersectPlane(this.groundPlane, out); },
  };
  const previews = [], fills = [];
  const t = new Tools(engine, s, {
    getContentMeshes: () => [], getNodeMeshes: () => [],
    onPreview: (tool, count, info) => previews.push({ tool, count, info }),
    onBulkFill: (n, what) => fills.push({ n, what }),
  });
  t.setCatalog('standards', 'std-6-7');
  const screen = (p, shiftKey = false) => { const v = new THREE.Vector3(...p).project(camera); return { clientX: ((v.x + 1) / 2) * W, clientY: ((1 - v.y) / 2) * H, shiftKey, ctrlKey: false, metaKey: false, altKey: false, buttons: 0 }; };
  return { ...built, t, previews, fills, screen };
}
const seatedOf = s => [...s.standards.values()].filter(c => c.bracketId);

test('with "On side brackets" on, the Standard tool stands a standard in the socket under the pointer, and nowhere else', () => {
  const { s, z, ks, t, previews, screen } = fromAbove();
  t.setStandardsOnBrackets(true);
  // Pointing a little off the rosette still finds it, as ScaffoldPro's snap does.
  const near = screen([7, -2, z]); near.clientX += 15;
  t._onMove(near);
  assert.equal(t.ghostGroup.children.length, 1, 'the standard a click would stand');
  assert.equal(previews.at(-1).info.onBrackets, true);
  close(previews.at(-1).info.totalFt, POST, 1e-9, 'the size chosen in the card');
  t._act(near);
  assert.deepEqual(seatedOf(s).map(c => [c.bracketId, c.x, c.y, c.segments]), [[ks[1].id, 7, -2, [POST]]]);
  // Out on open ground the tool does nothing while the box is ticked.
  const ground = screen([3.5, -8, 0]);
  t._onMove(ground);
  assert.equal(previews.at(-1).count, 0);
  t._act(ground);
  assert.equal(s.standards.size, 7);
  // Unticked, the same click stands one on the ground as it always has.
  t.setStandardsOnBrackets(false);
  t._act(ground);
  assert.equal(s.standards.size, 8);
  assert.equal(seatedOf(s).length, 1);
});

test('SHIFT stands a standard in every free socket along the row of brackets, as one undo step', () => {
  const { s, z, ks, t, previews, fills, screen } = fromAbove();
  t.setStandardsOnBrackets(true);
  s.addStandardOnBracket(ks[2].id, POST); // one is there already
  const at = screen([0, -2, z], true);
  t._onMove(at);
  assert.equal(previews.at(-1).count, 2, 'the two free sockets of the three');
  assert.deepEqual([previews.at(-1).info.batch, previews.at(-1).info.row, previews.at(-1).info.adding], [true, 3, false]);
  assert.equal(t._pendingBatch.count, 2, 'Enter would stand the same two');
  t._act(at);
  assert.deepEqual(seatedOf(s).map(c => c.bracketId).sort(), ks.map(k => k.id).sort());
  assert.deepEqual(seatedOf(s).map(c => c.segments.length), [1, 1, 1], 'the one that was there was left as it was');
  assert.deepEqual(fills.at(-1), { n: 2, what: 'bracket standard' });
  s.undo();
  assert.equal(seatedOf(s).length, 1, 'one undo takes the row back');
  // Hovering one that has a standard, SHIFT adds a segment to each that has one.
  s.redo();
  t._onMove(at);
  assert.deepEqual([previews.at(-1).count, previews.at(-1).info.adding], [3, true]);
  t._act(at);
  assert.deepEqual(seatedOf(s).map(c => c.segments.length), [2, 2, 2]);
});

test('with a height to build to, a seated standard is planned to come level with one built from the ground', () => {
  const { s, z, t } = fromAbove();
  t.standardTargetHeightFt = 19.6875; // two long standards from the ground
  const fromGround = t.standardStackPlan().reduce((a, b) => a + b, 0);
  const seatZ = z + BRACKET_SEAT_UP_IN / 12;
  const plan = t.standardStackPlanFrom(seatZ);
  const top = seatZ + plan.reduce((a, b) => a + b, 0);
  assert.ok(plan.length >= 1);
  assert.ok(top <= s.baseOffsetFt() + fromGround + 1e-9, 'no higher than the standards from the ground');
  assert.ok(s.baseOffsetFt() + fromGround - top < 1.7, `and within a segment of them: ${s.baseOffsetFt() + fromGround - top} ft short`);
  // With no height set, or a bracket already above it, it is the one piece chosen in the card.
  t.standardTargetHeightFt = 0;
  assert.deepEqual(t.standardStackPlanFrom(seatZ), [POST]);
  t.standardTargetHeightFt = 3;
  assert.deepEqual(t.standardStackPlanFrom(seatZ), [POST]);
});

test('SHIFT with the Plank tool on a bracket decks the whole row, each bay from one arm to the next', () => {
  const { s, ks, t } = fromAbove();
  const first = s.supportById(arm(ks[0]));
  const side = t._sideFor(first, { x: 3.5, y: -1 });
  const placements = t._plankRunPlacements(first, side);
  assert.equal(placements.length, 2, 'two bays between three brackets');
  assert.deepEqual(placements.map(p => p.ledgerId), [arm(ks[0]), arm(ks[1])]);
  assert.equal(t._batchFillPlanks(first, side), 2);
  assert.equal(s.plankBays().filter(d => d.frame.center.y < 0).length, 2);
  // Asked again from the other end, there is nothing left to deck.
  const last = s.supportById(arm(ks[2]));
  assert.deepEqual(t._plankRunPlacements(last, t._sideFor(last, { x: 10.5, y: -1 })), []);
  // A bay on brackets is held on two sides only, so its boards cannot be turned.
  assert.equal(t._isDecked({ ledgerId: arm(ks[0]), sideSign: side }), true);
});

test('with a ledger between the tips, the boards of a bracket bay can be turned to run out from the face', () => {
  const { s, z, ks, t } = fromAbove({ reachFt: 3 });
  const first = s.supportById(arm(ks[0]));
  const side = t._sideFor(first, { x: 3.5, y: -1.5 });
  assert.deepEqual(t._plankPlacementFor(first, side), { ledgerId: arm(ks[0]), sideSign: side }, 'along the face by default');
  t.plankRunAxis = Math.PI / 2; // boards wanted running front to back
  assert.deepEqual(t._plankPlacementFor(first, side), { ledgerId: arm(ks[0]), sideSign: side }, 'nothing to turn them onto yet');
  const tipLedger = s.addLedger([0, -3, z], [7, -3, z]);
  const turned = t._plankPlacementFor(first, side);
  assert.ok([tipLedger.id, [...s.ledgers.values()].find(l => l.a[1] === 0 && l.b[1] === 0 && Math.min(l.a[0], l.b[0]) === 0).id].includes(turned.ledgerId),
    'now they hang between the face ledger and the tip ledger');
  const deck = s.addPlankOnLedger(turned.ledgerId, turned.sideSign);
  assert.deepEqual([Math.abs(s.plankBays().find(d => d.id === deck.id).frame.along.y)], [1], 'running out from the face');
});

test('braces: the outer row has faces of its own, and a fill round the scaffold leaves the bracket ends alone', () => {
  const { s, ks, t } = fromAbove();
  const legFaces = t._faces().length;
  assert.equal(t._faces().some(f => f.tipRow || f.bracketEnd), false, 'bare tips at one lift take no brace');
  const posts = ks.map(k => s.addStandardOnBracket(k.id, POST));
  const faces = t._faces();
  assert.equal(faces.filter(f => !f.tipRow && !f.bracketEnd).length, legFaces, 'the scaffold\'s own faces are between its legs, as before');
  const row = faces.filter(f => f.tipRow);
  assert.deepEqual(row.map(f => [f.columnIdA, f.columnIdB].sort()).sort(), [[posts[0].id, posts[1].id].sort(), [posts[1].id, posts[2].id].sort()].sort(), 'along the outer row');
  const ends = faces.filter(f => f.bracketEnd);
  assert.equal(ends.length, 3, 'and from each seated standard back to the leg behind it');
  for (const f of ends) close(f.spanFt, 2, 1e-9, 'a bracket long');

  // A brace on the outer row runs from one bracket's tip rosette up the next standard.
  const plan = t._perimeterBracePlan(s.liftZ(LIFT + 2));
  const outer = plan.filter(b => b.face.tipRow);
  assert.equal(outer.length, 2);
  for (const b of outer) assert.deepEqual([Math.min(b.levelA, b.levelB), Math.max(b.levelA, b.levelB)], [LIFT, LIFT + 4]);
  assert.equal(plan.some(b => b.face.bracketEnd), false, 'a fill does not put a brace at every bracket');
  assert.equal(planPerimeterBraces(faces, s.nodes(), { standards: t._legs(), targetZ: s.liftZ(LIFT + 2) }).some(b => b.face.bracketEnd), false);
});

test('Send to beam offers legs only: a standard seated in a bracket is not one', () => {
  const { s, ks, t } = fromAbove();
  const post = s.addStandardOnBracket(ks[0].id, POST);
  assert.equal(t._standardSegments().some(g => g.id === post.id), true, 'a box in Select still takes it');
  assert.equal(t._standardSegments(true).some(g => g.id === post.id), false);
  assert.equal(t._standardSegments(true).length, 6);
  const seg = t._standardSegments().find(g => g.id === post.id);
  close(seg.a[2], s.standardBaseZ(post), 1e-12, 'drawn from its socket, not from the ground');
});
