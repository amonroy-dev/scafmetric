import test from 'node:test';
import assert from 'node:assert/strict';
import { stripeConfig } from '../server/stripe-config.js';

test('Vercel production uses only its live key, never the sandbox key', () => {
  const env = { VERCEL_ENV:'production', NODE_ENV:'production', STRIPE_SECRET_KEY:'rk_live_example', STRIPE_TEST_SECRET_KEY:'rk_test_example' };
  assert.deepEqual(stripeConfig(env), { key:'rk_live_example', livemode:true });
  assert.equal(stripeConfig({...env,STRIPE_SECRET_KEY:'rk_test_example'}), null);
  assert.equal(stripeConfig({...env,STRIPE_SECRET_KEY:undefined}), null);
});

test('Vercel preview uses only its sandbox key even when NODE_ENV is production', () => {
  const env = { VERCEL_ENV:'preview', NODE_ENV:'production', STRIPE_SECRET_KEY:'rk_live_example', STRIPE_TEST_SECRET_KEY:'rk_test_example' };
  assert.deepEqual(stripeConfig(env), { key:'rk_test_example', livemode:false });
  assert.equal(stripeConfig({...env,STRIPE_TEST_SECRET_KEY:'rk_live_example'}), null);
  assert.equal(stripeConfig({...env,STRIPE_TEST_SECRET_KEY:undefined}), null);
});

test('local development uses a sandbox key; unrecognized environments and invalid keys fail closed', () => {
  assert.deepEqual(stripeConfig({NODE_ENV:'development',STRIPE_TEST_SECRET_KEY:'sk_test_example'}), { key:'sk_test_example', livemode:false });
  assert.deepEqual(stripeConfig({NODE_ENV:'production',STRIPE_SECRET_KEY:'sk_live_example'}), { key:'sk_live_example', livemode:true });
  assert.equal(stripeConfig({VERCEL_ENV:'unknown',STRIPE_TEST_SECRET_KEY:'sk_test_example'}), null);
  assert.equal(stripeConfig({VERCEL_ENV:'development',STRIPE_TEST_SECRET_KEY:'sk_test_'}), null);
  assert.equal(stripeConfig({VERCEL_ENV:'development',STRIPE_TEST_SECRET_KEY:'sk_test_value extra'}), null);
});
