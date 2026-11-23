// The Block tool as ScaffoldPro's (recipe card, snapping ghost, click to
// place) and R as it works there for side brackets and planks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { ScaffoldState } from '../src/scaffold/workspace/state.js';
import {
  planBlockRecipe, planStandardSegmentsForLift, snapBlockCenter, rotateOffset90, rosettesOnSegment, BLOCK_DEFAULTS,
} from '../src/scaffold/workspace/planning.js';
import { crossPlankPlacement, plankRunAxis, sameRunAxis } from '../src/scaffold/workspace/planks.js';
import { bracketDirections, chooseBracketDirection, runCentroid } from '../src/scaffold/workspace/bracketdirs.js';
import { CATALOG } from '../src/scaffold/workspace/catalog.js';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { Tools } = await import('../src/scaffold/workspace/tools.js');
function toolsFor(state) {
  const el = { addEventListener() {}, removeEventListener() {} };
  return new Tools({ scene: new THREE.Scene(), renderer: { domElement: el }, invalidate() {} }, state);
}
const STD = CATALOG.standards.parts.map(p => p.lengthFt);
const LED = CATALOG.ledgers.parts.map(p => p.lengthFt);
const planFor = (s, recipe) => planBlockRecipe(recipe, {
  liftZ: l => s.liftZ(l), showBaseCollar: s.base.showBaseCollar, standardLengthsFt: STD, ledgerLengthsFt: LED,
});

// --- the recipe --------------------------------------------------------------

test('height is the top working deck: decks every fourth lift beneath it', () => {
  const s = new ScaffoldState({});
  const plan = planFor(s, BLOCK_DEFAULTS); // 7 x 3 x 10 ft, one level
  assert.deepEqual(plan.deckLifts, [4], 'lift 4 is the highest fourth lift under 10 ft');
  assert.ok(s.liftZ(4) <= 10 && s.liftZ(8) > 10);
  assert.equal(plan.requiredLift, 6, 'standards reach two lifts over the deck, for guardrails');
  assert.ok(plan.topLift >= 6);
  assert.ok(plan.ledgerLifts.includes(0) && plan.ledgerLifts.includes(4), 'ledgers at the collar and the deck');
  assert.equal(plan.decks.length, plan.layoutX.bays * plan.layoutY.bays);

  // Lift 12 sits at 20.68 ft: under 20 ft the top two are 4 and 8, under 21 ft 8 and 12.
  assert.ok(s.liftZ(12) > 20 && s.liftZ(12) < 21);
  assert.deepEqual(planFor(s, { ...BLOCK_DEFAULTS, heightFt: 20, plankedLevelsCount: 2 }).deckLifts, [4, 8]);
  assert.deepEqual(planFor(s, { ...BLOCK_DEFAULTS, heightFt: 21, plankedLevelsCount: 2 }).deckLifts, [8, 12], 'counted down from the top');
  const base = planFor(s, { ...BLOCK_DEFAULTS, heightFt: 20, plankedLevelsCount: 9, includeBaseDeck: true });
  assert.equal(base.deckLifts[0], 0, 'a base deck on the collar rosette when asked');
  assert.deepEqual(planFor(s, { ...BLOCK_DEFAULTS, heightFt: 3 }).deckLifts, [], 'no deck fits under 3 ft');
});

test('standards are planned by rosette count with the least overshoot', () => {
  assert.equal(rosettesOnSegment(9.84375), 6);
  assert.equal(rosettesOnSegment(6.5625), 4);
  const segs = planStandardSegmentsForLift(10, STD);
  assert.equal(segs.reduce((n, ft) => n + rosettesOnSegment(ft), 0), 10);
  assert.deepEqual(planStandardSegmentsForLift(6, STD), [9.84375], 'one piece where one will do');
});

test('braces run full height on the faces asked for, slash or backslash', () => {
  const s = new ScaffoldState({});
  const slash = planFor(s, { ...BLOCK_DEFAULTS, heightFt: 20, braceFrontBack: 'slash' });
  const back = planFor(s, { ...BLOCK_DEFAULTS, heightFt: 20, braceFrontBack: 'backslash' });
  assert.ok(slash.braces.length > 0 && slash.braces.every(b => b.normal.x === 0), 'front/back faces');
  const firstFront = list => list.find(b => b.normal.y === -1 && b.lift === 0);
  assert.notEqual(firstFront(slash.braces).a.x, firstFront(back.braces).a.x, 'the two options lean opposite ways');
  assert.equal(planFor(s, BLOCK_DEFAULTS).braces.length, 0, 'off by default, as in ScaffoldPro');
});

test('a quarter turn swaps the footprint', () => {
  assert.deepEqual(rotateOffset90({ x: 3.5, y: 1.5 }, 1), { x: -1.5, y: 3.5 });
  assert.deepEqual(rotateOffset90({ x: 3.5, y: 1.5 }, 4), { x: 3.5, y: 1.5 });
});

