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
