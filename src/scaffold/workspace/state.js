// Interactive scaffold state: the components the user has placed (standards,
// ledgers, braces, planks) plus the derived connection nodes and the per-leg
// dead/live load takeoff. Pure data + math (no three.js) so it is unit-testable.

import { tubeWeightPerFoot, resolveComponents, DEFAULT_LIVE_LOAD_PSF } from '../catalog.js';

const key = (x, y) => `${round(x)},${round(y)}`;
function round(v, d = 3) { const f = 10 ** d; return Math.round(v * f) / f; }

export class ScaffoldState {
  constructor(opts = {}) {
    this.liftHeightFt = opts.liftHeightFt ?? 6.5;
    this.snapStep = opts.snapStep ?? 1;
    this.components = resolveComponents(opts.components);
    this.liveLoadPsf = opts.liveLoadPsf ?? DEFAULT_LIVE_LOAD_PSF;
    this.standards = new Map(); // id -> { id, x, y, lifts }
    this.ledgers = new Map();   // id -> { id, ax, ay, bx, by, level }
    this.braces = new Map();    // id -> { id, ax, ay, bx, by, level }  (level..level+1)
    this.planks = new Map();    // id -> { id, x0, y0, x1, y1, level }
    this._seq = 0;
    this.onChange = opts.onChange || (() => {});
  }

  _id(p) { return `${p}${++this._seq}`; }
  snap(v) { const s = this.snapStep; return s > 0 ? Math.round(v / s) * s : v; }
  _emit() { this.onChange(); }

  maxLifts() { let m = 0; for (const s of this.standards.values()) m = Math.max(m, s.lifts); return m; }
  zAt(level) { return level * this.liftHeightFt; }

  // --- standards (stacks) --------------------------------------------------
  addStandard(x, y) {
    const sx = this.snap(x), sy = this.snap(y);
    const existing = this.standardAt(sx, sy);
    if (existing) { existing.lifts += 1; this._emit(); return existing; }
    const s = { id: this._id('S'), x: sx, y: sy, lifts: 1 };
    this.standards.set(s.id, s);
    this._emit();
    return s;
  }
  standardAt(x, y) {
    const k = key(x, y);
    for (const s of this.standards.values()) if (key(s.x, s.y) === k) return s;
    return null;
  }
  stack(id, delta) {
    const s = this.standards.get(id); if (!s) return;
    s.lifts = Math.max(1, s.lifts + delta);
    this._emit();
  }

