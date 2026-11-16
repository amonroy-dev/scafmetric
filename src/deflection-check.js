/**
 * Serviceability: maximum service-load (1.0D + 1.0L) deflection against a
 * span / n limit. Units: feet for the span, inches for deflection.
 *
 * L/240 is this calculator's preliminary support-beam serviceability criterion.
 * OSHA 29 CFR 1926.451(f)(16) and ANSI/ASSP A10.8-2019 section 5.1.1.3 give
 * span / 60 platform-deflection provisions. Those provisions do not establish
 * this selected support-beam criterion. A qualified designer must confirm the
 * applicable project requirements; see docs/scaffold-factors.md for sources.
 *
 * The check uses the adjusted (reduced-EI) deflection by default: the value the
 * calculator shows, plots and animates, and the larger of the two.
 */
export const DEFLECTION_LIMITS = Object.freeze([240, 360, 180]);
export const DEFAULT_DEFLECTION_LIMIT = 240;

export function checkDeflection({ analysis, limitRatio = DEFAULT_DEFLECTION_LIMIT, basis = 'reducedDeflectionIn' } = {}) {
  const unavailable = reason => ({ status: 'not_evaluated', reason });
  if (!analysis?.maxDeflection || !analysis.input) return unavailable('No service analysis is available.');
  if (!Number.isFinite(limitRatio) || limitRatio <= 0) return unavailable('Select a deflection limit.');
  if (!['reducedDeflectionIn', 'nominalDeflectionIn'].includes(basis)) return unavailable('Select a supported deflection basis.');
  const spanFt = analysis.input.spanFt;
  const allowableIn = spanFt * 12 / limitRatio;
  const deflectionIn = analysis.maxDeflection[basis];
  const utilization = deflectionIn / allowableIn;
  if (![spanFt, allowableIn, deflectionIn, utilization].every(Number.isFinite) || allowableIn <= 0) return unavailable('The deflection limit could not be evaluated from these values.');
  return Object.freeze({
    status: 'evaluated', limitRatio, basis, spanFt, allowableIn, deflectionIn,
    xFt: analysis.maxDeflection.xFt, nominalDeflectionIn: analysis.maxDeflection.nominalDeflectionIn,
    stiffnessFactor: analysis.input.stiffnessFactor, utilization, meets: utilization <= 1
  });
}
