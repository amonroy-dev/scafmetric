import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectsHandler } from '../api/projects.js';
import { saveProject } from '../server/project-collection.js';
import { checkEntitlement } from '../server/entitlement.js';
import { issueSession } from '../server/session-core.js';

const env = { NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://example.com', FIREBASE_PROJECT_ID: 'project', FIREBASE_CLIENT_EMAIL: 'service@example.com', FIREBASE_PRIVATE_KEY: 'test', SESSION_SECRET: 'a strong sufficiently long secret for testing' };
const user = { uid: 'u1', email: 'PERSON@example.com', name: 'Person' };
const cookie = `__scafmetric_session=${issueSession(user, env).token}`;
const payload = { project: 'Project A', preparer: 'Pat', submissionId: '7ed0734f-6dc9-4434-8a27-4d66006fb01f' };
const request = (body = payload, headers = {}, method = 'POST') => ({ method, body, headers: { origin: 'https://example.com', 'content-type': 'application/json', cookie, ...headers } });
const response = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } });

test('project endpoint records only validated fields for the authenticated account', async () => {
  let saved;
  const handler = createProjectsHandler({ env, getDatabase:() => ({}), accountFor: async () => ({ termsAccepted: true, profileComplete: true }), entitlementFor:async () => ({hasAccess:true}), store: async (account, input) => { saved = { account, input }; return { duplicate: false }; } });
  let r = response(); await handler(request({ ...payload, project: '  Project A  ' }), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(saved, { account: user, input: payload });
  for (const body of [ { ...payload, project: ' ' }, { ...payload, preparer: 'x'.repeat(121) }, { ...payload, project: 'a\nb' }, { ...payload, submissionId: '../bad' }, { ...payload, email: 'spoof@example.com' } ]) {
    r = response(); await handler(request(body), r); assert.equal(r.statusCode, 400);
  }
});

test('project endpoint fails closed for cross-origin, unauthenticated, unavailable or disabled accounts', async () => {
  let writes = 0;
  const make = extra => createProjectsHandler({ env, getDatabase:() => ({}), accountFor: async () => ({ termsAccepted: true, profileComplete: true }), entitlementFor:async () => ({hasAccess:true}), store: async () => { writes++; return {}; }, ...extra });
  let r = response(); await make()(request(payload, { origin: 'https://other.example' }), r); assert.equal(r.statusCode, 403);
  r = response(); await make()(request(payload, { cookie: '' }), r); assert.equal(r.statusCode, 401);
  r = response(); await make({ accountFor: async () => null })(request(), r); assert.equal(r.statusCode, 401);
  r = response(); await make({ accountFor: async () => ({ termsAccepted: false, profileComplete: true }) })(request(), r); assert.equal(r.statusCode, 403);
  r = response(); await make({ accountFor: async () => ({ termsAccepted: true, profileComplete: false }) })(request(), r); assert.equal(r.statusCode, 403);
  r = response(); await make({ accountFor: async () => { throw Error('offline'); } })(request(), r); assert.equal(r.statusCode, 503);
  r = response(); await make()(request(payload, {}, 'GET'), r); assert.equal(r.statusCode, 405);
  r = response(); await make()(request(payload, { 'content-type': 'text/plain' }), r); assert.equal(r.statusCode, 415);
  assert.equal(writes, 0);
});

test('project endpoint requires verified paid or lifetime access before any write', async () => {
  let writes = 0, grant = {lifetimeFree:true};
  const db = { collection(name) { assert.equal(name,'billingEntitlements'); return { doc(uid) { assert.equal(uid,user.uid); return { get:async () => ({exists:Boolean(grant),data:() => grant}) }; } }; } };
  const make = extra => createProjectsHandler({ env, getDatabase:() => db, accountFor:async () => ({termsAccepted:true,profileComplete:true}), entitlementFor:checkEntitlement, store:async () => { writes++; return {}; }, ...extra });
  let r=response(); await make()(request(),r); assert.equal(r.statusCode,200); assert.equal(writes,1);
  grant=null;
  r=response(); await make()(request(),r); assert.equal(r.statusCode,503); assert.equal(writes,1);
  r=response(); await make({verifyPaid:async () => false})(request(),r); assert.equal(r.statusCode,403); assert.equal(writes,1);
  r=response(); await make({verifyPaid:async () => true})(request(),r); assert.equal(r.statusCode,200); assert.equal(writes,2);
});

test('project writes are isolated by user and idempotent for retries', async () => {
  const records = new Map();
  const db = { collection(name) { assert.equal(name, 'scafmetricProjects'); return { doc(key) { return { key }; } }; }, async runTransaction(fn) { return fn({ async get(ref) { const data = records.get(ref.key); return { exists: !!data, data: () => data }; }, create(ref, data) { assert.equal(records.has(ref.key), false); records.set(ref.key, data); } }); } };
  assert.deepEqual(await saveProject(db, user, payload), { conflict: false, duplicate: false });
  assert.deepEqual(await saveProject(db, user, payload), { conflict: false, duplicate: true });
  assert.deepEqual(await saveProject(db, user, { ...payload, project: 'Changed' }), { conflict: true });
  assert.deepEqual(await saveProject(db, { ...user, uid: 'u2' }, payload), { conflict: false, duplicate: false });
  assert.equal(records.size, 2);
  const record = [...records.values()][0];
  assert.deepEqual(Object.keys(record).sort(), ['createdAt', 'email', 'preparer', 'project', 'uid']);
  assert.equal(record.email, 'person@example.com');
  assert.ok(Number.isFinite(Date.parse(record.createdAt)));
});
