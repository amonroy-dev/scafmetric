import test from 'node:test';
import assert from 'node:assert/strict';
import { createCheckoutHandler } from '../api/billing/checkout.js';
import { createPortalHandler } from '../api/billing/portal.js';
import { isApprovedPrice, startCheckout, startPortal } from '../server/billing.js';
import { issueSession } from '../server/session-core.js';

const env = { NODE_ENV:'production', VERCEL_ENV:'preview', NEXT_PUBLIC_APP_URL:'https://example.com', FIREBASE_PROJECT_ID:'project', FIREBASE_CLIENT_EMAIL:'server@example.com', FIREBASE_PRIVATE_KEY:'private', SESSION_SECRET:'a sufficiently long session secret for testing', STRIPE_TEST_SECRET_KEY:'rk_test_placeholder', STRIPE_PRICE_ID:'price_example' };
const user = { uid:'user-1', email:'person@example.com', name:'Person' };
const cookie = `__scafmetric_session=${issueSession(user,env).token}`;
const request = (body={}, headers={}, method='POST') => ({ method, body, headers:{origin:'https://example.com','content-type':'application/json',cookie,...headers} });
const response = () => ({ headers:{}, setHeader(k,v){this.headers[k]=v}, status(n){this.statusCode=n;return this}, json(v){this.body=v;return this} });
const approvedPrice = { id:'price_example', active:true, currency:'usd', type:'recurring', billing_scheme:'per_unit', unit_amount:4900, recurring:{interval:'month',interval_count:1,usage_type:'licensed',trial_period_days:null} };

function fakeDatabase() {
  const records = new Map(); let queue = Promise.resolve();
  const snapshot = key => ({ exists:records.has(key), data:() => records.get(key) });
  const ref = key => ({ key, get:async () => snapshot(key) });
  const db = { collection: name => ({ doc:id => ref(`${name}/${id}`) }), records,
    runTransaction(callback) {
      const run = queue.then(async () => {
        const writes=[];
        const tx = { get:async r => snapshot(r.key), set:(r,data,opts) => writes.push(['set',r.key,data,opts]), create:(r,data) => writes.push(['create',r.key,data]) };
        const result=await callback(tx);
        for(const [op,key,data,opts] of writes) {
          if(op==='create' && records.has(key)) throw Error('duplicate');
          records.set(key,op==='set'&&opts?.merge ? {...records.get(key),...data} : data);
        }
        return result;
      }); queue=run.catch(()=>{}); return run;
    }
  }; return db;
}
function fakeStripe() {
  const customerKeys = new Map(), sessionKeys = new Map(), sessions = new Map();
  const calls = {customers:[],checkouts:[],portals:[]};
  const stripe = {
    calls, sessions, prices:{retrieve:async () => approvedPrice},
    customers:{create:async (input,opts) => { calls.customers.push({input,opts}); if(!customerKeys.has(opts.idempotencyKey)) customerKeys.set(opts.idempotencyKey,{id:'cus_abc'}); return customerKeys.get(opts.idempotencyKey); }},
    subscriptions:{list:async () => ({data:[],has_more:false})},
    checkout:{sessions:{create:async (input,opts) => { calls.checkouts.push({input,opts}); if(!sessionKeys.has(opts.idempotencyKey)) { const id=sessionKeys.size ? `cs_${sessionKeys.size + 1}` : 'cs_abc'; const s={id,customer:input.customer,status:'open',url:'https://checkout.stripe.com/c/pay/example',expires_at:Math.floor(Date.now()/1000)+3600}; sessionKeys.set(opts.idempotencyKey,s); sessions.set(s.id,s); } return sessionKeys.get(opts.idempotencyKey); }, retrieve:async id => sessions.get(id)}},
    billingPortal:{sessions:{create:async input => { calls.portals.push(input);return {url:'https://billing.stripe.com/p/session/example'}; }}}
  }; return stripe;
}

test('only the approved active $49 monthly USD price without a trial is accepted', () => {
  assert.equal(isApprovedPrice(approvedPrice, 'price_example'), true);
  for(const bad of [ {...approvedPrice,unit_amount:4901}, {...approvedPrice,currency:'eur'}, {...approvedPrice,active:false}, {...approvedPrice,recurring:{...approvedPrice.recurring,interval:'year'}}, {...approvedPrice,recurring:{...approvedPrice.recurring,trial_period_days:14}}, {...approvedPrice,billing_scheme:'tiered'} ]) assert.equal(isApprovedPrice(bad,'price_example'), false);
});

test('concurrent checkout attempts reuse the same customer and checkout reservation', async () => {
  const db=fakeDatabase(), stripe=fakeStripe();
  const results=await Promise.all([startCheckout({db,stripe,user,env}),startCheckout({db,stripe,user,env})]);
  assert.deepEqual(results,['https://checkout.stripe.com/c/pay/example','https://checkout.stripe.com/c/pay/example']);
  assert.equal(new Set(stripe.calls.customers.map(call=>call.opts.idempotencyKey)).size,1);
  assert.equal(new Set(stripe.calls.checkouts.map(call=>call.opts.idempotencyKey)).size,1);
  const input=stripe.calls.checkouts[0].input;
  assert.deepEqual(input.line_items,[{price:'price_example',quantity:1}]);
  assert.equal(input.mode,'subscription');
  assert.ok(!('payment_method_types' in input)); assert.ok(!('automatic_tax' in input)); assert.ok(!('subscription_data' in input));
  assert.equal(db.records.get('scafmetricBilling/user-1').stripeCustomerId,'cus_abc');
  assert.equal(db.records.get('scafmetricStripeCustomers/cus_abc').uid,'user-1');
  assert.equal(await startCheckout({db,stripe,user,env}),results[0]);
  assert.equal(await startPortal({db,stripe,user,env}),'https://billing.stripe.com/p/session/example');
  assert.deepEqual(stripe.calls.portals[0],{customer:'cus_abc',return_url:'https://example.com/billing.html'});
});

