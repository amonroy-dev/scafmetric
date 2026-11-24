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
import { MATERIALS, verticalTube, tubeBetween, buildBaseAssembly, buildSideBracket, sideBracketWorldMembers, trussWorldMembers, buildTruss, plankBoard, liveLoadPatch, liveLoadGhostMaterial, liveLoadArrows, liveLoadGhostArrowMaterial, STANDARD_TUBE_OD_IN } from './parts.js';
import { legColumn } from './parts.js';
import { getPart, CATEGORY_TOOL, CATALOG } from './catalog.js';
import {
  findClosestUnoccupiedTarget, computeBatchPlan, planStandardSegmentsForHeight, liftFrame,
  planBlockRecipe, planStandardSegmentsForLift, rotateOffset90, snapBlockCenter, BLOCK_DEFAULTS,
} from './planning.js';
import { hitData, instanceMeshes, clearGroup } from './instancing.js';
import {
  getLedgerSideSign, buildDeckLoadPreview, deckSpanIsSupported, connectedDecks, pickDeckWithRay,
  DEFAULT_BAY_LIVE_LOAD_PSF,
} from './liveloads.js';
import { buildSupportPair } from './supportspan.js';
import {
  buildPlankPreviewForLedger, computePlankBatchPreview, crossPlankPlacement, plankRunAxis, sameRunAxis,
} from './planks.js';
import {
  buildFaceGraph, framedFaces, facingOutward, faceKey, pickFace, faceBraceTarget, nodesByColumn, planPerimeterBraces,
  bracketTipFaces, footprintCentroid, PERP_OFFSET_FT,
} from './braces.js';
import { marqueeFromDrag, marqueeHits, combineSelection, flatRectangleCorners, MARQUEE_DRAG_THRESHOLD_PX } from './screenmarquee.js';
import {
  bracketDirections, chooseBracketDirection, runCentroid, bracketRunRow, rosetteAtHeight, alignedBracketDirection,
} from './bracketdirs.js';

// How far from the tube the horizontal side-pick crossing may land before it
// stops meaning "the cursor is on this side of that ledger".
const SIDE_PICK_MAX_FT = 4;
const DRAG_PX = MARQUEE_DRAG_THRESHOLD_PX;
// A click this close to a tube on screen selects it, however thin it is drawn.
const PICK_TOLERANCE_PX = 6;
const PICK_BAND_PX = 3;
// With Send to beam open only a leg can be picked, so a click may land further
// from one and still mean it. The leg under the pointer is lit by a column
// this wide.
const LEG_PICK_TOLERANCE_PX = 12;
const LEG_HOVER_OD_IN = 18;
// Truss fits, from ScaffoldPro: two degrees off a run still counts as along it
// (rosettes sit on a grid, so this only absorbs noise); an inch off its own
// length still fits (the frames do not stretch); 0.05 ft is the same lift.
const TRUSS_AXIS_TOL_RAD = (2 * Math.PI) / 180;
const TRUSS_SPAN_TOL_FT = 1 / 12;
const TRUSS_LEVEL_TOL_FT = 0.05;
// In toolbar order. Block comes straight after Select: most scaffolds start as one.
export const TOOLS = ['select', 'block', 'standard', 'ledger', 'brace', 'truss', 'bracket', 'plank', 'liveload', 'erase'];

