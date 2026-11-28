import { summarizeChecks } from './check-verdict.js';
import { resolveFlangeBracing } from './bracing.js';
import { screeningInputs, sectionResponses, screenSection, flexureFor } from './suggest-beam-size.js';

const ltbStates = new Set(['inelastic LTB', 'elastic LTB']);
const positive = value => Number.isFinite(value) && value > 0;

// Offer a review of lateral bracing only when reducing LTB could resolve every
// listed failure in this model. This neither selects brace positions nor checks
// the strength or stiffness of any proposed brace.
export function canConsiderLateralBracing(checks) {
  if (!checks || typeof checks !== 'object') return false;
  const summary = summarizeChecks(checks);
  if (summary.status !== 'fail' || summary.unavailable.length || !summary.failed.every(item => item.kind === 'strength' && item.name.endsWith(' bending'))) return false;

  const flexures = [checks.flexure, ...(checks.extra ? [checks.extra.bending] : [])];
  let failedLtb = false;
  for (const flexure of flexures) {
    if (flexure?.status !== 'evaluated' || !positive(flexure.MpKipFt) || !positive(flexure.omegaB) || !Array.isArray(flexure.segments) || !flexure.segments.length) return false;
    const flangeStrength = flexure.flangeLocalBuckling == null ? flexure.MpKipFt : flexure.flangeLocalBuckling.MnKipFt;
    if (!positive(flangeStrength)) return false;
    const fullyBracedAllowable = Math.min(flexure.MpKipFt, flangeStrength) / flexure.omegaB;
    if (!positive(fullyBracedAllowable)) return false;
    for (const segment of flexure.segments) {
      if (!segment || !Number.isFinite(segment.MmaxKipFt) || segment.MmaxKipFt < 0 || !Number.isFinite(segment.utilization) || segment.utilization < 0 || segment.MmaxKipFt > fullyBracedAllowable) return false;
      if (segment.utilization > 1) {
        if (!ltbStates.has(segment.limitState)) return false;
        failedLtb = true;
      }
    }
  }
  return failedLtb;
}

// The widest spacing ever suggested, even where wider bracing would pass: 5 ft
// O.C. is as far apart as Scafmetric recommends braces on a scaffold beam.
export const MAX_BRACE_SPACING_FT = 5;
// Closer than this is not a layout anyone would build, and it is never needed:
// every library W shape has Lp over 2.5 ft, so 2 ft O.C. already braces it fully.
export const MIN_BRACE_SPACING_FT = 2;

/** Braces `spacingFt` apart from the left support, short of the right one. */
export function braceLocationsAt(spacingFt, spanFt) {
  const locations = [];
  for (let k = 1; k * spacingFt < spanFt - 1e-9; k++) locations.push(k * spacingFt);
  return locations;
}

/**
 * Lateral bracing that makes the section in hand pass every listed check: the
 * widest spacing at which it does, tried in whole feet from 5 ft down. Never
 * wider than 5 ft O.C., even when wider bracing would pass. On a span of 10 ft
 * or less, one brace at midspan comes first when half the span is not a whole
 * number of feet.
 *
 * The spacing is a maximum, good for any layout with braces no farther apart,
 * not only the one returned: the largest moment anywhere on the span is held to
 * the strength of a segment that long with Cb = 1, the least any such segment
 * can have. So "5' O.C." stays true wherever the crew starts measuring, and
 * whatever Cb method the calculator is set to. The layout returned, measured
 * from the left support, is also run through the calculator's own checks.
 *
 * Bracing changes neither shear nor deflection, and adds no strength once the
 * segments are no longer than Lp. So when shear or deflection fails, or bending
 * fails even fully braced, this returns null: no bracing makes it pass.
 *
 * The braces go on both flanges, as the calculator records them; the top
 * (compression) flange's set the unbraced lengths. The braces' own strength,
 * stiffness and connections are not checked.
 */
export function suggestBraceSpacing({ section, Iin4 = section?.Ix, ...beam } = {}) {
  const inputs = screeningInputs(beam);
  const span = inputs.spanFt;
  const unbraced = screenSection(section, inputs, resolveFlangeBracing({ spanFt: span, bracesFt: [0, span] }), Iin4);
  if ([unbraced.shearRatio, unbraced.comparisonShearRatio, unbraced.deflectionRatio].some(ratio => ratio !== null && ratio > 1)) return null;
  const r = sectionResponses(section, inputs, Iin4);
  const demands = [r.service, r.bending].filter(Boolean);

  // At least one brace, so no wider than half the span; and never wider than 5 ft.
  const widest = Math.min(MAX_BRACE_SPACING_FT, span / 2);
  const spacings = Number.isInteger(widest) || widest < MIN_BRACE_SPACING_FT ? [] : [widest];
  for (let s = Math.floor(widest); s >= MIN_BRACE_SPACING_FT; s--) spacings.push(s);
  for (const spacingFt of spacings) {
    const locationsFt = braceLocationsAt(spacingFt, span);
    const bracing = resolveFlangeBracing({ spanFt: span, bracesFt: [0, ...locationsFt, span] });
    let holds = true, fullyBraced = true;
    for (const analysis of demands) {
      const flexure = flexureFor(section, analysis, bracing, 'unity');
      const momentKipFt = Math.max(...flexure.segments.map(segment => segment.MmaxKipFt));
      // The first segment runs from the support to the first brace: a full spacing long.
      if (momentKipFt > flexure.segments[0].allowableKipFt) holds = false;
      if (spacingFt > flexure.LpFt) fullyBraced = false;
    }
    if (holds && screenSection(section, inputs, bracing, Iin4).passes) {
      return Object.freeze({ spacingFt, locationsFt: Object.freeze(locationsFt), midspan: locationsFt.length === 1 });
    }
    // Braced to Lp or closer, bending is as strong as it gets.
    if (fullyBraced) return null;
  }
  return null;
}
