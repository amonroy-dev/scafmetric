// The notice agreed to before the scaffold builder first opens: its wording,
// the record of agreement kept on the account, the endpoint, and the gate that
// asks once.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCAFFOLD_NOTICE, SCAFFOLD_NOTICE_VERSION, SCAFFOLD_NOTICE_ID, SCAFFOLD_NOTICE_CONFIRMATIONS,
} from '../src/scaffold-notice.js';
import {
  readScaffoldNotice, acceptScaffoldNotice, scaffoldNoticeStatus, StaleNoticeError, NoAccountError,
} from '../server/acknowledgments.js';
import { createAcknowledgmentsHandler } from '../api/acknowledgments.js';
import { issueSession } from '../server/session-core.js';
import { createUseNotice } from '../src/scaffold/workspace/usenotice.js';

// --- the wording --------------------------------------------------------------

test('the notice says what the builder is for, what it is not, and who must check', () => {
  const all = [SCAFFOLD_NOTICE.title, SCAFFOLD_NOTICE.lead, ...SCAFFOLD_NOTICE.sections.flatMap(s => [s.heading, s.text])].join(' ');
  for (const [what, pattern] of [
    ['estimating is its purpose', /estimating aid/i],
    ['bids are its purpose', /prepare a bid/i],
    ['it is not engineering', /It is not engineering/],
    ['who is not providing engineering', /Monroy Labs, LLC does not provide engineering services/],
    ['it does no structural analysis', /does not perform a structural analysis/i],
    ['its loads are estimates', /Leg loads are estimates/],
    ['a real analysis can differ', /materially different/i],
    ['a qualified person must design a scaffold', /designed by a qualified person/i],
    ['the OSHA rule that says so', /29 CFR 1926\.451\(a\)\(6\)/],
    ['an engineer is sometimes required', /registered professional engineer/i],
    ['independent verification before anything is built', /independently determine the loads and verify the design/i],
    ['it is not to stand in for judgment', /in place of the judgment of a qualified person or engineer/i],
    ['the terms of use still apply', /terms of use apply/i],
    ['warranties and liability are in those terms', /disclaimer of warranties and the limits on liability/i],
  ]) assert.match(all, pattern, what);
});

test('there are two statements to tick: the intended use, and that it is not engineering', () => {
  assert.deepEqual(SCAFFOLD_NOTICE_CONFIRMATIONS, ['use', 'limits']);
  const [use, limits] = SCAFFOLD_NOTICE.confirmations;
  assert.match(use.text, /estimating and bid purposes only/);
  assert.match(limits.text, /not engineering/);
  assert.match(limits.text, /does not replace the design, analysis or judgment of a qualified person or a licensed professional engineer/);
  assert.match(SCAFFOLD_NOTICE.assent, /recorded with your account/);
  assert.match(SCAFFOLD_NOTICE_VERSION, /^\d{4}-\d{2}-\d{2}-v\d+$/, 'a dated version, so a change of wording can be told from the last');
});

// --- the record on the account -------------------------------------------------

function fakeDb(docs) {
  const ref = id => ({
    id,
    async get() { return { exists: id in docs, data: () => docs[id] }; },
  });
  return {
    writes: 0,
    collection() { return { doc: ref }; },
    async runTransaction(run) {
      const db = this;
      return run({
        get: r => r.get(),
        update(r, updates) { db.writes++; Object.assign(docs[r.id], updates); },
      });
    },
  };
}
const user = { uid: 'u1', email: 'Person@Example.com' };
const account = () => ({ u1: { uid: 'u1', email: 'person@example.com', active: true } });
const agreement = { version: SCAFFOLD_NOTICE_VERSION, confirmed: ['use', 'limits'] };

test('an agreement is recorded once, with the server\'s date, and never moved', async () => {
  const docs = account();
  const db = fakeDb(docs);
  assert.deepEqual(await readScaffoldNotice(db, user), { version: SCAFFOLD_NOTICE_VERSION, accepted: false, acceptedAt: null });

  const first = await acceptScaffoldNotice(db, user, agreement, Date.parse('2026-11-24T15:00:00Z'));
  assert.deepEqual(first, { version: SCAFFOLD_NOTICE_VERSION, accepted: true, acceptedAt: '2026-11-24T15:00:00.000Z' });
  assert.equal(docs.u1.scaffoldNoticeVersion, SCAFFOLD_NOTICE_VERSION);
  assert.equal(docs.u1.scaffoldNoticeAcceptedAt, '2026-11-24T15:00:00.000Z');

  // Agreeing again a month on keeps the day they were first told.
  const again = await acceptScaffoldNotice(db, user, agreement, Date.parse('2026-12-24T15:00:00Z'));
  assert.equal(again.acceptedAt, '2026-11-24T15:00:00.000Z');
  assert.equal(db.writes, 1);
  assert.equal((await readScaffoldNotice(db, user)).accepted, true);
});