const MARKER_GEO = new THREE.SphereGeometry(0.2, 12, 10);
// The block ghost's footprint: blue, and green once snapped (ScaffoldPro's cue).
const BLOCK_OUTLINE = new THREE.LineBasicMaterial({ color: 0x2563eb });
const BLOCK_OUTLINE_SNAPPED = new THREE.LineBasicMaterial({ color: 0x16a34a });

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
    // Block tool: ScaffoldPro's block recipe (the block card edits it) and the
    // preview's quarter turns (R).
    this.blockSettings = { ...BLOCK_DEFAULTS };
    this.rotationSteps = 0;
    // Live load tool: a load spans along the boards of the deck it sits on,
    // until R turns it across them. Picking the tool again puts it back.
    this.liveLoadAcross = false;
    // Bracket tool: steps round the free directions from the outward one (R).
    // Kept across tools, as ScaffoldPro keeps it, so a turn holds for the row.
    this.bracketTurn = 0;
    // Plank tool: which way the boards run (R). One choice, kept on every lift
    // and across runs until R is pressed again; null follows the picked ledger.
    this.plankRunAxis = null;
    // Truss tool: steps round the rosettes the truss can reach (R).
    this.trussTurn = 0;
    // Why the last brace hover found nothing: 'no-face' | 'too-short' | 'already-braced'.
    this.braceMiss = null;
    this.selection = new Set();
    this._down = null;
    this._marquee = null;

    this.ghostGroup = new THREE.Group();
    engine.scene.add(this.ghostGroup);
    this._marqueeBox = null; // the selection box, a DOM element over the canvas

    const el = engine.renderer.domElement;
    this._bound = [];
    const on = (t, fn) => { el.addEventListener(t, fn); this._bound.push([t, fn]); };
    on('pointerdown', e => this._onDown(e));
    on('pointermove', e => this._onMove(e));
    on('pointerup', e => this._onUp(e));
    // Hover ends, preview ends (ScaffoldPro clears its hover on pointer-out).
    on('pointerleave', () => { this._hoverAt = null; this._pendingBatch = null; this._clearGhost(); this._setCursor(''); });
    this._onKey = e => this._key(e);
    window.addEventListener('keydown', this._onKey);
    // Shift is tracked as its own state, as ScaffoldPro does: pressing it over a
    // node shows the whole run at once and letting go goes back to one member,
    // with no need to nudge the mouse for a pointer event to carry the change.
    this.shiftHeld = false;
    this._hoverAt = null; // last client point hovered over the canvas
    this._onKeyUp = e => { if (e.key === 'Shift') this._setShift(false); };
    this._onBlur = () => this._setShift(false); // a keyup lost to another window
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
  }

  /** Shift went down or up: redraw the preview where the pointer already is. */
  _setShift(held) {
    if (this.shiftHeld === held) return;
    this.shiftHeld = held;
    this._refreshGhost();
  }

  /**
   * Redraw the preview where the pointer already is: after Shift, R, or a
   * change to the block card, so the change is on screen in the same frame
   * instead of waiting for the mouse to move.
   */
  _refreshGhost() {
    if (!this._hoverAt || this._marquee || this.engine.navigating) return;
    this._updateGhost({ ...this._hoverAt, shiftKey: this.shiftHeld, ctrlKey: false, altKey: false, buttons: 0 });
  }

  /** Change the block recipe (from the block card). */
  setBlockSettings(patch) {
    Object.assign(this.blockSettings, patch);
    this._refreshGhost();
  }

  setTool(name) {
    this.tool = name;
    this.pending = null;
    this.liveLoadAcross = false;
    this._clearGhost();
    this._setCursor('');
    this.hooks.onToolChange?.(name);
  }
  /** The pointer over the canvas: a hand while it is on something a click takes. */
  _setCursor(name) {
    const style = this.engine.renderer.domElement.style;
    if (style && style.cursor !== name) style.cursor = name;
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
    // The block ghost is instanced, so its buffers are freed here.
    clearGroup(this.ghostGroup);
    this.engine.invalidate?.();
  }
  /** Abandon a selection box being dragged, so releasing the mouse selects nothing. */
  cancelMarquee() {
    this._marquee = null;
    this._down = null;
    this._clearOverlay();
  }

  /** Hide the selection box. */
  _clearOverlay() {
    if (this._marqueeBox) this._marqueeBox.style.display = 'none';
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
    // A side bracket already spans from its rosette to its tip, so that edge is
    // taken, as in ScaffoldPro: a ledger from the tip runs along the bracket
    // row instead of back to the standard it hangs on.
    for (const k of this.state.brackets.values()) {
      const tip = this.state.bracketTipNode(k);
      ledgerKeys.add(segmentKey([k.x, k.y, k.z], [tip.x, tip.y, tip.z]));
    }
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
    // A left-drag draws a selection box in any tool and any view; a click
    // without a drag still belongs to the tool.
    this._marquee = { startClientX: e.clientX, startClientY: e.clientY, currentClientX: e.clientX, currentClientY: e.clientY };
  }

  _onMove(e) {
    if (this._down) this._down.moved = Math.max(Math.abs(e.clientX - this._down.x), Math.abs(e.clientY - this._down.y));
    if (this._marquee && (e.buttons & 1)) {
      this._marquee.currentClientX = e.clientX;
      this._marquee.currentClientY = e.clientY;
      if (this._down && this._down.moved >= DRAG_PX) { this._clearGhost(); this._drawMarquee(); }
      return;
    }
    if (this._marquee && !(e.buttons & 1)) { this._marquee = null; this._clearOverlay(); }
    this._hoverAt = { clientX: e.clientX, clientY: e.clientY };
    this.shiftHeld = e.shiftKey; // the pointer event is the authority when there is one
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
    if (marquee && dragged) {
      marquee.currentClientX = e.clientX;
      marquee.currentClientY = e.clientY;
      // With Send to beam open, a box takes the legs inside it for the beam.
      if (this.tool === 'beam') { this._finishLegMarquee(marquee, { ctrlKey: down.ctrl }); return; }
      // Shift adds and Ctrl toggles, as in ScaffoldPro. Outside Select a box
      // adds to what is selected rather than replacing it.
      this._finishMarquee(marquee, { shiftKey: down.shift || this.tool !== 'select', ctrlKey: down.ctrl });
      return;
    }
    if (dragged) return; // camera/aborted drag
    this._act(e);
    // The ghost previewed what this click just placed. Show what the next click
    // would do instead, without waiting for the pointer to move: a stale ghost
    // left over a placed part (an amber load ghost over the new cyan patch).
    this._updateGhost(e);
  }

  // --- the selection box (ScaffoldPro's screen marquee) ------------------------
  // Drawn on the screen, not on the ground, so it works in every view. Left to
  // right is a Window (solid blue: wholly inside), right to left a Crossing
  // (dashed green: anything touched). See screenmarquee.js.

  _marqueeGeometry(m) {
    return marqueeFromDrag(this.engine.renderer.domElement.getBoundingClientRect(), this.engine.camera, m);
  }

  _drawMarquee() {
    const canvas = this.engine.renderer.domElement;
    if (!this._marqueeBox) {
      const box = document.createElement('div');
      box.setAttribute('aria-hidden', 'true');
      // Inside the canvas's own container, above the canvas and under the
      // toolbars. On the page body it sat behind the builder window (which is
      // stacked far above the page) and could not be seen.
      Object.assign(box.style, { position: 'absolute', zIndex: '3', pointerEvents: 'none', boxSizing: 'border-box', display: 'none' });
      (canvas.parentElement || document.body).appendChild(box);
      this._marqueeBox = box;
    }
    const bounds = canvas.getBoundingClientRect();
    const { rect, mode } = this._marqueeGeometry(this._marquee);
    // Canvas-local, which is container-local: the canvas fills its container.
    const host = (canvas.parentElement || document.body).getBoundingClientRect();
    const ox = bounds.left - host.left, oy = bounds.top - host.top;
    const left = ox + Math.max(0, rect.left), top = oy + Math.max(0, rect.top);
    const right = ox + Math.min(bounds.width, rect.right), bottom = oy + Math.min(bounds.height, rect.bottom);
    this._marqueeBox.dataset.marquee = mode;
    Object.assign(this._marqueeBox.style, {
      display: 'block', left: `${left}px`, top: `${top}px`,
      width: `${Math.max(0, right - left)}px`, height: `${Math.max(0, bottom - top)}px`,
      border: mode === 'window' ? '1px solid #2f6fed' : '1px dashed #0f7b0f',
      background: mode === 'window' ? 'rgba(47, 111, 237, 0.08)' : 'rgba(15, 123, 15, 0.08)',
    });
  }

  /** Every part as the box tests it: tubes as segments, decks and loads as outlines. */
  _marqueeParts() {
    const s = this.state;
    const segments = this._standardSegments(), outlines = [];
    for (const map of [s.ledgers, s.braces, s.guardrails]) for (const m of map.values()) segments.push({ id: m.id, a: m.a, b: m.b });
    for (const k of s.brackets.values()) for (const m of sideBracketWorldMembers(k, k.dir, k.lengthFt)) segments.push({ id: k.id, a: m.a, b: m.b });
    for (const t of s.trusses.values()) for (const m of trussWorldMembers(t.a, t.b, t.family)) segments.push({ id: t.id, a: m.a, b: m.b });
    for (const d of s.plankBays()) {
      outlines.push({ id: d.id, corners: [[d.x0, d.y0, d.z], [d.x1, d.y0, d.z], [d.x1, d.y1, d.z], [d.x0, d.y1, d.z]] });
    }
    for (const p of s.liveLoadPatches()) {
      const corners = flatRectangleCorners({ x: p.center[0], y: p.center[1] }, p.widthFt / 2, p.lengthFt / 2, p.rotationZ, p.center[2]);
      outlines.push({ id: p.id, corners: corners.map(c => [c.x, c.y, c.z]) });
    }
    return { segments, outlines };
  }

  _finishMarquee(m, modifiers) {
    const { rect, mode, projector } = this._marqueeGeometry(m);
    const hits = marqueeHits(projector, rect, mode, this._marqueeParts());
    this.selection = new Set(combineSelection([...this.selection], hits, modifiers));
    this.hooks.onSelectionChange?.([...this.selection]);
  }

  /** Each standard as the screen tests it: its whole height, ground to top, so a box or a click on any of it counts. */
  _standardSegments() {
    const s = this.state, base = s.baseOffsetFt();
    return [...s.standards.values()].map(c => ({ id: c.id, a: [c.x, c.y, 0], b: [c.x, c.y, base + s.standardHeightFt(c)] }));
  }

  /** A box dragged with Send to beam open: the legs in it, and nothing else. */
  _finishLegMarquee(m, modifiers) {
    const { rect, mode, projector } = this._marqueeGeometry(m);
    const ids = marqueeHits(projector, rect, mode, { segments: this._standardSegments(), outlines: [] });
    this.hooks.onLegBox?.(ids, modifiers);
  }

  _act(e) {
    const s = this.state;
    // Move/copy capture: ground clicks drive the anchor/destination steps.
    if (this.transformHook) {
      const g = this._groundSnap(e);
      if (g && this.transformHook(g)) return;
    }
    // Send to beam: a click puts the leg under it on the beam, or takes it off.
    if (this.tool === 'beam') {
      this.hooks.onLegPick?.(this._pickStandard(e));
      return;
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
    // A click places the block the ghost is showing.
    if (this.tool === 'block') {
      const placement = this._blockPlacement(e);
      if (placement) this.placeBlockAt(placement);
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
      const p = this._plankPlacementFor(hit.ledger, side);
      if (!this._isDecked(p)) s.addPlankOnLedger(p.ledgerId, p.sideSign);
      return;
    }
    // A live load goes on the decked bay under the pointer; SHIFT takes the
    // whole platform. A bay already loaded takes the new load and direction.
    if (this.tool === 'liveload') {
      const plan = this._liveLoadPlan(e);
      if (!plan || !plan.changes.length) return;
      const n = this._applyLiveLoads(plan);
      if (e.shiftKey) this.hooks.onBulkFill?.(n, 'live load');
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
    // One bracket on this rosette, or with SHIFT one on every standard along
    // the run at this height.
    if (this.tool === 'bracket') {
      const part = this.currentPart();
      const plan = part ? this._bracketPlan(node, e.shiftKey) : null;
      if (!plan || !plan.items.length) return;
      const n = this._addBrackets(plan, part.lengthFt);
      if (e.shiftKey) this.hooks.onBulkFill?.(n, 'bracket');
      return;
    }

    // One click: the truss runs from this rosette to the one its own length
    // away along the run; R steps to the next direction, SHIFT fills the face.
    if (this.tool === 'truss') {
      const span = this._trussSpan(node);
      if (!span) return;
      if (e.shiftKey) { this._batchFillTrusses(span); return; }
      s.addTruss(span.a, span.b, this._trussFamily());
    }
  }

  // --- trusses ----------------------------------------------------------------
  // Placed as ScaffoldPro places them (its trussPlacement.ts): a truss reaches
  // from one rosette to another exactly its own length away, at the same lift
  // and along a run, so from any rosette there are only a few places it can
  // go. One is offered, R steps to the next, and the choice sticks.

  _trussFamily() { return CATALOG[this.categoryKey]?.family || 'truss'; }

  _trussExists(a, b) {
    const k = segmentKey(a, b);
    for (const t of this.state.trusses.values()) if (segmentKey(t.a, t.b) === k) return true;
    return false;
  }

  /** The rosettes a truss of the chosen length can reach from here, by bearing. */
  _trussCandidates(node) {
    const part = this.currentPart();
    if (!part || !node || !CATALOG[this.categoryKey]?.family) return [];
    const along = (bearing, axis) => {
      const d = Math.abs(Math.atan2(Math.sin(bearing - axis), Math.cos(bearing - axis)));
      return d <= TRUSS_AXIS_TOL_RAD || d >= Math.PI - TRUSS_AXIS_TOL_RAD;
    };
    // Along a run, not merely the right distance away: a truss replaces a
    // ledger on a bay line and never cuts a bay corner to corner. Runs come
    // from the ledgers meeting this standard, or the plan axes before any.
    const axes = [];
    for (const l of this.state.ledgers.values()) {
      for (const [p, q] of [[l.a, l.b], [l.b, l.a]]) {
        if (Math.hypot(p[0] - node.x, p[1] - node.y) > 0.01) continue;
        const bearing = Math.atan2(q[1] - p[1], q[0] - p[0]);
        if (Math.hypot(q[0] - p[0], q[1] - p[1]) > 0.1 && !axes.some(a => along(bearing, a))) axes.push(bearing);
      }
    }
    if (!axes.length) axes.push(0, Math.PI / 2);
    const out = [];
    for (const n of this._nodesAtLevel(node.level)) {
      if (Math.abs(n.z - node.z) > TRUSS_LEVEL_TOL_FT) continue;
      const dist = Math.hypot(n.x - node.x, n.y - node.y);
      if (Math.abs(dist - part.lengthFt) > TRUSS_SPAN_TOL_FT) continue;
      const bearing = Math.atan2(n.y - node.y, n.x - node.x);
      if (!axes.some(a => along(bearing, a))) continue;
      if (this._trussExists([node.x, node.y, node.z], [n.x, n.y, n.z])) continue;
      out.push({ target: n, bearing });
    }
    return out.sort((p, q) => p.bearing - q.bearing);
  }

  /** The span R has landed on from this rosette, or null. */
  _trussSpan(node) {
    const c = this._trussCandidates(node);
    if (!c.length) return null;
    const t = c[((this.trussTurn % c.length) + c.length) % c.length].target;
    return { a: [node.x, node.y, node.z], b: [t.x, t.y, t.z], choices: c.length };
  }

  /**
   * SHIFT: the whole face. Steps one truss length at a time both ways along
   * the span and stops at the first step with no rosette to land on or a truss
   * already there. It does not turn corners.
   */
  _trussFaceRun(span) {
    const len = Math.hypot(span.b[0] - span.a[0], span.b[1] - span.a[1]);
    if (len < 1e-6) return [];
    const ux = (span.b[0] - span.a[0]) / len, uy = (span.b[1] - span.a[1]) / len;
    const nodes = this.state.nodes().filter(n => Math.abs(n.z - span.a[2]) <= TRUSS_LEVEL_TOL_FT);
    const next = (from, sign) => {
      const x = from[0] + ux * len * sign, y = from[1] + uy * len * sign;
      const n = nodes.find(q => Math.hypot(q.x - x, q.y - y) <= TRUSS_SPAN_TOL_FT);
      return n ? [n.x, n.y, n.z] : null;
    };
    const run = [{ a: span.a, b: span.b }];
    for (const [anchor, sign] of [[span.b, 1], [span.a, -1]]) {
      let from = anchor;
      for (let guard = 0; guard < 200; guard++) {
        const to = next(from, sign);
        if (!to || this._trussExists(from, to)) break;
        run.push(sign === 1 ? { a: from, b: to } : { a: to, b: from });
        from = to;
      }
    }
    return run;
  }

  _batchFillTrusses(span) {
    const run = this._trussFaceRun(span);
    const family = this._trussFamily();
    this.state.batch(() => { for (const r of run) this.state.addTruss(r.a, r.b, family); });
    this.hooks.onBulkFill?.(run.length, 'truss');
    return run.length;
  }

  /**
   * Which way a bracket on this rosette points, as ScaffoldPro chooses: square
   * to the run, out of the run's middle by default, R steps round the free
   * directions. Null when the rosette has no free direction, or is itself a
   * bracket's tip (brackets hang on standards, not off other brackets).
   */
  _bracketDir(node) {
    if (!node || node.bracketId) return null;
    const ledgers = this.state.ledgerList();
    const directions = bracketDirections(node, { ledgers, brackets: [...this.state.brackets.values()] });
    const centroid = runCentroid(node, ledgers, [...this.state.standards.values()]);
    return chooseBracketDirection(node, directions, centroid, this.bracketTurn);
  }

  /**
   * What the Bracket tool would hang from this rosette: one bracket, or with
   * `wholeRun` (SHIFT) one on every standard along the run at this height.
   * Each of those faces the way the hovered one does rather than choosing for
   * itself, so the standard at the end of the run does not turn down the
   * return. A standard with no rosette at this height, or with that direction
   * taken, is passed over: it must not stop the rest of the row.
   *
   * Returns { dir, items: [{ node, dir }], walked }, `walked` being how many
   * standards the run has; null when the rosette has no free direction.
   */
  _bracketPlan(node, wholeRun) {
    const dir = this._bracketDir(node);
    if (!dir) return null;
    if (!wholeRun) return { dir, items: [{ node, dir }], walked: 1 };
    const ledgers = this.state.ledgerList();
    const brackets = [...this.state.brackets.values()];
    const angle = Math.atan2(dir[1], dir[0]);
    // A bracket points square to its run, so the run lies a quarter turn round.
    const row = bracketRunRow(node, angle - Math.PI / 2, ledgers, [...this.state.standards.values()]);
    const rosettes = this.state.nodes().filter(n => !n.bracketId);
    const onColumn = p => rosettes.filter(n => Math.hypot(n.x - p.x, n.y - p.y) < 0.01);
    const items = [];
    for (const p of row) {
      if (Math.hypot(p.x - node.x, p.y - node.y) < 0.01) { items.push({ node, dir }); continue; }
      const at = rosetteAtHeight(onColumn(p), node.z);
      if (!at) continue;
      const facing = alignedBracketDirection(bracketDirections(at, { ledgers, brackets }), angle);
      if (facing) items.push({ node: at, dir: facing });
    }
    return { dir, items, walked: row.length };
  }

  /** Hang the brackets of a plan, as one edit. Returns how many. */
  _addBrackets(plan, lengthFt) {
    return this.state.batch(() => {
      for (const b of plan.items) this.state.addBracket(b.node, b.dir, lengthFt);
      return plan.items.length;
    });
  }

  // --- decks: which way the boards run --------------------------------------

  /**
   * The deck to lay for the bay picked by a ledger and side, honouring the run
   * direction chosen with R. Falls back to the picked ledger's
   * own pair when the opening is bounded one way only.
   */
  _plankPlacementFor(ledger, side) {
    const natural = { ledgerId: ledger.id, sideSign: side };
    const want = this.plankRunAxis;
    if (want === null || sameRunAxis(want, plankRunAxis(ledger))) return natural;
    return crossPlankPlacement(ledger, this.state.ledgerList(), side) || natural;
  }

  /** True when this placement's opening already has a deck, either way round. */
  _isDecked(placement) {
    const ledger = this.state.ledgers.get(placement.ledgerId);
    if (!ledger) return true;
    const pair = buildSupportPair(ledger, this.state.ledgerList(), placement.sideSign);
    if (!pair) return true;
    const { source, signedOffsetFt, overlapMinFt, overlapMaxFt } = pair;
    const cx = source.mid.x + source.dir.x * (overlapMinFt + overlapMaxFt) / 2 + source.perp.x * signedOffsetFt / 2;
    const cy = source.mid.y + source.dir.y * (overlapMinFt + overlapMaxFt) / 2 + source.perp.y * signedOffsetFt / 2;
    return this.state.plankBays().some(d =>
      Math.abs(d.z - source.z) < 0.1 && Math.hypot((d.x0 + d.x1) / 2 - cx, (d.y0 + d.y1) / 2 - cy) < 0.5);
  }

  /**
   * R with the Plank tool: turn the boards in the hovered opening to run the
   * other way, decking off the other pair of ledgers, and keep that for
   * every bay and lift from then on. Returns the new run axis, or null when the opening is bounded
   * one way only.
   */
  _turnPlankRun() {
    const hit = this._hoverAt ? this._pickLedger(this._hoverAt) : null;
    if (!hit) return undefined;
    const side = this._sideFor(hit.ledger, hit.point);
    const current = this._plankPlacementFor(hit.ledger, side);
    const currentLedger = this.state.ledgers.get(current.ledgerId);
    const cross = crossPlankPlacement(currentLedger, this.state.ledgerList(), current.sideSign);
    if (!cross) return null;
    const axis = plankRunAxis(this.state.ledgers.get(cross.ledgerId));
    this.plankRunAxis = axis;
    return axis;
  }

  /**
   * What a click is on, nearest first.
   *
   * A tube is under two inches across, which zoomed out is a pixel or two: a
   * click had to land exactly on it, and standards in a whole-scaffold view
   * were close to unselectable. So besides what the ray actually hits, every
   * tube passing within a few pixels of the click counts, as ScaffoldPro's
   * fatter pick targets do, but measured on the screen so it works the same at
   * any zoom.
   *
   * Ordered by how far off the click was (in bands, so an exact click on a
   * back leg beats a near miss on a front one) and then by distance from the
   * camera. Clicking again steps to the next one behind.
   */
  _pickCandidates(e) {
    const { raycaster, camera, renderer } = this.engine;
    raycaster.setFromCamera(this.engine.pointer, camera);
    const best = new Map();
    const note = (id, px, depth) => {
      const band = Math.floor(px / PICK_BAND_PX);
      const cur = best.get(id);
      if (!cur || band < cur.band || (band === cur.band && depth < cur.depth)) best.set(id, { id, band, depth });
    };
    for (const h of raycaster.intersectObjects(this.hooks.getContentMeshes?.() || [], false)) {
      const d = hitData(h);
      if (d.proxy || !d.id) continue; // invisible hit targets never select
      note(d.id, 0, h.distance);
    }
    const bounds = renderer.domElement.getBoundingClientRect();
    const ray = raycaster.ray;
    const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), onRay = new THREE.Vector3(), onSeg = new THREE.Vector3();
    for (const seg of this._marqueeParts().segments) {
      ray.distanceSqToSegment(p0.set(...seg.a), p1.set(...seg.b), onRay, onSeg);
      const depth = onRay.distanceTo(ray.origin);
      onSeg.project(camera);
      if (onSeg.z < -1 || onSeg.z > 1) continue; // behind the camera or past the far plane
      const px = Math.hypot(((onSeg.x + 1) / 2) * bounds.width - (e.clientX - bounds.left), ((1 - onSeg.y) / 2) * bounds.height - (e.clientY - bounds.top));
      if (px <= PICK_TOLERANCE_PX) note(seg.id, px, depth);
    }
    return [...best.values()].sort((p, q) => p.band - q.band || p.depth - q.depth).map(c => c.id);
  }

  /**
   * Pick with cycling: clicking the same spot again steps to the next object
   * behind the current one, so overlapping members stay reachable.
   */
  _cyclePick(e) {
    const ids = this._pickCandidates(e);
    if (!ids.length) { this._cycle = null; return null; }
    const near = this._cycle && Math.hypot(e.clientX - this._cycle.x, e.clientY - this._cycle.y) < 6;
    if (near && this._cycle.ids.join('|') === ids.join('|')) {
      this._cycle.index = (this._cycle.index + 1) % ids.length;
    } else {
      this._cycle = { x: e.clientX, y: e.clientY, ids, index: 0 };
    }
    return ids[this._cycle.index];
  }

  // --- legs for the beam -------------------------------------------------------
  // With Send to beam open a click picks a leg and nothing else: the standard
  // nearest the click as it is drawn on the screen, so from above, where a leg
  // is a dot, clicking the dot is enough. A leg's load tag stands for its leg.

  /** The standard a click here would take, or null. */
  _pickStandard(e) {
    const { raycaster, camera, renderer } = this.engine;
    this.engine.setPointerFromEvent(e);
    raycaster.setFromCamera(this.engine.pointer, camera);
    // A load tag is drawn over everything, so it is what the click lands on.
    const tags = this.hooks.getLegTags?.() || [];
    if (tags.length) {
      const id = raycaster.intersectObjects(tags, false)[0]?.object.userData.legId;
      if (id && this.state.standards.has(id)) return id;
    }
    const bounds = renderer.domElement.getBoundingClientRect();
    const ray = raycaster.ray;
    const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), onRay = new THREE.Vector3(), onSeg = new THREE.Vector3();
    let best = null;
    for (const seg of this._standardSegments()) {
      ray.distanceSqToSegment(p0.set(...seg.a), p1.set(...seg.b), onRay, onSeg);
      const depth = onRay.distanceTo(ray.origin);
      onSeg.project(camera);
      if (onSeg.z < -1 || onSeg.z > 1) continue; // behind the camera or past the far plane
      const px = Math.hypot(((onSeg.x + 1) / 2) * bounds.width - (e.clientX - bounds.left), ((1 - onSeg.y) / 2) * bounds.height - (e.clientY - bounds.top));
      if (px > LEG_PICK_TOLERANCE_PX) continue;
      const band = Math.floor(px / PICK_BAND_PX);
      if (!best || band < best.band || (band === best.band && depth < best.depth)) best = { id: seg.id, band, depth };
    }
    return best ? best.id : null;
  }

  /** Send to beam: light up the leg a click would take, and show a hand over it. */
  _legHoverGhost(e) {
    const id = this._pickStandard(e);
    const c = id ? this.state.standards.get(id) : null;
    if (c) {
      const top = this.state.baseOffsetFt() + this.state.standardHeightFt(c);
      this.ghostGroup.add(legColumn(c.x, c.y, 0, top, LEG_HOVER_OD_IN, MATERIALS.legHover));
    }
    this._setCursor(c ? 'pointer' : '');
    this.hooks.onPreview?.('beam', c ? 1 : 0, { id: c ? id : null });
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

  /**
   * Face graph for the current standards, rebuilt per interaction, plus faces
   * along rows of bracket tips where a brace can climb between two lifts of
   * brackets (bracketTipFaces).
   */
  _faces() {
    // Kept until the model changes: building the graph compares every pair of
    // standards against every third one, and a hover asks for it on each move.
    const version = this.state.version;
    if (this._faceCache && this._faceCache.version === version) return this._faceCache.faces;
    const standards = [...this.state.standards.values()];
    // Sides of the scaffold as it is framed (a ledger between the two
    // standards, where there are ledgers), each outside one facing out.
    const faces = facingOutward(framedFaces(buildFaceGraph(standards), this._standardLinks(standards)));
    if (this.state.brackets.size > 1) {
      const nodes = this.state.nodes();
      const tips = new Map();
      for (const n of nodes) if (n.bracketId && !tips.has(n.columnId)) tips.set(n.columnId, { id: n.columnId, x: n.x, y: n.y, dir: n.dir });
      faces.push(...bracketTipFaces([...tips.values()], nodesByColumn(nodes), footprintCentroid(standards)));
    }
    this._faceCache = { version, faces };
    return faces;
  }

  /**
   * Which standards a ledger or truss joins, at any lift: { joined(a, b),
   * framed(id) } by standard id. A member to a bracket tip joins no two
   * standards and so does not count.
   */
  _standardLinks(standards) {
    const key = (x, y) => `${Math.round(x * 100)},${Math.round(y * 100)}`;
    const idAt = new Map(standards.map(s => [key(s.x, s.y), s.id]));
    const pairs = new Set(), framed = new Set();
    for (const map of [this.state.ledgers, this.state.trusses]) {
      for (const m of map.values()) {
        const a = idAt.get(key(m.a[0], m.a[1])), b = idAt.get(key(m.b[0], m.b[1]));
        if (!a || !b || a === b) continue;
        pairs.add(faceKey(a, b));
        framed.add(a);
        framed.add(b);
      }
    }
    return { joined: (a, b) => pairs.has(faceKey(a, b)), framed: id => framed.has(id) };
  }

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
    const placements = this._plankRunPlacements(ledger, sideSign);
    const added = this.state.batch(() => {
      let n = 0;
      for (const p of placements) {
        if (this._isDecked(p)) continue;
        if (this.state.addPlankOnLedger(p.ledgerId, p.sideSign)) n++;
      }
      return n;
    });
    this.hooks.onBulkFill?.(added, 'deck');
    return added;
  }

  /**
   * Every bay along the run, each decked the way R chose for this lift, less
   * any opening already decked either way round.
   */
  _plankRunPlacements(ledger, sideSign) {
    const ledgers = this.state.ledgerList();
    const seen = new Set();
    const out = [];
    for (const preview of computePlankBatchPreview(ledger, ledgers, sideSign, [])) {
      const runLedger = this.state.ledgers.get(preview.placement.ledgerId);
      const p = this._plankPlacementFor(runLedger, preview.placement.sideSign);
      const key = `${p.ledgerId}:${p.sideSign}`;
      if (seen.has(key) || this._isDecked(p)) continue;
      seen.add(key);
      out.push(p);
    }
    return out;
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

  // --- live loads -----------------------------------------------------------
  // A load goes on a decked bay: point at the deck and click. It spans one
  // way, along the boards unless R turned it across them (see liveloads.js).

  /** Every deck, the ledgers, and which load sits on which deck; cached until the model changes. */
  _deckIndex() {
    const version = this.state.version;
    if (this._deckCache && this._deckCache.version === version) return this._deckCache;
    const decks = this.state.plankBays().filter(d => d.frame);
    this._deckCache = { version, decks, ledgers: this.state.ledgerList(), loads: this.state.liveLoadsByDeck(decks) };
    return this._deckCache;
  }

  /** The deck under the pointer. */
  _pickDeck(e) {
    this.engine.setPointerFromEvent(e);
    this.engine.raycaster.setFromCamera(this.engine.pointer, this.engine.camera);
    const { decks } = this._deckIndex();
    const hit = pickDeckWithRay(this.engine.raycaster.ray, decks);
    if (hit) return hit.deck;
    // Seen edge on, a deck has no surface to point at: take the board itself.
    for (const h of this.engine.raycaster.intersectObjects(this.hooks.getContentMeshes?.() || [], false)) {
      const d = hitData(h);
      if (d.kind === 'plank') return decks.find(k => k.id === d.id) || null;
    }
    return null;
  }

  /**
   * What a click would do here: the decks pointed at (the whole platform with
   * SHIFT), how each load would span, and which of them that would change.
   * Null when the pointer is on no deck.
   */
  _liveLoadPlan(e) {
    const deck = this._pickDeck(e);
    if (!deck) return null;
    const { decks, ledgers, loads } = this._deckIndex();
    const psf = this.liveLoadPsf;
    const items = (e.shiftKey ? connectedDecks(deck, decks) : [deck]).map(d => {
      // A bay with ledgers on two sides only keeps its load along its boards.
      const across = this.liveLoadAcross && deckSpanIsSupported(d, ledgers, true);
      const existing = loads.get(d.id) || null;
      const same = !!existing && existing.deckId === d.id && existing.psf === psf && !!existing.across === across;
      return { deck: d, across, existing, same };
    });
    return { deck, items, changes: items.filter(i => !i.same), psf };
  }

  /** Place or change the loads of a plan, as one edit. Returns how many. */
  _applyLiveLoads(plan) {
    return this.state.setDeckLiveLoads(
      plan.changes.map(i => ({ deckId: i.deck.id, psf: plan.psf, across: i.across }))).length;
  }

  /** Which way loads span, from the card: along the boards, or across them. */
  setLiveLoadAcross(across) {
    this.liveLoadAcross = !!across;
    this._refreshGhost();
  }

  // --- blocks ---------------------------------------------------------------
  // As ScaffoldPro's PlaceBlockTool: the block card holds the recipe, a ghost
  // of the whole block follows the pointer and snaps onto the standards beside
  // it, R turns it a quarter turn, and a click places it.

  _blockPlan() {
    const s = this.state;
    return planBlockRecipe(this.blockSettings, {
      liftZ: lift => s.liftZ(lift),
      showBaseCollar: s.base.showBaseCollar,
      standardLengthsFt: CATALOG.standards.parts.map(p => p.lengthFt),
      ledgerLengthsFt: CATALOG.ledgers.parts.map(p => p.lengthFt),
    });
  }

  /** Where the block would go with the pointer at `e`, or null off the ground. */
  _blockPlacement(e) {
    this.engine.setPointerFromEvent(e);
    const p = this.engine.groundPoint();
    if (!p) return null;
    const plan = this._blockPlan();
    const g = this._blockCenterOnGrid(p, plan);
    const c = snapBlockCenter(g, plan, this.rotationSteps, [...this.state.standards.values()]);
    return { plan, center: { x: c.x, y: c.y }, snapped: c.snapped, rotationSteps: this.rotationSteps };
  }

  /**
   * The block centre nearest the pointer that puts the block's standards ON the
   * grid lines. Snapping the centre itself left a 7 x 3 ft block's standards
   * half a foot off the lines, between them; the corner standard is what is
   * snapped, and the centre follows from it.
   */
  _blockCenterOnGrid(p, plan) {
    const turned = this.rotationSteps % 2 === 1;
    const halfX = (turned ? plan.depthFt : plan.widthFt) / 2;
    const halfY = (turned ? plan.widthFt : plan.depthFt) / 2;
    return { x: this.state.snap(p.x - halfX) + halfX, y: this.state.snap(p.y - halfY) + halfY };
  }

  /** A placement in world feet: plain data the ghost and the placement share. */
  _blockWorld({ plan, center, rotationSteps }) {
    const s = this.state;
    const at = o => {
      const r = rotateOffset90(o, rotationSteps);
      return { x: center.x + r.x, y: center.y + r.y };
    };
    const xyz = (o, lift) => { const p = at(o); return [p.x, p.y, s.liftZ(lift)]; };
    const braces = plan.braces.map(b => {
      // Just outside the face, as the Brace tool places them.
      const n = rotateOffset90(b.normal, rotationSteps);
      const a = xyz(b.a, b.lift), z = xyz(b.b, b.toLift);
      const ox = n.x * PERP_OFFSET_FT, oy = n.y * PERP_OFFSET_FT;
      return { a: [a[0] + ox, a[1] + oy, a[2]], b: [z[0] + ox, z[1] + oy, z[2]] };
    });
    const decks = plan.decks.map(d => {
      const p = at({ x: d.x0, y: d.y0 }), q = at({ x: d.x1, y: d.y1 });
      return { x0: Math.min(p.x, q.x), y0: Math.min(p.y, q.y), x1: Math.max(p.x, q.x), y1: Math.max(p.y, q.y), z: s.liftZ(d.lift) };
    });
    const corners = [[plan.xs[0], plan.ys[0]], [plan.xs[plan.xs.length - 1], plan.ys[0]],
      [plan.xs[plan.xs.length - 1], plan.ys[plan.ys.length - 1]], [plan.xs[0], plan.ys[plan.ys.length - 1]]]
      .map(([x, y]) => at({ x, y }));
    return {
      standards: plan.standards.map(at),
      ledgers: plan.ledgers.map(l => ({ a: xyz(l.a, l.lift), b: xyz(l.b, l.lift) })),
      braces, decks, corners,
    };
  }

  /**
   * Place a block. Standards already standing where the block wants one are
   * shared, not stacked on: they get only the segments they are short of.
   * Ledgers, braces and decks already there are left alone. One undo step.
   */
  placeBlockAt(placement) {
    const s = this.state;
    const { plan } = placement;
    const w = this._blockWorld(placement);
    const lengths = CATALOG.standards.parts.map(p => p.lengthFt);
    let added = 0;
    s.batch(() => {
      for (const p of w.standards) {
        const existing = s.standardAt(p.x, p.y);
        if (!existing) {
          for (const len of plan.segments) s.addStandard(p.x, p.y, len, { exact: true });
          added++;
          continue;
        }
        const short = plan.requiredLift - s.standardLifts(existing);
        if (short > 0) for (const len of planStandardSegmentsForLift(short, lengths)) s.addStandard(p.x, p.y, len, { exact: true });
      }
      const ledgerKeys = new Set([...s.ledgers.values()].map(l => segmentKey(l.a, l.b)));
      for (const l of w.ledgers) {
        const k = segmentKey(l.a, l.b);
        if (ledgerKeys.has(k)) continue;
        ledgerKeys.add(k);
        s.addLedger(l.a, l.b);
      }
      for (const b of w.braces) if (!this._braceExistsBetween(b.a, b.b)) s.addBrace(b.a, b.b);
      const decked = s.plankBays();
      for (const d of w.decks) {
        const cx = (d.x0 + d.x1) / 2, cy = (d.y0 + d.y1) / 2;
        if (decked.some(e => Math.abs(e.z - d.z) < 0.1 && Math.hypot((e.x0 + e.x1) / 2 - cx, (e.y0 + e.y1) / 2 - cy) < 0.5)) continue;
        s.addPlank([d.x0, d.y0, d.z], [d.x1, d.y1, d.z]);
      }
      // Rails round each planked level, on the two rosettes above the deck.
      if (this.blockSettings.guardrails) {
        for (const lift of plan.deckLifts) s.setDeckGuardrails(s.liftZ(lift), [s.liftZ(lift + 1), s.liftZ(lift + 2)]);
      }
    });
    this.hooks.onBulkFill?.(added, 'block');
    return added;
  }

  /** The block ghost: the whole block, drawn faint, and its footprint. */
  _blockGhost(e) {
    const placement = this._blockPlacement(e);
    if (!placement) return;
    const s = this.state;
    const w = this._blockWorld(placement);
    const mat = MATERIALS.ghost;
    const base = s.baseOffsetFt();
    const top = base + placement.plan.segments.reduce((a, b) => a + b, 0);
    const meshes = [];
    for (const p of w.standards) meshes.push(verticalTube(p.x, p.y, base, top, STANDARD_TUBE_OD_IN, mat));
    for (const l of w.ledgers) meshes.push(tubeBetween(l.a, l.b, 1.9, mat));
    for (const b of w.braces) meshes.push(tubeBetween(b.a, b.b, 1.69, mat));
    for (const d of w.decks) {
      for (const b of s.plankBoards({ id: 'ghost', ...d })) meshes.push(plankBoard(b.center, b.rotationZ, b.lengthFt, b.widthIn, mat));
    }
    if (this.blockSettings.guardrails) {
      for (const lift of placement.plan.deckLifts) {
        for (const z of [s.liftZ(lift + 1), s.liftZ(lift + 2)]) {
          w.corners.forEach((c, i) => {
            const d = w.corners[(i + 1) % w.corners.length];
            meshes.push(tubeBetween([c.x, c.y, z], [d.x, d.y, z], 1.69, mat));
          });
        }
      }
    }
    for (const m of instanceMeshes(meshes)) this.ghostGroup.add(m);
    // Footprint: blue, green once it has snapped onto the standards beside it.
    const outline = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(w.corners.map(c => new THREE.Vector3(c.x, c.y, 0.03))),
      placement.snapped ? BLOCK_OUTLINE_SNAPPED : BLOCK_OUTLINE,
    );
    outline.userData.ownsGeometry = true;
    this.ghostGroup.add(outline);
    const { plan } = placement;
    this.hooks.onPreview?.('block', w.standards.length, {
      snapped: placement.snapped,
      widthFt: plan.widthFt, depthFt: plan.depthFt,
      deckZ: plan.deckLifts.length ? s.liftZ(plan.deckLifts[plan.deckLifts.length - 1]) : null,
      levels: plan.deckLifts.length,
      rotation: placement.rotationSteps * 90,
    });
  }


  /**
   * True when a key pressed while a field has the focus is still meant for the
   * tool: the pointer is out on the canvas and the key is Shift, R, or Enter
   * with a SHIFT fill waiting. A dropdown in the tool's card keeps the focus
   * after it is used, and without this Shift then showed no preview until the
   * mouse moved (which carries the Shift state with it).
   */
  claimsKey(e) {
    if (!this._hoverAt) return false;
    return e.key === 'Shift' || e.key === 'r' || e.key === 'R' || (e.key === 'Enter' && !!this._pendingBatch);
  }

  _key(e) {
    const t = e.target;
    const inField = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    // Typing in a field is typing, unless the pointer says the key is for the canvas.
    const typing = inField && !this.claimsKey(e);
    // Shift for a capital letter in a field is typing, not a fill.
    if (e.key === 'Shift') { if (!typing && !e.repeat) this._setShift(true); return; }
    // R rotates, as in the source app; what it turns depends on the tool (see
    // rotate()). A held key does not keep turning.
    if ((e.key === 'r' || e.key === 'R') && !typing && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.rotate();
      return;
    }
    // Enter confirms a SHIFT batch preview without a second click, which is how
    // the source app commits a run.
    if (e.key === 'Enter' && this._pendingBatch && !typing) {
      e.preventDefault();
      const batch = this._pendingBatch;
      this._pendingBatch = null;
      const n = batch.apply();
      this.hooks.onBulkFill?.(typeof n === 'number' ? n : batch.count, batch.label);
      this._clearGhost();
      return;
    }
    if (e.key === 'Escape') { this.pending = null; this._pendingBatch = null; this._clearGhost(); }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selection.size) {
      const target = e.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      this.state.removeMany([...this.selection]);
      this.selection.clear();
      this.hooks.onSelectionChange?.([]);
    }
  }

  /**
   * R: turn whatever the active tool is about to place, as ScaffoldPro does,
   * and show it at once where the pointer already is:
   *   block    a quarter turn
   *   brace    ascending / descending
   *   bracket  the next free direction round the rosette
   *   plank    the boards run the other way across the hovered opening
   *   liveload the load spans across the boards instead of along them
   */
  rotate() {
    // Redraw first, then report: what R did is the news, not the usual hover hint.
    const done = (tool, value) => { this._refreshGhost(); this.hooks.onRotate?.(tool, value); return value; };
    if (this.tool === 'block') {
      this.rotationSteps = (this.rotationSteps + 1) % 4;
      return done('block', this.rotationSteps);
    }
    if (this.tool === 'brace') {
      this.braceDirection = this.braceDirection === 'ascending' ? 'descending' : 'ascending';
      return done('brace', this.braceDirection);
    }
    if (this.tool === 'bracket') {
      this.bracketTurn++;
      const node = this._hoverAt ? this._nearestNode(this._hoverAt) : null;
      const dir = node ? this._bracketDir(node) : null;
      return done('bracket', dir);
    }
    if (this.tool === 'plank') {
      // undefined: nothing hovered; null: the opening decks one way only.
      return done('plank', this._turnPlankRun());
    }
    if (this.tool === 'liveload') {
      // Across the boards or along them, until R again or the tool is picked again.
      this.liveLoadAcross = !this.liveLoadAcross;
      this._refreshGhost();
      const plan = this._hoverAt ? this._liveLoadPlan({ ...this._hoverAt, shiftKey: this.shiftHeld }) : null;
      // A hovered bay with ledgers on two sides only cannot take the turn.
      const value = { across: this.liveLoadAcross, oneWayOnly: !!plan && this.liveLoadAcross && !plan.items[0].across };
      this.hooks.onRotate?.('liveload', value);
      return value;
    }
    if (this.tool === 'truss') {
      // The next rosette this truss can reach from the hovered one.
      this.trussTurn++;
      const node = this._hoverAt ? this._nearestNode(this._hoverAt) : null;
      const span = node ? this._trussSpan(node) : null;
      return done('truss', span ? span.choices : null);
    }
    if (this.tool === 'ledger') {
      // Nothing to rotate; report so the UI can say so rather than go silent.
      this.hooks.onRotate?.(this.tool, null);
    }
    return null;
  }

  /** Side of a ledger to use: the one the cursor is on. */
  _sideFor(ledger, point) {
    const want = getLedgerSideSign(ledger, point);
    // A side with no opposite ledger has no bay, so nothing can go there. Rather
    // than silently doing nothing, fall back to the side that does have one.
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
    if (this.tool === 'select' || this.tool === 'erase') return;
    if (this.tool === 'beam') { this._legHoverGhost(e); return; }
    if (this.tool === 'block') { this._blockGhost(e); return; }
    // Live loads: ghost the patch and its span arrows on the hovered deck, or
    // on every deck of the platform with SHIFT.
    if (this.tool === 'liveload') {
      const plan = this._liveLoadPlan(e);
      if (!plan) {
        this.hooks.onPreview?.('liveload', 0, { miss: true, decks: this._deckIndex().decks.length });
        return;
      }
      const ghosts = [];
      for (const item of plan.changes) {
        const preview = buildDeckLoadPreview(item.deck, plan.psf, item.across);
        if (!preview) continue;
        ghosts.push(liveLoadPatch(preview.liveLoad, liveLoadGhostMaterial()));
        ghosts.push(...liveLoadArrows(preview.liveLoad, liveLoadGhostArrowMaterial()));
      }
      // A whole platform is a lot of arrows: drawn instanced, as the block ghost is.
      for (const m of instanceMeshes(ghosts)) this.ghostGroup.add(m);
      this._pendingBatch = e.shiftKey && plan.changes.length
        ? { count: plan.changes.length, label: 'live load', apply: () => this._applyLiveLoads(plan) }
        : null;
      const first = plan.items[0];
      this.hooks.onPreview?.('liveload', plan.changes.length, {
        psf: plan.psf, batch: e.shiftKey, across: first.across,
        // R asked for across, but this bay has nothing to carry it that way.
        oneWayOnly: this.liveLoadAcross && !first.across,
        changing: plan.changes.some(i => i.existing),
      });
      return;
    }
    // Decks: ghost the boards that would be laid in the hovered bay.
    if (this.tool === 'plank') {
      const hit = this._pickLedger(e);
      if (!hit) return;
      const side = this._sideFor(hit.ledger, hit.point);
      const ledgers = this.state.ledgerList();
      // Each bay decked the way R chose for this lift.
      const placements = e.shiftKey
        ? this._plankRunPlacements(hit.ledger, side)
        : [this._plankPlacementFor(hit.ledger, side)].filter(p => !this._isDecked(p));
      let crossed = false;
      for (const p of placements) {
        const preview = buildPlankPreviewForLedger(this.state.ledgers.get(p.ledgerId), ledgers, p.sideSign, []);
        if (!preview) continue;
        crossed ||= p.ledgerId !== hit.ledger.id;
        for (const b of preview.deck.boards) {
          this.ghostGroup.add(plankBoard(b.center, b.rotationZ, b.lengthFt, b.widthIn, MATERIALS.ghost));
        }
      }
      this._pendingBatch = e.shiftKey && placements.length
        ? { count: placements.length, label: 'deck', apply: () => this._batchFillPlanks(hit.ledger, side) }
        : null;
      this.hooks.onPreview?.('plank', placements.length, { batch: e.shiftKey, crossed });
      return;
    }
    // Braces: ghost the diagonal on the hovered face, or the whole perimeter run.
    if (this.tool === 'brace') {
      const plan = this.bracePreview(e, e.shiftKey);
      // Green, glowing and a full tube thick, so one diagonal reads against the
      // grid; a whole perimeter of them is drawn instanced.
      const braceMat = e.shiftKey ? MATERIALS.braceGhostRun : MATERIALS.braceGhost;
      for (const m of instanceMeshes(plan.map(t => tubeBetween(t.a, t.b, 1.9, braceMat)))) this.ghostGroup.add(m);
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
      this.hooks.onPreview?.('ledger', t ? 1 : 0, { batch: false, level: node.level });
      return;
    }
    if (this.tool === 'bracket') {
      const part = this.currentPart();
      const plan = part ? this._bracketPlan(node, e.shiftKey) : null;
      const ghosts = [];
      for (const b of plan ? plan.items : []) ghosts.push(...buildSideBracket(b.node, b.dir, part.lengthFt, mat));
      // A whole run of brackets is a lot of tubes: drawn instanced.
      for (const m of instanceMeshes(ghosts)) this.ghostGroup.add(m);
      this._pendingBatch = e.shiftKey && plan && plan.items.length
        ? { count: plan.items.length, label: 'bracket', apply: () => this._addBrackets(plan, part.lengthFt) }
        : null;
      this.hooks.onPreview?.('bracket', plan ? plan.items.length : 0, {
        dir: plan ? plan.dir : null, batch: e.shiftKey, walked: plan ? plan.walked : 0,
      });
      return;
    }
    if (this.tool === 'truss') {
      const span = this._trussSpan(node);
      const family = this._trussFamily();
      const spans = span ? (e.shiftKey ? this._trussFaceRun(span) : [span]) : [];
      const meshes = spans.flatMap(r => buildTruss(r.a, r.b, mat, family));
      for (const m of instanceMeshes(meshes)) this.ghostGroup.add(m);
      this._pendingBatch = e.shiftKey && spans.length
        ? { count: spans.length, label: 'truss', apply: () => this._batchFillTrusses(span) }
        : null;
      this.hooks.onPreview?.('truss', spans.length, { batch: e.shiftKey, family, choices: span ? span.choices : 0, lengthFt: this.currentPart()?.lengthFt });
    }
  }

  destroy() {
    for (const [t, fn] of this._bound) this.engine.renderer.domElement.removeEventListener(t, fn);
    window.removeEventListener('keydown', this._onKey);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    this.engine.scene.remove(this.ghostGroup);
    this._marqueeBox?.remove();
  }
}
