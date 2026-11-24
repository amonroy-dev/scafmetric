// Turns a scaffold into a structural model for OpenSees.
//
// This is the independent side of the leg-load check, so it must not lean on
// the thing being checked. It never calls ScaffoldState.takeoff() or the live
// load attribution in liveloads.js. It reads the parts as they were placed
// (standards, ledgers, decks and their boards, braces, rails, brackets,
// trusses, loads) and writes down where each one physically sits and what it
// weighs. OpenSees then works out, by equilibrium, how much of that reaches
// each base. Unit weights (lb per foot of tube, psf of plank) are inputs to
// both sides; they are checked by hand in the unit tests, not here.
//
// The structure, in feet and pounds:
//
//   standards   one continuous member each, ground to top, held at the ground;
//               one seated in a side bracket starts at the bracket's tip and
//               is held by nothing but the bracket
//   brackets    the arm is a member too: continuous, rigid where it meets the
//               standard it hangs on and free at its tip, which is what a
//               cantilever is. A deck bears on it as on a ledger, a standard
//               stands on its tip, a ledger or brace ends on its tip rosette,
//               and OpenSees finds where all of that goes
//   ledgers     pin-ended between the standards (or bracket tips) they connect
//   decks       each board is a strip where it is drawn, running the way it is
//               drawn, simply supported on the ledgers it crosses and carrying
//               its own weight; a live load rides on strips a few inches wide
//               over the bay. So the load path is the deck's own, and nothing
//               here decides which leg gets what
//   the rest    braces, rails, trusses, a bracket's own frame and base hardware
//               are weights hung where the part is (a brace half at each end,
//               a rail half at each standard it runs between, each tube of a
//               bracket at its own middle along the arm), with brace
//               stiffness added only in the frame runs
//
// A live load turned across the boards rides on strips laid across them.
//
// The model also says which frames hold a bracket's overturning, for the
// "levered" solution in solve.py. A leg on a screw jack cannot hold a moment
// at its foot, so the overturning of a loaded bracket is held by the frame it
// hangs on: the leg under it, the leg a ledger or truss runs back to, and
// what joins the two. Those two legs' bases are marked as hinges about the
// line of the face (so is every leg in line with them, which leaves that
// frame the only thing able to hold the overturning) and the members joining
// them as fixed to them. Which leg is behind which bracket is read here from
// the placed parts, not asked of the builder.

import { tubeWeightPerFoot } from '../../src/scaffold/catalog.js';
import { screwJackWeightLb, woodSillWeightLb, baseCollarWeightLb, plankBoardWeightLb } from '../../src/scaffold/workspace/bom.js';
import { trussMemberLengthFt, sideBracketWorldMembers, sideBracketTip, inchesToFeet } from '../../src/scaffold/workspace/parts.js';
import { BRACKET_SEAT_UP_IN } from '../../src/scaffold/workspace/state.js';

const SAME_POINT_FT = 0.02;
const SAME_LIFT_FT = 1 / 12;
// A brace sits a couple of inches off its face, so its end is near a standard, not on it.
const BRACE_REACH_FT = 0.6;
const EDGE_FT = 0.05;
// The leg behind a bracket: one a ledger or truss runs back to, at least this
// far back and within about ten degrees of square behind it.
const BEHIND_MIN_FT = 0.5;
const BEHIND_COS = 0.985;
// Legs are in one frame line when what joins them runs this nearly along it.
const IN_LINE_SIN = 0.17;

const round = (v, d = 6) => Math.round(v * 10 ** d) / 10 ** d;

