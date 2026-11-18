// Per-bay live load placement and one-way load distribution.
//
// Ported from ScaffoldPro's manualSupportSpan.ts + manualLiveLoadPlacement.ts,
// rewritten without three.js so it stays unit-testable in Node.
//
// A live load is stored as a *placement*: a supporting ledger plus which side of
// it the load sits on. The bay is resolved at read time by finding the nearest
// parallel ledger on that side at the same lift, so the patch follows the model
// when members move. Each bay carries its own psf, which is the point of the
// feature: a 25 psf walkway and a 75 psf material bay can coexist.
//
// Distribution is one-way, matching the source: the patch is meshed into cells
// of at most 1 ft, each cell's weight is split between the two supporting
// ledgers in inverse proportion to its distance across the bay, and each
// resulting ledger point load is then split between the two legs at that
// ledger's ends (simply supported). This is the same takeoff the DXF/RISA export
// assumes, so leg loads agree with the analysis model.

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
export const DEFAULT_BAY_LIVE_LOAD_PSF = 50;

// --- placements --------------------------------------------------------------

function instanceFromResolved(resolved) {
  return {
    id: resolved.placement.id,
    center: resolved.center,
    rotationZ: resolved.rotationZ,
    lengthFt: resolved.lengthFt,
    widthFt: resolved.widthFt,
    psf: resolved.placement.psf,
    areaSqFt: resolved.areaSqFt,
    totalLb: resolved.areaSqFt * resolved.placement.psf,
    ledgerId: resolved.placement.ledgerId,
    sideSign: resolved.placement.sideSign,
  };
}

/** Resolve a stored placement against the current ledgers. */
export function resolveLiveLoadPlacement(placement, ledgers) {
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

  return {
    placement,
    supportPair,
    center: [cx, cy, src.z + LIVE_LOAD_SURFACE_Z_OFFSET_FT],
    rotationZ,
    lengthFt,
    widthFt,
    areaSqFt: lengthFt * widthFt,
  };
}

/**
 * Mesh the patch and hand each cell's share to the two supporting ledgers.
 * Load splits across the bay in inverse proportion to distance (one-way).
 */
export function forEachLiveLoadContribution(resolved, callback, maxCellSizeFt = LIVE_LOAD_MESH_MAX_CELL_SIZE_FT) {
  const { widthFt, lengthFt } = resolved;
  if (widthFt <= 1e-6 || lengthFt <= 1e-6) return;

  const cell = Math.max(maxCellSizeFt, 1e-3);
  const cellsAlong = Math.max(1, Math.ceil(lengthFt / cell));
  const cellsAcross = Math.max(1, Math.ceil(widthFt / cell));
  const cellLengthFt = lengthFt / cellsAlong;
  const cellWidthFt = widthFt / cellsAcross;
  const pair = resolved.supportPair;

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
export function buildLiveLoadInstances(placements, ledgers) {
  const out = [];
  for (const placement of placements) {
    const resolved = resolveLiveLoadPlacement(placement, ledgers);
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
