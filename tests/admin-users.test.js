import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminUsers, AdminActionError, isInvited, normalizeEmail, sendFirebaseReset, ACCOUNTS, ENTITLEMENTS, BILLING, INVITES, ADMIN_LOG } from '../server/admin-users.js';
import { createAdminUsersHandler } from '../api/admin/users.js';
import { COOKIE_NAME, issueSession } from '../server/session-core.js';
import { TERMS_VERSION } from '../src/terms.js';

const env = { NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://example.com', FIREBASE_PROJECT_ID: 'project', FIREBASE_CLIENT_EMAIL: 'service@example.com', FIREBASE_PRIVATE_KEY: 'test', SESSION_SECRET: 'a strong sufficiently long secret for testing', ADMIN_UIDS: 'owner-1, owner-2' };
const admin = { uid: 'owner-1', email: 'owner@example.com', name: 'Owner' };

// The smallest Firestore and Auth that the owner actions touch.
function fakeDb(seed = {}) {
  const data = new Map(Object.entries(seed).map(([name, docs]) => [name, new Map(Object.entries(docs))]));
  const col = name => { if (!data.has(name)) data.set(name, new Map()); return data.get(name); };
  let auto = 0;
  return {
    data,
    collection: name => ({
      doc: id => ({
        get: async () => ({ exists: col(name).has(id), data: () => col(name).get(id) }),
        set: async (value, opts) => { col(name).set(id, opts?.merge ? { ...col(name).get(id), ...value } : value); },
        update: async value => { col(name).set(id, { ...col(name).get(id), ...value }); },
        delete: async () => { col(name).delete(id); },
      }),
      add: async value => { col(name).set(`auto${++auto}`, value); },
      orderBy: field => ({ limit: () => ({ get: async () => ({ docs: [...col(name).values()].sort((a, b) => String(b[field]).localeCompare(String(a[field]))).map(v => ({ data: () => v })) }) }) }),
    }),
  };
}
function fakeAuth(users) {
  const byUid = new Map(users.map(u => [u.uid, { ...u }]));
  const missing = () => Object.assign(new Error('none'), { code: 'auth/user-not-found' });
  return {
    byUid, revoked: [],
    async getUser(uid) { if (!byUid.has(uid)) throw missing(); return byUid.get(uid); },
    async getUserByEmail(email) { const u = [...byUid.values()].find(x => x.email === email); if (!u) throw missing(); return u; },
    async updateUser(uid, patch) { Object.assign(byUid.get(uid), patch); },
    async revokeRefreshTokens(uid) { this.revoked.push(uid); },
  };
}
const person = (uid, email, providers = ['password']) => ({ uid, email, emailVerified: true, disabled: false, displayName: uid, metadata: { creationTime: 'Mon, 01 Jan 2026 00:00:00 GMT', lastSignInTime: 'Tue, 02 Jan 2026 00:00:00 GMT' }, providerData: providers.map(providerId => ({ providerId })) });

function setup() {
  const auth = fakeAuth([person('u1', 'ann@example.com'), person('g1', 'gus@example.com', ['google.com']), person('owner-1', 'owner@example.com'), person('owner-2', 'second@example.com')]);
  const db = fakeDb({
    [ACCOUNTS]: { u1: { uid: 'u1', email: 'ann@example.com', active: true, termsVersion: TERMS_VERSION, termsAcceptedAt: '2026-01-01T00:00:00.000Z', profile: { name: 'Ann', company: 'Acme', discovery: 'Search' } } },
    [BILLING]: { u1: { stripeCustomerId: 'cus_123', riskHold: false } },
  });
  const sent = [];
  const users = createAdminUsers({ auth, db, env, sendReset: async email => { sent.push(email); }, now: () => new Date('2026-11-23T12:00:00Z') });
  const log = () => [...(db.data.get(ADMIN_LOG) || new Map()).values()];
  return { auth, db, users, sent, log };
}

test('a user can be found by email or account ID, with their status and access', async () => {
  const { users } = setup();
  const byEmail = await users.find('  Ann@Example.com ');
  assert.equal(byEmail.uid, 'u1');
  assert.deepEqual(byEmail.signsInWith, ['password']);
  assert.equal(byEmail.blocked, false);
  assert.equal(byEmail.account.company, 'Acme');
  assert.equal(byEmail.account.termsAccepted, true);
  assert.deepEqual([byEmail.access.free, byEmail.access.stripeCustomerId], [false, 'cus_123']);
  assert.equal((await users.find('u1')).email, 'ann@example.com');
  assert.equal(await users.find('nobody@example.com'), null);
  assert.equal(await users.find('a/b'), null, 'an ID with a slash is never looked up');
  assert.equal((await users.find('owner-2')).isOwner, true);
});

test('a password reset is emailed to the user and logged; a Google account has none to reset', async () => {
  const { users, sent, log } = setup();
  const out = await users.act('send-reset', { uid: 'u1' }, admin);
  assert.equal(out.ok, true);
  assert.deepEqual(sent, ['ann@example.com'], 'sent to the address on the account, not one supplied by the caller');
  assert.ok(!JSON.stringify(out).includes('oobCode') && !JSON.stringify(out).includes('http'), 'no link comes back to the owner');
  assert.deepEqual(log().map(l => [l.action, l.targetEmail, l.adminEmail, l.at]), [['send-reset', 'ann@example.com', 'owner@example.com', '2026-11-23T12:00:00.000Z']]);
  await assert.rejects(users.act('send-reset', { uid: 'g1' }, admin), e => e instanceof AdminActionError && e.status === 409 && /Google/.test(e.message));
  assert.deepEqual(sent, ['ann@example.com']);
});

test('blocking disables sign-in, ends their sessions and marks the account; unblocking restores it', async () => {
  const { users, auth, db, log } = setup();
  const blocked = await users.act('block', { uid: 'u1' }, admin);
  assert.equal(auth.byUid.get('u1').disabled, true);
  assert.deepEqual(auth.revoked, ['u1']);
  assert.equal(db.data.get(ACCOUNTS).get('u1').active, false);
  assert.equal(blocked.user.blocked, true);
  const back = await users.act('unblock', { uid: 'u1' }, admin);
  assert.equal(auth.byUid.get('u1').disabled, false);
  assert.equal(db.data.get(ACCOUNTS).get('u1').active, true);
  assert.equal(back.user.blocked, false);
  assert.deepEqual(log().map(l => l.action), ['block', 'unblock']);
  // An account that never finished sign-up has no record to mark; blocking still works.
  await users.act('block', { uid: 'g1' }, admin);
  assert.equal(auth.byUid.get('g1').disabled, true);
  assert.equal(db.data.get(ACCOUNTS).has('g1'), false);
});

test('an owner cannot block themselves or another owner', async () => {
  const { users, auth, log } = setup();
  await assert.rejects(users.act('block', { uid: 'owner-1' }, admin), e => e.status === 409 && /your own/.test(e.message));
  await assert.rejects(users.act('block', { uid: 'owner-2' }, admin), e => e.status === 409 && /Owner accounts/.test(e.message));
  assert.equal(auth.byUid.get('owner-1').disabled, false);
  assert.equal(auth.byUid.get('owner-2').disabled, false);
  assert.equal(log().length, 0, 'a refused action is not logged as done');
});

test('free access is granted and removed on the server-owned entitlement record', async () => {
  const { users, db } = setup();
  const granted = await users.act('grant-access', { uid: 'u1' }, admin);
  assert.equal(db.data.get(ENTITLEMENTS).get('u1').lifetimeFree, true);
  assert.equal(db.data.get(ENTITLEMENTS).get('u1').updatedByEmail, 'owner@example.com');
  assert.equal(granted.user.access.free, true);
  const removed = await users.act('remove-access', { uid: 'u1' }, admin);
  assert.equal(db.data.get(ENTITLEMENTS).get('u1').lifetimeFree, false);
  assert.equal(removed.user.access.free, false);
});

test('invites are added, listed and removed, and only valid addresses are accepted', async () => {
  const { users, db } = setup();
  await users.act('invite', { email: ' New.Person@Example.com ' }, admin);
  assert.equal(await isInvited(db, 'new.person@example.com'), true);
  assert.equal(await isInvited(db, 'NEW.PERSON@example.com'), true, 'case does not matter');
  assert.equal(await isInvited(db, 'other@example.com'), false);
  assert.deepEqual((await users.invites()).map(i => [i.email, i.invitedBy]), [['new.person@example.com', 'owner@example.com']]);
  await users.act('remove-invite', { email: 'new.person@example.com' }, admin);
  assert.equal(await isInvited(db, 'new.person@example.com'), false);
  for (const bad of ['', 'not an email', 'a/b@example.com', 'x@y', null]) {
    await assert.rejects(users.act('invite', { email: bad }, admin), e => e.status === 400);
    assert.equal(await isInvited(db, bad), false);
  }
  assert.equal(normalizeEmail('A@B.co'), 'a@b.co');
  assert.equal(db.data.get(INVITES).size, 0);
});

test('unknown actions, missing users and bad IDs are refused', async () => {
  const { users } = setup();
  await assert.rejects(users.act('delete', { uid: 'u1' }, admin), e => e.status === 400);
  await assert.rejects(users.act('block', { uid: 'gone' }, admin), e => e.status === 404);
  await assert.rejects(users.act('block', { uid: 'a/b' }, admin), e => e.status === 400);
  await assert.rejects(users.act('block', {}, admin), e => e.status === 400);
});

test('the reset email goes through Firebase with the address only, and a failure is reported', async () => {
  const calls = [];
  await sendFirebaseReset('ann@example.com', { NEXT_PUBLIC_FIREBASE_API_KEY: 'key 1' }, async (url, init) => { calls.push([url, JSON.parse(init.body)]); return { ok: true }; });
  assert.match(calls[0][0], /accounts:sendOobCode\?key=key%201$/);
  assert.deepEqual(calls[0][1], { requestType: 'PASSWORD_RESET', email: 'ann@example.com' });
  await assert.rejects(sendFirebaseReset('a@b.co', {}, async () => ({ ok: true })), e => e.status === 503);
  await assert.rejects(sendFirebaseReset('a@b.co', { NEXT_PUBLIC_FIREBASE_API_KEY: 'k' }, async () => ({ ok: false })), e => e.status === 502);
});

// --- the endpoint ------------------------------------------------------------

const cookie = identity => `${COOKIE_NAME}=${issueSession(identity, env).token}`;
function response() { return { headers: {}, statusCode: 0, body: null, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } }; }
const post = (identity, body, headers = {}) => ({ method: 'POST', body, query: {}, headers: { ...(identity ? { cookie: cookie(identity) } : {}), origin: 'https://example.com', 'content-type': 'application/json', ...headers } });
const get = (identity, query) => ({ method: 'GET', query, headers: identity ? { cookie: cookie(identity) } : {} });

