// Map selected scaffold legs onto a beam and turn their reactions into beam
// point loads. The beam is positioned in the scaffold's ground plane; each leg's
// EXACT distance from the beam's left support is preserved at full precision, and
// legs that fall outside the span or off the beam line are flagged rather than
// silently clamped. Dead and live magnitudes stay separate all the way through.

// Build a beam placement from the world coordinates of its two supports.
//   leftSupport / rightSupport: [x, y] in scaffold feet.
export function beamFromSupports(leftSupport, rightSupport, { offToleranceFt = 0.5 } = {}) {
  const [lx, ly] = leftSupport;
  const [rx, ry] = rightSupport;
  const dx = rx - lx;
  const dy = ry - ly;
  const spanFt = Math.hypot(dx, dy);
  if (!(spanFt > 0)) throw new Error('Beam supports must be two distinct points.');
  return {
    origin: [lx, ly],
    dir: [dx / spanFt, dy / spanFt],
    spanFt,
    offToleranceFt,
  };
}

// Resolve one leg against the beam axis. Returns the along-beam distance from the
// left support (full precision), the perpendicular offset, and classification.
export function locateLegOnBeam(leg, beam) {
  const [ox, oy] = beam.origin;
  const [ux, uy] = beam.dir;
  const px = leg.x - ox;
  const py = leg.y - oy;
  const along = px * ux + py * uy;             // distance from left support
  const perp = Math.abs(px * uy - py * ux);    // signed-cross magnitude = offset
  const eps = 1e-9;
  const onSpan = along >= -eps && along <= beam.spanFt + eps;
  const onBeam = perp <= beam.offToleranceFt + eps;
  return { leg, locationFt: along, perpFt: perp, onSpan, onBeam };
}

export function mapLegsToBeam(legs, beam) {
  if (!Array.isArray(legs)) throw new Error('legs must be an array.');
  return legs.map(leg => locateLegOnBeam(leg, beam));
}

// With a great many legs picked, only lines through one of the first of them
// are tried, which keeps a box dragged round a whole job from stalling the page.
const LINE_SEARCH_LEGS = 60;

// The line that passes through the most of these legs: { anchor, ux, uy }, or
// null when they all stand on one spot. Where two lines tie, the one through
// the earlier-picked leg is kept.
function lineThroughMostLegs(legs, toleranceFt) {
  let best = null;
  const tried = Math.min(legs.length, LINE_SEARCH_LEGS);
  for (let i = 0; i < tried; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const dx = legs[j].x - legs[i].x, dy = legs[j].y - legs[i].y;
      const len = Math.hypot(dx, dy);
      if (!(len > toleranceFt)) continue;
      const ux = dx / len, uy = dy / len;
      let count = 0;
      for (const l of legs) {
        if (Math.abs((l.x - legs[i].x) * uy - (l.y - legs[i].y) * ux) <= toleranceFt + 1e-9) count++;
      }
      if (!best || count > best.count) best = { count, anchor: legs[i], ux, uy };
    }
  }
  return best;
}

// Lay the beam under the legs picked for it.
//
// The legs a beam carries stand in one line, so the beam's line is read from
// the picks themselves: it is the line through the most of them. Two legs make
// a line; a leg that is not in line with the rest is flagged (onBeam false)
// rather than sent. The beam's left end is the end further left in plan, or
// further to the front for a beam running front to back, and the first leg on
// the line stands `firstLegFt` in from the left support.
//
//   legs: [{ id, x, y, deadLb, liveLb }], in the order they were picked.
// Returns { beam, located, directed }:
//   beam      the placement, shaped as beamFromSupports gives it; null with no legs
//   located   every picked leg resolved against it, as mapLegsToBeam gives them
//   directed  false when one leg alone leaves the beam's direction open (it is
//             then laid left to right, which changes nothing about the load)
export function beamUnderPickedLegs(legs, spanFt, { firstLegFt = 0, offToleranceFt = 0.5 } = {}) {
  if (!Array.isArray(legs)) throw new Error('legs must be an array.');
  if (!(spanFt > 0)) throw new Error('The beam span must be greater than zero.');
  if (!legs.length) return { beam: null, located: [], directed: false };
  const firstFt = Number.isFinite(firstLegFt) && firstLegFt > 0 ? firstLegFt : 0;
  const place = (x, y, ux, uy) => ({ origin: [x - firstFt * ux, y - firstFt * uy], dir: [ux, uy], spanFt, offToleranceFt });

  const line = lineThroughMostLegs(legs, offToleranceFt);
  if (!line) {
    const beam = place(legs[0].x, legs[0].y, 1, 0);
    return { beam, located: mapLegsToBeam(legs, beam), directed: false };
  }
  // Left to right as the plan is drawn; front to back for a beam that runs that way.
  let { ux, uy } = line;
  if (Math.abs(ux) >= Math.abs(uy) ? ux < 0 : uy < 0) { ux = -ux; uy = -uy; }
  ux += 0; uy += 0; // a turned zero is still zero
  // The first leg on the line, measured along it from the leg the line was found from.
  const { anchor } = line;
  let startFt = Infinity;
  for (const l of legs) {
    const px = l.x - anchor.x, py = l.y - anchor.y;
    if (Math.abs(px * uy - py * ux) <= offToleranceFt + 1e-9) startFt = Math.min(startFt, px * ux + py * uy);
  }
  const beam = place(anchor.x + startFt * ux, anchor.y + startFt * uy, ux, uy);
  return { beam, located: mapLegsToBeam(legs, beam), directed: true };
}

// A leg as the beam form is given it: whole pounds, and its distance to a
// hundredth of a foot (an eighth of an inch). The takeoff works in fractions of
// a pound, and carried over as they were a leg read "2,103.8769 lbs" on the
// beam diagram, which at a glance is a load a thousand times its size. Dead and
// live are rounded each on its own, so the two fields add up to the total the
// builder shows for the leg (wholePoundsOnLeg).
export function forBeamForm(entry) {
  return {
    legId: entry.legId,
    deadLb: Math.round(entry.deadLb) + 0,
    liveLb: Math.round(entry.liveLb) + 0,
    locationFt: Math.round(entry.locationFt * 100) / 100 + 0,
  };
}

// The load on a leg in whole pounds, as its tag in the builder shows it and as
// the beam form receives it: dead and live each rounded, then added.
export function wholePoundsOnLeg(leg) {
  return Math.round(leg.deadLb) + Math.round(leg.liveLb);
}

// Convert located legs into importable beam point loads (pounds), keeping dead and
// live separate. By default only legs that are both on the span and on the beam
// line are imported; off-beam legs are returned separately so the UI can warn.
export function toBeamPointLoads(located, { includeOffBeam = false } = {}) {
  const imported = [];
  const skipped = [];
  for (const rec of located) {
    const usable = rec.onSpan && rec.onBeam;
    const entry = {
      legId: rec.leg.id,
      deadLb: rec.leg.deadLb,
      liveLb: rec.leg.liveLb,
      locationFt: rec.locationFt,
      perpFt: rec.perpFt,
      onSpan: rec.onSpan,
      onBeam: rec.onBeam,
    };
    if (usable || includeOffBeam) imported.push(entry);
    else skipped.push(entry);
  }
  return { imported, skipped };
}