export function buildAnalysisModel(state, { stripFt = 0.25 } = {}) {
  const nodes = [];
  const shared = new Map();
  /** A node of the structure itself: the same point is the same node. */
  const sharedNode = (x, y, z) => {
    const key = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
    let i = shared.get(key);
    if (i === undefined) { i = nodes.length; nodes.push([round(x), round(y), round(z)]); shared.set(key, i); }
    return i;
  };
  /** A node inside one deck strip: never shared, so strips cannot lean on each other. */
  const freeNode = (x, y, z) => { nodes.push([round(x), round(y), round(z)]); return nodes.length - 1; };

  const loads = { dead: new Map(), live: new Map() };
  const addLoad = (kase, node, lb) => { if (lb) loads[kase].set(node, (loads[kase].get(node) || 0) + lb); };
  const notes = [];
  const members = [];

  const perFt = {
    standard: tubeWeightPerFoot(state.components.standard),
    ledger: tubeWeightPerFoot(state.components.ledger),
    brace: tubeWeightPerFoot(state.components.brace),
  };
  const plankPsf = state.components.plank.areaWeightLbPerFt2;

  // --- standards ------------------------------------------------------------
  // A standard on the ground runs from the ground. One seated in a side
  // bracket runs from the bracket's tip rosette, its tube starting a few
  // inches up in the socket; where that is comes from the bracket, read here
  // from the placed parts rather than asked of the builder.
  const standards = [...state.standards.values()].map(s => {
    const bracket = s.bracketId ? state.brackets.get(s.bracketId) || null : null;
    const baseZ = bracket ? bracket.z + inchesToFeet(BRACKET_SEAT_UP_IN) : state.baseOffsetFt();
    return {
      id: s.id, x: s.x, y: s.y, baseZ, top: baseZ + s.segments.reduce((a, b) => a + b, 0), seated: !!bracket, bracket,
      levels: new Set([bracket ? round(bracket.z) : 0, round(baseZ)]),
    };
  });
  for (const s of standards) s.levels.add(round(s.top));
  const standardNear = (x, y, reach = SAME_POINT_FT) => {
    let best = null, gap = reach;
    for (const s of standards) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d <= gap) { gap = d; best = s; }
    }
    return best;
  };
  /** The node on a standard at a height, creating the level if it is new. */
  const onStandard = (s, z) => { s.levels.add(round(z)); return sharedNode(s.x, s.y, z); };

  // --- ledgers --------------------------------------------------------------
  const ledgers = state.ledgerList().map(l => {
    const dx = l.b[0] - l.a[0], dy = l.b[1] - l.a[1];
    const len = Math.hypot(dx, dy);
    return { id: l.id, a: l.a, b: l.b, len, ux: dx / len, uy: dy / len, z: (l.a[2] + l.b[2]) / 2, stations: [0, len] };
  });
  // --- side brackets: an arm cantilevered off the standard it hangs on --------
  const arms = [...state.brackets.values()].map(k => {
    const [tx, ty] = sideBracketTip(k, k.dir, k.lengthFt);
    const len = Math.hypot(tx - k.x, ty - k.y);
    return { id: k.id, a: [k.x, k.y, k.z], b: [tx, ty, k.z], len, ux: (tx - k.x) / len, uy: (ty - k.y) / len, z: k.z, stations: [0, len], bracket: k };
  });
  const tipNear = (x, y, z, reach = SAME_POINT_FT) =>
    arms.find(m => Math.abs(m.z - z) <= SAME_LIFT_FT && Math.hypot(m.b[0] - x, m.b[1] - y) <= reach) || null;

  for (const l of ledgers) {
    for (const end of [l.a, l.b]) {
      const s = standardNear(end[0], end[1]);
      if (s) { onStandard(s, end[2]); continue; }
      // On the rosette at a bracket's tip: the arm holds it up.
      if (!tipNear(end[0], end[1], end[2])) throw new Error(`ledger ${l.id} ends at ${end.slice(0, 2)} with no standard and no bracket tip there; this model cannot hold it up`);
    }
  }
  const ledgerNode = (l, u) => sharedNode(l.a[0] + l.ux * u, l.a[1] + l.uy * u, l.z);
  // What a deck can bear on: a ledger, or a bracket's arm.
  const bearers = [...ledgers, ...arms];

  // --- decks: strips spanning the way the boards run ------------------------
  let unsupportedLb = 0;
  /**
   * One strip of deck: a line through (ox, oy) along the unit vector (sx, sy),
   * `lengthFt` long about that point, carrying `totalLb` spread evenly along
   * it. It is simply supported on every ledger at its lift that it crosses,
   * span by span, so its load reaches the ledgers by its own statics.
   */
  const layStrip = ({ ox, oy, z, sx, sy, lengthFt, totalLb, kase, label }) => {
    if (!(totalLb > 0)) return;
    const bearings = [];
    for (const l of bearers) {
      if (Math.abs(l.z - z) > SAME_LIFT_FT) continue;
      const sin = sx * l.uy - sy * l.ux;
      if (Math.abs(sin) < 0.2) continue;
      const wx = l.a[0] - ox, wy = l.a[1] - oy;
      const t = (wx * l.uy - wy * l.ux) / sin;
      const u = (wx * sy - wy * sx) / sin;
      if (u < -1e-6 || u > l.len + 1e-6) continue;
      if (t < -lengthFt / 2 - EDGE_FT || t > lengthFt / 2 + EDGE_FT) continue;
      bearings.push({ t, ledger: l, u: Math.min(l.len, Math.max(0, u)) });
    }
    bearings.sort((p, q) => p.t - q.t);
    if (bearings.length < 2) {
      unsupportedLb += totalLb;
      notes.push(`${label}: a strip found ${bearings.length} ledger(s) to bear on`);
      return;
    }
    const borne = bearings[bearings.length - 1].t - bearings[0].t;
    if (Math.abs(borne - lengthFt) > 2 * EDGE_FT) notes.push(`${label}: a ${round(lengthFt, 3)} ft strip bears over ${round(borne, 3)} ft`);
    for (let i = 0; i < bearings.length - 1; i++) {
      const from = bearings[i], to = bearings[i + 1];
      const length = to.t - from.t;
      if (length < 1e-6) continue;
      from.ledger.stations.push(from.u);
      to.ledger.stations.push(to.u);
      // Four pieces, the load lumped at their ends: the same resultant, at
      // the same place, as the uniform load it stands for.
      const chain = [ledgerNode(from.ledger, from.u)];
      for (let k = 1; k < 4; k++) chain.push(freeNode(ox + sx * (from.t + length * k / 4), oy + sy * (from.t + length * k / 4), z));
      chain.push(ledgerNode(to.ledger, to.u));
      const spanLb = totalLb * length / borne;
      chain.forEach((n, k) => addLoad(kase, n, spanLb * (k === 0 || k === 4 ? 1 / 8 : 1 / 4)));
      members.push({ kind: 'strip', id: label, chain, pinned: true });
    }
  };

  /**
   * A uniform load over a rectangle, as narrow strips side by side. `rect` is
   * { cx, cy, z, sx, sy, spanFt, sideFt }: centre, lift, the unit vector the
   * strips span along, and the rectangle's size along and across it.
   */
  const layStrips = (rect, kase, psf, label) => {
    if (!(psf > 0)) return;
    const { cx, cy, z, sx, sy, spanFt, sideFt } = rect;
    const count = Math.max(1, Math.ceil(sideFt / stripFt - 1e-9));
    const width = sideFt / count;
    for (let j = 0; j < count; j++) {
      const v = -sideFt / 2 + width * (j + 0.5);
      layStrip({ ox: cx - sy * v, oy: cy + sx * v, z, sx, sy, lengthFt: spanFt, totalLb: psf * width * spanFt, kase, label });
    }
  };

  // Plank weight: one strip per board, where it is drawn, the way it is drawn
  // running, weighing what the parts list says that board weighs.
  const decks = state.plankBays();
  for (const deck of decks) {
    for (const board of deck.boards) {
      layStrip({
        ox: board.center[0], oy: board.center[1], z: deck.frame.z,
        sx: -Math.sin(board.rotationZ), sy: Math.cos(board.rotationZ),
        lengthFt: board.lengthFt,
        totalLb: plankBoardWeightLb(board.widthIn, board.lengthFt, plankPsf),
        kase: 'dead', label: `planks ${deck.id}`,
      });
    }
  }
  // Live loads: the rectangle each one is drawn over, spanning the way its
  // arrows point. A load on a deck sits at the deck's lift; a patch from an
  // older model, hung between two ledgers, sits at theirs.
  const drawn = new Map(state.liveLoadPatches().map(p => [p.id, p]));
  for (const load of state.liveLoads.values()) {
    const patch = drawn.get(load.id);
    if (!patch) { notes.push(`live load ${load.id} has no bay under it and carries nothing`); continue; }
    const deck = load.deckId ? decks.find(d => d.id === load.deckId) : null;
    const anchor = load.deckId ? null : ledgers.find(l => l.id === load.ledgerId);
    layStrips({
      cx: patch.center[0], cy: patch.center[1], z: deck ? deck.frame.z : anchor.z,
      sx: patch.span[0], sy: patch.span[1], spanFt: patch.widthFt, sideFt: patch.lengthFt,
    }, 'live', load.psf, `live load ${load.id}`);
  }

  // --- ledgers as members, their own weight along them ----------------------
  for (const l of ledgers) {
    const stations = [...new Set(l.stations.map(u => round(u, 4)))].sort((a, b) => a - b);
    const chain = stations.map(u => ledgerNode(l, u));
    for (let i = 0; i < stations.length - 1; i++) {
      const lb = perFt.ledger * (stations[i + 1] - stations[i]);
      addLoad('dead', chain[i], lb / 2);
      addLoad('dead', chain[i + 1], lb / 2);
    }
    members.push({ kind: 'ledger', id: l.id, chain, pinned: true });
  }

  // --- the parts that are only weight here ----------------------------------
  const braces = [];
  for (const b of state.braces.values()) {
    const lb = perFt.brace * Math.hypot(b.b[0] - b.a[0], b.b[1] - b.a[1], b.b[2] - b.a[2]);
    const ends = [b.a, b.b].map(p => {
      const s = standardNear(p[0], p[1], BRACE_REACH_FT);
      if (s) return onStandard(s, p[2]);
      // On a bracket's tip rosette, with no standard in the socket.
      const tip = tipNear(p[0], p[1], p[2], BRACE_REACH_FT);
      if (!tip) throw new Error(`brace ${b.id} ends ${p.slice(0, 2)} with no standard or bracket tip within reach`);
      return sharedNode(tip.b[0], tip.b[1], tip.z);
    });
    for (const n of ends) addLoad('dead', n, lb / 2);
    braces.push({ kind: 'brace', id: b.id, ends });
  }

  for (const g of state.guardrails.values()) {
    const dx = g.b[0] - g.a[0], dy = g.b[1] - g.a[1];
    const plan = Math.hypot(dx, dy);
    if (plan < 1e-6) {
      // A post: all of it on the standard it stands by.
      const s = standardNear(g.a[0], g.a[1], 1) || standardNear(g.a[0], g.a[1], Infinity);
      addLoad('dead', onStandard(s, Math.min(g.a[2], g.b[2])), perFt.ledger * Math.abs(g.b[2] - g.a[2]));
      continue;
    }
    // A rail is one tube between each pair of standards it runs past, however
    // long the line it was drawn as. Each piece weighs on its own two ends.
    const ux = dx / plan, uy = dy / plan;
    const along = [];
    for (const s of standards) {
      const ex = s.x - g.a[0], ey = s.y - g.a[1];
      const t = ex * ux + ey * uy;
      if (Math.abs(ex * -uy + ey * ux) > EDGE_FT || t < -EDGE_FT || t > plan + EDGE_FT) continue;
      along.push({ s, t });
    }
    along.sort((p, q) => p.t - q.t);
    if (along.length < 2) {
      const ends = [g.a, g.b].map(p => standardNear(p[0], p[1], Infinity));
      for (const s of ends) addLoad('dead', onStandard(s, g.a[2]), perFt.ledger * plan / 2);
      notes.push(`rail ${g.id} does not run between standards; its weight went to the nearest ones`);
      continue;
    }
    for (let i = 0; i < along.length - 1; i++) {
      const lb = perFt.ledger * (along[i + 1].t - along[i].t);
      addLoad('dead', onStandard(along[i].s, g.a[2]), lb / 2);
      addLoad('dead', onStandard(along[i + 1].s, g.a[2]), lb / 2);
    }
  }

  // What joins two legs, for finding the leg behind a bracket further down.
  const joins = [];
  const legNear = (x, y) => { const s = standardNear(x, y); return s && !s.seated ? s : null; };
  for (const l of ledgers) {
    const a = legNear(l.a[0], l.a[1]), b = legNear(l.b[0], l.b[1]);
    if (a && b && a !== b) joins.push({ a, b, ledger: l.id });
  }

  for (const t of state.trusses.values()) {
    const lb = perFt.ledger * trussMemberLengthFt(Math.hypot(t.b[0] - t.a[0], t.b[1] - t.a[1], t.b[2] - t.a[2]), t.family);
    const ends = [];
    for (const p of [t.a, t.b]) {
      const s = standardNear(p[0], p[1]);
      if (!s) throw new Error(`truss ${t.id} ends ${p.slice(0, 2)} with no standard there`);
      const node = onStandard(s, p[2]);
      addLoad('dead', node, lb / 2);
      ends.push({ s, node });
    }
    if (!ends[0].s.seated && !ends[1].s.seated && ends[0].s !== ends[1].s) joins.push({ a: ends[0].s, b: ends[1].s, tie: [ends[0].node, ends[1].node] });
  }

  for (const m of arms) {
    const k = m.bracket;
    const s = standardNear(k.x, k.y);
    if (!s) throw new Error(`bracket ${k.id} hangs on no standard`);
    onStandard(s, k.z);
    // The frame's own weight: every tube of it at its own middle, as far out
    // along the arm as that is. So the bracket weighs on its standard, and
    // turns it, as the thing itself does.
    for (const tube of sideBracketWorldMembers(k, k.dir, k.lengthFt)) {
      const lb = perFt.ledger * Math.hypot(tube.b[0] - tube.a[0], tube.b[1] - tube.a[1], tube.b[2] - tube.a[2]);
      const out = ((tube.a[0] + tube.b[0]) / 2 - k.x) * m.ux + ((tube.a[1] + tube.b[1]) / 2 - k.y) * m.uy;
      const u = Math.min(m.len, Math.max(0, out));
      m.stations.push(u);
      addLoad('dead', ledgerNode(m, round(u, 4)), lb);
    }
    // The arm as a member, through every point something bears on it. It is
    // the path those loads take to the standard.
    const stations = [...new Set(m.stations.map(u => round(u, 4)))].sort((a, b) => a - b);
    members.push({ kind: 'bracket', id: k.id, chain: stations.map(u => ledgerNode(m, u)), pinned: false });
  }

  // --- the frames that hold a bracket's overturning ---------------------------
  // For each bracket: the leg under it (down through any bracket its standard
  // is seated in), and the leg behind that one. Their bases hinge about the
  // line of the face, with every leg in line with them, and what joins the
  // pair is fixed to both.
  const hinges = new Map(); // leg id -> Set of 'x' | 'y'
  const fixedLedgers = new Set();
  const ties = [];
  const legUnder = k => {
    let s = standardNear(k.x, k.y);
    for (let i = 0; s && s.seated && i <= arms.length; i++) s = standardNear(s.bracket.x, s.bracket.y);
    return s && !s.seated ? s : null;
  };
  for (const m of arms) {
    const front = legUnder(m.bracket);
    if (!front) continue;
    let behind = null, armFt = Infinity;
    for (const j of joins) {
      const other = j.a === front ? j.b : j.b === front ? j.a : null;
      if (!other) continue;
      const dx = other.x - front.x, dy = other.y - front.y;
      const back = -(dx * m.ux + dy * m.uy);
      if (back < BEHIND_MIN_FT || back < BEHIND_COS * Math.hypot(dx, dy) || back >= armFt) continue;
      behind = other; armFt = back;
    }
    if (!behind) continue;
    // A load out along y turns the frame about x, and the other way about.
    const axis = Math.abs(m.uy) > 0.999 ? 'x' : Math.abs(m.ux) > 0.999 ? 'y' : null;
    if (!axis) throw new Error(`bracket ${m.id} is not square to the axes: this model cannot hinge the bases under it`);
    for (const j of joins) {
      if (!((j.a === front && j.b === behind) || (j.a === behind && j.b === front))) continue;
      if (j.ledger) fixedLedgers.add(j.ledger); else ties.push(j.tie);
    }
    // Every leg in line with the pair, found by walking what joins them along that line.
    const line = new Set([front]);
    for (let grew = true; grew;) {
      grew = false;
      for (const j of joins) {
        if (line.has(j.a) === line.has(j.b)) continue;
        const dx = j.b.x - j.a.x, dy = j.b.y - j.a.y;
        if (Math.abs(dx * m.uy - dy * m.ux) > IN_LINE_SIN * Math.hypot(dx, dy)) continue;
        line.add(j.a); line.add(j.b); grew = true;
      }
    }
    for (const leg of line) { if (!hinges.has(leg.id)) hinges.set(leg.id, new Set()); hinges.get(leg.id).add(axis); }
  }
  for (const member of members) if (member.kind === 'ledger' && fixedLedgers.has(member.id)) member.lever = true;

  // --- standards as members: the tube's weight up its height, the base hardware at its foot
  const hardwareLb = screwJackWeightLb(state.base.jackExtensionIn)
    + (state.base.showWoodSill ? woodSillWeightLb() : 0)
    + (state.base.showBaseCollar ? baseCollarWeightLb() : 0);
  const supports = [];
  for (const s of standards) {
    const levels = [...s.levels].filter(z => z <= s.top + 1e-6).sort((a, b) => a - b);
    const above = [...s.levels].filter(z => z > s.top + 1e-6);
    if (above.length) notes.push(`standard ${s.id}: something attaches above its top at ${above}`);
    const chain = levels.map(z => sharedNode(s.x, s.y, z));
    for (let i = 0; i < levels.length - 1; i++) {
      const tubeFt = Math.max(0, levels[i + 1] - Math.max(levels[i], s.baseZ));
      addLoad('dead', chain[i], perFt.standard * tubeFt / 2);
      addLoad('dead', chain[i + 1], perFt.standard * tubeFt / 2);
    }
    members.push({ kind: 'standard', id: s.id, chain, pinned: false });
    // Seated in a bracket it has no base and no support of its own: its
    // lowest node is the bracket's tip.
    if (s.seated) continue;
    addLoad('dead', chain[0], hardwareLb);
    const support = { node: chain[0], leg: s.id, x: s.x, y: s.y };
    if (hinges.has(s.id)) support.hinge = [...hinges.get(s.id)].sort().join('');
    supports.push(support);
  }

  const total = kase => [...loads[kase].values()].reduce((a, b) => a + b, 0);
  return {
    nodes,
    supports,
    members,
    braces,
    ties,
    loads: { dead: [...loads.dead], live: [...loads.live] },
    totals: { deadLb: total('dead'), liveLb: total('live'), unsupportedLb },
    notes: [...new Set(notes)],
  };
}
