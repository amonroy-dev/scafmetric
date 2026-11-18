// Draw a scaffold in a few dozen draw calls instead of thousands.
//
// Every tube, base plate, rosette and plank board is its own Mesh when the part
// builders make it, and three.js issues one draw call per Mesh, per pass. A
// ten-by-four frontage four lifts high was ~2,500 calls for the colour pass and
// about as many again for the shadow pass, which an integrated GPU cannot clear
// in a frame. Those meshes share a handful of unit geometries and materials, so
// they collapse into one InstancedMesh per (geometry, material) pair, which is
// how ScaffoldPro draws each part family.
//
// Picking keeps working per member: the source meshes' userData travels along
// in `userData.items`, indexed by the hit's instanceId. Read hits through
// hitData() rather than hit.object.userData.

import * as THREE from 'three';

/** Layer for invisible hit targets: raycast against, never drawn or shadowed. */
export const PICK_LAYER = 1;

/**
 * Collapse meshes that share a geometry, material, shadow flags and layers into
 * InstancedMeshes. Meshes must sit directly in an untransformed parent: their
 * local matrix becomes the instance matrix.
 */
export function instanceMeshes(meshes) {
  const groups = new Map();
  for (const m of meshes) {
    const key = `${m.geometry.id}|${m.material.id}|${m.castShadow ? 1 : 0}${m.receiveShadow ? 1 : 0}|${m.layers.mask}`;
    let g = groups.get(key);
    if (!g) groups.set(key, g = []);
    g.push(m);
  }
  const out = [];
  for (const list of groups.values()) {
    const first = list[0];
    const im = new THREE.InstancedMesh(first.geometry, first.material, list.length);
    for (let i = 0; i < list.length; i++) {
      list[i].updateMatrix();
      im.setMatrixAt(i, list[i].matrix);
    }
    im.instanceMatrix.needsUpdate = true;
    im.castShadow = first.castShadow;
    im.receiveShadow = first.receiveShadow;
    im.layers.mask = first.layers.mask;
    im.userData = { items: list.map(m => m.userData) };
    out.push(im);
  }
  return out;
}

/**
 * Line segments for the centerline view, one LineSegments per material, with
 * each segment's data in `userData.segmentItems`.
 */
export function mergeLineSegments(segments) {
  const groups = new Map();
  for (const s of segments) {
    let g = groups.get(s.material.id);
    if (!g) groups.set(s.material.id, g = { material: s.material, list: [] });
    g.list.push(s);
  }
  const out = [];
  for (const { material, list } of groups.values()) {
    const pos = new Float32Array(list.length * 6);
    list.forEach((s, i) => { pos.set(s.start, i * 6); pos.set(s.end, i * 6 + 3); });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const lines = new THREE.LineSegments(geo, material);
    lines.userData = { segmentItems: list.map(s => s.data), ownsGeometry: true };
    out.push(lines);
  }
  return out;
}

/** The member a raycast hit landed on, whether instanced, merged or plain. */
export function hitData(hit) {
  const ud = hit?.object?.userData;
  if (!ud) return {};
  if (ud.items && hit.instanceId !== undefined) return ud.items[hit.instanceId] || {};
  // LineSegments report the index of the segment's first vertex.
  if (ud.segmentItems && hit.index !== undefined) return ud.segmentItems[Math.floor(hit.index / 2)] || {};
  return ud;
}

/**
 * Empty a group and release what its children allocated on the GPU. Shared
 * unit geometries and materials are left alone; instance buffers, merged line
 * geometry and per-label textures are not shared, so they go.
 */
export function clearGroup(group) {
  for (const c of group.children) {
    if (c.isInstancedMesh) c.dispose();
    if (c.userData?.ownsGeometry) c.geometry.dispose();
    if (c.isSprite && c.userData?.ownsMaterial) { c.material.map?.dispose(); c.material.dispose(); }
  }
  group.clear();
}
