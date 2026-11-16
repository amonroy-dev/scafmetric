// Point-load records retain separate dead and live magnitudes in kips. Older
// records with only loadKip are interpreted as live-only, matching prior runs.
function normalizePoint(point, spanFt = Infinity) {
  if (!point || typeof point !== 'object' || Array.isArray(point)) throw new Error('Point loads must contain valid load records.');
  const split = 'deadKip' in point || 'liveKip' in point;
  const deadKip = split && 'deadKip' in point ? point.deadKip : 0;
  const liveKip = split ? ('liveKip' in point ? point.liveKip : 0) : point.loadKip;
  const locationFt = point.locationFt;
  if (![deadKip, liveKip].every(value => Number.isFinite(value) && value >= 0)) throw new Error('Point loads require finite nonnegative dead and live magnitudes.');
  if (!Number.isFinite(locationFt) || locationFt < 0 || locationFt > spanFt) throw new Error('Point loads must be located between the supports.');
  const loadKip = deadKip + liveKip;
  if (!Number.isFinite(loadKip)) throw new Error('Point loads are too large.');
  return { ...point, deadKip, liveKip, loadKip, locationFt };
}

export function normalizePointLoads(pointLoads, spanFt) {
  if (!Array.isArray(pointLoads)) throw new Error('Point loads must be an array.');
  if (!Number.isFinite(spanFt) || spanFt <= 0) throw new Error('Point loads require a positive finite span.');
  return pointLoads.map(point => normalizePoint(point, spanFt));
}

// Physical beam analysis needs the combined force in pounds. Only the live
// portion receives the selected comparison multiplier; dead load stays at 1.0.
export function pointLoadsForAnalysis(pointLoads, liveMultiplier = 1) {
  if (!Array.isArray(pointLoads)) throw new Error('Point loads must be an array.');
  if (!Number.isFinite(liveMultiplier) || liveMultiplier < 0) throw new Error('Point-load live multiplier must be finite and nonnegative.');
  return pointLoads.map(point => {
    const { deadKip, liveKip, locationFt } = normalizePoint(point);
    const loadLb = (deadKip + liveMultiplier * liveKip) * 1000;
    if (!Number.isFinite(loadLb)) throw new Error('Point loads are too large.');
    return { loadLb, locationFt };
  });
}
