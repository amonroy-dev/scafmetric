// SHIFT fills that have to understand the shape of the scaffold: braces round
// the whole perimeter of a footprint that is not one straight run, and side
// brackets along a run. Also Shift and R reaching the tool while a dropdown in
// the tool's card still has the keyboard focus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import {
  buildFaceGraph, buildBays, perimeterFaces, isPerimeterFace, planPerimeterBraces, faceKey,
} from '../src/scaffold/workspace/braces.js';
import {
  bracketRunRow, rosetteAtHeight, alignedBracketDirection, bracketDirections, ROSETTE_LEVEL_TOLERANCE_FT,
} from '../src/scaffold/workspace/bracketdirs.js';
import { ScaffoldState } from '../src/scaffold/workspace/state.js';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { Tools } = await import('../src/scaffold/workspace/tools.js');

const SEG = 9.84375;
const W = 800, H = 600;

/** Standards at these plan points, with a ledger between every adjacent pair at each lift given. */
function scaffold(points, lifts = [4]) {
  const s = new ScaffoldState({ snapStep: 0 });
  for (const [x, y] of points) s.addStandard(x, y, SEG);
  for (const lift of lifts) {
    const z = s.liftZ(lift);
    for (const a of points) for (const b of points) {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      // Each bay edge once: 7 ft along x, or 3 ft (or 7 ft) along y.
      if ((dy === 0 && dx === 7) || (dx === 0 && (dy === 3 || dy === 7))) s.addLedger([a[0], a[1], z], [b[0], b[1], z]);
    }
  }
  return s;
}

/**
 * Two runs of four 7 x 3 ft bays, the second stepped a bay's depth forward so
 * they meet at the one standard at (28, 0): a zig-zag in plan.
 */
const ZIGZAG = [];
for (let i = 0; i <= 4; i++) for (const y of [0, 3]) ZIGZAG.push([i * 7, y]);
for (let i = 4; i <= 8; i++) for (const y of [-3, 0]) if (!(i === 4 && y === 0)) ZIGZAG.push([i * 7, y]);

const standardsOf = s => [...s.standards.values()];
const midOf = f => [(f.ax + f.bx) / 2, (f.ay + f.by) / 2];
const has = (faces, x, y) => faces.some(f => { const [mx, my] = midOf(f); return Math.abs(mx - x) < 1e-6 && Math.abs(my - y) < 1e-6; });

test('a bay is four standards with a face on each side', () => {
  const s = scaffold([[0, 0], [7, 0], [14, 0], [0, 3], [7, 3], [14, 3]]);
  const faces = buildFaceGraph(standardsOf(s));
  assert.equal(faces.length, 7, 'two along each row, and the three across');
  const bays = buildBays(faces);
  assert.equal(bays.length, 2, 'two bays side by side');
  assert.deepEqual(bays.map(b => [b.cx, b.cy]).sort((p, q) => p[0] - q[0]), [[3.5, 1.5], [10.5, 1.5]]);
  for (const b of bays) assert.equal(new Set(b.faceKeys).size, 4);

  // The face they share has a bay each side; every other face has one.
  const shared = faces.find(f => Math.abs(midOf(f)[0] - 7) < 1e-9 && Math.abs(midOf(f)[1] - 1.5) < 1e-9);
  assert.equal(isPerimeterFace(shared, faces), false);
  assert.equal(perimeterFaces(faces).length, 6);
  assert.equal(faceKey('S2', 'S1'), faceKey('S1', 'S2'), 'a face has one name, whichever way round');
});

