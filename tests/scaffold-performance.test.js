// What keeps the scaffold builder smooth: batched edits, instanced drawing,
// invisible pick targets, and a per-lift grid frame computed once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { ScaffoldState } from '../src/scaffold/workspace/state.js';
import { instanceMeshes, mergeLineSegments, hitData, clearGroup, PICK_LAYER } from '../src/scaffold/workspace/instancing.js';
import { tubeBetween, tubePickProxy, nodePickProxy, MATERIALS } from '../src/scaffold/workspace/parts.js';
import { findClosestUnoccupiedTarget, liftFrame } from '../src/scaffold/workspace/planning.js';

const SEG = 6.5625;

test('a batch is one undo step and one change, however many edits it holds', () => {
  let changes = 0;
  const s = new ScaffoldState({ snapStep: 1, onChange: () => changes++ });
  s.addStandard(0, 0, SEG);
  s.resetHistory();
  changes = 0;
  const v0 = s.version;

  s.batch(() => {
    for (let i = 1; i <= 5; i++) s.addLedger([0, 0, i], [7, 0, i]);
    s.batch(() => s.addBrace([0, 0, 1], [7, 0, 5])); // nested folds in
  });

  assert.equal(changes, 1, 'one rebuild for the whole batch');
  assert.equal(s._history.length, 1, 'one undo step for the whole batch');
  assert.ok(s.version > v0 + 5, 'version still moves with every edit, so caches cannot go stale mid-batch');
  s.undo();
  assert.equal(s.ledgers.size, 0, 'one undo removes the whole run');
  assert.equal(s.braces.size, 0);
  s.redo();
  assert.equal(s.ledgers.size, 5, 'one redo puts it all back');
  assert.equal(s.braces.size, 1);
});

test('a batch that changes nothing notifies nobody and records nothing', () => {
  let changes = 0;
  const s = new ScaffoldState({ snapStep: 1, onChange: () => changes++ });
  s.resetHistory();
  s.batch(() => s.addLiveLoad('missing-ledger', 1, 50));
  assert.equal(changes, 0);
  assert.equal(s.canUndo(), false);
});

test('a batch that throws still notifies for what it changed', () => {
  let changes = 0;
  const s = new ScaffoldState({ snapStep: 1, onChange: () => changes++ });
  assert.throws(() => s.batch(() => { s.addStandard(0, 0, SEG); throw new Error('boom'); }));
  assert.equal(changes, 1);
  assert.equal(s._batchDepth, 0, 'the batch closed');
});

test('meshes sharing geometry and material collapse into one instanced draw', () => {
  const meshes = [];
  for (let i = 0; i < 30; i++) {
    const m = tubeBetween([i, 0, 0], [i, 7, 0], 1.9, MATERIALS.ledger);
    m.userData = { id: `L${i}`, kind: 'ledger' };
    meshes.push(m);
  }
  const brace = tubeBetween([0, 0, 0], [7, 0, 6], 1.69, MATERIALS.brace);
  brace.userData = { id: 'B1', kind: 'brace' };
  meshes.push(brace);

  const out = instanceMeshes(meshes);
  assert.equal(out.length, 2, 'one per material');
  const ledgers = out.find(m => m.material === MATERIALS.ledger);
  assert.equal(ledgers.count, 30);
  assert.equal(ledgers.castShadow, true);
  const mat = new THREE.Matrix4();
  ledgers.getMatrixAt(12, mat);
  meshes[12].updateMatrix();
  // Instance matrices are stored as 32-bit floats.
  const diff = Math.max(...mat.elements.map((v, i) => Math.abs(v - meshes[12].matrix.elements[i])));
  assert.ok(diff < 1e-5, `each instance keeps its source mesh transform (off by ${diff})`);
});

test('a raycast into an instanced draw reports the member that was hit', () => {
  const group = new THREE.Group();
  const meshes = [0, 10, 20].map(x => {
    const m = tubeBetween([x, -5, 0], [x, 5, 0], 6, MATERIALS.ledger);
    m.userData = { id: `L${x}`, kind: 'ledger' };
    return m;
  });
  for (const m of instanceMeshes(meshes)) group.add(m);
  group.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(10, 0, 50), new THREE.Vector3(0, 0, -1));
  const hit = ray.intersectObjects(group.children, false)[0];
  assert.ok(hit, 'the ray hit');
  assert.deepEqual(hitData(hit), { id: 'L10', kind: 'ledger' });
});

