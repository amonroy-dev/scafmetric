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
import { buildStairFlight } from './parts.js';
import { findEnd, pullEnd } from './pull.js';
import { MATERIALS, verticalTube, tubeBetween, buildBaseAssembly, buildSideBracket, sideBracketWorldMembers, trussWorldMembers, buildTruss, plankBoard, liveLoadPatch, liveLoadGhostMaterial, liveLoadArrows, liveLoadGhostArrowMaterial, STANDARD_TUBE_OD_IN } from './parts.js';
import { legColumn } from './parts.js';
import { getPart, CATEGORY_TOOL, CATALOG } from './catalog.js';
import {
  findClosestUnoccupiedTarget, computeBatchPlan, planStandardSegmentsForHeight, liftFrame, planLiftOutline,
  planBlockRecipe, planStandardSegmentsForLift, rotateOffset90, snapBlockCenter, BLOCK_DEFAULTS,
  planStairTower, STAIR_DEFAULTS, BLOCK_SNAP_RADIUS_FT,
  BUILDING_DEFAULTS, planScaffoldRoundBuilding, snapToWall,
} from './planning.js';
import { hitData, instanceMeshes, clearGroup } from './instancing.js';
import {
  getLedgerSideSign, buildDeckLoadPreview, deckSpanIsSupported, connectedDecks, pickDeckWithRay,
  DEFAULT_BAY_LIVE_LOAD_PSF,
} from './liveloads.js';
import { buildSupportPair, collinearRun } from './supportspan.js';
import { buildPlankPreviewForLedger, crossPlankPlacement, plankRunAxis, sameRunAxis } from './planks.js';
import { ARM_PREFIX } from './state.js';
import {
  buildFaceGraph, framedFaces, facingOutward, faceKey, pickFace, faceBraceTarget, nodesByColumn, planPerimeterBraces,
  traceFraming, MIN_SPAN_FT, MAX_SPAN_FT,
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
// With "On side brackets" ticked, the Standard tool takes the bracket socket
// nearest the pointer within this reach on the screen, as ScaffoldPro's does.
const BRACKET_SEAT_SNAP_PX = 28;
// Truss fits, from ScaffoldPro: two degrees off a run still counts as along it
// (rosettes sit on a grid, so this only absorbs noise); an inch off its own
// length still fits (the frames do not stretch); 0.05 ft is the same lift.
const TRUSS_AXIS_TOL_RAD = (2 * Math.PI) / 180;
const TRUSS_SPAN_TOL_FT = 1 / 12;
const TRUSS_LEVEL_TOL_FT = 0.05;
// A deck rail is on a lift when it is this near the lift's rosettes, and runs
// past a rosette that is this near its line.
const RAIL_ON_LIFT_FT = 0.05;
// A leg stands where a bracket hangs when it is this near in plan.
const BRACKET_HOST_FT = 0.05;
// In toolbar order. Block comes straight after Select: most scaffolds start as one.
export const TOOLS = ['select', 'block', 'stair', 'standard', 'ledger', 'brace', 'truss', 'bracket', 'plank', 'liveload', 'building', 'erase'];
// A click this near the first corner of an outline being traced closes it.
const OUTLINE_CLOSE_FT = 1;
const OUTLINE_LINE = new THREE.LineBasicMaterial({ color: 0x2563eb });
// Pulling an end: its handle shows when the pointer is this near the end on
// the ground, and is taken hold of within this many pixels of it.
const PULL_NEAR_FT = 4;
const PULL_GRAB_PX = 22;
const PULL_REMOVE_LINE = new THREE.LineBasicMaterial({ color: 0xb91c1c });

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

/** True when a deck rail runs past both of these nodes: the bay edge between them has its member. */
function railRunsBetween(rail, a, b) {
  const dx = rail.b[0] - rail.a[0], dy = rail.b[1] - rail.a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return false;
  const ux = dx / len, uy = dy / len;
  for (const p of [a, b]) {
    const ex = p.x - rail.a[0], ey = p.y - rail.a[1];
    if (Math.abs(ey * ux - ex * uy) > RAIL_ON_LIFT_FT) return false;
    const along = ex * ux + ey * uy;
    if (along < -RAIL_ON_LIFT_FT || along > len + RAIL_ON_LIFT_FT) return false;
  }
  return true;
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
    // Standard tool: when set, a standard goes in a side bracket's socket and
    // nowhere else (the card's "On side brackets").
    this.standardsOnBrackets = false;
    // Ledger tool: when set, a ledger goes on an outside face and nowhere
    // else, and SHIFT runs them round the outside of the scaffold at that
    // level instead of through every bay of it (the card's "Perimeter
    // handrails", ScaffoldPro's ledger placement mode of the same name).
    this.perimeterHandrails = false;
    // Block tool: ScaffoldPro's block recipe (the block card edits it) and the
    // preview's quarter turns (R).
    this.blockSettings = { ...BLOCK_DEFAULTS };
    // Stair tool: the height of the tower's top landing (its card's one field).
    this.stairSettings = { ...STAIR_DEFAULTS };
    // Building tool: the height of the next building traced, how far off its
    // walls scaffold stands, and the corners clicked so far.
    this.buildingSettings = { ...BUILDING_DEFAULTS };
    this.outline = [];
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
    on('dblclick', e => this._selectChain(e));
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

  // --- pulling an end ---------------------------------------------------------------
  // In Select, a straight outside face shows a handle when the pointer comes
  // near it. Dragged out it adds whole bays, each a repeat of the last one;
  // dragged in it takes bays away (see pull.js).

  /** The end whose handle the pointer is near, or null. With `grab`, only when it is on the handle itself. */
  _endUnderPointer(e, grab = false) {
    if (this.tool !== 'select' || this.carry || this.groundHook || !this.state.ledgers.size) return null;
    this.engine.setPointerFromEvent(e);
    const g = this.engine.groundPoint();
    if (!g) return null;
    const faces = this._framing().faces;
    let best = null, bd = PULL_NEAR_FT;
    for (const f of faces) {
      if (!f.outside) continue;
      const out = (g.x - f.ax) * f.normX + (g.y - f.ay) * f.normY;
      const along = (g.x - f.ax) * f.dirX + (g.y - f.ay) * f.dirY;
      if (out < -0.75 || out > PULL_NEAR_FT) continue;
      const d = Math.hypot(Math.max(0, -along, along - f.spanFt), out);
      if (d < bd) { bd = d; best = f; }
    }
    const end = best ? findEnd(faces, best) : null;
    if (!end) return null;
    if (grab) {
      const { camera, renderer } = this.engine;
      const p = new THREE.Vector3(end.handle.x, end.handle.y, 0).project(camera);
      const r = renderer.domElement.getBoundingClientRect();
      const px = Math.hypot(((p.x + 1) / 2) * r.width - (e.clientX - r.left), ((1 - p.y) / 2) * r.height - (e.clientY - r.top));
      if (!(px <= PULL_GRAB_PX)) return null;
    }
    return end;
  }

  /** The handle on an end, and with a pull under way the bays it would add or take. */
  _pullGhost(end, bays = 0, held = false) {
    const mat = held ? MATERIALS.braceGhost : MATERIALS.ghost;
    const { n, t, origin, span, depthFt: L } = end;
    const at = (u, v, z = 0.12) => [origin.x + n.x * u + t.x * v, origin.y + n.y * u + t.y * v, z];
    const mid = (span[0] + span[1]) / 2, out = 1.5 + bays * L;
    // An arrow pointing each way along the pull.
    this.ghostGroup.add(tubeBetween(at(out - 0.9, mid), at(out + 0.9, mid), 3, mat));
    for (const s of [-1, 1]) for (const w of [-1, 1]) this.ghostGroup.add(tubeBetween(at(out + s * 0.9, mid), at(out + s * 0.45, mid + w * 0.45), 3, mat));
    for (let i = 1; i <= Math.abs(bays); i++) {
      const [u0, u1] = bays > 0 ? [(i - 1) * L, i * L] : [-i * L, -(i - 1) * L];
      const pts = [at(u0, span[0], 0.05), at(u1, span[0], 0.05), at(u1, span[1], 0.05), at(u0, span[1], 0.05)].map(p => new THREE.Vector3(...p));
      const box = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), bays > 0 ? OUTLINE_LINE : PULL_REMOVE_LINE);
      box.userData.ownsGeometry = true;
      this.ghostGroup.add(box);
    }
    this.hooks.onPreview?.('pull', bays, { depthFt: L, held });
  }

  /** Pull an end by whole bays (out is positive), as one undo step. Returns how many were done. */
  pullEndBy(end, bays) {
    const way = Math.sign(bays);
    if (!way) return 0;
    const mid = (end.span[0] + end.span[1]) / 2;
    let done = 0, at = end, u = 0;
    this.state.batch(() => {
      for (let i = 0; i < Math.abs(bays); i++) {
        if (!at || !pullEnd(this.state, at, way)) break;
        done++;
        u += at.depthFt * way;
        // The same end, where it stands now.
        const px = end.origin.x + end.n.x * u + end.t.x * mid, py = end.origin.y + end.n.y * u + end.t.y * mid;
        const faces = this._framing().faces;
        const face = faces.find(f => f.outside && f.normX * end.n.x + f.normY * end.n.y > 0.99
          && Math.abs((px - f.ax) * f.normX + (py - f.ay) * f.normY) < 0.3
          && (px - f.ax) * f.dirX + (py - f.ay) * f.dirY > -0.3 && (px - f.ax) * f.dirX + (py - f.ay) * f.dirY < f.spanFt + 0.3);
        at = face ? findEnd(faces, face) : null;
      }
    });
    return done * way;
  }

  // --- carrying a selection ------------------------------------------------------
  // Move and Copy pick the selection up: it follows the pointer as a ghost,
  // held by the standard that was nearest the pointer, R turns it a quarter
  // turn about that standard, and a click sets it down. Near another standard
  // it snaps onto it, as a block does, and what lands on parts already there
  // becomes one with them: that is how a chain is clicked onto another.

  /** Pick these parts up. False when there is no standard among them to hold them by. */
  beginCarry(ids, copy = false) {
    const s = this.state;
    const cols = ids.map(id => s.standards.get(id)).filter(c => c && s.isLeg(c));
    if (!cols.length) return false;
    this.setTool('select');
    let hold = cols[0];
    if (this._hoverAt) {
      this.engine.setPointerFromEvent(this._hoverAt);
      const g = this.engine.groundPoint();
      if (g) for (const c of cols) if (Math.hypot(c.x - g.x, c.y - g.y) < Math.hypot(hold.x - g.x, hold.y - g.y)) hold = c;
    }
    const has = new Set(ids);
    const lines = [];
    for (const map of [s.ledgers, s.trusses, s.braces, s.guardrails]) for (const m of map.values()) if (has.has(m.id)) lines.push({ a: m.a, b: m.b });
    this.carry = {
      ids: [...ids], copy, steps: 0, pivot: { x: hold.x, y: hold.y },
      cols: cols.map(c => ({ x: c.x, y: c.y, top: s.standardTopZ(c) })), lines,
    };
    this._refreshGhost();
    return true;
  }

  cancelCarry() {
    if (!this.carry) return;
    this.carry = null;
    this._clearGhost();
  }

  /** Where the carried parts would be set down with the pointer at `e`: { dx, dy, steps, pivot, snapped }. */
  _carryPlacement(e) {
    const c = this.carry;
    this.engine.setPointerFromEvent(e);
    const g = this.engine.groundPoint();
    if (!c || !g) return null;
    const turns = c.steps % 4;
    const turn = (x, y) => (turns === 1 ? [-y, x] : turns === 2 ? [-x, -y] : turns === 3 ? [y, -x] : [x, y]);
    let dx = this.state.snap(g.x) - c.pivot.x, dy = this.state.snap(g.y) - c.pivot.y;
    const at = p => { const [rx, ry] = turn(p.x - c.pivot.x, p.y - c.pivot.y); return { x: c.pivot.x + rx + dx, y: c.pivot.y + ry + dy }; };
    // Onto the nearest standard that is staying where it is.
    const carried = new Set(c.ids);
    let best = null;
    for (const other of this.state.standards.values()) {
      if (!c.copy && carried.has(other.id)) continue;
      for (const col of c.cols) {
        const p = at(col);
        const d = Math.hypot(other.x - p.x, other.y - p.y);
        if (d <= BLOCK_SNAP_RADIUS_FT && (!best || d < best.d)) best = { d, ox: other.x - p.x, oy: other.y - p.y };
      }
    }
    if (best) { dx += best.ox; dy += best.oy; }
    return { dx, dy, steps: c.steps, pivot: c.pivot, snapped: !!best, at };
  }

  _carryGhost(e) {
    const c = this.carry;
    const p = this._carryPlacement(e);
    if (!p) return;
    const mat = MATERIALS.ghost;
    const base = this.state.baseOffsetFt();
    const meshes = [];
    for (const col of c.cols) { const q = p.at(col); meshes.push(verticalTube(q.x, q.y, base, col.top, STANDARD_TUBE_OD_IN, mat)); }
    for (const l of c.lines) {
      const a = p.at({ x: l.a[0], y: l.a[1] }), b = p.at({ x: l.b[0], y: l.b[1] });
      meshes.push(tubeBetween([a.x, a.y, l.a[2]], [b.x, b.y, l.b[2]], 1.9, mat));
    }
    for (const m of instanceMeshes(meshes)) this.ghostGroup.add(m);
    this.hooks.onPreview?.('carry', c.ids.length, { copy: c.copy, snapped: p.snapped, rotation: (c.steps % 4) * 90, standards: c.cols.length });
  }

  /** Set the carried parts down where the pointer is. */
  _dropCarry(e) {
    const c = this.carry;
    const p = this._carryPlacement(e);
    if (!c || !p) return;
    this.carry = null;
    const ids = this.state.transformParts(c.ids, { dx: p.dx, dy: p.dy, steps: p.steps, pivot: p.pivot }, c.copy);
    this.selection = new Set(ids);
    this.hooks.onSelectionChange?.(ids);
    this.hooks.onCarried?.(c.cols.length, c.copy, p.snapped);
  }

  /** Double-click in Select: the whole chain the part under the pointer belongs to. */
  _selectChain(e) {
    if (this.tool !== 'select' || this.carry) return;
    this.engine.setPointerFromEvent(e);
    const ids = this._pickCandidates(e);
    if (!ids.length) return;
    const chain = this.state.chainOf([ids[0]]);
    this.selection = new Set(chain);
    this.hooks.onSelectionChange?.(chain);
    this.hooks.onChainSelected?.(chain);
  }

  // --- buildings -------------------------------------------------------------------
  // The Building tool traces an outline corner by corner on the ground. SHIFT
  // holds the next wall square to the last corner. A click back on the first
  // corner, or Enter, closes it into a building of the height in the card.

  /** The corner a click at `e` would add: on the grid, and with SHIFT square to the last one. */
  _outlinePoint(e) {
    const g = this._groundSnap(e);
    if (!g) return null;
    const last = this.outline[this.outline.length - 1];
    if (last && e.shiftKey) {
      if (Math.abs(g.x - last[0]) >= Math.abs(g.y - last[1])) g.y = last[1]; else g.x = last[0];
    }
    const first = this.outline[0];
    const closes = this.outline.length >= 3 && Math.hypot(g.x - first[0], g.y - first[1]) <= OUTLINE_CLOSE_FT;
    return { x: g.x, y: g.y, closes };
  }

  /** Close the outline traced so far into a building. */
  finishOutline() {
    if (this.outline.length < 3) return null;
    const b = this.state.addBuilding(this.outline, this.buildingSettings.heightFt);
    this.outline = [];
    this._clearGhost();
    if (b) this.hooks.onBuilding?.(b);
    return b;
  }

  _outlineGhost(e) {
    const p = this._outlinePoint(e);
    const pts = this.outline.map(q => new THREE.Vector3(q[0], q[1], 0.04));
    if (p) pts.push(p.closes ? pts[0].clone() : new THREE.Vector3(p.x, p.y, 0.04));
    if (pts.length >= 2) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), OUTLINE_LINE);
      line.userData.ownsGeometry = true;
      this.ghostGroup.add(line);
    }
    if (p) {
      const marker = new THREE.Mesh(MARKER_GEO, MATERIALS.ghost);
      marker.position.set(p.closes ? this.outline[0][0] : p.x, p.closes ? this.outline[0][1] : p.y, 0.1);
      this.ghostGroup.add(marker);
    }
    const last = this.outline[this.outline.length - 1];
    this.hooks.onPreview?.('building', this.outline.length, {
      closes: !!(p && p.closes),
      lengthFt: p && last ? Math.hypot(p.x - last[0], p.y - last[1]) : 0,
    });
  }

  /**
   * Scaffold round a building: blocks of the Block card's recipe, as deep as
   * it says and decked under the building's height, off its walls by the
   * distance in the Building card. One undo step. Returns { blocks, skipped }.
   */
  scaffoldRoundBuilding(buildingId) {
    const b = this.state.buildings.get(buildingId);
    if (!b) return null;
    const s = this.state;
    const plan = planScaffoldRoundBuilding(b.points, { offsetFt: this.buildingSettings.wallDistanceFt, depthFt: this.blockSettings.depthFt });
    const ctx = {
      liftZ: lift => s.liftZ(lift), showBaseCollar: s.base.showBaseCollar,
      standardLengthsFt: CATALOG.standards.parts.map(p => p.lengthFt), ledgerLengthsFt: CATALOG.ledgers.parts.map(p => p.lengthFt),
    };
    // The face that looks at the wall is left open: no rails within the
    // stand-off of this building's walls, now or when a later block re-lays them.
    b.openWithinFt = Math.max(0, Number(this.buildingSettings.wallDistanceFt) || 0) + 0.25;
    const heard = this.hooks.onBulkFill;
    this.hooks.onBulkFill = null; // one message for the lot, not one a block
    try {
      s.batch(() => {
        for (const k of plan.blocks) {
          const recipe = { ...this.blockSettings, widthFt: k.widthFt, depthFt: k.depthFt, heightFt: b.heightFt };
          this.placeBlockAt({ plan: planBlockRecipe(recipe, ctx), center: k.center, snapped: false, rotationSteps: k.rotationSteps });
        }
      });
    } finally { this.hooks.onBulkFill = heard; }
    return { blocks: plan.blocks.length, skipped: plan.skipped };
  }

  setTool(name) {
    this.carry = null;
    this.outline = [];
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
   * Nodes grouped by lift, each lift's grid frame, the ledgers already placed
   * and the deck rails on each lift, cached until the model changes. Colouring
   * the nodes for the Ledger tool asks for every node's target; recomputing
   * these per node made a rebuild with that tool active cost 220 ms on a
   * 40-standard job.
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
    // The rails a block lays round a deck are on the rosettes of the two lifts
    // above it, one line down each side however many bays it passes. Each is
    // already the member on those bay edges: a ledger there would be a second
    // tube in the same place, counted and weighed twice.
    const rails = new Map();
    for (const g of this.state.guardrails.values()) {
      if (g.kind !== 'rail' || Math.abs(g.a[2] - g.b[2]) > RAIL_ON_LIFT_FT) continue;
      const level = this.state.liftAt(g.a[2]);
      if (Math.abs(this.state.liftZ(level) - g.a[2]) > RAIL_ON_LIFT_FT) continue;
      let list = rails.get(level);
      if (!list) rails.set(level, list = []);
      list.push(g);
    }
    this._liftCache = { version, byLevel, ledgerKeys, rails, frames: new Map(), outlines: new Map(), links: null };
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
    // A press on an end's handle starts a pull, not a selection box.
    const end = this._endUnderPointer(e, true);
    if (end) {
      this.engine.setPointerFromEvent(e);
      const g = this.engine.groundPoint();
      this.pull = { end, bays: 0, from: { x: g.x, y: g.y } };
      this._marquee = null;
      return;
    }
    // A left-drag draws a selection box in any tool and any view; a click
    // without a drag still belongs to the tool.
    this._marquee = { startClientX: e.clientX, startClientY: e.clientY, currentClientX: e.clientX, currentClientY: e.clientY };
  }

  _onMove(e) {
    if (this._down) this._down.moved = Math.max(Math.abs(e.clientX - this._down.x), Math.abs(e.clientY - this._down.y));
    if (this.pull) {
      if (!(e.buttons & 1)) { this.pull = null; } else {
        this.engine.setPointerFromEvent(e);
        const g = this.engine.groundPoint();
        const { end, from } = this.pull;
        if (g) this.pull.bays = Math.max(-30, Math.min(60, Math.round(((g.x - from.x) * end.n.x + (g.y - from.y) * end.n.y) / end.depthFt)));
        this._clearGhost();
        this._pullGhost(end, this.pull.bays, true);
        this.engine.invalidate?.();
        return;
      }
    }
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
    if (this.pull) {
      const { end, bays } = this.pull;
      this.pull = null;
      this._clearGhost();
      const done = bays ? this.pullEndBy(end, bays) : 0;
      this.hooks.onPulled?.(done, bays, end.depthFt);
      this._updateGhost(e);
      return;
    }
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

  /**
   * Each standard as the screen tests it: its whole height, so a box or a click
   * on any of it counts. A leg runs from the ground, one seated in a side
   * bracket from its socket. `legsOnly` leaves the seated ones out.
   */
  _standardSegments(legsOnly = false) {
    const s = this.state;
    const out = [];
    for (const c of s.standards.values()) {
      const leg = s.isLeg(c);
      if (legsOnly && !leg) continue;
      out.push({ id: c.id, a: [c.x, c.y, leg ? 0 : s.standardBaseZ(c)], b: [c.x, c.y, s.standardTopZ(c)] });
    }
    return out;
  }

  /** A box dragged with Send to beam open: the legs in it, and nothing else. */
  _finishLegMarquee(m, modifiers) {
    const { rect, mode, projector } = this._marqueeGeometry(m);
    const ids = marqueeHits(projector, rect, mode, { segments: this._standardSegments(true), outlines: [] });
    this.hooks.onLegBox?.(ids, modifiers);
  }

  _act(e) {
    const s = this.state;
    if (this.carry) { this._dropCarry(e); return; }
    // A click wanted by something outside the tools (setting a drawing to
    // scale): the point on the ground exactly as clicked, not on the grid.
    if (this.groundHook) {
      this.engine.setPointerFromEvent(e);
      const g = this.engine.groundPoint();
      if (g && this.groundHook({ x: g.x, y: g.y })) return;
    }
    if (this.tool === 'building') {
      const p = this._outlinePoint(e);
      if (!p) return;
      if (p.closes) this.finishOutline(); else this.outline.push([p.x, p.y]);
      return;
    }
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
    if (this.tool === 'standard' && this.standardsOnBrackets) {
      const plan = this._bracketStandardPlan(e);
      if (!plan || !plan.seats.length) return;
      const n = this._addBracketStandards(plan);
      if (e.shiftKey) this.hooks.onBulkFill?.(n, 'bracket standard');
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
    if (this.tool === 'block' || this.tool === 'stair') {
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
      if (e.shiftKey) { this._batchFillLedgers(node.level, node); return; }
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
    return crossPlankPlacement(ledger, this.state.supportList(), side) || natural;
  }

  /** True when this placement's opening already has a deck, either way round. */
  _isDecked(placement) {
    const ledger = this.state.supportById(placement.ledgerId);
    if (!ledger) return true;
    const pair = buildSupportPair(ledger, this.state.supportList(), placement.sideSign);
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
    const currentLedger = this.state.supportById(current.ledgerId);
    const cross = crossPlankPlacement(currentLedger, this.state.supportList(), current.sideSign);
    if (!cross) return null;
    const axis = plankRunAxis(this.state.supportById(cross.ledgerId));
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
      const tagged = id ? this.state.standards.get(id) : null;
      if (tagged && this.state.isLeg(tagged)) return id;
    }
    const bounds = renderer.domElement.getBoundingClientRect();
    const ray = raycaster.ray;
    const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), onRay = new THREE.Vector3(), onSeg = new THREE.Vector3();
    let best = null;
    // Legs only: a standard seated in a side bracket is carried by another leg.
    for (const seg of this._standardSegments(true)) {
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
      this.ghostGroup.add(legColumn(c.x, c.y, 0, this.state.standardTopZ(c), LEG_HOVER_OD_IN, MATERIALS.legHover));
    }
    this._setCursor(c ? 'pointer' : '');
    this.hooks.onPreview?.('beam', c ? 1 : 0, { id: c ? id : null });
  }

  _nodesAtLevel(level) { return this._lifts().byLevel.get(level) || []; }

  /** True when the bay edge between two nodes of a lift has its member: a ledger, a side bracket's arm, or a deck rail. */
  _ledgerExists(a, b) {
    const lifts = this._lifts();
    if (lifts.ledgerKeys.has(segmentKey([a.x, a.y, a.z], [b.x, b.y, b.z]))) return true;
    const rails = lifts.rails.get(a.level);
    return !!rails && rails.some(g => railRunsBetween(g, a, b));
  }

  /**
   * Nearest unoccupied adjacent node at the same lift. With "Perimeter
   * handrails", the nearest one along an outside face.
   */
  ledgerTargetFor(node) {
    if (this.perimeterHandrails) return this._handrailTargetFor(node);
    const lifts = this._lifts();
    const nodes = lifts.byLevel.get(node.level) || [];
    let frame = lifts.frames.get(node.level);
    if (frame === undefined) lifts.frames.set(node.level, frame = liftFrame(nodes));
    return findClosestUnoccupiedTarget(node, nodes, c => !this._ledgerExists(node, c), frame);
  }

  // --- perimeter handrails ----------------------------------------------------
  // With "Perimeter handrails" ticked the Ledger tool works on the outside of
  // the scaffold only, as ScaffoldPro's does: a click adds the one ledger along
  // an outside face from the rosette under it, and SHIFT adds every one that is
  // missing round the outside of that scaffold at that level. Bay edges inside
  // it are left alone: a ledger at rail height across a deck is in the way.

  setPerimeterHandrails(on) {
    this.perimeterHandrails = !!on;
    this._clearGhost();
    this._pendingBatch = null;
    this._refreshGhost();
  }

  /** The side bracket a node is carried by (its bare tip, or a standard seated in it), or null for a leg's rosette. */
  _bracketUnder(node) {
    if (node.bracketId) return this.state.brackets.get(node.bracketId) || null;
    const c = this.state.standards.get(node.columnId);
    return c ? this.state.standardBracket(c) : null;
  }

  /**
   * Whether two neighbouring nodes of a lift are the two ends of a bay edge,
   * for telling the outside of the scaffold from the inside of it.
   *
   * Between two legs this is the Brace tool's rule (framedFaces): a ledger or
   * truss joins them at some lift, or one of them has none on it yet and
   * standing next to each other is all there is to go on. Without it two runs
   * a few feet apart close bays across the open air between them, and the
   * faces looking onto that gap read as inside.
   *
   * A standard seated in a side bracket (or a bracket's bare tip) is joined to
   * the leg its bracket hangs on by the bracket, and to its neighbours along
   * the row of brackets by nothing until this tool has been there: both count.
   */
  _isBayEdge(a, b) {
    const lifts = this._lifts();
    if (!lifts.links) lifts.links = this._standardLinks(this._legs());
    const { joined, framed } = lifts.links;
    const underA = this._bracketUnder(a), underB = this._bracketUnder(b);
    if (underA && underB) return true;
    if (!underA && !underB) return joined(a.columnId, b.columnId) || !framed(a.columnId) || !framed(b.columnId);
    const leg = underA ? b : a, k = underA || underB;
    return (Math.abs(leg.x - k.x) < BRACKET_HOST_FT && Math.abs(leg.y - k.y) < BRACKET_HOST_FT) || !framed(leg.columnId);
  }

  /** A lift's bay edges, which are outside, and which scaffold each node is part of; kept until the model changes. */
  _outline(level) {
    const lifts = this._lifts();
    let outline = lifts.outlines.get(level);
    if (outline) return outline;
    const nodes = lifts.byLevel.get(level) || [];
    let frame = lifts.frames.get(level);
    if (frame === undefined) lifts.frames.set(level, frame = liftFrame(nodes));
    outline = planLiftOutline(nodes, frame, (a, b) => this._isBayEdge(a, b));
    // A side the traced outline has a bay on both hands of is inside, whatever
    // the squares say: they miss a bay with a standard part-way along a side.
    // (The trace knows the legs only, so it cannot call a side outside: a row
    // of bracket standards may stand beyond it.)
    const traced = this._framing();
    for (const e of outline.edges) {
      const side = traced.byKey.get(faceKey(e.a.columnId, e.b.columnId));
      if (side && !side.outside) outline.outside.delete(e.key);
    }
    lifts.outlines.set(level, outline);
    return outline;
  }

  /** True when this node is on the outside of the scaffold at its lift. */
  isOutsideNode(node) {
    const outline = this._outline(node.level);
    return (outline.byColumn.get(node.columnId) || []).some(e => outline.outside.has(e.key));
  }

  /** The node the nearest open outside edge from this one runs to, or null. */
  _handrailTargetFor(node) {
    const outline = this._outline(node.level);
    let best = null, bestFt = Infinity;
    for (const e of outline.byColumn.get(node.columnId) || []) {
      if (!outline.outside.has(e.key) || e.lengthFt >= bestFt || this._ledgerExists(e.a, e.b)) continue;
      best = e.a.columnId === node.columnId ? e.b : e.a;
      bestFt = e.lengthFt;
    }
    return best;
  }

  /** Every open edge round the outside of the scaffold this node is part of, at its lift: [{ a, b }]. */
  _handrailPlan(node) {
    const outline = this._outline(node.level);
    const group = outline.group.get(node.columnId);
    if (group === undefined) return [];
    return outline.edges.filter(e => outline.outside.has(e.key) && outline.group.get(e.a.columnId) === group && !this._ledgerExists(e.a, e.b));
  }

  /**
   * What SHIFT adds from a node: a ledger on every open bay edge at its level,
   * or with "Perimeter handrails" only round the outside of its scaffold.
   */
  _ledgerFillPlan(node) {
    if (this.perimeterHandrails) return this._handrailPlan(node);
    return computeBatchPlan(this._nodesAtLevel(node.level), (a, b) => !this._ledgerExists(a, b));
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

  // --- standards on side brackets -------------------------------------------
  // With "On side brackets" ticked the Standard tool stands its standard in a
  // side bracket's socket and nowhere else: the free socket nearest the
  // pointer, as ScaffoldPro snaps to it, or with SHIFT every one along that
  // row of brackets. The standard's height comes from the bracket (see
  // ScaffoldState.bracketSeat), so its rosettes land on the scaffold's lifts.

  setStandardsOnBrackets(on) {
    this.standardsOnBrackets = !!on;
    this._clearGhost();
    this._pendingBatch = null;
    this._refreshGhost();
  }

  /**
   * The segments to stand from a height: the size chosen in the card, or with
   * a height to build to, the stack that brings the top level with a standard
   * built to that height from the ground.
   */
  standardStackPlanFrom(baseZ) {
    const target = Number(this.standardTargetHeightFt) || 0;
    if (target > 0) {
      const lengths = CATALOG.standards.parts.map(p => p.lengthFt);
      const remaining = target - (baseZ - this.state.baseOffsetFt());
      if (remaining >= Math.min(...lengths) - 1e-6) {
        const plan = planStandardSegmentsForHeight(remaining, lengths);
        if (plan.length) return plan;
      }
    }
    const part = this.currentPart();
    return part ? [part.lengthFt] : [];
  }

  /** The bracket socket a click here would use: a seat (ScaffoldState.bracketSeat), or null. */
  _bracketSeatUnderPointer(e) {
    const { camera, renderer } = this.engine;
    const bounds = renderer.domElement.getBoundingClientRect();
    const p = new THREE.Vector3();
    let best = null, bestPx = Infinity, bestZ = Infinity;
    for (const k of this.state.brackets.values()) {
      const seat = this.state.bracketSeat(k.id);
      if (!seat || seat.blocked) continue;
      // Aimed at the socket itself, where the standard's foot goes.
      p.set(seat.x, seat.y, k.z).project(camera);
      if (p.z < -1 || p.z > 1) continue;
      const px = Math.hypot(((p.x + 1) / 2) * bounds.width - (e.clientX - bounds.left), ((1 - p.y) / 2) * bounds.height - (e.clientY - bounds.top));
      if (px > BRACKET_SEAT_SNAP_PX) continue;
      // Seen from above, brackets one over another are one point on the
      // screen: the lowest is the one a standard starts from.
      const nearer = px < bestPx - 0.5;
      const sameSpotLower = Math.abs(px - bestPx) <= 0.5 && k.z < bestZ;
      if (nearer || sameSpotLower) { bestPx = px; bestZ = k.z; best = seat; }
    }
    return best;
  }

  /**
   * What a click would stand: { seats, row }. One standard in the socket under
   * the pointer, or with SHIFT one in every socket along that row of brackets
   * that is in the same state as the hovered one: free sockets get a standard,
   * or, hovering one that has a standard already, each standard in the row
   * gets another segment. `row` is how many brackets the row has.
   */
  _bracketStandardPlan(e) {
    const seat = this._bracketSeatUnderPointer(e);
    if (!seat) return null;
    if (!e.shiftKey) return { seats: [seat], row: 1 };
    const row = this.state.bracketRow(seat.bracketId);
    const seats = [];
    const spots = new Set();
    for (const k of row) {
      const s = this.state.bracketSeat(k.id);
      if (!s || s.blocked || !!s.standard !== !!seat.standard) continue;
      const spot = `${Math.round(s.x * 1000)},${Math.round(s.y * 1000)}`;
      if (spots.has(spot)) continue;
      spots.add(spot);
      seats.push(s);
    }
    return { seats, row: row.length };
  }

  /** Stand the standards of a plan, as one edit. Returns how many sockets were used. */
  _addBracketStandards(plan) {
    return this.state.batch(() => {
      let n = 0;
      for (const seat of plan.seats) {
        let stood = false;
        for (const len of this.standardStackPlanFrom(seat.z)) {
          if (this.state.addStandardOnBracket(seat.bracketId, len)) stood = true;
        }
        if (stood) n++;
      }
      return n;
    });
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
    // The scaffold's own faces are between its legs. A standard seated in a
    // side bracket is outside it, and is given faces of its own below.
    const standards = this._legs();
    // Sides of the scaffold as it is framed (a ledger between the two
    // standards, where there are ledgers), each outside one facing out.
    // Where there are ledgers the faces are the sides traced along them, each
    // knowing whether it is outside. Standards with none on them yet have only
    // where they stand to go on.
    const traced = this._framing();
    const loose = facingOutward(framedFaces(buildFaceGraph(standards), this._standardLinks(standards)))
      .filter(f => !traced.framed.has(f.columnIdA) || !traced.framed.has(f.columnIdB));
    const faces = [...traced.faces.filter(f => f.spanFt >= MIN_SPAN_FT && f.spanFt <= MAX_SPAN_FT), ...loose];
    if (this.state.brackets.size) {
      const nodes = this.state.nodes();
      const byColumn = nodesByColumn(nodes);
      const centroid = footprintCentroid(standards);
      // Along a row of brackets: between the tips, or the standards seated in
      // them, wherever a brace can climb.
      const tips = new Map();
      for (const n of nodes) if (n.bracketId && !tips.has(n.columnId)) tips.set(n.columnId, { id: n.columnId, x: n.x, y: n.y, dir: n.dir });
      faces.push(...bracketTipFaces([...tips.values()], byColumn, centroid));
      // And the short face from a seated standard back to the standard its
      // bracket hangs on, so the two can be braced together.
      const at = new Map([...this.state.standards.values()].map(c => [`${Math.round(c.x * 100)},${Math.round(c.y * 100)}`, c]));
      for (const c of this.state.standards.values()) {
        const k = this.state.standardBracket(c);
        const host = k ? at.get(`${Math.round(k.x * 100)},${Math.round(k.y * 100)}`) : null;
        if (!host) continue;
        for (const f of buildFaceGraph([host, c], centroid)) {
          if (faceBraceTarget(f, byColumn, 0, 'ascending') || faceBraceTarget(f, byColumn, 0, 'descending')) faces.push({ ...f, bracketEnd: true });
        }
      }
    }
    this._faceCache = { version, faces };
    return faces;
  }

  /** The standards that stand on the ground. */
  _legs() {
    return [...this.state.standards.values()].filter(c => this.state.isLeg(c));
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
    // And the two halves of a ledger that passes a standard part-way along it.
    for (const f of this._framing().faces) pairs.add(faceKey(f.columnIdA, f.columnIdB));
    return { joined: (a, b) => pairs.has(faceKey(a, b)), framed: id => framed.has(id) };
  }

  /** The scaffold's outline traced along its ledgers and trusses (traceFraming), kept until the model changes. */
  _framing() {
    const version = this.state.version;
    if (this._framingCache && this._framingCache.version === version) return this._framingCache.traced;
    const traced = traceFraming(this._legs(), [...this.state.ledgers.values(), ...this.state.trusses.values()]);
    traced.byKey = new Map(traced.faces.map(f => [faceKey(f.columnIdA, f.columnIdB), f]));
    this._framingCache = { version, traced };
    return traced;
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
    const standards = this._legs();
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
      standards: this._legs(),
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
    const supports = this.state.supportList();
    // Along the connected run of ledgers; or, from a side bracket, along its
    // row of brackets, each arm decked across to the next.
    const run = ledger.bracketId
      ? this.state.bracketRow(ledger.bracketId).map(k => this.state.supportById(`${ARM_PREFIX}${k.id}`)).filter(Boolean)
      : collinearRun(ledger, this.state.ledgerList());
    const seen = new Set();
    const out = [];
    for (const member of run) {
      const preview = buildPlankPreviewForLedger(member, supports, sideSign, []);
      if (!preview) continue;
      const runLedger = this.state.supportById(preview.placement.ledgerId);
      const p = this._plankPlacementFor(runLedger, preview.placement.sideSign);
      const key = `${p.ledgerId}:${p.sideSign}`;
      if (seen.has(key) || this._isDecked(p)) continue;
      seen.add(key);
      out.push(p);
    }
    return out;
  }

  /**
   * SHIFT: lay the fill. Started from a node it is what the card asks for
   * (_ledgerFillPlan); given a level alone it is every bay of that level.
   */
  _batchFillLedgers(level, from = null) {
    const plan = from
      ? this._ledgerFillPlan(from)
      : computeBatchPlan(this._nodesAtLevel(level), (a, b) => !this._ledgerExists(a, b));
    this.state.batch(() => {
      for (const { a, b } of plan) this.state.addLedger([a.x, a.y, a.z], [b.x, b.y, b.z]);
    });
    this.hooks.onBulkFill?.(plan.length, from && this.perimeterHandrails ? 'handrail' : 'ledger');
    return plan.length;
  }

  /** Nearest ledger under the pointer, with the world point that was hit. */
  _pickLedger(e) {
    this.engine.setPointerFromEvent(e);
    this.engine.raycaster.setFromCamera(this.engine.pointer, this.engine.camera);
    const ray = this.engine.raycaster.ray;
    const hits = this.engine.raycaster.intersectObjects(this.hooks.getContentMeshes?.() || [], false);
    for (const h of hits) {
      const d = hitData(h);
      if (d.kind !== 'ledger' && d.kind !== 'line' && d.kind !== 'bracket') continue;
      // A side bracket is picked by any part of it: boards bear on its arm.
      const ledger = this.state.ledgers.get(d.id) || this.state.supportById(`${ARM_PREFIX}${d.id}`);
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
    // What a deck bears on: the ledgers, and the arms of the side brackets.
    this._deckCache = { version, decks, ledgers: this.state.supportList(), loads: this.state.liveLoadsByDeck(decks) };
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
    // The Stair tool places a stair tower the way the Block tool places a block.
    if (this.tool === 'stair') {
      return planStairTower(this.stairSettings, {
        liftZ: lift => s.liftZ(lift),
        showBaseCollar: s.base.showBaseCollar,
        standardLengthsFt: CATALOG.standards.parts.map(p => p.lengthFt),
      });
    }
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
    const c = snapBlockCenter(g, plan, this.rotationSteps, this._legs());
    // With no standards to join, it stands off the wall it is beside.
    if (!c.snapped && this.state.buildings.size) {
      const turned = this.rotationSteps % 2 === 1;
      const wall = snapToWall(c, turned ? plan.depthFt : plan.widthFt, turned ? plan.widthFt : plan.depthFt, [...this.state.buildings.values()], this.buildingSettings.wallDistanceFt);
      if (wall) return { plan, center: wall, snapped: false, onWall: true, rotationSteps: this.rotationSteps };
    }
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
    const flights = (plan.flights || []).map(f => ({
      lower: f.lower.map(o => { const p = at(o); return [p.x, p.y]; }),
      upper: f.upper.map(o => { const p = at(o); return [p.x, p.y]; }),
      z0: s.liftZ(f.lift), z1: s.liftZ(f.toLift), treads: f.treads,
    }));
    return {
      standards: plan.standards.map(at),
      ledgers: plan.ledgers.map(l => ({ a: xyz(l.a, l.lift), b: xyz(l.b, l.lift) })),
      braces, decks, corners, flights,
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
        s.addPlank([d.x0, d.y0, d.z], [d.x1, d.y1, d.z], { stair: !!plan.stair });
      }
      for (const f of w.flights) {
        const there = [...s.stairs.values()].some(e => Math.abs(e.z0 - f.z0) < 0.05 && Math.hypot(e.lower[0][0] - f.lower[0][0], e.lower[0][1] - f.lower[0][1]) < 0.05
          && Math.hypot(e.lower[1][0] - f.lower[1][0], e.lower[1][1] - f.lower[1][1]) < 0.05);
        if (!there) s.addStairFlight(f);
      }
      // Rails round each planked level, on the two rosettes above the deck. A
      // stair tower's rails are among its ledgers, open where the flights are.
      if (!plan.stair && this.blockSettings.guardrails) {
        for (const lift of plan.deckLifts) s.setDeckGuardrails(s.liftZ(lift), [s.liftZ(lift + 1), s.liftZ(lift + 2)]);
      }
    });
    this.hooks.onBulkFill?.(plan.stair ? plan.flightCount : added, plan.stair ? 'stair' : 'block');
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
    for (const f of w.flights) meshes.push(...buildStairFlight(f, mat));
    if (!placement.plan.stair && this.blockSettings.guardrails) {
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
    this.hooks.onPreview?.(plan.stair ? 'stair' : 'block', w.standards.length, {
      flights: plan.flightCount, onWall: !!placement.onWall,
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
    if (e.key === 'Enter' && this.tool === 'building' && this.outline.length >= 3 && !typing) { e.preventDefault(); this.finishOutline(); return; }
    if (e.key === 'Escape') { this.pending = null; this._pendingBatch = null; this.outline = []; this._clearGhost(); }
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
    if (this.carry) {
      this.carry.steps = (this.carry.steps + 1) % 4;
      return done('carry', this.carry.steps);
    }
    if (this.tool === 'block' || this.tool === 'stair') {
      this.rotationSteps = (this.rotationSteps + 1) % 4;
      return done(this.tool, this.rotationSteps);
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
    const ledgers = this.state.supportList();
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
    if (this.carry) { this._carryGhost(e); return; }
    if (this.tool === 'building') { this._outlineGhost(e); return; }
    if (this.tool === 'select') {
      const end = this._endUnderPointer(e);
      if (end) this._pullGhost(end, 0, !!this._endUnderPointer(e, true));
      this._setCursor(end && this._endUnderPointer(e, true) ? 'grab' : '');
      return;
    }
    if (this.tool === 'erase') return;
    if (this.tool === 'beam') { this._legHoverGhost(e); return; }
    if (this.tool === 'block' || this.tool === 'stair') { this._blockGhost(e); return; }
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
      const ledgers = this.state.supportList();
      // Each bay decked the way R chose for this lift.
      const placements = e.shiftKey
        ? this._plankRunPlacements(hit.ledger, side)
        : [this._plankPlacementFor(hit.ledger, side)].filter(p => !this._isDecked(p));
      let crossed = false;
      for (const p of placements) {
        const preview = buildPlankPreviewForLedger(this.state.supportById(p.ledgerId), ledgers, p.sideSign, []);
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
    // On side brackets: the standard a click would stand in the socket under
    // the pointer, or with SHIFT in every socket along the row.
    if (this.tool === 'standard' && this.standardsOnBrackets) {
      const plan = this._bracketStandardPlan(e);
      const ghosts = [];
      let totalFt = 0;
      for (const seat of plan ? plan.seats : []) {
        let z = seat.z;
        for (const len of this.standardStackPlanFrom(seat.z)) {
          ghosts.push(verticalTube(seat.x, seat.y, z, z + len, STANDARD_TUBE_OD_IN, mat));
          z += len;
        }
        totalFt = z - seat.z;
      }
      for (const m of instanceMeshes(ghosts)) this.ghostGroup.add(m);
      const count = plan ? plan.seats.length : 0;
      this._pendingBatch = e.shiftKey && count
        ? { count, label: 'bracket standard', apply: () => this._addBracketStandards(plan) }
        : null;
      this.hooks.onPreview?.('standard', count, {
        onBrackets: true, batch: e.shiftKey, row: plan ? plan.row : 0, totalFt,
        adding: !!(plan && plan.seats[0] && plan.seats[0].standard), brackets: this.state.brackets.size,
      });
      return;
    }
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
      const handrails = this.perimeterHandrails;
      if (e.shiftKey) {
        const plan = this._ledgerFillPlan(node);
        for (const { a, b } of plan) this.ghostGroup.add(tubeBetween([a.x, a.y, a.z], [b.x, b.y, b.z], 1.9, mat));
        this._pendingBatch = plan.length
          ? { count: plan.length, label: handrails ? 'handrail' : 'ledger', apply: () => this._batchFillLedgers(node.level, node) }
          : null;
        this.hooks.onPreview?.('ledger', plan.length, { batch: true, level: node.level, handrails });
        return;
      }
      this._pendingBatch = null;
      const t = this.ledgerTargetFor(node);
      if (t) this.ghostGroup.add(tubeBetween([node.x, node.y, node.z], [t.x, t.y, t.z], 1.9, mat));
      this.hooks.onPreview?.('ledger', t ? 1 : 0, {
        batch: false, level: node.level, handrails, outside: handrails ? this.isOutsideNode(node) : null,
      });
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