test('the whole outside of a zig-zag is perimeter, and only the outside', () => {
  const s = scaffold(ZIGZAG);
  assert.equal(s.standards.size, 19, 'the two runs share one standard');
  const faces = buildFaceGraph(standardsOf(s));
  assert.equal(faces.length, 26);
  assert.equal(buildBays(faces).length, 8, 'four bays a run');

  const outside = perimeterFaces(faces);
  assert.equal(outside.length, 20, 'eight faces each side of each run, less the six between bays');
  // The side of each run that looks at the other run was the part left out.
  for (const x of [3.5, 10.5, 17.5, 24.5]) {
    assert.ok(has(outside, x, 0), `front of the first run at x ${x}`);
    assert.ok(has(outside, x, 3), `back of the first run at x ${x}`);
  }
  for (const x of [31.5, 38.5, 45.5, 52.5]) {
    assert.ok(has(outside, x, 0), `back of the second run at x ${x}`);
    assert.ok(has(outside, x, -3), `front of the second run at x ${x}`);
  }
  // The step between the runs, and the far ends.
  for (const [x, y] of [[28, 1.5], [28, -1.5], [0, 1.5], [56, -1.5]]) assert.ok(has(outside, x, y), `end face at ${x}, ${y}`);
  // The faces between two bays of one run are not.
  for (const [x, y] of [[7, 1.5], [14, 1.5], [21, 1.5], [35, -1.5], [42, -1.5], [49, -1.5]]) assert.equal(has(outside, x, y), false, `between bays at ${x}, ${y}`);
});

test('an L is braced all round as well', () => {
  // Five 7 ft square bays: three in a row, two more turning up from the end.
  const cells = [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2]];
  const points = new Map();
  for (const [i, j] of cells) for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 1]]) points.set(`${i + di},${j + dj}`, [(i + di) * 7, (j + dj) * 7]);
  const s = scaffold([...points.values()]);
  const faces = buildFaceGraph(standardsOf(s));
  assert.equal(buildBays(faces).length, 5);
  assert.equal(perimeterFaces(faces).length, 12, 'the outline of the L');
  assert.equal(faces.length - perimeterFaces(faces).length, 4, 'and the four faces between its bays');
});

test('SHIFT plans a brace on every perimeter face of the zig-zag', () => {
  const s = scaffold(ZIGZAG);
  const plan = planPerimeterBraces(buildFaceGraph(standardsOf(s)), s.nodes(), {
    standards: standardsOf(s), direction: 'ascending', targetZ: s.liftZ(2),
  });
  assert.equal(plan.length, 20);
  const every2nd = planPerimeterBraces(buildFaceGraph(standardsOf(s)), s.nodes(), {
    standards: standardsOf(s), direction: 'ascending', targetZ: s.liftZ(2), nthBay: 2,
  });
  assert.ok(every2nd.length >= 9 && every2nd.length <= 11, `every second bay, got ${every2nd.length}`);
});

// --- side brackets along a run ---------------------------------------------

test('a run is walked both ways along the ledgers and stops at a corner', () => {
  const s = scaffold(ZIGZAG);
  const ledgers = s.ledgerList(), standards = standardsOf(s);
  // From the middle of the first run's back row, along x.
  const row = bracketRunRow({ x: 14, y: 3 }, 0, ledgers, standards);
  assert.deepEqual(row.map(p => [p.x, p.y]), [[0, 3], [7, 3], [14, 3], [21, 3], [28, 3]], 'the whole row, in order, and no further');
  // Pointing the other way along the run gives the same row.
  assert.deepEqual(bracketRunRow({ x: 14, y: 3 }, Math.PI, ledgers, standards).map(p => p.x).sort((a, b) => a - b), [0, 7, 14, 21, 28]);
  // The line y = 0 carries both runs end to end, so its row is all nine standards.
  assert.equal(bracketRunRow({ x: 7, y: 0 }, 0, ledgers, standards).length, 9);
  // Across the scaffold a run is just the two standards of a bay end.
  assert.deepEqual(bracketRunRow({ x: 7, y: 0 }, Math.PI / 2, ledgers, standards).map(p => p.y), [0, 3]);
  assert.deepEqual(bracketRunRow({ x: 99, y: 99 }, 0, ledgers, standards), [], 'not a standard');
});

