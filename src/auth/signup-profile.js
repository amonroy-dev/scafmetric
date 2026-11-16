const STORAGE_KEY = 'scafmetric-signup-profile';
const MAX_AGE = 24 * 60 * 60 * 1000;
export const DISCOVERY_OPTIONS = ['Google Search', 'LinkedIn', 'Reddit', 'YouTube', 'Facebook', 'Colleague or referral', 'Other'];

export function validateSignupProfile(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const [key, limit] of [['name', 80], ['company', 120], ['discovery', 160]]) {
    const raw = value[key];
    if (typeof raw !== 'string' || raw.length > limit || /[\u0000-\u001f\u007f]/.test(raw) || !raw.trim()) return null;
    result[key] = raw.trim();
  }
  return DISCOVERY_OPTIONS.includes(result.discovery) ? result : null;
}

// Only temporary profile fields are stored; credentials and tokens never are.
export function savePendingSignup(storage, { profile, uid = null, provider }, now = Date.now()) {
  const clean = validateSignupProfile(profile);
  if (!clean || !['google', 'email'].includes(provider) || (uid !== null && (typeof uid !== 'string' || !uid))) return false;
  try { storage.setItem(STORAGE_KEY, JSON.stringify({ profile: clean, uid, provider, createdAt: now })); return true; } catch { return false; }
}
export function readPendingSignup(storage, now = Date.now()) {
  try {
    const data = JSON.parse(storage.getItem(STORAGE_KEY));
    if (!data) return null;
    if (!validateSignupProfile(data.profile) || !['google', 'email'].includes(data.provider) || (data.uid !== null && (typeof data.uid !== 'string' || !data.uid)) || !Number.isFinite(data.createdAt) || now < data.createdAt || now - data.createdAt > MAX_AGE) { clearPendingSignup(storage); return null; }
    return { profile: validateSignupProfile(data.profile), uid: data.uid, provider: data.provider, createdAt: data.createdAt };
  } catch { clearPendingSignup(storage); return null; }
}
export function clearPendingSignup(storage) { try { storage.removeItem(STORAGE_KEY); } catch { /* Storage can be disabled. */ } }
export function pendingForUser(pending, uid) { return Boolean(pending && typeof uid === 'string' && uid && pending.uid === uid); }
