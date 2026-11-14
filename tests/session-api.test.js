import test from 'node:test';
import assert from 'node:assert/strict';
import { TERMS_VERSION } from '../server/account.js';
import { createSessionHandler, isConfigured } from '../api/auth/session.js';

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
  const handler=createSessionHandler({ env, verifyToken: async token => token==='good' ? decoded : null, accountFor: async data => { calls++; assert.equal(data.creationTime, decoded.creationTime); }, accountStatus: async () => ({ trialActive:false }) });
  let r=response(); await handler(req('POST',{idToken:'bad'}),r); assert.equal(r.statusCode,401); assert.equal(calls,0);
  r=response(); await handler(req('POST',{idToken:'good'}),r); assert.equal(r.statusCode,200); assert.equal(calls,1); assert.match(r.headers['Set-Cookie'], /HttpOnly; SameSite=Lax; Secure/);
  const cookie=r.headers['Set-Cookie'].split(';')[0];
  r=response(); await handler(req('GET',null,{cookie}),r); assert.equal(r.statusCode,200); assert.equal(r.body.authenticated,true); assert.equal(r.body.trial.trialActive,false);
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
    accountStatus: async () => ({ trialActive:false, termsAccepted:account.termsVersion === TERMS_VERSION }) });
  let r=response(); await handler(req('POST',{ idToken:'good' }),r);
  assert.equal(r.body.termsAccepted,false); assert.equal(r.body.termsVersion,TERMS_VERSION);
  const cookie=r.headers['Set-Cookie'].split(';')[0];
  r=response(); await handler(req('GET',null,{cookie}),r); assert.equal(r.body.termsAccepted,false);
  r=response(); await handler(req('POST',{ idToken:'good', acceptTermsVersion:'old' }),r); assert.equal(r.statusCode,409); assert.deepEqual(account,{});
  r=response(); await handler(req('POST',{ idToken:'good', acceptTermsVersion:TERMS_VERSION }),r); assert.equal(r.body.termsAccepted,true);
  r=response(); await handler(req('GET',null,{cookie}),r); assert.equal(r.body.termsAccepted,true);
});
