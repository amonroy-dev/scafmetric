// Selection by a rectangle drawn on the screen, ported from ScaffoldPro's
// screenMarquee.ts.
//
// The box is a flat rectangle over the view, so it behaves identically in
// perspective, top, front, side and isometric views: nothing about it is in the
// model. The direction it is dragged chooses the rule:
//
//   Left to right   Window     only what lies wholly inside the box
//   Right to left   Crossing   anything the box touches or encloses
//
// The marquee this replaces projected the pointer onto the ground plane and
// tested standards in plan, so it failed in a front or side view (the plane is
// edge-on) and could select nothing but standards. Here parts are tested by
// what their shape projects to: a member is a segment, a deck or load patch a
// flat outline. The box selects through: a part hidden behind another is still
// selected. Geometry only, no DOM.

import * as THREE from 'three';

/** Movement below this is a click, and belongs to whatever was clicked. */
export const MARQUEE_DRAG_THRESHOLD_PX = 4;
// Tubes are a few pixels wide on screen; testing the centreline alone would let
// a crossing box that visibly grazes a brace miss it.
export const CROSSING_TOLERANCE_PX = 3;

export function marqueeModeFor(start, current) {
  return current.x < start.x ? 'crossing' : 'window';
}

export function screenRectFrom(a, b) {
  return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
}

/**
 * A drag in client pixels as the hit tests want it: a canvas-local rectangle
 * clamped to the canvas, the rule its direction chooses, and the projection.
 */
export function marqueeFromDrag(bounds, camera, drag) {
  const start = { x: drag.startClientX - bounds.left, y: drag.startClientY - bounds.top };
  const current = {
    x: Math.min(Math.max(drag.currentClientX - bounds.left, 0), bounds.width),
    y: Math.min(Math.max(drag.currentClientY - bounds.top, 0), bounds.height),
  };
  return {
    rect: screenRectFrom(start, current),
    mode: marqueeModeFor(start, current),
    projector: createScreenProjector(camera, bounds.width, bounds.height),
  };
}

/**
 * A projection frozen for one gesture. Points behind the camera are cut away at
 * the near plane first: projected naively they come out mirrored through the
 * centre of the view and could land inside a box drawn nowhere near them.
 */
export function createScreenProjector(camera, widthPx, heightPx) {
  camera.updateMatrixWorld();
  const view = camera.matrixWorldInverse.clone();
  const projection = camera.projectionMatrix.clone();
  // An orthographic camera may have a negative near plane: nothing is behind it.
  const nearZ = camera.isOrthographicCamera ? Infinity : -Math.max(camera.near ?? 0.1, 1e-6);
  const toView = world => world.clone().applyMatrix4(view);
  const toScreen = viewPoint => {
    const ndc = viewPoint.clone().applyMatrix4(projection);
    return { x: ((ndc.x + 1) / 2) * widthPx, y: ((1 - ndc.y) / 2) * heightPx };
  };
  return {
    point(world) {
      const p = toView(world);
      return p.z > nearZ ? null : toScreen(p);
    },
    segment(a, b) {
      let va = toView(a), vb = toView(b);
      const aVisible = va.z <= nearZ, bVisible = vb.z <= nearZ;
      if (!aVisible && !bVisible) return null;
      let clipped = false;
      if (!aVisible || !bVisible) {
        const cut = va.clone().lerp(vb, (nearZ - va.z) / (vb.z - va.z));
        if (aVisible) vb = cut; else va = cut;
        clipped = true;
      }
      return { a: toScreen(va), b: toScreen(vb), clipped };
    },
  };
}

const contains = (r, p) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
const inflate = (r, by) => ({ left: r.left - by, top: r.top - by, right: r.right + by, bottom: r.bottom + by });

