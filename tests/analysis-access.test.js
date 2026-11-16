import test from 'node:test';
import assert from 'node:assert/strict';
import { getAnalysisAccess } from '../src/analysis-access.js';

test('only a configured, signed-in user with complete onboarding can run analysis', async () => {
  const check = body => getAnalysisAccess(async (url, options) => {
    assert.equal(url, '/api/auth/session'); assert.equal(options.cache, 'no-store');
    return { ok: true, async json() { return body; } };
  });
  assert.equal(await check({ configured: true, authenticated: true, termsAccepted: true, profileComplete: true }), 'allowed');
  assert.equal(await check({ configured: true, authenticated: false }), 'signin');
  assert.equal(await check({ configured: true, authenticated: true, termsAccepted: false, profileComplete: true }), 'onboarding');
  assert.equal(await check({ configured: true, authenticated: true, termsAccepted: true, profileComplete: false }), 'onboarding');
  assert.equal(await check({ configured: true, authenticated: true }), 'onboarding');
  assert.equal(await check({ configured: false }), 'unavailable');
  assert.equal(await check(null), 'unavailable');
  assert.equal(await getAnalysisAccess(async () => ({ ok: false })), 'unavailable');
  assert.equal(await getAnalysisAccess(async () => { throw Error('network'); }), 'unavailable');
});
