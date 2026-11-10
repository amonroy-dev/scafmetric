/** Separate service and user-proposed ASD comparison loads, in kip/ft.
 * These are arithmetic demand comparisons, not an OSHA or overall compliance check.
 * The selected safety factor is applied only to the entered live load. */
export function strengthComparisonLoads({ dead, live, self, safetyFactor }) {
  if (![dead, live, self].every(x => Number.isFinite(x) && x >= 0)) throw new Error('Loads must be finite and nonnegative.');
  if (!Number.isFinite(safetyFactor) || safetyFactor < 1) throw new Error('Safety factor must be at least 1.');
  const service = dead + self + live;
  const bending = dead + self + safetyFactor / 1.67 * live;
  const shear = dead + self + safetyFactor / 1.5 * live;
  if (![service, bending, shear].every(Number.isFinite)) throw new Error('Comparison loads are too large.');
  return Object.freeze({ service, bending, shear });
}
