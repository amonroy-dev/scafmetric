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

import { inchesToFeet, STANDARD_TUBE_OD_IN } from './parts.js';

export const MIN_LEDGER_LENGTH_FT = 1;
export const MIN_SUPPORT_OFFSET_FT = 0.5;
export const PARALLEL_DOT_THRESHOLD = 0.985;
export const SAME_LIFT_TOL_FT = 1 / 12;
export const MIN_OVERLAP_FT = 0.5;

// Batch ("fill the run") tolerances.
const BATCH_SAME_LIFT_TOL_FT = inchesToFeet(1);
const BATCH_SAME_LINE_TOL_FT = inchesToFeet(2);
const BATCH_TOUCH_TOL_FT = inchesToFeet(2);

export const LIVE_LOAD_SURFACE_Z_OFFSET_FT = inchesToFeet(STANDARD_TUBE_OD_IN / 2) + inchesToFeet(0.25);
export const LIVE_LOAD_MESH_MAX_CELL_SIZE_FT = 1;
export const DEFAULT_BAY_LIVE_LOAD_PSF = 50;

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// --- 2D frames ---------------------------------------------------------------

/**
 * Plan-view frame of a ledger: its axis, perpendicular and lift height.
 * Returns null for ledgers too short to support a bay.
 */
export function getSupportFrame(ledger) {
  if (!ledger || !ledger.a || !ledger.b) return null;
  const start = { x: ledger.a[0], y: ledger.a[1] };
  const end = { x: ledger.b[0], y: ledger.b[1] };
  let dx = end.x - start.x;
  let dy = end.y - start.y;
  const lengthFt = Math.hypot(dx, dy);
  if (!(lengthFt >= MIN_LEDGER_LENGTH_FT)) return null;
  dx /= lengthFt; dy /= lengthFt;
  return {
    ledger,
    start,
    end,
    mid: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    dir: { x: dx, y: dy },
    perp: { x: -dy, y: dx },
    lengthFt,
    z: (ledger.a[2] + ledger.b[2]) / 2,
  };
}

/** Extent of a frame along the source axis, measured from `origin`. */
export function computeSupportAxisInterval(frame, origin) {
  const center = (frame.mid.x - origin.x) * frame.dir.x + (frame.mid.y - origin.y) * frame.dir.y;
  return { min: center - frame.lengthFt / 2, max: center + frame.lengthFt / 2 };
}

/**
 * Nearest parallel ledger on the given side at the same lift, with enough
 * overlap to form a bay.
 */
export function findOppositeSupportFrame(source, ledgers, sideSign) {
  let best = null;
  let bestOffset = Infinity;
  const sourceInterval = { min: -source.lengthFt / 2, max: source.lengthFt / 2 };

  for (const candidate of ledgers) {
    if (candidate.id === source.ledger.id) continue;
    const frame = getSupportFrame(candidate);
    if (!frame) continue;
    if (Math.abs(frame.z - source.z) > SAME_LIFT_TOL_FT) continue;
    const dot = source.dir.x * frame.dir.x + source.dir.y * frame.dir.y;
    if (Math.abs(Math.abs(dot) - 1) > 1 - PARALLEL_DOT_THRESHOLD) continue;

    const dxm = frame.mid.x - source.mid.x;
    const dym = frame.mid.y - source.mid.y;
    const signedOffset = dxm * source.perp.x + dym * source.perp.y;
    if (signedOffset * sideSign <= MIN_SUPPORT_OFFSET_FT) continue;

    const interval = computeSupportAxisInterval(frame, source.mid);
    const overlap = Math.min(sourceInterval.max, interval.max) - Math.max(sourceInterval.min, interval.min);
    if (overlap < MIN_OVERLAP_FT) continue;

    const absOffset = Math.abs(signedOffset);
    if (absOffset < bestOffset) { bestOffset = absOffset; best = frame; }
  }
  return best;
}

