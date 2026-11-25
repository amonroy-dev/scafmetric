// Building shapes, roofs and parapets, and moving a building.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { ScaffoldState } from '../src/scaffold/workspace/state.js';
import { rectOutline, roundOutline, asRect, roofTriangles, buildingTopFt, buildBuildingMeshes, ROUND_SIDES } from '../src/scaffold/workspace/buildings.js';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { Tools } = await import('../src/scaffold/workspace/tools.js');
function model() {
  const s = new ScaffoldState({});
  const el = { addEventListener() {}, removeEventListener() {} };
  const tools = new Tools({ scene: new THREE.Scene(), renderer: { domElement: el }, invalidate() {} }, s);
  let ground = { x: 0, y: 0 };
  tools.engine.setPointerFromEvent = () => {};
  tools.engine.groundPoint = () => ground;
  const click = (x, y) => { ground = { x, y }; tools._act({}); };
  return { s, tools, click };
}
const RECT = { x0: 0, x1: 30, y0: 0, y1: 20 };
const zs = tris => tris.flat().map(p => p[2]);

test('outlines: a rectangle from two corners, a circle as many straight walls', () => {
  assert.deepEqual(rectOutline([30, 20], [0, 0]), [[0, 0], [30, 0], [30, 20], [0, 20]]);
  assert.deepEqual(asRect(rectOutline([0, 0], [30, 20])), RECT);
  assert.equal(asRect([[0, 0], [30, 0], [30, 20], [5, 20]]), null, 'not square to the grid');
  const round = roundOutline([10, 10], 12);
  assert.equal(round.length, ROUND_SIDES);
  for (const p of round) assert.ok(Math.abs(Math.hypot(p[0] - 10, p[1] - 10) - 12) < 1e-9);
  assert.equal(asRect(round), null);
});

test('roofs: a gable has a ridge the length of the building, a hip a shorter one, a shed one high edge', () => {
  assert.deepEqual(roofTriangles(RECT, 20, { type: 'flat', riseFt: 6 }), []);
  assert.deepEqual(roofTriangles(RECT, 20, { type: 'gable', riseFt: 0 }), [], 'no rise, no roof');
  assert.deepEqual(roofTriangles(null, 20, { type: 'gable', riseFt: 6 }), [], 'only over a rectangle');

  const gable = roofTriangles(RECT, 20, { type: 'gable', riseFt: 6 });
  assert.equal(gable.length, 6, 'two slopes of two triangles and a triangle at each end');
  assert.deepEqual([Math.min(...zs(gable)), Math.max(...zs(gable))], [20, 26]);
  const ridge = [...new Map(gable.flat().filter(p => p[2] === 26).map(p => [p.join(), p])).values()];
  assert.deepEqual(ridge.map(p => [p[0], p[1]]).sort((a, b) => a[0] - b[0]), [[0, 10], [30, 10]], 'along the longer side, down the middle');

  const hip = roofTriangles(RECT, 20, { type: 'hip', riseFt: 6 });
  const hipRidge = [...new Map(hip.flat().filter(p => p[2] === 26).map(p => [p.join(), p])).values()];
  assert.deepEqual(hipRidge.map(p => p[0]).sort((a, b) => a - b), [10, 20], 'in from each end by half the width');

  const turned = roofTriangles(RECT, 20, { type: 'gable', riseFt: 6, ridge: 'y' });
  assert.ok(turned.flat().filter(p => p[2] === 26).every(p => p[0] === 15), 'the ridge can be turned across');

  const over = roofTriangles(RECT, 20, { type: 'gable', riseFt: 6, overhangFt: 2 });
  assert.equal(Math.min(...over.flat().map(p => p[0])), -2, 'an overhang carries the eaves out');

  const shed = roofTriangles(RECT, 20, { type: 'shed', riseFt: 4 });
  assert.ok(shed.flat().filter(p => p[2] === 24).every(p => p[1] === 20), 'one long edge is the high one');
});

test('a building is drawn as its mass, with a roof or a parapet on it', () => {
  const mats = [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()];
  const base = { points: rectOutline([0, 0], [30, 20]), heightFt: 20 };
  assert.equal(buildBuildingMeshes(base, ...mats).length, 1);
  assert.equal(buildBuildingMeshes({ ...base, roof: { type: 'hip', riseFt: 6 } }, ...mats).length, 2);
  assert.equal(buildBuildingMeshes({ ...base, parapetFt: 3 }, ...mats).length, 2);
  assert.equal(buildingTopFt(base), 20);
  assert.equal(buildingTopFt({ ...base, roof: { type: 'gable', riseFt: 6 } }), 26);
  assert.equal(buildingTopFt({ ...base, parapetFt: 3 }), 23);
});

