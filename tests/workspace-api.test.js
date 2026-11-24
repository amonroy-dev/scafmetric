import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceHandler, parseInput } from '../api/workspace.js';
import { readWorkspace, saveWorkspace, deleteWorkspace, isExpired, RETENTION_DAYS, RETENTION_MS, COLLECTION } from '../server/workspace-store.js';
import { issueSession, sameSiteRead } from '../server/session-core.js';
import { pickNewer } from '../src/scaffold/store.js';

const env = { NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://example.com', FIREBASE_PROJECT_ID: 'project', FIREBASE_CLIENT_EMAIL: 'service@example.com', FIREBASE_PRIVATE_KEY: 'test', SESSION_SECRET: 'a strong sufficiently long secret for testing' };
const user = { uid: 'u1', email: 'PERSON@example.com', name: 'Person' };
const cookie = `__scafmetric_session=${issueSession(user, env).token}`;
const request = (body = null, headers = {}, method = 'PUT') => ({ method, body, headers: { origin: 'https://example.com', 'content-type': 'application/json', cookie, ...headers } });
const response = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } });

const payload = { beam: { fields: { span: '20' }, loads: [] }, scaffold: '{"standards":[]}' };

test('workspace input accepts beam and scaffold, rejects anything else', () => {
  assert.deepEqual(parseInput(payload), { beam: payload.beam, scaffold: payload.scaffold });
  // Each half is saved on its own: a half that was not sent is not in the result,
  // so it is left as it was. An explicit null clears it.
  assert.deepEqual(parseInput({ beam: payload.beam }), { beam: payload.beam });
  assert.deepEqual(parseInput({ scaffold: 'x' }), { scaffold: 'x' });
  assert.deepEqual(parseInput({ scaffold: null }), { scaffold: null });
  for (const bad of [null, [], 'str', {}, { uid: 'spoof' }, { beam: [] }, { scaffold: 5 }, { beam: payload.beam, extra: 1 }]) {
    assert.equal(parseInput(bad), null, JSON.stringify(bad));
  }
  // oversized scaffold snapshot
  assert.equal(parseInput({ scaffold: 'x'.repeat(256 * 1024 + 1) }), null);
});

test('saving and loading round-trips for the authenticated account', async () => {
  let stored = null;
  const handler = createWorkspaceHandler({
    env,
    write: async (u, input) => { stored = { u, input }; return { updatedAt: '2026-01-01T00:00:00.000Z' }; },
    read: async () => ({ beam: payload.beam, scaffold: payload.scaffold, updatedAt: '2026-01-01T00:00:00.000Z' }),
  });
  let r = response(); await handler(request(payload), r);
  assert.equal(r.statusCode, 200);
  assert.equal(stored.u.uid, 'u1');
  assert.deepEqual(stored.input, { beam: payload.beam, scaffold: payload.scaffold });
  assert.equal(r.body.retentionDays, RETENTION_DAYS);

  r = response(); await handler(request(null, {}, 'GET'), r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.workspace.scaffold, payload.scaffold);
});

test('workspace endpoint fails closed', async () => {
  let writes = 0;
  const make = extra => createWorkspaceHandler({ env, write: async () => { writes++; return {}; }, read: async () => null, remove: async () => ({}), ...extra });
  let r = response(); await make()(request(payload, { origin: 'https://other.example' }), r); assert.equal(r.statusCode, 403);
  r = response(); await make()(request(payload, { cookie: '' }), r); assert.equal(r.statusCode, 401);
  r = response(); await make()(request(payload, {}, 'POST'), r); assert.equal(r.statusCode, 405);
  r = response(); await make()(request(payload, { 'content-type': 'text/plain' }), r); assert.equal(r.statusCode, 415);
  r = response(); await make()(request({ nope: 1 }), r); assert.equal(r.statusCode, 400);
  r = response(); await make()(request(payload, { 'content-length': String(300 * 1024) }), r); assert.equal(r.statusCode, 413);
  r = response(); await make({ write: async () => { throw Error('offline'); } })(request(payload), r); assert.equal(r.statusCode, 503);
  assert.equal(writes, 0);
});

test('delete clears the saved workspace', async () => {
  let removed = false;
  const handler = createWorkspaceHandler({ env, remove: async () => { removed = true; return { deleted: true }; } });
  const r = response(); await handler(request(null, {}, 'DELETE'), r);
  assert.equal(r.statusCode, 200);
  assert.equal(removed, true);
});

