import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { createWorkspaceHandler } from '../api/workspace-asset.js';
import { checkEntitlement } from '../server/entitlement.js';
import { COOKIE_NAME, issueSession } from '../server/session-core.js';

const env = { NODE_ENV:'production', NEXT_PUBLIC_APP_URL:'https://example.com', FIREBASE_PROJECT_ID:'project', FIREBASE_CLIENT_EMAIL:'service@example.com', FIREBASE_PRIVATE_KEY:'test', SESSION_SECRET:'a strong sufficiently long secret for testing' };
const cookie = `${COOKIE_NAME}=${issueSession({uid:'u1',email:'u1@example.com',name:'Owner'},env).token}`;
const req = (asset, auth = true, method = 'GET') => ({ method, query:{asset}, headers:auth ? {cookie} : {} });
function response() { return { headers:{}, statusCode:0, body:null, setHeader(key,value) { this.headers[key]=value; }, status(value) { this.statusCode=value; return this; }, send(value) { this.body=value; return this; } }; }
const okAccount = { termsAccepted:true, profileComplete:true };
const fakeDb = {};
const handler = (extra = {}) => createWorkspaceHandler({ env, getDatabase:() => fakeDb, accountFor:async () => okAccount, entitlementFor:async () => ({hasAccess:true}), readAsset:async file => `content:${file}`, ...extra });

test('workspace HTML and modules require an authenticated verified account', async () => {
  let r = response(); await handler()(req('calculator',false),r);
  assert.equal(r.statusCode,302); assert.equal(r.headers.Location,'/signin.html'); assert.doesNotMatch(r.body,/content:/);
  for (const name of ['app']) {
    r=response(); await handler()(req(name,false),r); assert.equal(r.statusCode,401); assert.doesNotMatch(r.body,/content:/);
  }
  for (const account of [null,{termsAccepted:false,profileComplete:true},{termsAccepted:true,profileComplete:false}]) {
    r=response(); await handler({accountFor:async () => account})(req('calculator'),r); assert.equal(r.statusCode,302);
    r=response(); await handler({accountFor:async () => account})(req('app'),r); assert.equal(r.statusCode,403);
  }
});

test('workspace HTML and modules require a server-verified entitlement and fail closed', async () => {
  for (const [entitlementFor, status] of [[async () => ({hasAccess:false}),403],[async () => { throw Error('payment unavailable'); },503],[async () => ({hasAccess:'true'}),403]]) {
    for (const asset of ['calculator','app']) {
      let read=false; const h=handler({entitlementFor,readAsset:async () => {read=true;return 'secret';}}); const r=response();
      await h(req(asset),r); assert.equal(r.statusCode,asset === 'calculator' && status === 403 ? 302 : status); if (asset === 'calculator' && status === 403) assert.equal(r.headers.Location,'/billing.html'); assert.equal(read,false);
    }
  }
  const noConfig=handler({env:{...env,SESSION_SECRET:''}}), r=response(); await noConfig(req('calculator'),r); assert.equal(r.statusCode,503);
});

test('real entitlement logic grants lifetime access and otherwise requires verified payment', async () => {
  let grant = { lifetimeFree:true };
  const db = { collection(name) { assert.equal(name,'billingEntitlements'); return { doc(uid) { assert.equal(uid,'u1'); return { get:async () => ({exists:Boolean(grant),data:() => grant}) }; } }; } };
  const h = extra => handler({getDatabase:() => db, entitlementFor:checkEntitlement, ...extra});
  let r=response(); await h()(req('calculator'),r); assert.equal(r.statusCode,200);
  grant=null;
  r=response(); await h()(req('calculator'),r); assert.equal(r.statusCode,503);
  r=response(); await h({verifyPaid:async () => false})(req('calculator'),r); assert.equal(r.statusCode,302); assert.equal(r.headers.Location,'/billing.html');
  r=response(); await h({verifyPaid:async () => true})(req('calculator'),r); assert.equal(r.statusCode,200);
});

test('an entitled session receives only allowlisted workspace files with private cache controls', async () => {
  const h=handler(); let r=response(); await h(req('calculator'),r);
  assert.equal(r.statusCode,200); assert.equal(r.body,'content:calculator.html'); assert.match(r.headers['Cache-Control'],/no-store/); assert.match(r.headers['Content-Type'],/text\/html/);
  r=response(); await h(req('app'),r); assert.equal(r.statusCode,200); assert.equal(r.body,'content:workspace-private/app.js'); assert.match(r.headers['Content-Type'],/javascript/);
  for (const asset of ['beam.js','input-visual.js','../server/account.js','auth/client.js','terms.js','__proto__','']) { r=response(); await h(req(asset),r); assert.equal(r.statusCode,404); }
  r=response(); await h(req('app',true,'POST'),r); assert.equal(r.statusCode,405);
  r=response(); await h(req('app',true,'HEAD'),r); assert.equal(r.statusCode,200); assert.equal(r.body,'');
});

test('workspace public build excludes original protected assets when a build is present', async t => {
  try { await access('dist/index.html'); } catch { return t.skip('Run npm run build to check public output.'); }
  for (const file of ['dist/calculator.html','dist/app.js','dist/src/beam.js']) await assert.rejects(access(file));
  for (const file of ['dist/index.html','dist/signin.html','dist/auth.js','dist/account.js']) await assert.doesNotReject(access(file));
  await assert.doesNotReject(access('workspace-private/app.js'));
});