test('pick proxies are raycast but never drawn or shadowed', () => {
  const ledgerProxy = tubePickProxy([0, 0, 0], [7, 0, 0]);
  const nodeProxy = nodePickProxy(0, 0, 0);
  const camera = new THREE.PerspectiveCamera();
  for (const p of [ledgerProxy, nodeProxy]) {
    assert.equal(p.layers.test(camera.layers), false, 'the camera (and so the shadow pass) skips it');
  }
  assert.equal(ledgerProxy.castShadow, false);

  ledgerProxy.userData = { id: 'L1', kind: 'ledger', proxy: true };
  const group = new THREE.Group();
  for (const m of instanceMeshes([ledgerProxy])) group.add(m);
  assert.equal(group.children[0].layers.mask, 1 << PICK_LAYER, 'instancing keeps the layer');
  group.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(3, 0, 10), new THREE.Vector3(0, 0, -1));
  ray.layers.enableAll();
  const hit = ray.intersectObjects(group.children, false)[0];
  assert.equal(hitData(hit).proxy, true, 'a raycaster that enables every layer still finds it');
});

test('merged centerlines map a hit back to its member', () => {
  const mat = new THREE.LineBasicMaterial();
  const lines = mergeLineSegments([
    { start: [0, 0, 0], end: [0, 10, 0], material: mat, data: { id: 'A', kind: 'line' } },
    { start: [5, 0, 0], end: [5, 10, 0], material: mat, data: { id: 'B', kind: 'line' } },
  ]);
  assert.equal(lines.length, 1);
  const group = new THREE.Group();
  group.add(...lines);
  group.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(5, 5, 10), new THREE.Vector3(0, 0, -1));
  ray.params.Line = { threshold: 0.25 };
  const hit = ray.intersectObjects(group.children, false)[0];
  assert.equal(hitData(hit).id, 'B');
  clearGroup(group);
  assert.equal(group.children.length, 0);
});

test('a precomputed lift frame finds the same ledger targets', () => {
  const nodes = [];
  for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) nodes.push({ x: i * 7, y: j * 5, z: 2, level: 0, columnId: `S${i}-${j}` });
  const frame = liftFrame(nodes);
  assert.ok(frame);
  const taken = new Set(['S1-0']);
  for (const n of nodes) {
    const canUse = c => !taken.has(c.columnId);
    assert.deepEqual(
      findClosestUnoccupiedTarget(n, nodes, canUse, frame),
      findClosestUnoccupiedTarget(n, nodes, canUse),
      `same target from ${n.columnId}`);
  }
  assert.equal(liftFrame([nodes[0]]), null, 'a single node has no grid');
});

test('a standard is drawn as a hollow tube, 1.9 in OD with a 0.12 in wall', async () => {
  const { verticalTube, STANDARD_TUBE_OD_IN, STANDARD_TUBE_WALL_IN } = await import('../src/scaffold/workspace/parts.js');
  assert.equal(STANDARD_TUBE_OD_IN, 1.9);
  assert.equal(STANDARD_TUBE_WALL_IN, 0.12);
  const m = verticalTube(0, 0, 0, 10, STANDARD_TUBE_OD_IN, MATERIALS.steel);
  m.updateMatrixWorld(true);
  const pos = m.geometry.attributes.position;
  const radiiIn = new Set();
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
    radiiIn.add(+(Math.hypot(v.x, v.y) * 12).toFixed(3));
  }
  assert.deepEqual([...radiiIn].sort((a, b) => a - b), [0.83, 0.95], 'only the bore (0.83 in) and the outside (0.95 in): nothing closes the middle');
  // Looking straight down the bore, a ray passes through instead of hitting a cap.
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 50), new THREE.Vector3(0, 0, -1));
  assert.equal(ray.intersectObject(m).length, 0, 'the top is open');
  const wall = new THREE.Raycaster(new THREE.Vector3(0.89 / 12 * Math.cos(0.2), 0.89 / 12 * Math.sin(0.2), 50), new THREE.Vector3(0, 0, -1)); // off the facet edges
  assert.ok(wall.intersectObject(m).length > 0, 'the end of the wall is there');
});
