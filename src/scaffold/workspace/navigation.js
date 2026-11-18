// Camera navigation math, ported from ScaffoldPro (Scene.tsx, cameraGesture.ts,
// zoomExtents.ts, orbitPivot.ts, useViewTransition.ts). Pure functions over
// three.js vectors so they can be unit-tested without a renderer.
//
// The mouse model it serves is ScaffoldPro's, which follows Inventor:
//   - LEFT click / drag   : tools and selection only, never the camera
//   - MIDDLE drag         : pan, 1:1 - the point you grab stays under the cursor
//   - SHIFT + MIDDLE drag : orbit (perspective only; orthographic faces stay put)
//   - double MIDDLE click : Zoom Extents - fit the model, keep the view direction
//   - WHEEL               : zoom toward what is under the cursor
//   - RIGHT click         : left free; the browser menu is suppressed
// This builder also keeps, for trackpads without a middle button:
//   - RIGHT drag          : orbit (perspective) / pan (orthographic)
//   - PAN lock + LEFT     : pan;  SPACE or ALT + LEFT : as RIGHT drag

import * as THREE from 'three';

/** How far the view turns for a drag the height of the viewport, at sensitivity 1. */
export const ORBIT_RADIANS_PER_VIEWPORT_HEIGHT = Math.PI;
export const CAMERA_MIN_DISTANCE_FT = 1;
export const CAMERA_MAX_DISTANCE_FT = 1500;
export const ORTHO_MIN_ZOOM = 0.01;
export const ORTHO_MAX_ZOOM = 500;
/** Fraction of the viewport the model may occupy after Zoom Extents. 0.9 leaves a 5% rim. */
export const ZOOM_EXTENTS_FILL = 0.9;
export const ZOOM_EXTENTS_TRANSITION_MS = 220;
export const VIEW_TRANSITION_MS = 500;
/** Easing applied to orbit drags so motion stays continuous when frames are slow. */
export const ORBIT_SMOOTH_TIME_S = 0.055;
/** A new wheel gesture, rather than another notch of the current one. */
export const GESTURE_GAP_MS = 250;
/** How near a rosette must be before an orbit pivot is taken to mean that rosette. */
export const FEATURE_SNAP_FT = 2.5;
/** Movement past which a middle press is a drag, not a click. */
export const DRAG_THRESHOLD_PX = 4;
/** A model smaller than this in any direction is fitted as if it were this big. */
export const MIN_FIT_SPAN_FT = 6;

const Z_UP = new THREE.Vector3(0, 0, 1);
const MIN_PROJECTED_SIZE = 1e-6;
const POLE_EPS = 1e-3;

// ---------------------------------------------------------------------------
// Gesture rates (cameraGesture.ts)

/** World feet one pixel covers at a depth in front of a perspective camera. */
export function perspectiveWorldPerPixel({ distance, fovDeg, viewportHeightPx }) {
  const height = Math.max(viewportHeightPx, 1);
  return (2 * Math.max(distance, 1e-6) * Math.tan((fovDeg * Math.PI) / 360)) / height;
}

/** The same for an orthographic camera, whose scale comes from zoom, not depth. */
export function orthographicWorldPerPixel({ frustumHeight, zoom, viewportHeightPx }) {
  return frustumHeight / Math.max(zoom, 1e-6) / Math.max(viewportHeightPx, 1);
}

/**
 * How far the camera slides so the grabbed point stays under the pointer, along
 * the screen's right and up axes. Dragging right moves the camera left, so the
 * world comes with the hand.
 */
export function panOffset({ dx, dy, worldPerPixel }) {
  return { right: -dx * worldPerPixel, up: dy * worldPerPixel };
}

/** Orbit angles for a pointer movement; both axes measured against the height. */
export function orbitAngles({ dx, dy, viewportHeightPx, sensitivity = 1, invertVertical = false }) {
  const perPixel = (ORBIT_RADIANS_PER_VIEWPORT_HEIGHT * sensitivity) / Math.max(viewportHeightPx, 1);
  return { theta: -dx * perPixel, phi: -dy * perPixel * (invertVertical ? -1 : 1) };
}

// ---------------------------------------------------------------------------
// Camera moves

