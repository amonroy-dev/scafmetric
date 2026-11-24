// Live loads on decked bays, with one-way distribution.
//
// A live load is placed the way RISA-3D places a one-way member area load: a
// rectangle of deck, a magnitude in psf and the direction the load spans. It is
// stored against the DECK it sits on (`deckId`) with `across` saying whether it
// spans along the boards (the default: planks hook over the ledgers at their
// ends, so that is where their load goes) or square to them. The rectangle is
// read back from the deck each time, so the load follows the model, and it goes
// when its deck goes. Each bay carries its own psf: a 25 psf walkway and a
// 75 psf material bay can sit side by side.
//
// Attribution follows RISA-3D's "Member Area Loads" (one way):
//   - the area is meshed into pieces no bigger than the area load mesh
//     (144 in², so 1 ft cells);
//   - each piece is carried in the span direction by the nearest member either
//     side of it, as a simply supported deck: each takes the share set by how
//     far the other is from the piece;
//   - a piece with no member one way along the span is attributed two-way,
//     to the nearest members whichever way they lie.
// RISA's answer depends on its mesh; this takes the limit of a fine one. The
// load is cut into strips along the span, cut again wherever a ledger ends,
// and each stretch between two supports is taken whole, which for a uniform
// load is exact. So a hand check of a rectangular bay matches to the pound.
// Each resulting point load on a ledger is then split between the legs at its
// ends as a simple span, which is this takeoff's stand-in for the frame solve.
//
// Models saved before loads sat on decks hold ledger-anchored patches
// ({ ledgerId, sideSign }, from ScaffoldPro's manualLiveLoadPlacement.ts): the
// bay between a ledger and its opposite neighbour, spanning between the two.
// Those still resolve and attribute exactly as they did.
//
// No three.js here, so all of it is unit-testable in Node.

import {
  LEDGER_TUBE_OD_IN, getSupportFrame, computeSupportAxisInterval, findOppositeSupportFrame,
  buildSupportPair, projectAxisPointToSupportFrame, getLedgerSideSign, collinearRun,
  inchesToFeet, clamp,
  MIN_LEDGER_LENGTH_FT, MIN_SUPPORT_OFFSET_FT, PARALLEL_DOT_THRESHOLD,
  SAME_LIFT_TOL_FT, MIN_OVERLAP_FT,
} from './supportspan.js';

// Re-exported so existing callers and tests keep one import site.
export {
  getSupportFrame, computeSupportAxisInterval, findOppositeSupportFrame,
  buildSupportPair, projectAxisPointToSupportFrame, getLedgerSideSign, collinearRun,
  MIN_LEDGER_LENGTH_FT, MIN_SUPPORT_OFFSET_FT, PARALLEL_DOT_THRESHOLD,
  SAME_LIFT_TOL_FT, MIN_OVERLAP_FT,
};

export const LIVE_LOAD_SURFACE_Z_OFFSET_FT = inchesToFeet(LEDGER_TUBE_OD_IN / 2) + inchesToFeet(0.25);
export const LIVE_LOAD_MESH_MAX_CELL_SIZE_FT = 1;
// Light duty, the rating most working decks carry.
export const DEFAULT_BAY_LIVE_LOAD_PSF = 25;

// A member within about 11 degrees of the span cannot carry a deck spanning
// that way: the span runs along it, not onto it.
const SUPPORT_MIN_SIN = 0.2;
const SUPPORT_END_TOL_FT = 1e-6;
// How far past a deck's edge a ledger may sit and still be the one it bears on.
const EDGE_SUPPORT_TOL_FT = 0.5;
const DECK_TOUCH_TOL_FT = inchesToFeet(2);

// --- placements --------------------------------------------------------------

