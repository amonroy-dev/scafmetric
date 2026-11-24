// Interactive scaffold state: placed standards (stacks of catalog segments),
// ledgers, braces and planks, the derived connection nodes, and the per-leg
// dead/live load takeoff. Pure data + math (no three.js) so it is unit-testable.

import { tubeWeightPerFoot, resolveComponents } from '../catalog.js';
import { getStandardBaseOffsetFt, inchesToFeet, buildBestFitPlankLayout, PLANK } from './parts.js';
import { planGuardrails, deckRectsByHeight, computeRectUnionBoundarySegments } from './guardrails.js';
import { trussMemberLengthFt, sideBracketTubeLengthFt, sideBracketTip, sideBracketCentroidOutFt } from './parts.js';
import {
  buildLiveLoadInstances, resolveLiveLoadPlacement, forEachLiveLoadMemberLoad, forEachStripMemberLoad,
  distributeLedgerPointLoad, liveLoadsByDeck, DEFAULT_BAY_LIVE_LOAD_PSF,
} from './liveloads.js';
import { screwJackWeightLb, woodSillWeightLb, baseCollarWeightLb } from './bom.js';
import { buildPlankDecks, resolvePlankPlacement, plankSeatOffsetFt, deckFrameFromRect, rectDeckRunsAlongX } from './planks.js';

// Real connection spacing on a standard (kept even though rosette hardware is
// not drawn), so ledger heights land where they actually would.
export const FIRST_NODE_OFFSET_IN = 15.75;
export const NODE_SPACING_IN = 19.6875;

// How near a rail's line a standard must stand to be one the rail runs past.
const RAIL_ON_LINE_FT = 0.05;

// A standard set in a side bracket's socket seats this far above the rosette
// the bracket hangs on. That puts its own first rosette exactly one spacing
// up, on the next lift of the scaffold beside it, and every rosette above on
// a lift too. As ScaffoldPro seats one: its socket shoulder is 3.925 in above
// the bracket's rosette and its tip rosette 0.0125 in below it, and the two
// together are this.
export const BRACKET_SEAT_UP_IN = NODE_SPACING_IN - FIRST_NODE_OFFSET_IN;
// The longest plank is ten feet, so two bracket arms further apart than this
// are not the two ends of one deck (ScaffoldPro's limit).
export const MAX_BRACKET_DECK_SPAN_FT = 10.5;
// Brackets in one row: at one lift, facing one way, tips in one line.
const ROW_SAME_LIFT_FT = 1 / 12;
const ROW_SAME_HEADING_COS = 0.999;
const ROW_SAME_LINE_FT = 2 / 12;
// A deck that bears on a bracket's arm names it by the bracket, with this in front.
export const ARM_PREFIX = 'arm:';
// A bracket's leverage is taken against the leg a ledger runs back to from the
// leg it hangs on: back within this of dead opposite the bracket (about ten
// degrees), and far enough away to be another leg.
const LEVER_BACK_COS = 0.985;
const LEVER_MIN_ARM_FT = 0.5;
// A brace stands a couple of inches off its face, so its end is near a
// standard or a bracket's tip, not on it: within this it is taken to be on it.
const NEAR_COLUMN_FT = 0.6;
// Against overturning, the dead load that holds a scaffold down has to be this
// many times what tries to turn it over. It is not the 4 of a scaffold's
// strength: docs/scaffold-overturning.md has where each number comes from.
export const OVERTURNING_FACTOR = 1.5;

const key = (x, y) => `${round(x)},${round(y)}`;
function round(v, d = 3) { const f = 10 ** d; return Math.round(v * f) / f; }

export class ScaffoldState {
  constructor(opts = {}) {
    this.snapStep = opts.snapStep ?? 1;
    this.components = resolveComponents(opts.components);
    this.base = {
      jackExtensionIn: opts.jackExtensionIn ?? 6,
      showWoodSill: opts.showWoodSill ?? true,
      showBaseCollar: opts.showBaseCollar ?? true,
    };
    // id -> { id, x, y, segments:[lengthFt] }, standing on the ground; with a
    // bracketId as well, standing in that side bracket's socket instead.
    this.standards = new Map();
    this.ledgers = new Map();   // id -> { id, a:[x,y,z], b:[x,y,z] }
    this.braces = new Map();    // id -> { id, a:[x,y,z], b:[x,y,z] }
    this.planks = new Map();    // id -> { id, x0,y0,x1,y1,z }  (rect decks, e.g. from the block tool)
    // Ledger-anchored decks, as the source app places them: a supporting ledger
    // plus the side the boards run to. Resolved against the ledgers on read.
    this.plankPlacements = new Map(); // id -> { id, ledgerId, sideSign }
    this.brackets = new Map();  // id -> { id, x, y, z, dir:[dx,dy], lengthFt }
    this.trusses = new Map();   // id -> { id, a:[x,y,z], b:[x,y,z] }
    this.guardrails = new Map();// id -> { id, a:[x,y,z], b:[x,y,z], kind }
    // A live load sits on a deck: id -> { id, deckId, psf, across }. Models
    // saved before that hold ledger-anchored patches, { id, ledgerId, sideSign, psf }.
    // These are ALL the live load there is: a deck carries none of its own, so
    // a bay nobody loaded with the Live load tool is unloaded.
    this.liveLoads = new Map();
    this._seq = 0;
    this._history = [];
    this._future = [];
    // Bumped on every change, inside a batch too, so derived data can be cached
    // against it and never go stale mid-run.
    this.version = 0;
    this._batchDepth = 0;
    this._batchPushed = false;
    this._batchDirty = false;
    this.onChange = opts.onChange || (() => {});
  }

  /**
   * Run several edits as one: one undo step and one change notification.
   *
   * A Shift-fill used to add its members one at a time, and every add pushed a
   * full snapshot onto the history and rebuilt the whole scene. Filling a 66-bay
   * level was 66 rebuilds (most of a second, several with the Ledger tool
   * active) and 66 undo steps, which also pushed the user's earlier work off
   * the 100-step history. Nested batches fold into the outermost one.
   */
  batch(fn) {
    if (this._batchDepth === 0) { this._batchPushed = false; this._batchDirty = false; }
    this._batchDepth++;
    try {
      return fn();
    } finally {
      this._batchDepth--;
      if (this._batchDepth === 0 && this._batchDirty) {
        this._batchDirty = false;
        this.onChange();
      }
    }
  }

