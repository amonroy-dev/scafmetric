import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkMajorAxisShear } from '../src/strength-shear.js';
const w = { Type:'W', AISC_Manual_Label:'W16X31', d:15.9, tw:0.275, kdes:0.842 };
const base = { section:w, Eksi:29000, FyKsi:50, demandKip:10.311 };
const near = (a,b,eps=1e-8) => assert.ok(Math.abs(a-b) < eps, `${a} != ${b}`);
test('W16×31 ASD major-axis shear matches the RISA and TEDDS benchmark', () => {
 const r = checkMajorAxisShear(base);
 assert.equal(r.status, 'evaluated'); near(r.clearWebIn,14.216); near(r.hOverTw,14.216/0.275);
 near(r.AwIn2,4.3725); near(r.nominalKip,131.175); near(r.allowableKip,87.45);
 near(r.utilization,10.311/87.45); assert.equal(r.omega,1.5); assert.equal(r.meets,true);
});
test('ASD utilization compares unrounded demand to allowable strength', () => {
 const allowable = checkMajorAxisShear(base).allowableKip;
 assert.equal(checkMajorAxisShear({...base,demandKip:allowable}).meets,true);
 assert.equal(checkMajorAxisShear({...base,demandKip:allowable+0.00001}).meets,false);
});
test('slender, unknown and invalid sections remain unevaluated', () => {
 assert.equal(checkMajorAxisShear({...base,section:{...w,tw:0.20}}).status,'not_evaluated');
 assert.equal(checkMajorAxisShear({...base,section:{...w,Type:'HSS'}}).status,'not_evaluated');
 assert.equal(checkMajorAxisShear({...base,section:{...w,kdes:undefined}}).status,'not_evaluated');
 for (const bad of [-1,NaN,Infinity]) assert.equal(checkMajorAxisShear({...base,demandKip:bad}).status,'not_evaluated');
});
test('shear threshold uses 2.24 sqrt(E/Fy), including equality', () => {
 const limit = 2.24 * Math.sqrt(29000/50);
 const within = { ...w, d: limit*w.tw+2*w.kdes };
 assert.equal(checkMajorAxisShear({...base,section:within}).status,'evaluated');
 assert.equal(checkMajorAxisShear({...base,section:{...within,d:within.d+1e-5}}).status,'not_evaluated');
});
