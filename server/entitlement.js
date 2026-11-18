// Access is decided only from server-owned Firestore data or a trusted,
// server-side payment verifier. The client must never supply either source.
export class EntitlementUnavailableError extends Error {
  constructor() {
    super('Access verification is temporarily unavailable.');
    this.name = 'EntitlementUnavailableError';
  }
}

/**
 * Determine whether a Firebase user has lifetime or paid access.
 *
 * verifyPaid is an optional server-side dependency with signature
 *   async verifyPaid(uid) -> boolean
 * It must return true only after verifying actual paid entitlement with the
 * configured payment provider. Subscription labels, client input, and a
 * checkout return URL alone are not sufficient proof of payment. No trial or
 * cached lease is granted by this function.
 *
 * A storage or verifier outage throws a safe error rather than granting access.
 */
export async function checkEntitlement({ db, uid, verifyPaid } = {}) {
  if (typeof uid !== 'string' || !uid || uid.length > 128 || uid.includes('/')) {
    throw new EntitlementUnavailableError();
  }
  let grant;
  try {
    const snapshot = await db.collection('billingEntitlements').doc(uid).get();
    grant = snapshot.exists ? snapshot.data() : null;
  } catch {
    throw new EntitlementUnavailableError();
  }
  if (grant?.lifetimeFree === true) return { hasAccess: true, reason: 'lifetime' };
  if (typeof verifyPaid !== 'function') throw new EntitlementUnavailableError();
  let paid;
  try { paid = await verifyPaid(uid); } catch { throw new EntitlementUnavailableError(); }
  if (typeof paid !== 'boolean') throw new EntitlementUnavailableError();
  return paid ? { hasAccess: true, reason: 'paid' } : { hasAccess: false, reason: 'payment_required' };
}