function instanceFromResolved(resolved) {
  const p = resolved.placement;
  return {
    id: p.id,
    center: resolved.center,
    rotationZ: resolved.rotationZ,
    lengthFt: resolved.lengthFt,
    widthFt: resolved.widthFt,
    psf: p.psf,
    areaSqFt: resolved.areaSqFt,
    totalLb: resolved.areaSqFt * p.psf,
    // Unit vector along the span, in plan: the way the arrows point.
    span: [resolved.span.x, resolved.span.y],
    deckId: p.deckId ?? null,
    across: !!p.across,
    ledgerId: p.ledgerId ?? null,
    sideSign: p.sideSign ?? null,
  };
}

/**
 * A load on a deck. `widthFt` is the span, between the members that carry it;
 * `lengthFt` runs along those members.
 */
function resolveDeckLiveLoad(placement, decks) {
  const deck = decks.find(d => d.id === placement.deckId);
  const f = deck && deck.frame;
  if (!f) return null;
  const across = !!placement.across;
  const span = across ? f.across : f.along;
  const widthFt = across ? f.acrossFt : f.alongFt;
  const lengthFt = across ? f.alongFt : f.acrossFt;
  if (!Number.isFinite(widthFt) || widthFt <= 1e-6) return null;
  if (!Number.isFinite(lengthFt) || lengthFt <= 1e-6) return null;
  return {
    placement,
    deck,
    span: { x: span.x, y: span.y },
    z: f.z,
    center: [f.center.x, f.center.y, f.z + LIVE_LOAD_SURFACE_Z_OFFSET_FT],
    rotationZ: Math.atan2(span.y, span.x),
    lengthFt,
    widthFt,
    areaSqFt: lengthFt * widthFt,
  };
}

/**
 * Resolve a stored placement against the current model. `decks` is the list
 * from ScaffoldState.plankBays(); it is only needed for loads placed on a deck.
 */
export function resolveLiveLoadPlacement(placement, ledgers, decks = []) {
  if (placement.deckId) return resolveDeckLiveLoad(placement, decks);

  const sourceLedger = ledgers.find(l => l.id === placement.ledgerId);
  if (!sourceLedger) return null;
  const supportPair = buildSupportPair(sourceLedger, ledgers, placement.sideSign);
  if (!supportPair) return null;

  const widthFt = Math.abs(supportPair.signedOffsetFt);
  const lengthFt = supportPair.overlapLengthFt;
  if (!Number.isFinite(widthFt) || widthFt <= 1e-6) return null;
  if (!Number.isFinite(lengthFt) || lengthFt <= 1e-6) return null;

  const axisCenterFt = (supportPair.overlapMinFt + supportPair.overlapMaxFt) * 0.5;
  const src = supportPair.source;
  const cx = src.mid.x + src.dir.x * axisCenterFt + src.perp.x * supportPair.signedOffsetFt * 0.5;
  const cy = src.mid.y + src.dir.y * axisCenterFt + src.perp.y * supportPair.signedOffsetFt * 0.5;
  const rotationZ = Math.PI / 2 - Math.atan2(src.dir.y, src.dir.x);
  const sign = Math.sign(supportPair.signedOffsetFt) || 1;

  return {
    placement,
    supportPair,
    span: { x: src.perp.x * sign, y: src.perp.y * sign },
    z: src.z,
    center: [cx, cy, src.z + LIVE_LOAD_SURFACE_Z_OFFSET_FT],
    rotationZ,
    lengthFt,
    widthFt,
    areaSqFt: lengthFt * widthFt,
  };
}

/**
 * Mesh a ledger-anchored patch and hand each cell's share to its two
 * supporting ledgers. Load splits across the bay in inverse proportion to
 * distance (one-way).
 */
