// Placement + selection tools for the scaffold workspace.
//
// Navigation is handled by the engine (middle = pan, right = orbit, shift/space
// modifiers). LEFT is reserved here: a click performs the tool action, and a
// drag in Select runs a marquee.
//
// Marquee matches the source app: ground-plane rectangle, 4 px drag threshold,
// left-to-right = WINDOW (fully contained), right-to-left = CROSSING
// (intersecting), Shift adds to the current selection.

import * as THREE from 'three';
import { MATERIALS, verticalTube, tubeBetween, plankDeck, buildBaseAssembly, STANDARD_TUBE_OD_IN } from './parts.js';
import { getPart, CATEGORY_TOOL } from './catalog.js';

const DRAG_PX = 4;
export const TOOLS = ['select', 'standard', 'ledger', 'brace', 'plank', 'erase'];

const MARKER_GEO = new THREE.SphereGeometry(0.2, 12, 10);
const PLANE_GEO = new THREE.PlaneGeometry(1, 1);

function normalizeRect(a, b) {
  return { xMin: Math.min(a.x, b.x), xMax: Math.max(a.x, b.x), yMin: Math.min(a.y, b.y), yMax: Math.max(a.y, b.y) };
}
function windowContains(sel, r) {
  return r.xMin >= sel.xMin && r.xMax <= sel.xMax && r.yMin >= sel.yMin && r.yMax <= sel.yMax;
}
function crossingIntersects(sel, r) {
  return !(r.xMax < sel.xMin || r.xMin > sel.xMax || r.yMax < sel.yMin || r.yMin > sel.yMax);
}

