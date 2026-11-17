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
import { MATERIALS, verticalTube, tubeBetween, plankDeck, buildBaseAssembly, buildSideBracket, buildTruss, STANDARD_TUBE_OD_IN } from './parts.js';
import { getPart, CATEGORY_TOOL, CATALOG } from './catalog.js';
import {
  findClosestUnoccupiedTarget, computeBatchPlan, computeAdjacencyScaleFt,
  computeLiftAxes, getAdjacentCandidates, maxProjFor, planBlock, BRACE_DELTA_LIFT,
} from './planning.js';

const DRAG_PX = 4;
export const TOOLS = ['select', 'standard', 'block', 'ledger', 'brace', 'truss', 'bracket', 'plank', 'erase'];

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

  // Pure camera gestures we never intercept. Shift is NOT included: shift+drag
  // pans (handled by the engine) while shift+click still reaches the tool, which
  // is how the source app does bulk fills.
  _navGesture(e) {
    return this.engine.panLock || e.altKey || this.engine._modifiers.space;
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
    this._down = { x: e.clientX, y: e.clientY, moved: 0, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
    if (!e.shiftKey) {  // left-drag marquees in any tool; left-click still places
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
    if (this.tool === 'block' && marquee && dragged) {
      this.placeBlock(normalizeRect(marquee.start, marquee.current));
      return;
    }
    if (marquee && dragged) { this._finishMarquee(marquee, down.ctrl || this.tool !== 'select'); return; }
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
    // Source palette: window = blue, crossing = green; block rect = orange.
    const isBlock = this.tool === 'block';
    const edgeColor = isBlock ? 0xffa41b : (crossing ? 0x34d399 : 0x60a5fa);
    const fillColor = isBlock ? 0xffc266 : (crossing ? 0x6ee7b7 : 0x93c5fd);
    const opacity = isBlock ? 0.14 : (crossing ? 0.12 : 0.08);
    const color = edgeColor;
    const fill = new THREE.Mesh(PLANE_GEO, new THREE.MeshBasicMaterial({ color: fillColor, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
    fill.position.set((r.xMin + r.xMax) / 2, (r.yMin + r.yMax) / 2, 0.04);
    fill.scale.set(w, d, 1);
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(PLANE_GEO), new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: 0.95 }));
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
    // Move/copy capture: ground clicks drive the anchor/destination steps.
    if (this.transformHook) {
      const g = this._groundSnap(e);
      if (g && this.transformHook(g)) return;
    }
    if (this.tool === 'standard') {
      const g = this._groundSnap(e);
      const part = this.currentPart();
      if (g && part) s.addStandard(g.x, g.y, part.lengthFt);
      return;
    }
    if (this.tool === 'select' || this.tool === 'erase') {
      this.engine.setPointerFromEvent(e);
      const id = this._cyclePick(e);
      if (this.tool === 'erase') { if (id) { s.remove(id); this.selection.delete(id); this.hooks.onSelectionChange?.([...this.selection]); } return; }
      if (!id) { if (!e.shiftKey) { this.selection.clear(); this.hooks.onSelectionChange?.([]); } return; }
      if (e.shiftKey) { this.selection.has(id) ? this.selection.delete(id) : this.selection.add(id); }
      else this.selection = new Set([id]);
      this.hooks.onSelectionChange?.([...this.selection]);
      return;
    }
    // Connect tools. Ledgers and braces are ONE CLICK: the target is found
    // automatically (nearest unoccupied adjacent standard), as in the source app.
    const node = this._nearestNode(e);
    if (!node) return;

    if (this.tool === 'ledger') {
      if (e.shiftKey) { this._batchFillLedgers(node.level); return; }
      const target = this.ledgerTargetFor(node);
      if (target) s.addLedger([node.x, node.y, node.z], [target.x, target.y, target.z]);
      return;
    }
    if (this.tool === 'bracket') {
      const part = this.currentPart();
      if (part) s.addBracket(node, this._outwardDir(node), part.lengthFt);
      return;
    }
    if (this.tool === 'brace') {
      if (e.shiftKey) { this._batchFillBraces(node.level); return; }
      const target = this.braceTargetFor(node);
      if (target) s.addBrace([node.x, node.y, node.z], [target.x, target.y, target.z]);
      return;
    }
    // Planks and trusses take two nodes.
    if (!this.pending) { this.pending = node; return; }
    const a = this.pending;
    this.pending = null;
    if (a.x === node.x && a.y === node.y) return;
    if (this.tool === 'truss') s.addTruss([a.x, a.y, a.z], [node.x, node.y, node.z]);
    else s.addPlank([a.x, a.y, a.z], [node.x, node.y, node.z]);
  }

  // Direction pointing away from the scaffold footprint centre.
  _outwardDir(node) {
    const cols = [...this.state.standards.values()];
    if (!cols.length) return [1, 0];
    const cx = cols.reduce((a, c) => a + c.x, 0) / cols.length;
    const cy = cols.reduce((a, c) => a + c.y, 0) / cols.length;
    let dx = node.x - cx, dy = node.y - cy;
    if (Math.hypot(dx, dy) < 1e-6) return [1, 0];
    // Snap to the dominant axis so brackets sit square to the bay.
    if (Math.abs(dx) >= Math.abs(dy)) return [Math.sign(dx), 0];
    return [0, Math.sign(dy)];
  }

  /**
   * Pick with cycling: clicking the same spot again steps to the next object
   * behind the current one, so overlapping members stay reachable.
   */
  _cyclePick(e) {
    this.engine.raycaster.setFromCamera(this.engine.pointer, this.engine.camera);
    const hits = this.engine.raycaster.intersectObjects(this.hooks.getContentMeshes?.() || [], false);
    const ids = [];
    for (const h of hits) {
      const id = h.object.userData?.id;
      if (id && !ids.includes(id)) ids.push(id);
    }
    if (!ids.length) { this._cycle = null; return null; }
    const near = this._cycle && Math.hypot(e.clientX - this._cycle.x, e.clientY - this._cycle.y) < 6;
    if (near && this._cycle.ids.join('|') === ids.join('|')) {
      this._cycle.index = (this._cycle.index + 1) % ids.length;
    } else {
      this._cycle = { x: e.clientX, y: e.clientY, ids, index: 0 };
    }
    return ids[this._cycle.index];
  }

  _nodesAtLevel(level) { return this.state.nodes().filter(n => n.level === level); }

  _ledgerExists(a, b) {
    for (const l of this.state.ledgers.values()) {
      const m1 = Math.hypot(l.a[0] - a.x, l.a[1] - a.y) < 1e-6 && Math.abs(l.a[2] - a.z) < 1e-6
        && Math.hypot(l.b[0] - b.x, l.b[1] - b.y) < 1e-6 && Math.abs(l.b[2] - b.z) < 1e-6;
      const m2 = Math.hypot(l.a[0] - b.x, l.a[1] - b.y) < 1e-6 && Math.abs(l.a[2] - b.z) < 1e-6
        && Math.hypot(l.b[0] - a.x, l.b[1] - a.y) < 1e-6 && Math.abs(l.b[2] - a.z) < 1e-6;
      if (m1 || m2) return true;
    }
    return false;
  }

  /** Nearest unoccupied adjacent node at the same lift. */
  ledgerTargetFor(node) {
    const nodes = this._nodesAtLevel(node.level);
    return findClosestUnoccupiedTarget(node, nodes, c => !this._ledgerExists(node, c));
  }

  /** Diagonal target: nearest adjacent standard, 4 rosette levels up. */
  braceTargetFor(node) {
    const nodes = this._nodesAtLevel(node.level);
    const scale = computeAdjacencyScaleFt(nodes);
    const axes = computeLiftAxes(nodes, scale);
    if (!axes) return null;
    const adj = getAdjacentCandidates(node, nodes, axes, maxProjFor(scale), null);
    let best = null, bestD = Infinity;
    for (const c of adj) {
      const d = Math.hypot(c.x - node.x, c.y - node.y);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (!best) return null;
    const up = this.state.nodes().find(n =>
      n.columnId === best.columnId && n.level === node.level + BRACE_DELTA_LIFT);
    return up || null;
  }

  _batchFillLedgers(level) {
    const nodes = this._nodesAtLevel(level);
    const plan = computeBatchPlan(nodes, (a, b) => !this._ledgerExists(a, b));
    for (const { a, b } of plan) this.state.addLedger([a.x, a.y, a.z], [b.x, b.y, b.z]);
    this.hooks.onBulkFill?.(plan.length, 'ledger');
  }

  _batchFillBraces(level) {
    const nodes = this._nodesAtLevel(level);
    const plan = computeBatchPlan(nodes, null);
    let added = 0;
    const all = this.state.nodes();
    for (const { a, b } of plan) {
      const up = all.find(n => n.columnId === b.columnId && n.level === level + BRACE_DELTA_LIFT);
      if (!up) continue;
      this.state.addBrace([a.x, a.y, a.z], [up.x, up.y, up.z]);
      added++;
    }
    this.hooks.onBulkFill?.(added, 'brace');
  }

  /** Block tool: lay out a full scaffold block over the dragged ground rect. */
  placeBlock(rect) {
    const s = this.state;
    const plan = planBlock({
      x0: rect.xMin, y0: rect.yMin, x1: rect.xMax, y1: rect.yMax,
      heightFt: this.blockHeightFt ?? 19.6875,
      standardLengthsFt: CATALOG.standards.parts.map(p => p.lengthFt),
      ledgerLengthsFt: CATALOG.ledgers.parts.map(p => p.lengthFt),
      maxLevel: 0,
    });
    if (!plan) return 0;

    for (const st of plan.standards) {
      for (const len of st.segments) s.addStandard(st.x, st.y, len);
    }
    // Levels available now that the standards exist.
    const all = s.nodes();
    const maxLevel = all.reduce((m, n) => Math.max(m, n.level), 0);
    const replan = planBlock({
      x0: rect.xMin, y0: rect.yMin, x1: rect.xMax, y1: rect.yMax,
      heightFt: this.blockHeightFt ?? 19.6875,
      standardLengthsFt: CATALOG.standards.parts.map(p => p.lengthFt),
      ledgerLengthsFt: CATALOG.ledgers.parts.map(p => p.lengthFt),
      maxLevel,
    });
    const nodeAt = (x, y, level) => all.find(n =>
      Math.hypot(n.x - x, n.y - y) < 1e-6 && n.level === level);

    for (const l of replan.ledgers) {
      const a = nodeAt(l.a.x, l.a.y, l.level), b = nodeAt(l.b.x, l.b.y, l.level);
      if (a && b) s.addLedger([a.x, a.y, a.z], [b.x, b.y, b.z]);
    }
    for (const br of replan.braces) {
      const a = nodeAt(br.a.x, br.a.y, br.level), b = nodeAt(br.b.x, br.b.y, br.toLevel);
      if (a && b) s.addBrace([a.x, a.y, a.z], [b.x, b.y, b.z]);
    }
    for (const d of replan.decks) {
      const a = nodeAt(d.x0, d.y0, d.level), b = nodeAt(d.x1, d.y1, d.level);
      if (a && b) s.addPlank([a.x, a.y, a.z], [b.x, b.y, b.z]);
    }
    this.hooks.onBulkFill?.(plan.standards.length, 'block');
    return plan.standards.length;
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
    if (this.tool === 'select' || this.tool === 'erase' || this.tool === 'block') return;
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
    if (!node) return;
    // Ledger/brace preview the auto-chosen target, so one click is predictable.
    if (this.tool === 'ledger') {
      const t = this.ledgerTargetFor(node);
      if (t) this.ghostGroup.add(tubeBetween([node.x, node.y, node.z], [t.x, t.y, t.z], 1.9, mat));
      return;
    }
    if (this.tool === 'bracket') {
      const part = this.currentPart();
      if (part) for (const m of buildSideBracket(node, this._outwardDir(node), part.lengthFt, mat)) this.ghostGroup.add(m);
      return;
    }
    if (this.tool === 'brace') {
      const t = this.braceTargetFor(node);
      if (t) this.ghostGroup.add(tubeBetween([node.x, node.y, node.z], [t.x, t.y, t.z], 1.69, mat));
      return;
    }
    if (this.pending) {
      const a = this.pending;
      if (this.tool === 'truss') {
        for (const m of buildTruss([a.x, a.y, a.z], [node.x, node.y, node.z], mat)) this.ghostGroup.add(m);
      } else {
        this.ghostGroup.add(plankDeck(a.x, a.y, node.x, node.y, Math.min(a.z, node.z), mat));
      }
    }
  }

  destroy() {
    for (const [t, fn] of this._bound) this.engine.renderer.domElement.removeEventListener(t, fn);
    window.removeEventListener('keydown', this._onKey);
    this.engine.scene.remove(this.ghostGroup, this.overlayGroup);
  }
}
