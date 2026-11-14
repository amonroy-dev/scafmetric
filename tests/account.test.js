import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureAccount, readAccount, TRIAL_MS, TERMS_VERSION } from '../server/account.js';

function fakeDatabase() {
  const docs = new Map(); let queue = Promise.resolve();
  const ref = id => ({ id, get: async () => ({ exists: docs.has(id), data: () => docs.get(id) }) });
  return {
    docs,
    collection: () => ({ doc: ref }),
    runTransaction: operation => {
      const result = queue.then(() => operation({ get: r => r.get(), create: (r, value) => { if (docs.has(r.id)) throw Error('Already exists'); docs.set(r.id, value); }, update: (r, value) => { if (!docs.has(r.id)) throw Error('Missing'); docs.set(r.id, { ...docs.get(r.id), ...value }); } }));
      queue = result.catch(() => {}); return result;
    },
  };
}
const identity = { uid: 'user123', email: 'Customer@Example.com', creationTime: '2020-01-01T00:00:00.000Z' };

test('trial uses Firebase account creation time, not first sign-in', async () => {
  const db = fakeDatabase();
  const account = await ensureAccount(db, identity);
  assert.equal(account.trialStartedAt, '2020-01-01T00:00:00.000Z');
  assert.equal(Date.parse(account.trialEndsAt) - Date.parse(account.trialStartedAt), TRIAL_MS);
  assert.equal((await readAccount(db, { uid: identity.uid, email: identity.email })).trialActive, false);
});

test('repeat and concurrent sign-ins cannot extend an existing trial', async () => {
  const db = fakeDatabase();
  const [first, second] = await Promise.all([ensureAccount(db, identity), ensureAccount(db, identity)]);
  assert.deepEqual(first, second);
  assert.equal(db.docs.size, 1);
  await assert.rejects(ensureAccount(db, { ...identity, creationTime: '2021-01-01T00:00:00.000Z' }));
  assert.deepEqual(db.docs.get(identity.uid), first);
});

test('invalid, missing, and disabled account data fail closed', async () => {
  const db = fakeDatabase();
  await assert.rejects(ensureAccount(db, { ...identity, creationTime: 'invalid' }));
  await ensureAccount(db, identity);
  db.docs.get(identity.uid).active = false;
  assert.equal(await readAccount(db, identity), null);
  await assert.rejects(ensureAccount(db, identity));
  await assert.rejects(ensureAccount({ ...db, runTransaction: async () => { throw Error('unavailable'); } }, identity));
});


test('acceptance is explicit, versioned and persists without extending trial', async () => {
  const db = fakeDatabase();
  const before = await ensureAccount(db, identity);
  assert.equal((await readAccount(db, identity)).termsAccepted, false);
  await assert.rejects(ensureAccount(db, { ...identity, acceptTermsVersion: 'old' }));
  const accepted = await ensureAccount(db, { ...identity, acceptTermsVersion: TERMS_VERSION });
  assert.equal(accepted.termsVersion, TERMS_VERSION);
  assert.ok(Number.isFinite(Date.parse(accepted.termsAcceptedAt)));
  assert.equal(accepted.trialEndsAt, before.trialEndsAt);
  assert.equal((await readAccount(db, identity)).termsAccepted, true);
  const repeat = await ensureAccount(db, identity);
  assert.equal(repeat.termsAcceptedAt, accepted.termsAcceptedAt);
  db.docs.get(identity.uid).termsAcceptedAt = 'invalid';
  assert.equal((await readAccount(db, identity)).termsAccepted, false);
  await ensureAccount(db, { ...identity, acceptTermsVersion: TERMS_VERSION });
  assert.equal((await readAccount(db, identity)).termsAccepted, true);
  db.docs.get(identity.uid).termsVersion = 'older-version';
  assert.equal((await readAccount(db, identity)).termsAccepted, false);
});
