/**
 * User-proposed load multipliers for comparison only, not verified load combinations.
 * These do not establish OSHA compliance, capacity or serviceability.
 * Units are kip/ft for loads and ft for span. Beam self-weight is included once.
 */
export function requestedLoadComparison({ selection, deadLoadKipFt, liveLoadKipFt, selfWeightKipFt, spanFt }) {
  if (selection === 'none') return null;
  const numerator = { 'four': 4, 'two-and-half': 2.5 }[selection];
  if (numerator === undefined) throw new Error('Select a supported comparison.');
  for (const x of [deadLoadKipFt, liveLoadKipFt, selfWeightKipFt, spanFt]) {
    if (!Number.isFinite(x) || x < 0) throw new Error('Comparison inputs must be finite and nonnegative.');
  }
  if (spanFt === 0) throw new Error('Span must be greater than zero.');
  const multiplier = numerator / 1.67;
  const totalKipFt = deadLoadKipFt + selfWeightKipFt + multiplier * liveLoadKipFt;
  return Object.freeze({ numerator, multiplier, totalKipFt, reactionKip: totalKipFt * spanFt / 2, momentKipFt: totalKipFt * spanFt ** 2 / 8 });
}
