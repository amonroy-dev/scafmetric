// Buildings as they are drawn: the mass, a roof on it, a parapet round it.
// After ScaffoldPro's building entities (rect, polygon and circle masses;
// flat, shed, gable and hip roofs with a rise and an overhang; parapets),
// kept to what a scaffold is built against. Outlines and triangles are plain
// numbers, so they are tested without a canvas.

import * as THREE from 'three';

export const ROOF_TYPES = ['flat', 'gable', 'hip', 'shed', 'cone', 'dome'];
// Which roofs go on which building: ridged ones on a rectangle, a cone or a dome on a round one.
export const RECT_ROOFS = ['gable', 'hip', 'shed'];
export const ROUND_ROOFS = ['cone', 'dome'];
export const BUILDING_SHAPES = ['outline', 'rect', 'round'];
// A round building is drawn, and snapped to, as this many straight walls.
export const ROUND_SIDES = 48;

/** The four corners of a rectangle from two opposite ones. */
export function rectOutline(a, b) {
  const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]);
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

/** A circle as a many-sided outline. */
export function roundOutline(centre, radiusFt, sides = ROUND_SIDES) {
  return Array.from({ length: sides }, (_, i) => {
    const a = (i / sides) * Math.PI * 2;
    return [centre[0] + Math.cos(a) * radiusFt, centre[1] + Math.sin(a) * radiusFt];
  });
}

/** { x0, x1, y0, y1 } when an outline is a rectangle square to the grid, else null. */
export function asRect(points) {
  if (!points || points.length !== 4) return null;
  const xs = [...new Set(points.map(p => Math.round(p[0] * 1000) / 1000))].sort((a, b) => a - b);
  const ys = [...new Set(points.map(p => Math.round(p[1] * 1000) / 1000))].sort((a, b) => a - b);
  if (xs.length !== 2 || ys.length !== 2) return null;
  return { x0: xs[0], x1: xs[1], y0: ys[0], y1: ys[1] };
}

/**
 * A roof over a rectangle as triangles: [[x,y,z] x 3, ...]. `eaveZ` is the top
 * of the walls. `roof` is { type, riseFt, overhangFt, ridge } with ridge 'x',
 * 'y' or unset for along the longer side. A flat roof, or no rise, is none.
 */
export function roofTriangles(rect, eaveZ, roof) {
  const type = roof && RECT_ROOFS.includes(roof.type) ? roof.type : 'flat';
  const rise = Math.max(0, Number(roof && roof.riseFt) || 0);
  if (type === 'flat' || !rect || !(rise > 0)) return [];
  const o = Math.max(0, Number(roof.overhangFt) || 0);
  const x0 = rect.x0 - o, x1 = rect.x1 + o, y0 = rect.y0 - o, y1 = rect.y1 + o;
  const alongX = roof.ridge ? roof.ridge === 'x' : (x1 - x0) >= (y1 - y0);
  // Work with the ridge along u, then put it back.
  const [u0, u1, v0, v1] = alongX ? [x0, x1, y0, y1] : [y0, y1, x0, x1];
  const P = (u, v, z) => (alongX ? [u, v, z] : [v, u, z]);
  const vm = (v0 + v1) / 2, top = eaveZ + rise;
  const a = P(u0, v0, eaveZ), b = P(u1, v0, eaveZ), c = P(u1, v1, eaveZ), d = P(u0, v1, eaveZ);
  const quad = (p, q, r, s) => [[p, q, r], [p, r, s]];
  if (type === 'shed') {
    const ch = P(u1, v1, top), dh = P(u0, v1, top);
    return [...quad(a, b, ch, dh), [a, dh, d], [b, c, ch], ...quad(d, dh, ch, c)];
  }
  const inset = type === 'hip' ? Math.min((v1 - v0) / 2, (u1 - u0) / 2) : 0;
  const r0 = P(u0 + inset, vm, top), r1 = P(u1 - inset, vm, top);
  return [...quad(a, b, r1, r0), ...quad(c, d, r0, r1), [d, a, r0], [b, c, r1]];
}

