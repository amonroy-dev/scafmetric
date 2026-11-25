// Changing a building after it is drawn: dragging a wall in or out, raising it
// off what it stands on (a balcony, a canopy), and setting it down corner to
// corner with another.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { ScaffoldState } from '../src/scaffold/workspace/state.js';
import { rectOutline, asRect } from '../src/scaffold/workspace/buildings.js';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { Tools } = await import('../src/scaffold/workspace/tools.js');
function model() {
  const s = new ScaffoldState({});
  const el = { addEventListener() {}, removeEventListener() {} };
  const tools = new Tools({ scene: new THREE.Scene(), renderer: { domElement: el }, invalidate() {} }, s);
  let ground = { x: 0, y: 0 };
  tools.engine.setPointerFromEvent = () => {};
  tools.engine.groundPoint = () => ground;
  return { s, tools, at: (x, y) => { ground = { x, y }; } };
}

test('a wall moves square to itself and the walls either side follow', () => {
  const { s } = model();
  const b = s.addBuilding(rectOutline([0, 0], [30, 20]), 20);
  // Wall 1 runs up the right-hand side.
  assert.equal(s.moveBuildingWall(b.id, 1, 6), true);
  assert.deepEqual(asRect(b.points), { x0: 0, x1: 36, y0: 0, y1: 20 });
  assert.equal(s.moveBuildingWall(b.id, 1, -10), true);
  assert.deepEqual(asRect(b.points), { x0: 0, x1: 26, y0: 0, y1: 20 });
  s.undo();
  assert.deepEqual(asRect(s.buildings.get(b.id).points), { x0: 0, x1: 36, y0: 0, y1: 20 });
  // Not through the wall opposite, and not down to nothing.
  assert.equal(s.moveBuildingWall(b.id, 1, -40), false);
  assert.equal(s.moveBuildingWall(b.id, 1, -35.5), false, 'under a foot wide');
  assert.deepEqual(asRect(s.buildings.get(b.id).points), { x0: 0, x1: 36, y0: 0, y1: 20 });
  // Traced the other way round, out is still out.
  const back = s.addBuilding([...rectOutline([100, 0], [130, 20])].reverse(), 20);
  const right = back.points.findIndex((p, i) => p[0] === 130 && back.points[(i + 1) % 4][0] === 130);
  s.moveBuildingWall(back.id, right, 5);
  assert.equal(asRect(back.points).x1, 135);
  // On an L, one wall of the notch moves and the outline stays square.
  const ell = s.addBuilding([[200, 0], [228, 0], [228, 7], [214, 7], [214, 14], [200, 14]], 20);
  assert.equal(s.moveBuildingWall(ell.id, 2, 3), true);
  assert.deepEqual(ell.points, [[200, 0], [228, 0], [228, 10], [214, 10], [214, 14], [200, 14]]);
  // A round building has no wall to drag.
  const round = s.addBuilding(rectOutline([300, 0], [310, 10]), 20, { round: { cx: 305, cy: 5, radiusFt: 5 } });
  assert.equal(s.moveBuildingWall(round.id, 0, 2), false);
});

test('in Select, the handle on a selected building wall is found near that wall and nowhere else', () => {
  const { s, tools, at } = model();
  const b = s.addBuilding(rectOutline([0, 0], [30, 20]), 20);
  tools.setTool('select');
  at(32, 10);
  assert.equal(tools._wallUnderPointer({}), null, 'not selected, no handle');
  tools.selection = new Set([b.id]);
  const hit = tools._wallUnderPointer({});
  assert.equal(hit.building.id, b.id);
  assert.deepEqual([hit.wall.nx, hit.wall.ny], [1, 0], 'the right-hand wall');
  assert.deepEqual(hit.handle, { x: 31.5, y: 10 });
  at(15, -1);
  assert.deepEqual([tools._wallUnderPointer({}).wall.nx, tools._wallUnderPointer({}).wall.ny], [0, -1], 'the front wall');
  at(15, -30);
  assert.equal(tools._wallUnderPointer({}), null, 'too far off');
});

test('raised off what it stands on: a balcony hangs on the side and carries no legs', () => {
  const { s } = model();
  const body = s.addBuilding(rectOutline([0, 0], [40, 30]), 30);
  const balcony = s.addBuilding(rectOutline([40, 10], [46, 20]), 1, { raisedFt: 12 });
  assert.equal(s.buildingBaseZ(balcony), 12);
  assert.equal(s.geometry().buildings.find(b => b.id === balcony.id).baseZ, 12);
  assert.equal(s.supportZAt(43, 15), 0, 'a leg under the balcony stands on the ground');
  // A canopy over a roof: raised above the roof it is over.
  const canopy = s.addBuilding(rectOutline([10, 10], [20, 20]), 1, { raisedFt: 9 });
  assert.equal(s.buildingBaseZ(canopy), 39);
  assert.equal(s.supportZAt(15, 15), 30, 'and a leg under it stands on the roof');
  s.updateBuilding(canopy.id, { raisedFt: 0 });
  assert.equal(s.buildingBaseZ(canopy), 30);
  assert.equal(s.supportZAt(15, 15), 31, 'set down, it is a block on the roof that can be stood on');
  assert.ok(body);
});

test('a building carried on its own snaps corner to corner with one that is staying', () => {
  const { s, tools, at } = model();
  s.addBuilding(rectOutline([0, 0], [30, 20]), 20);
  const wing = s.addBuilding(rectOutline([60, 0], [80, 12]), 14);
  assert.equal(tools.beginCarry([wing.id], false), true);
  const pivot = tools.carry.pivot; // its first corner, (60, 0)
  at(pivot.x - 28.8, pivot.y + 0.4); // bring that corner near (30, 0): on the grid it is a foot off
  const p = tools._carryPlacement({});
  assert.equal(p.snapped, true);
  assert.deepEqual([p.dx, p.dy], [-30, 0]);
  tools._act({});
  assert.deepEqual(asRect(s.buildings.get(wing.id).points), { x0: 30, x1: 50, y0: 0, y1: 12 }, 'set down against the first, sharing its corner');
});
