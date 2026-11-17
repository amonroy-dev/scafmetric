// Procedural scaffold part geometry — no GLB/GLTF assets, no rosettes, no
// mouthpieces, no manufacturer part numbers. Dimensions mirror the structural
// values used by the source scaffold project so the base stack-up is correct:
//
//   wood sill (optional) -> jack plate -> jack stem + extension -> base collar
//   (optional) -> standard tube
//
// All world units are FEET, Z-up.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const inchesToFeet = i => i / 12;

// Structural dimensions (inches).
export const WOOD_SILL = { widthIn: 9, depthIn: 9, thicknessIn: 0.5 };
export const JACK_PLATE = { thicknessIn: 0.375, sizeIn: 6 };
export const JACK_STEM = { baseHeightIn: 2, rodDiameterIn: 1.25 };
export const HANDLE_NUT = { diameterIn: 3.6, heightIn: 1.25, wingLenIn: 2.4, wingThickIn: 0.4, wingHeightIn: 0.75 };
export const BASE_COLLAR = { heightIn: 7.0, outerDiameterIn: 2.45 };
export const STANDARD_TUBE_OD_IN = 1.9;
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
  selected: new THREE.MeshStandardMaterial({ color: 0xa855f7, emissive: 0xa855f7, emissiveIntensity: 0.45, metalness: 0.2, roughness: 0.4 }),
  ghost: new THREE.MeshStandardMaterial({ color: 0x3dd9c9, transparent: true, opacity: 0.45, depthWrite: false, metalness: 0.2, roughness: 0.5 }),
};

// Shared geometries (never disposed; scaled per instance).
// Unit cylinder: radius 1, height 1, axis +Z (rotated from the default +Y).
const UNIT_CYL_Z = new THREE.CylinderGeometry(1, 1, 1, TUBE_RADIAL_SEGMENTS);
UNIT_CYL_Z.rotateX(Math.PI / 2);
// Unit cylinder along +Y, for arbitrary-direction tubes (ledgers/braces).
const UNIT_CYL_Y = new THREE.CylinderGeometry(1, 1, 1, TUBE_RADIAL_SEGMENTS);
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const HEX_GEO = new THREE.CylinderGeometry(1, 1, 1, 6);
HEX_GEO.rotateX(Math.PI / 2);

export const SHARED_GEO = { UNIT_CYL_Z, UNIT_CYL_Y, UNIT_BOX, HEX_GEO };

function mesh(geo, mat, pos, scale) {
  const m = new THREE.Mesh(geo, mat);
  if (pos) m.position.set(pos[0], pos[1], pos[2]);
  if (scale) m.scale.set(scale[0], scale[1], scale[2]);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// Vertical tube from z0 to z1 at (x,y), given an outside diameter in inches.
export function verticalTube(x, y, z0, z1, odIn, material) {
  const r = inchesToFeet(odIn) / 2;
  const h = Math.max(z1 - z0, 1e-6);
  return mesh(UNIT_CYL_Z, material, [x, y, z0 + h / 2], [r, r, h]);
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
    const r = inchesToFeet(BASE_COLLAR.outerDiameterIn) / 2;
    const collar = mesh(UNIT_CYL_Z, steel, [x, y, z + h / 2], [r, r, h]);
    collar.userData.part = 'base-collar';
    meshes.push(collar);
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
export const PLANK = { widthIn: 9, narrowWidthIn: 6, profileDepthIn: 2.25, color: 0xc5c9ce };

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
  color: PLANK.color, metalness: 0.35, roughness: 0.42,
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
// Side bracket — drawn from generic tubing (no GLB). An outward arm at the
// rosette level plus a 45-degree strut back down to the standard.
// ---------------------------------------------------------------------------
export const BRACKET = { armOdIn: 1.9, strutOdIn: 1.69 };

/**
 * Build a side bracket at a node, projecting horizontally along `dir` ([dx,dy],
 * need not be normalised). Returns an array of meshes.
 */
export function buildSideBracket(node, dir, lengthFt, material) {
  const mat = material || MATERIALS.ledger;
  const len = Math.hypot(dir[0], dir[1]) || 1;
  const ux = dir[0] / len, uy = dir[1] / len;
  const base = [node.x, node.y, node.z];
  const tip = [node.x + ux * lengthFt, node.y + uy * lengthFt, node.z];
  // Strut anchors one bracket-length down the standard (45 degrees).
  const anchor = [node.x, node.y, node.z - lengthFt];
  return [
    tubeBetween(base, tip, BRACKET.armOdIn, mat),
    tubeBetween(tip, anchor, BRACKET.strutOdIn, mat),
  ];
}

// ---------------------------------------------------------------------------
// Truss — two chords with a zig-zag web, drawn from generic tubing.
// ---------------------------------------------------------------------------
export const TRUSS = { depthIn: 18, chordOdIn: 1.9, webOdIn: 1.5, panels: 6 };

export function buildTruss(a, b, material) {
  const mat = material || MATERIALS.ledger;
  const depth = inchesToFeet(TRUSS.depthIn);
  const top = [[a[0], a[1], a[2]], [b[0], b[1], b[2]]];
  const bot = [[a[0], a[1], a[2] - depth], [b[0], b[1], b[2] - depth]];
  const out = [
    tubeBetween(top[0], top[1], TRUSS.chordOdIn, mat),
    tubeBetween(bot[0], bot[1], TRUSS.chordOdIn, mat),
  ];
  const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
  for (let i = 0; i < TRUSS.panels; i++) {
    const t0 = i / TRUSS.panels, t1 = (i + 1) / TRUSS.panels;
    // alternate the web direction to form the zig-zag
    const from = i % 2 === 0 ? lerp(top[0], top[1], t0) : lerp(bot[0], bot[1], t0);
    const to = i % 2 === 0 ? lerp(bot[0], bot[1], t1) : lerp(top[0], top[1], t1);
    out.push(tubeBetween(from, to, TRUSS.webOdIn, mat));
    out.push(tubeBetween(lerp(top[0], top[1], t1), lerp(bot[0], bot[1], t1), TRUSS.webOdIn, mat));
  }
  return out;
}

// Guardrail rail/post tubing.
export const GUARDRAIL_OD_IN = 1.69;
