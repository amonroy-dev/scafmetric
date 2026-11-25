// Legs that stand on a building: the scaffold stays level, every rosette stays
// on the same heights, and a leg over a flat roof is that much shorter with
// its jack taking up the difference (ScaffoldPro's support-aware legs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { ScaffoldState } from '../src/scaffold/workspace/state.js';
import { BLOCK_DEFAULTS } from '../src/scaffold/workspace/planning.js';
import { rectOutline } from '../src/scaffold/workspace/buildings.js';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { Tools } = await import('../src/scaffold/workspace/tools.js');
function model() {
  const s = new ScaffoldState({});
  const el = { addEventListener() {}, removeEventListener() {} };
  const tools = new Tools({ scene: new THREE.Scene(), renderer: { domElement: el }, invalidate() {} }, s);
  const block = (cx, cy, heightFt, extra = {}) => {
    tools.blockSettings = { ...BLOCK_DEFAULTS, widthFt: 14, depthFt: 5, heightFt, plankedLevelsCount: 1, guardrails: false, ...extra };
    tools.placeBlockAt({ plan: tools._blockPlan(), center: { x: cx, y: cy }, snapped: false, rotationSteps: 0 });
  };
  return { s, tools, block };
}
const PITCH = 19.6875 / 12;

test('what is under a point: the ground, or the flat roof of a building it is over', () => {
  const { s } = model();
  assert.equal(s.supportZAt(5, 5), 0);
  assert.equal(s.firstLiftAt(5, 5), 1);
  s.addBuilding(rectOutline([0, 0], [40, 40]), 20);
  assert.equal(s.supportZAt(5, 5), 20);
  assert.equal(s.supportZAt(-5, 5), 0);
  assert.equal(s.supportZAt(0, 5), 0, 'a leg on the line of the wall is beside the building, not on it');
  const pitched = s.addBuilding(rectOutline([100, 0], [140, 40]), 20, { roof: { type: 'gable', riseFt: 6 } });
  assert.equal(s.supportZAt(120, 20), 0, 'a pitched roof is not stood on');
  s.updateBuilding(pitched.id, { roof: { type: 'flat' } });
  assert.equal(s.supportZAt(120, 20), 20);
  // The first rosette is on the first lift whose tube foot clears the roof and the base under it.
  const first = s.firstLiftAt(5, 5);
  assert.equal(first, 1 + Math.ceil(20 / PITCH));
  const extra = s.jackExtraFtAt(5, 5);
  assert.ok(extra >= 0 && extra < PITCH, 'the jack takes up less than one rosette spacing');
});

test('a block on a roof stands on it, in step with the ground, and is shorter by the roof', () => {
  const onGround = model();
  onGround.block(20, 20, 30);
  const { s, block } = model();
  s.addBuilding(rectOutline([0, 0], [40, 40]), 20);
  block(20, 20, 30);
  assert.equal(s.standards.size, 6);
  const first = s.firstLiftAt(20, 20);
  for (const c of s.standards.values()) {
    const foot = s.standardBaseZ(c);
    assert.ok(foot >= 20 + s.baseOffsetFt() - 1e-9, 'its tube starts above the roof and the base on it');
    assert.ok(foot < 20 + s.baseOffsetFt() + PITCH);
    assert.ok(Math.abs(s.standardHeightFt(c) - (s.standardHeightFt([...onGround.s.standards.values()][0]) - (first - 1) * PITCH)) < 3.3,
      'shorter than the same block on the ground by about the roof');
  }
  // Every rosette is on a lift the ground scaffold has too.
  for (const n of s.nodes()) assert.ok(Math.abs(n.z - s.liftZ(n.level)) < 1e-9 && n.level >= first - 1);
  // The deck is where the block wanted it; the ledgers at the foot are on the collars up on the roof.
  const want = onGround.s.plankBays().map(d => d.z);
  assert.deepEqual([...new Set(s.plankBays().map(d => d.z))], [...new Set(want)]);
  const zs = [...new Set([...s.ledgers.values()].map(l => Math.round(l.a[2] * 1000) / 1000))].sort((a, b) => a - b);
  assert.equal(zs[0], Math.round(s.liftZ(first - 1) * 1000) / 1000, 'the lowest ledgers are on the collars');
  assert.ok(zs.every(z => z > 20), 'none below the roof');
  // And the legs carry less: there is less of them.
  const lb = st => st.takeoff().legs.reduce((n, l) => n + l.deadLb, 0);
  assert.ok(lb(s) < lb(onGround.s) - 100);
  // Drawn standing on the roof, its jack wound out to suit.
  const g = s.geometry().standards[0];
  assert.equal(g.supportZ, 20);
  assert.ok(Math.abs(g.jackExtraIn / 12 - s.jackExtraFtAt(g.x, g.y)) < 1e-9);
});

test('half on the roof and half off: the ground legs are full height and nothing is built into the building', () => {
  const { s, block } = model();
  s.addBuilding(rectOutline([20, -20], [60, 20]), 20);
  block(20, 0, 30); // standards at x = 13, 20, 27: the last is over the roof
  const cols = [...s.standards.values()];
  const high = cols.filter(c => c.x > 20.5), low = cols.filter(c => c.x < 20.5);
  assert.deepEqual([low.length, high.length], [4, 2]);
  assert.ok(Math.abs(s.standardBaseZ(low[0]) - s.baseOffsetFt()) < 1e-9);
  assert.ok(s.standardBaseZ(high[0]) > 20);
  assert.ok(Math.abs(s.standardTopZ(high[0]) - s.standardTopZ(low[0])) < 3.3, 'their tops are near enough level');
  // No ledger ends on a roof leg below the roof.
  for (const l of s.ledgers.values()) for (const p of [l.a, l.b]) if (p[0] > 20.5) assert.ok(p[2] > 20, `a ledger at ${p[2]} ft runs into the building`);
  // The deck up top still spans onto the roof legs.
  assert.equal(s.plankBays().length, 2);
});

test('take the building away and the legs are on the ground again', () => {
  const { s, block } = model();
  const b = s.addBuilding(rectOutline([0, 0], [40, 40]), 20);
  block(20, 20, 30);
  const c = [...s.standards.values()][0];
  assert.ok(s.standardBaseZ(c) > 20);
  s.remove(b.id);
  assert.ok(Math.abs(s.standardBaseZ(c) - s.baseOffsetFt()) < 1e-9, 'what a leg stands on is read from what is under it now');
});
