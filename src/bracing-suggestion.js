import { summarizeChecks } from './check-verdict.js';

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
