// Scaffold component catalog for the scaffold-to-beam workflow.
//
// SCOPE NOTE: This is deliberately generic. Unlike the source scaffold projects
// (Scaffxiq_v2 / ScaffoldPro), there are no manufacturer names, part numbers,
// rosettes, or mouthpieces here. Standards, ledgers, and braces are modeled as
// plain steel tubes; planks as a generic steel-plank basis. Component-weight
// details are kept internal to the calculation and are never surfaced as product
// specifications.

export const INCHES_PER_FOOT = 12;

// Structural steel unit weight used throughout the weight takeoff.
export const STEEL_DENSITY_LB_FT3 = 490;
const STEEL_DENSITY_LB_IN3 = STEEL_DENSITY_LB_FT3 / (INCHES_PER_FOOT ** 3);

export function inchesToFeet(inches) {
  return inches / INCHES_PER_FOOT;
}

// Hollow round-tube self-weight from its actual cross-section.
//   area = π/4 (OD² − ID²),  ID = OD − 2·wall
// Returns pounds per foot of length. An optional allowance (e.g. 0.2 for +20%)
// accounts for couplers, wall tolerance, galvanizing, and node hardware that a
// bare-tube calculation ignores.
export function tubeWeightPerFoot({ outsideDiameterIn, wallThicknessIn, allowance = 0 }) {
  if (!Number.isFinite(outsideDiameterIn) || outsideDiameterIn <= 0) {
    throw new Error('Tube outside diameter must be a positive number of inches.');
  }
  if (!Number.isFinite(wallThicknessIn) || wallThicknessIn <= 0) {
    throw new Error('Tube wall thickness must be a positive number of inches.');
  }
  const insideDiameterIn = outsideDiameterIn - 2 * wallThicknessIn;
  if (insideDiameterIn <= 0) {
    throw new Error('Tube wall thickness is too large for the given outside diameter.');
  }
  if (!Number.isFinite(allowance) || allowance < 0) {
    throw new Error('Weight allowance must be a finite, nonnegative fraction.');
  }
  const steelAreaIn2 = (Math.PI / 4) * (outsideDiameterIn ** 2 - insideDiameterIn ** 2);
  const perFoot = steelAreaIn2 * STEEL_DENSITY_LB_IN3 * INCHES_PER_FOOT;
  return perFoot * (1 + allowance);
}

// Total self-weight of a tube of a given length (feet).
export function tubeWeightLb(spec, lengthFt) {
  if (!Number.isFinite(lengthFt) || lengthFt < 0) {
    throw new Error('Tube length must be a finite, nonnegative number of feet.');
  }
  return tubeWeightPerFoot(spec) * lengthFt;
}

// The proposed standard (vertical leg) tube: 1.9" OD × 0.12" wall + 20%.
// These three numbers are the only "settled" figures in the checklist; the
// ledger, brace, and plank values below are provisional defaults the user is
// meant to review and edit.
export const STANDARD_TUBE = Object.freeze({
  outsideDiameterIn: 1.9,
  wallThicknessIn: 0.12,
  allowance: 0.2,
});

// Provisional, EDITABLE defaults. Flagged as assumptions, not published specs.
// Ledgers and braces reuse the same proposed tube section as a starting point;
// the brace carries a slightly higher allowance for its end connections.
export const DEFAULT_COMPONENTS = Object.freeze({
  standard: { ...STANDARD_TUBE, settled: true },
  ledger: { outsideDiameterIn: 1.9, wallThicknessIn: 0.12, allowance: 0.2, settled: false },
  brace: { outsideDiameterIn: 1.9, wallThicknessIn: 0.12, allowance: 0.25, settled: false },
  // Generic steel plank basis expressed as an equivalent area weight (lb/ft²).
  // This is an editable placeholder pending the published-spec research in
  // docs/scaffold-to-beam-research-checklist.md — NOT a settled value.
  plank: { areaWeightLbPerFt2: 3.0, widthIn: 9.5, settled: false },
});

// Live load applied to the planked working area, in lb/ft². Editable; a light
// scaffold duty (~25 psf) is a common preliminary default.
export const DEFAULT_LIVE_LOAD_PSF = 25;

// Resolve a components object (possibly partial / user-edited) against defaults.
export function resolveComponents(overrides = {}) {
  const out = {};
  for (const key of Object.keys(DEFAULT_COMPONENTS)) {
    out[key] = { ...DEFAULT_COMPONENTS[key], ...(overrides[key] ?? {}) };
  }
  return out;
}
