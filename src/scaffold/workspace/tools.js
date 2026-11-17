// Placement tools for the scaffold workspace. Left-drag still orbits (handled by
// OrbitControls); a left click that doesn't drag performs the tool action. Ghost
// previews follow the cursor. Connect-tools (ledger/brace/plank) snap endpoints to
// the nearest standard node.

import * as THREE from 'three';
import { tubeMesh, plankMesh, ghostMaterial, RADII, MARKER_GEO } from './builders.js';

const CLICK_PX = 5;

export const TOOLS = ['select', 'standard', 'ledger', 'brace', 'plank', 'erase'];

export class Tools {
  constructor(engine, state, hooks = {}) {
    this.engine = engine;
    this.state = state;
    this.hooks = hooks; // { getNodeMeshes, getContentMeshes, onSelect }
    this.tool = 'standard';
    this.pending = null;   // first picked node for connect tools
    this.selectedId = null;
    this._down = null;

    this.ghostGroup = new THREE.Group();
    this.ghostGroup.renderOrder = 10;
    this.ghostMat = ghostMaterial();
    engine.scene.add(this.ghostGroup);

    const el = engine.renderer.domElement;
    this._listeners = [];
    const on = (t, fn) => { el.addEventListener(t, fn); this._listeners.push([t, fn]); };
    on('pointerdown', e => this._onDown(e));
    on('pointermove', e => this._onMove(e));
    on('pointerup', e => this._onUp(e));
    this._onKey = e => this._key(e);
    window.addEventListener('keydown', this._onKey);
  }

  setTool(name) {
    this.tool = name;
    this.pending = null;
    this._clearGhost();
    this.hooks.onToolChange?.(name);
  }

  _clearGhost() {
    // All ghost meshes use shared geometries; just detach them.
    this.ghostGroup.clear();
  }

  _nearestNode(event) {
    this.engine.setPointerFromEvent(event);
    const meshes = this.hooks.getNodeMeshes?.() || [];
    const hit = this.engine.pick(meshes);
    return hit ? hit.object.userData.node : null;
  }

  _groundSnap(event) {
    this.engine.setPointerFromEvent(event);
    const p = this.engine.groundPoint();
    if (!p) return null;
    return { x: this.state.snap(p.x), y: this.state.snap(p.y) };
  }

  _onDown(e) {
    if (e.button !== 0) return;
    this._down = { x: e.clientX, y: e.clientY, moved: 0 };
  }

  _onMove(e) {
    if (this._down) this._down.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
    this._updateGhost(e);
  }

  _onUp(e) {
    if (e.button !== 0 || !this._down) return;
    const wasClick = this._down.moved < CLICK_PX;
    this._down = null;
    if (!wasClick) return; // it was an orbit drag
    this._act(e);
  }

  _act(e) {
    const s = this.state;
    if (this.tool === 'standard') {
      const g = this._groundSnap(e); if (g) s.addStandard(g.x, g.y);
      return;
    }
    if (this.tool === 'select' || this.tool === 'erase') {
      this.engine.setPointerFromEvent(e);
      const hit = this.engine.pick(this.hooks.getContentMeshes?.() || []);
      const id = hit?.object.userData.id ?? null;
      if (this.tool === 'erase') { if (id) s.remove(id); }
      else { this.selectedId = id; this.hooks.onSelect?.(id); }
      return;
    }
    // connect tools
    const node = this._nearestNode(e);
    if (!node) return;
    if (!this.pending) { this.pending = node; return; }
    const a = this.pending, b = node;
    this.pending = null;
    if (a.x === b.x && a.y === b.y) return; // need two distinct columns
    if (this.tool === 'ledger') s.addLedger(a.x, a.y, b.x, b.y, a.level);
    else if (this.tool === 'brace') s.addBrace(a.x, a.y, b.x, b.y, a.level);
    else if (this.tool === 'plank') s.addPlank(a.x, a.y, b.x, b.y, a.level);
  }

  _key(e) {
    if (e.key === 'Escape') { this.pending = null; this._clearGhost(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.tool === 'select' && this.selectedId) {
      this.state.remove(this.selectedId);
      this.selectedId = null;
      this.hooks.onSelect?.(null);
    }
  }

  _updateGhost(e) {
    this._clearGhost();
    const mat = this.ghostMat;
    if (this.tool === 'standard') {
      const g = this._groundSnap(e); if (!g) return;
      const top = [g.x, g.y, this.state.liftHeightFt];
      this.ghostGroup.add(tubeMesh([g.x, g.y, 0], top, RADII.standard, mat));
      return;
    }
    if (this.tool === 'ledger' || this.tool === 'brace' || this.tool === 'plank') {
      const node = this._nearestNode(e);
      // marker at hovered node
      if (node) {
        const m = new THREE.Mesh(MARKER_GEO, mat);
        m.position.set(node.x, node.y, node.z);
        this.ghostGroup.add(m);
      }
      if (this.pending && node) {
        const a = this.pending;
        if (this.tool === 'ledger') {
          this.ghostGroup.add(tubeMesh([a.x, a.y, a.z], [node.x, node.y, a.z], RADII.ledger, mat));
        } else if (this.tool === 'brace') {
          this.ghostGroup.add(tubeMesh([a.x, a.y, a.z], [node.x, node.y, a.z + this.state.liftHeightFt], RADII.brace, mat));
        } else {
          this.ghostGroup.add(plankMesh(a.x, a.y, node.x, node.y, a.z, mat));
        }
      }
    }
  }

  destroy() {
    for (const [t, fn] of this._listeners) this.engine.renderer.domElement.removeEventListener(t, fn);
    window.removeEventListener('keydown', this._onKey);
    this._clearGhost();
    this.engine.scene.remove(this.ghostGroup);
  }
}
