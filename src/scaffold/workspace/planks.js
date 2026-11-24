// Deck (plank) placement on a bay.
//
// Ported from ScaffoldPro's manualPlankPlacement.ts. Decking is NOT a
// two-corner drag: you hover a LEDGER, the side under the cursor picks the bay,
// and the boards span between that ledger and its opposite neighbour, packed
// side by side along the ledger. SHIFT decks every bay along the run.
//
// Boards therefore run PERPENDICULAR to the supporting ledgers, which is how
// planks actually sit, and the best-fit 9 in / 6 in packing runs along them.

import { buildSupportPair, collinearRun, LEDGER_TUBE_OD_IN, inchesToFeet } from './supportspan.js';
import { buildBestFitPlankLayout, PLANK } from './parts.js';

// Both ends of a plank hook over the ledger, so the packing span is the ledger
// length less the two mouthpieces.
export const PLANK_MOUTHPIECE_TOTAL_IN = 6;

/**
 * Board centre above the ledger's centreline so the walking surface is flush
 * with the top of the ledger tube, as planks hooked over a ledger sit.
 */
export function plankSeatOffsetFt() {
  return inchesToFeet(LEDGER_TUBE_OD_IN / 2) - inchesToFeet(PLANK.profileDepthIn) * PLANK.topAboveCentre;
}

/**
 * Boards for one resolved bay. `placementId` seeds the board ids so each board
 * traces back to its placement for picking.
 */
export function buildPlankBoardsFromPair(placementId, pair) {
  const { source, signedOffsetFt } = pair;
  const runLengthFt = Math.abs(signedOffsetFt);
  const usableSpanIn = Math.max(0, source.lengthFt * 12 - PLANK_MOUTHPIECE_TOTAL_IN);
  const layout = buildBestFitPlankLayout(usableSpanIn);
  if (layout.length === 0) return [];

  // A hair short of the full bay so neighbouring decks do not fight for pixels.
  const visibleLengthFt = Math.max(inchesToFeet(PLANK.widthIn), runLengthFt - inchesToFeet(0.25));
  const sign = Math.sign(signedOffsetFt) || 1;
  const runDir = { x: source.perp.x * sign, y: source.perp.y * sign };
  const rotationZ = Math.PI / 2 - Math.atan2(runDir.y, runDir.x);
  const betweenMid = {
    x: source.mid.x + source.perp.x * (signedOffsetFt / 2),
    y: source.mid.y + source.perp.y * (signedOffsetFt / 2),
  };
  const deckCenterZ = source.z + plankSeatOffsetFt();

  return layout.map((slot, index) => ({
    id: `${placementId}:${index}`,
    bayId: placementId,
    widthIn: slot.widthIn,
    lengthFt: visibleLengthFt,
    rotationZ,
    center: [
      betweenMid.x + source.dir.x * slot.centerOffsetFt,
      betweenMid.y + source.dir.y * slot.centerOffsetFt,
      deckCenterZ,
    ],
  }));
}

/**
 * Plan-view rectangle of a resolved bay, used by guardrails, the BOM and the
 * load takeoff, all of which work in footprint rectangles.
 */
export function plankRectFromPair(pair) {
  const { source, signedOffsetFt, overlapMinFt, overlapMaxFt } = pair;
  const corners = [];
  for (const along of [overlapMinFt, overlapMaxFt]) {
    for (const across of [0, signedOffsetFt]) {
      corners.push({
        x: source.mid.x + source.dir.x * along + source.perp.x * across,
        y: source.mid.y + source.dir.y * along + source.perp.y * across,
      });
    }
  }
  const xs = corners.map(c => c.x), ys = corners.map(c => c.y);
  return {
    x0: Math.min(...xs), x1: Math.max(...xs),
    y0: Math.min(...ys), y1: Math.max(...ys),
    z: source.z,
  };
}

