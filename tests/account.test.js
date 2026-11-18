import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureAccount, readAccount, TERMS_VERSION } from '../server/account.js';

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

test('new account records have no trial and are bound to verified Firebase creation time', async () => {
  const db = fakeDatabase();
  const account = await ensureAccount(db, identity);
  assert.equal(account.authCreatedAt, '2020-01-01T00:00:00.000Z');
  assert.equal(account.trialStartedAt, undefined);
  assert.equal(account.trialEndsAt, undefined);
  assert.equal((await readAccount(db, identity)).trialActive, undefined);
});

test('repeat and concurrent sign-ins preserve account identity', async () => {
  const db = fakeDatabase();
  const [first, second] = await Promise.all([ensureAccount(db, identity), ensureAccount(db, identity)]);
  assert.deepEqual(first, second);
  assert.equal(db.docs.size, 1);
  await assert.rejects(ensureAccount(db, { ...identity, creationTime: '2021-01-01T00:00:00.000Z' }));
  assert.deepEqual(db.docs.get(identity.uid), first);
});

test('legacy accounts remain valid and retain trial fields without granting trial access', async () => {
  const db = fakeDatabase();
  const legacy = { uid:identity.uid, email:identity.email.toLowerCase(), active:true, trialStartedAt:'2020-01-01T00:00:00.000Z', trialEndsAt:'2020-01-15T00:00:00.000Z' };
  db.docs.set(identity.uid, { ...legacy });
  const before = await readAccount(db, identity);
  assert.equal(before.termsAccepted, false);
  assert.equal(before.trialActive, undefined);
  const migrated = await ensureAccount(db, identity);
  assert.equal(migrated.authCreatedAt, '2020-01-01T00:00:00.000Z');
  assert.equal(migrated.trialStartedAt, legacy.trialStartedAt);
  assert.equal(migrated.trialEndsAt, legacy.trialEndsAt);
  assert.equal((await readAccount(db, identity)).trialActive, undefined);
  await assert.rejects(ensureAccount(db, { ...identity, creationTime:'2021-01-01T00:00:00.000Z' }));
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


test('acceptance is explicit, versioned and persists with account identity', async () => {
  const db = fakeDatabase();
  const before = await ensureAccount(db, identity);
  assert.equal((await readAccount(db, identity)).termsAccepted, false);
  await assert.rejects(ensureAccount(db, { ...identity, acceptTermsVersion: 'old' }));
  const accepted = await ensureAccount(db, { ...identity, acceptTermsVersion: TERMS_VERSION });
  assert.equal(accepted.termsVersion, TERMS_VERSION);
  assert.ok(Number.isFinite(Date.parse(accepted.termsAcceptedAt)));
  assert.equal(accepted.authCreatedAt, before.authCreatedAt);
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

test('an account that accepted the previous terms must accept the updated terms', async () => {
  const db = fakeDatabase();
  const account = await ensureAccount(db, identity);
  db.docs.set(identity.uid, { ...account, termsVersion:'draft-2026-11-16', termsAcceptedAt:'2026-11-16T12:00:00.000Z' });
  assert.equal((await readAccount(db, identity)).termsAccepted, false);
  await assert.rejects(ensureAccount(db, { ...identity, acceptTermsVersion:'draft-2026-11-16' }));
  const accepted = await ensureAccount(db, { ...identity, acceptTermsVersion:TERMS_VERSION });
  assert.equal((await readAccount(db, identity)).termsAccepted, true);
  assert.equal(accepted.authCreatedAt, account.authCreatedAt);
});

test('profile completion stores bounded, trimmed fields without altering account identity or terms', async () => {
  const db = fakeDatabase();
  const original = await ensureAccount(db, { ...identity, acceptTermsVersion: TERMS_VERSION });
  assert.equal((await readAccount(db, identity)).profileComplete, false);
  const updated = await ensureAccount(db, { ...identity, profile: { name: '  Alex Rivera ', company: '  Example Co  ', discovery: ' Colleague ', ignored: 'not stored' } });
  assert.deepEqual(updated.profile, { name: 'Alex Rivera', company: 'Example Co', discovery: 'Colleague' });
  assert.ok(Number.isFinite(Date.parse(updated.profileUpdatedAt)));
  assert.equal(updated.authCreatedAt, original.authCreatedAt);
  assert.equal(updated.termsAcceptedAt, original.termsAcceptedAt);
  assert.equal((await readAccount(db, identity)).profileComplete, true);
  assert.deepEqual((await ensureAccount(db, identity)).profile, updated.profile);
});

test('invalid profile fields never write partial account data', async () => {
  const db = fakeDatabase();
  await ensureAccount(db, identity);
  const badProfiles = [null, {}, { name:' ', company:'Example', discovery:'Search' }, { name:'Alex', company:'X'.repeat(121), discovery:'Search' }, { name:'Alex\nAdmin', company:'Example', discovery:'Search' }, { name:'Alex', company:'Example', discovery:42 }];
  for (const profile of badProfiles.slice(1)) await assert.rejects(ensureAccount(db, { ...identity, profile }));
  assert.equal((await readAccount(db, identity)).profileComplete, false);
  assert.equal(db.docs.get(identity.uid).profile, undefined);
});

test('signup profile is saved only after acceptance and cannot overwrite an existing completed profile', async () => {
  const db = fakeDatabase();
  const first = { name:'First User', company:'First Company', discovery:'LinkedIn' };
  const second = { name:'Other User', company:'Other Company', discovery:'Reddit' };
  await assert.rejects(ensureAccount(db, { ...identity, profile:first }));
  assert.equal(db.docs.size, 0);
  await ensureAccount(db, identity);
  await assert.rejects(ensureAccount(db, { ...identity, profile:first }));
  const [saved] = await Promise.all([
    ensureAccount(db, { ...identity, profile:first, acceptTermsVersion:TERMS_VERSION }),
    ensureAccount(db, { ...identity, profile:second, acceptTermsVersion:TERMS_VERSION })
  ]);
  assert.deepEqual(saved.profile, first);
  assert.deepEqual((await ensureAccount(db, { ...identity, profile:second })).profile, first);
});
