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
import { MATERIALS, verticalTube, tubeBetween, buildBaseAssembly, buildSideBracket, buildTruss, plankBoard, liveLoadPatch, liveLoadGhostMaterial, STANDARD_TUBE_OD_IN } from './parts.js';
import { getPart, CATEGORY_TOOL, CATALOG } from './catalog.js';
import {
  findClosestUnoccupiedTarget, computeBatchPlan, planBlock, planStandardSegmentsForHeight, liftFrame,
} from './planning.js';
import { hitData } from './instancing.js';
import {
  getLedgerSideSign, buildLiveLoadPreviewForLedger, computeLiveLoadBatchPreview,
  DEFAULT_BAY_LIVE_LOAD_PSF,
} from './liveloads.js';
import { buildSupportPair } from './supportspan.js';
import { buildPlankPreviewForLedger, computePlankBatchPreview } from './planks.js';
import {
  buildFaceGraph, pickFace, faceBraceTarget, nodesByColumn, planPerimeterBraces,
} from './braces.js';

// How far from the tube the horizontal side-pick crossing may land before it
// stops meaning "the cursor is on this side of that ledger".
const SIDE_PICK_MAX_FT = 4;
const DRAG_PX = 4;
export const TOOLS = ['select', 'standard', 'block', 'ledger', 'brace', 'truss', 'bracket', 'plank', 'liveload', 'erase'];

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

