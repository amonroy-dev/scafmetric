// Procedural scaffold part geometry — no GLB/GLTF assets, no mouthpieces, no
// manufacturer part numbers. Rosettes are plain discs at the connection nodes.
// Dimensions mirror the structural values used by the source scaffold project
// so the base stack-up is correct:
//
//   wood sill (optional) -> jack plate -> jack stem + extension -> base collar
//   (optional) -> standard tube
//
// All world units are FEET, Z-up.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PICK_LAYER } from './instancing.js';
import { TRUSS_FRAMES } from './trussframes.js';

export const inchesToFeet = i => i / 12;

// Structural dimensions (inches).
export const WOOD_SILL = { widthIn: 9, depthIn: 9, thicknessIn: 0.5 };
export const JACK_PLATE = { thicknessIn: 0.375, sizeIn: 6 };
export const JACK_STEM = { baseHeightIn: 2, rodDiameterIn: 1.25 };
export const HANDLE_NUT = { diameterIn: 3.6, heightIn: 1.25, wingLenIn: 2.4, wingThickIn: 0.4, wingHeightIn: 0.75 };
// Base collar, drawn the way ScaffoldPro's collar is built (measured off its
// model, not loaded from it): a 1.9 in tube that slips over the jack, and a
// 2.25 in sleeve the foot of the standard drops into, starting half an inch
// below the standard's base and running 5 1/2 in up it. Its rosette is a
// connection node (lift 0, see ScaffoldState.nodes) and is drawn with the
// others. heightIn is the stack-up from jack top to standard base, which the
// takeoff and node heights use; it is unchanged.
export const BASE_COLLAR = {
  heightIn: 7.0,
  tubeOdIn: 1.9,
  sleeveOdIn: 2.25,
  sleeveBelowBaseIn: 0.5,
  sleeveAboveBaseIn: 5.5,
  wallIn: 0.12,
};
export const STANDARD_TUBE_OD_IN = 1.9;
export const STANDARD_TUBE_WALL_IN = 0.12;
export const TUBE_RADIAL_SEGMENTS = 12;

// Height from ground to the bottom of the standard tube. Must match the load
// takeoff and the ghost preview exactly.
export function getStandardBaseOffsetFt(jackExtensionIn, showWoodSill, showBaseCollar) {
  let offset = 0;
  if (showWoodSill) offset += inchesToFeet(WOOD_SILL.thicknessIn);
  offset += inchesToFeet(JACK_PLATE.thicknessIn);
  offset += inchesToFeet(JACK_STEM.baseHeightIn + jackExtensionIn);
  if (showBaseCollar) offset += inchesToFeet(BASE_COLLAR.heightIn);
  return offset;
}

export const MATERIALS = {
  steel: new THREE.MeshStandardMaterial({ color: 0xb8bcc0, metalness: 0.32, roughness: 0.28 }),
  hardware: new THREE.MeshStandardMaterial({ color: 0x6a6f75, metalness: 0.45, roughness: 0.35 }),
  wood: new THREE.MeshStandardMaterial({ color: 0xc4a574, metalness: 0, roughness: 0.85 }),
  ledger: new THREE.MeshStandardMaterial({ color: 0xa8aeb6, metalness: 0.3, roughness: 0.32 }),
  brace: new THREE.MeshStandardMaterial({ color: 0x98a0aa, metalness: 0.3, roughness: 0.36 }),
  plank: new THREE.MeshStandardMaterial({ color: 0xd9a441, metalness: 0.18, roughness: 0.62 }),
  selected: new THREE.MeshStandardMaterial({ color: 0x2563eb, emissive: 0x1d4ed8, emissiveIntensity: 0.35, metalness: 0.2, roughness: 0.4 }),
  ghost: new THREE.MeshStandardMaterial({ color: 0x2563eb, transparent: true, opacity: 0.4, depthWrite: false, metalness: 0.2, roughness: 0.5 }),
  // The brace preview is green and glows, as ScaffoldPro's does: one thin
  // diagonal in the ghost blue above was all but invisible against the grid.
  // The whole-perimeter preview is a little quieter, there being many of them.
  braceGhost: new THREE.MeshStandardMaterial({ color: 0x16a34a, emissive: 0x22c55e, emissiveIntensity: 0.55, transparent: true, opacity: 0.9, depthWrite: false, metalness: 0.2, roughness: 0.4 }),
  braceGhostRun: new THREE.MeshStandardMaterial({ color: 0x16a34a, emissive: 0x22c55e, emissiveIntensity: 0.45, transparent: true, opacity: 0.75, depthWrite: false, metalness: 0.2, roughness: 0.4 }),
  // Send to beam: the leg a click would take. Drawn over everything, so it
  // shows from above, where a leg is a dot under its deck.
  legHover: new THREE.MeshBasicMaterial({ color: 0x2563eb, transparent: true, opacity: 0.38, depthTest: false, depthWrite: false }),
};

// Shared geometries (never disposed; scaled per instance).
// Unit cylinder: radius 1, height 1, axis +Z (rotated from the default +Y).
const UNIT_CYL_Z = new THREE.CylinderGeometry(1, 1, 1, TUBE_RADIAL_SEGMENTS);
UNIT_CYL_Z.rotateX(Math.PI / 2);
// Unit cylinder along +Y, for arbitrary-direction tubes (ledgers/braces).
const UNIT_CYL_Y = new THREE.CylinderGeometry(1, 1, 1, TUBE_RADIAL_SEGMENTS);
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