// --- snapping and placing ----------------------------------------------------

test('the ghost snaps onto a neighbour\'s face but never on top of it', () => {
  const s = new ScaffoldState({});
  const plan = planFor(s, BLOCK_DEFAULTS); // 7 x 3: corners at (+-3.5, +-1.5)
  const existing = [{ x: 0, y: 0 }, { x: 7, y: 0 }, { x: 0, y: 3 }, { x: 7, y: 3 }];
  const beside = snapBlockCenter({ x: 10.8, y: 1.2 }, plan, 0, existing);
  assert.ok(beside.snapped);
  assert.deepEqual([beside.x, beside.y], [10.5, 1.5], 'shares the x = 7 face');
  const onTop = snapBlockCenter({ x: 3.5, y: 1.5 }, plan, 0, existing);
  assert.ok(!onTop.snapped || Math.hypot(onTop.x - 3.5, onTop.y - 1.5) > 1, 'a full overlap is refused');
  assert.equal(snapBlockCenter({ x: 30, y: 30 }, plan, 0, existing).snapped, false, 'nothing near, no snap');
});

test('placing a block shares the standards already there and is one undo step', () => {
  const s = new ScaffoldState({});
  const tools = toolsFor(s);
  const plan = tools._blockPlan();
  tools.placeBlockAt({ plan, center: { x: 3.5, y: 1.5 }, snapped: false, rotationSteps: 0 });
  assert.equal(s.standards.size, 4);
  const segmentsBefore = [...s.standards.values()].map(x => x.segments.length).join();
  assert.ok(s.ledgers.size > 0 && s.plankBays().length === 1);
  const steps = s._history.length;
  // A second block sharing the x = 7 face.
  tools.placeBlockAt({ plan, center: { x: 10.5, y: 1.5 }, snapped: true, rotationSteps: 0 });
  assert.equal(s.standards.size, 6, 'two new standards, two shared');
  assert.equal([...s.standards.values()].slice(0, 4).map(x => x.segments.length).join(), segmentsBefore, 'shared standards are not stacked on');
  const shared = s.ledgerList().filter(l => l.a[0] === 7 && l.b[0] === 7);
  assert.equal(new Set(shared.map(l => l.a[2])).size, shared.length, 'the shared face keeps one ledger per lift');
  assert.equal(s._history.length, steps + 1, 'one undo step');
  s.undo();
  assert.equal(s.standards.size, 4);
});

test('block standards keep exact bay spacing, off the 1 ft grid', () => {
  const s = new ScaffoldState({ snapStep: 1 });
  const tools = toolsFor(s);
  tools.setBlockSettings({ widthFt: 7, depthFt: 3 });
  tools.placeBlockAt({ plan: tools._blockPlan(), center: { x: 0, y: 0 }, snapped: false, rotationSteps: 1 });
  const xs = [...new Set([...s.standards.values()].map(p => p.x))].sort((a, b) => a - b);
  const ys = [...new Set([...s.standards.values()].map(p => p.y))].sort((a, b) => a - b);
  assert.deepEqual(xs, [-1.5, 1.5], 'turned: the 3 ft side runs along x');
  assert.deepEqual(ys, [-3.5, 3.5]);
});

// --- R for side brackets -------------------------------------------------------

function row(n = 3) {
  const s = new ScaffoldState({ snapStep: 1 });
  for (let i = 0; i < n; i++) { s.addStandard(i * 7, 0, 9.84375); s.addStandard(i * 7, 7, 9.84375); }
  const tools = toolsFor(s);
  for (const level of [2]) tools._batchFillLedgers(level);
  return { s, tools, node: (x, y, l) => s.nodes().find(q => !q.bracketId && q.x === x && q.y === y && q.level === l) };
}

test('a bracket points out of the run, square to it, by default', () => {
  const { s, tools, node } = row();
  assert.deepEqual(tools._bracketDir(node(7, 0, 2)), [0, -1], 'front run: out the front');
  assert.deepEqual(tools._bracketDir(node(7, 7, 2)), [0, 1], 'back run: out the back');
});

test('R steps a bracket round the free directions only', () => {
  const { s, tools, node } = row();
  // A middle standard on the front run has ledgers left, right and back:
  // only the front is free, so R has nowhere else to go.
  const mid = node(7, 0, 2);
  const free = bracketDirections(mid, { ledgers: s.ledgerList(), brackets: [] });
  assert.equal(free.length, 1);
  tools.bracketTurn = 1;
  assert.deepEqual(tools._bracketDir(mid), [0, -1]);
  // A corner has two free directions, and R swaps between them.
  tools.bracketTurn = 0;
  const corner = node(0, 0, 2);
  const first = tools._bracketDir(corner);
  tools.bracketTurn = 1;
  const second = tools._bracketDir(corner);
  tools.bracketTurn = 2;
  assert.notDeepEqual(first, second);
  assert.deepEqual(tools._bracketDir(corner), first, 'and back round');
  // A bracket already hung takes its direction.
  s.addBracket(corner, first, 2);
  tools.bracketTurn = 0;
  assert.deepEqual(tools._bracketDir(corner), second);
});

