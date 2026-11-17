import { createHash } from 'node:crypto';

// One saved workspace per signed-in account: the beam inputs and the scaffold
// model, retained for RETENTION_DAYS. The UID is the document key so callers
// can never read or overwrite another account's work.

export const RETENTION_DAYS = 30;
export const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const COLLECTION = 'scafmetricWorkspaces';

function keyFor(uid) {
  return createHash('sha256').update(uid).digest('hex');
}

export function isExpired(data, now = Date.now()) {
  if (!data || typeof data.updatedAt !== 'string') return true;
  const updated = Date.parse(data.updatedAt);
  if (!Number.isFinite(updated)) return true;
  return now - updated > RETENTION_MS;
}

/** Returns { beam, scaffold, updatedAt } or null when absent or expired. */
export async function readWorkspace(db, user, now = Date.now()) {
  const ref = db.collection(COLLECTION).doc(keyFor(user.uid));
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (!data || data.uid !== user.uid) return null;
  if (isExpired(data, now)) return null;
  return { beam: data.beam ?? null, scaffold: data.scaffold ?? null, updatedAt: data.updatedAt };
}

/** Replace the stored workspace. Returns { updatedAt, expiresAt }. */
export async function saveWorkspace(db, user, input, now = Date.now()) {
  const updatedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + RETENTION_MS).toISOString();
  const ref = db.collection(COLLECTION).doc(keyFor(user.uid));
  await ref.set({
    uid: user.uid,
    email: String(user.email ?? '').trim().toLowerCase(),
    beam: input.beam ?? null,
    scaffold: input.scaffold ?? null,
    updatedAt,
    expiresAt,
  });
  return { updatedAt, expiresAt };
}

export async function deleteWorkspace(db, user) {
  await db.collection(COLLECTION).doc(keyFor(user.uid)).delete();
  return { deleted: true };
}
