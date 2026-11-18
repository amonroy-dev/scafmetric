import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { createStripeWebhook } from '../api/stripe/webhook.js';

const env = { VERCEL_ENV:'preview', NODE_ENV:'production', STRIPE_TEST_SECRET_KEY:'sk_test_dummy', STRIPE_WEBHOOK_SECRET:'whsec_dummy', STRIPE_PRICE_ID:'price_123' };
const stripe = new Stripe(env.STRIPE_TEST_SECRET_KEY);
const payload = JSON.stringify({id:'evt_123',type:'invoice.paid',livemode:false,data:{object:{id:'in_123'}}},null,2);
const signature = stripe.webhooks.generateTestHeaderString({payload,secret:env.STRIPE_WEBHOOK_SECRET});
const request = (body=payload, sig=signature) => new Request('https://example.com/api/stripe/webhook',{method:'POST',headers:{'stripe-signature':sig},body});

test('webhook verifies the raw signed bytes and rejects altered payloads', async () => {
  let calls=0;
  const handler=createStripeWebhook({env,stripe,getDatabase:()=>({}),processEvent:async ({event})=>{calls++;assert.equal(event.id,'evt_123');}});
  assert.equal((await handler(request())).status,200);
  assert.equal((await handler(request(payload+' '))).status,400);
  assert.equal((await handler(request(payload,'bad'))).status,400);
  assert.equal(calls,1);
});

test('webhook fails closed for wrong mode, missing settings and processing failures', async () => {
  const common={stripe,getDatabase:()=>({})};
  let handler=createStripeWebhook({...common,env:{...env,VERCEL_ENV:'production',STRIPE_SECRET_KEY:'sk_live_dummy'}});
  assert.equal((await handler(request())).status,400);
  handler=createStripeWebhook({...common,env:{...env,STRIPE_TEST_SECRET_KEY:'sk_live_dummy'}});
  assert.equal((await handler(request())).status,503);
  handler=createStripeWebhook({...common,env:{...env,STRIPE_WEBHOOK_SECRET:''}});
  assert.equal((await handler(request())).status,503);
  handler=createStripeWebhook({...common,env,processEvent:async()=>{throw Error('outage');}});
  assert.equal((await handler(request())).status,503);
  assert.equal((await handler(new Request('https://example.com',{method:'GET'}))).status,405);
});
