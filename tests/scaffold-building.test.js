// Buildings: an outline traced in plan with a height, scaffold laid round it
// off its walls, and blocks that stand off the wall they are placed beside.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { ScaffoldState } from '../src/scaffold/workspace/state.js';
import { buildingWalls, planScaffoldRoundBuilding, snapToWall, BLOCK_DEFAULTS } from '../src/scaffold/workspace/planning.js';
import { deriveBom } from '../src/scaffold/workspace/bom.js';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { Tools } = await import('../src/scaffold/workspace/tools.js');
function model() {
  const s = new ScaffoldState({});
  const el = { addEventListener() {}, removeEventListener() {} };
  const tools = new Tools({ scene: new THREE.Scene(), renderer: { domElement: el }, invalidate() {} }, s);
  return { s, tools };
}
const RECT = [[0, 0], [28, 0], [28, 14], [0, 14]];
// An L: a 28 x 14 ft body with a 14 x 7 ft notch out of its top right.
const ELL = [[0, 0], [28, 0], [28, 7], [14, 7], [14, 14], [0, 14]];

test('walls face out of the building whichever way round it was traced', () => {
  for (const pts of [RECT, [...RECT].reverse()]) {
    const walls = buildingWalls(pts);
    assert.equal(walls.length, 4);
    for (const w of walls) {
      const mx = (w.a[0] + w.b[0]) / 2 + w.nx, my = (w.a[1] + w.b[1]) / 2 + w.ny;
      assert.equal(mx > 0 && mx < 28 && my > 0 && my < 14, false, 'a step along the normal leaves the building');
      assert.equal(w.square, true);
    }
  }
  assert.equal(buildingWalls([[0, 0], [10, 0], [5, 8]]).filter(w => !w.square).length, 2);
});

test('round a rectangle: a run along each wall and a square at each corner, all off the wall', () => {
  const { blocks, skipped } = planScaffoldRoundBuilding(RECT, { offsetFt: 1, depthFt: 3 });
  assert.equal(skipped, 0);
  assert.equal(blocks.filter(b => b.corner).length, 4);
  const runs = blocks.filter(b => !b.corner);
  assert.deepEqual(runs.map(b => b.widthFt).sort((a, b) => a - b), [16, 16, 30, 30], 'each run is its wall and the offset past each end');
  // Nothing closer to the building than the offset, and nothing further than offset + depth.
  for (const b of blocks) {
    const hx = (b.rotationSteps % 2 ? b.depthFt : b.widthFt) / 2, hy = (b.rotationSteps % 2 ? b.widthFt : b.depthFt) / 2;
    const [x0, x1, y0, y1] = [b.center.x - hx, b.center.x + hx, b.center.y - hy, b.center.y + hy];
    assert.ok(x0 >= -4 - 1e-9 && x1 <= 32 + 1e-9 && y0 >= -4 - 1e-9 && y1 <= 18 + 1e-9, 'inside the outer line');
    assert.ok(x1 <= -1 + 1e-9 || x0 >= 29 - 1e-9 || y1 <= -1 + 1e-9 || y0 >= 15 - 1e-9, 'outside the offset line');
  }
});

test('round an L: the runs stop short in the notch and a square fills its angle', () => {
  const { blocks } = planScaffoldRoundBuilding(ELL, { offsetFt: 1, depthFt: 3 });
  assert.equal(blocks.filter(b => b.corner).length, 6);
  const inNotch = blocks.find(b => b.corner && Math.abs(b.center.x - 16.5) < 1e-9 && Math.abs(b.center.y - 9.5) < 1e-9);
  assert.ok(inNotch, 'the inside corner at (14, 7) has its square in the angle, 1 ft off both walls');
  // The two walls of the notch: 14 ft and 7 ft, each less the offset and depth at the inside end, plus the offset at the outside end.
  const widths = blocks.filter(b => !b.corner).map(b => b.widthFt).sort((a, b) => a - b);
  assert.deepEqual(widths, [4, 9, 11, 16, 16, 30]);
});