/** Whether a 2D segment touches a rectangle: Liang-Barsky, edges included. */
function segmentTouchesRect(rect, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  let enter = 0, exit = 1;
  for (const [p, q] of [[-dx, a.x - rect.left], [dx, rect.right - a.x], [-dy, a.y - rect.top], [dy, rect.bottom - a.y]]) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > exit) return false; if (t > enter) enter = t; }
    else { if (t < enter) return false; if (t < exit) exit = t; }
  }
  return true;
}

function insideConvexPolygon(point, polygon) {
  let sign = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (cross === 0) continue;
    const side = Math.sign(cross);
    if (sign === 0) sign = side;
    else if (side !== sign) return false;
  }
  return true;
}

/**
 * A member (standard, ledger, brace) as the segment it projects to. Window
 * needs all of it on screen and inside: a member partly behind the camera is
 * not wholly enclosed by anything.
 */
export function segmentHit(projector, rect, mode, a, b, tolerancePx = CROSSING_TOLERANCE_PX) {
  const s = projector.segment(a, b);
  if (!s) return false;
  if (mode === 'window') return !s.clipped && contains(rect, s.a) && contains(rect, s.b);
  return segmentTouchesRect(inflate(rect, tolerancePx), s.a, s.b);
}

/**
 * A flat part (a deck bay, a load patch) as the outline it projects to, corners
 * in order. Crossing also catches the box lying wholly inside the face.
 */
export function outlineHit(projector, rect, mode, corners) {
  if (!corners.length) return false;
  if (mode === 'window') {
    return corners.every(c => { const p = projector.point(c); return p !== null && contains(rect, p); });
  }
  for (let i = 0; i < corners.length; i++) {
    const s = projector.segment(corners[i], corners[(i + 1) % corners.length]);
    if (s && segmentTouchesRect(rect, s.a, s.b)) return true;
  }
  const outline = corners.map(c => projector.point(c));
  if (outline.some(p => p === null)) return false;
  return insideConvexPolygon({ x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 }, outline);
}

/** Corners of a rectangle lying flat at height z, turned about its centre. */
export function flatRectangleCorners(center, halfX, halfY, rotationZ, z) {
  const cos = Math.cos(rotationZ), sin = Math.sin(rotationZ);
  return [[-halfX, -halfY], [halfX, -halfY], [halfX, halfY], [-halfX, halfY]]
    .map(([x, y]) => new THREE.Vector3(center.x + x * cos - y * sin, center.y + x * sin + y * cos, z));
}

/** How a finished box changes the selection: Shift adds, Ctrl toggles. */
export function combineSelection(previous, hits, { shiftKey = false, ctrlKey = false, metaKey = false } = {}) {
  if (ctrlKey || metaKey) {
    const hitSet = new Set(hits), prevSet = new Set(previous);
    return [...previous.filter(id => !hitSet.has(id)), ...hits.filter(id => !prevSet.has(id))];
  }
  if (shiftKey) return [...new Set([...previous, ...hits])];
  return [...hits];
}

/**
 * Every part of the scaffold the box selects, by id. `parts` is plain data:
 * { segments: [{ id, a, b }], outlines: [{ id, corners }] } with a/b/corners
 * as [x, y, z]. A part drawn as several pieces (a bracket's frame, a truss) is
 * selected by Window only when all of it is inside, by Crossing when any is.
 */
export function marqueeHits(projector, rect, mode, parts) {
  const v = p => new THREE.Vector3(p[0], p[1], p[2]);
  const tally = new Map();
  const note = (id, hit) => {
    const t = tally.get(id) || { any: false, all: true };
    t.any ||= hit; t.all &&= hit;
    tally.set(id, t);
  };
  for (const s of parts.segments || []) note(s.id, segmentHit(projector, rect, mode, v(s.a), v(s.b)));
  for (const o of parts.outlines || []) note(o.id, outlineHit(projector, rect, mode, o.corners.map(v)));
  return [...tally].filter(([, t]) => (mode === 'window' ? t.all : t.any)).map(([id]) => id);
}
