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

/** Board top sits on the ledger tube, so the profile centre drops half a depth. */
export function plankSeatOffsetFt() {
  return inchesToFeet(LEDGER_TUBE_OD_IN / 2) - inchesToFeet(PLANK.profileDepthIn) / 2;
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
