// Vercel sets NODE_ENV=production for Preview builds too. Use VERCEL_ENV
// first, and never fall back to a key intended for the other environment.
export function stripeConfig(env = process.env) {
  const target = env.VERCEL_ENV;
  if (target && !['production', 'preview', 'development'].includes(target)) return null;
  const live = target ? target === 'production' : env.NODE_ENV === 'production';
  const key = live ? env.STRIPE_SECRET_KEY : env.STRIPE_TEST_SECRET_KEY;
  const valid = live ? /^(?:sk|rk)_live_\S+$/ : /^(?:sk|rk)_test_\S+$/;
  return typeof key === 'string' && valid.test(key) ? { key, livemode: live } : null;
}