// --- store ---
function fakeDb(records = new Map()) {
  return {
    records,
    collection(name) {
      assert.equal(name, COLLECTION);
      return { doc(key) {
        return {
          key,
          async get() { const d = records.get(key); return { exists: !!d, data: () => d }; },
          // As Firestore: mergeFields replaces each named field whole and leaves the rest.
          async set(data, options) {
            if (!options?.mergeFields) { records.set(key, data); return; }
            const next = { ...(records.get(key) || {}) };
            for (const field of options.mergeFields) {
              assert.ok(field in data, `mergeFields names ${field}, which was not given`);
              next[field] = data[field];
            }
            records.set(key, next);
          },
          async delete() { records.delete(key); },
        };
      } };
    },
  };
}

test('workspace writes are isolated per account', async () => {
  const db = fakeDb();
  await saveWorkspace(db, user, payload);
  await saveWorkspace(db, { uid: 'u2', email: 'b@example.com' }, { beam: null, scaffold: 'other' });
  assert.equal(db.records.size, 2, 'separate documents');
  const mine = await readWorkspace(db, user);
  assert.equal(mine.scaffold, payload.scaffold);
  const theirs = await readWorkspace(db, { uid: 'u2', email: 'b@example.com' });
  assert.equal(theirs.scaffold, 'other');
});

test('saved work expires after the retention window', async () => {
  const db = fakeDb();
  const now = Date.UTC(2026, 0, 1);
  await saveWorkspace(db, user, payload, now);
  assert.ok(await readWorkspace(db, user, now + RETENTION_MS - 1000), 'still inside the window');
  assert.equal(await readWorkspace(db, user, now + RETENTION_MS + 1000), null, 'dropped past the window');
  assert.equal(isExpired({ updatedAt: new Date(now).toISOString() }, now + RETENTION_MS + 1), true);
  assert.equal(isExpired({}, now), true);
  assert.equal(isExpired(null, now), true);
});

// --- the account copy has to be loadable, and saving one half must not cost the other ---

