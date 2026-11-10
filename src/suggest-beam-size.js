import { analyzeBeam } from './beam.js';
import { beamSelfWeight } from './beam-self-weight.js';
import { checkFlexure } from './strength-flexure.js';
import { checkMajorAxisShear } from './strength-shear.js';
import { strengthComparisonLoads } from './strength-comparison.js';

/**
 * Find the lowest weight-per-foot catalogue section that meets the implemented
 * AISC F2 bending and G2.1(a) shear checks. This is preliminary candidate
 * screening, not an overall member, scaffold, deflection, or compliance design.
 * Each proposed section's properties must be independently verified.
 */
export function suggestBeamSize({ sections, spanFt, deadLoadKipFt, liveLoadKipFt, bracesFt, cbMethod = 'unity', safetyFactor = null, Eksi = 29000, confirmedLateralBracing = false, confirmedScope = false } = {}) {
  if (!confirmedLateralBracing || !confirmedScope) throw new Error('Confirm the material, restraint and loading assumptions before suggesting a size.');
  if (Eksi !== 29000) throw new Error('Suggested sizes require E = 29,000 ksi and A992 steel.');
  if (!Number.isFinite(spanFt) || spanFt <= 0 || ![deadLoadKipFt, liveLoadKipFt].every(n => Number.isFinite(n) && n >= 0)) throw new Error('A positive span and finite nonnegative loads are required.');
  if (!Array.isArray(sections)) throw new Error('Section library is unavailable.');
  if (!['unity', 'quarter'].includes(cbMethod)) throw new Error('Select a supported Cb method.');
  if (!Array.isArray(bracesFt) || bracesFt.length < 2 || bracesFt[0] !== 0 || bracesFt[bracesFt.length - 1] !== spanFt || bracesFt.some((x, i) => !Number.isFinite(x) || x < 0 || x > spanFt || (i > 0 && x <= bracesFt[i - 1]))) throw new Error('Brace locations must increase from 0 to the span and include both supports.');
  if (safetyFactor !== null && (!Number.isFinite(safetyFactor) || safetyFactor < 1)) throw new Error('Safety factor must be at least 1.');

  let considered = 0, skipped = 0;
  const candidates = [];
  for (const section of sections) {
    try {
      if (section?.Type !== 'W' || typeof section.AISC_Manual_Label !== 'string' || !section.AISC_Manual_Label || !Number.isFinite(section.Ix) || section.Ix <= 0) throw new Error('Invalid W section.');
      const self = beamSelfWeight(section);
      const base = { spanFt, Eksi, Iin4: section.Ix, stiffnessFactor: 1 };
      const flexure = load => checkFlexure({ section, analysis: analyzeBeam({ ...base, uniformLoadPlf: load * 1000 }), bracesFt, cbMethod, Eksi, Fyksi: 50, confirmedLateralBracing: true, confirmedScope: true });
      const shear = load => checkMajorAxisShear({ section, Eksi, FyKsi: 50, demandKip: load * spanFt / 2 });
      const serviceLoad = deadLoadKipFt + liveLoadKipFt + self;
      const bending = flexure(serviceLoad), shearing = shear(serviceLoad);
      if (shearing.status !== 'evaluated') throw new Error(shearing.reason);
      let comparisonBendingRatio = null, comparisonShearRatio = null;
      if (safetyFactor !== null) {
        const loads = strengthComparisonLoads({ dead: deadLoadKipFt, live: liveLoadKipFt, self, safetyFactor });
        comparisonBendingRatio = flexure(loads.bending).governingSegment.utilization;
        const comparisonShear = shear(loads.shear);
        if (comparisonShear.status !== 'evaluated') throw new Error(comparisonShear.reason);
        comparisonShearRatio = comparisonShear.utilization;
      }
      const bendingRatio = bending.governingSegment.utilization, shearRatio = shearing.utilization;
      const ratios = [bendingRatio, shearRatio, ...(safetyFactor === null ? [] : [comparisonBendingRatio, comparisonShearRatio])];
      if (!ratios.every(Number.isFinite)) throw new Error('Invalid ratio.');
      considered++;
      if (ratios.every(n => n <= 1)) candidates.push({ section, bendingRatio, shearRatio, comparisonBendingRatio, comparisonShearRatio, selfWeightKipFt: self });
    } catch {
      skipped++;
    }
  }
  candidates.sort((a, b) => a.section.W - b.section.W || a.section.AISC_Manual_Label.localeCompare(b.section.AISC_Manual_Label, undefined, { numeric: true }));
  if (!candidates.length) return Object.freeze({ status: 'no_candidate', considered, skipped });
  return Object.freeze({ status: 'suggested', ...candidates[0], considered, skipped });
}