export function forEachLiveLoadContribution(resolved, callback, maxCellSizeFt = LIVE_LOAD_MESH_MAX_CELL_SIZE_FT) {
  const { widthFt, lengthFt } = resolved;
  const pair = resolved.supportPair;
  if (!pair || widthFt <= 1e-6 || lengthFt <= 1e-6) return;

  const cell = Math.max(maxCellSizeFt, 1e-3);
  const cellsAlong = Math.max(1, Math.ceil(lengthFt / cell));
  const cellsAcross = Math.max(1, Math.ceil(widthFt / cell));
  const cellLengthFt = lengthFt / cellsAlong;
  const cellWidthFt = widthFt / cellsAcross;

  for (let along = 0; along < cellsAlong; along++) {
    const axisPositionFt = pair.overlapMinFt + cellLengthFt * (along + 0.5);
    for (let across = 0; across < cellsAcross; across++) {
      const spanPositionFt = cellWidthFt * (across + 0.5);
      const pointLoadLb = resolved.placement.psf * cellLengthFt * cellWidthFt;
      if (!Number.isFinite(pointLoadLb) || pointLoadLb <= 0) continue;

      const sourceLoadLb = pointLoadLb * ((widthFt - spanPositionFt) / widthFt);
      callback({
        sourceLedger: pair.source.ledger,
        targetLedger: pair.target.ledger,
        sourcePoint: projectAxisPointToSupportFrame(pair.source, pair.source.mid, pair.source.dir, axisPositionFt),
        targetPoint: projectAxisPointToSupportFrame(pair.target, pair.source.mid, pair.source.dir, axisPositionFt),
        sourceLoadLb,
        targetLoadLb: pointLoadLb - sourceLoadLb,
      });
    }
  }
}

// --- one-way attribution, as RISA-3D's member area loads ---------------------

/** The ledgers at one lift as plan segments: a start, a unit direction, a length. */
function membersAtLift(ledgers, z) {
  const out = [];
  for (const ledger of ledgers) {
    if (Math.abs((ledger.a[2] + ledger.b[2]) / 2 - z) > SAME_LIFT_TOL_FT) continue;
    const dx = ledger.b[0] - ledger.a[0], dy = ledger.b[1] - ledger.a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    out.push({ ledger, ax: ledger.a[0], ay: ledger.a[1], ux: dx / len, uy: dy / len, len });
  }
  return out;
}

/**
 * Where the line through `origin` along the unit vector `dir` meets each
 * member: [{ t, ledger, point }] in order along the line. `t` is the distance
 * from `origin`, negative behind it.
 */
function crossingsAlong(origin, dir, members) {
  const out = [];
  for (const m of members) {
    const sin = dir.x * m.uy - dir.y * m.ux;
    if (Math.abs(sin) < SUPPORT_MIN_SIN) continue;
    const wx = m.ax - origin.x, wy = m.ay - origin.y;
    const t = (wx * m.uy - wy * m.ux) / sin;
    const u = (wx * dir.y - wy * dir.x) / sin;
    if (u < -SUPPORT_END_TOL_FT || u > m.len + SUPPORT_END_TOL_FT) continue;
    out.push({ t, ledger: m.ledger, point: { x: origin.x + dir.x * t, y: origin.y + dir.y * t } });
  }
  return out.sort((p, q) => p.t - q.t);
}

/** Share a piece between the members found, each by how near it is. */
function shareByDistance(found, loadLb, onMember) {
  const touching = found.find(f => f.d < 1e-9);
  if (touching) { onMember(touching.ledger, touching.point, loadLb); return; }
  let sum = 0;
  for (const f of found) sum += 1 / f.d;
  for (const f of found) onMember(f.ledger, f.point, loadLb * (1 / f.d) / sum);
}

/**
 * Hand every piece of a resolved load to the ledgers that carry it.
 *
 *   onMember(ledger, point, lb)   a point load on a ledger, at a plan point
 *   onUnsupported(point, lb)      a piece with no ledger under it at all
 *
 * A load on a deck is attributed as RISA-3D attributes a one-way member area
 * load (see the head of this file). With two ledgers either side of a piece
 * the 1/distance share IS the simple-span split, so the two-way fallback is
 * the same rule with more members in it.
 */