/**
 * A deck's rectangle in plan and the way its boards run:
 *
 *   center            the middle of the deck
 *   z                 the lift it sits on (the ledgers' centreline)
 *   along, alongFt    unit vector along the boards, and the deck's size that way
 *   across, acrossFt  square to the boards, and its size that way
 *
 * Whatever sits on a deck (a live load) reads its footprint and its default
 * direction from this, so it follows the deck however the deck was laid.
 */
export function deckFrameFromPair(pair) {
  const { source, signedOffsetFt, overlapMinFt, overlapMaxFt } = pair;
  const sign = Math.sign(signedOffsetFt) || 1;
  const mid = (overlapMinFt + overlapMaxFt) / 2;
  return {
    center: {
      x: source.mid.x + source.dir.x * mid + source.perp.x * signedOffsetFt / 2,
      y: source.mid.y + source.dir.y * mid + source.perp.y * signedOffsetFt / 2,
    },
    z: source.z,
    // The boards run from the ledger they hang on to its opposite.
    along: { x: source.perp.x * sign, y: source.perp.y * sign },
    alongFt: Math.abs(signedOffsetFt),
    across: { x: source.dir.x, y: source.dir.y },
    acrossFt: overlapMaxFt - overlapMinFt,
  };
}

/** A rectangle deck's boards run along its longer side. */
export function rectDeckRunsAlongX(p) {
  return Math.abs(p.x1 - p.x0) >= Math.abs(p.y1 - p.y0);
}

/** The frame of a rectangle deck (the kind the Block tool lays). */
export function deckFrameFromRect(p) {
  const w = Math.abs(p.x1 - p.x0), d = Math.abs(p.y1 - p.y0);
  const alongX = rectDeckRunsAlongX(p);
  return {
    center: { x: (p.x0 + p.x1) / 2, y: (p.y0 + p.y1) / 2 },
    z: p.z,
    along: alongX ? { x: 1, y: 0 } : { x: 0, y: 1 },
    alongFt: alongX ? w : d,
    across: alongX ? { x: 0, y: 1 } : { x: 1, y: 0 },
    acrossFt: alongX ? d : w,
  };
}

/** The direction the boards run for a placement, as an axis angle in [0, PI). */
export function plankRunAxis(ledger) {
  const a = Math.atan2(ledger.b[1] - ledger.a[1], ledger.b[0] - ledger.a[0]) + Math.PI / 2;
  return ((a % Math.PI) + Math.PI) % Math.PI;
}

/** True when two axis angles are the same line. */
export function sameRunAxis(a, b) {
  const d = Math.abs(((a - b) % Math.PI + Math.PI) % Math.PI);
  return Math.min(d, Math.PI - d) < 0.05;
}

/**
 * The same opening decked the other way, as ScaffoldPro's R does it: boards
 * spanning the OTHER pair of ledgers round the bay, so they run square to how
 * they ran. Returns { ledgerId, sideSign }, or null when the opening is bounded
 * one way only and so can only be decked one way.
 */