  _id(p) { return `${p}${++this._seq}`; }

  // --- undo / redo ---------------------------------------------------------
  snapshot() {
    return JSON.stringify({
      standards: [...this.standards], ledgers: [...this.ledgers],
      braces: [...this.braces], planks: [...this.planks], brackets: [...this.brackets],
      trusses: [...this.trusses], guardrails: [...this.guardrails],
      liveLoads: [...this.liveLoads],
      plankPlacements: [...this.plankPlacements],
      seq: this._seq, base: { ...this.base },
    });
  }
  restore(json) {
    const d = JSON.parse(json);
    this.standards = new Map(d.standards);
    this.ledgers = new Map(d.ledgers);
    this.braces = new Map(d.braces);
    this.planks = new Map(d.planks);
    this.brackets = new Map(d.brackets || []);
    this.trusses = new Map(d.trusses || []);
    this.guardrails = new Map(d.guardrails || []);
    this.liveLoads = new Map(d.liveLoads || []);
    this.plankPlacements = new Map(d.plankPlacements || []);
    // Older saves also carry a liveLoadMode ('uniform' put a blanket load on
    // every deck). There is no blanket any more, so it is not read.
    this._seq = d.seq;
    Object.assign(this.base, d.base);
    this._emit();
  }
  _pushHistory() {
    // Inside a batch only the state before its first edit is worth keeping.
    if (this._batchDepth > 0) {
      if (this._batchPushed) return;
      this._batchPushed = true;
    }
    this._history.push(this.snapshot());
    if (this._history.length > 100) this._history.shift();
    this._future.length = 0;
  }
  resetHistory() { this._history.length = 0; this._future.length = 0; }
  canUndo() { return this._history.length > 0; }
  canRedo() { return this._future.length > 0; }
  undo() {
    if (!this._history.length) return false;
    this._future.push(this.snapshot());
    this.restore(this._history.pop());
    return true;
  }
  redo() {
    if (!this._future.length) return false;
    this._history.push(this.snapshot());
    this.restore(this._future.pop());
    return true;
  }
  snap(v) { const s = this.snapStep; return s > 0 ? Math.round(v / s) * s : v; }
  _emit() {
    this.version++;
    if (this._batchDepth > 0) { this._batchDirty = true; return; }
    this.onChange();
  }

  // Bottom of the standard tube, above the base assembly.
  baseOffsetFt() {
    return getStandardBaseOffsetFt(this.base.jackExtensionIn, this.base.showWoodSill, this.base.showBaseCollar);
  }
  setBase(patch) { this._pushHistory(); Object.assign(this.base, patch); this._emit(); }

  standardHeightFt(s) { return s.segments.reduce((a, b) => a + b, 0); }
  /** The side bracket a standard stands in, or null for one that stands on the ground. */
  standardBracket(s) { return s.bracketId ? this.brackets.get(s.bracketId) || null : null; }
  /**
   * True for a standard that stands on the ground, which is what a leg is. One
   * set in a side bracket is carried by the bracket, and so by the leg the
   * bracket hangs on: it has no base, no load tag, and is not sent to a beam.
   */
  isLeg(s) { return !this.standardBracket(s); }
  /** Bottom of a standard's tube: above its base assembly, or seated in its bracket. */
  standardBaseZ(s) {
    const k = this.standardBracket(s);
    return k ? k.z + inchesToFeet(BRACKET_SEAT_UP_IN) : this.baseOffsetFt();
  }
  standardTopZ(s) { return this.standardBaseZ(s) + this.standardHeightFt(s); }

  // --- placement -----------------------------------------------------------
  /**
   * Add a segment at (x, y), on top of any standard already there. `exact`
   * skips the grid snap, for the Block tool, whose bays need not land on it.
   */
  addStandard(x, y, lengthFt, { exact = false } = {}) { this._pushHistory();
    const fix = v => Math.round(v * 1e6) / 1e6;
    const sx = exact ? fix(x) : this.snap(x), sy = exact ? fix(y) : this.snap(y);
    const existing = this.standardAt(sx, sy);
    if (existing) { existing.segments.push(lengthFt); this._emit(); return existing; }
    const s = { id: this._id('S'), x: sx, y: sy, segments: [lengthFt] };
    this.standards.set(s.id, s);
    this._emit();
    return s;
  }
  standardAt(x, y) {
    const k = key(x, y);
    for (const s of this.standards.values()) if (key(s.x, s.y) === k) return s;
    return null;
  }
  popSegment(id) {
    const s = this.standards.get(id);
    if (!s) return;
    this._pushHistory();
    if (s.segments.length <= 1) this.standards.delete(id);
    else s.segments.pop();
    this._emit();
  }

  // --- standards on side brackets -----------------------------------------
  // A side bracket ends in a rosette with a socket over it, and a standard can
  // be stood in the socket: the outer row of a wider platform, a guardrail
  // post. As in ScaffoldPro, it has no base assembly and takes its height from
  // the bracket.

  /**
   * Where a standard would seat in this bracket: { bracketId, x, y, z,
   * standard, blocked }.
   *
   *   standard  the one already standing at that spot, from this bracket or
   *             from one below it: another segment goes on top of it
   *   blocked   true when the spot is taken by something this socket cannot
   *             add to: a standard up from the ground, or one seated in a
   *             bracket higher up
   *   z         where the new tube's bottom would be
   */
  bracketSeat(bracketId) {
    const k = this.brackets.get(bracketId);
    if (!k) return null;
    const [x, y] = sideBracketTip(k, k.dir, k.lengthFt);
    const seatZ = k.z + inchesToFeet(BRACKET_SEAT_UP_IN);
    const there = this.standardAt(x, y);
    if (!there) return { bracketId, x, y, z: seatZ, standard: null, blocked: false };
    const under = this.standardBracket(there);
    if (!under || under.z > k.z + 1e-6) return { bracketId, x, y, z: seatZ, standard: null, blocked: true };
    return { bracketId, x, y, z: this.standardTopZ(there), standard: there, blocked: false };
  }