export function forEachLiveLoadMemberLoad(resolved, ledgers, onMember, onUnsupported = () => {}, maxCellSizeFt = LIVE_LOAD_MESH_MAX_CELL_SIZE_FT) {
  if (resolved.supportPair) {
    forEachLiveLoadContribution(resolved, c => {
      onMember(c.sourceLedger, c.sourcePoint, c.sourceLoadLb);
      onMember(c.targetLedger, c.targetPoint, c.targetLoadLb);
    }, maxCellSizeFt);
    return;
  }

  const { widthFt, lengthFt, span } = resolved;
  const psf = resolved.placement.psf;
  if (!(widthFt > 1e-6) || !(lengthFt > 1e-6) || !Number.isFinite(psf) || psf <= 0) return;
  const cell = Math.max(maxCellSizeFt, 1e-3);
  const side = { x: -span.y, y: span.x };
  const cx = resolved.center[0], cy = resolved.center[1];
  const members = membersAtLift(ledgers, resolved.z);

  // Strips run along the span, a mesh cell wide at most. They are also cut
  // wherever a ledger ends, so each strip bears on the same ledgers for its
  // whole width and its load acts at its centre line exactly.
  const cuts = evenCuts(-lengthFt / 2, lengthFt / 2, cell);
  for (const m of members) {
    for (const [px, py] of [[m.ax, m.ay], [m.ax + m.ux * m.len, m.ay + m.uy * m.len]]) {
      const v = (px - cx) * side.x + (py - cy) * side.y;
      if (v > -lengthFt / 2 + CUT_TOL_FT && v < lengthFt / 2 - CUT_TOL_FT) cuts.push(v);
    }
  }
  const strips = mergeCuts(cuts);

  for (let j = 0; j < strips.length - 1; j++) {
    const stripFt = strips[j + 1] - strips[j];
    const v = (strips[j] + strips[j + 1]) / 2;
    const origin = { x: cx + side.x * v, y: cy + side.y * v };
    const crossings = crossingsAlong(origin, span, members);
    // The strip's own length, cut at each ledger it passes over.
    const stops = mergeCuts([-widthFt / 2, widthFt / 2,
      ...crossings.map(c => c.t).filter(t => t > -widthFt / 2 + CUT_TOL_FT && t < widthFt / 2 - CUT_TOL_FT)]);
    for (let i = 0; i < stops.length - 1; i++) {
      const t0 = stops[i], t1 = stops[i + 1];
      let back = null, fwd = null;
      for (const c of crossings) {
        if (c.t <= t0 + CUT_TOL_FT) back = c;
        else if (c.t >= t1 - CUT_TOL_FT) { fwd = c; break; }
      }
      if (back && fwd) {
        // A uniform load between two supports acts at its middle, whatever
        // the mesh, so the stretch is taken whole.
        const loadLb = psf * stripFt * (t1 - t0);
        const toBack = loadLb * (fwd.t - (t0 + t1) / 2) / (fwd.t - back.t);
        onMember(back.ledger, back.point, toBack);
        onMember(fwd.ledger, fwd.point, loadLb - toBack);
        continue;
      }
      // Nothing to span onto one way: two-way, piece by piece, to the nearest
      // members all round.
      const pieces = evenCuts(t0, t1, cell);
      for (let k = 0; k < pieces.length - 1; k++) {
        const t = (pieces[k] + pieces[k + 1]) / 2;
        const pieceLb = psf * stripFt * (pieces[k + 1] - pieces[k]);
        const point = { x: origin.x + span.x * t, y: origin.y + span.y * t };
        const found = [];
        if (back) found.push({ ledger: back.ledger, point: back.point, d: Math.max(0, t - back.t) });
        if (fwd) found.push({ ledger: fwd.ledger, point: fwd.point, d: Math.max(0, fwd.t - t) });
        let left = null, right = null;
        for (const c of crossingsAlong(point, side, members)) { if (c.t <= 0) left = c; else { right = c; break; } }
        if (left) found.push({ ledger: left.ledger, point: left.point, d: -left.t });
        if (right) found.push({ ledger: right.ledger, point: right.point, d: right.t });
        if (found.length) shareByDistance(found, pieceLb, onMember);
        else onUnsupported(point, pieceLb);
      }
    }
  }
}

