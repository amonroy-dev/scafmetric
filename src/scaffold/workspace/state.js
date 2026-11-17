// Interactive scaffold state: placed standards (stacks of catalog segments),
// ledgers, braces and planks, the derived connection nodes, and the per-leg
// dead/live load takeoff. Pure data + math (no three.js) so it is unit-testable.

import { tubeWeightPerFoot, resolveComponents, DEFAULT_LIVE_LOAD_PSF } from '../catalog.js';
import { getStandardBaseOffsetFt, inchesToFeet, buildBestFitPlankLayout, PLANK } from './parts.js';

// Real connection spacing on a standard (kept even though rosette hardware is
// not drawn), so ledger heights land where they actually would.
export const FIRST_NODE_OFFSET_IN = 15.75;
export const NODE_SPACING_IN = 19.6875;

const key = (x, y) => `${round(x)},${round(y)}`;
function round(v, d = 3) { const f = 10 ** d; return Math.round(v * f) / f; }

export class ScaffoldState {
  constructor(opts = {}) {
    this.snapStep = opts.snapStep ?? 1;
    this.components = resolveComponents(opts.components);
    this.liveLoadPsf = opts.liveLoadPsf ?? DEFAULT_LIVE_LOAD_PSF;
    this.base = {
      jackExtensionIn: opts.jackExtensionIn ?? 6,
      showWoodSill: opts.showWoodSill ?? true,
      showBaseCollar: opts.showBaseCollar ?? true,
    };
    this.standards = new Map(); // id -> { id, x, y, segments:[lengthFt] }
    this.ledgers = new Map();   // id -> { id, a:[x,y,z], b:[x,y,z] }
    this.braces = new Map();    // id -> { id, a:[x,y,z], b:[x,y,z] }
    this.planks = new Map();    // id -> { id, x0,y0,x1,y1,z }
    this.brackets = new Map();  // id -> { id, x, y, z, dir:[dx,dy], lengthFt }
    this._seq = 0;
    this._history = [];
    this._future = [];
    this.onChange = opts.onChange || (() => {});
  }

  _id(p) { return `${p}${++this._seq}`; }