function endpoint(account = { termsAccepted: true, profileComplete: true }) {
  const s = setup();
  const handler = createAdminUsersHandler({ env, services: () => ({ db: s.db, users: s.users }), accountFor: async () => account });
  return { ...s, handler };
}

test('only a signed-in, allowlisted, fully set up owner reaches the tools', async () => {
  const { handler, auth } = endpoint();
  let r = response(); await handler(get(null, { q: 'u1' }), r); assert.equal(r.statusCode, 401);
  r = response(); await handler(get({ uid: 'u1', email: 'ann@example.com', name: 'Ann' }, { q: 'u1' }), r); assert.equal(r.statusCode, 403);
  r = response(); await handler(post({ uid: 'u1', email: 'ann@example.com', name: 'Ann' }, { action: 'block', uid: 'g1' }), r); assert.equal(r.statusCode, 403);
  assert.equal(auth.byUid.get('g1').disabled, false, 'a non-owner changes nothing');
  r = response(); await handler(get(admin, { q: 'ann@example.com' }), r); assert.equal(r.statusCode, 200); assert.equal(r.body.user.uid, 'u1');
  assert.match(r.headers['Cache-Control'], /no-store/);
  const incomplete = endpoint({ termsAccepted: true, profileComplete: false });
  r = response(); await incomplete.handler(get(admin, { q: 'u1' }), r); assert.equal(r.statusCode, 403);
});

