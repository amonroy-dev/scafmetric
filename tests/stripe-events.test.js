import test from 'node:test';
import assert from 'node:assert/strict';
import { processStripeEvent } from '../server/stripe-events.js';

function database() {
  const docs = new Map([['scafmetricBilling/u1',{stripeCustomerId:'cus_123'}],['scafmetricStripeCustomers/cus_123',{uid:'u1'}]]);
  const ref = key => ({key,get:async()=>({exists:docs.has(key),data:()=>docs.get(key)})});
  return {docs,collection:name=>({doc:id=>ref(`${name}/${id}`)}),runTransaction:async fn=>fn({get:r=>r.get(),create:(r,v)=>docs.set(r.key,v),update:(r,v)=>docs.set(r.key,{...docs.get(r.key),...v})})};
}
function client(refunded=4900) {
  return {
    charges:{retrieve:async()=>({id:'ch_123',customer:'cus_123',payment_intent:'pi_123',amount:4900,amount_refunded:refunded})},
    invoicePayments:{list:async()=>({data:[{id:'inpay_1',invoice:'in_123'}],has_more:false})},
    invoices:{retrieve:async()=>({id:'in_123',customer:'cus_123',parent:{type:'subscription_details',subscription_details:{subscription:'sub_123'}}})},
    subscriptions:{retrieve:async()=>({id:'sub_123',customer:'cus_123'})},
    subscriptionItems:{list:async()=>({data:[{id:'si_123',price:'price_123'}],has_more:false})}
  };
}
const event=(id,type,object) => ({id,type,livemode:false,data:{object:{id:object}}});

test('full refund records a sticky hold, idempotently and despite later normal events',async()=>{
  const db=database(), stripe=client(), priceId='price_123';
  const refund=event('evt_1','charge.refunded','ch_123');
  await processStripeEvent({db,stripe,event:refund,priceId});
  assert.equal(db.docs.get('scafmetricBilling/u1').riskHold,true);
  const first=db.docs.get('scafmetricStripeEvents/test_evt_1_cus_123');
  await processStripeEvent({db,stripe,event:refund,priceId});
  assert.equal(db.docs.get('scafmetricStripeEvents/test_evt_1_cus_123'),first);
  await processStripeEvent({db,stripe,event:event('evt_2','invoice.paid','in_123'),priceId});
  assert.equal(db.docs.get('scafmetricBilling/u1').riskHold,true);
});

test('partial refund flags review without creating a permanent hold',async()=>{
  const db=database();
  await processStripeEvent({db,stripe:client(100),event:event('evt_3','charge.refunded','ch_123'),priceId:'price_123'});
  assert.equal(db.docs.get('scafmetricBilling/u1').riskReviewRequired,true);
  assert.notEqual(db.docs.get('scafmetricBilling/u1').riskHold,true);
});

test('inconsistent server-owned customer mapping rejects the event',async()=>{
  const db=database(); db.docs.set('scafmetricBilling/u1',{stripeCustomerId:'cus_wrong'});
  await assert.rejects(processStripeEvent({db,stripe:client(),event:event('evt_4','charge.refunded','ch_123'),priceId:'price_123'}));
  assert.equal(db.docs.has('scafmetricStripeEvents/test_evt_4_cus_123'),false);
});

test('risk events inspect every invoice payment page and hold disputed charges',async()=>{
  const db=database(), stripe=client();
  stripe.disputes={retrieve:async()=>({id:'dp_123',charge:'ch_123',status:'needs_response'})};
  stripe.invoicePayments.list=async ({starting_after})=>starting_after
    ? {data:[{id:'inpay_2',invoice:'in_123'}],has_more:false}
    : {data:[{id:'inpay_1',invoice:'in_other'}],has_more:true};
  stripe.invoices.retrieve=async id=> id==='in_other' ? {id,customer:'cus_123',parent:null} : {id,customer:'cus_123',parent:{type:'subscription_details',subscription_details:{subscription:'sub_123'}}};
  await processStripeEvent({db,stripe,event:event('evt_5','charge.dispute.created','dp_123'),priceId:'price_123'});
  assert.equal(db.docs.get('scafmetricBilling/u1').riskHoldReason,'dispute');
});
