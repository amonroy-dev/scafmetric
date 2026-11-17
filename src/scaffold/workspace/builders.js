// three.js mesh factories for generic scaffold components. No manufacturer parts,
// no rosettes/mouthpieces — standards, ledgers, and braces are plain steel tubes;
// planks are thin steel decks. Visual tube radii are slightly exaggerated for
// legibility and are independent of the weight takeoff (which uses true OD).

import * as THREE from 'three';

const UP_Y = new THREE.Vector3(0, 1, 0);

export const COLORS = {
  standard: 0x9fb2cc,
  ledger: 0x6f8199,
  brace: 0x5a6f88,
  plank: 0xffa41b,
  node: 0x3dd9c9,
  nodeHover: 0xffffff,
  selected: 0xffa41b,
  beam: 0x3dd9c9,
  ghost: 0x3dd9c9,
};

export const RADII = { standard: 0.11, ledger: 0.09, brace: 0.075 };

export function makeMaterial(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.65, ...opts });
}

export function ghostMaterial(color = COLORS.ghost) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.3, transparent: true, opacity: 0.45, depthWrite: false });
}

// Unit cylinder (height 1 along +Y, centered at origin) reused for every tube.
const UNIT_CYL = new THREE.CylinderGeometry(1, 1, 1, 12, 1, false);

// Build (or update) a tube mesh spanning world points a → b with the given radius.
export function tubeMesh(a, b, radius, material) {
  const mesh = new THREE.Mesh(UNIT_CYL, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  orientTube(mesh, a, b, radius);
  return mesh;
}

export function orientTube(mesh, a, b, radius) {
  const av = toVec(a), bv = toVec(b);
  const dir = new THREE.Vector3().subVectors(bv, av);
  const length = dir.length() || 1e-6;
  mesh.position.copy(av).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(UP_Y, dir.clone().normalize());
  mesh.scale.set(radius, length, radius);
}

const NODE_GEO = new THREE.SphereGeometry(0.16, 16, 12);
export function nodeMesh(pos, material) {
  const mesh = new THREE.Mesh(NODE_GEO, material);
  mesh.position.copy(toVec(pos));
  return mesh;
}

// Thin plank deck covering a rectangle [x0,y0]→[x1,y1] at height z. Uses a shared
// unit box scaled per instance, so no per-mesh geometry is created or disposed.
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
export function plankMesh(x0, y0, x1, y1, z, material) {
  const w = Math.abs(x1 - x0) || 0.1;
  const d = Math.abs(y1 - y0) || 0.1;
  const mesh = new THREE.Mesh(UNIT_BOX, material);
  mesh.scale.set(w, d, 0.12);
  mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, z + 0.06);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// Shared sphere geometry for transient markers (ghost nodes).
export const MARKER_GEO = new THREE.SphereGeometry(0.22, 12, 10);

export function toVec(p) {
  return p instanceof THREE.Vector3 ? p : new THREE.Vector3(p[0], p[1], p[2]);
}