test('an agreement to an older wording does not count for the wording in force', () => {
  assert.equal(scaffoldNoticeStatus({ scaffoldNoticeVersion: '2020-01-01-v1', scaffoldNoticeAcceptedAt: '2020-01-01T00:00:00.000Z' }).accepted, false);
  assert.equal(scaffoldNoticeStatus({ scaffoldNoticeVersion: SCAFFOLD_NOTICE_VERSION, scaffoldNoticeAcceptedAt: 'not a date' }).accepted, false);
  assert.equal(scaffoldNoticeStatus(null).accepted, false);
});

test('nothing is recorded for a stale notice, a missed box, or an account that is not theirs', async () => {
  const docs = account();
  const db = fakeDb(docs);
  await assert.rejects(acceptScaffoldNotice(db, user, { ...agreement, version: '2020-01-01-v1' }), StaleNoticeError);
  await assert.rejects(acceptScaffoldNotice(db, user, { ...agreement, confirmed: ['use'] }), /Every statement must be confirmed/);
  await assert.rejects(acceptScaffoldNotice(db, user, { version: SCAFFOLD_NOTICE_VERSION }), /Every statement must be confirmed/);
  await assert.rejects(acceptScaffoldNotice(db, { uid: 'nobody', email: 'x@example.com' }, agreement), NoAccountError);
  await assert.rejects(acceptScaffoldNotice(db, { uid: 'u1', email: 'someone-else@example.com' }, agreement), NoAccountError);
  docs.u1.active = false;
  await assert.rejects(acceptScaffoldNotice(db, user, agreement), NoAccountError);
  assert.equal(await readScaffoldNotice(db, user), null);
  assert.equal(db.writes, 0);
  assert.equal('scaffoldNoticeAcceptedAt' in docs.u1, false);
});

// --- the endpoint --------------------------------------------------------------

