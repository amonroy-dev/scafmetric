// Agreement to the scaffold builder notice, kept on the account record.
//
// The notice says the builder is for estimating and is not engineering (the
// wording is in src/scaffold-notice.js). A person agrees once; what is stored
// is which version they agreed to and when, beside the terms acceptance the
// account already carries. The server, not the browser, writes the date, and
// the first agreement to a version is never moved: it is the record of when
// they were told.
import { SCAFFOLD_NOTICE_VERSION, SCAFFOLD_NOTICE_ID, SCAFFOLD_NOTICE_CONFIRMATIONS } from '../src/scaffold-notice.js';

export { SCAFFOLD_NOTICE_VERSION, SCAFFOLD_NOTICE_ID, SCAFFOLD_NOTICE_CONFIRMATIONS };

const collection = 'scafmetricAccounts';

/** Thrown when the notice agreed to is not the one in force. */
export class StaleNoticeError extends Error {}
/** Thrown when there is no usable account to record against. */
export class NoAccountError extends Error {}

function identity(user) {
  if (typeof user?.uid !== 'string' || !user.uid || user.uid.includes('/') || typeof user.email !== 'string' || !user.email.trim()) throw new Error('Invalid identity');
  return { uid: user.uid, email: user.email.trim().toLowerCase() };
}
const owns = (data, who) => Boolean(data) && data.uid === who.uid && data.email === who.email && data.active === true;

/** What an account record says about the notice in force. */
export function scaffoldNoticeStatus(data) {
  const acceptedAt = data?.scaffoldNoticeVersion === SCAFFOLD_NOTICE_VERSION && Number.isFinite(Date.parse(data?.scaffoldNoticeAcceptedAt))
    ? data.scaffoldNoticeAcceptedAt : null;
  return { version: SCAFFOLD_NOTICE_VERSION, accepted: acceptedAt !== null, acceptedAt };
}

/** Whether this account has agreed to the notice in force; null with no usable account. */
export async function readScaffoldNotice(db, user) {
  const who = identity(user);
  const snap = await db.collection(collection).doc(who.uid).get();
  const data = snap.exists ? snap.data() : null;
  return owns(data, who) ? scaffoldNoticeStatus(data) : null;
}

/**
 * Record that this account agrees to the notice. `version` must be the one in
 * force and `confirmed` must name every box on it.
 */
export async function acceptScaffoldNotice(db, user, { version, confirmed } = {}, now = Date.now()) {
  const who = identity(user);
  if (version !== SCAFFOLD_NOTICE_VERSION) throw new StaleNoticeError('The notice has changed');
  if (!Array.isArray(confirmed) || !SCAFFOLD_NOTICE_CONFIRMATIONS.every(id => confirmed.includes(id))) throw new Error('Every statement must be confirmed');
  const ref = db.collection(collection).doc(who.uid);
  return db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : null;
    if (!owns(data, who)) throw new NoAccountError('Account record is missing or disabled');
    const already = scaffoldNoticeStatus(data);
    if (already.accepted) return already;
    const acceptedAt = new Date(now).toISOString();
    tx.update(ref, { scaffoldNoticeVersion: SCAFFOLD_NOTICE_VERSION, scaffoldNoticeAcceptedAt: acceptedAt });
    return { version: SCAFFOLD_NOTICE_VERSION, accepted: true, acceptedAt };
  });
}
