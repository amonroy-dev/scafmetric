import { createHash } from 'node:crypto';

// One event per successful analysis, identified by a client-generated UUID.
// The signed-in UID is part of the key so callers cannot overwrite each other.
export async function saveProject(db, user, input) {
  const key = createHash('sha256').update(user.uid).update('\0').update(input.submissionId).digest('hex');
  const ref = db.collection('scafmetricProjects').doc(key);
  return db.runTransaction(async tx => {
    const existing = await tx.get(ref);
    if (existing.exists) {
      const data = existing.data();
      if (data.uid !== user.uid || data.project !== input.project || data.preparer !== input.preparer) return { conflict: true };
      return { conflict: false, duplicate: true };
    }
    tx.create(ref, {
      uid: user.uid,
      email: user.email.trim().toLowerCase(),
      project: input.project,
      preparer: input.preparer,
      createdAt: new Date().toISOString()
    });
    return { conflict: false, duplicate: false };
  });
}
