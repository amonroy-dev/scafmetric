// Handrails with the Ledger tool. With "Perimeter handrails" ticked in its card
// the tool keeps to the outside of the scaffold: a click adds one ledger along
// an outside face, and SHIFT adds every one missing round the outside of that
// level, where without the tick it fills every bay of the level. The case it
// was asked for: standards seated in a row of side brackets, railed along the
// row and back to the scaffold at its two ends, with nothing across the decks.
// (ScaffoldPro's ledger placement mode of the same name.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { ScaffoldState, ARM_PREFIX } from '../src/scaffold/workspace/state.js';
import { liftBayEdges, outsideEdgeKeys, planLiftOutline, bayEdgeKey, BLOCK_DEFAULTS } from '../src/scaffold/workspace/planning.js';
import { deriveBom } from '../src/scaffold/workspace/bom.js';
import { tubeWeightPerFoot } from '../src/scaffold/catalog.js';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { Tools } = await import('../src/scaffold/workspace/tools.js');
function toolsFor(state, hooks = {}) {
  const el = { addEventListener() {}, removeEventListener() {} };
  return new Tools({ scene: new THREE.Scene(), renderer: { domElement: el }, invalidate() {} }, state, hooks);
}

const SEG = 9.84375;  // the long standard: six rosettes
const POST = 3.28125; // the 1 m standard: two rosettes, the two rails' heights

// --- the outside of a lift, as plain geometry ---------------------------------

/** Nodes of one lift at these plan points. */
const lift = points => points.map(([x, y], i) => ({ x, y, z: 0, level: 1, columnId: `c${i}` }));
function grid(nx, ny, dx = 7, dy = 5) {
  const pts = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) pts.push([i * dx, j * dy]);
  return lift(pts);
}
const ends = e => [[e.a.x, e.a.y], [e.b.x, e.b.y]].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
/** The outside edges as "x,y-x,y" strings, to a hundredth, sorted. */
const outsideOf = nodes => {
  const edges = liftBayEdges(nodes);
  const outside = outsideEdgeKeys(edges);
  return edges.filter(e => outside.has(e.key)).map(e => ends(e).map(p => p.map(v => Math.round(v * 100) / 100).join(',')).join('-')).sort();
};

test('the outside of a grid of bays is its outline', () => {
  const nodes = grid(4, 3); // three bays by two
  const edges = liftBayEdges(nodes);
  assert.equal(edges.length, 17, 'nine along the rows and eight across');
  assert.equal(new Set(edges.map(e => e.key)).size, 17, 'each once');
  const outside = outsideEdgeKeys(edges);
  assert.equal(outside.size, 10, 'three along each long side, two up each end');
  for (const e of edges) {
    const [[ax, ay], [bx, by]] = ends(e);
    const onOutline = (ay === by && (ay === 0 || ay === 10)) || (ax === bx && (ax === 0 || ax === 21));
    assert.equal(outside.has(e.key), onOutline, `${ax},${ay} to ${bx},${by}`);
  }
});

test('a single row is all outside, and one bay deep only the end ledgers are', () => {
  assert.equal(outsideOf(grid(4, 1)).length, 3, 'no bays, so nothing is inside');
  const deep = outsideOf(grid(4, 2));
  assert.deepEqual(deep, [
    '0,0-0,5', '0,0-7,0', '0,5-7,5', '14,0-21,0', '14,5-21,5', '21,0-21,5', '7,0-14,0', '7,5-14,5',
  ], 'the two rows and the two ends; the ledgers across at 7 and 14 ft have a bay each side');
});

test('turned in plan the outline is the same edges', () => {
  const square = grid(4, 3);
  const a = Math.PI / 6;
  const turned = square.map(n => ({ ...n, x: n.x * Math.cos(a) - n.y * Math.sin(a), y: n.x * Math.sin(a) + n.y * Math.cos(a) }));
  const keysOf = nodes => { const edges = liftBayEdges(nodes); const out = outsideEdgeKeys(edges); return [edges.length, [...out].sort()]; };
  assert.deepEqual(keysOf(turned), keysOf(square));
});