test('loading saved work needs no Origin header, because browsers send none on a same-site GET', async () => {
  const stored = { beam: payload.beam, scaffold: payload.scaffold, updatedAt: '2026-01-01T00:00:00.000Z' };
  const handler = createWorkspaceHandler({ env, read: async () => stored });
  const load = async headers => { const r = response(); await handler({ method: 'GET', headers: { cookie, ...headers } }, r); return r; };

  const plain = await load({ 'sec-fetch-site': 'same-origin' });
  assert.equal(plain.statusCode, 200, 'this is the request the page makes');
  assert.equal(plain.body.workspace.scaffold, payload.scaffold);
  assert.equal((await load({})).statusCode, 200, 'an older browser that sends no fetch metadata either');
  assert.equal((await load({ origin: 'https://example.com' })).statusCode, 200);

  assert.equal((await load({ 'sec-fetch-site': 'cross-site' })).statusCode, 403, 'another site reading through the visitor');
  assert.equal((await load({ 'sec-fetch-site': 'same-site' })).statusCode, 403, 'a sibling subdomain is not this app');
  assert.equal((await load({ origin: 'https://other.example' })).statusCode, 403);
  assert.equal((await load({ cookie: '' })).statusCode, 401);

  // A write still has to name this site as its origin.
  const r = response(); await handler({ method: 'PUT', body: payload, headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', cookie } }, r);
  assert.equal(r.statusCode, 403);
});

test('a read is judged by what browsers send with it', () => {
  const read = headers => sameSiteRead({ headers }, env);
  assert.equal(read({}), true);
  assert.equal(read({ 'sec-fetch-site': 'same-origin' }), true);
  assert.equal(read({ 'sec-fetch-site': 'none' }), true, 'typed into the address bar');
  assert.equal(read({ 'sec-fetch-site': 'cross-site' }), false);
  assert.equal(read({ origin: 'https://example.com', 'sec-fetch-site': 'same-origin' }), true);
  assert.equal(read({ origin: 'https://evil.example' }), false);
});

test('saving the beam leaves the scaffold on the account, and the other way round', async () => {
  const db = fakeDb();
  const t0 = Date.UTC(2026, 0, 1);
  await saveWorkspace(db, user, { beam: { fields: { span: '20', grade: 'A992' }, loads: [] }, scaffold: 'model-1' }, t0);

  // The beam form saves its half alone.
  await saveWorkspace(db, user, { beam: { fields: { span: '24' }, loads: [] } }, t0 + 60_000);
  let found = await readWorkspace(db, user, t0 + 120_000);
  assert.equal(found.scaffold, 'model-1', 'the scaffold model is still there');
  assert.deepEqual(found.beam, { fields: { span: '24' }, loads: [] }, 'and the beam inputs are the new ones whole, not blended with the old');

  // The builder saves its half alone.
  await saveWorkspace(db, user, { scaffold: 'model-2' }, t0 + 180_000);
  found = await readWorkspace(db, user, t0 + 240_000);
  assert.equal(found.scaffold, 'model-2');
  assert.deepEqual(found.beam, { fields: { span: '24' }, loads: [] });

  // Each half says when it was last saved.
  assert.equal(found.beamUpdatedAt, new Date(t0 + 60_000).toISOString());
  assert.equal(found.scaffoldUpdatedAt, new Date(t0 + 180_000).toISOString());

  // null clears a half on purpose.
  await saveWorkspace(db, user, { scaffold: null }, t0 + 300_000);
  assert.equal((await readWorkspace(db, user, t0 + 360_000)).scaffold, null);
});

test('each half keeps its own thirty days', async () => {
  const db = fakeDb();
  const day = 24 * 60 * 60 * 1000;
  const t0 = Date.UTC(2026, 0, 1);
  await saveWorkspace(db, user, { scaffold: 'old model' }, t0);
  await saveWorkspace(db, user, { beam: { fields: { span: '20' }, loads: [] } }, t0 + 20 * day);

  const within = await readWorkspace(db, user, t0 + 25 * day);
  assert.equal(within.scaffold, 'old model');
  const later = await readWorkspace(db, user, t0 + 31 * day);
  assert.ok(later, 'the beam was saved eleven days ago, so the record is live');
  assert.deepEqual(later.beam, { fields: { span: '20' }, loads: [] });
  assert.equal(later.scaffold, null, 'the scaffold was saved thirty-one days ago and is not handed back');
  assert.equal(await readWorkspace(db, user, t0 + 51 * day), null, 'and then neither is');

  // A record from before the halves kept their own times: one time serves both.
  const old = fakeDb();
  await saveWorkspace(old, user, payload, t0);
  const [key] = [...old.records.keys()];
  const stored = old.records.get(key);
  delete stored.beamUpdatedAt; delete stored.scaffoldUpdatedAt;
  const read = await readWorkspace(old, user, t0 + day);
  assert.equal(read.scaffold, payload.scaffold);
  assert.equal(read.scaffoldUpdatedAt, stored.updatedAt);
});

test('the newer copy is judged half by half', () => {
  const morning = Date.UTC(2026, 0, 10, 9), lastWeek = Date.UTC(2026, 0, 3, 9), justNow = Date.UTC(2026, 0, 10, 15);
  const local = { savedAt: morning, data: 'this morning, on this device' };
  // On the account: a scaffold from last week, and beam inputs saved a moment ago.
  const server = {
    scaffold: 'last week', beam: {}, updatedAt: new Date(justNow).toISOString(),
    scaffoldUpdatedAt: new Date(lastWeek).toISOString(), beamUpdatedAt: new Date(justNow).toISOString(),
  };
  assert.equal(pickNewer(local, server, 'scaffold').source, 'device', 'this morning\'s scaffold is not thrown away for last week\'s');
  assert.equal(pickNewer(local, server, 'beam').source, 'account');
  // A record without per-half times falls back to its one time.
  assert.equal(pickNewer(local, { scaffold: 'x', updatedAt: new Date(justNow).toISOString() }, 'scaffold').source, 'account');
  assert.equal(pickNewer(null, null, 'beam'), null);
});

test('save records an expiry 30 days out and delete removes the doc', async () => {
  const db = fakeDb();
  const now = Date.UTC(2026, 5, 1);
  const { updatedAt, expiresAt } = await saveWorkspace(db, user, payload, now);
  assert.equal(Date.parse(expiresAt) - Date.parse(updatedAt), RETENTION_MS);
  assert.equal(RETENTION_DAYS, 30);
  await deleteWorkspace(db, user);
  assert.equal(db.records.size, 0);
  assert.equal(await readWorkspace(db, user), null);
});
