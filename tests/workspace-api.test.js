import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceHandler, parseInput } from '../api/workspace.js';
import { readWorkspace, saveWorkspace, deleteWorkspace, isExpired, RETENTION_DAYS, RETENTION_MS, COLLECTION } from '../server/workspace-store.js';
import { issueSession } from '../server/session-core.js';

const env = { NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://example.com', FIREBASE_PROJECT_ID: 'project', FIREBASE_CLIENT_EMAIL: 'service@example.com', FIREBASE_PRIVATE_KEY: 'test', SESSION_SECRET: 'a strong sufficiently long secret for testing' };
const user = { uid: 'u1', email: 'PERSON@example.com', name: 'Person' };
const cookie = `__scafmetric_session=${issueSession(user, env).token}`;
const request = (body = null, headers = {}, method = 'PUT') => ({ method, body, headers: { origin: 'https://example.com', 'content-type': 'application/json', cookie, ...headers } });
const response = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } });

const payload = { beam: { fields: { span: '20' }, loads: [] }, scaffold: '{"standards":[]}' };

test('workspace input accepts beam and scaffold, rejects anything else', () => {
  assert.deepEqual(parseInput(payload), { beam: payload.beam, scaffold: payload.scaffold });
  assert.deepEqual(parseInput({ beam: payload.beam }), { beam: payload.beam, scaffold: null });
  assert.deepEqual(parseInput({ scaffold: 'x' }), { beam: null, scaffold: 'x' });
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
          async set(data) { records.set(key, data); },
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