test('a corner cut out of the footprint has its two inside faces on the outside', () => {
  // Three 7 ft bays in an L: the bay at the top right is missing.
  const nodes = lift([[0, 0], [7, 0], [14, 0], [0, 7], [7, 7], [14, 7], [0, 14], [7, 14]]);
  const outside = outsideOf(nodes);
  assert.equal(outside.length, 8);
  assert.ok(outside.includes('7,7-14,7') && outside.includes('7,7-7,14'), 'the two faces of the notch');
  assert.ok(!outside.includes('0,7-7,7') && !outside.includes('7,0-7,7'), 'the two ledgers between bays are inside');
});

test('a pair turned down as no bay opens the faces either side of it', () => {
  // Two runs of two bays, 4 ft apart. Read as geometry alone, the gap is a row of bays.
  const nodes = lift([[0, 0], [7, 0], [14, 0], [0, 3], [7, 3], [14, 3], [0, 7], [7, 7], [14, 7], [0, 10], [7, 10], [14, 10]]);
  assert.ok(!outsideOf(nodes).includes('0,3-7,3'), 'the face onto the gap reads as inside');
  const acrossGap = (a, b) => (a.y === 3 && b.y === 7) || (a.y === 7 && b.y === 3);
  const outline = planLiftOutline(nodes, undefined, (a, b) => !acrossGap(a, b));
  assert.equal(outline.edges.length, 14, 'seven a run');
  const key = (p, q) => bayEdgeKey(nodes.find(n => n.x === p[0] && n.y === p[1]), nodes.find(n => n.x === q[0] && n.y === q[1]));
  assert.ok(outline.outside.has(key([0, 3], [7, 3])) && outline.outside.has(key([0, 7], [7, 7])), 'both faces onto the gap are outside');
  assert.ok(!outline.outside.has(key([7, 0], [7, 3])), 'the ledger between a run\'s two bays is still inside');
  // And the two runs are two scaffolds.
  const group = n => outline.group.get(n.columnId);
  assert.equal(new Set(nodes.filter(n => n.y <= 3).map(group)).size, 1);
  assert.notEqual(group(nodes[0]), group(nodes[11]));
});

// --- the Ledger tool ------------------------------------------------------------

/**
 * A 21 x 5 ft block decked at lift 4 (three bays, eight legs), a 2 ft side
 * bracket on each front leg (or only the first `brackets` of them) at the
 * deck, the brackets decked, and a 1 m standard in each bracket.
 */
function bracketedBlock({ guardrails = true, brackets = 4 } = {}) {
  const s = new ScaffoldState({});
  const tools = toolsFor(s);
  tools.blockSettings = { ...BLOCK_DEFAULTS, widthFt: 21, depthFt: 5, heightFt: 10, guardrails };
  const plan = tools._blockPlan();
  tools.placeBlockAt({ plan, center: { x: 10.5, y: 2.5 }, snapped: false, rotationSteps: 0 });
  const deck = plan.deckLifts[plan.deckLifts.length - 1];
  const z = s.liftZ(deck);
  const ks = [0, 7, 14, 21].slice(0, brackets).map(x => s.addBracket({ x, y: 0, z }, [0, -1], 2));
  for (const k of ks.slice(0, -1)) assert.ok(s.addPlankOnLedger(`${ARM_PREFIX}${k.id}`, 1) || s.addPlankOnLedger(`${ARM_PREFIX}${k.id}`, -1));
  for (const k of ks) assert.ok(s.addStandardOnBracket(k.id, POST));
  return { s, tools, deck, ks };
}
const nodeAt = (s, x, y, level) => s.nodes().find(n => !n.bracketId && Math.abs(n.x - x) < 1e-6 && Math.abs(n.y - y) < 1e-6 && n.level === level);
const named = plan => plan.map(e => ends(e).map(p => p.join(',')).join(' to ')).sort();
const ROW_AND_RETURNS = ['0,-2 to 0,0', '0,-2 to 7,-2', '14,-2 to 21,-2', '21,-2 to 21,0', '7,-2 to 14,-2'];

