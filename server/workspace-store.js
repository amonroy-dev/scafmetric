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

/**
 * Returns { beam, scaffold, updatedAt, beamUpdatedAt, scaffoldUpdatedAt }, or
 * null when absent or expired.
 *
 * The beam inputs and the scaffold model are saved separately, so each has its
 * own time and its own thirty days: a half last saved longer ago than that is
 * not handed back, even if the other half was saved this morning. Records
 * written before the halves kept their own times carry one time for both.
 */
export async function readWorkspace(db, user, now = Date.now()) {
  const ref = db.collection(COLLECTION).doc(keyFor(user.uid));
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (!data || data.uid !== user.uid) return null;
  if (isExpired(data, now)) return null;
  const beamUpdatedAt = data.beamUpdatedAt ?? data.updatedAt;
  const scaffoldUpdatedAt = data.scaffoldUpdatedAt ?? data.updatedAt;
  const kept = stamp => !isExpired({ updatedAt: stamp }, now);
  return {
    beam: kept(beamUpdatedAt) ? data.beam ?? null : null,
    scaffold: kept(scaffoldUpdatedAt) ? data.scaffold ?? null : null,
    updatedAt: data.updatedAt,
    beamUpdatedAt,
    scaffoldUpdatedAt,
  };
}

/**
 * Save the halves given, leaving the other as it was. Returns { updatedAt, expiresAt }.
 *
 * The beam form saves `beam` and the builder saves `scaffold`, each on its own.
 * Writing the whole record every time meant saving one wiped the other.
 */
export async function saveWorkspace(db, user, input, now = Date.now()) {
  const updatedAt = new Date(now).toISOString();
  const expiresAt = new Date(now + RETENTION_MS).toISOString();
  const ref = db.collection(COLLECTION).doc(keyFor(user.uid));
  const record = { uid: user.uid, email: String(user.email ?? '').trim().toLowerCase(), updatedAt, expiresAt };
  if (input.beam !== undefined) Object.assign(record, { beam: input.beam, beamUpdatedAt: updatedAt });
  if (input.scaffold !== undefined) Object.assign(record, { scaffold: input.scaffold, scaffoldUpdatedAt: updatedAt });
  // mergeFields replaces each named field whole (a plain merge would blend the
  // new beam inputs into the old ones) and leaves every other field alone.
  await ref.set(record, { mergeFields: Object.keys(record) });
  return { updatedAt, expiresAt };
}

export async function deleteWorkspace(db, user) {
  await db.collection(COLLECTION).doc(keyFor(user.uid)).delete();
  return { deleted: true };
}
