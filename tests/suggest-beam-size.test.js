import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { suggestBeamSize } from '../src/suggest-beam-size.js';
import { checkMajorAxisShear } from '../src/strength-shear.js';

const all = JSON.parse(readFileSync(new URL('../public/data/aisc-w-shapes-v15.json', import.meta.url)));
const section = name => all.find(s => s.AISC_Manual_Label === name);
const base = { sections: [section('W16X40'), section('W16X31'), section('W16X36')], spanFt: 20, deadLoadKipFt: 0, liveLoadKipFt: 1, bracesFt: [0, 5, 10, 15, 20], confirmedLateralBracing: true, confirmedScope: true };

test('suggests the lightest supported passing section, independent of input order', () => {
  const result = suggestBeamSize(base);
  assert.equal(result.status, 'suggested');
  assert.equal(result.section.AISC_Manual_Label, 'W16X31');
  assert.equal(result.selfWeightKipFt, 0.031);
  assert.ok(result.bendingRatio < 1 && result.shearRatio < 1);
  assert.equal(result.considered, 3);
  assert.equal(result.skipped, 0);
});

test('counts each candidate self-weight when a load is near the bending limit', () => {
  // W16x31 has about 128.84 kip-ft allowable moment for these braces.
  // At 2.55 kip/ft, applied load alone gives 127.5 kip-ft, but the 31 lb/ft
  // beam weight adds 1.55 kip-ft, so the W16x31 must be rejected.
  const result = suggestBeamSize({ ...base, sections: [section('W16X31')], liveLoadKipFt: 2.55 });
  assert.equal(result.status, 'no_candidate');
  assert.equal(result.considered, 1);
});

test('selected additional comparison must pass along with the service checks', () => {
  const service = suggestBeamSize({ ...base, liveLoadKipFt: 2 });
  assert.equal(service.section.AISC_Manual_Label, 'W16X31');
  const compared = suggestBeamSize({ ...base, liveLoadKipFt: 2, safetyFactor: 4 });
  assert.equal(compared.status, 'no_candidate');
  const lowerLoad = suggestBeamSize({ ...base, safetyFactor: 4 });
  assert.ok(lowerLoad.comparisonBendingRatio > lowerLoad.bendingRatio);
  assert.ok(lowerLoad.comparisonShearRatio > lowerLoad.shearRatio);
});

test('eccentric point loads contribute to the governing shear and the separate comparisons', () => {
  // Point loads of 4 kip at 2 ft and 2 kip at 15 ft produce 4.1 kip
  // of left reaction (plus half of the beam's self-weight). The right
  // reaction is smaller, so equal-reaction uniform-load formulas are wrong.
  const beam = section('W16X31');
  const result = suggestBeamSize({ ...base, sections: [beam], liveLoadKipFt: 0,
    pointLoads: [{loadKip: 4, locationFt: 2}, {loadKip: 2, locationFt: 15}], safetyFactor: 4 });
  assert.equal(result.status, 'suggested');
  const allowable = checkMajorAxisShear({ section: beam, Eksi: 29000, FyKsi: 50, demandKip: 0 }).allowableKip;
  const selfReaction = 0.031 * 20 / 2;
  assert.ok(Math.abs(result.shearRatio - (selfReaction + 4.1) / allowable) < 1e-12);
  assert.ok(Math.abs(result.comparisonShearRatio - (selfReaction + 4.1 * 4 / 1.5) / allowable) < 1e-12);
  // With Cb=1 the flexural capacity is the same for both load cases; the
  // entire applied point load is multiplied by 4/1.67, but self-weight is not.
  const selfOnly = suggestBeamSize({ ...base, sections: [beam], liveLoadKipFt: 0 });
  assert.ok(result.comparisonBendingRatio > result.bendingRatio);
  assert.ok(result.comparisonBendingRatio < result.bendingRatio * 4 / 1.67);
  assert.ok(result.bendingRatio > selfOnly.bendingRatio);
});

test('unsupported sections are skipped and do not receive a passing result', () => {
  const missing = { ...section('W16X31'), AISC_Manual_Label:'MISSING', rts:undefined, W:1 };
  const result = suggestBeamSize({ ...base, sections: [missing, section('W16X36')] });
  assert.equal(result.section.AISC_Manual_Label, 'W16X36');
  assert.equal(result.skipped, 1);
  assert.equal(result.considered, 1);
  const noCandidate = suggestBeamSize({ ...base, sections: [missing] });
  assert.deepEqual(noCandidate, { status: 'no_candidate', considered: 0, skipped: 1 });
});

test('requires supported assumptions and rejects invalid global inputs', () => {
  assert.throws(() => suggestBeamSize({ ...base, confirmedLateralBracing: false }), /assumptions/);
  assert.throws(() => suggestBeamSize({ ...base, Eksi: 28000 }), /29,000/);
  assert.throws(() => suggestBeamSize({ ...base, bracesFt: [0, 10] }), /Brace/);
  assert.throws(() => suggestBeamSize({ ...base, safetyFactor: 0.5 }), /factor/);
  assert.throws(() => suggestBeamSize({ ...base, liveLoadKipFt: NaN }), /loads/);
  assert.throws(() => suggestBeamSize({ ...base, pointLoads: [{loadKip: 1, locationFt: 21}] }), /Point loads/);
  assert.throws(() => suggestBeamSize({ ...base, pointLoads: [{loadKip: -1, locationFt: 5}] }), /Point loads/);
});