// Order-free key for a ledger between two points. Ledger ends are copied from
// node coordinates, so equal points give equal keys.
const pointKey = p => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)},${Math.round(p[2] * 1000)}`;
function segmentKey(a, b) {
  const ka = pointKey(a), kb = pointKey(b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
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
    this.liveLoadPsf = DEFAULT_BAY_LIVE_LOAD_PSF;
    // Brace options, mirroring the source app's catalog controls, including its
    // default of descending diagonals.
    this.braceDirection = 'descending';
    this.braceFaceFilter = 'all';
    this.braceNthBay = 1;
    // Standard tool: when set, placing a standard builds a planned stack that
    // reaches this height instead of dropping a single catalog segment.
    this.standardTargetHeightFt = 0;
    // Block tool preview rotation, in 90 degree steps (R).
    this.rotationSteps = 0;
    this.sideFlipped = false;
    // Why the last brace hover found nothing: 'no-face' | 'too-short' | 'already-braced'.
    this.braceMiss = null;
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
    this.sideFlipped = false;
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

  // The canvas draws on demand, so every change to what the tools show asks for
  // a frame. Clearing an empty group changes nothing and asks for nothing,
  // which keeps a plain hover in Select from redrawing the scene.
  _clearGhost() {
    if (!this.ghostGroup.children.length) return;
    this.ghostGroup.clear();
    this.engine.invalidate?.();
  }
  _clearOverlay() {
    if (!this.overlayGroup.children.length) return;
    // The marquee is redrawn on every move with its own materials and edge
    // geometry; free them rather than leak a set per pointer event.
    for (const c of this.overlayGroup.children) {
      c.material.dispose();
      if (c.geometry !== PLANE_GEO) c.geometry.dispose();
    }
    this.overlayGroup.clear();
    this.engine.invalidate?.();
  }

  /**
   * Nodes grouped by lift, each lift's grid frame, and the ledgers already
   * placed, cached until the model changes. Colouring the nodes for the Ledger
   * tool asks for every node's target; recomputing these per node made a
   * rebuild with that tool active cost 220 ms on a 40-standard job.
   */
  _lifts() {
    const version = this.state.version;
    if (this._liftCache && this._liftCache.version === version) return this._liftCache;
    const byLevel = new Map();
    for (const n of this.state.nodes()) {
      let list = byLevel.get(n.level);
      if (!list) byLevel.set(n.level, list = []);
      list.push(n);
    }
    const ledgerKeys = new Set();
    for (const l of this.state.ledgers.values()) ledgerKeys.add(segmentKey(l.a, l.b));
    this._liftCache = { version, byLevel, ledgerKeys, frames: new Map() };
    return this._liftCache;
  }

  // Pure camera gestures we never intercept. Shift is NOT included: shift+drag
  // pans (handled by the engine) while shift+click still reaches the tool, which
  // is how the source app does bulk fills.
  _navGesture(e) {
    return this.engine.panLock || e.altKey || this.engine._modifiers.space;
  }

  _nearestNode(e) {
    this.engine.setPointerFromEvent(e);
    const hit = this.engine.pick(this.hooks.getNodeMeshes?.() || []);
    return hit ? hitData(hit).node || null : null;
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
    // The ghost previewed what this click just placed. Show what the next click
    // would do instead, without waiting for the pointer to move: a stale ghost
    // left over a placed part (an amber load ghost over the new cyan patch).
    this._updateGhost(e);
  }

  _drawMarquee() {
    this._clearOverlay();
    const m = this._marquee;
    const r = this.tool === 'block'
      ? this.orientRect(normalizeRect(m.start, m.current))
      : normalizeRect(m.start, m.current);
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
    this.engine.invalidate?.();
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
      if (!g) return;
      const plan = this.standardStackPlan();
      if (!plan.length) return;
      s.batch(() => { for (const len of plan) s.addStandard(g.x, g.y, len); });
      if (plan.length > 1) this.hooks.onBulkFill?.(plan.length, 'standard segment');
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
    // Braces attach to a bay FACE, not a node: the face under the cursor and the
    // cursor height together choose which lift pair gets the diagonal.
    if (this.tool === 'brace') {
      const target = this.braceTargetUnderCursor(e);
      if (!target) return;
      if (e.shiftKey) { this._batchFillBraces(target); return; }
      s.addBrace(target.a, target.b);
      return;
    }
    // Decks attach to a ledger and a side; the boards span to the opposite
    // ledger of that bay.
    if (this.tool === 'plank') {
      const hit = this._pickLedger(e);
      if (!hit) return;
      const side = this._sideFor(hit.ledger, hit.point);
      if (e.shiftKey) { this._batchFillPlanks(hit.ledger, side); return; }
      s.addPlankOnLedger(hit.ledger.id, side);
      return;
    }
    // Live load patches attach to a ledger, not a node: pick the ledger and the
    // side of it the pointer landed on.
    if (this.tool === 'liveload') {
      const hit = this._pickLedger(e);
      if (!hit) return;
      const side = this._sideFor(hit.ledger, hit.point);
      if (e.shiftKey) { this._batchFillLiveLoads(hit.ledger, side); return; }
      s.addLiveLoad(hit.ledger.id, side, this.liveLoadPsf);
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

    // Trusses still take two nodes.
    if (this.tool === 'truss') {
      if (!this.pending) { this.pending = node; return; }
      const a = this.pending;
      this.pending = null;
      if (a.x === node.x && a.y === node.y) return;
      s.addTruss([a.x, a.y, a.z], [node.x, node.y, node.z]);
    }
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
      const d = hitData(h);
      if (d.proxy) continue; // invisible hit targets never select
      const id = d.id;
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

  _nodesAtLevel(level) { return this._lifts().byLevel.get(level) || []; }

  _ledgerExists(a, b) {
    return this._lifts().ledgerKeys.has(segmentKey([a.x, a.y, a.z], [b.x, b.y, b.z]));
  }

  /** Nearest unoccupied adjacent node at the same lift. */
  ledgerTargetFor(node) {
    const lifts = this._lifts();
    const nodes = lifts.byLevel.get(node.level) || [];
    let frame = lifts.frames.get(node.level);
    if (frame === undefined) lifts.frames.set(node.level, frame = liftFrame(nodes));
    return findClosestUnoccupiedTarget(node, nodes, c => !this._ledgerExists(node, c), frame);
  }

  // --- standards -----------------------------------------------------------

  /**
   * Segment lengths for one click of the Standard tool. With a target height
   * typed in, this is the planned stack that reaches it; otherwise it is the
   * single selected catalog segment.
   */
  standardStackPlan() {
    const target = Number(this.standardTargetHeightFt) || 0;
    if (target > 0) {
      const plan = planStandardSegmentsForHeight(target, CATALOG.standards.parts.map(p => p.lengthFt));
      if (plan.length) return plan;
    }
    const part = this.currentPart();
    return part ? [part.lengthFt] : [];
  }

  // --- braces --------------------------------------------------------------

  /** Face graph for the current standards, rebuilt per interaction. */
  _faces() { return buildFaceGraph([...this.state.standards.values()]); }

  /** True when a diagonal already runs between these two points. */
  _braceExistsBetween(a, b) {
    const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 0.35;
    for (const v of this.state.braces.values()) {
      if ((near(v.a, a) && near(v.b, b)) || (near(v.a, b) && near(v.b, a))) return true;
    }
    return false;
  }

  /**
   * The diagonal the cursor is pointing at: the face whose vertical plane the
   * ray hits first, then the lift pair whose midpoint is nearest the cursor.
   */
  braceTargetUnderCursor(e) {
    this.engine.setPointerFromEvent(e);
    this.engine.raycaster.setFromCamera(this.engine.pointer, this.engine.camera);
    const r = this.engine.raycaster.ray;
    const faces = this._faces();
    if (!faces.length) { this.braceMiss = 'no-face'; return null; }
    const standards = [...this.state.standards.values()];
    const picked = pickFace(
      { origin: [r.origin.x, r.origin.y, r.origin.z], direction: [r.direction.x, r.direction.y, r.direction.z] },
      faces,
      { filter: this.braceFaceFilter, standards },
    );
    if (!picked) { this.braceMiss = 'no-face'; return null; }
    const byColumn = nodesByColumn(this.state.nodes());
    const taken = (face, levelA, levelB) => {
      const t = this._faceEndpoints(face, byColumn, levelA, levelB);
      return t ? this._braceExistsBetween(t.a, t.b) : true;
    };
    const target = faceBraceTarget(picked.face, byColumn, picked.cursorZ, this.braceDirection, taken, picked.side);
    if (target) { this.braceMiss = null; return target; }
    // Nothing placeable on a face we did hit. Say which of the two reasons it is,
    // instead of failing silently: a diagonal climbs four rosette levels, so a
    // single-segment standard can never carry one.
    const ignoringTaken = faceBraceTarget(picked.face, byColumn, picked.cursorZ, this.braceDirection, null, picked.side);
    this.braceMiss = ignoringTaken ? 'already-braced' : 'too-short';
    return null;
  }

  _faceEndpoints(face, byColumn, levelA, levelB) {
    const a = byColumn.get(face.columnIdA)?.get(levelA);
    const b = byColumn.get(face.columnIdB)?.get(levelB);
    if (!a || !b) return null;
    return { a: [a.x, a.y, a.z], b: [b.x, b.y, b.z] };
  }

  /** Every brace that the current hover would place, for the ghost preview. */
  bracePreview(e, shiftKey) {
    const target = this.braceTargetUnderCursor(e);
    if (!target) return [];
    if (!shiftKey) return [target];
    return this._perimeterBracePlan(target.midZ);
  }

  _perimeterBracePlan(targetZ) {
    const byColumn = nodesByColumn(this.state.nodes());
    return planPerimeterBraces(this._faces(), this.state.nodes(), {
      standards: [...this.state.standards.values()],
      filter: this.braceFaceFilter,
      nthBay: this.braceNthBay,
      direction: this.braceDirection,
      targetZ,
      isTaken: (face, levelA, levelB) => {
        const t = this._faceEndpoints(face, byColumn, levelA, levelB);
        return t ? this._braceExistsBetween(t.a, t.b) : true;
      },
    });
  }

  /** SHIFT: brace every selected perimeter face at this height. */
  // Every SHIFT fill commits as one edit: one rebuild and one undo step for the
  // whole run (see ScaffoldState.batch).

  /** Place a planned set of braces, skipping any already there. */
  _addBraces(plan) {
    return this.state.batch(() => {
      let added = 0;
      for (const t of plan) {
        if (this._braceExistsBetween(t.a, t.b)) continue;
        this.state.addBrace(t.a, t.b);
        added++;
      }
      return added;
    });
  }

  _batchFillBraces(target) {
    const added = this._addBraces(this._perimeterBracePlan(target.midZ));
    this.hooks.onBulkFill?.(added, 'brace');
    return added;
  }

  /** SHIFT: deck every bay along the connected run of ledgers at this lift. */
  _batchFillPlanks(ledger, sideSign) {
    const existing = [...this.state.plankPlacements.values()];
    const previews = computePlankBatchPreview(ledger, this.state.ledgerList(), sideSign, existing);
    const added = this.state.batch(() => {
      let n = 0;
      for (const p of previews) {
        if (this.state.addPlankOnLedger(p.placement.ledgerId, p.placement.sideSign)) n++;
      }
      return n;
    });
    this.hooks.onBulkFill?.(added, 'deck');
    return added;
  }

  _batchFillLedgers(level) {
    const nodes = this._nodesAtLevel(level);
    const plan = computeBatchPlan(nodes, (a, b) => !this._ledgerExists(a, b));
    this.state.batch(() => {
      for (const { a, b } of plan) this.state.addLedger([a.x, a.y, a.z], [b.x, b.y, b.z]);
    });
    this.hooks.onBulkFill?.(plan.length, 'ledger');
  }

  /** Nearest ledger under the pointer, with the world point that was hit. */
  _pickLedger(e) {
    this.engine.setPointerFromEvent(e);
    this.engine.raycaster.setFromCamera(this.engine.pointer, this.engine.camera);
    const ray = this.engine.raycaster.ray;
    const hits = this.engine.raycaster.intersectObjects(this.hooks.getContentMeshes?.() || [], false);
    for (const h of hits) {
      const d = hitData(h);
      if (d.kind !== 'ledger' && d.kind !== 'line') continue;
      const ledger = this.state.ledgers.get(d.id);
      if (ledger) return { ledger, point: this._sidePoint(ledger, ray, h.point) };
    }
    return null;
  }

  /**
   * Where the cursor is, for the purpose of choosing a side of a ledger.
   *
   * The raycast hit lands on the TUBE SURFACE, which always leans toward the
   * camera -- reading the side from it means you can never deck inward from an
   * outside view. Use where the cursor ray crosses the horizontal plane the
   * deck would lie in instead, and only fall back to the surface hit when the
   * view is too flat for that crossing to be near the ledger.
   */
  _sidePoint(ledger, ray, hitPoint) {
    const z = (ledger.a[2] + ledger.b[2]) / 2;
    if (Math.abs(ray.direction.z) > 1e-3) {
      const t = (z - ray.origin.z) / ray.direction.z;
      if (t > 0) {
        const x = ray.origin.x + ray.direction.x * t;
        const y = ray.origin.y + ray.direction.y * t;
        if (Math.hypot(x - hitPoint.x, y - hitPoint.y) <= SIDE_PICK_MAX_FT) return { x, y, z };
      }
    }
    return { x: hitPoint.x, y: hitPoint.y, z: hitPoint.z };
  }

  /** SHIFT: load every bay along the connected run of ledgers at this lift. */
  _batchFillLiveLoads(ledger, sideSign) {
    const existing = [...this.state.liveLoads.values()];
    const previews = computeLiveLoadBatchPreview(
      ledger, this.state.ledgerList(), sideSign, existing, this.liveLoadPsf);
    const added = this.state.batch(() => {
      let n = 0;
      for (const p of previews) {
        if (this.state.addLiveLoad(p.placement.ledgerId, p.placement.sideSign, p.placement.psf)) n++;
      }
      return n;
    });
    this.hooks.onBulkFill?.(added, 'live load');
    return added;
  }

  /**
   * Turn the dragged rectangle a quarter turn about its centre for each press
   * of R, which is what rotates the block: the footprint swaps width for depth,
   * so the bay subdivision runs the other way.
   */
  orientRect(rect) {
    if ((this.rotationSteps % 2) === 0) return rect;
    const cx = (rect.xMin + rect.xMax) / 2;
    const cy = (rect.yMin + rect.yMax) / 2;
    const halfW = (rect.xMax - rect.xMin) / 2;
    const halfD = (rect.yMax - rect.yMin) / 2;
    return { xMin: cx - halfD, xMax: cx + halfD, yMin: cy - halfW, yMax: cy + halfW };
  }

  /** Block tool: lay out a full scaffold block over the dragged ground rect. */
  placeBlock(rawRect) {
    const rect = this.orientRect(rawRect);
    const s = this.state;
    const plan = planBlock({
      x0: rect.xMin, y0: rect.yMin, x1: rect.xMax, y1: rect.yMax,
      heightFt: this.blockHeightFt ?? 19.6875,
      standardLengthsFt: CATALOG.standards.parts.map(p => p.lengthFt),
      ledgerLengthsFt: CATALOG.ledgers.parts.map(p => p.lengthFt),
      maxLevel: 0,
    });
    if (!plan) return 0;
    // One edit for the whole block: one rebuild, one undo step.
    s.batch(() => this._layBlock(rect, plan));
    this.hooks.onBulkFill?.(plan.standards.length, 'block');
    return plan.standards.length;
  }

  _layBlock(rect, plan) {
    const s = this.state;
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
  }

  _key(e) {
    const t = e.target;
    const inField = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    // R rotates, as in the source app. What it rotates depends on the tool:
    // the block preview turns 90 degrees, a brace flips ascending/descending,
    // and a deck or load patch flips to the other side of the ledger.
    if ((e.key === 'r' || e.key === 'R') && !inField && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.rotate();
      return;
    }
    // Enter confirms a SHIFT batch preview without a second click, which is how
    // the source app commits a run.
    if (e.key === 'Enter' && this._pendingBatch && !inField) {
      e.preventDefault();
      const batch = this._pendingBatch;
      this._pendingBatch = null;
      const n = batch.apply();
      this.hooks.onBulkFill?.(typeof n === 'number' ? n : batch.count, batch.label);
      this._clearGhost();
      return;
    }
    if (e.key === 'Escape') { this.pending = null; this.sideFlipped = false; this._pendingBatch = null; this._clearGhost(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection.size) {
      const target = e.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      this.state.removeMany([...this.selection]);
      this.selection.clear();
      this.hooks.onSelectionChange?.([]);
    }
  }

  /** R: rotate / flip whatever the active tool is about to place. */
  rotate() {
    if (this.tool === 'block') {
      this.rotationSteps = (this.rotationSteps + 1) % 4;
      this.hooks.onRotate?.('block', this.rotationSteps);
      return this.rotationSteps;
    }
    if (this.tool === 'brace') {
      this.braceDirection = this.braceDirection === 'ascending' ? 'descending' : 'ascending';
      this.hooks.onRotate?.('brace', this.braceDirection);
      return this.braceDirection;
    }
    if (this.tool === 'plank' || this.tool === 'liveload') {
      // Flip to the other side of the hovered ledger, and stay flipped until
      // R is pressed again or the tool changes.
      this.sideFlipped = !this.sideFlipped;
      this.hooks.onRotate?.(this.tool, this.sideFlipped ? 'flipped' : 'cursor');
      return this.sideFlipped;
    }
    if (this.tool === 'truss' || this.tool === 'ledger') {
      // Nothing to rotate; report so the UI can say so rather than go silent.
      this.hooks.onRotate?.(this.tool, null);
    }
    return null;
  }

  /** Side of a ledger to use, honouring an R flip. */
  _sideFor(ledger, point) {
    const natural = getLedgerSideSign(ledger, point);
    const want = this.sideFlipped ? (natural === 1 ? -1 : 1) : natural;
    // A side with no opposite ledger has no bay, so nothing can go there. Rather
    // than silently doing nothing, fall back to the side that does have one; R
    // still picks between them when both are real bays.
    const ledgers = this.state.ledgerList();
    if (buildSupportPair(ledger, ledgers, want)) return want;
    const other = want === 1 ? -1 : 1;
    return buildSupportPair(ledger, ledgers, other) ? other : want;
  }

  _updateGhost(e) {
    this._buildGhost(e);
    if (!this.ghostGroup.children.length) return;
    // The shadow map is baked only when the model changes, so a ghost that
    // cast would leave its shadow behind where the cursor last was.
    for (const m of this.ghostGroup.children) m.castShadow = false;
    this.engine.invalidate?.();
  }

  _buildGhost(e) {
    this._clearGhost();
    this._pendingBatch = null;
    if (this.tool === 'select' || this.tool === 'erase' || this.tool === 'block') return;
    if (this.tool === 'liveload') {
      const hit = this._pickLedger(e);
      if (!hit) return;
      const side = this._sideFor(hit.ledger, hit.point);
      const existing = [...this.state.liveLoads.values()];
      const ledgers = this.state.ledgerList();
      const previews = e.shiftKey
        ? computeLiveLoadBatchPreview(hit.ledger, ledgers, side, existing, this.liveLoadPsf)
        : [buildLiveLoadPreviewForLedger(hit.ledger, ledgers, side, existing, this.liveLoadPsf)].filter(Boolean);
      const ghostMat = liveLoadGhostMaterial();
      for (const p of previews) this.ghostGroup.add(liveLoadPatch(p.liveLoad, ghostMat));
      this._pendingBatch = e.shiftKey && previews.length
        ? { count: previews.length, label: 'live load', apply: () => this._batchFillLiveLoads(hit.ledger, side) }
        : null;
      this.hooks.onPreview?.('liveload', previews.length, { psf: this.liveLoadPsf, batch: e.shiftKey, flipped: this.sideFlipped });
      return;
    }
    // Decks: ghost the boards that would be laid in the hovered bay.
    if (this.tool === 'plank') {
      const hit = this._pickLedger(e);
      if (!hit) return;
      const side = this._sideFor(hit.ledger, hit.point);
      const existing = [...this.state.plankPlacements.values()];
      const ledgers = this.state.ledgerList();
      const previews = e.shiftKey
        ? computePlankBatchPreview(hit.ledger, ledgers, side, existing)
        : [buildPlankPreviewForLedger(hit.ledger, ledgers, side, existing)].filter(Boolean);
      for (const p of previews) {
        for (const b of p.deck.boards) {
          this.ghostGroup.add(plankBoard(b.center, b.rotationZ, b.lengthFt, b.widthIn, MATERIALS.ghost));
        }
      }
      this._pendingBatch = e.shiftKey && previews.length
        ? { count: previews.length, label: 'deck', apply: () => this._batchFillPlanks(hit.ledger, side) }
        : null;
      this.hooks.onPreview?.('plank', previews.length, { batch: e.shiftKey, flipped: this.sideFlipped });
      return;
    }
    // Braces: ghost the diagonal on the hovered face, or the whole perimeter run.
    if (this.tool === 'brace') {
      const plan = this.bracePreview(e, e.shiftKey);
      for (const t of plan) this.ghostGroup.add(tubeBetween(t.a, t.b, 1.69, MATERIALS.ghost));
      this._pendingBatch = e.shiftKey && plan.length
        ? { count: plan.length, label: 'brace', apply: () => this._addBraces(plan) }
        : null;
      this.hooks.onPreview?.('brace', plan.length, {
        batch: e.shiftKey, direction: this.braceDirection,
        filter: this.braceFaceFilter, nthBay: this.braceNthBay,
        reason: this.braceMiss,
      });
      return;
    }
    const mat = MATERIALS.ghost;
    if (this.tool === 'standard') {
      const g = this._groundSnap(e);
      const plan = this.standardStackPlan();
      if (!g || !plan.length) return;
      const base = this.state.baseOffsetFt();
      const { meshes } = buildBaseAssembly({
        x: g.x, y: g.y, groundZ: 0,
        jackExtensionIn: this.state.base.jackExtensionIn,
        showWoodSill: this.state.base.showWoodSill,
        showBaseCollar: this.state.base.showBaseCollar,
        material: mat,
      });
      for (const m of meshes) this.ghostGroup.add(m);
      let z = base;
      for (const len of plan) {
        this.ghostGroup.add(verticalTube(g.x, g.y, z, z + len, STANDARD_TUBE_OD_IN, mat));
        z += len;
      }
      if (plan.length > 1) {
        this.hooks.onPreview?.('standard', plan.length, { totalFt: z - base, segments: plan });
      }
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
      if (e.shiftKey) {
        const plan = computeBatchPlan(this._nodesAtLevel(node.level), (a, b) => !this._ledgerExists(a, b));
        for (const { a, b } of plan) this.ghostGroup.add(tubeBetween([a.x, a.y, a.z], [b.x, b.y, b.z], 1.9, mat));
        this._pendingBatch = plan.length
          ? { count: plan.length, label: 'ledger', apply: () => this._batchFillLedgers(node.level) }
          : null;
        this.hooks.onPreview?.('ledger', plan.length, { batch: true, level: node.level });
        return;
      }
      this._pendingBatch = null;
      const t = this.ledgerTargetFor(node);
      if (t) this.ghostGroup.add(tubeBetween([node.x, node.y, node.z], [t.x, t.y, t.z], 1.9, mat));
      return;
    }
    if (this.tool === 'bracket') {
      const part = this.currentPart();
      if (part) for (const m of buildSideBracket(node, this._outwardDir(node), part.lengthFt, mat)) this.ghostGroup.add(m);
      return;
    }
    if (this.pending && this.tool === 'truss') {
      const a = this.pending;
      for (const m of buildTruss([a.x, a.y, a.z], [node.x, node.y, node.z], mat)) this.ghostGroup.add(m);
    }
  }

  destroy() {
    for (const [t, fn] of this._bound) this.engine.renderer.domElement.removeEventListener(t, fn);
    window.removeEventListener('keydown', this._onKey);
    this.engine.scene.remove(this.ghostGroup, this.overlayGroup);
  }
}
