import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBeam } from '../src/beam.js';
import { checkDeflection } from '../src/deflection-check.js';

test('L/240 on a 20 ft span allows 1.0 in; the adjusted (0.8 EI) deflection is checked', () => {
  const a = analyzeBeam({ spanFt: 20, uniformLoadPlf: 1031, Eksi: 29000, Iin4: 375, stiffnessFactor: 0.8 });
  const d = checkDeflection({ analysis: a });
  const exact = 5 * (1031 / 12) * 240 ** 4 / (384 * 29000 * 1000 * 375) / 0.8;
  assert.equal(d.status, 'evaluated');
  assert.equal(d.limitRatio, 240);
  assert.equal(d.allowableIn, 1);
  assert.ok(Math.abs(d.deflectionIn - exact) < 1e-12);
  assert.ok(Math.abs(d.utilization - exact) < 1e-12);
  assert.equal(d.meets, true);
  assert.ok(Math.abs(checkDeflection({ analysis: a, limitRatio: 360 }).allowableIn - 240 / 360) < 1e-12);
});

test('a strength-adequate W10x22 sags past L/240 and fails the limit', () => {
  // 200 D + 800 L + 22 lb/ft self-weight on 20 ft; Ix = 118 in⁴.
  const a = analyzeBeam({ spanFt: 20, uniformLoadPlf: 1022, Eksi: 29000, Iin4: 118, stiffnessFactor: 0.8 });
  const d = checkDeflection({ analysis: a, limitRatio: 240 });
  assert.equal(d.meets, false);
  assert.ok(d.utilization > 1.3 && d.utilization < 1.4);
});

test('missing analysis or limit is reported, never passed', () => {
  assert.equal(checkDeflection({}).status, 'not_evaluated');
  const a = analyzeBeam({ spanFt: 20, uniformLoadPlf: 1000, Eksi: 29000, Iin4: 375 });
  assert.equal(checkDeflection({ analysis: a, limitRatio: 0 }).status, 'not_evaluated');
});