export function crossPlankPlacement(sourceLedger, ledgers, sideSign) {
  const pair = buildSupportPair(sourceLedger, ledgers, sideSign);
  if (!pair) return null;
  const { source, signedOffsetFt, overlapMinFt, overlapMaxFt } = pair;
  const centre = {
    x: source.mid.x + source.dir.x * (overlapMinFt + overlapMaxFt) / 2 + source.perp.x * signedOffsetFt / 2,
    y: source.mid.y + source.dir.y * (overlapMinFt + overlapMaxFt) / 2 + source.perp.y * signedOffsetFt / 2,
  };
  // The bay's ends: ledgers square to this pair, at either end of the overlap.
  const ends = [];
  for (const l of ledgers) {
    if (l.id === sourceLedger.id || Math.abs((l.a[2] + l.b[2]) / 2 - source.z) > 1 / 12) continue;
    const dx = l.b[0] - l.a[0], dy = l.b[1] - l.a[1], len = Math.hypot(dx, dy);
    if (len < 1 || Math.abs((dx * source.dir.x + dy * source.dir.y) / len) > 0.15) continue;
    const mid = { x: (l.a[0] + l.b[0]) / 2, y: (l.a[1] + l.b[1]) / 2 };
    const along = (mid.x - source.mid.x) * source.dir.x + (mid.y - source.mid.y) * source.dir.y;
    const atEnd = Math.min(Math.abs(along - overlapMinFt), Math.abs(along - overlapMaxFt));
    if (atEnd < 0.25) ends.push({ ledger: l, along });
  }
  ends.sort((p, q) => p.along - q.along);
  for (const { ledger } of ends) {
    const frameDir = { x: ledger.b[0] - ledger.a[0], y: ledger.b[1] - ledger.a[1] };
    const len = Math.hypot(frameDir.x, frameDir.y);
    const perp = { x: -frameDir.y / len, y: frameDir.x / len };
    const mid = { x: (ledger.a[0] + ledger.b[0]) / 2, y: (ledger.a[1] + ledger.b[1]) / 2 };
    const side = (centre.x - mid.x) * perp.x + (centre.y - mid.y) * perp.y >= 0 ? 1 : -1;
    const crossPair = buildSupportPair(ledger, ledgers, side);
    if (!crossPair) continue;
    const r = plankRectFromPair(crossPair);
    // Only the same opening counts: the cross bay must sit where this one does.
    if (Math.hypot((r.x0 + r.x1) / 2 - centre.x, (r.y0 + r.y1) / 2 - centre.y) < 0.5) {
      return { ledgerId: ledger.id, sideSign: side };
    }
  }
  return null;
}

function hasPlacement(existing, ledgerId, sideSign) {
  return existing.some(p => p.ledgerId === ledgerId && p.sideSign === sideSign);
}

/** Resolve a placement to its bay, boards and footprint. */
export function resolvePlankPlacement(placement, ledgers) {
  const sourceLedger = ledgers.find(l => l.id === placement.ledgerId);
  if (!sourceLedger) return null;
  const pair = buildSupportPair(sourceLedger, ledgers, placement.sideSign);
  if (!pair) return null;
  const boards = buildPlankBoardsFromPair(placement.id, pair);
  if (!boards.length) return null;
  const rect = plankRectFromPair(pair);
  return {
    id: placement.id,
    placement,
    pair,
    boards,
    ...rect,
    frame: deckFrameFromPair(pair),
    widthFt: Math.abs(pair.signedOffsetFt),
    lengthFt: pair.overlapLengthFt,
    areaSqFt: Math.abs(pair.signedOffsetFt) * pair.overlapLengthFt,
  };
}

/** Preview for hovering one ledger side; null if that bay is already decked. */
export function buildPlankPreviewForLedger(sourceLedger, ledgers, sideSign, existing = []) {
  if (hasPlacement(existing, sourceLedger.id, sideSign)) return null;
  const placement = { id: `preview:${sourceLedger.id}:${sideSign}`, ledgerId: sourceLedger.id, sideSign };
  const resolved = resolvePlankPlacement(placement, ledgers);
  if (!resolved) return null;
  return { placement, deck: resolved };
}

/** Resolve every stored placement. */
export function buildPlankDecks(placements, ledgers) {
  const out = [];
  for (const placement of placements) {
    const resolved = resolvePlankPlacement(placement, ledgers);
    if (resolved) out.push(resolved);
  }
  return out;
}

/** SHIFT batch: every bay along the connected run of ledgers at this lift. */
export function computePlankBatchPreview(sourceLedger, ledgers, sideSign, existing = []) {
  return collinearRun(sourceLedger, ledgers)
    .map(ledger => buildPlankPreviewForLedger(ledger, ledgers, sideSign, existing))
    .filter(preview => preview !== null);
}