test('Scaffold round it lays one chain with no standard or ledger twice', () => {
  const { s, tools } = model();
  const b = s.addBuilding(ELL, 20);
  tools.blockSettings = { ...BLOCK_DEFAULTS, depthFt: 3, plankedLevelsCount: 1, guardrails: false };
  tools.buildingSettings.wallDistanceFt = 1;
  const done = tools.scaffoldRoundBuilding(b.id);
  assert.deepEqual(done, { blocks: 12, skipped: 0 });
  const spots = [...s.standards.values()].map(c => `${Math.round(c.x * 100)},${Math.round(c.y * 100)}`);
  assert.equal(new Set(spots).size, spots.length, 'no two standards on one spot');
  const pairs = [...s.ledgers.values()].map(l => [l.a, l.b].map(p => p.map(v => Math.round(v * 100)).join(',')).sort().join('|'));
  assert.equal(new Set(pairs).size, pairs.length, 'no ledger twice');
  assert.equal(s.chainOf([[...s.standards.keys()][0]]).filter(id => s.standards.has(id)).length, s.standards.size, 'one chain all the way round');
  // No standard inside the building or nearer than the offset.
  const inside = (x, y) => (x > -1 + 1e-6 && x < 29 - 1e-6 && y > -1 + 1e-6 && y < 8 - 1e-6) || (x > -1 + 1e-6 && x < 15 - 1e-6 && y > -1 + 1e-6 && y < 15 - 1e-6);
  assert.equal([...s.standards.values()].some(c => inside(c.x, c.y)), false);
  // Decked under the building's height, and the outline of the scaffold is a closed ring: every outside face found.
  assert.ok(s.plankBays().every(d => d.z <= 20));
  const traced = tools._framing();
  assert.ok(traced.faces.filter(f => f.outside).length > 20);
  // Rails: round the outside of every deck, and none on the face that looks at the wall.
  const withRails = model();
  const hb = withRails.s.addBuilding(ELL, 20);
  withRails.tools.blockSettings = { ...BLOCK_DEFAULTS, depthFt: 3, plankedLevelsCount: 1, guardrails: true };
  withRails.tools.scaffoldRoundBuilding(hb.id);
  const rails = [...withRails.s.guardrails.values()].filter(g => g.kind === 'rail');
  assert.ok(rails.length > 0);
  const nearWall = (x, y) => (x >= -1.01 && x <= 29.01 && y >= -1.01 && y <= 8.01) || (x >= -1.01 && x <= 15.01 && y >= -1.01 && y <= 15.01);
  for (const g of rails) assert.equal(nearWall((g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2), false, `a rail on the wall side at ${g.a} to ${g.b}`);
  assert.ok(rails.some(g => Math.abs(g.a[1] + 4) < 1e-6 && Math.abs(g.b[1] + 4) < 1e-6), 'the outside face is railed');
  // The building weighs nothing and carries nothing.
  const lb = deriveBom(s).summary.totalWeightLb;
  s.remove(b.id);
  assert.equal(deriveBom(s).summary.totalWeightLb, lb);
  s.undo(); s.undo();
  assert.equal(s.standards.size, 0, 'the whole scaffold is one undo');
  assert.equal(s.buildings.size, 1);
});

test('a block placed beside a wall stands off it by the distance in the card', () => {
  const walls = [{ points: RECT }];
  // A 14 x 3 ft block below the bottom wall, its centre 3 ft out: moved to 1 ft off, so 2.5 ft out.
  assert.deepEqual(snapToWall({ x: 10, y: -3 }, 14, 3, walls, 1), { x: 10, y: -2.5 });
  // Turned to stand along the left wall.
  assert.deepEqual(snapToWall({ x: -4, y: 7 }, 3, 14, walls, 1), { x: -2.5, y: 7 });
  assert.equal(snapToWall({ x: 10, y: -12 }, 14, 3, walls, 1), null, 'too far from any wall');
  assert.equal(snapToWall({ x: 60, y: -3 }, 14, 3, walls, 1), null, 'past the end of the wall');
});

test('the Building tool traces an outline corner by corner and closes on the first', () => {
  const { s, tools } = model();
  let ground = { x: 0, y: 0 };
  tools.engine.setPointerFromEvent = () => {};
  tools.engine.groundPoint = () => ground;
  const said = [];
  tools.hooks.onBuilding = b => said.push(b.id);
  tools.setTool('building');
  tools.buildingSettings.heightFt = 24;
  // Nothing is traced until a shape is picked in the card.
  ground = { x: 5, y: 5 }; tools._act({});
  assert.deepEqual(tools.outline, []);
  tools.buildingSettings.shape = 'outline';
  const click = (x, y, shiftKey = false) => { ground = { x, y }; tools._act({ shiftKey }); };
  click(0, 0);
  click(28, 0.4, true);  // SHIFT: held square to the last corner
  click(28, 14);
  click(0, 14);
  assert.deepEqual(tools.outline, [[0, 0], [28, 0], [28, 14], [0, 14]]);
  click(0.3, 0.2);       // back on the first corner
  assert.equal(s.buildings.size, 1);
  const b = [...s.buildings.values()][0];
  assert.deepEqual([b.points.length, b.heightFt], [4, 24]);
  assert.deepEqual(said, [b.id]);
  assert.deepEqual(tools.outline, [], 'ready for the next one');
  // Two corners are not a building.
  click(50, 0); click(60, 0);
  assert.equal(tools.finishOutline(), null);
  tools.setTool('select');
  assert.deepEqual(tools.outline, [], 'changing tool lets the half-traced outline go');
});
