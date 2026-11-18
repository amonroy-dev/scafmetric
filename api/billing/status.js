import { readAccount } from '../../server/account.js';
import { billingDatabase, billingStripe, mappedCustomer } from '../../server/billing.js';
import { checkEntitlement } from '../../server/entitlement.js';
import { createPaidVerifier } from '../../server/stripe-paid.js';
import { getSessionCookie, verifySession } from '../../server/session-core.js';
import { isConfigured } from '../auth/session.js';

// This endpoint exposes only the current account's access state. Payment and
// lifetime grants are checked on the server; no client-selected IDs are used.
export function createBillingStatusHandler({ env = process.env, getDatabase = () => billingDatabase(env), accountFor = readAccount, entitlementFor = checkEntitlement, verifyPaid, customerFor = mappedCustomer } = {}) {
  return async function status(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error:'Method not allowed.' }); }
    if (!isConfigured(env)) return res.status(503).json({ error:'Billing is temporarily unavailable.' });
    const user = verifySession(getSessionCookie(req.headers.cookie), env);
    if (!user) return res.status(401).json({ error:'Sign in to check access.' });
    try {
      const db = getDatabase();
      const account = await accountFor(db, user);
      if (!account || account.termsAccepted !== true || account.profileComplete !== true) return res.status(403).json({ error:'Complete your account setup.' });
      // Construct Stripe lazily so an explicit lifetime grant works without
      // payment configuration or network availability.
      const trustedVerifier = verifyPaid || (uid => createPaidVerifier({ stripe:billingStripe(env), db, priceId:env.STRIPE_PRICE_ID })(uid));
      const access = await entitlementFor({ db, uid:user.uid, verifyPaid:trustedVerifier });
      if (typeof access?.hasAccess !== 'boolean' || !['lifetime', 'paid', 'payment_required'].includes(access.reason) || access.hasAccess !== (access.reason !== 'payment_required')) throw new Error('Invalid access state');
      const canManageBilling = access.reason !== 'lifetime' ? Boolean(await customerFor(db, user.uid)) : false;
      return res.status(200).json({ hasAccess:access.hasAccess, reason:access.reason, canManageBilling });
    } catch { return res.status(503).json({ error:'Billing is temporarily unavailable.' }); }
  };
}
export default createBillingStatusHandler();
