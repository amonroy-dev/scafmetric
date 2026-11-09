/**
 * User-proposed load multipliers for comparison only, not verified load combinations.
 * These do not establish OSHA compliance, capacity or serviceability.
 * Units are kip/ft for loads and ft for span. Beam self-weight is included once.
 */
export function requestedLoadComparison({ selection, deadLoadKipFt, liveLoadKipFt, selfWeightKipFt, spanFt, customSafetyFactor }) {
  if (selection === 'none') return null;
  if (!['four', 'custom'].includes(selection)) throw new Error('Select a supported comparison.');
  const numerator = selection === 'four' ? 4 : customSafetyFactor;
  if (!Number.isFinite(numerator) || numerator < 1) throw new Error('Enter a custom safety factor of at least 1.');
  for (const x of [deadLoadKipFt, liveLoadKipFt, selfWeightKipFt, spanFt]) {
    if (!Number.isFinite(x) || x < 0) throw new Error('Comparison inputs must be finite and nonnegative.');
  }
  if (spanFt === 0) throw new Error('Span must be greater than zero.');
  const multiplier = numerator / 1.67;
  const totalKipFt = deadLoadKipFt + selfWeightKipFt + multiplier * liveLoadKipFt;
  const reactionKip = totalKipFt * spanFt / 2;
  const momentKipFt = totalKipFt * spanFt ** 2 / 8;
  if (![multiplier, totalKipFt, reactionKip, momentKipFt].every(Number.isFinite)) throw new Error('The comparison values are too large.');
  return Object.freeze({ numerator, multiplier, totalKipFt, reactionKip, momentKipFt });
}
