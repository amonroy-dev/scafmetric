import { analyzeBeam } from './beam.js';
import { beamSelfWeight } from './beam-self-weight.js';
import { checkFlexure } from './strength-flexure.js';
import { checkMajorAxisShear } from './strength-shear.js';
import { strengthComparisonLoads } from './strength-comparison.js';
import { resolveFlangeBracing } from './bracing.js';
import { normalizePointLoads, pointLoadsForAnalysis } from './point-loads.js';

/**
 * The beam a suggestion is worked for, validated once: span, loads, the Cb
 * method, the selected comparison safety factor and the deflection limit. Both
 * suggestions screen against it: another section (below), and bracing for the
 * section in hand (bracing-suggestion.js).
 */
export function screeningInputs({ spanFt, deadLoadKipFt, liveLoadKipFt, pointLoads = [], cbMethod = 'unity', safetyFactor = null, deflectionLimitRatio = null, stiffnessFactor = 1, Eksi = 29000, confirmedLateralBracing = false, confirmedScope = false } = {}) {
  if (!confirmedLateralBracing || !confirmedScope) throw new Error('Confirm the material, restraint and loading assumptions before suggesting a size.');
  if (Eksi !== 29000) throw new Error('Suggested sizes require E = 29,000 ksi and A992 steel.');
  if (!Number.isFinite(spanFt) || spanFt <= 0 || ![deadLoadKipFt, liveLoadKipFt].every(n => Number.isFinite(n) && n >= 0)) throw new Error('A positive span and finite nonnegative loads are required.');
  const points = normalizePointLoads(pointLoads, spanFt);
  if (!['unity', 'quarter'].includes(cbMethod)) throw new Error('Select a supported Cb method.');
  if (safetyFactor !== null && (!Number.isFinite(safetyFactor) || safetyFactor < 1)) throw new Error('Safety factor must be at least 1.');
  if (deflectionLimitRatio !== null && (!Number.isFinite(deflectionLimitRatio) || deflectionLimitRatio <= 0)) throw new Error('Deflection limit must be a positive span ratio.');
  if (!Number.isFinite(stiffnessFactor) || stiffnessFactor <= 0 || stiffnessFactor > 1) throw new Error('Stiffness factor must be greater than zero and at most 1.');
  return Object.freeze({ spanFt, deadLoadKipFt, liveLoadKipFt, points, cbMethod, safetyFactor, deflectionLimitRatio, stiffnessFactor, Eksi });
}

/**
 * How one W section responds, its own self-weight added to the loads: the
 * service analysis and, with a safety factor selected, the comparison analyses
 * for bending and for shear. Braces do not enter here; only the checks read them.
 * `Iin4` is the moment of inertia the deflection uses (the calculator lets it
 * be overridden); it defaults to the section's.
 */
export function sectionResponses(section, inputs, Iin4 = section?.Ix) {
  if (section?.Type !== 'W' || typeof section.AISC_Manual_Label !== 'string' || !section.AISC_Manual_Label || !Number.isFinite(Iin4) || Iin4 <= 0) throw new Error('Invalid W section.');
  const { spanFt, deadLoadKipFt: dead, liveLoadKipFt: live, points, safetyFactor, stiffnessFactor, Eksi } = inputs;
  const self = beamSelfWeight(section);
  // Strength results do not depend on stiffness; the deflection check uses the
  // calculator's stiffness factor so it matches the adjusted deflection shown.
  const base = { spanFt, Eksi, Iin4, stiffnessFactor };
  // Preserve point-load categories when comparing live loads. Eccentric
  // point loads also make the end reactions, and hence shear demand, unequal.
  const response = (load, pointMultiplier = 1) => analyzeBeam({ ...base, uniformLoadPlf: load * 1000, pointLoads: pointLoadsForAnalysis(points, pointMultiplier) });
  const service = response(dead + live + self);
  if (safetyFactor === null) return { self, service, bending: null, shear: null };
  const loads = strengthComparisonLoads({ dead, live, self, safetyFactor });
  return { self, service, bending: response(loads.bending, safetyFactor / 1.67), shear: response(loads.shear, safetyFactor / 1.5) };
}