/**
 * A cone or a dome over a round building as triangles. `round` is { cx, cy,
 * radiusFt }; the eaves stand out by the overhang. A cone rises straight to a
 * point; a dome is the cap of a sphere that high.
 */
export function roundRoofTriangles(round, eaveZ, roof, sides = ROUND_SIDES) {
  const type = roof && ROUND_ROOFS.includes(roof.type) ? roof.type : null;
  const rise = Math.max(0, Number(roof && roof.riseFt) || 0);
  if (!type || !round || !(rise > 0)) return [];
  const r = round.radiusFt + Math.max(0, Number(roof.overhangFt) || 0);
  const bands = type === 'dome' ? 6 : 1;
  // The radius and height of each ring of it, from the eaves (0) to the top (1).
  const ringAt = k => {
    if (type === 'cone') return [r * (1 - k), eaveZ + rise * k];
    const R = (r * r + rise * rise) / (2 * rise);
    const a = Math.asin(Math.min(1, r / R)) * (1 - k);
    return [R * Math.sin(a), eaveZ + rise - (R - R * Math.cos(a))];
  };
  const pt = (ring, i) => { const a = (i / sides) * Math.PI * 2; return [round.cx + Math.cos(a) * ring[0], round.cy + Math.sin(a) * ring[0], ring[1]]; };
  const tris = [];
  for (let b = 0; b < bands; b++) {
    const lo = ringAt(b / bands), hi = ringAt((b + 1) / bands);
    for (let i = 0; i < sides; i++) {
      const p = pt(lo, i), q = pt(lo, i + 1), u = pt(hi, i + 1), v = pt(hi, i);
      tris.push([p, q, u]);
      if (hi[0] > 1e-6) tris.push([p, u, v]);
    }
  }
  return tris;
}

/** The highest point of a building above its own foot: its walls, its parapet or its roof. */
export function buildingTopFt(b) {
  const roof = b.roof && b.roof.type !== 'flat' ? Math.max(0, Number(b.roof.riseFt) || 0) : 0;
  return b.heightFt + Math.max(roof, Math.max(0, Number(b.parapetFt) || 0));
}

/** The meshes that draw a building: its mass, then roof and parapet where it has them. */
export function buildBuildingMeshes(b, massMaterial, roofMaterial) {
  const out = [];
  // Standing on another building, it starts at that one's roof.
  const z0 = Math.max(0, Number(b.baseZ) || 0);
  const shape = new THREE.Shape(b.points.map(p => new THREE.Vector2(p[0], p[1])));
  // A ring: a round building with its middle left open.
  const hollow = b.round ? Math.max(0, Number(b.round.innerRadiusFt) || 0) : 0;
  if (hollow > 0 && hollow < b.round.radiusFt) shape.holes.push(new THREE.Path(roundOutline([b.round.cx, b.round.cy], hollow).reverse().map(p => new THREE.Vector2(p[0], p[1]))));
  const mass = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: b.heightFt, bevelEnabled: false }), massMaterial);
  mass.position.z = z0;
  out.push(mass);
  const top = z0 + b.heightFt;
  const flat = tris => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(2), 3));
    g.computeVertexNormals();
    return g;
  };
  const roof = b.round ? (hollow > 0 ? [] : roundRoofTriangles(b.round, top, b.roof)) : roofTriangles(asRect(b.points), top, b.roof);
  if (roof.length) out.push(new THREE.Mesh(flat(roof), roofMaterial));
  const parapet = Math.max(0, Number(b.parapetFt) || 0);
  if (parapet > 0 && !roof.length) {
    const tris = [];
    b.points.forEach((p, i) => {
      const q = b.points[(i + 1) % b.points.length];
      const lo0 = [p[0], p[1], top], lo1 = [q[0], q[1], top], hi0 = [p[0], p[1], top + parapet], hi1 = [q[0], q[1], top + parapet];
      tris.push([lo0, lo1, hi1], [lo0, hi1, hi0]);
    });
    out.push(new THREE.Mesh(flat(tris), roofMaterial));
  }
  return out;
}
