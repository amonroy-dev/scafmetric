import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkEntitlement, EntitlementUnavailableError } from '../server/entitlement.js';

function database(data, { failure = false } = {}) {
  return {
    collection(name) {
      assert.equal(name, 'billingEntitlements');
      return { doc(uid) { return { async get() {
        if (failure) throw new Error('storage failure');
        const value = data[uid];
        return { exists: value !== undefined, data: () => value };
      } }; } };
    }
  };
}

test('only an explicit server-owned lifetime boolean grants free access without billing', async () => {
  const db = database({ owner: { lifetimeFree: true }, text: { lifetimeFree: 'true' }, flag: { freeLifetime: true }, number: { lifetimeFree: 1 } });
  assert.deepEqual(await checkEntitlement({ db, uid: 'owner' }), { hasAccess: true, reason: 'lifetime' });
  for (const uid of ['text', 'flag', 'number', 'missing']) {
    assert.deepEqual(await checkEntitlement({ db, uid, verifyPaid: async () => false }), { hasAccess: false, reason: 'payment_required' });
  }
});

test('paid access is granted only on explicit server-verifier success; trial and cached flags do not suffice', async () => {
  const db = database({ member: { reason: 'trial', accessUntil: new Date('2999-01-01'), paid: true } });
  const checked = [];
  assert.deepEqual(await checkEntitlement({ db, uid: 'member', verifyPaid: async uid => { checked.push(uid); return true; } }), { hasAccess: true, reason: 'paid' });
  assert.deepEqual(checked, ['member']);
  assert.deepEqual(await checkEntitlement({ db, uid: 'member', verifyPaid: async () => false }), { hasAccess: false, reason: 'payment_required' });
  for (const invalid of ['active', { paid: true }, 1, null]) {
    await assert.rejects(checkEntitlement({ db, uid: 'member', verifyPaid: async () => invalid }), EntitlementUnavailableError);
  }
});

test('invalid identity, storage failure and unverifiable billing fail closed', async () => {
  const db = database({});
  for (const uid of ['', 'bad/id', 'x'.repeat(129), null]) await assert.rejects(checkEntitlement({ db, uid, verifyPaid: async () => true }), EntitlementUnavailableError);
  await assert.rejects(checkEntitlement({ db: database({}, { failure: true }), uid: 'member', verifyPaid: async () => true }), EntitlementUnavailableError);
  await assert.rejects(checkEntitlement({ db, uid: 'member' }), EntitlementUnavailableError);
  await assert.rejects(checkEntitlement({ db, uid: 'member', verifyPaid: async () => { throw new Error('provider down'); } }), EntitlementUnavailableError);
});
