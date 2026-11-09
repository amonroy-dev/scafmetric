import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestedLoadComparison } from '../src/load-comparison.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const input = { deadLoadKipFt: 0.2, liveLoadKipFt: 0.8, selfWeightKipFt: 0.031, spanFt: 20 };
test('requested comparisons apply full-precision ratio to live load and add beam weight once', () => {
 for (const [selection, numerator] of [['four', 4], ['two-and-half', 2.5]]) {
  const r = requestedLoadComparison({ ...input, selection });
  const expected = 0.2 + 0.031 + (numerator / 1.67) * 0.8;
  near(r.multiplier, numerator / 1.67);
  near(r.totalKipFt, expected);
  near(r.reactionKip, expected * 10);
  near(r.momentKipFt, expected * 50);
 }
});
test('comparison remains optional and validates its bounds', () => {
 assert.equal(requestedLoadComparison({ ...input, selection:'none' }), null);
 assert.throws(() => requestedLoadComparison({ ...input, selection:'other' }));
 assert.throws(() => requestedLoadComparison({ ...input, selection:'four', liveLoadKipFt:-1 }));
 assert.throws(() => requestedLoadComparison({ ...input, selection:'four', spanFt:0 }));
});
