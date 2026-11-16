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

test('deflection screening rejects a strength-passing candidate at reduced EI', () => {
  const input = {...base, sections:[section('W10X22')], deadLoadKipFt:0.2, liveLoadKipFt:0.7};
  const strengthOnly = suggestBeamSize({...input, stiffnessFactor:0.8});
  assert.equal(strengthOnly.status, 'suggested');
  assert.ok(strengthOnly.bendingRatio < 1 && strengthOnly.shearRatio < 1);
  // 922 lb/ft includes this candidate's 22 lb/ft self-weight. L/240 allows
  // 1 inch here: nominal EI passes, but dividing the sag by 0.8 exceeds it.
  const nominalSagIn = 5 * (922 / 12) * 240 ** 4 / (384 * 29000000 * 118);
  const nominal = suggestBeamSize({...input, stiffnessFactor:1, deflectionLimitRatio:240});
  assert.equal(nominal.status, 'suggested');
  assert.ok(Math.abs(nominal.deflectionRatio - nominalSagIn) < 1e-12);
  assert.ok(nominalSagIn < 1 && nominalSagIn / 0.8 > 1);
  const reduced = suggestBeamSize({...input, stiffnessFactor:0.8, deflectionLimitRatio:240});
  assert.deepEqual(reduced, {status:'no_candidate', considered:1, skipped:0});
});

test('a stricter selected deflection criterion excludes an otherwise passing candidate', () => {
  const input = {...base, sections:[section('W10X22')], deadLoadKipFt:0.2, liveLoadKipFt:0.7, stiffnessFactor:1};
  assert.equal(suggestBeamSize({...input, deflectionLimitRatio:240}).status, 'suggested');
  assert.deepEqual(suggestBeamSize({...input, deflectionLimitRatio:360}), {status:'no_candidate', considered:1, skipped:0});
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

test('mixed point-load categories retain dead demand and factor only live demand in size screening', () => {
  const beam = section('W16X31');
  const result = suggestBeamSize({...base, sections:[beam], liveLoadKipFt:0, safetyFactor:4,
    pointLoads:[{deadKip:2,liveKip:3,locationFt:4},{deadKip:1,liveKip:1,locationFt:15}]});
  assert.equal(result.status, 'suggested');
  const allowable = checkMajorAxisShear({section:beam,Eksi:29000,FyKsi:50,demandKip:0}).allowableKip;
  const selfReaction = .031*20/2;
  // Independent left reactions: D = 2(16/20)+1(5/20) = 1.85 kip;
  // LL = 3(16/20)+1(5/20) = 2.65 kip. Left governs every case.
  const deadReaction = 1.85, liveReaction = 2.65;
  assert.ok(Math.abs(result.shearRatio - (selfReaction+deadReaction+liveReaction)/allowable) < 1e-12);
  assert.ok(Math.abs(result.comparisonShearRatio - (selfReaction+deadReaction+liveReaction*4/1.5)/allowable) < 1e-12);
  // Both maxima occur at x = 4 ft; all four unbraced intervals have the
  // same Cb = 1 capacity, so the utilization ratio equals the moment ratio.
  const serviceMoment = (selfReaction+deadReaction+liveReaction)*4 - .031*4**2/2;
  const comparedMoment = (selfReaction+deadReaction+liveReaction*4/1.67)*4 - .031*4**2/2;
  assert.ok(Math.abs(result.comparisonBendingRatio/result.bendingRatio - comparedMoment/serviceMoment) < 1e-12);
});

test('dead-only point loads are unchanged by the selected live-load comparison', () => {
  const result = suggestBeamSize({...base, sections:[section('W16X31')], liveLoadKipFt:0,
    pointLoads:[{deadKip:5,liveKip:0,locationFt:6}], safetyFactor:4});
  assert.equal(result.status, 'suggested');
  assert.equal(result.comparisonBendingRatio, result.bendingRatio);
  assert.equal(result.comparisonShearRatio, result.shearRatio);
  assert.throws(() => suggestBeamSize({...base, pointLoads:[{deadKip:-1,liveKip:1,locationFt:2}]}), /Point loads/);
  assert.throws(() => suggestBeamSize({...base, pointLoads:[{deadKip:1,liveKip:NaN,locationFt:2}]}), /Point loads/);
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

test('size screening does not count bottom-flange braces as top-flange restraint', () => {
  const input = { ...base, sections: [section('W16X31')], bracesFt: undefined };
  const topBraced = suggestBeamSize({ ...input, topBracesFt: [0, 5, 10, 15, 20], bottomBracesFt: [0, 20] });
  assert.equal(topBraced.status, 'suggested');
  const bottomOnly = suggestBeamSize({ ...input, topBracesFt: [0, 20], bottomBracesFt: [0, 5, 10, 15, 20] });
  const noInteriorBraces = suggestBeamSize({ ...input, bracesFt: [0, 20] });
  assert.equal(bottomOnly.status, 'no_candidate');
  assert.deepEqual(bottomOnly, noInteriorBraces);
  assert.throws(() => suggestBeamSize({ ...input, topBracesFt: [0, 20], bottomBracesFt: [0, -1, 20] }), /bottom/);
});
