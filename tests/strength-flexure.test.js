import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBeam } from '../src/beam.js';
import { checkFlexure } from '../src/strength-flexure.js';

const w16x31 = { Type:'W', d:15.9, bf:5.53, tf:0.44, tw:0.275, kdes:0.842, Sx:47.2, Zx:54, ry:1.17, rts:1.42, J:0.461, ho:15.5 };
const near = (actual, expected, tolerance=1e-6) => assert.ok(Math.abs(actual-expected)<=tolerance, `${actual} != ${expected}`);
const analysis = analyzeBeam({ spanFt:20, uniformLoadPlf:1031, Eksi:29000, Iin4:375 });
const baseline = { section:w16x31, analysis, bracesFt:[0,5,10,15,20], cbMethod:'unity', Eksi:29000, Fyksi:50, confirmedLateralBracing:true, confirmedScope:true };
test('W16x31 AISC F2 with Cb=1: rounded AISC v15 source, RISA reference', () => {
 const r = checkFlexure(baseline), g=r.governingSegment;
 near(r.compactness.flangeRatio, 5.53/(2*.44)); near(r.compactness.webRatio, (15.9-2*.842)/.275);
 assert.ok(r.compactness.flangeRatio<r.compactness.flangeLimit && r.compactness.webRatio<r.compactness.webLimit);
 near(r.MpKipFt,225); near(r.LpFt,4.132675,1e-5); near(r.LrFt,11.833431,1e-5);
 assert.equal(g.ltbRegime,'inelastic LTB'); near(g.Cb,1); near(g.MmaxKipFt,51.55);
 near(g.MnKipFt,215.163776,1e-5); near(g.allowableKipFt,128.840584,1e-5);
 near(g.utilization,51.55/128.840584,1e-6);
 // RISA p.5 uses less-rounded properties and reports 128.769 kip-ft.
 assert.ok(Math.abs(g.allowableKipFt-128.769)<0.08);
});
test('calculated Cb uses quarter-point segment moments and plastic cap as TEDDS', () => {
 const r=checkFlexure({...baseline, cbMethod:'quarter'}), segment=r.segments[1];
 near(segment.MaKipFt,44.30078125); near(segment.MbKipFt,48.328125); near(segment.McKipFt,50.74453125);
 near(segment.Cb,1.06100795756,1e-9); near(segment.MnKipFt,225); near(segment.allowableKipFt,225/1.67);
 near(r.governingSegment.utilization,51.55/(225/1.67));
});
test('F2 covers yielding and elastic LTB regimes, with strength using nominal EI properties', () => {
 const short=checkFlexure({...baseline, bracesFt:[0,2,4,6,8,10,12,14,16,18,20]});
 assert.equal(short.segments[0].ltbRegime,'yielding'); near(short.segments[0].MnKipFt,225);
 const long=checkFlexure({...baseline, bracesFt:[0,20]});
 assert.equal(long.segments[0].ltbRegime,'elastic LTB'); assert.ok(long.segments[0].MnKipFt<225);
 assert.ok(Number.isFinite(long.segments[0].FcrKsi)); near(long.segments[0].MnKipFt, Math.min(225, long.segments[0].FcrKsi*w16x31.Sx/12));
 const nominalAnalysis=analyzeBeam({spanFt:20,uniformLoadPlf:1031,Eksi:29000,Iin4:375,stiffnessFactor:1});
 const nominal=checkFlexure({...baseline, analysis:nominalAnalysis});
 near(nominal.governingSegment.allowableKipFt,checkFlexure(baseline).governingSegment.allowableKipFt);
});
test('unequal brace intervals govern by segment demand/capacity; zero load remains finite', () => {
 const r=checkFlexure({...baseline,bracesFt:[0,5,20]});
 assert.equal(r.governingSegment.startFt,5); assert.equal(r.governingSegment.endFt,20); near(r.governingSegment.MmaxKipFt,51.55);
 const zero=analyzeBeam({spanFt:20,uniformLoadPlf:0,Eksi:29000,Iin4:375});
 const empty=checkFlexure({...baseline,analysis:zero,cbMethod:'quarter'});
 assert.ok(empty.segments.every(s=>s.Cb===1 && s.utilization===0));
});
test('rejects unsupported material, geometry, loading, section or unconfirmed conditions', () => {
 assert.throws(()=>checkFlexure({...baseline,confirmedLateralBracing:false}),/restrained/);
 assert.throws(()=>checkFlexure({...baseline,confirmedScope:false}),/assumptions/);
 assert.throws(()=>checkFlexure({...baseline,Fyksi:36}),/A992/);
 assert.throws(()=>checkFlexure({...baseline,Eksi:28000}),/29,000/);
 const otherE = analyzeBeam({spanFt:20,uniformLoadPlf:1031,Eksi:28000,Iin4:375});
 assert.throws(()=>checkFlexure({...baseline,analysis:otherE}),/modulus must match/);
 assert.throws(()=>checkFlexure({...baseline,section:{...w16x31,tf:.1}}),/not compact/);
 assert.throws(()=>checkFlexure({...baseline,section:{...w16x31,rts:undefined}}),/missing/);
 assert.throws(()=>checkFlexure({...baseline,bracesFt:[0,10,9,20]}),/Brace/);
 const point=analyzeBeam({spanFt:20,uniformLoadPlf:0,pointLoadLb:1000,pointLocationFt:10,Eksi:29000,Iin4:375});
 assert.throws(()=>checkFlexure({...baseline,analysis:point}),/uniform load/);
});