test('changes must be same-site JSON POSTs', async () => {
  const { handler, auth } = endpoint();
  let r = response(); await handler(post(admin, { action: 'block', uid: 'u1' }, { origin: 'https://evil.example' }), r); assert.equal(r.statusCode, 403);
  r = response(); await handler(post(admin, { action: 'block', uid: 'u1' }, { 'content-type': 'text/plain' }), r); assert.equal(r.statusCode, 415);
  r = response(); await handler({ ...post(admin, { action: 'block', uid: 'u1' }), method: 'DELETE' }, r); assert.equal(r.statusCode, 405);
  r = response(); await handler(post(admin, { uid: 'u1' }), r); assert.equal(r.statusCode, 400);
  assert.equal(auth.byUid.get('u1').disabled, false);
  r = response(); await handler(post(admin, { action: 'block', uid: 'u1' }), r); assert.equal(r.statusCode, 200); assert.equal(r.body.user.blocked, true);
});

test('the endpoint reports refusals plainly and lists invites and activity', async () => {
  const { handler } = endpoint();
  let r = response(); await handler(post(admin, { action: 'block', uid: 'owner-1' }), r); assert.equal(r.statusCode, 409); assert.match(r.body.error, /your own/);
  r = response(); await handler(get(admin, { q: 'nobody@example.com' }), r); assert.equal(r.statusCode, 404);
  r = response(); await handler(get(admin, {}), r); assert.equal(r.statusCode, 400);
  r = response(); await handler(post(admin, { action: 'invite', email: 'new@example.com' }), r); assert.equal(r.statusCode, 200);
  r = response(); await handler(get(admin, { list: 'invites' }), r); assert.deepEqual(r.body.invites.map(i => i.email), ['new@example.com']);
  r = response(); await handler(get(admin, { list: 'log' }), r); assert.deepEqual(r.body.log.map(l => l.action), ['invite']);
  const down = createAdminUsersHandler({ env, services: () => { throw new Error('down'); } });
  r = response(); await down(get(admin, { q: 'u1' }), r); assert.equal(r.statusCode, 503);
});
