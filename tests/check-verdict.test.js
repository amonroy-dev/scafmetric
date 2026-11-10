import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeChecks } from '../src/check-verdict.js';
const flex = ratio => ({status:'evaluated', governingSegment:{utilization:ratio}});
const shear = ratio => ({status:'evaluated', utilization:ratio});
const base = () => ({status:'evaluated', flexure:flex(0.8), shear:shear(0.5)});
test('passes only evaluated bending and shear within their limits', () => {
  assert.equal(summarizeChecks(base()).status, 'pass');
  assert.equal(summarizeChecks({...base(),flexure:flex(1.00001)}).status, 'fail');
  assert.equal(summarizeChecks({...base(),shear:{status:'not_evaluated',reason:'unsupported'}}).status, 'incomplete');
  assert.equal(summarizeChecks({status:'not_requested'}).status, 'incomplete');
});
test('selected comparison controls the verdict and missing checks cannot pass', () => {
  const check = {...base(),comparisonSelection:'four',extra:{bending:flex(1.2),shearing:shear(0.9)}};
  const failure = summarizeChecks(check);
  assert.equal(failure.status, 'fail');
  assert.equal(failure.governing.name, '4:1 comparison bending');
  check.extra.bending = {status:'not_evaluated',reason:'unsupported'};
  assert.equal(summarizeChecks(check).status, 'incomplete');
});