/**
 * Turn the camera rigidly about a pivot: theta about world Z (azimuth), phi
 * about the camera's horizontal right axis (polar). Position and target turn
 * together, so the pivot stays where it is on screen. The view never tips over
 * the pole.
 */
export function orbitAbout({ position, target, pivot, theta, phi }) {
  const view = position.clone().sub(target);
  let axis = new THREE.Vector3().crossVectors(Z_UP, view);
  if (axis.lengthSq() < 1e-12) {
    // Looking straight down or up: any horizontal axis perpendicular to the
    // current screen works; derive it from the azimuth the camera would have.
    axis.set(1, 0, 0);
  }
  axis.normalize();
  const polar0 = view.angleTo(Z_UP);
  const polar1 = THREE.MathUtils.clamp(polar0 + phi, POLE_EPS, Math.PI - POLE_EPS);
  const q = new THREE.Quaternion()
    .setFromAxisAngle(Z_UP, theta)
    .multiply(new THREE.Quaternion().setFromAxisAngle(axis, polar1 - polar0));
  return {
    position: position.clone().sub(pivot).applyQuaternion(q).add(pivot),
    target: target.clone().sub(pivot).applyQuaternion(q).add(pivot),
  };
}

/**
 * Perspective zoom about a point on the cursor ray: a homothety centred on the
 * pivot, so the pivot (and everything on its ray) stays under the cursor and the
 * camera slows asymptotically into it. scale < 1 moves in.
 */
export function dollyAbout({ position, target, pivot, scale,
  minDistance = CAMERA_MIN_DISTANCE_FT, maxDistance = CAMERA_MAX_DISTANCE_FT }) {
  const distance = Math.max(position.distanceTo(target), 1e-9);
  const toPivot = Math.max(position.distanceTo(pivot), 1e-9);
  let s = scale;
  if (s < 1) s = Math.max(s, Math.min(1, Math.max(minDistance / distance, minDistance / toPivot)));
  else s = Math.min(s, Math.max(1, maxDistance / distance));
  return {
    position: position.clone().sub(pivot).multiplyScalar(s).add(pivot),
    target: target.clone().sub(pivot).multiplyScalar(s).add(pivot),
  };
}

/**
 * Orthographic zoom about the cursor. cursorOffset is the world vector, in the
 * view plane, from the screen centre to the point under the cursor; the camera
 * slides so that point stays put.
 */
export function zoomOrthoAbout({ position, target, zoom, scale, cursorOffset,
  minZoom = ORTHO_MIN_ZOOM, maxZoom = ORTHO_MAX_ZOOM }) {
  const next = THREE.MathUtils.clamp(zoom / scale, minZoom, maxZoom);
  const shift = cursorOffset.clone().multiplyScalar(1 - zoom / next);
  return { position: position.clone().add(shift), target: target.clone().add(shift), zoom: next };
}

/** Wheel delta in pixels, whatever unit the device reported it in. */
export function wheelPixels(event) {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
  return event.deltaY * unit;
}

/** Zoom scale for a wheel delta: about 15% per notch; positive deltas zoom out. */
export function wheelScale(deltaPx, sensitivity = 1) {
  return Math.exp(THREE.MathUtils.clamp(deltaPx, -400, 400) * 0.0016 * sensitivity);
}

// ---------------------------------------------------------------------------
// Zoom Extents (zoomExtents.ts)

function cornersOf(box) {
  const { min, max } = box;
  const out = [];
  for (let i = 0; i < 8; i++) {
    out.push(new THREE.Vector3(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z));
  }
  return out;
}