test('a standard with no ledgers yet offers all four plan directions, outward first', () => {
  const s = new ScaffoldState({});
  s.addStandard(0, 0, 9.84375);
  s.addStandard(20, 0, 9.84375);
  const n = s.nodes().find(q => q.x === 20 && q.level === 2);
  const dirs = bracketDirections(n, { ledgers: [], brackets: [] });
  assert.equal(dirs.length, 4);
  assert.deepEqual(chooseBracketDirection(n, dirs, runCentroid(n, [], [...s.standards.values()]), 0), [1, 0]);
});

// --- R for planks ------------------------------------------------------------

function bay() {
  const s = new ScaffoldState({ snapStep: 1 });
  for (const [x, y] of [[0, 0], [7, 0], [0, 3], [7, 3], [14, 0], [14, 3]]) s.addStandard(x, y, 9.84375);
  const tools = toolsFor(s);
  tools._batchFillLedgers(4);
  const front = s.ledgerList().find(l => l.a[1] === 0 && l.b[1] === 0 && Math.min(l.a[0], l.b[0]) === 0);
  return { s, tools, front };
}

test('the same opening can be decked the other way, off the other pair of ledgers', () => {
  const { s, front } = bay();
  const cross = crossPlankPlacement(front, s.ledgerList(), 1);
  assert.ok(cross, 'a closed bay can turn');
  const crossLedger = s.ledgers.get(cross.ledgerId);
  assert.ok(sameRunAxis(plankRunAxis(crossLedger), 0), 'boards now run along x');
  assert.ok(sameRunAxis(plankRunAxis(front), Math.PI / 2), 'they ran along y');
  // A bay with ledgers on two sides only cannot turn.
  const open = new ScaffoldState({});
  open.addLedger([0, 0, 5], [7, 0, 5]);
  open.addLedger([0, 3, 5], [7, 3, 5]);
  assert.equal(crossPlankPlacement(open.ledgerList()[0], open.ledgerList(), 1), null);
});

test('R turns the boards for the whole lift, and Shift fills the run that way', () => {
  const { s, tools, front } = bay();
  tools.setTool('plank');
  tools._hoverAt = { clientX: 0, clientY: 0 };
  tools._pickLedger = () => ({ ledger: front, point: { x: 3.5, y: 1, z: front.a[2] } });
  const axis = tools.rotate();
  assert.ok(sameRunAxis(axis, 0), 'R: boards along x');
  // The other bay on this lift is decked the same way without its own R.
  const second = s.ledgerList().find(l => l.a[1] === 0 && l.b[1] === 0 && Math.min(l.a[0], l.b[0]) === 7);
  const p = tools._plankPlacementFor(second, 1);
  assert.ok(sameRunAxis(plankRunAxis(s.ledgers.get(p.ledgerId)), 0));
  assert.equal(tools._batchFillPlanks(front, 1), 2, 'both bays');
  for (const d of s.plankBays()) {
    assert.ok(d.boards.every(b => Math.abs(Math.sin(b.rotationZ)) > 0.99), 'boards along x');
  }
  assert.equal(tools._batchFillPlanks(front, 1), 0, 'an opening decked either way is not decked twice');
  // R again turns them back.
  assert.ok(sameRunAxis(tools.rotate(), Math.PI / 2));
});

test('the turned board direction is remembered on other lifts and after a run is placed', () => {
  const { s, tools, front } = bay();
  tools._batchFillLedgers(2);
  tools.setTool('plank');
  tools._hoverAt = { clientX: 0, clientY: 0 };
  tools._pickLedger = () => ({ ledger: front, point: { x: 3.5, y: 1, z: front.a[2] } });
  tools.rotate();
  tools._batchFillPlanks(front, 1);
  // A different lift, never hovered when R was pressed.
  const lower = s.ledgerList().find(l => l.a[1] === 0 && l.b[1] === 0 && Math.min(l.a[0], l.b[0]) === 0 && l.a[2] < front.a[2] - 1);
  const p = tools._plankPlacementFor(lower, 1);
  assert.ok(sameRunAxis(plankRunAxis(s.ledgers.get(p.ledgerId)), 0), 'still along x on the lift below');
  tools.setTool('select'); tools.setTool('plank');
  assert.ok(sameRunAxis(plankRunAxis(s.ledgers.get(tools._plankPlacementFor(lower, 1).ledgerId)), 0), 'and after switching tools');
});