  // --- undo / redo ---------------------------------------------------------
  snapshot() {
    return JSON.stringify({
      standards: [...this.standards], ledgers: [...this.ledgers],
      braces: [...this.braces], planks: [...this.planks], brackets: [...this.brackets],
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
    this._seq = d.seq;
    Object.assign(this.base, d.base);
    this._emit();
  }
  _pushHistory() {
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
  _emit() { this.onChange(); }

  // Bottom of the standard tube, above the base assembly.
  baseOffsetFt() {
    return getStandardBaseOffsetFt(this.base.jackExtensionIn, this.base.showWoodSill, this.base.showBaseCollar);
  }
  setBase(patch) { this._pushHistory(); Object.assign(this.base, patch); this._emit(); }

  standardHeightFt(s) { return s.segments.reduce((a, b) => a + b, 0); }
  standardTopZ(s) { return this.baseOffsetFt() + this.standardHeightFt(s); }

  // --- placement -----------------------------------------------------------
  addStandard(x, y, lengthFt) { this._pushHistory();
    const sx = this.snap(x), sy = this.snap(y);
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

  addLedger(a, b) { this._pushHistory(); const l = { id: this._id('L'), a: [...a], b: [...b] }; this.ledgers.set(l.id, l); this._emit(); return l; }
  addBrace(a, b) { this._pushHistory(); const v = { id: this._id('B'), a: [...a], b: [...b] }; this.braces.set(v.id, v); this._emit(); return v; }
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
    for (const m of [this.standards, this.ledgers, this.braces, this.planks, this.brackets]) {
      if (m.delete(id)) { this._emit(); return true; }
    }
    return false;
  }
  removeMany(ids) { this._pushHistory();
    let n = 0;
    for (const id of ids) {
      for (const m of [this.standards, this.ledgers, this.braces, this.planks, this.brackets]) {
        if (m.delete(id)) { n++; break; }
      }
    }
    if (n) this._emit();
    return n;
  }
  clear() { this._pushHistory(); this.standards.clear(); this.ledgers.clear(); this.braces.clear(); this.planks.clear(); this.brackets.clear(); this._emit(); }

  // Connection nodes along each standard, at the real connection spacing.
  nodes() {
    const out = [];
    const base = this.baseOffsetFt();
    const first = inchesToFeet(FIRST_NODE_OFFSET_IN);
    const spacing = inchesToFeet(NODE_SPACING_IN);
    for (const s of this.standards.values()) {
      const top = this.standardTopZ(s);
      let level = 0;
      for (let z = base + first; z <= top + 1e-6; z += spacing) {
        out.push({ x: s.x, y: s.y, z, level, columnId: s.id });
        level++;
      }
    }
    return out;
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
    const runAlongX = w >= d;
    const lengthFt = runAlongX ? w : d;
    const crossSpanIn = (runAlongX ? d : w) * 12;
    const slots = buildBestFitPlankLayout(crossSpanIn);
    const z = p.z + inchesToFeet(PLANK.profileDepthIn) / 2;
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
    const base = this.baseOffsetFt();
    const standards = [...this.standards.values()].map(s => ({
      id: s.id, x: s.x, y: s.y, baseZ: base, topZ: this.standardTopZ(s), segments: s.segments.slice(),
    }));
    const bases = [...this.standards.values()].map(s => ({ id: s.id, x: s.x, y: s.y }));
    const ledgers = [...this.ledgers.values()].map(l => ({ id: l.id, a: l.a, b: l.b }));
    const braces = [...this.braces.values()].map(b => ({ id: b.id, a: b.a, b: b.b }));
    const planks = [...this.planks.values()].map(p => ({ ...p, boards: this.plankBoards(p) }));
    const brackets = [...this.brackets.values()].map(b => ({ ...b }));
    return { standards, bases, ledgers, braces, planks, brackets, nodes: this.nodes() };
  }

  // --- load takeoff --------------------------------------------------------
  takeoff() {
    const perFootStandard = tubeWeightPerFoot(this.components.standard);
    const perFootLedger = tubeWeightPerFoot(this.components.ledger);
    const perFootBrace = tubeWeightPerFoot(this.components.brace);
    const plankPsf = this.components.plank.areaWeightLbPerFt2;

    const legs = new Map();
    for (const s of this.standards.values()) {
      legs.set(s.id, { id: s.id, x: s.x, y: s.y, deadLb: perFootStandard * this.standardHeightFt(s), liveLb: 0 });
    }
    const byCol = new Map();
    for (const l of legs.values()) byCol.set(key(l.x, l.y), l);
    const nearest = (x, y) => {
      let best = null, bd = Infinity;
      for (const l of legs.values()) { const d = (l.x - x) ** 2 + (l.y - y) ** 2; if (d < bd) { bd = d; best = l; } }
      return best;
    };
    const attribute = (x, y, w) => { const l = byCol.get(key(x, y)) || nearest(x, y); if (l) l.deadLb += w; };

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
      const perFoot = tubeWeightPerFoot(this.components.ledger);
      attribute(b.x, b.y, perFoot * (b.lengthFt + Math.hypot(b.lengthFt, b.lengthFt)));
    }
    for (const p of this.planks.values()) {
      const area = Math.abs(p.x1 - p.x0) * Math.abs(p.y1 - p.y0);
      const dead = area * plankPsf;
      const live = area * this.liveLoadPsf;
      const inside = [...legs.values()].filter(l =>
        l.x >= p.x0 - 1e-6 && l.x <= p.x1 + 1e-6 && l.y >= p.y0 - 1e-6 && l.y <= p.y1 + 1e-6);
      const targets = inside.length ? inside : [nearest((p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2)].filter(Boolean);
      for (const l of targets) { l.deadLb += dead / targets.length; l.liveLb += live / targets.length; }
    }

    const list = [...legs.values()];
    const totals = list.reduce((a, l) => ({ deadLb: a.deadLb + l.deadLb, liveLb: a.liveLb + l.liveLb }), { deadLb: 0, liveLb: 0 });
    return { legs: list, totals };
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
