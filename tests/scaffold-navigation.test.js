import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  calculateZoomExtents, dollyAbout, interpolateView, orbitAbout, orbitAngles,
  orthographicWorldPerPixel, panOffset, perspectiveWorldPerPixel, resolveOrbitPivot,
  smootherstep, snapToNearestPoint, wheelScale, withMinSpan, zoomOrthoAbout, modelVisibility,
} from '../src/scaffold/workspace/navigation.js';

const v = (x, y, z) => new THREE.Vector3(x, y, z);
const close = (a, b, tol = 1e-6, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a}`);

function perspective(position, target, aspect = 1.6) {
  const cam = new THREE.PerspectiveCamera(50, aspect, 0.1, 4000);
  cam.up.set(0, 0, 1);
  cam.position.copy(position);
  cam.lookAt(target);
  cam.updateMatrixWorld();
  return cam;
}
function ndc(cam, point) { cam.updateMatrixWorld(); return point.clone().project(cam); }

test('a pan is a 1:1 grab: one pixel of drag moves the world one pixel', () => {
  // 90 degree vertical field at 10 ft over a 200 px viewport: 20 ft tall, 0.1 ft/px.
  close(perspectiveWorldPerPixel({ distance: 10, fovDeg: 90, viewportHeightPx: 200 }), 0.1, 1e-12);
  close(orthographicWorldPerPixel({ frustumHeight: 40, zoom: 2, viewportHeightPx: 400 }), 0.05, 1e-12);
  // Dragging right moves the camera left and dragging down moves it up, so the
  // world follows the hand on both axes.
  const o = panOffset({ dx: 10, dy: 20, worldPerPixel: 0.1 });
  close(o.right, -1); close(o.up, 2);
});

test('orbit turns the same for the same hand movement in any direction', () => {
  const a = orbitAngles({ dx: 300, dy: 300, viewportHeightPx: 600 });
  close(Math.abs(a.theta), Math.abs(a.phi), 1e-12, 'diagonal drag is diagonal');
  close(orbitAngles({ dx: 600, dy: 0, viewportHeightPx: 600 }).theta, -Math.PI, 1e-12, 'a viewport-height drag turns half a revolution');
  assert.ok(orbitAngles({ dx: 0, dy: 10, viewportHeightPx: 600, invertVertical: true }).phi > 0);
});

test('orbiting turns rigidly about the pivot, which stays put on screen, and never flips over the pole', () => {
  const position = v(24, -30, 22), target = v(7, 3.5, 5), pivot = v(3, 3, 4);
  const before = ndc(perspective(position, target), pivot);
  const next = orbitAbout({ position, target, pivot, theta: 0.7, phi: -0.3 });
  const after = ndc(perspective(next.position, next.target), pivot);
  close(after.x, before.x, 1e-6, 'pivot x'); close(after.y, before.y, 1e-6, 'pivot y');
  assert.ok(next.position.distanceTo(position) > 1, 'the camera actually moved');
  close(next.position.distanceTo(pivot), position.distanceTo(pivot), 1e-9, 'rigid about the pivot');
  for (const phi of [-10, 10]) {
    const pole = orbitAbout({ position, target, pivot, theta: 0, phi });
    const angle = pole.position.clone().sub(pole.target).angleTo(v(0, 0, 1));
    assert.ok(angle > 0 && angle < Math.PI, `view stays off the pole (${angle})`);
  }
});

test('wheel zoom in perspective keeps the point under the cursor fixed and stops short of it', () => {
  const position = v(20, -20, 15), target = v(0, 0, 0), pivot = v(4, 2, 3);
  const cam = perspective(position, target);
  const before = ndc(cam, pivot);
  const next = dollyAbout({ position, target, pivot, scale: 0.5 });
  const after = ndc(perspective(next.position, next.target), pivot);
  close(after.x, before.x, 1e-9); close(after.y, before.y, 1e-9);
  close(next.position.distanceTo(pivot), position.distanceTo(pivot) * 0.5, 1e-9);
  // Repeated zooming slows into the surface and never passes the minimum.
  let p = { position, target };
  for (let i = 0; i < 60; i++) p = dollyAbout({ ...p, pivot, scale: 0.5, minDistance: 1 });
  assert.ok(p.position.distanceTo(pivot) >= 1 - 1e-9);
  assert.ok(wheelScale(100) > 1 && wheelScale(-100) < 1, 'scrolling down zooms out');
});

test('orthographic wheel zoom keeps the point under the cursor fixed', () => {
  const target = v(5, 5, 0), position = v(5, 5, 50);
  const cursorOffset = v(6, -2, 0); // cursor sits 6 ft right, 2 ft down of centre
  const world = target.clone().add(cursorOffset);
  const next = zoomOrthoAbout({ position, target, zoom: 1, scale: 0.5, cursorOffset });
  close(next.zoom, 2);
  // Screen offset of the same world point, in "zoom 1" units, is unchanged.
  const offsetAfter = world.clone().sub(next.target).multiplyScalar(next.zoom);
  close(offsetAfter.x, cursorOffset.x); close(offsetAfter.y, cursorOffset.y);
});

test('zoom extents fits the whole model without changing the view direction', () => {
  const box = new THREE.Box3(v(0, 0, 0), v(28, 7, 20));
  const position = v(60, -80, 50), target = v(-30, 10, 0);
  const cam = perspective(position, target);
  const fit = calculateZoomExtents(cam, box, position, target, { fill: 0.9 });
  const dirBefore = target.clone().sub(position).normalize();
  const dirAfter = fit.target.clone().sub(fit.position).normalize();
  close(dirAfter.dot(dirBefore), 1, 1e-9, 'same direction');
  const fitted = perspective(fit.position, fit.target);
  let maxExtent = 0;
  for (let i = 0; i < 8; i++) {
    const c = ndc(fitted, v(i & 1 ? 28 : 0, i & 2 ? 7 : 0, i & 4 ? 20 : 0));
    assert.ok(Math.abs(c.x) <= 0.9 + 1e-6 && Math.abs(c.y) <= 0.9 + 1e-6, `corner ${i} inside the 90% fill`);
    maxExtent = Math.max(maxExtent, Math.abs(c.x), Math.abs(c.y));
  }
  close(maxExtent, 0.9, 1e-6, 'and touches it');

  const ortho = new THREE.OrthographicCamera(-32, 32, 20, -20, -2000, 4000);
  ortho.up.set(0, 1, 0); ortho.position.set(100, 100, 60); ortho.lookAt(100, 100, 0);
  const top = calculateZoomExtents(ortho, box, ortho.position, v(100, 100, 0));
  close(top.target.x, 14); close(top.target.y, 3.5);
  close(top.zoom, Math.min(64 * 0.9 / 28, 40 * 0.9 / 7), 1e-9);
  assert.equal(calculateZoomExtents(cam, new THREE.Box3(), position, target), null, 'nothing drawn, nothing to fit');
  const tiny = withMinSpan(new THREE.Box3(v(0, 0, 0), v(0.2, 0.2, 6.6)));
  assert.ok(tiny.getSize(v()).x >= 6 && tiny.getSize(v()).z >= 6.6 - 1e-9, 'a single standard is not zoomed to a pinpoint');
});

test('orbit pivot follows Inventor: model centre, then under the cursor, then the cursor', () => {
  const modelBox = new THREE.Box3(v(0, 0, 0), v(14, 7, 20));
  assert.equal(resolveOrbitPivot({ modelBox: null, visibility: 'none' }), null);
  assert.deepEqual(resolveOrbitPivot({ modelBox, visibility: 'whole', cursorHit: v(1, 1, 1) }).point.toArray(), [7, 3.5, 10]);
  assert.deepEqual(resolveOrbitPivot({ modelBox, visibility: 'part', cursorHit: v(1, 2, 3) }).point.toArray(), [1, 2, 3]);
  const ray = new THREE.Ray(v(40, 3.5, 10), v(-1, 0, 0));
  const nearest = resolveOrbitPivot({ modelBox, visibility: 'part', cursorRay: ray }).point;
  assert.ok(modelBox.containsPoint(nearest) && Math.abs(nearest.y - 3.5) < 1e-6);
  const down = new THREE.Ray(v(100, 100, 30), v(0, 0, -1));
  assert.deepEqual(resolveOrbitPivot({ modelBox, visibility: 'none', cursorRay: down, fallbackDistance: 30 }).point.toArray(), [100, 100, 0]);
  const rosettes = [v(0, 0, 1.6), v(7, 0, 1.6)];
  assert.deepEqual(snapToNearestPoint(v(6.2, 0.4, 2), rosettes, 2.5).toArray(), [7, 0, 1.6]);
  assert.equal(snapToNearestPoint(v(3.5, 0, 1.6), rosettes, 2.5), null, 'mid-span is not snapped to a node feet away');
});

test('model visibility distinguishes whole, part and none', () => {
  const cam = perspective(v(0, -60, 20), v(0, 0, 5));
  cam.aspect = 1.6; cam.updateProjectionMatrix();
  assert.equal(modelVisibility(new THREE.Box3(v(-2, -2, 0), v(2, 2, 6)), cam), 'whole');
  assert.equal(modelVisibility(new THREE.Box3(v(-400, -2, 0), v(400, 2, 6)), cam), 'part');
  assert.equal(modelVisibility(new THREE.Box3(v(-2, -200, 0), v(2, -190, 6)), cam), 'none');
});

test('view transitions ease in and out and swing around the target instead of cutting through', () => {
  assert.equal(smootherstep(0), 0); assert.equal(smootherstep(1), 1); close(smootherstep(0.5), 0.5, 1e-12);
  const target = v(7, 3.5, 5);
  const from = { position: target.clone().add(v(30, 0, 0)), target, zoom: 1 };
  const to = { position: target.clone().add(v(-30, 0.001, 0)), target, zoom: 4 };
  const mid = interpolateView(from, to, 0.5);
  close(mid.position.distanceTo(target), 30, 1e-6, 'stays on the sphere');
  close(mid.zoom, 2, 1e-9, 'zoom interpolates geometrically');
  const end = interpolateView(from, to, 1);
  assert.ok(end.position.distanceTo(to.position) < 1e-6);
  // Same direction (Zoom Extents) slides straight in, even looking straight down.
  const topFrom = { position: v(0, 0, 50), target: v(0, 0, 0), zoom: 1 };
  const topTo = { position: v(5, 5, 50), target: v(5, 5, 0), zoom: 3 };
  const slide = interpolateView(topFrom, topTo, 0.5);
  close(slide.position.x, slide.target.x, 1e-9, 'still straight down');
  close(slide.position.y, slide.target.y, 1e-9, 'still straight down');
});