const CUT_TOL_FT = 1e-6;

/** The ends of equal pieces, none longer than `maxFt`, covering [from, to]. */
function evenCuts(from, to, maxFt) {
  const n = Math.max(1, Math.ceil((to - from) / maxFt - 1e-9));
  const out = [];
  for (let i = 0; i <= n; i++) out.push(from + (to - from) * i / n);
  return out;
}

/** Sorted, with cuts that fall on top of each other merged. */
function mergeCuts(cuts) {
  const sorted = [...cuts].sort((a, b) => a - b);
  const out = [];
  for (const c of sorted) if (!out.length || c - out[out.length - 1] > CUT_TOL_FT) out.push(c);
  return out;
}

/**
 * Split a point load on a ledger between the legs at its two ends, as a simply
 * supported span. `addAt(x, y, lb)` receives each reaction in plan position.
 */
export function distributeLedgerPointLoad(ledger, point, loadLb, addAt) {
  if (!Number.isFinite(loadLb) || loadLb <= 0) return;
  const ax = ledger.a[0], ay = ledger.a[1];
  const dx = ledger.b[0] - ax, dy = ledger.b[1] - ay;
  const lengthFt = Math.hypot(dx, dy);
  if (lengthFt <= 1e-6) {
    addAt(ax, ay, loadLb * 0.5);
    addAt(ledger.b[0], ledger.b[1], loadLb * 0.5);
    return;
  }
  const along = clamp(((point.x - ax) * dx + (point.y - ay) * dy) / lengthFt, 0, lengthFt);
  const endLb = loadLb * (along / lengthFt);
  addAt(ax, ay, loadLb - endLb);
  addAt(ledger.b[0], ledger.b[1], endLb);
}

// --- decks: what a load can sit on -------------------------------------------
// `deck` is an entry of ScaffoldState.plankBays(); its `frame` is the deck's
// rectangle in plan and the way its boards run (see planks.js).

/** The patch a load on this deck would draw, for the hover preview. */
export function buildDeckLoadPreview(deck, psf = DEFAULT_BAY_LIVE_LOAD_PSF, across = false) {
  const placement = { id: `preview:${deck.id}`, deckId: deck.id, psf, across: !!across };
  const resolved = resolveDeckLiveLoad(placement, [deck]);
  return resolved ? { placement, liveLoad: instanceFromResolved(resolved) } : null;
}

/**
 * True when a ledger sits along both edges the load would bear on, spanning
 * along the boards (`across` false) or square to them (`across` true). A deck
 * with ledgers on two sides only can carry its load one way only.
 */
export function deckSpanIsSupported(deck, ledgers, across = false) {
  const f = deck && deck.frame;
  if (!f) return false;
  const dir = across ? f.across : f.along;
  const reach = (across ? f.acrossFt : f.alongFt) / 2 + EDGE_SUPPORT_TOL_FT;
  const crossings = crossingsAlong(f.center, dir, membersAtLift(ledgers, f.z));
  return crossings.some(c => c.t < 0 && -c.t <= reach) && crossings.some(c => c.t > 0 && c.t <= reach);
}

/**
 * The decks joined edge to edge with this one at its lift, itself first: the
 * platform a SHIFT click loads. Touching at a corner is not joined.
 */
export function connectedDecks(start, decks) {
  const joined = (a, b) => {
    if (Math.abs(a.z - b.z) > SAME_LIFT_TOL_FT) return false;
    const gapX = Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1);
    const gapY = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1);
    return (gapX <= DECK_TOUCH_TOL_FT && -gapY >= MIN_OVERLAP_FT) || (gapY <= DECK_TOUCH_TOL_FT && -gapX >= MIN_OVERLAP_FT);
  };
  const out = [start];
  const seen = new Set([start.id]);
  for (let i = 0; i < out.length; i++) {
    for (const d of decks) {
      if (seen.has(d.id) || !joined(out[i], d)) continue;
      seen.add(d.id);
      out.push(d);
    }
  }
  return out;
}