  /**
   * Stand a standard in a side bracket's socket, or put another segment on the
   * one already standing there. Returns the standard, or null when the socket
   * cannot take one (see bracketSeat).
   */
  addStandardOnBracket(bracketId, lengthFt) {
    const seat = this.bracketSeat(bracketId);
    if (!seat || seat.blocked) return null;
    this._pushHistory();
    if (seat.standard) { seat.standard.segments.push(lengthFt); this._emit(); return seat.standard; }
    const s = { id: this._id('S'), x: seat.x, y: seat.y, segments: [lengthFt], bracketId };
    this.standards.set(s.id, s);
    this._emit();
    return s;
  }

  /**
   * The row a side bracket is in: every bracket at its lift that faces the
   * same way with its tip in the same line, in order along the face. It is
   * what SHIFT takes with the Standard tool, and the run a deck is laid along.
   */
  bracketRow(bracketId) {
    const k = this.brackets.get(bracketId);
    if (!k) return [];
    const len = Math.hypot(k.dir[0], k.dir[1]) || 1;
    const ox = k.dir[0] / len, oy = k.dir[1] / len;
    const tipOut = b => { const [x, y] = sideBracketTip(b, b.dir, b.lengthFt); return x * ox + y * oy; };
    const along = b => b.y * ox - b.x * oy;
    const line = tipOut(k);
    return [...this.brackets.values()]
      .filter(b => {
        if (Math.abs(b.z - k.z) > ROW_SAME_LIFT_FT) return false;
        const bl = Math.hypot(b.dir[0], b.dir[1]) || 1;
        if ((b.dir[0] * ox + b.dir[1] * oy) / bl < ROW_SAME_HEADING_COS) return false;
        return Math.abs(tipOut(b) - line) <= ROW_SAME_LINE_FT;
      })
      .sort((p, q) => along(p) - along(q));
  }

  addLedger(a, b) { this._pushHistory(); const l = { id: this._id('L'), a: [...a], b: [...b] }; this.ledgers.set(l.id, l); this._emit(); return l; }
  addBrace(a, b) { this._pushHistory(); const v = { id: this._id('B'), a: [...a], b: [...b] }; this.braces.set(v.id, v); this._emit(); return v; }
  /** A truss between two rosettes at one lift. family: 'light' | 'heavy' | 'truss'. */
  addTruss(a, b, family = 'truss') {
    this._pushHistory();
    const t = { id: this._id('T'), a: [...a], b: [...b], family };
    this.trusses.set(t.id, t); this._emit(); return t;
  }

  /** Generate rails and posts around every decked area. Replaces existing ones. */
  generateGuardrails(opts = {}) {
    this._pushHistory();
    this.guardrails.clear();
    for (const [z, rects] of deckRectsByHeight(this)) {
      const { rails, posts } = planGuardrails(rects, z, opts);
      for (const r of rails) {
        const g = { id: this._id('G'), a: r.a, b: r.b, kind: 'rail' };
        this.guardrails.set(g.id, g);
      }
      for (const p of posts) {
        const g = { id: this._id('G'), a: [p.x, p.y, p.z0], b: [p.x, p.y, p.z1], kind: 'post' };
        this.guardrails.set(g.id, g);
      }
    }
    this._emit();
    return this.guardrails.size;
  }
  /**
   * Rails round the decked area at one deck height, as a block lays them: on
   * the rosettes one and two lifts above the deck, along the outside edge of
   * every deck at that height taken together. Replaces the rails a block laid
   * there before, so two blocks side by side share one perimeter and get no
   * rail down the face between them.
   */
  setDeckGuardrails(deckZ, railHeights) {
    this._pushHistory();
    const tag = Math.round(deckZ * 1000);
    for (const [id, g] of [...this.guardrails]) if (g.deckTag === tag) this.guardrails.delete(id);
    const rects = deckRectsByHeight(this).get(Math.round(deckZ * 1000) / 1000) || [];
    let n = 0;
    for (const s of computeRectUnionBoundarySegments(rects)) {
      for (const z of railHeights) {
        const [a, b] = s.kind === 'H' ? [[s.x0, s.y, z], [s.x1, s.y, z]] : [[s.x, s.y0, z], [s.x, s.y1, z]];
        const g = { id: this._id('G'), a, b, kind: 'rail', deckTag: tag };
        this.guardrails.set(g.id, g);
        n++;
      }
    }
    this._emit();
    return n;
  }

  clearGuardrails() { this._pushHistory(); this.guardrails.clear(); this._emit(); }