test('the Building tool: two clicks for a rectangle or a round building, with the roof the card says', () => {
  const { s, tools, click } = model();
  tools.setTool('building');
  Object.assign(tools.buildingSettings, { shape: 'rect', heightFt: 18, roofType: 'gable', riseFt: 5 });
  click(30, 20);
  assert.equal(s.buildings.size, 0);
  click(30, 40);
  assert.equal(s.buildings.size, 0, 'a rectangle with no width is not one: still waiting for the opposite corner');
  click(0, 0);
  const rect = [...s.buildings.values()][0];
  assert.deepEqual(asRect(rect.points), RECT);
  assert.deepEqual([rect.heightFt, rect.roof.type, rect.roof.riseFt], [18, 'gable', 5]);

  Object.assign(tools.buildingSettings, { shape: 'round', roofType: 'flat', parapetFt: 3 });
  click(100, 0);
  click(100, 15);
  const round = [...s.buildings.values()][1];
  assert.deepEqual(round.round, { cx: 100, cy: 0, radiusFt: 15 });
  assert.equal(round.points.length, ROUND_SIDES);
  assert.equal(round.roof, undefined);
  assert.equal(round.parapetFt, 3);
  // Scaffold round it: two rings of standards, 1 ft off the wall and the depth further out.
  tools.blockSettings = { ...tools.blockSettings, depthFt: 3, plankedLevelsCount: 1, guardrails: true };
  const done = tools.scaffoldRoundBuilding(round.id);
  assert.equal(done.round, true);
  const radii = [...s.standards.values()].map(c => Math.round(Math.hypot(c.x - 100, c.y) * 100) / 100);
  assert.deepEqual([...new Set(radii)].sort((a, b) => a - b), [16, 19]);
  assert.equal(s.standards.size, done.blocks * 2);
  assert.equal(s.plankBays().length, done.blocks, 'a deck in every bay of the ring');
  const legs = s.takeoff().legs;
  assert.ok(legs.every(l => Number.isFinite(l.deadLb) && l.deadLb > 0));
  // Railed on the outer ring only: no ledger above the deck runs between two inner standards.
  const deckZ = s.plankBays()[0].z;
  const onInner = p => Math.abs(Math.hypot(p[0] - 100, p[1]) - 16) < 0.01;
  assert.equal([...s.ledgers.values()].some(l => l.a[2] > deckZ + 0.1 && onInner(l.a) && onInner(l.b)), false);
  assert.ok([...s.ledgers.values()].some(l => l.a[2] > deckZ + 0.1));
  s.undo();
  assert.equal(s.standards.size, 0, 'one undo');
});

test('a building can be changed, and picked up and turned like a chain', () => {
  const { s, tools } = model();
  const b = s.addBuilding(rectOutline([0, 0], [30, 20]), 20, { roof: { type: 'gable', riseFt: 6, ridge: 'x' } });
  s.updateBuilding(b.id, { heightFt: 24, parapetFt: 2, roof: { type: 'flat' } });
  assert.deepEqual([b.heightFt, b.parapetFt, b.roof], [24, 2, undefined]);
  s.undo();
  assert.deepEqual([s.buildings.get(b.id).heightFt, s.buildings.get(b.id).roof.type], [20, 'gable']);

  s.transformParts([b.id], { dx: 10, dy: 5, steps: 1, pivot: { x: 0, y: 0 } });
  const moved = s.buildings.get(b.id);
  assert.deepEqual(asRect(moved.points), { x0: -10, x1: 10, y0: 5, y1: 35 }, 'a quarter turn about its corner, then across');
  assert.equal(moved.roof.ridge, 'y', 'its ridge turned with it');
  const copies = s.transformParts([b.id], { dx: 50 }, true);
  assert.equal(s.buildings.size, 2);
  assert.notEqual(copies[0], b.id);

  assert.equal(tools.beginCarry([b.id], false), true, 'held by a corner');
  assert.equal(tools.carry.lines.length, 4);
  tools.cancelCarry();
});