test('lifetime users and accounts with existing subscriptions are not sent to a new checkout', async () => {
  const db=fakeDatabase(), stripe=fakeStripe();
  db.records.set('billingEntitlements/user-1',{lifetimeFree:true});
  await assert.rejects(startCheckout({db,stripe,user,env}),error=>error.status===409);
  assert.equal(stripe.calls.customers.length,0);
  db.records.delete('billingEntitlements/user-1');
  stripe.subscriptions.list=async () => ({data:[{status:'active'}],has_more:false});
  await assert.rejects(startCheckout({db,stripe,user,env}),error=>error.status===409);
  assert.equal(stripe.calls.checkouts.length,0);
});

test('canceled checkout can resume, expired checkout can be replaced, completed checkout cannot duplicate', async () => {
  const db=fakeDatabase(), stripe=fakeStripe();
  await startCheckout({db,stripe,user,env});
  await startCheckout({db,stripe,user,env});
  assert.equal(stripe.calls.checkouts.length,1, 'open checkout resumes without creating a second session');
  stripe.sessions.get('cs_abc').status='expired';
  await startCheckout({db,stripe,user,env});
  assert.equal(stripe.calls.checkouts.length,2);
  assert.notEqual(stripe.calls.checkouts[0].opts.idempotencyKey,stripe.calls.checkouts[1].opts.idempotencyKey);
  stripe.sessions.get('cs_2').status='complete';
  await assert.rejects(startCheckout({db,stripe,user,env}),error=>error.status===409);
  assert.equal(stripe.calls.checkouts.length,2);
  assert.equal(await startPortal({db,stripe,user,env}),'https://billing.stripe.com/p/session/example');
});

test('retry after losing the checkout response reuses the same Stripe idempotency key', async () => {
  const db=fakeDatabase(), stripe=fakeStripe();
  const create = stripe.checkout.sessions.create; let lost = true;
  stripe.checkout.sessions.create = async (...args) => {
    const result = await create(...args);
    if (lost) { lost=false; throw Error('response lost'); }
    return result;
  };
  await assert.rejects(startCheckout({db,stripe,user,env}));
  assert.equal(await startCheckout({db,stripe,user,env}),'https://checkout.stripe.com/c/pay/example');
  assert.equal(stripe.calls.checkouts.length,2);
  assert.equal(stripe.calls.checkouts[0].opts.idempotencyKey,stripe.calls.checkouts[1].opts.idempotencyKey);
  assert.equal(stripe.sessions.size,1);
});

test('an abandoned customer reservation older than Stripe idempotency retention fails closed', async () => {
  const db=fakeDatabase(), stripe=fakeStripe();
  db.records.set('scafmetricBilling/user-1',{customerReservation:{id:'4ae80213-89f8-4ec6-b3ba-010914b5ac01',createdAt:Date.now()-25*60*60*1000}});
  await assert.rejects(startCheckout({db,stripe,user,env}),error=>error.status===503);
  assert.equal(stripe.calls.customers.length,0);
});

test('portal and checkout fail closed on mismatched customer ownership or price', async () => {
  const db=fakeDatabase(), stripe=fakeStripe();
  db.records.set('scafmetricBilling/user-1',{stripeCustomerId:'cus_abc'});
  db.records.set('scafmetricStripeCustomers/cus_abc',{uid:'other'});
  await assert.rejects(startPortal({db,stripe,user,env}),error=>error.status===503);
  assert.equal(stripe.calls.portals.length,0);
  stripe.prices.retrieve=async () => ({...approvedPrice,unit_amount:1});
  await assert.rejects(startCheckout({db,stripe,user,env}),error=>error.status===503);
  assert.equal(stripe.calls.checkouts.length,0);
});

test('billing endpoints require same-origin authenticated completed account and reject client-chosen prices or customers', async () => {
  let executions=0;
  const deps={env,getDatabase:()=>({}),getStripe:()=>({}),accountFor:async()=>({termsAccepted:true,profileComplete:true}),execute:async()=>{executions++;return 'https://checkout.stripe.com/c/pay/example'}};
  let r=response(); await createCheckoutHandler(deps)(request(),r); assert.equal(r.statusCode,200);
  for(const [req,status] of [[request({}, {origin:'https://evil.example'}),403],[request({}, {cookie:''}),401],[request({price:'price_spoof'}),400],[request({customer:'cus_spoof'}),400],[request({}, {'content-type':'text/plain'}),415],[request({}, {}, 'GET'),405]]) { r=response();await createCheckoutHandler(deps)(req,r);assert.equal(r.statusCode,status); }
  r=response();await createCheckoutHandler({...deps,accountFor:async()=>({termsAccepted:false,profileComplete:true})})(request(),r);assert.equal(r.statusCode,403);
  r=response();await createPortalHandler({...deps,accountFor:async()=>null})(request(),r);assert.equal(r.statusCode,401);
  assert.equal(executions,1);
});

test('billing endpoints reject keys belonging to the wrong environment before executing', async () => {
  let executions = 0;
  const deps = {env:{...env,VERCEL_ENV:'production',STRIPE_SECRET_KEY:'rk_test_invalid'},getDatabase:()=>({}),getStripe:()=>({}),accountFor:async()=>({termsAccepted:true,profileComplete:true}),execute:async()=>{executions++;return 'https://checkout.stripe.com/c/pay/example'}};
  const r = response();
  await createCheckoutHandler(deps)(request(),r);
  assert.equal(r.statusCode,503);
  assert.equal(executions,0);
});
