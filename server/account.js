// Account records are server-owned; access is checked separately and is never
// granted based on account age or legacy trial fields.
import { TERMS_VERSION } from '../src/terms.js';
export { TERMS_VERSION } from '../src/terms.js';
const collection = 'scafmetricAccounts';
// Only bounded plain text is retained. The authenticated server, not the client,
// selects the account document and timestamps the profile.
export function normalizeProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
  const result = {};
  for (const [key, limit] of [['name', 80], ['company', 120], ['discovery', 160]]) {
    const raw = profile[key];
    if (typeof raw !== 'string' || raw.length > limit || /[\u0000-\u001f\u007f]/.test(raw)) return null;
    const value = raw.trim();
    if (!value) return null;
    result[key] = value;
  }
  return result;
}
export const hasProfile = account => Boolean(normalizeProfile(account?.profile));
export async function ensureAccount(db, input) {
  const { uid, email, creationTime, acceptTermsVersion, profile } = input;
  if (acceptTermsVersion != null && acceptTermsVersion !== TERMS_VERSION) throw new Error('Terms version is no longer current');
  const cleanProfile = profile == null ? null : normalizeProfile(profile);
  if (profile != null && !cleanProfile) throw new Error('Invalid profile');
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const created = Date.parse(creationTime);
  if (typeof uid !== 'string' || !uid || uid.includes('/') || !normalized || !Number.isFinite(created) || created > Date.now() + 60_000) throw new Error('Invalid verified identity');
  const authCreatedAt = new Date(created).toISOString();
  const ref = db.collection(collection).doc(uid);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      const data = snap.data();
      if (!data || data.uid !== uid || data.email !== normalized || data.active !== true || (data.authCreatedAt != null && data.authCreatedAt !== authCreatedAt)) throw new Error('Account record is invalid or disabled');
      const updates = {};
      // Bind old records to the verified Firebase creation time on first sign-in.
      // Legacy trial fields, if any, are left unchanged and are never used for access.
      if (data.authCreatedAt == null) updates.authCreatedAt = authCreatedAt;
      if (acceptTermsVersion === TERMS_VERSION && (data.termsVersion !== TERMS_VERSION || !Number.isFinite(Date.parse(data.termsAcceptedAt)))) Object.assign(updates, { termsVersion: TERMS_VERSION, termsAcceptedAt: new Date().toISOString() });
      if (cleanProfile && !hasProfile(data)) {
        if (!(acceptTermsVersion === TERMS_VERSION || (data.termsVersion === TERMS_VERSION && Number.isFinite(Date.parse(data.termsAcceptedAt))))) throw new Error('Accept the terms before saving a profile');
        Object.assign(updates, { profile: cleanProfile, profileUpdatedAt: new Date().toISOString() });
      }
      if (Object.keys(updates).length) tx.update(ref, updates);
      return { ...data, ...updates };
    }
    if (cleanProfile && acceptTermsVersion !== TERMS_VERSION) throw new Error('Accept the terms before saving a profile');
    const data = { uid, email: normalized, active: true, authCreatedAt, ...(acceptTermsVersion === TERMS_VERSION ? { termsVersion: TERMS_VERSION, termsAcceptedAt: new Date().toISOString() } : {}), ...(cleanProfile ? { profile: cleanProfile, profileUpdatedAt: new Date().toISOString() } : {}) };
    tx.create(ref, data);
    return data;
  });
}
export async function readAccount(db, user) {
  if (typeof user?.uid !== 'string' || !user.uid || user.uid.includes('/') || typeof user.email !== 'string' || !user.email.trim()) throw new Error('Invalid identity');
  const snap = await db.collection(collection).doc(user.uid).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (!data || data.uid !== user.uid || data.email !== user.email.trim().toLowerCase() || data.active !== true) return null;
  return { termsAccepted: data.termsVersion === TERMS_VERSION && Number.isFinite(Date.parse(data.termsAcceptedAt)), profileComplete: hasProfile(data) };
}
