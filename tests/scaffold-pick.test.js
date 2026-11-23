// Clicking a part selects it at any zoom: a tube a pixel wide on screen still
// has a few pixels of tolerance round it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { ScaffoldState } from '../src/scaffold/workspace/state.js';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { Tools } = await import('../src/scaffold/workspace/tools.js');

const W = 1000, H = 800;
function setup(distance) {
  const s = new ScaffoldState({ snapStep: 1 });
  s.addStandard(0, 0, 9.84375);   // front leg
  s.addStandard(1, 20, 9.84375);   // back leg, almost behind it from the front
  const camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 5000);
  camera.up.set(0, 0, 1);
  camera.position.set(0, -distance, 5);
  camera.lookAt(0, 0, 5);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  const el = { addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) };
  const engine = {
    scene: new THREE.Scene(), renderer: { domElement: el }, camera, invalidate() {},
    raycaster: new THREE.Raycaster(), pointer: new THREE.Vector2(),
    setPointerFromEvent(e) { this.pointer.set((e.clientX / W) * 2 - 1, -(e.clientY / H) * 2 + 1); },
  };
  // No meshes: only the screen tolerance can find a tube here.
  const t = new Tools(engine, s, { getContentMeshes: () => [] });
  t.setTool('select');
  const screen = p => { const v = new THREE.Vector3(...p).project(camera); return { clientX: ((v.x + 1) / 2) * W, clientY: ((1 - v.y) / 2) * H }; };
  const click = (p, dx = 0) => { const e = screen(p); e.clientX += dx; engine.setPointerFromEvent(e); return t._pickCandidates(e); };
  return { s, t, click, ids: [...s.standards.keys()] };
}

test('zoomed far out, a click a few pixels off a standard still selects it', () => {
  const { click, ids } = setup(400); // the whole tube is about a pixel wide here
  assert.equal(click([0, 0, 5], -4)[0], ids[0], '4 px to the side');
  assert.equal(click([0, 0, 5], -5)[0], ids[0], '5 px the other way');
  assert.deepEqual(click([0, 0, 5], 30), [], 'but not from 30 px away');
});

test('an exact click on a back leg beats a near miss on the front one', () => {
  const { click, ids } = setup(60);
  const [front, back] = ids;
  // The back leg projects a few pixels from the front one; click right on it.
  const hits = click([1, 20, 5]);
  assert.equal(hits[0], back, 'the leg under the cursor');
  assert.ok(hits.length === 1 || hits[1] === front, 'the front leg is the next click, if it is in reach at all');
  assert.equal(click([0, 0, 5])[0], front);
});

test('legs in a line: nearest first, and clicking again reaches the one behind', () => {
  const s = setup(60);
  // Stand a third leg dead behind the first.
  s.s.addStandard(0, 30, 9.84375);
  const behind = [...s.s.standards.keys()][2];
  const hits = s.click([0, 0, 5]);
  assert.equal(hits[0], s.ids[0], 'the front leg first');
  assert.ok(hits.includes(behind), 'the one behind is in the cycle');
});
