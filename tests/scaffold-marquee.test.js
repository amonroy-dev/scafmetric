// The selection box, ported from ScaffoldPro's screenMarquee: drawn on the
// screen so it works in any view, and it selects every kind of part.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { ScaffoldState } from '../src/scaffold/workspace/state.js';
import {
  createScreenProjector, marqueeFromDrag, marqueeHits, segmentHit, outlineHit, combineSelection, marqueeModeFor,
} from '../src/scaffold/workspace/screenmarquee.js';

globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
const { Tools } = await import('../src/scaffold/workspace/tools.js');

const W = 800, H = 600;
function frontCamera() {
  // Looking along +Y at the y = 0 face: x across the screen, z up it.
  const cam = new THREE.OrthographicCamera(-20, 20, 15, -15, -500, 500);
  cam.up.set(0, 0, 1);
  cam.position.set(7, -50, 8);
  cam.lookAt(7, 0, 8);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  return cam;
}
function toolsFor(state, camera) {
  const el = { addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H }) };
  return new Tools({ scene: new THREE.Scene(), renderer: { domElement: el }, camera, invalidate() {} }, state);
}
function model() {
  const s = new ScaffoldState({ snapStep: 1 });
  for (const [x, y] of [[0, 0], [7, 0], [0, 7], [7, 7]]) s.addStandard(x, y, 9.84375);
  const t = toolsFor(s, frontCamera());
  t._batchFillLedgers(4);
  const n = (x, y, l) => s.nodes().find(q => q.x === x && q.y === y && q.level === l);
  s.addBrace([0, 0, n(0, 0, 0).z], [7, 0, n(7, 0, 4).z]);
  const front = s.ledgerList().find(l => l.a[1] === 0 && l.b[1] === 0);
  s.addPlankOnLedger(front.id, 1);
  s.addLiveLoad(front.id, 1, 50);
  s.addBracket(n(0, 0, 2), [-1, 0], 2);
  return { s, t };
}
const KINDS = ['standards', 'ledgers', 'braces', 'plankPlacements', 'liveLoads', 'brackets'];
const kinds = (s, ids) => [...new Set(ids.map(id => KINDS.find(k => s[k].has(id))))].sort();

test('the direction of the drag chooses the rule', () => {
  assert.equal(marqueeModeFor({ x: 10, y: 0 }, { x: 50, y: 30 }), 'window');
  assert.equal(marqueeModeFor({ x: 50, y: 0 }, { x: 10, y: 30 }), 'crossing');
});

test('a box in a FRONT view selects every kind of part', () => {
  const { s, t } = model();
  // Right to left over everything: crossing.
  t._finishMarquee({ startClientX: W - 5, startClientY: 5, currentClientX: 5, currentClientY: H - 5 }, {});
  assert.deepEqual(kinds(s, [...t.selection]), ['braces', 'brackets', 'ledgers', 'liveLoads', 'plankPlacements', 'standards']);
  assert.equal([...t.selection].filter(id => s.standards.has(id)).length, 4);
});

test('window takes only what is wholly inside; crossing takes what it touches', () => {
  const { s } = model();
  const p = createScreenProjector(frontCamera(), W, H);
  const col = [...s.standards.values()].find(c => c.x === 7 && c.y === 0);
  const a = new THREE.Vector3(7, 0, 0), b = new THREE.Vector3(7, 0, s.baseOffsetFt() + s.standardHeightFt(col));
  const pa = p.point(a), pb = p.point(b);
  const upperHalf = { left: pa.x - 20, right: pa.x + 20, top: pb.y - 10, bottom: (pa.y + pb.y) / 2 };
  assert.equal(segmentHit(p, upperHalf, 'window', a, b), false, 'half a standard is not wholly inside');
  assert.equal(segmentHit(p, upperHalf, 'crossing', a, b), true, 'but the box does touch it');
  const whole = { left: pa.x - 20, right: pa.x + 20, top: pb.y - 10, bottom: pa.y + 10 };
  assert.equal(segmentHit(p, whole, 'window', a, b), true);
});

test('a bracket drawn as several tubes is one part to a window box', () => {
  const { s, t } = model();
  const bracket = [...s.brackets.values()][0];
  const parts = t._marqueeParts();
  const p = createScreenProjector(frontCamera(), W, H);
  const pts = parts.segments.filter(x => x.id === bracket.id).flatMap(x => [x.a, x.b]).map(q => p.point(new THREE.Vector3(...q)));
  const box = {
    left: Math.min(...pts.map(q => q.x)) - 2, right: Math.max(...pts.map(q => q.x)) + 2,
    top: Math.min(...pts.map(q => q.y)) - 2, bottom: Math.max(...pts.map(q => q.y)) + 2,
  };
  assert.ok(marqueeHits(p, box, 'window', parts).includes(bracket.id), 'all of it inside: selected');
  const half = { ...box, right: (box.left + box.right) / 2 };
  assert.ok(!marqueeHits(p, half, 'window', parts).includes(bracket.id), 'part of it outside: not');
  assert.ok(marqueeHits(p, half, 'crossing', parts).includes(bracket.id));
});

test('a small crossing box in the middle of a deck still selects the deck', () => {
  const cam = new THREE.OrthographicCamera(-20, 20, 15, -15, -500, 500);
  cam.up.set(0, 1, 0); cam.position.set(0, 0, 50); cam.lookAt(0, 0, 0); cam.updateMatrixWorld();
  const p = createScreenProjector(cam, W, H);
  const corners = [[-5, -5, 3], [5, -5, 3], [5, 5, 3], [-5, 5, 3]].map(c => new THREE.Vector3(...c));
  const mid = { left: W / 2 - 4, right: W / 2 + 4, top: H / 2 - 4, bottom: H / 2 + 4 };
  assert.equal(outlineHit(p, mid, 'crossing', corners), true);
  assert.equal(outlineHit(p, mid, 'window', corners), false);
});

test('a part behind a perspective camera is never selected', () => {
  const cam = new THREE.PerspectiveCamera(50, W / H, 0.1, 1000);
  cam.position.set(0, -10, 5); cam.lookAt(0, 0, 5); cam.updateMatrixWorld();
  const p = createScreenProjector(cam, W, H);
  const all = { left: 0, top: 0, right: W, bottom: H };
  assert.equal(segmentHit(p, all, 'crossing', new THREE.Vector3(0, -30, 0), new THREE.Vector3(0, -30, 10)), false);
  assert.equal(segmentHit(p, all, 'crossing', new THREE.Vector3(0, 5, 4), new THREE.Vector3(0, 5, 6)), true);
});

test('Shift adds to the selection and Ctrl toggles', () => {
  assert.deepEqual(combineSelection(['a'], ['b'], {}), ['b']);
  assert.deepEqual(combineSelection(['a'], ['b'], { shiftKey: true }), ['a', 'b']);
  assert.deepEqual(combineSelection(['a', 'b'], ['b', 'c'], { ctrlKey: true }), ['a', 'c']);
});

test('the drag is clamped to the canvas', () => {
  const g = marqueeFromDrag({ left: 100, top: 50, width: W, height: H }, frontCamera(),
    { startClientX: 300, startClientY: 200, currentClientX: 5000, currentClientY: -40 });
  assert.deepEqual(g.rect, { left: 200, top: 0, right: W, bottom: 150 });
});