test('SHIFT with Perimeter handrails rails the row of bracket standards and its two ends, and nothing else', () => {
  const { s, tools, deck } = bracketedBlock();
  assert.equal(deck, 4);
  const from = nodeAt(s, 7, -2, deck + 1);
  assert.ok(from, 'the seated standards have a rosette one lift above the deck');

  // Without the tick: every open bay edge of the level, nine of them, four across the bracket decks.
  const all = named(tools._ledgerFillPlan(from));
  assert.equal(all.length, 9);
  assert.ok(all.includes('7,-2 to 7,0') && all.includes('7,0 to 7,5'), 'ledgers across the decks at rail height');

  tools.setPerimeterHandrails(true);
  assert.deepEqual(named(tools._ledgerFillPlan(from)), ROW_AND_RETURNS);

  const before = s.ledgers.size;
  assert.equal(tools._batchFillLedgers(from.level, from), 5);
  assert.equal(s.ledgers.size, before + 5);
  assert.deepEqual(named(tools._ledgerFillPlan(nodeAt(s, 7, -2, deck + 1))), [], 'a second fill finds nothing');

  // The top rail, one lift up. The rails just built must not change what
  // counts as outside: the brackets still close a bay each between them.
  const top = nodeAt(s, 14, -2, deck + 2);
  assert.deepEqual(named(tools._ledgerFillPlan(top)), ROW_AND_RETURNS);
  tools._batchFillLedgers(top.level, top);
  assert.equal(s.ledgers.size, before + 10);
  s.undo();
  assert.equal(s.ledgers.size, before + 5, 'one fill is one undo');
});

test('the fill lays nothing over the rails a block put round its deck', () => {
  const { s, tools, deck } = bracketedBlock();
  const rails = [...s.guardrails.values()].filter(g => g.kind === 'rail');
  assert.equal(rails.length, 8, 'two rails down each of the four sides');
  const a = nodeAt(s, 7, 5, deck + 1), b = nodeAt(s, 14, 5, deck + 1);
  assert.equal(tools._ledgerExists(a, b), true, 'the back rail runs past both rosettes: that bay edge has its member');
  assert.equal(tools._ledgerExists(nodeAt(s, 7, 5, deck + 2), nodeAt(s, 14, 5, deck + 2)), true, 'and so does the top rail, a lift up');
  assert.equal(tools._ledgerExists(nodeAt(s, 7, 5, deck - 1), nodeAt(s, 14, 5, deck - 1)), false, 'a lift with neither rail nor ledger on it is open');
  assert.equal(tools._ledgerExists(nodeAt(s, 7, 5, deck), nodeAt(s, 7, 0, deck)), true, 'a ledger is still a ledger');
  assert.equal(tools._ledgerExists(nodeAt(s, 7, 0, deck + 1), nodeAt(s, 7, 5, deck + 1)), false, 'no rail across the deck');

  // Every bay, the old fill: it used to add seventeen here, eight of them on top of the rails.
  const from = nodeAt(s, 7, 0, deck + 1);
  for (const e of tools._ledgerFillPlan(from)) {
    const [[ax, ay], [bx, by]] = ends(e);
    const underRail = (ay === by && (ay === 0 || ay === 5)) || (ax === bx && (ax === 0 || ax === 21) && ay >= 0);
    assert.equal(underRail, false, `${ax},${ay} to ${bx},${by} is where a rail already is`);
  }
  // The rails that "Add to decks" stands on posts of their own are not on the rosettes, and take no bay edge.
  s.generateGuardrails();
  assert.equal(tools._ledgerExists(nodeAt(s, 7, 5, deck + 1), nodeAt(s, 14, 5, deck + 1)), false);
});

test('with no rails round the deck the fill goes round the whole outline', () => {
  const { s, tools, deck } = bracketedBlock({ guardrails: false });
  tools.setPerimeterHandrails(true);
  const plan = named(tools._ledgerFillPlan(nodeAt(s, 7, -2, deck + 1)));
  assert.deepEqual(plan, [...ROW_AND_RETURNS, '0,0 to 0,5', '0,5 to 7,5', '14,5 to 21,5', '21,0 to 21,5', '7,5 to 14,5'].sort());
  assert.ok(!plan.some(p => /,0 to \d+,0$/.test(p)), 'nothing along the face between the scaffold\'s deck and the brackets\'');
});

