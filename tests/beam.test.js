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
test('uniform-load diagram critical points and zero-load response', () => {
 const r = analyzeBeam(base);
 near(r.maxShear.shearLb, 10310); near(r.maxShear.xFt, 0);
 near(r.minShear.shearLb, -10310); near(r.minShear.xFt, 20);
 near(r.at(10).shearLb, 0); near(r.maxMoment.xFt, 10); near(r.maxDeflection.xFt, 10);
 const zero = analyzeBeam({ ...base, uniformLoadPlf: 0 });
 for (const x of [0, 5, 10, 15, 20]) {
  near(zero.at(x).shearLb, 0); near(zero.at(x).momentKipFt, 0); near(zero.at(x).reducedDeflectionIn, 0);
 }
});
test('multiple point loads satisfy equilibrium, superposition and individual shear jumps', () => {
 const pointLoads = [{loadLb:4000,locationFt:4},{loadLb:6000,locationFt:14},{loadLb:2000,locationFt:4}];
 const combined = analyzeBeam({ ...base, pointLoads });
 const singles = pointLoads.map(p => analyzeBeam({ ...base, uniformLoadPlf:0, pointLoadLb:p.loadLb, pointLocationFt:p.locationFt }));
 const uniform = analyzeBeam(base);
 near(combined.reactions.leftLb, 10310 + 6000*16/20 + 6000*6/20);
 near(combined.reactions.rightLb, 10310 + 6000*4/20 + 6000*14/20);
 near(combined.at(4,'left').shearLb - combined.at(4,'right').shearLb,6000);
 near(combined.at(14,'left').shearLb - combined.at(14,'right').shearLb,6000);
 for (const x of [0,4,8,14,20]) for (const key of ['shearLb','momentLbIn','nominalDeflectionIn']) near(combined.at(x)[key], uniform.at(x)[key] + singles.reduce((sum,p) => sum + p.at(x)[key],0), 1e-6);
 near(combined.equilibrium.forceResidualLb,0); near(combined.equilibrium.momentResidualLbIn,0);
 const expectedRoot=(combined.reactions.leftLb-6000)/1031;
 near(combined.maxMoment.xFt,expectedRoot);
 near(combined.at(expectedRoot).shearLb,0);
});
test('point loads at supports transfer directly into support reactions', () => {
 const r=analyzeBeam({...base,uniformLoadPlf:0,pointLoads:[{loadLb:5000,locationFt:0},{loadLb:3000,locationFt:20}]});
 near(r.reactions.leftLb,5000);near(r.reactions.rightLb,3000);
 for(const x of [0,5,10,15,20]) { near(r.at(x).momentKipFt,0); near(r.at(x).nominalDeflectionIn,0); }
 near(r.maxShear.shearLb,0); near(r.minShear.shearLb,0);
});
test('point-load arrays reject invalid inputs and conflicting legacy input', () => {
 assert.throws(()=>analyzeBeam({...base,pointLoads:[{loadLb:1,locationFt:21}]}));
 assert.throws(()=>analyzeBeam({...base,pointLoads:[{loadLb:-1,locationFt:1}]}));
 assert.throws(()=>analyzeBeam({...base,pointLoads:[{loadLb:NaN,locationFt:1}]}));
 assert.throws(()=>analyzeBeam({...base,pointLoadLb:1,pointLoads:[{loadLb:1,locationFt:1}]}));
});