const env = { NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://example.com', FIREBASE_PROJECT_ID: 'project', FIREBASE_CLIENT_EMAIL: 'service@example.com', FIREBASE_PRIVATE_KEY: 'test', SESSION_SECRET: 'a strong sufficiently long secret for testing' };
const cookie = `__scafmetric_session=${issueSession({ uid: 'u1', email: 'person@example.com', name: 'Person' }, env).token}`;
const response = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; }, json(v) { this.body = v; return this; } });
const post = (body, headers = {}) => ({ method: 'POST', body, headers: { origin: 'https://example.com', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', cookie, ...headers } });
// A browser sends no Origin header on a same-site GET.
const get = (headers = {}) => ({ method: 'GET', headers: { 'sec-fetch-site': 'same-origin', cookie, ...headers } });
function handlerOn(docs) {
  const db = fakeDb(docs);
  const handler = createAcknowledgmentsHandler({
    env,
    read: who => readScaffoldNotice(db, who),
    accept: (who, agreed) => acceptScaffoldNotice(db, who, agreed),
  });
  return { db, handler, call: async req => { const res = response(); await handler(req, res); return res; } };
}
const body = { notice: SCAFFOLD_NOTICE_ID, version: SCAFFOLD_NOTICE_VERSION, confirmed: ['use', 'limits'] };

test('the endpoint reports and records agreement for the signed-in account', async () => {
  const docs = account();
  const { call } = handlerOn(docs);

  let res = await call(get());
  assert.equal(res.statusCode, 200, 'a GET with no Origin header is how the page asks');
  assert.deepEqual(res.body.scaffoldNotice, { version: SCAFFOLD_NOTICE_VERSION, accepted: false, acceptedAt: null });
  assert.match(res.headers['Cache-Control'], /no-store/);

  res = await call(post(body));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.scaffoldNotice.accepted, true);
  assert.ok(Number.isFinite(Date.parse(docs.u1.scaffoldNoticeAcceptedAt)));

  res = await call(get());
  assert.equal(res.body.scaffoldNotice.accepted, true);
  assert.equal(res.body.scaffoldNotice.acceptedAt, docs.u1.scaffoldNoticeAcceptedAt);
});

test('the endpoint fails closed', async () => {
  const docs = account();
  const { call, db } = handlerOn(docs);
  const status = async req => (await call(req)).statusCode;

  assert.equal(await status({ method: 'PUT', headers: { cookie } }), 405);
  assert.equal(await status(get({ cookie: '' })), 401, 'not signed in');
  assert.equal(await status(get({ 'sec-fetch-site': 'cross-site' })), 403, 'a read from another site');
  assert.equal(await status(post(body, { origin: 'https://evil.example' })), 403, 'a write from another site');
  assert.equal(await status(post(body, { origin: undefined })), 403, 'a write with no origin');
  assert.equal(await status(post(body, { 'content-type': 'text/plain' })), 415);
  assert.equal(await status(post('{not json')), 400);
  assert.equal(await status(post({ ...body, notice: 'something-else' })), 400);
  assert.equal(await status(post({ ...body, confirmed: 'use,limits' })), 400);
  assert.equal(await status(post({ ...body, confirmed: ['use'] })), 400, 'a box left empty');
  const stale = await call(post({ ...body, version: '2020-01-01-v1' }));
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.body.version, SCAFFOLD_NOTICE_VERSION, 'and it says which wording is in force');
  assert.equal(db.writes, 0, 'none of those recorded anything');

  // No account record, or one that is switched off: nothing to record against.
  const none = handlerOn({});
  assert.equal((await none.call(get())).statusCode, 403);
  assert.equal((await none.call(post(body))).statusCode, 403);

  // The database is down: say so, do not pretend.
  const down = createAcknowledgmentsHandler({ env, read: async () => { throw new Error('offline'); }, accept: async () => { throw new Error('offline'); } });
  let res = response(); await down(get(), res);
  assert.equal(res.statusCode, 503);
  res = response(); await down(post(body), res);
  assert.equal(res.statusCode, 503);

  // Not set up at all.
  const bare = createAcknowledgmentsHandler({ env: { ...env, SESSION_SECRET: '' } });
  res = response(); await bare(get(), res);
  assert.equal(res.statusCode, 503);
});

// --- the gate in front of the builder -------------------------------------------

/** A server that answers the way the endpoint does, counting what it is asked. */
function fakeServer({ accepted = false, postStatus = 200, down = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (down) throw new Error('offline');
    if (init.method === 'GET') return { ok: true, status: 200, json: async () => ({ ok: true, scaffoldNotice: { accepted } }) };
    return { ok: postStatus === 200, status: postStatus, json: async () => ({}) };
  };
  return { calls, fetchImpl };
}
/** A notice that is "shown" by handing the test its two buttons. */
function fakePage() {
  const shown = [];
  return { shown, present: handlers => shown.push(handlers) };
}

test('someone who has already agreed goes straight in', async () => {
  const server = fakeServer({ accepted: true });
  const page = fakePage();
  const gate = createUseNotice({ fetchImpl: server.fetchImpl, present: page.present });
  let opened = 0;
  assert.equal(await gate.request(() => opened++), 'already');
  assert.equal(opened, 1);
  assert.equal(page.shown.length, 0, 'no notice');
  await gate.request(() => opened++);
  assert.equal(opened, 2);
  assert.equal(server.calls.length, 1, 'and the server is asked once, not on every click');
});

test('the first time, the builder waits for the notice; after agreeing it is never in the way again', async () => {
  const server = fakeServer({ accepted: false });
  const page = fakePage();
  const gate = createUseNotice({ fetchImpl: server.fetchImpl, present: page.present });
  let opened = 0;

  const asked = gate.request(() => opened++);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(page.shown.length, 1, 'the notice is up');
  assert.equal(opened, 0, 'and the builder is not');

  assert.deepEqual(await page.shown[0].onAgree(), { done: true });
  assert.equal(await asked, 'recorded');
  assert.equal(opened, 1);
  const sent = server.calls.find(c => c.method === 'POST');
  assert.deepEqual(sent.body, { notice: SCAFFOLD_NOTICE_ID, version: SCAFFOLD_NOTICE_VERSION, confirmed: ['use', 'limits'] });

  assert.equal(await gate.request(() => opened++), 'already');
  assert.equal(opened, 2);
  assert.equal(page.shown.length, 1, 'asked once');
});

test('cancelling leaves the builder shut, and the notice comes up again next time', async () => {
  const server = fakeServer({ accepted: false });
  const page = fakePage();
  const gate = createUseNotice({ fetchImpl: server.fetchImpl, present: page.present });
  let opened = 0;

  const asked = gate.request(() => opened++);
  await new Promise(r => setTimeout(r, 0));
  page.shown[0].onCancel();
  assert.equal(await asked, 'cancelled');
  assert.equal(opened, 0);
  assert.equal(server.calls.filter(c => c.method === 'POST').length, 0, 'nothing recorded');

  gate.request(() => opened++);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(page.shown.length, 2);
});

test('if the agreement cannot be recorded the builder still opens, and they are asked again next visit', async () => {
  for (const server of [fakeServer({ down: true }), fakeServer({ postStatus: 503 })]) {
    const page = fakePage();
    const gate = createUseNotice({ fetchImpl: server.fetchImpl, present: page.present });
    let opened = 0;
    const asked = gate.request(() => opened++);
    await new Promise(r => setTimeout(r, 0));
    assert.equal(page.shown.length, 1, 'the notice shows when the server cannot say they agreed');
    await page.shown[0].onAgree();
    assert.equal(await asked, 'unrecorded');
    assert.equal(opened, 1, 'they did agree, so the builder opens');
    // A new page load starts from the server again, which still has no record.
    const later = createUseNotice({ fetchImpl: server.fetchImpl, present: page.present });
    later.request(() => opened++);
    await new Promise(r => setTimeout(r, 0));
    assert.equal(page.shown.length, 2);
  }
});

test('a notice that changed since the page loaded is not agreed to blind', async () => {
  const server = fakeServer({ accepted: false, postStatus: 409 });
  const page = fakePage();
  const gate = createUseNotice({ fetchImpl: server.fetchImpl, present: page.present });
  let opened = 0;
  gate.request(() => opened++);
  await new Promise(r => setTimeout(r, 0));
  const result = await page.shown[0].onAgree();
  assert.match(result.error, /Reload the page/);
  assert.equal(opened, 0);
});