// A standard is a tube, 1.9 in OD with a 0.12 in wall, and is drawn as one: an
// outer skin, an inner skin facing the bore, and a ring closing each end, so
// the open top of a leg shows its wall instead of a solid round bar. Unit
// outer radius and height along +Z, scaled per instance like the cylinders.
const UNIT_TUBE_Z = (() => {
  const bore = (STANDARD_TUBE_OD_IN - 2 * STANDARD_TUBE_WALL_IN) / STANDARD_TUBE_OD_IN;
  const outer = new THREE.CylinderGeometry(1, 1, 1, TUBE_RADIAL_SEGMENTS, 1, true);
  const inner = new THREE.CylinderGeometry(bore, bore, 1, TUBE_RADIAL_SEGMENTS, 1, true);
  // Turn the inner skin to face the bore: reverse each triangle and its normals.
  const idx = inner.index.array;
  for (let i = 0; i < idx.length; i += 3) { const t = idx[i]; idx[i] = idx[i + 2]; idx[i + 2] = t; }
  const n = inner.attributes.normal.array;
  for (let i = 0; i < n.length; i++) n[i] = -n[i];
  const top = new THREE.RingGeometry(bore, 1, TUBE_RADIAL_SEGMENTS).rotateX(-Math.PI / 2).translate(0, 0.5, 0);
  const bottom = new THREE.RingGeometry(bore, 1, TUBE_RADIAL_SEGMENTS).rotateX(Math.PI / 2).translate(0, -0.5, 0);
  const parts = [outer, inner, top, bottom];
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  merged.rotateX(Math.PI / 2);
  return merged;
})();
const HEX_GEO = new THREE.CylinderGeometry(1, 1, 1, 6);
HEX_GEO.rotateX(Math.PI / 2);

const UNIT_SPHERE = new THREE.SphereGeometry(1, 16, 12);

/** A ball the size of a tube, to close the outside of a bend between two tubes. */
function jointBall(at, odIn, material) {
  const r = inchesToFeet(odIn) / 2;
  return mesh(UNIT_SPHERE, material, at, [r, r, r]);
}

export const SHARED_GEO = { UNIT_CYL_Z, UNIT_CYL_Y, UNIT_BOX, HEX_GEO };

