import test from 'node:test';
import assert from 'node:assert/strict';
import { TERMS_VERSION } from '../server/account.js';
import { createSessionHandler, isConfigured } from '../api/auth/session.js';
import { COOKIE_NAME, issueSession } from '../server/session-core.js';

const env = { NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://example.com', FIREBASE_PROJECT_ID: 'project', FIREBASE_CLIENT_EMAIL: 'service@example.com', FIREBASE_PRIVATE_KEY: 'test', SESSION_SECRET: 'a strong sufficiently long secret for testing' };
function response() { return { headers: {}, statusCode: 0, body: null, setHeader(k,v) { this.headers[k]=v; }, status(n) { this.statusCode=n; return this; }, json(v) { this.body=v; return this; } }; }
const req = (method, body, headers={}) => ({ method, body, headers: { origin: 'https://example.com', 'content-type': 'application/json', ...headers } });
const decoded = { uid: 'u1', email: 'person@example.com', email_verified: true, creationTime: '2020-01-01T00:00:00.000Z' };

test('configured status is based only on required settings, fails closed on missing or insecure values', () => {
  assert.equal(isConfigured(env), true);
  for (const key of ['NEXT_PUBLIC_APP_URL','FIREBASE_PROJECT_ID','FIREBASE_CLIENT_EMAIL','FIREBASE_PRIVATE_KEY','SESSION_SECRET']) assert.equal(isConfigured({ ...env, [key]: '' }), false);
  assert.equal(isConfigured({ ...env, NEXT_PUBLIC_APP_URL: 'http://example.com' }), false);
});

test('only verified Firebase identities receive a secure session after account creation', async () => {
  let calls=0;
  const handler=createSessionHandler({ env, verifyToken: async token => token==='good' ? decoded : null, accountFor: async data => { calls++; assert.equal(data.creationTime, decoded.creationTime); }, accountStatus: async () => ({ termsAccepted:false, profileComplete:false }) });
  let r=response(); await handler(req('POST',{idToken:'bad'}),r); assert.equal(r.statusCode,401); assert.equal(calls,0);
  r=response(); await handler(req('POST',{idToken:'good'}),r); assert.equal(r.statusCode,200); assert.equal(calls,1); assert.match(r.headers['Set-Cookie'], /HttpOnly; SameSite=Lax; Secure/);
  const cookie=r.headers['Set-Cookie'].split(';')[0];
  r=response(); await handler(req('GET',null,{cookie}),r); assert.equal(r.statusCode,200); assert.equal(r.body.authenticated,true); assert.equal(r.body.trial,undefined);
  r=response(); await handler(req('DELETE',null),r); assert.equal(r.statusCode,200); assert.match(r.headers['Set-Cookie'], /Max-Age=0/);
});

test('unverified users, cross-origin requests, missing configuration, or unavailable account storage fail closed', async () => {
  const unverified=createSessionHandler({ env, verifyToken: async () => ({ ...decoded, email_verified:false }) });
  let r=response(); await unverified(req('POST',{idToken:'x'}),r); assert.equal(r.statusCode,401);
  r=response(); await unverified(req('POST',{idToken:'x'},{origin:'https://elsewhere.example'}),r); assert.equal(r.statusCode,403);
  const unavailable=createSessionHandler({ env, verifyToken:async () => decoded, accountFor:async () => { throw Error('unavailable'); } });
  r=response(); await unavailable(req('POST',{idToken:'x'}),r); assert.equal(r.statusCode,503); assert.equal(r.headers['Set-Cookie'],undefined);
  const missing=createSessionHandler({ env: { ...env, SESSION_SECRET:'' }, verifyToken:async () => decoded });
  r=response(); await missing(req('POST',{idToken:'x'}),r); assert.equal(r.statusCode,503);
});


test('session reports acceptance and stores it only when current terms are explicitly accepted', async () => {
  let account = {};
  const handler = createSessionHandler({ env, verifyToken: async () => decoded,
    accountFor: async data => { if (data.acceptTermsVersion) account = { termsVersion:data.acceptTermsVersion, termsAcceptedAt:new Date().toISOString() }; return account; },
    accountStatus: async () => ({ termsAccepted:account.termsVersion === TERMS_VERSION }) });
  let r=response(); await handler(req('POST',{ idToken:'good' }),r);
  assert.equal(r.body.termsAccepted,false); assert.equal(r.body.termsVersion,TERMS_VERSION);
  const cookie=r.headers['Set-Cookie'].split(';')[0];
  r=response(); await handler(req('GET',null,{cookie}),r); assert.equal(r.body.termsAccepted,false);
  r=response(); await handler(req('POST',{ idToken:'good', acceptTermsVersion:'old' }),r); assert.equal(r.statusCode,409); assert.deepEqual(account,{});
  r=response(); await handler(req('POST',{ idToken:'good', acceptTermsVersion:TERMS_VERSION }),r); assert.equal(r.body.termsAccepted,true);
  r=response(); await handler(req('GET',null,{cookie}),r); assert.equal(r.body.termsAccepted,true);
});

test('profile completion is validated and bound to the verified identity', async () => {
  let account = { termsVersion:TERMS_VERSION, termsAcceptedAt:new Date().toISOString() }, captured;
  const handler = createSessionHandler({ env, verifyToken:async () => decoded,
    accountFor:async data => { captured=data; if (data.profile) account={...account, profile:data.profile}; return account; },
    accountStatus:async () => ({ termsAccepted:true, profileComplete:Boolean(account.profile) }) });
  let r=response(); await handler(req('POST', { idToken:'good' }), r);
  assert.equal(r.body.profileComplete, false);
  r=response(); await handler(req('POST', { idToken:'good', profile:{ name:' ', company:'Example', discovery:'Search' } }), r);
  assert.equal(r.statusCode, 400);
  r=response(); await handler(req('POST', { idToken:'good', uid:'someone-else', profile:{ name:'Alex', company:'Example', discovery:'Search' } }, { origin:'https://elsewhere.example' }), r);
  assert.equal(r.statusCode, 403);
  r=response(); await handler(req('POST', { idToken:'good', uid:'someone-else', profile:{ name:'Alex', company:'Example', discovery:'Search' } }), r);
  assert.equal(r.statusCode, 200); assert.equal(captured.uid, decoded.uid); assert.equal(r.body.profileComplete, true);
  const cookie = r.headers['Set-Cookie'].split(';')[0];
  r=response(); await handler(req('GET', null, { cookie }), r); assert.equal(r.body.profileComplete, true);
  assert.equal(r.body.profile, undefined);
});

test('admin navigation is exposed only for an allowlisted, active, fully onboarded session', async () => {
  const adminEnv = { ...env, ADMIN_UIDS:'u1, other-owner' };
  const cookieForUser = uid => `${COOKIE_NAME}=${issueSession({ uid, email:`${uid}@example.com`, name:uid }, adminEnv).token}`;
  let account = { termsAccepted:true, profileComplete:true };
  const handler = createSessionHandler({ env:adminEnv, accountStatus:async () => account });
  let r=response(); await handler(req('GET', null), r);
  assert.equal(r.body.authenticated, false); assert.notEqual(r.body.isAdmin, true);
  r=response(); await handler(req('GET', null, { cookie:cookieForUser('u1') }), r);
  assert.equal(r.body.isAdmin, true); assert.match(r.headers['Cache-Control'], /no-store/);
  r=response(); await handler(req('GET', null, { cookie:cookieForUser('u10') }), r);
  assert.equal(r.body.authenticated, true); assert.equal(r.body.isAdmin, false);
  for (const state of [{ termsAccepted:false, profileComplete:true }, { termsAccepted:true, profileComplete:false }, { termsAccepted:'true', profileComplete:true }]) {
    account=state; r=response(); await handler(req('GET', null, { cookie:cookieForUser('u1') }), r); assert.equal(r.body.isAdmin, false);
  }
  account=null; r=response(); await handler(req('GET', null, { cookie:cookieForUser('u1') }), r); assert.equal(r.body.authenticated, false); assert.notEqual(r.body.isAdmin, true);
  const noAdmins=createSessionHandler({ env:{ ...adminEnv, ADMIN_UIDS:'' }, accountStatus:async () => ({ termsAccepted:true, profileComplete:true }) });
  r=response(); await noAdmins(req('GET', null, { cookie:cookieForUser('u1') }), r); assert.equal(r.body.isAdmin, false);
  const unavailable=createSessionHandler({ env:adminEnv, accountStatus:async () => { throw Error('unavailable'); } });
  r=response(); await unavailable(req('GET', null, { cookie:cookieForUser('u1') }), r); assert.equal(r.statusCode, 503); assert.notEqual(r.body.isAdmin, true);
});

test('while signups are paused, people without an account are refused before any record or session is created', async () => {
  let created=0;
  const handler=createSessionHandler({ env, verifyToken:async () => decoded, accountFor:async () => { created++; return {}; }, accountStatus:async () => null });
  let r=response(); await handler(req('POST',{ idToken:'good' }),r);
  assert.equal(r.statusCode,403); assert.equal(r.body.signupsPaused,true); assert.match(r.body.error,/work in progress/);
  assert.equal(created,0); assert.equal(r.headers['Set-Cookie'],undefined);
  r=response(); await handler(req('GET',null),r); assert.equal(r.body.signupsOpen,false);
  const storageDown=createSessionHandler({ env, verifyToken:async () => decoded, accountFor:async () => { created++; return {}; }, accountStatus:async () => { throw Error('unavailable'); } });
  r=response(); await storageDown(req('POST',{ idToken:'good' }),r); assert.equal(r.statusCode,503); assert.equal(created,0); assert.equal(r.headers['Set-Cookie'],undefined);
});

test('while signups are paused, existing accounts and allowlisted owners still sign in', async () => {
  let seen;
  const existing=createSessionHandler({ env, verifyToken:async () => decoded, accountFor:async () => ({}), accountStatus:async user => { seen=user; return { termsAccepted:true, profileComplete:true }; } });
  let r=response(); await existing(req('POST',{ idToken:'good' }),r);
  assert.equal(r.statusCode,200); assert.match(r.headers['Set-Cookie'],/HttpOnly/); assert.deepEqual(seen,{ uid:decoded.uid, email:decoded.email });
  const owner=createSessionHandler({ env:{ ...env, ADMIN_UIDS:'u1' }, verifyToken:async () => decoded, accountFor:async () => ({}), accountStatus:async () => null });
  r=response(); await owner(req('POST',{ idToken:'good' }),r); assert.equal(r.statusCode,200);
});

test('setting SIGNUPS_OPEN=true lets new users create accounts again', async () => {
  let created=0;
  const openEnv={ ...env, SIGNUPS_OPEN:'true' };
  const handler=createSessionHandler({ env:openEnv, verifyToken:async () => decoded, accountFor:async () => { created++; return {}; }, accountStatus:async () => null });
  let r=response(); await handler(req('POST',{ idToken:'good' }),r); assert.equal(r.statusCode,200); assert.equal(created,1);
  r=response(); await handler(req('GET',null),r); assert.equal(r.body.signupsOpen,true);
  for (const value of ['1','yes','TRUE','']) {
    const closed=createSessionHandler({ env:{ ...env, SIGNUPS_OPEN:value }, verifyToken:async () => decoded, accountFor:async () => ({}), accountStatus:async () => null });
    r=response(); await closed(req('POST',{ idToken:'good' }),r); assert.equal(r.statusCode,403);
  }
});