test('the rosette at a height, and the direction that faces the same way', () => {
  const nodes = [{ z: 2.9 }, { z: 4.6 }, { z: 6.2 }];
  assert.equal(rosetteAtHeight(nodes, 4.5).z, 4.6);
  assert.equal(rosetteAtHeight(nodes, 7.5), null, 'none within reach: that standard stops short');
  assert.ok(ROSETTE_LEVEL_TOLERANCE_FT < 1.64, 'less than one rosette spacing, so never the lift above or below');

  const dirs = [{ angle: 0 }, { angle: Math.PI / 2 }, { angle: Math.PI }];
  assert.deepEqual(alignedBracketDirection(dirs, Math.PI / 2 + 0.1), [0, 1]);
  assert.equal(alignedBracketDirection(dirs, -Math.PI / 2), null, 'nothing free faces that way');
});

function toolsFor(state) {
  const cam = new THREE.OrthographicCamera(-20, 20, 15, -15, 0.1, 500);
  cam.up.set(0, 1, 0);
  cam.position.set(14, 0, 100);
  cam.lookAt(14, 0, 0);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  const el = { addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) };
  const engine = {
    scene: new THREE.Scene(), renderer: { domElement: el }, camera: cam, invalidate() {},
    pointer: new THREE.Vector2(), raycaster: new THREE.Raycaster(),
    setPointerFromEvent(e) { this.pointer.set((e.clientX / W) * 2 - 1, -(e.clientY / H) * 2 + 1); },
    // The rosette under the pointer is whichever one the test put there.
    hovered: null,
    pick() { return this.hovered ? { object: { userData: { node: this.hovered } } } : null; },
  };
  const calls = { preview: [], bulk: [] };
  const t = new Tools(engine, state, {
    getNodeMeshes: () => [], getContentMeshes: () => [],
    onPreview: (tool, count, info) => calls.preview.push({ tool, count, info }),
    onBulkFill: (n, label) => calls.bulk.push({ n, label }),
  });
  return { t, engine, calls };
}

test('SHIFT hangs a bracket on every standard along the run, all facing the same way', async () => {
  const { CATALOG } = await import('../src/scaffold/workspace/catalog.js');
  const s = scaffold(ZIGZAG);
  const { t, engine, calls } = toolsFor(s);
  t.setCatalog('brackets', CATALOG.brackets.parts[0].id);
  assert.equal(t.tool, 'bracket');

  // The rosette at the deck lift on the first run's back row, mid run.
  const z = s.liftZ(4);
  const node = s.nodes().find(n => n.x === 14 && n.y === 3 && Math.abs(n.z - z) < 1e-6);
  engine.hovered = node;
  const e = { clientX: 400, clientY: 300, shiftKey: false, buttons: 0 };

  t._onMove(e);
  assert.equal(calls.preview.at(-1).count, 1, 'one bracket without Shift');
  assert.deepEqual(calls.preview.at(-1).info.dir, [0, 1], 'pointing out of the back of the run');

  t._onMove({ ...e, shiftKey: true });
  const preview = calls.preview.at(-1);
  assert.deepEqual([preview.count, preview.info.batch, preview.info.walked], [5, true, 5], 'the five standards of that row');
  assert.equal(t._pendingBatch.count, 5, 'Enter would hang the same five');
  assert.ok(t.ghostGroup.children.length > 0);

  t._act({ ...e, shiftKey: true });
  const hung = [...s.brackets.values()];
  assert.equal(hung.length, 5);
  assert.deepEqual(hung.map(b => b.x).sort((a, b) => a - b), [0, 7, 14, 21, 28]);
  assert.ok(hung.every(b => b.y === 3 && Math.abs(b.z - z) < 1e-6), 'all on that row, at that height');
  assert.ok(hung.every(b => b.dir[0] === 0 && b.dir[1] === 1), 'all facing the way the hovered one does');
  assert.deepEqual(calls.bulk.at(-1), { n: 5, label: 'bracket' });

  s.undo();
  assert.equal(s.brackets.size, 0, 'one undo takes the whole row back');
});