test('a row of brackets on part of a face gets a return where it stops', () => {
  const { s, tools, deck } = bracketedBlock({ brackets: 3 });
  tools.setPerimeterHandrails(true);
  assert.deepEqual(named(tools._ledgerFillPlan(nodeAt(s, 7, -2, deck + 1))), ['0,-2 to 0,0', '0,-2 to 7,-2', '14,-2 to 14,0', '7,-2 to 14,-2']);
  // The face beyond the brackets is still outside; there the block's rail is the handrail.
  assert.equal(tools.isOutsideNode(nodeAt(s, 21, 0, deck + 1)), true);
  assert.equal(tools.ledgerTargetFor(nodeAt(s, 21, 0, deck + 1)), null);
});

test('a click adds the one handrail along an outside face, and none from a rosette inside', () => {
  const { s, tools, deck } = bracketedBlock();
  tools.setPerimeterHandrails(true);
  const level = deck + 1;
  const to = (x, y) => { const t = tools.ledgerTargetFor(nodeAt(s, x, y, level)); return t ? [t.x, t.y] : null; };
  assert.deepEqual(to(0, -2), [0, 0], 'from the end of the row: the short return to the scaffold');
  assert.deepEqual(to(7, -2), [0, -2], 'from the middle of it: along the row');
  assert.deepEqual(to(0, 0), [0, -2]);
  assert.equal(to(7, 0), null, 'between the two decks every edge is inside or railed');
  assert.equal(to(7, 5), null, 'the back face has the block\'s rail');
  assert.equal(tools.isOutsideNode(nodeAt(s, 7, 0, level)), false);
  assert.equal(tools.isOutsideNode(nodeAt(s, 7, -2, level)), true);

  tools.setPerimeterHandrails(false);
  assert.deepEqual(to(7, 0), [7, -2], 'without the tick the nearest open neighbour, across the bracket deck');
});

test('two runs standing 4 ft apart are railed one at a time, gap faces and all', () => {
  const s = new ScaffoldState({ snapStep: 0 });
  const rows = [0, 3, 7, 10];
  for (const y of rows) for (const x of [0, 7, 14]) s.addStandard(x, y, SEG);
  const z = s.liftZ(4);
  for (const [y0, y1] of [[0, 3], [7, 10]]) {
    for (const x of [0, 7, 14]) s.addLedger([x, y0, z], [x, y1, z]);
    for (const y of [y0, y1]) for (const x of [0, 7]) s.addLedger([x, y, z], [x + 7, y, z]);
  }
  const tools = toolsFor(s);
  tools.setPerimeterHandrails(true);
  const near = named(tools._ledgerFillPlan(nodeAt(s, 0, 0, 5)));
  assert.deepEqual(near, ['0,0 to 0,3', '0,0 to 7,0', '0,3 to 7,3', '14,0 to 14,3', '7,0 to 14,0', '7,3 to 14,3'], 'this run only, its face onto the gap included');
  assert.equal(tools._batchFillLedgers(5, nodeAt(s, 0, 0, 5)), 6);
  assert.equal(named(tools._ledgerFillPlan(nodeAt(s, 0, 10, 5))).length, 6, 'the other run is still to do');

  // Bare standards have no ledgers to say which are bays: standing next to each other is all there is.
  const bare = new ScaffoldState({ snapStep: 0 });
  for (const y of [0, 5]) for (const x of [0, 7, 14]) bare.addStandard(x, y, SEG);
  const t2 = toolsFor(bare);
  t2.setPerimeterHandrails(true);
  assert.equal(t2._ledgerFillPlan(nodeAt(bare, 0, 0, 3)).length, 6, 'the outline of the two bays');
});

test('the fill says what it added, and a level alone is still every bay', () => {
  const said = [];
  const { s, deck } = bracketedBlock();
  const tools = toolsFor(s, { onBulkFill: (n, what) => said.push([n, what]) });
  tools.setPerimeterHandrails(true);
  tools._batchFillLedgers(deck + 1, nodeAt(s, 7, -2, deck + 1));
  assert.deepEqual(said.pop(), [5, 'handrail']);
  // Called with a level and no rosette (as the tests of other tools do) it fills every bay.
  const before = s.ledgers.size;
  tools._batchFillLedgers(deck + 2);
  assert.deepEqual(said.pop(), [9, 'ledger']);
  assert.equal(s.ledgers.size, before + 9);
});