export class Tools {
  constructor(engine, state, hooks = {}) {
    this.engine = engine;
    this.state = state;
    this.hooks = hooks; // { getNodeMeshes, getContentMeshes, onSelectionChange }
    this.tool = 'standard';
    this.categoryKey = 'standards';
    this.partId = null;
    this.pending = null;
    this.selection = new Set();
    this._down = null;
    this._marquee = null;

    this.ghostGroup = new THREE.Group();
    this.overlayGroup = new THREE.Group();
    engine.scene.add(this.ghostGroup, this.overlayGroup);

    const el = engine.renderer.domElement;
    this._bound = [];
    const on = (t, fn) => { el.addEventListener(t, fn); this._bound.push([t, fn]); };
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
  setCatalog(categoryKey, partId) {
    this.categoryKey = categoryKey;
    this.partId = partId;
    const t = CATEGORY_TOOL[categoryKey];
    if (t) this.setTool(t);
  }
  currentPart() { return getPart(this.categoryKey, this.partId); }

  _clearGhost() { this.ghostGroup.clear(); }
  _clearOverlay() { this.overlayGroup.clear(); }

  // True while the user is driving the camera (so we never fight navigation).
  _navGesture(e) {
    return this.engine.panLock || e.shiftKey || e.altKey || this.engine._modifiers.space;
  }

  _nearestNode(e) {
    this.engine.setPointerFromEvent(e);
    const hit = this.engine.pick(this.hooks.getNodeMeshes?.() || []);
    return hit ? hit.object.userData.node : null;
  }
  _groundSnap(e) {
    this.engine.setPointerFromEvent(e);
    const p = this.engine.groundPoint();
    return p ? { x: this.state.snap(p.x), y: this.state.snap(p.y) } : null;
  }

  _onDown(e) {
    if (e.button !== 0 || this._navGesture(e)) return;
    this._down = { x: e.clientX, y: e.clientY, moved: 0, shift: e.shiftKey };
    if (this.tool === 'select') {
      const g = this.engine.projectClientToGround(e.clientX, e.clientY);
      if (g) this._marquee = { start: { x: g.x, y: g.y }, current: { x: g.x, y: g.y }, startClientX: e.clientX, currentClientX: e.clientX };
    }
  }

  _onMove(e) {
    if (this._down) this._down.moved = Math.max(Math.abs(e.clientX - this._down.x), Math.abs(e.clientY - this._down.y));
    if (this._marquee && (e.buttons & 1)) {
      const g = this.engine.projectClientToGround(e.clientX, e.clientY);
      if (g) {
        this._marquee.current = { x: g.x, y: g.y };
        this._marquee.currentClientX = e.clientX;
        if (this._down && this._down.moved >= DRAG_PX) this._drawMarquee();
      }
      return;
    }
    if (this._marquee && !(e.buttons & 1)) { this._marquee = null; this._clearOverlay(); }
    this._updateGhost(e);
  }

  _onUp(e) {
    if (e.button !== 0) return;
    const down = this._down;
    const marquee = this._marquee;
    this._down = null;
    this._marquee = null;
    this._clearOverlay();
    if (!down) return;
    const dragged = down.moved >= DRAG_PX;
    if (this.tool === 'select' && marquee && dragged) { this._finishMarquee(marquee, down.shift); return; }
    if (dragged) return; // camera/aborted drag
    this._act(e);
  }

  _drawMarquee() {
    this._clearOverlay();
    const m = this._marquee;
    const r = normalizeRect(m.start, m.current);
    const w = Math.max(r.xMax - r.xMin, 1e-4);
    const d = Math.max(r.yMax - r.yMin, 1e-4);
    const crossing = m.currentClientX < m.startClientX;
    const color = crossing ? 0xffa41b : 0x3dd9c9;
    const fill = new THREE.Mesh(PLANE_GEO, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide }));
    fill.position.set((r.xMin + r.xMax) / 2, (r.yMin + r.yMax) / 2, 0.04);
    fill.scale.set(w, d, 1);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(PLANE_GEO), new THREE.LineBasicMaterial({ color }));
    edge.position.copy(fill.position);
    edge.scale.copy(fill.scale);
    this.overlayGroup.add(fill, edge);
  }

  _finishMarquee(m, additive) {
    const rect = normalizeRect(m.start, m.current);
    const crossing = m.currentClientX < m.startClientX;
    const hit = [];
    for (const s of this.state.standards.values()) {
      const r = { xMin: s.x - 0.1, xMax: s.x + 0.1, yMin: s.y - 0.1, yMax: s.y + 0.1 };
      if (crossing ? crossingIntersects(rect, r) : windowContains(rect, r)) hit.push(s.id);
    }
    if (additive) for (const id of hit) this.selection.add(id);
    else this.selection = new Set(hit);
    this.hooks.onSelectionChange?.([...this.selection]);
  }

  _act(e) {
    const s = this.state;
    if (this.tool === 'standard') {
      const g = this._groundSnap(e);
      const part = this.currentPart();
      if (g && part) s.addStandard(g.x, g.y, part.lengthFt);
      return;
    }
    if (this.tool === 'select' || this.tool === 'erase') {
      this.engine.setPointerFromEvent(e);
      const hit = this.engine.pick(this.hooks.getContentMeshes?.() || []);
      const id = hit?.object.userData.id ?? null;
      if (this.tool === 'erase') { if (id) { s.remove(id); this.selection.delete(id); this.hooks.onSelectionChange?.([...this.selection]); } return; }
      if (!id) { if (!e.shiftKey) { this.selection.clear(); this.hooks.onSelectionChange?.([]); } return; }
      if (e.shiftKey) { this.selection.has(id) ? this.selection.delete(id) : this.selection.add(id); }
      else this.selection = new Set([id]);
      this.hooks.onSelectionChange?.([...this.selection]);
      return;
    }
    // node -> node connect tools
    const node = this._nearestNode(e);
    if (!node) return;
    if (!this.pending) { this.pending = node; return; }
    const a = this.pending, b = node;
    this.pending = null;
    if (a.x === b.x && a.y === b.y && Math.abs(a.z - b.z) < 1e-6) return;
    const av = [a.x, a.y, a.z], bv = [b.x, b.y, b.z];
    if (this.tool === 'ledger') s.addLedger(av, bv);
    else if (this.tool === 'brace') s.addBrace(av, bv);
    else if (this.tool === 'plank') s.addPlank(av, bv);
  }

  _key(e) {
    if (e.key === 'Escape') { this.pending = null; this._clearGhost(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection.size) {
      const target = e.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      this.state.removeMany([...this.selection]);
      this.selection.clear();
      this.hooks.onSelectionChange?.([]);
    }
  }

  _updateGhost(e) {
    this._clearGhost();
    if (this.tool === 'select' || this.tool === 'erase') return;
    const mat = MATERIALS.ghost;
    if (this.tool === 'standard') {
      const g = this._groundSnap(e);
      const part = this.currentPart();
      if (!g || !part) return;
      const base = this.state.baseOffsetFt();
      const { meshes } = buildBaseAssembly({
        x: g.x, y: g.y, groundZ: 0,
        jackExtensionIn: this.state.base.jackExtensionIn,
        showWoodSill: this.state.base.showWoodSill,
        showBaseCollar: this.state.base.showBaseCollar,
        material: mat,
      });
      for (const m of meshes) this.ghostGroup.add(m);
      this.ghostGroup.add(verticalTube(g.x, g.y, base, base + part.lengthFt, STANDARD_TUBE_OD_IN, mat));
      return;
    }
    const node = this._nearestNode(e);
    if (node) {
      const marker = new THREE.Mesh(MARKER_GEO, mat);
      marker.position.set(node.x, node.y, node.z);
      this.ghostGroup.add(marker);
    }
    if (this.pending && node) {
      const a = this.pending;
      const av = [a.x, a.y, a.z], bv = [node.x, node.y, node.z];
      if (this.tool === 'ledger') this.ghostGroup.add(tubeBetween(av, bv, 1.9, mat));
      else if (this.tool === 'brace') this.ghostGroup.add(tubeBetween(av, bv, 1.69, mat));
      else this.ghostGroup.add(plankDeck(a.x, a.y, node.x, node.y, Math.min(a.z, node.z), mat));
    }
  }

  destroy() {
    for (const [t, fn] of this._bound) this.engine.renderer.domElement.removeEventListener(t, fn);
    window.removeEventListener('keydown', this._onKey);
    this.engine.scene.remove(this.ghostGroup, this.overlayGroup);
  }
}