function mesh(geo, mat, pos, scale) {
  const m = new THREE.Mesh(geo, mat);
  if (pos) m.position.set(pos[0], pos[1], pos[2]);
  if (scale) m.scale.set(scale[0], scale[1], scale[2]);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// A standard: a hollow tube from z0 to z1 at (x,y), outside diameter in inches
// (the wall keeps the standard's own proportion, 0.12 in on 1.9 in).
export function verticalTube(x, y, z0, z1, odIn, material) {
  const r = inchesToFeet(odIn) / 2;
  const h = Math.max(z1 - z0, 1e-6);
  return mesh(UNIT_TUBE_Z, material, [x, y, z0 + h / 2], [r, r, h]);
}

// A solid column round a leg, to light it up: `odIn` across, from z0 to z1.
export function legColumn(x, y, z0, z1, odIn, material) {
  const r = inchesToFeet(odIn) / 2;
  const h = Math.max(z1 - z0, 1e-6);
  const m = mesh(UNIT_CYL_Z, material, [x, y, z0 + h / 2], [r, r, h]);
  m.castShadow = false;
  m.receiveShadow = false;
  return m;
}

// Tube between two arbitrary world points (ledgers, braces).
const _up = new THREE.Vector3(0, 1, 0);
export function tubeBetween(a, b, odIn, material) {
  const r = inchesToFeet(odIn) / 2;
  const av = new THREE.Vector3(a[0], a[1], a[2]);
  const dir = new THREE.Vector3(b[0], b[1], b[2]).sub(av);
  const len = Math.max(dir.length(), 1e-6);
  const m = new THREE.Mesh(UNIT_CYL_Y, material);
  m.position.copy(av).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(_up, dir.clone().normalize());
  m.scale.set(r, len, r);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/**
 * A stair flight as it is drawn: a stringer down each side and its treads.
 * `f` is { lower:[[x,y],[x,y]], upper:[[x,y],[x,y]], z0, z1, treads }.
 */
// A stair stringer is drawn as a rectangular tube on edge: 6 in deep, 2 in wide.
export const STRINGER_DEPTH_IN = 6;
export const STRINGER_WIDTH_IN = 2;
// Each stands this far in from the standards its ledgers hang on, clear of them.
const STRINGER_INSET_FT = 0.25;

/** A rectangular tube from a to b, `depthIn` up its side and `widthIn` across, standing on edge. */
export function rectTubeBetween(a, b, depthIn, widthIn, material) {
  const from = new THREE.Vector3(a[0], a[1], a[2]), along = new THREE.Vector3(b[0], b[1], b[2]).sub(from);
  const len = Math.max(along.length(), 1e-6);
  const x = along.clone().normalize();
  // Its width lies level, square to the run; its depth is square to both.
  const y = new THREE.Vector3(0, 0, 1).cross(x);
  if (y.lengthSq() < 1e-9) y.set(0, 1, 0);
  y.normalize();
  const z = x.clone().cross(y);
  const m = new THREE.Mesh(UNIT_BOX, material);
  m.position.copy(from).addScaledVector(along, 0.5);
  m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  m.scale.set(len, inchesToFeet(widthIn), inchesToFeet(depthIn));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** The centre lines of a flight's two stringers: [[a, b], [a, b]], each a little in from its standards. */
export function stairStringerLines(f) {
  const cx = (f.lower[0][0] + f.lower[1][0]) / 2, cy = (f.lower[0][1] + f.lower[1][1]) / 2;
  return [0, 1].map(i => {
    const dx = cx - f.lower[i][0], dy = cy - f.lower[i][1], d = Math.hypot(dx, dy) || 1;
    const ox = (dx / d) * STRINGER_INSET_FT, oy = (dy / d) * STRINGER_INSET_FT;
    return [[f.lower[i][0] + ox, f.lower[i][1] + oy, f.z0], [f.upper[i][0] + ox, f.upper[i][1] + oy, f.z1]];
  });
}

export function buildStairFlight(f, material) {
  const out = [];
  for (const [a, b] of stairStringerLines(f)) out.push(rectTubeBetween(a, b, STRINGER_DEPTH_IN, STRINGER_WIDTH_IN, material));
  const n = Math.max(0, Math.round(f.treads || 0));
  for (let k = 1; k <= n; k++) {
    const t = k / (n + 1);
    const p = i => [f.lower[i][0] + (f.upper[i][0] - f.lower[i][0]) * t, f.lower[i][1] + (f.upper[i][1] - f.lower[i][1]) * t];
    const a = p(0), b = p(1);
    const run = Math.hypot(f.upper[0][0] - f.lower[0][0], f.upper[0][1] - f.lower[0][1]) || 1;
    const half = 0.4; // a tread is about 10 in from front to back
    const rx = ((f.upper[0][0] - f.lower[0][0]) / run) * half, ry = ((f.upper[0][1] - f.lower[0][1]) / run) * half;
    const z = f.z0 + (f.z1 - f.z0) * t;
    out.push(plankDeck(Math.min(a[0], b[0]) - Math.abs(rx), Math.min(a[1], b[1]) - Math.abs(ry), Math.max(a[0], b[0]) + Math.abs(rx), Math.max(a[1], b[1]) + Math.abs(ry), z, material));
  }
  return out;
}

// Plank deck covering a rectangle at height z.
export function plankDeck(x0, y0, x1, y1, z, material) {
  const w = Math.max(Math.abs(x1 - x0), 0.1);
  const d = Math.max(Math.abs(y1 - y0), 0.1);
  return mesh(UNIT_BOX, material, [(x0 + x1) / 2, (y0 + y1) / 2, z + 0.06], [w, d, 0.12]);
}

/**
 * Build the full base assembly at ground point (x,y,groundZ).
 * Returns { meshes, topZ } where topZ is the bottom of the standard tube.
 * Each mesh carries userData.part so picking can report which component was hit.
 */
export function buildBaseAssembly(opts) {
  const {
    x, y, groundZ = 0, jackExtensionIn = 0,
    showWoodSill = true, showBaseCollar = true, material = null,
  } = opts;
  const meshes = [];
  const steel = material || MATERIALS.steel;
  const hardware = material || MATERIALS.hardware;
  const wood = material || MATERIALS.wood;
  let z = groundZ;

  if (showWoodSill) {
    const t = inchesToFeet(WOOD_SILL.thicknessIn);
    const m = mesh(UNIT_BOX, wood, [x, y, z + t / 2],
      [inchesToFeet(WOOD_SILL.widthIn), inchesToFeet(WOOD_SILL.depthIn), t]);
    m.userData.part = 'wood-sill';
    meshes.push(m);
    z += t;
  }

  const plateT = inchesToFeet(JACK_PLATE.thicknessIn);
  const plate = mesh(UNIT_BOX, steel, [x, y, z + plateT / 2],
    [inchesToFeet(JACK_PLATE.sizeIn), inchesToFeet(JACK_PLATE.sizeIn), plateT]);
  plate.userData.part = 'screw-jack';
  meshes.push(plate);
  z += plateT;

  const rodH = inchesToFeet(JACK_STEM.baseHeightIn + jackExtensionIn);
  const rodR = inchesToFeet(JACK_STEM.rodDiameterIn) / 2;
  const rod = mesh(UNIT_CYL_Z, steel, [x, y, z + rodH / 2], [rodR, rodR, rodH]);
  rod.userData.part = 'screw-jack';
  meshes.push(rod);
  const jackTopZ = z + rodH;

  // Handle nut, top flush with the jack top.
  const nutH = inchesToFeet(HANDLE_NUT.heightIn);
  const nutR = inchesToFeet(HANDLE_NUT.diameterIn) / 2;
  const nutZ = jackTopZ - nutH / 2;
  const nut = mesh(HEX_GEO, hardware, [x, y, nutZ], [nutR, nutR, nutH]);
  nut.userData.part = 'screw-jack';
  meshes.push(nut);
  const wingL = inchesToFeet(HANDLE_NUT.wingLenIn);
  const wingT = inchesToFeet(HANDLE_NUT.wingThickIn);
  const wingH = inchesToFeet(HANDLE_NUT.wingHeightIn);
  for (const sign of [1, -1]) {
    const w = mesh(UNIT_BOX, hardware,
      [x + sign * (nutR + wingL / 2), y, nutZ], [wingL, wingT, wingH]);
    w.userData.part = 'screw-jack';
    meshes.push(w);
  }
  z = jackTopZ;

  if (showBaseCollar) {
    const h = inchesToFeet(BASE_COLLAR.heightIn);
    const rTube = inchesToFeet(BASE_COLLAR.tubeOdIn) / 2;
    const tube = mesh(UNIT_CYL_Z, steel, [x, y, z + h / 2], [rTube, rTube, h]);
    tube.userData.part = 'base-collar';
    meshes.push(tube);
    // The sleeve the standard sits in, straddling the standard's base.
    const s0 = z + h - inchesToFeet(BASE_COLLAR.sleeveBelowBaseIn);
    const s1 = z + h + inchesToFeet(BASE_COLLAR.sleeveAboveBaseIn);
    const rSleeve = inchesToFeet(BASE_COLLAR.sleeveOdIn) / 2;
    const sleeve = mesh(UNIT_CYL_Z, steel, [x, y, (s0 + s1) / 2], [rSleeve, rSleeve, s1 - s0]);
    sleeve.userData.part = 'base-collar';
    meshes.push(sleeve);
    z += h;
  }

  return { meshes, topZ: z };
}

// ---------------------------------------------------------------------------
// Rosette connection nodes (procedural disk — NOT a GLB model).
// Real visual size from the source app: 4.84 in diameter x 0.36 in thick.
// ---------------------------------------------------------------------------
export const ROSETTE = { diameterIn: 4.84, thicknessIn: 0.36, radialSegments: 20 };

const ROSETTE_GEO = new THREE.CylinderGeometry(1, 1, 1, ROSETTE.radialSegments);
ROSETTE_GEO.rotateX(Math.PI / 2);

export function rosetteDisk(x, y, z, material) {
  const r = inchesToFeet(ROSETTE.diameterIn) / 2;
  const t = inchesToFeet(ROSETTE.thicknessIn);
  const m = new THREE.Mesh(ROSETTE_GEO, material || MATERIALS.hardware);
  m.position.set(x, y, z);
  m.scale.set(r, r, t);
  m.castShadow = true;
  return m;
}

// ---------------------------------------------------------------------------
// Planks — profiled deck board, matching how Scaffxiq_v2 draws them.
// Unit space: x = width, y = length, z = profile depth; scaled per instance.
// ---------------------------------------------------------------------------
// topAboveCentre: where the walking surface sits in the board's profile, as a
// fraction of its depth above the profile's centre (the profile below has its
// top face at 0.44, with the ribs hanging further down than the top stands up).
// Timber tan, so a deck reads as a deck: steel is grey, blue means selected or
// previewed, and cyan is a live load patch.
export const PLANK = { widthIn: 9, narrowWidthIn: 6, profileDepthIn: 2.25, topAboveCentre: 0.44, color: 0xc8a472 };

const PLANK_PROFILE_GEO = (() => {
  const geoms = [];
  const pushBox = (sx, sy, sz, x, y, z) => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    g.applyMatrix4(new THREE.Matrix4().makeTranslation(x, y, z));
    geoms.push(g);
  };
  pushBox(0.98, 0.96, 0.08, 0, 0, 0.4);      // deck top
  pushBox(0.06, 0.96, 0.56, -0.47, 0, 0.12); // side wall
  pushBox(0.06, 0.96, 0.56, 0.47, 0, 0.12);  // side wall
  pushBox(0.76, 0.06, 0.16, 0, -0.31, -0.27); // bottom rib
  pushBox(0.76, 0.06, 0.16, 0, 0, -0.27);     // bottom rib
  pushBox(0.76, 0.06, 0.16, 0, 0.31, -0.27);  // bottom rib
  const merged = mergeGeometries(geoms, false) || new THREE.BufferGeometry();
  for (const g of geoms) g.dispose();
  merged.computeVertexNormals();
  return merged;
})();

export const PLANK_MATERIAL = new THREE.MeshStandardMaterial({
  color: PLANK.color, metalness: 0.05, roughness: 0.7,
});

/**
 * One plank board. center = [x,y,z] of the board centre (z = top of ledger),
 * rotationZ aligns the board length, lengthFt spans the bay, widthIn is 9 or 6.
 */
export function plankBoard(center, rotationZ, lengthFt, widthIn, material) {
  const m = new THREE.Mesh(PLANK_PROFILE_GEO, material || PLANK_MATERIAL);
  m.position.set(center[0], center[1], center[2]);
  m.rotation.z = rotationZ;
  m.scale.set(inchesToFeet(widthIn), lengthFt, inchesToFeet(PLANK.profileDepthIn));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/**
 * Best-fit plank layout across a bay, ported from Scaffxiq_v2 plankLayout.ts.
 * Packs as many 9 in boards as possible, fills the remainder with 6 in boards,
 * and centres the run. Returns [{ widthIn, centerOffsetFt }].
 */
export function buildBestFitPlankLayout(usableSpanIn) {
  const NARROW = PLANK.narrowWidthIn;
  if (!Number.isFinite(usableSpanIn) || usableSpanIn < NARROW) return [];

  let bestCovered = 0, bestNine = 0, bestSix = 0;
  const maxNine = Math.floor(usableSpanIn / PLANK.widthIn);
  for (let nine = maxNine; nine >= 0; nine--) {
    const remaining = Math.max(0, usableSpanIn - nine * PLANK.widthIn);
    const six = Math.floor(remaining / NARROW);
    const covered = nine * PLANK.widthIn + six * NARROW;
    const better =
      covered > bestCovered ||
      (covered === bestCovered && nine > bestNine) ||
      (covered === bestCovered && nine === bestNine && six < bestSix);
    if (better) { bestCovered = covered; bestNine = nine; bestSix = six; }
  }
  if (bestCovered < NARROW) return [];

  const leftNine = Math.floor(bestNine / 2);
  const rightNine = bestNine - leftNine;
  const widths = [
    ...Array.from({ length: leftNine }, () => PLANK.widthIn),
    ...Array.from({ length: bestSix }, () => NARROW),
    ...Array.from({ length: rightNine }, () => PLANK.widthIn),
  ];
  let cursor = -bestCovered / 2;
  return widths.map(widthIn => {
    const centerOffsetFt = inchesToFeet(cursor + widthIn / 2);
    cursor += widthIn;
    return { widthIn, centerOffsetFt };
  });
}

// ---------------------------------------------------------------------------
// Side bracket — the frame ScaffoldPro's line view draws (its bracketFrame.ts,
// measured there off the bracket models; only the geometry is kept here, no
// part numbers):
//
//   chord     level, from the rosette it hangs on out to the tip
//   post      short vertical near the standard, chord down to the diagonal
//   diagonal  from a fixing on the standard, below the rosette, up to the
//             tip, landing on the socket a little below the chord
//   socket    vertical stub at the tip, up to where a standard would seat
//
// The tip carries a rosette, which is a connection node (ScaffoldState.nodes).
// Local axes: `out` from the standard's centreline, `up` from the rosette.
// ---------------------------------------------------------------------------
export const BRACKET = {
  chordOdIn: 1.9,
  postOdIn: 1.625,
  socketOdIn: 1.9,
  // Where a standard dropped into the socket bottoms out, above the rosette.
  socketShoulderUpFt: 0.3271,
};

// Per reach. The 3 ft and 3 ft 6 in brackets hang their diagonal from twice
// as far down as the 2 ft one.
const SIDE_BRACKET_FRAMES = [
  { reachFt: 2, lowerFixingUpFt: -1.3692, diagonalTopUpFt: -0.2148, postOutFt: 0.3654, diagonalOdIn: 1.625 },
  { reachFt: 3, lowerFixingUpFt: -2.7111, diagonalTopUpFt: -0.1926, postOutFt: 0.3826, diagonalOdIn: 1.9 },
  { reachFt: 3.5, lowerFixingUpFt: -2.6889, diagonalTopUpFt: -0.2333, postOutFt: 0.381, diagonalOdIn: 1.9 },
];

/**
 * The bracket frame for a reach: named points as [out, up] in feet, and the
 * members between them. A reach between the measured ones takes the nearest
 * one's shape at its own length.
 */
export function sideBracketFrame(lengthFt) {
  const f = SIDE_BRACKET_FRAMES.reduce((best, c) =>
    (Math.abs(c.reachFt - lengthFt) < Math.abs(best.reachFt - lengthFt) ? c : best));
  const reach = lengthFt;
  // The post's foot sits ON the diagonal, so the frame closes.
  const rise = f.diagonalTopUpFt - f.lowerFixingUpFt;
  const postFootUp = f.lowerFixingUpFt + (f.postOutFt / reach) * rise;
  const points = {
    mount: [0, 0],
    tip: [reach, 0],
    postHead: [f.postOutFt, 0],
    postFoot: [f.postOutFt, postFootUp],
    lowerFixing: [0, f.lowerFixingUpFt],
    diagonalTop: [reach, f.diagonalTopUpFt],
    socketShoulder: [reach, BRACKET.socketShoulderUpFt],
  };
  const members = [
    { a: 'mount', b: 'postHead', role: 'chord', odIn: BRACKET.chordOdIn },
    { a: 'postHead', b: 'tip', role: 'chord', odIn: BRACKET.chordOdIn },
    { a: 'lowerFixing', b: 'postFoot', role: 'diagonal', odIn: f.diagonalOdIn },
    { a: 'postFoot', b: 'diagonalTop', role: 'diagonal', odIn: f.diagonalOdIn },
    { a: 'postHead', b: 'postFoot', role: 'post', odIn: BRACKET.postOdIn },
    { a: 'diagonalTop', b: 'tip', role: 'socket', odIn: BRACKET.socketOdIn },
    { a: 'tip', b: 'socketShoulder', role: 'socket', odIn: BRACKET.socketOdIn },
  ];
  return { points, members };
}

function bracketAxes(dir) {
  const len = Math.hypot(dir[0], dir[1]) || 1;
  return [dir[0] / len, dir[1] / len];
}

/** The bracket's members in world feet, hung at `node`, pointing along `dir`. */
export function sideBracketWorldMembers(node, dir, lengthFt) {
  const [ux, uy] = bracketAxes(dir);
  const { points, members } = sideBracketFrame(lengthFt);
  const at = ([out, up]) => [node.x + ux * out, node.y + uy * out, node.z + up];
  return members.map(m => ({ a: at(points[m.a]), b: at(points[m.b]), role: m.role, odIn: m.odIn }));
}

/** Where the bracket's tip rosette is, in world feet. */
export function sideBracketTip(node, dir, lengthFt) {
  const [ux, uy] = bracketAxes(dir);
  return [node.x + ux * lengthFt, node.y + uy * lengthFt, node.z];
}

/**
 * How far out from its standard a bracket's own weight acts: the centre of its
 * tube, taken by length, since every member is weighed at the same pounds a
 * foot. A little under half the reach.
 */
export function sideBracketCentroidOutFt(lengthFt) {
  const { points, members } = sideBracketFrame(lengthFt);
  let tube = 0, moment = 0;
  for (const m of members) {
    const [ao, au] = points[m.a], [bo, bu] = points[m.b];
    const len = Math.hypot(bo - ao, bu - au);
    tube += len;
    moment += len * (ao + bo) / 2;
  }
  return tube > 0 ? moment / tube : 0;
}

/** Total tube in one bracket, for its self-weight. */
export function sideBracketTubeLengthFt(lengthFt) {
  const { points, members } = sideBracketFrame(lengthFt);
  return members.reduce((sum, m) => {
    const [ao, au] = points[m.a], [bo, bu] = points[m.b];
    return sum + Math.hypot(bo - ao, bu - au);
  }, 0);
}

/**
 * Build a side bracket at a node, projecting horizontally along `dir` ([dx,dy],
 * need not be normalised). Returns an array of meshes, one per member.
 */
export function buildSideBracket(node, dir, lengthFt, material) {
  const mat = material || MATERIALS.ledger;
  const members = sideBracketWorldMembers(node, dir, lengthFt);
  const meshes = members.map(m => tubeBetween(m.a, m.b, m.odIn, mat));
  // Where the diagonal runs into the foot of the socket the two tubes meet at
  // an angle, and square-cut cylinders leave a notch on the outside of the
  // bend. A ball of the tube's own size there closes it into one smooth elbow.
  const diagonal = members.filter(m => m.role === 'diagonal').pop();
  const socketOd = Math.max(...members.filter(m => m.role === 'socket').map(m => m.odIn));
  if (diagonal) meshes.push(jointBall(diagonal.b, Math.max(diagonal.odIn, socketOd), mat));
  return meshes;
}

// ---------------------------------------------------------------------------
// Trusses - the frames ScaffoldPro's centerline view draws (trussframes.js,
// generated from its truss frame data), in three families:
//
//   light  a truss ledger: a top chord with a shallow bottom member a few
//          inches below it, tied by flat bar webs
//   heavy  a heavy-duty truss ledger: a king post, or a small trapezoid on
//          the longer sizes
//   truss  a lattice girder: two parallel chords 1 ft 7 11/16 in apart with a
//          tube web
//
// A truss spans two rosettes at one lift. Its top chord runs between them and
// the rest hangs straight down in the vertical plane of the span.
// ---------------------------------------------------------------------------
export const TRUSS_FAMILIES = ['light', 'heavy', 'truss'];

/** The frame for a family nearest a span. Legacy trusses carry no family. */
export function trussFrameFor(family, spanFt) {
  const list = TRUSS_FRAMES[family] || TRUSS_FRAMES.truss;
  return list.reduce((best, t) => (Math.abs(t.lengthFt - spanFt) < Math.abs(best.lengthFt - spanFt) ? t : best));
}

/** Every member of a truss between two rosettes, as world-space segments. */
export function trussWorldMembers(a, b, family = 'truss') {
  const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  const span = Math.hypot(dx, dy, dz) || 1e-6;
  const frame = trussFrameFor(family, span);
  // Fitted to the rosettes: the end nodes land exactly on the connections.
  const scale = span / frame.lengthFt;
  const ux = dx / span, uy = dy / span, uz = dz / span;
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const at = ([s, d]) => [mid[0] + ux * s * scale, mid[1] + uy * s * scale, mid[2] + uz * s * scale + d];
  return frame.members.map(([i, j, role, odIn, plateWidthIn, plateThicknessIn]) => ({
    a: at(frame.nodes[i]), b: at(frame.nodes[j]), role, odIn,
    plate: plateWidthIn ? { widthIn: plateWidthIn, thicknessIn: plateThicknessIn } : null,
  }));
}

/**
 * Tubing in a truss for its self-weight, as feet of ledger tube: smaller
 * tubes and the flat bar webs count for less in proportion to their steel.
 */
export function trussMemberLengthFt(spanFt, family = 'truss') {
  let total = 0;
  for (const m of trussWorldMembers([0, 0, 0], [spanFt, 0, 0], family)) {
    const len = Math.hypot(m.b[0] - m.a[0], m.b[1] - m.a[1], m.b[2] - m.a[2]);
    total += len * (m.plate ? (m.plate.widthIn * m.plate.thicknessIn) / 0.671 : m.odIn / STANDARD_TUBE_OD_IN);
  }
  return total;
}

// A flat bar web, standing on edge: its width lies in the vertical plane of
// the truss and its thickness across it. `across` is the horizontal normal to
// that plane, taken from the span so a vertical web knows which way to face.
function flatBarBetween(a, b, widthIn, thicknessIn, material, across) {
  const av = new THREE.Vector3(a[0], a[1], a[2]);
  const dir = new THREE.Vector3(b[0], b[1], b[2]).sub(av);
  const len = Math.max(dir.length(), 1e-6);
  dir.divideScalar(len);
  // Right-handed: X (width) x Y (length) = Z (thickness). A mirrored basis is
  // not a rotation, and laid the plate flat.
  const inPlane = new THREE.Vector3().crossVectors(dir, across).normalize();
  const m = new THREE.Mesh(UNIT_BOX, material);
  m.position.copy(av).addScaledVector(dir, len / 2);
  m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(inPlane, dir, across));
  m.scale.set(inchesToFeet(widthIn), len, inchesToFeet(thicknessIn));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export function buildTruss(a, b, material, family = 'truss') {
  const mat = material || MATERIALS.ledger;
  // Horizontal normal to the truss's plane.
  const across = new THREE.Vector3(-(b[1] - a[1]), b[0] - a[0], 0);
  if (across.lengthSq() < 1e-12) across.set(0, 1, 0);
  across.normalize();
  return trussWorldMembers(a, b, family).map(m => (m.plate
    ? flatBarBetween(m.a, m.b, m.plate.widthIn, m.plate.thicknessIn, mat, across)
    : tubeBetween(m.a, m.b, m.odIn, mat)));
}

// Guardrail rail/post tubing.
export const GUARDRAIL_OD_IN = 1.69;

// --- live load patches -------------------------------------------------------
// A translucent slab over a decked bay with span arrows on it: double-headed,
// the way a framing plan marks a one-way deck, pointing at the two ledgers
// that carry the load. Turn the load and the arrows turn with it.

const LIVE_LOAD_VISUAL_THICKNESS_FT = inchesToFeet(0.35);
const LOAD_ARROW_THICKNESS_FT = inchesToFeet(0.3);
const LOAD_ARROW_SHAFT_WIDTH_FT = inchesToFeet(1.25);
// The arrows stop this far short of the ledgers they point at.
const LOAD_ARROW_END_GAP_FT = inchesToFeet(3);
// One arrow for about this much of the bay, three at most.
const LOAD_ARROW_PITCH_FT = 2.5;
const LOAD_ARROW_MAX_HEAD_FT = 0.75;

// A flat triangle with its tip at +X: unit length, width and thickness.
const ARROW_HEAD_GEO = (() => {
  const shape = new THREE.Shape();
  shape.moveTo(0.5, 0);
  shape.lineTo(-0.5, 0.5);
  shape.lineTo(-0.5, -0.5);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false });
  geo.translate(0, 0, -0.5);
  return geo;
})();

let _liveLoadMaterial = null;
export function liveLoadMaterial() {
  if (_liveLoadMaterial) return _liveLoadMaterial;
  _liveLoadMaterial = new THREE.MeshStandardMaterial({
    color: 0x22d3ee,
    emissive: 0x22d3ee,
    emissiveIntensity: 0.34,
    transparent: true,
    // Light enough that the boards still read through it; the arrows carry the message.
    opacity: 0.2,
    metalness: 0.08,
    roughness: 0.48,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return _liveLoadMaterial;
}

let _liveLoadGhostMaterial = null;
export function liveLoadGhostMaterial() {
  if (_liveLoadGhostMaterial) return _liveLoadGhostMaterial;
  _liveLoadGhostMaterial = new THREE.MeshStandardMaterial({
    color: 0xfbbf24,
    emissive: 0xf59e0b,
    emissiveIntensity: 0.2,
    transparent: true,
    opacity: 0.34,
    metalness: 0.05,
    roughness: 0.38,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return _liveLoadGhostMaterial;
}

// Unlit, so the arrows read the same from every side and in every light.
let _liveLoadArrowMaterial = null;
export function liveLoadArrowMaterial() {
  if (!_liveLoadArrowMaterial) _liveLoadArrowMaterial = new THREE.MeshBasicMaterial({ color: 0x0e7490 });
  return _liveLoadArrowMaterial;
}

let _liveLoadGhostArrowMaterial = null;
export function liveLoadGhostArrowMaterial() {
  if (!_liveLoadGhostArrowMaterial) {
    _liveLoadGhostArrowMaterial = new THREE.MeshBasicMaterial({ color: 0xb45309, transparent: true, opacity: 0.9, depthWrite: false });
  }
  return _liveLoadGhostArrowMaterial;
}

/**
 * Slab for one resolved live load patch. `widthFt` is the span, between the
 * ledgers that carry the load; `lengthFt` runs along them.
 */
export function liveLoadPatch(patch, material) {
  const m = new THREE.Mesh(UNIT_BOX, material || liveLoadMaterial());
  m.position.set(patch.center[0], patch.center[1], patch.center[2]);
  m.rotation.z = patch.rotationZ;
  m.scale.set(patch.widthFt, patch.lengthFt, LIVE_LOAD_VISUAL_THICKNESS_FT);
  return m;
}

/**
 * Where the span arrows go on a patch, in plan: [{ from: [x, y], to: [x, y] }],
 * each running along the span from just inside one supporting ledger to just
 * inside the other, spread evenly over the bay.
 */
export function liveLoadArrowLayout(patch) {
  const [sx, sy] = patch.span;
  const half = patch.widthFt / 2 - LOAD_ARROW_END_GAP_FT;
  if (!(half > 0.2)) return [];
  const count = Math.max(1, Math.min(3, Math.round(patch.lengthFt / LOAD_ARROW_PITCH_FT)));
  const out = [];
  for (let i = 0; i < count; i++) {
    const v = patch.lengthFt * ((i + 0.5) / count - 0.5);
    const cx = patch.center[0] - sy * v, cy = patch.center[1] + sx * v;
    out.push({ from: [cx - sx * half, cy - sy * half], to: [cx + sx * half, cy + sy * half] });
  }
  return out;
}

/** The span arrows of a patch as meshes: a shaft, and a head at each end. */
export function liveLoadArrows(patch, material) {
  const mat = material || liveLoadArrowMaterial();
  const z = patch.center[2] + LIVE_LOAD_VISUAL_THICKNESS_FT / 2 + LOAD_ARROW_THICKNESS_FT / 2;
  const out = [];
  for (const { from, to } of liveLoadArrowLayout(patch)) {
    const dx = to[0] - from[0], dy = to[1] - from[1];
    const len = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    const head = Math.min(LOAD_ARROW_MAX_HEAD_FT, len * 0.22);
    const shaft = new THREE.Mesh(UNIT_BOX, mat);
    shaft.position.set((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, z);
    shaft.rotation.z = angle;
    shaft.scale.set(Math.max(0.01, len - 2 * head + 0.02), LOAD_ARROW_SHAFT_WIDTH_FT, LOAD_ARROW_THICKNESS_FT);
    out.push(shaft);
    for (const [end, turn] of [[to, 0], [from, Math.PI]]) {
      const tip = new THREE.Mesh(ARROW_HEAD_GEO, mat);
      const ux = Math.cos(angle + turn), uy = Math.sin(angle + turn);
      tip.position.set(end[0] - ux * head / 2, end[1] - uy * head / 2, z);
      tip.rotation.z = angle + turn;
      tip.scale.set(head, head * 0.8, LOAD_ARROW_THICKNESS_FT);
      out.push(tip);
    }
  }
  return out;
}

// --- connection node markers -------------------------------------------------
// The visual rosette is a thin disc, which is almost impossible to click when
// seen edge on. The source app draws its markers as spheres, so each node also
// gets an invisible spherical pick proxy that is forgiving to aim at.

export const NODE_PICK_DIAMETER_IN = 7;
const NODE_PICK_GEO = new THREE.SphereGeometry(inchesToFeet(NODE_PICK_DIAMETER_IN) / 2, 12, 8);
const NODE_PICK_MAT = new THREE.MeshBasicMaterial({
  transparent: true, opacity: 0, depthWrite: false, colorWrite: false,
});

/** Invisible, generously sized hit target for a connection node. */
export function nodePickProxy(x, y, z) {
  const m = new THREE.Mesh(NODE_PICK_GEO, NODE_PICK_MAT);
  m.position.set(x, y, z);
  // Raycast only: on its own layer the camera never draws it, and the shadow
  // pass (which follows the camera's layers) never casts it.
  m.layers.set(PICK_LAYER);
  return m;
}

// A ledger tube is 1.9 in across, which is about two pixels on screen at a
// normal working zoom -- far too small to hover reliably. The deck and live
// load tools both start from a ledger, so they get the same treatment as the
// connection nodes: an invisible, fatter hit target around the real tube.
export const LEDGER_PICK_DIAMETER_IN = 6;

/** Invisible, generously sized hit target along a tube. */
export function tubePickProxy(a, b, diameterIn = LEDGER_PICK_DIAMETER_IN) {
  const m = tubeBetween(a, b, diameterIn, NODE_PICK_MAT);
  // Drawn, it cost a draw call per ledger and cast a 6 in shadow under a
  // 1.9 in tube.
  m.castShadow = false;
  m.receiveShadow = false;
  m.layers.set(PICK_LAYER);
  return m;
}

export const NODE_MATERIALS = {
  // Node can start a placement with the active tool.
  valid: new THREE.MeshStandardMaterial({
    color: 0x2563eb, emissive: 0x1e3a8a, emissiveIntensity: 0.5, metalness: 0.3, roughness: 0.4,
  }),
  // Node exists but the active tool cannot use it (nothing to connect to).
  invalid: new THREE.MeshStandardMaterial({
    color: 0xa1a1aa, emissive: 0x000000, metalness: 0.2, roughness: 0.6,
    transparent: true, opacity: 0.55,
  }),
};