function viewAxes(camera, position, target) {
  const forward = target.clone().sub(position);
  if (forward.lengthSq() <= 1e-12) camera.getWorldDirection(forward);
  forward.normalize();
  const right = new THREE.Vector3().crossVectors(forward, camera.up);
  if (right.lengthSq() <= 1e-12) {
    const fallbackUp = Math.abs(forward.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    right.crossVectors(forward, fallbackUp);
  }
  right.normalize();
  const screenUp = new THREE.Vector3().crossVectors(right, forward).normalize();
  return { forward, right, screenUp };
}

/** Grow a box about its centre so no side is shorter than minSpan. */
export function withMinSpan(box, minSpan = MIN_FIT_SPAN_FT) {
  const out = box.clone();
  const size = out.getSize(new THREE.Vector3());
  out.expandByVector(new THREE.Vector3(
    Math.max(0, minSpan - size.x) / 2, Math.max(0, minSpan - size.y) / 2, Math.max(0, minSpan - size.z) / 2,
  ));
  return out;
}

/**
 * Fit a box in the camera's current orientation: only the centre and scale
 * change, never the view direction (Inventor's Zoom All).
 */
export function calculateZoomExtents(camera, box, position, target, options = {}) {
  if (!box || box.isEmpty()) return null;
  const fill = THREE.MathUtils.clamp(options.fill ?? ZOOM_EXTENTS_FILL, 0.1, 1);
  const minDistance = options.minDistance ?? CAMERA_MIN_DISTANCE_FT;
  const maxDistance = options.maxDistance ?? CAMERA_MAX_DISTANCE_FT;
  const center = box.getCenter(new THREE.Vector3());
  const { forward, right, screenUp } = viewAxes(camera, position, target);
  const corners = cornersOf(box);

  if (camera.isPerspectiveCamera) {
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV() * 0.5));
    const tanH = tanV * Math.max(camera.aspect, MIN_PROJECTED_SIZE);
    let distance = minDistance;
    for (const corner of corners) {
      const offset = corner.sub(center);
      const px = Math.abs(offset.dot(right));
      const py = Math.abs(offset.dot(screenUp));
      const depth = offset.dot(forward);
      // Solve the frustum inequalities per corner rather than fitting a sphere,
      // which wastes screen on long, thin models.
      distance = Math.max(distance,
        px / Math.max(tanH * fill, MIN_PROJECTED_SIZE) - depth,
        py / Math.max(tanV * fill, MIN_PROJECTED_SIZE) - depth,
        camera.near * 2 - depth);
    }
    distance = THREE.MathUtils.clamp(distance, minDistance, maxDistance);
    return { position: center.clone().addScaledVector(forward, -distance), target: center };
  }

  if (camera.isOrthographicCamera) {
    let halfW = MIN_PROJECTED_SIZE, halfH = MIN_PROJECTED_SIZE;
    for (const corner of corners) {
      const offset = corner.sub(center);
      halfW = Math.max(halfW, Math.abs(offset.dot(right)));
      halfH = Math.max(halfH, Math.abs(offset.dot(screenUp)));
    }
    const frustumW = Math.abs(camera.right - camera.left);
    const frustumH = Math.abs(camera.top - camera.bottom);
    const zoom = THREE.MathUtils.clamp(
      Math.min((frustumW * fill) / (halfW * 2), (frustumH * fill) / (halfH * 2)),
      options.minZoom ?? ORTHO_MIN_ZOOM, options.maxZoom ?? ORTHO_MAX_ZOOM);
    const distance = THREE.MathUtils.clamp(position.distanceTo(target), minDistance, maxDistance);
    return { position: center.clone().addScaledVector(forward, -distance), target: center, zoom };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Orbit pivot (orbitPivot.ts)

/** Whether a box is wholly, partly or not at all inside the camera's view. */
export function modelVisibility(box, camera) {
  camera.updateMatrixWorld();
  const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(m);
  if (!frustum.intersectsBox(box)) return 'none';
  for (const corner of cornersOf(box)) if (!frustum.containsPoint(corner)) return 'part';
  return 'whole';
}

/** The point of a box nearest a ray. */
export function nearestPointOnBoxToRay(box, ray) {
  const point = box.getCenter(new THREE.Vector3());
  const onRay = new THREE.Vector3();
  for (let i = 0; i < 6; i++) {
    ray.closestPointToPoint(point, onRay);
    box.clampPoint(onRay, point);
  }
  return point;
}

/** On the ground under the cursor, or as far along the ray as the camera is turning now. */
export function pointUnderCursor(ray, fallbackDistance) {
  const distance = Math.max(fallbackDistance, 1);
  if (Math.abs(ray.direction.z) > 1e-6) {
    const t = -ray.origin.z / ray.direction.z;
    if (t > 0 && t <= distance * 4) return ray.at(t, new THREE.Vector3());
  }
  return ray.at(distance, new THREE.Vector3());
}

/**
 * Inventor's orbit pivot, chosen once on press:
 *   - whole model in view : its centre, whatever the cursor is over
 *   - model partly in view: what the cursor is over (snapped to a rosette), or
 *                           the nearest point of the model to the cursor ray
 *   - model out of view   : the point under the cursor
 * Null when nothing is drawn: the camera keeps turning about its target.
 */
export function resolveOrbitPivot({ modelBox, visibility, cursorHit = null, cursorRay = null, fallbackDistance = 30 }) {
  if (!modelBox || modelBox.isEmpty()) return null;
  if (visibility === 'whole') return { point: modelBox.getCenter(new THREE.Vector3()), source: 'model' };
  if (visibility === 'part') {
    if (cursorHit) return { point: cursorHit.clone(), source: 'nearest' };
    if (cursorRay) return { point: nearestPointOnBoxToRay(modelBox, cursorRay), source: 'nearest' };
    return { point: modelBox.getCenter(new THREE.Vector3()), source: 'model' };
  }
  if (!cursorRay) return null;
  return { point: pointUnderCursor(cursorRay, fallbackDistance), source: 'cursor' };
}

/** The nearest candidate within maxDistance, or null. */
export function snapToNearestPoint(point, candidates, maxDistance = FEATURE_SNAP_FT) {
  let best = null;
  let bestSq = maxDistance * maxDistance;
  for (const c of candidates) {
    const d = c.distanceToSquared(point);
    if (d <= bestSq) { bestSq = d; best = c; }
  }
  return best ? best.clone() : null;
}

// ---------------------------------------------------------------------------
// View transitions (useViewTransition.ts)

/** Smootherstep: zero velocity and acceleration at both ends. */
export function smootherstep(t) {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/**
 * Z-up spherical coordinates of an offset. At the poles the azimuth is
 * undefined; -PI/2 (camera just south of the target) is the one that puts +Y at
 * the top of the screen, which is how the top view is drawn.
 */
export function toSpherical(offset) {
  const r = Math.max(offset.length(), 1e-9);
  const phi = Math.acos(THREE.MathUtils.clamp(offset.z / r, -1, 1));
  const horizontal = Math.hypot(offset.x, offset.y);
  const theta = horizontal < 1e-6 * r ? -Math.PI / 2 : Math.atan2(offset.y, offset.x);
  return { r, theta, phi };
}

export function fromSpherical({ r, theta, phi }) {
  const p = THREE.MathUtils.clamp(phi, POLE_EPS, Math.PI - POLE_EPS);
  return new THREE.Vector3(r * Math.sin(p) * Math.cos(theta), r * Math.sin(p) * Math.sin(theta), r * Math.cos(p));
}

/**
 * The camera part-way between two views, interpolated about the target in
 * spherical terms so the camera swings around the model rather than cutting
 * through it. Distance and zoom interpolate geometrically.
 */
export function interpolateView(from, to, t) {
  const e = smootherstep(t);
  const target = from.target.clone().lerp(to.target, e);
  const fromOffset = from.position.clone().sub(from.target);
  const toOffset = to.position.clone().sub(to.target);
  const a = toSpherical(fromOffset);
  const b = toSpherical(toOffset);
  const zoom = Number.isFinite(from.zoom) && Number.isFinite(to.zoom) && from.zoom > 0 && to.zoom > 0
    ? from.zoom * Math.pow(to.zoom / from.zoom, e) : undefined;
  // Same direction (Zoom Extents): slide along it, without touching the pole.
  if (fromOffset.clone().normalize().dot(toOffset.clone().normalize()) > 1 - 1e-9) {
    const offset = fromOffset.normalize().multiplyScalar(a.r * Math.pow(b.r / a.r, e));
    return { position: target.clone().add(offset), target, zoom };
  }
  let dTheta = b.theta - a.theta;
  while (dTheta > Math.PI) dTheta -= 2 * Math.PI;
  while (dTheta < -Math.PI) dTheta += 2 * Math.PI;
  const offset = fromSpherical({
    r: a.r * Math.pow(b.r / a.r, e),
    theta: a.theta + dTheta * e,
    phi: a.phi + (b.phi - a.phi) * e,
  });
  return { position: target.clone().add(offset), target, zoom };
}
