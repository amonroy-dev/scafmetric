import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBeam } from '../src/beam.js';
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const base = { spanFt: 20, uniformLoadPlf: 1031, Eksi: 29000, Iin4: 375 };
test('W16x31 uniform-load benchmark, reduced and nominal EI', () => {
 const r = analyzeBeam(base);
 near(r.reactions.leftLb, 10310); near(r.reactions.rightLb, 10310);
 near(r.maxMoment.momentKipFt, 51.55); near(r.maxMoment.xFt, 10);
 near(r.maxDeflection.nominalDeflectionIn, 5*(1031/12)*240**4/(384*29000*1000*375));
 near(r.maxDeflection.reducedDeflectionIn, r.maxDeflection.nominalDeflectionIn/0.8);
 near(r.at(0).nominalDeflectionIn, 0); near(r.at(20).nominalDeflectionIn, 0, 1e-12);
 near(r.equilibrium.forceResidualLb, 0); near(r.equilibrium.momentResidualLbIn, 0);
});
test('central point load closed form and shear jump', () => {
 const r = analyzeBeam({ ...base, uniformLoadPlf: 0, pointLoadLb: 10000, pointLocationFt: 10 });
 near(r.reactions.leftLb, 5000); near(r.maxMoment.momentKipFt, 50);
 near(r.maxDeflection.nominalDeflectionIn, 10000*240**3/(48*29000*1000*375));
 near(r.at(10, 'left').shearLb-r.at(10, 'right').shearLb, 10000);
});
test('eccentric point load equilibrium and superposition', () => {
 const u = analyzeBeam(base); const p = analyzeBeam({ ...base, uniformLoadPlf: 0, pointLoadLb: 6000, pointLocationFt: 5 });
 const both = analyzeBeam({ ...base, pointLoadLb: 6000, pointLocationFt: 5 });
 near(p.reactions.leftLb, 4500); near(p.reactions.rightLb, 1500); near(p.maxMoment.xFt, 5);
 for (const x of [0, 5, 7, 10, 20]) for (const key of ['shearLb', 'momentLbIn', 'nominalDeflectionIn']) near(both.at(x)[key], u.at(x)[key]+p.at(x)[key], 1e-7);
 near(both.equilibrium.momentResidualLbIn, 0);
});
test('rejects unsupported geometry and invalid material', () => {
 assert.throws(() => analyzeBeam({ ...base, spanFt: 0 }));
 assert.throws(() => analyzeBeam({ ...base, pointLoadLb: -1 }));
 assert.throws(() => analyzeBeam({ ...base, pointLocationFt: 21 }));
 assert.throws(() => analyzeBeam({ ...base, stiffnessFactor: 0 }));
});