  /**
   * The guardrails as the tubes they really are: [{ id, kind, a, b, lengthFt }].
   *
   * A rail round a deck is drawn as one line along each edge, however many
   * bays that edge runs past, but it is built as one tube between each pair of
   * standards. Weighing the line as a single 21 ft tube put half of it on each
   * end leg and none on the legs between, and listed a part nobody makes. The
   * parts list and the leg loads both read rails from here.
   */
  guardrailPieces() {
    const cols = [...this.standards.values()];
    const out = [];
    for (const g of this.guardrails.values()) {
      const dx = g.b[0] - g.a[0], dy = g.b[1] - g.a[1], dz = g.b[2] - g.a[2];
      const plan = Math.hypot(dx, dy);
      const whole = { id: g.id, kind: g.kind, a: g.a, b: g.b, lengthFt: Math.hypot(dx, dy, dz) };
      // A post stands on one spot; so does anything with no run in plan.
      if (g.kind === 'post' || plan < 1e-6) { out.push(whole); continue; }
      const ux = dx / plan, uy = dy / plan;
      const stops = [0, plan];
      for (const s of cols) {
        const ex = s.x - g.a[0], ey = s.y - g.a[1];
        const t = ex * ux + ey * uy;
        if (Math.abs(ey * ux - ex * uy) <= RAIL_ON_LINE_FT && t > RAIL_ON_LINE_FT && t < plan - RAIL_ON_LINE_FT) stops.push(t);
      }
      stops.sort((p, q) => p - q);
      const at = t => [g.a[0] + ux * t, g.a[1] + uy * t, g.a[2] + dz * (t / plan)];
      for (let i = 0; i < stops.length - 1; i++) {
        if (stops[i + 1] - stops[i] < RAIL_ON_LINE_FT) continue; // two standards on one spot
        const a = at(stops[i]), b = at(stops[i + 1]);
        out.push({ id: g.id, kind: g.kind, a, b, lengthFt: Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) });
      }
    }
    return out;
  }

  /** What stands under every standard: its screw jack, and the collar and sill when they are on. */
  baseHardwareLb() {
    return screwJackWeightLb(this.base.jackExtensionIn)
      + (this.base.showWoodSill ? woodSillWeightLb() : 0)
      + (this.base.showBaseCollar ? baseCollarWeightLb() : 0);
  }

  // --- per-bay live loads --------------------------------------------------
  // A load is placed on a decked bay and spans one way: along the boards, or
  // across them (see liveloads.js). The bay is read from the deck each time.

  ledgerList() { return [...this.ledgers.values()]; }

  // --- what a deck can bear on ---------------------------------------------
  // Boards on side brackets sit straight on the brackets' arms, two arms
  // carrying a deck between them as two ledgers would; no ledger is run from
  // tip to tip first. So each arm is offered to the deck code as a span of its
  // own, as ScaffoldPro does (its bracketPlankSupports.ts). These are for
  // finding and carrying decks only: an arm is never a ledger in the parts
  // list, and never drawn as one.

  /** Each side bracket's arm, from the rosette it hangs on to its tip, shaped as a ledger is. */
  bracketArms() {
    return [...this.brackets.values()].map(k => {
      const [x, y] = sideBracketTip(k, k.dir, k.lengthFt);
      return { id: `${ARM_PREFIX}${k.id}`, a: [k.x, k.y, k.z], b: [x, y, k.z], bracketId: k.id, maxSpanFt: MAX_BRACKET_DECK_SPAN_FT };
    });
  }

  _supports() {
    if (!this._supportCache || this._supportCache.version !== this.version) {
      const list = [...this.ledgers.values(), ...this.bracketArms()];
      this._supportCache = { version: this.version, list, byId: new Map(list.map(m => [m.id, m])) };
    }
    return this._supportCache;
  }
  /** Everything a deck can bear on: the ledgers, and the arms of the side brackets. */
  supportList() { return this._supports().list; }
  /** A ledger, or a bracket's arm, by the id a deck names it by. */
  supportById(id) { return this._supports().byId.get(id) || null; }

  /** Which load sits on each deck: Map of deckId to placement. */
  liveLoadsByDeck(decks = this.plankBays()) {
    return liveLoadsByDeck([...this.liveLoads.values()], this.supportList(), decks);
  }

  /**
   * Put a live load on each of these decked bays, or change the one already
   * there: items are { deckId, psf, across }. One undo step for the lot.
   * Returns the loads placed or changed; a bay already loaded that way, or one
   * with no deck, is left alone.
   */
  setDeckLiveLoads(items) {
    const decks = this.plankBays();
    const byDeck = this.liveLoadsByDeck(decks);
    const plan = [];
    for (const item of items) {
      if (!decks.some(d => d.id === item.deckId)) continue; // a load needs a deck to sit on
      const psf = Math.max(0, Number(item.psf ?? DEFAULT_BAY_LIVE_LOAD_PSF) || 0);
      const across = !!item.across;
      const existing = byDeck.get(item.deckId) || null;
      if (existing && existing.deckId === item.deckId && existing.psf === psf && !!existing.across === across) continue;
      plan.push({ deckId: item.deckId, psf, across, existing });
    }
    if (!plan.length) return [];
    this._pushHistory();
    const out = [];
    for (const { deckId, psf, across, existing } of plan) {
      if (existing && existing.deckId === deckId) {
        existing.psf = psf;
        existing.across = across;
        out.push(existing);
        continue;
      }
      // An older ledger-anchored patch over this bay is replaced, not doubled.
      if (existing) this.liveLoads.delete(existing.id);
      const ll = { id: this._id('LL'), deckId, psf, across };
      this.liveLoads.set(ll.id, ll);
      out.push(ll);
    }
    this._emit();
    return out;
  }

  /** One decked bay: see setDeckLiveLoads. Returns the load, or null. */
  setDeckLiveLoad(deckId, psf = DEFAULT_BAY_LIVE_LOAD_PSF, across = false) {
    return this.setDeckLiveLoads([{ deckId, psf, across }])[0] || null;
  }

  /** Turn a load on a deck to span along the boards (false) or across them. */
  setLiveLoadAcross(id, across) {
    const ll = this.liveLoads.get(id);
    if (!ll || !ll.deckId || !!ll.across === !!across) return false;
    this._pushHistory();
    ll.across = !!across;
    this._emit();
    return true;
  }

  /**
   * Add a ledger-anchored patch to one side of a ledger: how loads were placed
   * before they sat on decks. Kept for models and callers that still use it.
   */
  addLiveLoad(ledgerId, sideSign, psf = DEFAULT_BAY_LIVE_LOAD_PSF) {
    if (!this.ledgers.has(ledgerId)) return null;
    const side = sideSign >= 0 ? 1 : -1;
    for (const ll of this.liveLoads.values()) {
      if (ll.ledgerId === ledgerId && ll.sideSign === side) return null; // already loaded
    }
    const magnitude = Math.max(0, Number(psf) || 0);
    const probe = { id: 'probe', ledgerId, sideSign: side, psf: magnitude };
    if (!resolveLiveLoadPlacement(probe, this.ledgerList())) return null; // no bay on that side
    this._pushHistory();
    const ll = { id: this._id('LL'), ledgerId, sideSign: side, psf: magnitude };
    this.liveLoads.set(ll.id, ll);
    this._emit();
    return ll;
  }

  setLiveLoadPsf(id, psf) {
    const ll = this.liveLoads.get(id);
    if (!ll) return false;
    this._pushHistory();
    ll.psf = Math.max(0, Number(psf) || 0);
    this._emit();
    return true;
  }

  /** Take every live load off the model. */
  clearLiveLoads() {
    if (!this.liveLoads.size) return;
    this._pushHistory();
    this.liveLoads.clear();
    this._emit();
  }

  /** Drop loads whose deck is gone, and older patches whose ledger is gone. */
  _pruneOrphanLiveLoads() {
    let dropped = 0;
    for (const [id, ll] of [...this.liveLoads]) {
      const kept = ll.deckId
        ? this.planks.has(ll.deckId) || this.plankPlacements.has(ll.deckId)
        : this.ledgers.has(ll.ledgerId);
      if (!kept) { this.liveLoads.delete(id); dropped++; }
    }
    return dropped;
  }

  /** Drawable patches for the placements that still resolve to a bay. */
  liveLoadPatches() {
    const placements = [...this.liveLoads.values()];
    // Decks are only worth resolving when a load sits on one.
    const decks = placements.some(p => p.deckId) ? this.plankBays() : [];
    return buildLiveLoadInstances(placements, this.supportList(), decks);
  }

  // --- ledger-anchored decks ----------------------------------------------
  // As in the source app: a deck is anchored to a supporting ledger and a side,
  // and the boards span to the opposite ledger of that bay.

  /** Deck the bay on one side of a ledger. Returns the placement, or null. */
  addPlankOnLedger(ledgerId, sideSign) {
    // A ledger, or a side bracket's arm (see supportList).
    if (!this.supportById(ledgerId)) return null;
    const side = sideSign >= 0 ? 1 : -1;
    for (const p of this.plankPlacements.values()) {
      if (p.ledgerId === ledgerId && p.sideSign === side) return null; // already decked
    }
    const probe = { id: 'probe', ledgerId, sideSign: side };
    if (!resolvePlankPlacement(probe, this.supportList())) return null; // no bay on that side
    this._pushHistory();
    const p = { id: this._id('D'), ledgerId, sideSign: side };
    this.plankPlacements.set(p.id, p);
    this._emit();
    return p;
  }

  /**
   * Every deck in the model as a footprint rectangle plus its boards, from both
   * the ledger-anchored placements and the rectangle decks the block tool lays.
   * This is the single accessor the renderer, BOM, guardrails and takeoff use.
   */
  plankBays() {
    const out = buildPlankDecks([...this.plankPlacements.values()], this.supportList());
    for (const p of this.planks.values()) {
      out.push({
        id: p.id,
        x0: p.x0, x1: p.x1, y0: p.y0, y1: p.y1, z: p.z,
        boards: this.plankBoards(p),
        frame: deckFrameFromRect(p),
        widthFt: Math.abs(p.x1 - p.x0),
        lengthFt: Math.abs(p.y1 - p.y0),
        areaSqFt: Math.abs(p.x1 - p.x0) * Math.abs(p.y1 - p.y0),
      });
    }
    return out;
  }

  /** Drop placements whose anchor ledger is gone. */
  _pruneOrphans() {
    // A standard goes with the bracket it stood in.
    for (const [id, s] of [...this.standards]) {
      if (s.bracketId && !this.brackets.has(s.bracketId)) this.standards.delete(id);
    }
    // A deck goes with the ledger, or the bracket arm, it was hung on. Asked
    // of the parts themselves: this runs before the change is announced, when
    // the list of supports kept for the last version still has the old one.
    const stillThere = id => this.ledgers.has(id)
      || (typeof id === 'string' && id.startsWith(ARM_PREFIX) && this.brackets.has(id.slice(ARM_PREFIX.length)));
    for (const [id, p] of [...this.plankPlacements]) {
      if (!stillThere(p.ledgerId)) this.plankPlacements.delete(id);
    }
    // After the decks, so a load goes with the deck it sat on.
    this._pruneOrphanLiveLoads();
  }

  /** Move or copy whole standard stacks by a delta. Returns the new/moved ids. */
  transformStacks(ids, dx, dy, copy = false) {
    this._pushHistory();
    const out = [];
    for (const id of ids) {
      const st = this.standards.get(id);
      // One standing in a bracket stays with its bracket.
      if (!st || st.bracketId) continue;
      if (copy) {
        const n = { id: this._id('S'), x: this.snap(st.x + dx), y: this.snap(st.y + dy), segments: st.segments.slice() };
        this.standards.set(n.id, n);
        out.push(n.id);
      } else {
        st.x = this.snap(st.x + dx);
        st.y = this.snap(st.y + dy);
        out.push(st.id);
      }
    }
    this._emit();
    return out;
  }

  addBracket(node, dir, lengthFt) {
    this._pushHistory();
    const b = { id: this._id('K'), x: node.x, y: node.y, z: node.z, dir: [dir[0], dir[1]], lengthFt };
    this.brackets.set(b.id, b); this._emit(); return b;
  }
  addPlank(a, b) { this._pushHistory();
    const p = {
      id: this._id('P'),
      x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]),
      x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]),
      z: Math.min(a[2], b[2]),
    };
    this.planks.set(p.id, p); this._emit(); return p;
  }

  remove(id) { this._pushHistory();
    for (const m of [this.standards, this.ledgers, this.braces, this.planks, this.brackets, this.trusses, this.guardrails, this.liveLoads, this.plankPlacements]) {
      if (m.delete(id)) { this._pruneOrphans(); this._emit(); return true; }
    }
    return false;
  }
  removeMany(ids) { this._pushHistory();
    let n = 0;
    for (const id of ids) {
      for (const m of [this.standards, this.ledgers, this.braces, this.planks, this.brackets, this.trusses, this.guardrails, this.liveLoads, this.plankPlacements]) {
        if (m.delete(id)) { n++; break; }
      }
    }
    if (n) { this._pruneOrphans(); this._emit(); }
    return n;
  }
  clear() { this._pushHistory(); this.standards.clear(); this.ledgers.clear(); this.braces.clear(); this.planks.clear(); this.brackets.clear(); this.trusses.clear(); this.guardrails.clear(); this.liveLoads.clear(); this.plankPlacements.clear(); this._emit(); }

  /**
   * Every connection node, numbered by lift as ScaffoldPro numbers them:
   *
   *   lift 0   the base collar's rosette, one spacing below the standard's
   *            first, present only while the collar is shown
   *   lift 1+  the rosettes up the standard, from 15.75 in above its base
   *
   * plus the rosette at the tip of each side bracket, at the lift of the
   * rosette the bracket hangs on. Tips stacked at one spot share a column, so
   * a brace can climb between them.
   */
  nodes() {
    const out = [];
    // Standards seated in brackets, by where they stand, and the lifts each
    // has a rosette of its own at.
    const seated = new Map();
    const seatedLifts = new Set();
    for (const s of this.standards.values()) {
      const top = this.standardTopZ(s);
      const under = this.standardBracket(s);
      if (under) {
        seated.set(key(s.x, s.y), s);
        // Its rosettes start one lift above the bracket's, on the lifts of the
        // scaffold beside it.
        for (let level = this.liftAt(under.z) + 1; this.liftZ(level) <= top + 1e-6; level++) {
          out.push({ x: s.x, y: s.y, z: this.liftZ(level), level, columnId: s.id });
          seatedLifts.add(`${s.id}@${level}`);
        }
        continue;
      }
      if (this.base.showBaseCollar) out.push({ x: s.x, y: s.y, z: this.liftZ(0), level: 0, columnId: s.id });
      for (let level = 1; this.liftZ(level) <= top + 1e-6; level++) {
        out.push({ x: s.x, y: s.y, z: this.liftZ(level), level, columnId: s.id });
      }
    }
    for (const k of this.brackets.values()) {
      const tip = this.bracketTipNode(k);
      const s = seated.get(key(tip.x, tip.y));
      if (s) {
        // A tip the standard has grown up past is one of the standard's own
        // rosettes already. Any other tip there, the one it stands in first of
        // all, is a rosette of the same column, so a brace can run from it.
        if (seatedLifts.has(`${s.id}@${tip.level}`)) continue;
        tip.columnId = s.id;
      }
      out.push(tip);
    }
    return out;
  }

  /** The lift a height sits at on the standards (the collar's is 0). */
  liftAt(z) {
    const base = this.baseOffsetFt();
    return Math.round((z - base - inchesToFeet(FIRST_NODE_OFFSET_IN)) / inchesToFeet(NODE_SPACING_IN)) + 1;
  }

  /** The height of a lift's rosettes: one formula, so every user agrees exactly. */
  liftZ(lift) {
    return this.baseOffsetFt() + inchesToFeet(FIRST_NODE_OFFSET_IN) + (lift - 1) * inchesToFeet(NODE_SPACING_IN);
  }

  /** How many rosettes a standard carries (its top lift). */
  standardLifts(s) {
    const tubeIn = this.standardHeightFt(s) * 12;
    return tubeIn + 1e-6 < FIRST_NODE_OFFSET_IN ? 0 : Math.floor((tubeIn - FIRST_NODE_OFFSET_IN) / NODE_SPACING_IN + 1e-6) + 1;
  }

  /** The rosette at a side bracket's tip, as a connection node. */
  bracketTipNode(k) {
    const [x, y, z] = sideBracketTip(k, k.dir, k.lengthFt);
    return { x, y, z, level: this.liftAt(k.z), columnId: `tip:${key(x, y)}`, bracketId: k.id, dir: [...k.dir] };
  }

  /**
   * Individual plank boards filling a bay, using the best-fit 9 in / 6 in packing
   * from the source app. Boards run along the longer side of the bay and are laid
   * side by side across the shorter side.
   */
  plankBoards(p) {
    const w = Math.abs(p.x1 - p.x0);
    const d = Math.abs(p.y1 - p.y0);
    if (w < 1e-6 || d < 1e-6) return [];
    const cx = (p.x0 + p.x1) / 2, cy = (p.y0 + p.y1) / 2;
    const runAlongX = rectDeckRunsAlongX(p);
    const lengthFt = runAlongX ? w : d;
    const crossSpanIn = (runAlongX ? d : w) * 12;
    const slots = buildBestFitPlankLayout(crossSpanIn);
    // Flush with the top of the ledgers, the same seat a ledger-hung deck uses.
    // (It used to sit a full half-depth above the ledger centreline, which left
    // a block's deck standing more than an inch proud of its ledgers.)
    const z = p.z + plankSeatOffsetFt();
    return slots.map((slot, i) => ({
      id: `${p.id}b${i}`,
      bayId: p.id,
      widthIn: slot.widthIn,
      lengthFt,
      rotationZ: runAlongX ? Math.PI / 2 : 0,
      center: runAlongX ? [cx, cy + slot.centerOffsetFt, z] : [cx + slot.centerOffsetFt, cy, z],
    }));
  }

  // Geometry description for the scene builder (plain data, no three.js).
  geometry() {
    // `leg` is false for a standard seated in a side bracket: it has no base.
    const standards = [...this.standards.values()].map(s => ({
      id: s.id, x: s.x, y: s.y, baseZ: this.standardBaseZ(s), topZ: this.standardTopZ(s), segments: s.segments.slice(), leg: this.isLeg(s),
    }));
    const bases = [...this.standards.values()].filter(s => this.isLeg(s)).map(s => ({ id: s.id, x: s.x, y: s.y }));
    const ledgers = [...this.ledgers.values()].map(l => ({ id: l.id, a: l.a, b: l.b }));
    const braces = [...this.braces.values()].map(b => ({ id: b.id, a: b.a, b: b.b }));
    const planks = this.plankBays();
    const brackets = [...this.brackets.values()].map(b => ({ ...b }));
    const trusses = [...this.trusses.values()].map(t => ({ ...t }));
    const guardrails = [...this.guardrails.values()].map(g => ({ ...g }));
    const liveLoads = this.liveLoadPatches();
    return { standards, bases, ledgers, braces, planks, brackets, trusses, guardrails, liveLoads, nodes: this.nodes() };
  }

  // --- load takeoff --------------------------------------------------------
  // What each leg delivers to whatever it stands on, dead and live apart.
  //
  // Every pound in the parts list reaches a leg, by the path it really takes:
  //   a standard and its base hardware   straight down its own leg
  //   a ledger, brace, truss or rail     half to the leg at each end
  //   a side bracket                     the standard it hangs on, and with it
  //                                      whatever the bracket carries; being
  //                                      out from that standard, it also levers
  //                                      load onto it from the leg behind
  //   a plank                            the two ledgers it bears on, then
  //                                      along each ledger to its legs
  //   a live load                        the same way as the planks under it,
  //                                      or across them if it was turned
  // Ledgers are taken as simple spans between standards, which is what makes
  // this a tributary takeoff rather than a frame analysis. It is checked
  // against OpenSees, leg by leg: see verification/opensees.
  //
  // Each leg comes back as { id, x, y, deadLb, liveLb }: its load as the
  // scaffold stands, everything placed on it at once. A leg whose total is
  // negative is in uplift. A leg that side brackets lever load off has two
  // more things on it:
  //   lifted       { deadLb, liveLb } taken off it by those brackets, which
  //                deadLb and liveLb already leave out
  //   overturning  how it stands against being lifted right off the ground,
  //                which is a different question from its load:
  //                  turningLb    what the brackets lift, dead and live
  //                  resistingLb  the dead load holding it down
  //                  factor       resistingLb / turningLb
  //                  holdDownLb   what must be added here, as counterweight
  //                               or an anchor, for resistingLb to be
  //                               OVERTURNING_FACTOR times turningLb
  //                Live load on the deck behind is left out of resistingLb:
  //                it may not be there when the bracket is loaded.
  takeoff() {
    const perFootStandard = tubeWeightPerFoot(this.components.standard);
    const perFootLedger = tubeWeightPerFoot(this.components.ledger);
    const perFootBrace = tubeWeightPerFoot(this.components.brace);
    const plankPsf = this.components.plank.areaWeightLbPerFt2;

    const legs = new Map();
    // The jack, collar and sill are on the leg too: they were in the parts
    // list but not in the leg loads, which read about 14 lb a leg light.
    const hardwareLb = this.baseHardwareLb();
    // A leg is a standard that stands on the ground.
    for (const s of this.standards.values()) {
      if (!this.isLeg(s)) continue;
      legs.set(s.id, { id: s.id, x: s.x, y: s.y, deadLb: perFootStandard * this.standardHeightFt(s) + hardwareLb, liveLb: 0 });
    }
    const byCol = new Map();
    // Every spot a load can come down at: a leg, or a bracket's tip.
    const spots = [];
    for (const l of legs.values()) { byCol.set(key(l.x, l.y), l); spots.push({ k: key(l.x, l.y), x: l.x, y: l.y }); }
    // A side bracket is a cantilever off one standard, so whatever bears on it
    // goes down the leg it is attached to and no other: a standard in its
    // socket, a deck on its arm, a ledger or a brace on its tip rosette. Here
    // each tip is tied to that leg. A bracket hung on a standard that itself
    // stands in a bracket passes its load on down, so the walk repeats until
    // it finds nothing new. `reach` is how far out from the leg each tip is:
    // one step for each bracket on the way, which way it points and how long.
    const reach = new Map();
    const brackets = [...this.brackets.values()];
    const unit = k => { const len = Math.hypot(k.dir[0], k.dir[1]) || 1; return [k.dir[0] / len, k.dir[1] / len]; };
    for (let pass = 0, found = true; found && pass <= brackets.length; pass++) {
      found = false;
      for (const k of brackets) {
        const [tx, ty] = sideBracketTip(k, k.dir, k.lengthFt);
        const tip = key(tx, ty);
        if (byCol.has(tip)) continue;
        const host = key(k.x, k.y);
        const carrier = byCol.get(host);
        if (!carrier) continue;
        const [ux, uy] = unit(k);
        byCol.set(tip, carrier);
        spots.push({ k: tip, x: tx, y: ty });
        reach.set(tip, [...(reach.get(host) || []), { ux, uy, armFt: k.lengthFt }]);
        found = true;
      }
    }
    const nearest = (x, y) => {
      let best = null, bd = Infinity;
      for (const l of legs.values()) { const d = (l.x - x) ** 2 + (l.y - y) ** 2; if (d < bd) { bd = d; best = l; } }
      return best;
    };
    /** The spot a load at (x, y) comes down at: that very spot, or one it stands just beside. */
    const spotAt = (x, y) => {
      const k = key(x, y);
      if (byCol.has(k)) return k;
      let best = null, bd = NEAR_COLUMN_FT ** 2;
      for (const p of spots) { const d = (p.x - x) ** 2 + (p.y - y) ** 2; if (d <= bd) { bd = d; best = p.k; } }
      return best;
    };
    // What a bracket's load does besides weigh on its leg. It stands out from
    // the leg, so it also tries to turn the scaffold over about it. Kept for
    // each leg and each way a bracket points from it, in lb ft, dead and live.
    const turning = new Map(); // leg id -> Map(direction -> { ux, uy, deadLbFt, liveLbFt })
    const turn = (leg, ux, uy, lbFt, kase) => {
      let ways = turning.get(leg.id);
      if (!ways) turning.set(leg.id, ways = new Map());
      const way = Math.round(Math.atan2(uy, ux) * 1000);
      let t = ways.get(way);
      if (!t) ways.set(way, t = { ux, uy, deadLbFt: 0, liveLbFt: 0 });
      t[kase] += lbFt;
    };
    const land = (x, y, w, load, kase) => {
      const k = spotAt(x, y);
      const l = (k && byCol.get(k)) || nearest(x, y);
      if (!l) return;
      l[load] += w;
      for (const step of (k && reach.get(k)) || []) turn(l, step.ux, step.uy, w * step.armFt, kase);
    };
    const attribute = (x, y, w) => land(x, y, w, 'deadLb', 'deadLbFt');
    const attributeLive = (x, y, w) => land(x, y, w, 'liveLb', 'liveLbFt');
    // A standard seated in a bracket: its tube, with no base under it.
    for (const s of this.standards.values()) {
      if (!this.isLeg(s)) attribute(s.x, s.y, perFootStandard * this.standardHeightFt(s));
    }

    for (const l of this.ledgers.values()) {
      const len = Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1], l.b[2] - l.a[2]);
      const w = perFootLedger * len;
      attribute(l.a[0], l.a[1], w / 2); attribute(l.b[0], l.b[1], w / 2);
    }
    for (const b of this.braces.values()) {
      const len = Math.hypot(b.b[0] - b.a[0], b.b[1] - b.a[1], b.b[2] - b.a[2]);
      const w = perFootBrace * len;
      attribute(b.a[0], b.a[1], w / 2); attribute(b.b[0], b.b[1], w / 2);
    }
    for (const b of this.brackets.values()) {
      // The whole frame (chord, post, diagonal, socket) hangs on its standard,
      // and out from it: its weight acts at the middle of its tube.
      const w = perFootLedger * sideBracketTubeLengthFt(b.lengthFt);
      attribute(b.x, b.y, w);
      const carrier = byCol.get(key(b.x, b.y));
      const [ux, uy] = unit(b);
      if (carrier) turn(carrier, ux, uy, w * sideBracketCentroidOutFt(b.lengthFt), 'deadLbFt');
    }
    for (const t of this.trusses.values()) {
      const len = Math.hypot(t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]);
      const w = perFootLedger * trussMemberLengthFt(len, t.family); // every chord, post, tie and diagonal
      attribute(t.a[0], t.a[1], w / 2); attribute(t.b[0], t.b[1], w / 2);
    }
    // A rail is a tube between each pair of standards it runs past.
    for (const g of this.guardrailPieces()) {
      const w = perFootLedger * g.lengthFt;
      attribute(g.a[0], g.a[1], w / 2); attribute(g.b[0], g.b[1], w / 2);
    }
    // Deck self weight, board by board: a plank bears on the ledgers at its
    // two ends and on nothing else, so that is where its weight goes, and from
    // each ledger to the legs at that ledger's ends. (Sharing a bay's planks
    // equally among the legs round it is right only for four legs at the
    // corners; a leg under the middle of a side ledger carries none of them.)
    // A deck brings no live load with it: that is only ever what was placed on
    // it with the Live load tool.
    const decks = this.plankBays();
    // The ledgers and the bracket arms: a deck on brackets bears on the arms,
    // and an arm's two ends both lead to the leg its bracket hangs on.
    const ledgerList = this.supportList();
    for (const deck of decks) {
      for (const board of deck.boards) {
        forEachStripMemberLoad(
          { center: board.center, z: deck.frame.z, span: deck.frame.along, spanFt: board.lengthFt, widthFt: inchesToFeet(board.widthIn), psf: plankPsf },
          ledgerList,
          (ledger, point, lb) => distributeLedgerPointLoad(ledger, point, lb, attribute),
          // A board with no ledger under it still weighs on the nearest leg.
          (point, lb) => attribute(point.x, point.y, lb));
      }
    }

    // Placed live loads: one-way onto the ledgers either side of the span (as
    // RISA-3D attributes a one-way area load), then each ledger point load
    // split between the legs at its ends.
    let placedLiveLb = 0;
    for (const placement of this.liveLoads.values()) {
      const resolved = resolveLiveLoadPlacement(placement, ledgerList, decks);
      if (!resolved) continue;
      placedLiveLb += resolved.areaSqFt * placement.psf;
      forEachLiveLoadMemberLoad(resolved, ledgerList,
        (ledger, point, lb) => distributeLedgerPointLoad(ledger, point, lb, attributeLive),
        // A piece with no ledger anywhere under it still weighs on the nearest leg.
        (point, lb) => attributeLive(point.x, point.y, lb));
    }

    // The leverage of the side brackets. Everything above put a bracket's
    // load on the leg it hangs on, which is where its weight goes. But the
    // load stands outside that leg, and a leg on a screw jack cannot hold the
    // overturning by itself. The frame holds it, as a pair of forces: more on
    // the leg the bracket hangs on, and the same amount less on the leg behind
    // it, the one a ledger runs back to. Each is the overturning divided by
    // the distance between the two legs, which is plain statics and needs no
    // stiffness. Where it comes to more than the leg behind carries, that leg
    // is in uplift and its load is negative. With no leg behind there is
    // nothing to lever against, and the load stays where it was.
    const legAt = new Map([...legs.values()].map(l => [key(l.x, l.y), l]));
    const joined = new Map(); // leg id -> the legs a ledger or truss runs to from it
    for (const map of [this.ledgers, this.trusses]) {
      for (const m of map.values()) {
        const a = legAt.get(key(m.a[0], m.a[1])), b = legAt.get(key(m.b[0], m.b[1]));
        if (!a || !b || a === b) continue;
        for (const [from, to] of [[a, b], [b, a]]) {
          if (!joined.has(from.id)) joined.set(from.id, new Set());
          joined.get(from.id).add(to);
        }
      }
    }
    for (const [id, ways] of turning) {
      const leg = legs.get(id);
      for (const t of ways.values()) {
        let behind = null, armFt = Infinity;
        for (const other of joined.get(id) || []) {
          const dx = other.x - leg.x, dy = other.y - leg.y;
          const back = -(dx * t.ux + dy * t.uy);
          if (back < LEVER_MIN_ARM_FT || back < LEVER_BACK_COS * Math.hypot(dx, dy) || back >= armFt) continue;
          behind = other; armFt = back;
        }
        if (!behind) continue;
        const dead = t.deadLbFt / armFt, live = t.liveLbFt / armFt;
        leg.deadLb += dead; behind.deadLb -= dead;
        leg.liveLb += live; behind.liveLb -= live;
        if (!behind.lifted) behind.lifted = { deadLb: 0, liveLb: 0 };
        behind.lifted.deadLb += dead; behind.lifted.liveLb += live;
      }
    }
    // A leg in uplift and a scaffold safe against overturning are not the
    // same thing. The first is this leg's load as everything stands, which
    // can be a few pounds either side of nothing. The second asks for a
    // margin: the dead load on the leg must be OVERTURNING_FACTOR times what
    // the brackets lift off it, and the live load behind does not count,
    // since it comes and goes. So the hold-down a leg needs is always more
    // than its uplift, and a leg with no uplift at all can still need one.
    for (const leg of legs.values()) {
      if (!leg.lifted) continue;
      const turningLb = leg.lifted.deadLb + leg.lifted.liveLb;
      if (!(turningLb > 0)) { delete leg.lifted; continue; }
      const resistingLb = leg.deadLb + leg.lifted.deadLb;
      leg.overturning = {
        turningLb, resistingLb,
        factor: resistingLb / turningLb,
        holdDownLb: Math.max(0, OVERTURNING_FACTOR * turningLb - resistingLb),
      };
    }

    const list = [...legs.values()];
    const totals = list.reduce((a, l) => ({ deadLb: a.deadLb + l.deadLb, liveLb: a.liveLb + l.liveLb }), { deadLb: 0, liveLb: 0 });
    return { legs: list, totals, placedLiveLb };
  }
}

export function stateBounds(state) {
  const cols = [...state.standards.values()];
  if (!cols.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = 0;
  for (const s of cols) {
    minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
    minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
    maxZ = Math.max(maxZ, state.standardTopZ(s));
  }
  return { min: [minX, minY, 0], max: [maxX, maxY, maxZ] };
}
