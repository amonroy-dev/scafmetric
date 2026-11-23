// Owner actions on user accounts. Every dependency is injected (Firebase Auth,
// Firestore, the reset-email sender, the clock), so the rules below are tested
// without any network.
//
// What an owner can do, and the limits on it:
//   - look a user up by email or account ID
//   - have Firebase email them a password reset (the owner never sees the link)
//   - block and unblock an account (never their own, never another owner's)
//   - grant or remove free access
//   - invite an email address while sign-ups are paused
// Every change is written to an activity log with who did it and when.
import { isAdminUid } from './admin-access.js';
import { TERMS_VERSION } from '../src/terms.js';
import { hasProfile } from './account.js';

export const ACCOUNTS = 'scafmetricAccounts';
export const ENTITLEMENTS = 'billingEntitlements';
export const BILLING = 'scafmetricBilling';
export const INVITES = 'scafmetricInvites';
export const ADMIN_LOG = 'scafmetricAdminLog';

export const USER_ACTIONS = ['send-reset', 'block', 'unblock', 'grant-access', 'remove-access'];
export const INVITE_ACTIONS = ['invite', 'remove-invite'];

export class AdminActionError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const EMAIL = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;
export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : null;
}
const validUid = uid => typeof uid === 'string' && uid.length > 0 && uid.length <= 128 && !uid.includes('/');
/** Invite documents are keyed by the address; it has no slash, by the check above. */
export const inviteKey = email => email;

export function createAdminUsers({ auth, db, env, sendReset, now = () => new Date() }) {
  const stamp = () => now().toISOString();

  async function record(admin, action, target) {
    await db.collection(ADMIN_LOG).add({
      at: stamp(), action, adminUid: admin.uid, adminEmail: admin.email,
      targetUid: target.uid || null, targetEmail: target.email || null,
    });
  }

  async function authUser(query) {
    const email = normalizeEmail(query);
    try {
      if (email) return await auth.getUserByEmail(email);
      if (validUid(query)) return await auth.getUser(query);
    } catch (error) {
      if (error?.code === 'auth/user-not-found') return null;
      throw error;
    }
    return null;
  }

  /** Everything the owner page shows for one user, or null when there is none. */
  async function find(query) {
    const user = await authUser(typeof query === 'string' ? query.trim() : '');
    if (!user) return null;
    const [account, grant, billing] = await Promise.all([
      db.collection(ACCOUNTS).doc(user.uid).get(),
      db.collection(ENTITLEMENTS).doc(user.uid).get(),
      db.collection(BILLING).doc(user.uid).get(),
    ]);
    const a = account.exists ? account.data() : null;
    const g = grant.exists ? grant.data() : null;
    const b = billing.exists ? billing.data() : null;
    return {
      uid: user.uid,
      email: user.email || '',
      name: user.displayName || a?.profile?.name || '',
      createdAt: user.metadata?.creationTime || null,
      lastSignInAt: user.metadata?.lastSignInTime || null,
      emailVerified: user.emailVerified === true,
      blocked: user.disabled === true || a?.active === false,
      signsInWith: (user.providerData || []).map(p => p.providerId),
      isOwner: isAdminUid({ uid: user.uid }, env),
      account: a ? {
        company: a.profile?.company || '', discovery: a.profile?.discovery || '',
        profileComplete: hasProfile(a),
        termsAccepted: a.termsVersion === TERMS_VERSION && Number.isFinite(Date.parse(a.termsAcceptedAt)),
      } : null,
      access: {
        free: g?.lifetimeFree === true,
        freeGrantedBy: g?.updatedByEmail || null,
        freeGrantedAt: g?.updatedAt || null,
        stripeCustomerId: typeof b?.stripeCustomerId === 'string' ? b.stripeCustomerId : null,
        riskHold: b?.riskHold === true,
      },
    };
  }

  async function act(action, target, admin) {
    if (INVITE_ACTIONS.includes(action)) {
      const email = normalizeEmail(target?.email);
      if (!email) throw new AdminActionError(400, 'Enter a valid email address.');
      const ref = db.collection(INVITES).doc(inviteKey(email));
      if (action === 'invite') await ref.set({ email, invitedAt: stamp(), invitedBy: admin.email });
      else await ref.delete();
      await record(admin, action, { email });
      return { ok: true };
    }
    if (!USER_ACTIONS.includes(action)) throw new AdminActionError(400, 'Unknown action.');
    if (!validUid(target?.uid)) throw new AdminActionError(400, 'Choose a user first.');
    const user = await authUser(target.uid);
    if (!user) throw new AdminActionError(404, 'That user no longer exists.');
    const who = { uid: user.uid, email: user.email || '' };

    if (action === 'send-reset') {
      if (!(user.providerData || []).some(p => p.providerId === 'password')) {
        throw new AdminActionError(409, 'This account signs in with Google and has no password to reset.');
      }
      if (!user.email) throw new AdminActionError(409, 'This account has no email address.');
      await sendReset(user.email);
    } else if (action === 'block' || action === 'unblock') {
      const block = action === 'block';
      // An owner cannot lock themselves, or another owner, out of the app.
      if (block && user.uid === admin.uid) throw new AdminActionError(409, 'You cannot block your own account.');
      if (block && isAdminUid({ uid: user.uid }, env)) throw new AdminActionError(409, 'Owner accounts cannot be blocked here. Remove them from ADMIN_UIDS first.');
      await auth.updateUser(user.uid, { disabled: block });
      // Refresh tokens are revoked so a blocked user cannot mint new sign-ins.
      if (block) await auth.revokeRefreshTokens(user.uid);
      const ref = db.collection(ACCOUNTS).doc(user.uid);
      if ((await ref.get()).exists) await ref.update({ active: !block });
    } else {
      const free = action === 'grant-access';
      await db.collection(ENTITLEMENTS).doc(user.uid).set(
        { lifetimeFree: free, updatedAt: stamp(), updatedByUid: admin.uid, updatedByEmail: admin.email }, { merge: true });
    }
    await record(admin, action, who);
    return { ok: true, user: await find(user.uid) };
  }

  async function invites() {
    const snap = await db.collection(INVITES).orderBy('invitedAt', 'desc').limit(200).get();
    return snap.docs.map(d => ({ email: d.data().email, invitedAt: d.data().invitedAt, invitedBy: d.data().invitedBy }));
  }

  async function log() {
    const snap = await db.collection(ADMIN_LOG).orderBy('at', 'desc').limit(100).get();
    return snap.docs.map(d => d.data());
  }

  return { find, act, invites, log };
}

/** True when this address has been invited (sign-ups paused, but let them in). */
export async function isInvited(db, email) {
  const clean = normalizeEmail(email);
  if (!clean) return false;
  return (await db.collection(INVITES).doc(inviteKey(clean)).get()).exists;
}

/**
 * Ask Firebase to email its standard password reset to an address. The link
 * goes to the user only; nothing about it is returned to the caller.
 */
export async function sendFirebaseReset(email, env, request = fetch) {
  const key = env.NEXT_PUBLIC_FIREBASE_API_KEY;
  if (!key) throw new AdminActionError(503, 'Password reset email is not configured.');
  const response = await request(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestType: 'PASSWORD_RESET', email }),
  });
  if (!response.ok) throw new AdminActionError(502, 'Firebase could not send the reset email. Try again.');
}