/** AISC F2/F3 flexure on one analysis, with the given braces. */
export function flexureFor(section, analysis, bracing, cbMethod) {
  return checkFlexure({ section, analysis, topBracesFt: bracing.top.locations, bottomBracesFt: bracing.bottom.locations, cbMethod, Eksi: 29000, Fyksi: 50, confirmedLateralBracing: true, confirmedScope: true });
}

function shearRatio(section, analysis) {
  const shear = checkMajorAxisShear({ section, Eksi: 29000, FyKsi: 50, demandKip: Math.max(Math.abs(analysis.maxShear.shearLb), Math.abs(analysis.minShear.shearLb)) / 1000 });
  if (shear.status !== 'evaluated') throw new Error(shear.reason);
  return shear.utilization;
}

/**
 * Every listed check for one section, braced as given, as a ratio to its limit:
 * service bending and shear, the selected comparison's bending and shear, and
 * the service deflection limit. These are the checks the calculator runs, so a
 * section that passes here passes there. Throws when one cannot be worked.
 */
export function screenSection(section, inputs, bracing, Iin4 = section?.Ix) {
  const r = sectionResponses(section, inputs, Iin4);
  const { spanFt, cbMethod, deflectionLimitRatio } = inputs;
  const bendingRatio = flexureFor(section, r.service, bracing, cbMethod).governingSegment.utilization;
  const serviceShearRatio = shearRatio(section, r.service);
  const comparisonBendingRatio = r.bending ? flexureFor(section, r.bending, bracing, cbMethod).governingSegment.utilization : null;
  const comparisonShearRatio = r.shear ? shearRatio(section, r.shear) : null;
  const deflectionRatio = deflectionLimitRatio === null ? null : r.service.maxDeflection.reducedDeflectionIn / (spanFt * 12 / deflectionLimitRatio);
  const ratios = [bendingRatio, serviceShearRatio, ...(r.bending ? [comparisonBendingRatio, comparisonShearRatio] : []), ...(deflectionRatio === null ? [] : [deflectionRatio])];
  if (!ratios.every(Number.isFinite)) throw new Error('Invalid ratio.');
  return { bendingRatio, shearRatio: serviceShearRatio, comparisonBendingRatio, comparisonShearRatio, deflectionRatio, selfWeightKipFt: r.self, passes: ratios.every(n => n <= 1) };
}

/**
 * Find the lowest weight-per-foot catalog section that meets the implemented
 * AISC F2/F3 bending and G2.1(a) shear checks and, when a limit is given, the
 * service deflection limit (span / deflectionLimitRatio, using the same stiffness
 * factor as the calculator). This is preliminary candidate screening, not an
 * overall member, scaffold or compliance design. Each proposed section's
 * properties must be independently verified.
 */
export function suggestBeamSize({ sections, bracesFt, topBracesFt, bottomBracesFt, ...beam } = {}) {
  const inputs = screeningInputs(beam);
  if (!Array.isArray(sections)) throw new Error('Section library is unavailable.');
  const bracing = resolveFlangeBracing({ spanFt: inputs.spanFt, bracesFt, topBracesFt, bottomBracesFt });

  let considered = 0, skipped = 0;
  const candidates = [];
  for (const section of sections) {
    let result;
    try { result = screenSection(section, inputs, bracing); } catch { skipped++; continue; }
    considered++;
    const { passes, ...ratios } = result;
    if (passes) candidates.push({ section, ...ratios });
  }
  candidates.sort((a, b) => a.section.W - b.section.W || a.section.AISC_Manual_Label.localeCompare(b.section.AISC_Manual_Label, undefined, { numeric: true }));
  if (!candidates.length) return Object.freeze({ status: 'no_candidate', considered, skipped });
  return Object.freeze({ status: 'suggested', ...candidates[0], considered, skipped });
}
