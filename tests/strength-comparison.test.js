import { test } from 'node:test';
import assert from 'node:assert/strict';
import { strengthComparisonLoads } from '../src/strength-comparison.js';
const close = (a,b) => assert.ok(Math.abs(a-b)<1e-12, `${a} != ${b}`);
const loads = { dead:.2, self:.031, live:.8 };
test('4:1 strength comparison uses separate ASD divisors, leaving service unchanged', () => {
 const r = strengthComparisonLoads({ ...loads, safetyFactor:4 });
 close(r.service,1.031); close(r.bending,.231 + 4/1.67*.8); close(r.shear,.231 + 4/1.5*.8);
 assert.ok(r.shear > r.bending);
});
test('custom 2.5:1 and zero live load are calculated without adding self weight twice', () => {
 const r = strengthComparisonLoads({ ...loads, safetyFactor:2.5 });
 close(r.service,1.031); close(r.bending,.231 + 2.5/1.67*.8); close(r.shear,.231 + 2.5/1.5*.8);
 const zero = strengthComparisonLoads({ ...loads, live:0, safetyFactor:4 });
 close(zero.service,.231); close(zero.bending,.231); close(zero.shear,.231);
});
test('invalid factors, invalid loads, and overflow are rejected', () => {
 for (const sf of [0,-1,NaN,Infinity,undefined]) assert.throws(()=>strengthComparisonLoads({...loads,safetyFactor:sf}));
 assert.throws(()=>strengthComparisonLoads({...loads,dead:-1,safetyFactor:4}));
 assert.throws(()=>strengthComparisonLoads({...loads,live:1e308,safetyFactor:1e308}));
});
