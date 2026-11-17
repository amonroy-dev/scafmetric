import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ScaffoldState, stateBounds, FIRST_NODE_OFFSET_IN, NODE_SPACING_IN } from '../src/scaffold/workspace/state.js';
import { getStandardBaseOffsetFt, buildBestFitPlankLayout, inchesToFeet, PLANK } from '../src/scaffold/workspace/parts.js';
import { tubeWeightPerFoot, STANDARD_TUBE } from '../src/scaffold/catalog.js';
import { CATALOG, getPart } from '../src/scaffold/workspace/catalog.js';

const SEG = 6.5625; // a 6 ft 7 in standard

test('base stack-up: sill + jack plate + stem + extension + collar', () => {
  // 0.5 sill + 0.375 plate + (2 + 6) stem&extension + 7 collar = 15.875 in
  const withAll = getStandardBaseOffsetFt(6, true, true);
  assert.ok(Math.abs(withAll - 15.875 / 12) < 1e-9, `${withAll}`);
  // no sill, no collar: 0.375 + 2 + 6 = 8.375 in
  const bare = getStandardBaseOffsetFt(6, false, false);
  assert.ok(Math.abs(bare - 8.375 / 12) < 1e-9, `${bare}`);
  // extension raises the standard one-for-one
  assert.ok(Math.abs(getStandardBaseOffsetFt(12, true, true) - getStandardBaseOffsetFt(6, true, true) - 0.5) < 1e-9);
});

test('placing a standard twice on the same column stacks a second segment', () => {
  const s = new ScaffoldState({ snapStep: 1 });
  s.addStandard(0, 0, SEG);
  s.addStandard(0.2, -0.1, SEG); // snaps to (0,0)
  assert.equal(s.standards.size, 1);
  const st = [...s.standards.values()][0];
  assert.equal(st.segments.length, 2);
  assert.ok(Math.abs(s.standardHeightFt(st) - SEG * 2) < 1e-9);
});

test('rosette nodes use the real first offset and spacing', () => {
  const s = new ScaffoldState({ snapStep: 1, jackExtensionIn: 0, showWoodSill: false, showBaseCollar: false });
  s.addStandard(0, 0, SEG);
  const nodes = s.nodes();
  assert.ok(nodes.length >= 3, `expected several nodes, got ${nodes.length}`);
  const base = s.baseOffsetFt();
  assert.ok(Math.abs(nodes[0].z - (base + inchesToFeet(FIRST_NODE_OFFSET_IN))) < 1e-9);
  assert.ok(Math.abs((nodes[1].z - nodes[0].z) - inchesToFeet(NODE_SPACING_IN)) < 1e-9);
  // never above the top of the standard
  const top = s.standardTopZ([...s.standards.values()][0]);
  for (const n of nodes) assert.ok(n.z <= top + 1e-6);
});

test('popSegment removes a lift, then the standard itself', () => {
  const s = new ScaffoldState({ snapStep: 1 });
  const st = s.addStandard(0, 0, SEG);
  s.addStandard(0, 0, SEG);
  s.popSegment(st.id);
  assert.equal([...s.standards.values()][0].segments.length, 1);
  s.popSegment(st.id);
  assert.equal(s.standards.size, 0);
});

test('plank bay is filled with a best-fit mix of 9 in and 6 in boards', () => {
  // 84 in bay = nine 9 in boards (81) + one 6 in would overflow -> 9x9=81, remainder 3 -> no 6
  const slots = buildBestFitPlankLayout(84);
  const covered = slots.reduce((a, s) => a + s.widthIn, 0);
  assert.ok(covered <= 84 && covered >= 84 - PLANK.widthIn, `covered ${covered}`);
  assert.ok(slots.every(s => s.widthIn === 9 || s.widthIn === 6));
  // centred about zero
  const first = slots[0].centerOffsetFt, last = slots[slots.length - 1].centerOffsetFt;
  assert.ok(Math.abs(first + last) < 1e-9, `not centred: ${first} ${last}`);
  // too narrow for any board
  assert.deepEqual(buildBestFitPlankLayout(4), []);
});

test('plank boards span the long side and lay across the short side', () => {
  const s = new ScaffoldState({ snapStep: 1 });
  for (const [x, y] of [[0, 0], [7, 0], [0, 3], [7, 3]]) s.addStandard(x, y, SEG);
  const n = s.nodes().filter(nd => nd.level === 0);
  const a = n.find(p => p.x === 0 && p.y === 0), b = n.find(p => p.x === 7 && p.y === 3);
  const bay = s.addPlank([a.x, a.y, a.z], [b.x, b.y, b.z]);
  const boards = s.plankBoards(bay);
  assert.ok(boards.length > 1, `expected multiple boards, got ${boards.length}`);
  // 7 ft is the long side -> boards are 7 ft long
  for (const bd of boards) assert.ok(Math.abs(bd.lengthFt - 7) < 1e-9);
});