/** The bay: two parallel ledgers, their offset and their overlapping run. */
export function buildSupportPair(sourceLedger, ledgers, sideSign) {
  const source = getSupportFrame(sourceLedger);
  if (!source) return null;
  const target = findOppositeSupportFrame(source, ledgers, sideSign);
  if (!target) return null;

  const sourceInterval = { min: -source.lengthFt / 2, max: source.lengthFt / 2 };
  const targetInterval = computeSupportAxisInterval(target, source.mid);
  const overlapMinFt = Math.max(sourceInterval.min, targetInterval.min);
  const overlapMaxFt = Math.min(sourceInterval.max, targetInterval.max);
  const overlapLengthFt = overlapMaxFt - overlapMinFt;
  if (overlapLengthFt < MIN_OVERLAP_FT) return null;

  const signedOffsetFt =
    (target.mid.x - source.mid.x) * source.perp.x + (target.mid.y - source.mid.y) * source.perp.y;
  if (Math.abs(signedOffsetFt) <= MIN_SUPPORT_OFFSET_FT) return null;

  return { source, target, signedOffsetFt, overlapMinFt, overlapMaxFt, overlapLengthFt };
}

/** Point on `frame` closest to the given station on the source axis. */
export function projectAxisPointToSupportFrame(frame, axisOrigin, axisDir, axisPositionFt) {
  const px = axisOrigin.x + axisDir.x * axisPositionFt;
  const py = axisOrigin.y + axisDir.y * axisPositionFt;
  const offset = clamp((px - frame.start.x) * frame.dir.x + (py - frame.start.y) * frame.dir.y, 0, frame.lengthFt);
  return { x: frame.start.x + frame.dir.x * offset, y: frame.start.y + frame.dir.y * offset };
}

/** Which side of a ledger a picked point falls on. */
export function getLedgerSideSign(ledger, point) {
  const frame = getSupportFrame(ledger);
  if (!frame) return 1;
  const dx = point.x - frame.mid.x;
  const dy = point.y - frame.mid.y;
  return dx * frame.perp.x + dy * frame.perp.y >= 0 ? 1 : -1;
}

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
  const source = getSupportFrame(sourceLedger);
  if (!source) return [];

  const sameLine = ledgers
    .map(getSupportFrame)
    .filter(frame => frame !== null)
    .filter(frame => {
      if (Math.abs(frame.z - source.z) > BATCH_SAME_LIFT_TOL_FT) return false;
      const dot = source.dir.x * frame.dir.x + source.dir.y * frame.dir.y;
      if (Math.abs(Math.abs(dot) - 1) > 1 - PARALLEL_DOT_THRESHOLD) return false;
      const offset = (frame.mid.x - source.mid.x) * source.perp.x + (frame.mid.y - source.mid.y) * source.perp.y;
      return Math.abs(offset) <= BATCH_SAME_LINE_TOL_FT;
    });

  const byId = new Map(sameLine.map(frame => [frame.ledger.id, frame]));
  const component = new Set([source.ledger.id]);
  const queue = [source.ledger.id];

  while (queue.length > 0) {
    const current = byId.get(queue.shift() ?? '');
    if (!current) continue;
    const a = computeSupportAxisInterval(current, source.mid);
    for (const candidate of sameLine) {
      if (component.has(candidate.ledger.id)) continue;
      const b = computeSupportAxisInterval(candidate, source.mid);
      if (!(a.min <= b.max + BATCH_TOUCH_TOL_FT && b.min <= a.max + BATCH_TOUCH_TOL_FT)) continue;
      component.add(candidate.ledger.id);
      queue.push(candidate.ledger.id);
    }
  }

  return sameLine
    .filter(frame => component.has(frame.ledger.id))
    .sort((a, b) => computeSupportAxisInterval(a, source.mid).min - computeSupportAxisInterval(b, source.mid).min)
    .map(frame => buildLiveLoadPreviewForLedger(frame.ledger, ledgers, sideSign, existing, psf))
    .filter(preview => preview !== null);
}