test('handrails are ledgers: on the parts list, and their weight down the legs', () => {
  const { s, tools, deck } = bracketedBlock();
  const legsLb = () => s.takeoff().legs.reduce((sum, l) => sum + l.deadLb, 0);
  const bom0 = deriveBom(s), legs0 = legsLb();
  tools.setPerimeterHandrails(true);
  for (const level of [deck + 1, deck + 2]) tools._batchFillLedgers(level, nodeAt(s, 7, -2, level));
  const bom1 = deriveBom(s);
  const ledgers = bom => bom.lineItems.filter(r => r.category === 'Ledgers').reduce((n, r) => n + r.quantity, 0);
  assert.equal(ledgers(bom1) - ledgers(bom0), 10, 'three 7 ft and two 2 ft at each of the two rails');
  const addedLb = 2 * (3 * 7 + 2 * 2) * tubeWeightPerFoot(s.components.ledger);
  assert.ok(Math.abs((bom1.summary.totalWeightLb - bom0.summary.totalWeightLb) - addedLb) < 0.05, 'weighed as ledgers');
  assert.ok(Math.abs((legsLb() - legs0) - addedLb) < 1e-6, 'and all of it comes down the legs');
  assert.ok(s.takeoff().legs.every(l => Number.isFinite(l.deadLb) && Number.isFinite(l.liveLb)));
});

test('a block placed afterwards lays no rail over a handrail, and drops the one between the two decks', () => {
  const { s, tools, deck } = bracketedBlock();
  tools.setPerimeterHandrails(true);
  for (const level of [deck + 1, deck + 2]) tools._batchFillLedgers(level, nodeAt(s, 7, -2, level));
  const z1 = s.liftZ(deck + 1);
  const railsAt = (pred) => [...s.guardrails.values()].filter(g => g.kind === 'rail' && Math.abs(g.a[2] - z1) < 1e-6 && pred(g));
  assert.equal(railsAt(g => g.a[1] === 0 && g.b[1] === 0).length, 1, 'the block\'s rail along the face the brackets hang on is still there');

  // A second block of the same height on the right-hand end: the rails round that deck height are laid again.
  tools.placeBlockAt({ plan: tools._blockPlan(), center: { x: 31.5, y: 2.5 }, snapped: false, rotationSteps: 0 });
  assert.equal(railsAt(g => g.a[1] === 0 && g.b[1] === 0 && Math.min(g.a[0], g.b[0]) < 21 - 1e-6).length, 0, 'no rail left between the scaffold\'s deck and the brackets\'');
  assert.equal(railsAt(g => g.a[1] === -2 && g.b[1] === -2).length, 0, 'none along the row of bracket standards: the ledgers there are the rail');
  assert.equal(railsAt(g => g.a[0] === 0 && g.b[0] === 0).length, 1, 'the left end is railed');
  const leftEnd = railsAt(g => g.a[0] === 0 && g.b[0] === 0)[0];
  assert.deepEqual([Math.min(leftEnd.a[1], leftEnd.b[1]), Math.max(leftEnd.a[1], leftEnd.b[1])], [0, 5], 'from the scaffold\'s front leg back, not over the 2 ft return');
  // Nothing doubled: no bay edge at the rail's lift has both a ledger and a rail.
  for (const l of s.ledgers.values()) {
    if (Math.abs(l.a[2] - z1) > 1e-6) continue;
    const a = { x: l.a[0], y: l.a[1] }, b = { x: l.b[0], y: l.b[1] };
    const under = railsAt(g => {
      const horizontal = g.a[1] === g.b[1];
      const on = p => (horizontal ? Math.abs(p.y - g.a[1]) < 0.05 && p.x >= Math.min(g.a[0], g.b[0]) - 0.05 && p.x <= Math.max(g.a[0], g.b[0]) + 0.05
        : Math.abs(p.x - g.a[0]) < 0.05 && p.y >= Math.min(g.a[1], g.b[1]) - 0.05 && p.y <= Math.max(g.a[1], g.b[1]) + 0.05);
      return on(a) && on(b);
    });
    assert.equal(under.length, 0, `ledger ${a.x},${a.y} to ${b.x},${b.y} has a rail on top of it`);
  }
});
