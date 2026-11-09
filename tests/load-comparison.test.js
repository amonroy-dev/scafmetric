import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestedLoadComparison } from '../src/load-comparison.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const input = { deadLoadKipFt: 0.2, liveLoadKipFt: 0.8, selfWeightKipFt: 0.031, spanFt: 20 };
test('preset and custom comparisons use the full-precision factor and add self-weight once', () => {
 for (const [selection, factor] of [['four', 4], ['custom', 2.5], ['custom', 2.75]]) {
  const r = requestedLoadComparison({ ...input, selection, customSafetyFactor: factor });
  const expected = 0.2 + 0.031 + (factor / 1.67) * 0.8;
  near(r.multiplier, factor / 1.67);
  near(r.totalKipFt, expected);
  near(r.reactionKip, expected * 10);
  near(r.momentKipFt, expected * 50);
 }
});
test('comparison remains optional and rejects invalid inputs and overflow', () => {
 assert.equal(requestedLoadComparison({ ...input, selection:'none' }), null);
 assert.throws(() => requestedLoadComparison({ ...input, selection:'other' }));
 for (const customSafetyFactor of [undefined, NaN, 0, -1, Infinity]) assert.throws(() => requestedLoadComparison({ ...input, selection:'custom', customSafetyFactor }));
 assert.throws(() => requestedLoadComparison({ ...input, selection:'four', liveLoadKipFt:-1 }));
 assert.throws(() => requestedLoadComparison({ ...input, selection:'four', spanFt:0 }));
 assert.throws(() => requestedLoadComparison({ ...input, selection:'custom', customSafetyFactor:Number.MAX_VALUE, liveLoadKipFt:10 }));
});
