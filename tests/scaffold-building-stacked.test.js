// Buildings on buildings (a penthouse, a setback), ring buildings, and the
// cone and dome that go on a round one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { ScaffoldState } from '../src/scaffold/workspace/state.js';
import { BLOCK_DEFAULTS } from '../src/scaffold/workspace/planning.js';
import { rectOutline, roundOutline, roundRoofTriangles, roofTriangles, buildBuildingMeshes } from '../src/scaffold/workspace/buildings.js';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { Tools } = await import('../src/scaffold/workspace/tools.js');
function model() {
  const s = new ScaffoldState({});
  const el = { addEventListener() {}, removeEventListener() {} };
  const tools = new Tools({ scene: new THREE.Scene(), renderer: { domElement: el }, invalidate() {} }, s);
  return { s, tools };
}
const mats = [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()];

test('a building drawn on a flat roof stands on it, and what is on top of it stands higher still', () => {
  const { s } = model();
  const base = s.addBuilding(rectOutline([0, 0], [60, 40]), 20);
  const pent = s.addBuilding(rectOutline([20, 10], [40, 30]), 12);
  assert.equal(s.buildingBaseZ(base), 0);
  assert.equal(s.buildingBaseZ(pent), 20);
  assert.equal(s.supportZAt(5, 5), 20, 'on the lower roof');
  assert.equal(s.supportZAt(30, 20), 32, 'on the penthouse');
  const mast = s.addBuilding(rectOutline([28, 18], [32, 22]), 6);
  assert.equal(s.buildingBaseZ(mast), 32);
  // Drawn from its own foot.
  assert.equal(s.geometry().buildings.find(b => b.id === pent.id).baseZ, 20);
  assert.equal(buildBuildingMeshes({ ...pent, baseZ: 20 }, ...mats)[0].position.z, 20);
  // It follows the building under it: lower that and it comes down; move it off and it is on the ground.
  s.updateBuilding(base.id, { heightFt: 15 });
  assert.equal(s.buildingBaseZ(pent), 15);
  s.transformParts([pent.id], { dx: 100 });
  assert.equal(s.buildingBaseZ(pent), 0);
  // A pitched roof carries nothing.
  s.undo();
  s.updateBuilding(base.id, { roof: { type: 'gable', riseFt: 6 } });
  assert.equal(s.buildingBaseZ(pent), 0);
});

test('scaffold round a penthouse stands on the roof below and reaches the penthouse top', () => {
  const { s, tools } = model();
  s.addBuilding(rectOutline([0, 0], [80, 60]), 20);
  const pent = s.addBuilding(rectOutline([20, 15], [48, 36]), 12);
  tools.blockSettings = { ...BLOCK_DEFAULTS, depthFt: 3, plankedLevelsCount: 1, guardrails: false };
  const done = tools.scaffoldRoundBuilding(pent.id);
  assert.ok(done.blocks >= 8);
  for (const c of s.standards.values()) assert.ok(s.standardBaseZ(c) > 20, 'every leg is on the lower roof');
  const deck = Math.max(...s.plankBays().map(d => d.z));
  assert.ok(deck > 20 + 5 && deck <= 32, `decked under the penthouse top, at ${deck}`);
});

test('a ring building has an open middle: nothing stands there, and it is drawn with the hole', () => {
  const { s, tools } = model();
  let ground = { x: 0, y: 0 };
  tools.engine.setPointerFromEvent = () => {};
  tools.engine.groundPoint = () => ground;
  tools.setTool('building');
  Object.assign(tools.buildingSettings, { shape: 'round', heightFt: 20, innerRadiusFt: 8 });
  for (const p of [[0, 0], [20, 0]]) { ground = { x: p[0], y: p[1] }; tools._act({}); }
  const ring = [...s.buildings.values()][0];
  assert.deepEqual(ring.round, { cx: 0, cy: 0, radiusFt: 20, innerRadiusFt: 8 });
  assert.equal(s.supportZAt(14, 0), 20, 'on the ring');
  assert.equal(s.supportZAt(3, 0), 0, 'in the open middle');
  const mass = buildBuildingMeshes(ring, ...mats)[0];
  assert.ok(mass.geometry.attributes.position.count > 0);
  // A hollow as wide as the building is no hollow.
  Object.assign(tools.buildingSettings, { innerRadiusFt: 50 });
  for (const p of [[100, 0], [110, 0]]) { ground = { x: p[0], y: p[1] }; tools._act({}); }
  assert.equal([...s.buildings.values()][1].round.innerRadiusFt, undefined);
});

test('a cone rises to a point and a dome to a rounded top, and each roof goes only on its own kind of building', () => {
  const round = { cx: 0, cy: 0, radiusFt: 10 };
  const zs = tris => tris.flat().map(p => p[2]);
  const cone = roundRoofTriangles(round, 20, { type: 'cone', riseFt: 8 }, 24);
  assert.equal(cone.length, 24, 'one triangle a side');
  assert.deepEqual([Math.min(...zs(cone)), Math.max(...zs(cone))], [20, 28]);
  const apex = cone.flat().filter(p => p[2] === 28);
  assert.ok(apex.every(p => Math.abs(p[0]) < 1e-9 && Math.abs(p[1]) < 1e-9), 'the point is over the middle');
  const dome = roundRoofTriangles(round, 20, { type: 'dome', riseFt: 5 }, 24);
  assert.ok(Math.abs(Math.max(...zs(dome)) - 25) < 1e-9);
  // Half way in, a dome is higher than a cone of the same rise would be.
  const midDome = dome.flat().filter(p => Math.abs(Math.hypot(p[0], p[1]) - 5) < 1.2).map(p => p[2]);
  assert.ok(Math.max(...midDome) > 20 + 5 * 0.55);
  const eaves = roundRoofTriangles(round, 20, { type: 'cone', riseFt: 8, overhangFt: 2 }, 24);
  assert.ok(Math.abs(Math.max(...eaves.flat().map(p => Math.hypot(p[0], p[1]))) - 12) < 1e-9, 'an overhang carries the eaves out');
  assert.deepEqual(roundRoofTriangles(round, 20, { type: 'gable', riseFt: 8 }), []);
  assert.deepEqual(roofTriangles({ x0: 0, x1: 10, y0: 0, y1: 10 }, 20, { type: 'cone', riseFt: 8 }), []);
  // Drawn: a round building with a dome is two meshes; a ring gets no roof over its open middle.
  const b = { points: roundOutline([0, 0], 10), heightFt: 20, round, roof: { type: 'dome', riseFt: 5 } };
  assert.equal(buildBuildingMeshes(b, ...mats).length, 2);
  assert.equal(buildBuildingMeshes({ ...b, round: { ...round, innerRadiusFt: 4 } }, ...mats).length, 1);
});