test('a rosette already taken that way is passed over; the rest of the row is still hung', async () => {
  const { CATALOG } = await import('../src/scaffold/workspace/catalog.js');
  const s = scaffold(ZIGZAG);
  const { t, engine, calls } = toolsFor(s);
  t.setCatalog('brackets', CATALOG.brackets.parts[0].id);
  const z = s.liftZ(4);
  const at = x => s.nodes().find(n => n.x === x && n.y === 3 && Math.abs(n.z - z) < 1e-6);
  s.addBracket(at(21), [0, 1], 2);

  engine.hovered = at(7);
  const e = { clientX: 400, clientY: 300, shiftKey: true, buttons: 0 };
  t._onMove(e);
  assert.deepEqual([calls.preview.at(-1).count, calls.preview.at(-1).info.walked], [4, 5], 'four of the five');
  t._act(e);
  assert.equal(s.brackets.size, 5, 'the four new ones, and the one that was there');
  assert.equal([...s.brackets.values()].filter(b => b.x === 21).length, 1, 'never two on one rosette the same way');
  // The directions left on a rosette exclude the one just used.
  assert.equal(bracketDirections(at(7), { ledgers: s.ledgerList(), brackets: [...s.brackets.values()] }).some(d => Math.abs(d.angle - Math.PI / 2) < 0.01), false);
});

// --- Shift and R while a dropdown in the card has the focus ------------------

test('with the pointer on the canvas, Shift and R reach the tool even from a focused field', async () => {
  const { CATALOG } = await import('../src/scaffold/workspace/catalog.js');
  const s = scaffold(ZIGZAG);
  const { t, engine, calls } = toolsFor(s);
  t.setCatalog('brackets', CATALOG.brackets.parts[0].id);
  engine.hovered = s.nodes().find(n => n.x === 14 && n.y === 3 && Math.abs(n.z - s.liftZ(4)) < 1e-6);
  const dropdown = { tagName: 'SELECT' };
  const key = (k, target) => { const e = { key: k, target, repeat: false, prevented: false, preventDefault() { this.prevented = true; } }; t._key(e); return e; };

  // The pointer is over the card: a key in its dropdown is the dropdown's own.
  assert.equal(t.claimsKey({ key: 'Shift' }), false);
  key('Shift', dropdown);
  assert.equal(t.shiftHeld, false, 'Shift in a field, pointer off the canvas: typing');
  const turnBefore = t.bracketTurn;
  key('r', dropdown);
  assert.equal(t.bracketTurn, turnBefore, 'R in a field, pointer off the canvas: typing');

  // The pointer moves out over the scaffold; the dropdown still has the focus.
  t._onMove({ clientX: 400, clientY: 300, shiftKey: false, buttons: 0 });
  assert.equal(calls.preview.at(-1).count, 1);
  assert.equal(t.claimsKey({ key: 'Shift' }), true);
  key('Shift', dropdown);
  assert.equal(t.shiftHeld, true);
  assert.equal(calls.preview.at(-1).count, 5, 'the whole run previews at once, without the mouse moving');

  const r = key('r', dropdown);
  assert.equal(t.bracketTurn, turnBefore + 1, 'R turns the bracket');
  assert.equal(r.prevented, true, 'and the dropdown does not also take the letter');

  // Enter belongs to the tool only while a fill is waiting; Delete never does.
  assert.equal(t.claimsKey({ key: 'Enter' }), !!t._pendingBatch);
  assert.equal(t.claimsKey({ key: 'Delete' }), false);
  assert.equal(t.claimsKey({ key: 'Backspace' }), false);
  assert.equal(t.claimsKey({ key: '5' }), false, 'digits are always typing');
});