/**
 * The deck a pointer ray lands on: the nearest one whose walking surface the
 * ray passes through. `ray` is { origin, direction } in world feet. Returns
 * { deck, point }, or null (always null for a ray level with the decks).
 */
export function pickDeckWithRay(ray, decks) {
  let best = null;
  const o = ray.origin, d = ray.direction;
  if (Math.abs(d.z) < 1e-6) return null;
  for (const deck of decks) {
    const f = deck.frame;
    if (!f) continue;
    const t = (f.z + inchesToFeet(LEDGER_TUBE_OD_IN / 2) - o.z) / d.z;
    if (!(t > 0) || (best && t >= best.t)) continue;
    const px = o.x + d.x * t - f.center.x, py = o.y + d.y * t - f.center.y;
    if (Math.abs(px * f.along.x + py * f.along.y) > f.alongFt / 2) continue;
    if (Math.abs(px * f.across.x + py * f.across.y) > f.acrossFt / 2) continue;
    best = { t, deck, point: { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t } };
  }
  return best ? { deck: best.deck, point: best.point } : null;
}

/**
 * Which load sits on each deck: Map of deckId to placement. A ledger-anchored
 * patch from an older model counts for the deck it lies over, so loading that
 * deck again replaces it instead of doubling it.
 */
export function liveLoadsByDeck(placements, ledgers, decks) {
  const map = new Map();
  const older = [];
  for (const p of placements) { if (p.deckId) map.set(p.deckId, p); else older.push(p); }
  for (const p of older) {
    const r = resolveLiveLoadPlacement(p, ledgers);
    if (!r) continue;
    for (const d of decks) {
      if (map.has(d.id) || !d.frame || Math.abs(d.frame.z - r.z) > SAME_LIFT_TOL_FT) continue;
      if (Math.hypot(d.frame.center.x - r.center[0], d.frame.center.y - r.center[1]) < 0.5) { map.set(d.id, p); break; }
    }
  }
  return map;
}

// --- ledger-anchored patches (older models) ----------------------------------

function hasPlacement(existing, ledgerId, sideSign) {
  return existing.some(p => p.ledgerId === ledgerId && p.sideSign === sideSign);
}

/** Preview patch for hovering one ledger side; null if the bay is already loaded. */
export function buildLiveLoadPreviewForLedger(sourceLedger, ledgers, sideSign, existing = [], psf = DEFAULT_BAY_LIVE_LOAD_PSF) {
  if (hasPlacement(existing, sourceLedger.id, sideSign)) return null;
  const placement = { id: `preview:${sourceLedger.id}:${sideSign}`, ledgerId: sourceLedger.id, sideSign, psf };
  const resolved = resolveLiveLoadPlacement(placement, ledgers);
  if (!resolved) return null;
  return { placement, liveLoad: instanceFromResolved(resolved) };
}

/** Resolve every stored placement to a drawable patch. */
export function buildLiveLoadInstances(placements, ledgers, decks = []) {
  const out = [];
  for (const placement of placements) {
    const resolved = resolveLiveLoadPlacement(placement, ledgers, decks);
    if (resolved) out.push(instanceFromResolved(resolved));
  }
  return out;
}

/**
 * SHIFT batch: every bay along the connected run of collinear ledgers at this
 * lift, flood-filled from the hovered ledger through touching neighbours.
 */
export function computeLiveLoadBatchPreview(sourceLedger, ledgers, sideSign, existing = [], psf = DEFAULT_BAY_LIVE_LOAD_PSF) {
  return collinearRun(sourceLedger, ledgers)
    .map(ledger => buildLiveLoadPreviewForLedger(ledger, ledgers, sideSign, existing, psf))
    .filter(preview => preview !== null);
}