  addLedger(ax, ay, bx, by, level) {
    const l = { id: this._id('L'), ax, ay, bx, by, level: Math.max(0, Math.round(level)) };
    this.ledgers.set(l.id, l); this._emit(); return l;
  }
  addBrace(ax, ay, bx, by, level) {
    const b = { id: this._id('B'), ax, ay, bx, by, level: Math.max(0, Math.round(level)) };
    this.braces.set(b.id, b); this._emit(); return b;
  }
  addPlank(x0, y0, x1, y1, level) {
    const p = { id: this._id('P'), x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1), level: Math.max(0, Math.round(level)) };
    this.planks.set(p.id, p); this._emit(); return p;
  }

  remove(id) {
    for (const map of [this.standards, this.ledgers, this.braces, this.planks]) {
      if (map.delete(id)) { this._emit(); return true; }
    }
    return false;
  }
  clear() { this.standards.clear(); this.ledgers.clear(); this.braces.clear(); this.planks.clear(); this._emit(); }

  // Connection nodes: for each standard column, a node at every lift level it reaches.
  nodes() {
    const out = [];
    for (const s of this.standards.values()) {
      for (let lv = 0; lv <= s.lifts; lv++) out.push({ x: s.x, y: s.y, z: this.zAt(lv), level: lv, columnId: s.id });
    }
    return out;
  }

  // Geometry for rendering (plain objects; the scene builds meshes from these).
  geometry() {
    const tubes = [];
    for (const s of this.standards.values()) {
      tubes.push({ id: s.id, kind: 'standard', a: [s.x, s.y, 0], b: [s.x, s.y, this.zAt(s.lifts)] });
    }
    for (const l of this.ledgers.values()) {
      const z = this.zAt(l.level);
      tubes.push({ id: l.id, kind: 'ledger', a: [l.ax, l.ay, z], b: [l.bx, l.by, z] });
    }
    for (const b of this.braces.values()) {
      tubes.push({ id: b.id, kind: 'brace', a: [b.ax, b.ay, this.zAt(b.level)], b: [b.bx, b.by, this.zAt(b.level + 1)] });
    }
    const planks = [...this.planks.values()].map(p => ({ id: p.id, x0: p.x0, y0: p.y0, x1: p.x1, y1: p.y1, z: this.zAt(p.level) }));
    const legs = [...this.standards.values()].map(s => ({ id: s.id, x: s.x, y: s.y, z0: 0, z1: this.zAt(s.lifts) }));
    return { tubes, planks, legs, nodes: this.nodes() };
  }

  // --- load takeoff --------------------------------------------------------
  takeoff() {
    const perFootStandard = tubeWeightPerFoot(this.components.standard);
    const perFootLedger = tubeWeightPerFoot(this.components.ledger);
    const perFootBrace = tubeWeightPerFoot(this.components.brace);
    const plankPsf = this.components.plank.areaWeightLbPerFt2;

    const legs = new Map(); // id -> { id, x, y, deadLb, liveLb }
    for (const s of this.standards.values()) {
      legs.set(s.id, { id: s.id, x: s.x, y: s.y, deadLb: perFootStandard * this.zAt(s.lifts), liveLb: 0 });
    }
    const byColumn = new Map();
    for (const leg of legs.values()) byColumn.set(key(leg.x, leg.y), leg);
    const nearestLeg = (x, y) => {
      let best = null, bd = Infinity;
      for (const leg of legs.values()) { const d = (leg.x - x) ** 2 + (leg.y - y) ** 2; if (d < bd) { bd = d; best = leg; } }
      return best;
    };
    const attribute = (x, y, w) => {
      const leg = byColumn.get(key(x, y)) || nearestLeg(x, y);
      if (leg) leg.deadLb += w;
    };

    for (const l of this.ledgers.values()) {
      const len = Math.hypot(l.bx - l.ax, l.by - l.ay);
      const w = perFootLedger * len;
      attribute(l.ax, l.ay, w / 2); attribute(l.bx, l.by, w / 2);
    }
    for (const b of this.braces.values()) {
      const len = Math.hypot(b.bx - b.ax, b.by - b.ay, this.liftHeightFt);
      const w = perFootBrace * len;
      attribute(b.ax, b.ay, w / 2); attribute(b.bx, b.by, w / 2);
    }
    for (const p of this.planks.values()) {
      const area = Math.abs(p.x1 - p.x0) * Math.abs(p.y1 - p.y0);
      const dead = area * plankPsf;
      const live = area * this.liveLoadPsf;
      const inside = [...legs.values()].filter(leg =>
        leg.x >= p.x0 - 1e-6 && leg.x <= p.x1 + 1e-6 && leg.y >= p.y0 - 1e-6 && leg.y <= p.y1 + 1e-6);
      const targets = inside.length ? inside : [nearestLeg((p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2)].filter(Boolean);
      for (const leg of targets) { leg.deadLb += dead / targets.length; leg.liveLb += live / targets.length; }
    }

    const legList = [...legs.values()];
    const totals = legList.reduce((a, l) => ({ deadLb: a.deadLb + l.deadLb, liveLb: a.liveLb + l.liveLb }), { deadLb: 0, liveLb: 0 });
    return { legs: legList, totals };
  }
}

// Bounding box of all placed geometry, in feet: {min:[x,y,z], max:[x,y,z]} or null.
export function stateBounds(state) {
  const cols = [...state.standards.values()];
  if (!cols.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = 0;
  for (const s of cols) {
    minX = Math.min(minX, s.x); maxX = Math.max(maxX, s.x);
    minY = Math.min(minY, s.y); maxY = Math.max(maxY, s.y);
    maxZ = Math.max(maxZ, state.zAt(s.lifts));
  }
  return { min: [minX, minY, 0], max: [maxX, maxY, maxZ] };
}
