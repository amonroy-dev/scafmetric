// Support-span geometry: given one ledger and a side, find the bay it encloses
// with the nearest parallel ledger at the same lift.
//
// Ported from ScaffoldPro's manualSupportSpan.ts, without three.js. Both the
// plank tool and the live load tool are built on this: in the source app you
// hover a LEDGER and pick a side, and the bay between that ledger and its
// opposite neighbour is what gets decked or loaded.

export const LEDGER_TUBE_OD_IN = 1.9;
export const MIN_LEDGER_LENGTH_FT = 1;
export const MIN_SUPPORT_OFFSET_FT = 0.5;
export const PARALLEL_DOT_THRESHOLD = 0.985;
export const SAME_LIFT_TOL_FT = 1 / 12;
export const MIN_OVERLAP_FT = 0.5;

export const inchesToFeet = i => i / 12;
export const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

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

// --- batch runs --------------------------------------------------------------
// Both the plank and live load tools use SHIFT to fill every bay along the
// connected run of collinear ledgers at this lift. Tolerances from the source.

export const BATCH_SAME_LIFT_TOL_FT = inchesToFeet(1);
export const BATCH_SAME_LINE_TOL_FT = inchesToFeet(2);
export const BATCH_TOUCH_TOL_FT = inchesToFeet(2);

/**
 * Ledgers forming the connected collinear run through `sourceLedger`, ordered
 * along the run. Flood-filled through touching neighbours on the same line.
 */
export function collinearRun(sourceLedger, ledgers) {
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
    .map(frame => frame.ledger);
}
