import test from 'node:test';
import assert from 'node:assert/strict';
import { createBillingStatusHandler } from '../api/billing/status.js';
import { COOKIE_NAME, issueSession } from '../server/session-core.js';

const env = { NODE_ENV:'production', NEXT_PUBLIC_APP_URL:'https://example.com', FIREBASE_PROJECT_ID:'project', FIREBASE_CLIENT_EMAIL:'service@example.com', FIREBASE_PRIVATE_KEY:'test', SESSION_SECRET:'a strong sufficiently long secret for testing' };
const user = { uid:'owner', email:'owner@example.com', name:'Owner' };
const cookie = `${COOKIE_NAME}=${issueSession(user, env).token}`;
const request = (method = 'GET', headers = {}) => ({ method, headers });
const response = () => ({ headers:{}, statusCode:0, body:null, setHeader(k,v){this.headers[k]=v}, status(n){this.statusCode=n;return this}, json(body){this.body=body;return this} });
const complete = async () => ({ termsAccepted:true, profileComplete:true });

test('status is private and requires a signed in, complete account', async () => {
  let calls = 0;
  const handler = createBillingStatusHandler({ env, getDatabase:()=>({}), accountFor:complete, entitlementFor:async()=>{calls++;return {hasAccess:false,reason:'payment_required'}}, customerFor:async()=>null });
  let res=response(); await handler(request(), res); assert.equal(res.statusCode,401); assert.equal(calls,0); assert.match(res.headers['Cache-Control'],/no-store/);
  res=response(); await handler(request('POST', {cookie}),res); assert.equal(res.statusCode,405); assert.equal(calls,0);
  const incomplete = createBillingStatusHandler({ env, getDatabase:()=>({}), accountFor:async()=>({termsAccepted:true,profileComplete:false}), entitlementFor:async()=>{calls++} });
  res=response(); await incomplete(request('GET',{cookie}),res); assert.equal(res.statusCode,403); assert.equal(calls,0);
});

test('status reports only server-confirmed own entitlement and billing availability', async () => {
  let customerUid;
  const handler = createBillingStatusHandler({ env, getDatabase:()=>({}), accountFor:complete, entitlementFor:async ({uid})=>{assert.equal(uid,user.uid);return {hasAccess:false,reason:'payment_required'}}, customerFor:async (_db,uid)=>{customerUid=uid;return 'cus_private'} });
  const res=response(); await handler(request('GET',{cookie}),res);
  assert.equal(res.statusCode,200); assert.deepEqual(res.body,{hasAccess:false,reason:'payment_required',canManageBilling:true}); assert.equal(customerUid,user.uid);
  assert.equal(JSON.stringify(res.body).includes('cus_private'),false);
  const lifetime = createBillingStatusHandler({ env, getDatabase:()=>({}), accountFor:complete, entitlementFor:async()=>({hasAccess:true,reason:'lifetime'}), customerFor:async()=>{throw Error('must not be called')} });
  const owner=response(); await lifetime(request('GET',{cookie}),owner); assert.deepEqual(owner.body,{hasAccess:true,reason:'lifetime',canManageBilling:false});
});

test('storage, payment-verifier, and malformed entitlement failures never grant access', async () => {
  for (const entitlementFor of [async()=>{throw Error('offline')}, async()=>({hasAccess:'true',reason:'paid'}), async()=>({hasAccess:true,reason:'unknown'}), async()=>({hasAccess:true,reason:'payment_required'}), async()=>({hasAccess:false,reason:'paid'})]) {
    const handler=createBillingStatusHandler({env,getDatabase:()=>({}),accountFor:complete,entitlementFor,customerFor:async()=>null});
    const res=response(); await handler(request('GET',{cookie}),res); assert.equal(res.statusCode,503); assert.equal(res.body.hasAccess,undefined);
  }
});
