// Server-created, server-owned trial record. The start is derived only from
// Firebase Auth's authoritative creationTime, matching the Copious trial basis.
export const TRIAL_MS = 14 * 24 * 60 * 60 * 1000;
const collection = 'scafmetricAccounts';
export async function ensureAccount(db, input) {
  const { uid, email, creationTime } = input;
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const created = Date.parse(creationTime);
  if (typeof uid !== 'string' || !uid || uid.includes('/') || !normalized || !Number.isFinite(created) || created > Date.now() + 60_000) throw new Error('Invalid verified identity');
  const ref = db.collection(collection).doc(uid);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const data = snap.data();
      if (!data || data.uid !== uid || data.email !== normalized || data.active !== true || data.trialStartedAt !== new Date(created).toISOString() || data.trialEndsAt !== new Date(created + TRIAL_MS).toISOString()) throw new Error('Account record is invalid or disabled');
      return data;
    }
    const data = { uid, email: normalized, active: true, trialStartedAt: new Date(created).toISOString(), trialEndsAt: new Date(created + TRIAL_MS).toISOString() };
    tx.create(ref, data);
    return data;
  });
}
export async function readAccount(db, user) {
  if (!user?.uid || user.uid.includes('/')) throw new Error('Invalid identity');
  const snap = await db.collection(collection).doc(user.uid).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (!data || data.uid !== user.uid || data.email !== user.email.trim().toLowerCase() || data.active !== true) return null;
  const start = Date.parse(data.trialStartedAt), end = Date.parse(data.trialEndsAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start !== TRIAL_MS) return null;
  return { trialStartedAt: data.trialStartedAt, trialEndsAt: data.trialEndsAt, trialActive: Date.now() < end };
}
