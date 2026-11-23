// Benchmark against RISA-3D v22 (AISC 360-16 ASD), detail report for member M1:
// W4X13, 4 ft simple span, 15 kip point load at midspan plus self-weight,
// braced at the supports only, load combination DL + LL.
// The expected values are the ones printed in that report. Lp and Lr differ
// slightly because RISA derives ry, Sz and rts itself (1.004, 5.433, 1.163)
// where the AISC table this app uses rounds them (1.00, 5.46, 1.16); yielding
// governs here, so the result is the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { analyzeBeam } from '../src/beam.js';
import { checkFlexure } from '../src/strength-flexure.js';
import { checkMajorAxisShear } from '../src/strength-shear.js';
import { beamSelfWeight } from '../src/beam-self-weight.js';

const data = JSON.parse(readFileSync(new URL('../public/data/aisc-w-shapes-v15.json', import.meta.url), 'utf8'));
const section = (Array.isArray(data) ? data : (data.shapes || Object.values(data))).find(s => s.AISC_Manual_Label === 'W4X13');
const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} vs RISA ${expected}`);

const analysis = analyzeBeam({
  spanFt: 4, uniformLoadPlf: beamSelfWeight(section) * 1000,
  pointLoads: [{ loadLb: 15000, locationFt: 2 }], Eksi: 29000, Iin4: section.Ix, stiffnessFactor: 0.8,
});

test('RISA W4X13: reactions, shear and moment', () => {
  near(analysis.reactions.leftLb, 7526.065, 0.5, 'reaction, lb');
  near(Math.abs(analysis.minShear.shearLb), 7526.065, 0.5, 'shear, lb');
  near(analysis.maxMoment.momentKipFt, 15.026, 0.0005, 'moment, k-ft');
  assert.equal(analysis.maxMoment.xFt, 2);
});

test('RISA W4X13: strong-axis flexure, unity 0.959', () => {
  const f = checkFlexure({
    section, analysis, topBracesFt: [0, 4], bottomBracesFt: [0, 4], cbMethod: 'quarter',
    Eksi: 29000, Fyksi: 50, confirmedLateralBracing: true, confirmedScope: true,
  });
  const g = f.governingSegment;
  near(g.Cb, 1.315, 0.0005, 'Cb');
  near(g.MaKipFt, 7.52, 0.005, 'MA, k-ft');
  near(f.MpKipFt, 26.167, 0.0005, 'Mp, k-ft');
  near(g.MnKipFt, 26.167, 0.0005, 'Mn, k-ft');
  near(g.allowableKipFt, 15.669, 0.0005, 'allowable moment, k-ft');
  near(g.utilization, 0.959, 0.0005, 'bending unity');
  near(f.compactness.flangeRatio, 5.884, 0.0005, 'flange slenderness');
  near(f.compactness.webRatio, 10.607, 0.0005, 'web slenderness');
  near(f.LpFt, 3.546, 0.02, 'Lp, ft');
  near(f.LrFt, 19.321, 0.15, 'Lr, ft');
});

test('RISA W4X13: major-axis shear, unity 0.323', () => {
  const v = checkMajorAxisShear({ section, FyKsi: 50, Eksi: 29000, demandKip: Math.abs(analysis.minShear.shearLb) / 1000 });
  near(v.AwIn2, 1.165, 0.0005, 'shear area, in2');
  near(v.nominalKip, 34.944, 0.0005, 'Vn, kip');
  near(v.allowableKip, 23.296, 0.0005, 'allowable shear, kip');
  near(v.utilization, 0.323, 0.0005, 'shear unity');
});

test('RISA W4X13: deflection L/363 on 0.8 EI', () => {
  near(48 / analysis.maxDeflection.reducedDeflectionIn, 363, 0.5, 'deflection ratio');
  assert.equal(+analysis.maxDeflection.xFt.toFixed(3), 2);
});