test('takeoff keeps dead and live separate; live = planked area x psf', () => {
  const s = new ScaffoldState({ snapStep: 1, liveLoadPsf: 25, components: { plank: { areaWeightLbPerFt2: 3 } } });
  const b = 7;
  for (const [x, y] of [[0, 0], [b, 0], [0, b], [b, b]]) s.addStandard(x, y, SEG);
  const n0 = s.nodes().find(n => n.x === 0 && n.y === 0 && n.level === 0);
  const n1 = s.nodes().find(n => n.x === b && n.y === b && n.level === 0);
  s.addPlank([n0.x, n0.y, n0.z], [n1.x, n1.y, n1.z]);
  const { legs, totals } = s.takeoff();
  assert.equal(legs.length, 4);
  assert.ok(Math.abs(totals.liveLb - 49 * 25) < 1e-6, `live ${totals.liveLb}`);
  const standardOnly = tubeWeightPerFoot(STANDARD_TUBE) * SEG;
  for (const leg of legs) assert.ok(leg.deadLb >= standardOnly - 1e-9);
});

test('ledger weight splits half to each end column', () => {
  const s = new ScaffoldState({ snapStep: 1, components: { plank: { areaWeightLbPerFt2: 0 } } });
  s.addStandard(0, 0, SEG); s.addStandard(10, 0, SEG);
  const n = s.nodes().filter(nd => nd.level === 0);
  const a = n.find(p => p.x === 0), c = n.find(p => p.x === 10);
  s.addLedger([a.x, a.y, a.z], [c.x, c.y, c.z]);
  const { legs } = s.takeoff();
  const la = legs.find(l => l.x === 0), lb = legs.find(l => l.x === 10);
  assert.ok(Math.abs(la.deadLb - lb.deadLb) < 1e-9, 'symmetric split');
  assert.ok(la.deadLb > tubeWeightPerFoot(s.components.standard) * SEG);
});

test('catalog exposes generic sizes with no part numbers', () => {
  for (const key of Object.keys(CATALOG)) {
    for (const part of CATALOG[key].parts) {
      assert.ok(part.lengthFt > 0, `${part.id} needs a length`);
      assert.ok(!/^U[SHDB]/.test(part.label), `${part.label} looks like a part number`);
    }
  }
  assert.equal(getPart('standards', 'nope').id, CATALOG.standards.parts[0].id); // falls back
});

test('stateBounds spans columns and the top of the tallest stack', () => {
  const s = new ScaffoldState({ snapStep: 1 });
  const a = s.addStandard(0, 0, SEG);
  s.addStandard(14, 7, SEG);
  s.addStandard(0, 0, SEG); // stack a second segment on the first
  const bb = stateBounds(s);
  assert.deepEqual(bb.min, [0, 0, 0]);
  assert.equal(bb.max[0], 14);
  assert.equal(bb.max[1], 7);
  assert.ok(Math.abs(bb.max[2] - s.standardTopZ(a)) < 1e-9);
});

test('clear removes everything', () => {
  const s = new ScaffoldState({ snapStep: 1 });
  s.addStandard(0, 0, SEG);
  s.addLedger([0, 0, 1], [7, 0, 1]);
  s.clear();
  assert.equal(s.standards.size, 0);
  assert.equal(s.ledgers.size, 0);
  assert.equal(stateBounds(s), null);
});

test('undo and redo restore placements', () => {
  const s = new ScaffoldState({ snapStep: 1 });
  s.addStandard(0, 0, SEG);
  s.resetHistory();
  assert.equal(s.canUndo(), false);

  s.addStandard(7, 0, SEG);
  assert.equal(s.standards.size, 2);
  assert.equal(s.canUndo(), true);

  s.undo();
  assert.equal(s.standards.size, 1, 'undo removed the second standard');
  assert.equal(s.canRedo(), true);

  s.redo();
  assert.equal(s.standards.size, 2, 'redo put it back');
});

test('undo restores a cleared model', () => {
  const s = new ScaffoldState({ snapStep: 1 });
  s.addStandard(0, 0, SEG);
  s.addLedger([0, 0, 1], [7, 0, 1]);
  s.resetHistory();
  s.clear();
  assert.equal(s.standards.size, 0);
  s.undo();
  assert.equal(s.standards.size, 1);
  assert.equal(s.ledgers.size, 1);
});

test('undo of a stacked segment drops only that segment', () => {
  const s = new ScaffoldState({ snapStep: 1 });
  const st = s.addStandard(0, 0, SEG);
  s.resetHistory();
  s.addStandard(0, 0, SEG);
  assert.equal(s.standards.get(st.id).segments.length, 2);
  s.undo();
  assert.equal(s.standards.get(st.id).segments.length, 1);
});
