import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaidVerifier } from '../server/stripe-paid.js';

function fixtures() {
  const data = {
    forward:{stripeCustomerId:'cus_123'}, reverse:{uid:'user1'},
    customer:{id:'cus_123',deleted:false},
    subscription:{id:'sub_123',customer:'cus_123',status:'active',latest_invoice:'in_123'},
    item:{id:'si_123',price:{id:'price_123',currency:'usd',unit_amount:4900,recurring:{interval:'month',interval_count:1}},quantity:1,current_period_start:100,current_period_end:500},
    invoice:{id:'in_123',customer:'cus_123',status:'paid',currency:'usd',amount_due:4900,amount_paid:4900,parent:{type:'subscription_details',subscription_details:{subscription:'sub_123'}}},
    payment:{id:'inpay_123',invoice:'in_123',status:'paid',amount_paid:4900,payment:{type:'payment_intent',payment_intent:'pi_123'}},
    intent:{id:'pi_123',status:'succeeded',customer:'cus_123',latest_charge:{id:'ch_123',customer:'cus_123',paid:true,disputed:false,amount_captured:4900,amount_refunded:0}}
  };
  const db={collection(name){return {doc(id){return {get:async()=>{let value=name==='scafmetricBilling'&&id==='user1'?data.forward:name==='scafmetricStripeCustomers'&&id==='cus_123'?data.reverse:null;return {exists:Boolean(value),data:()=>value};}};}};}};
  const stripe={customers:{retrieve:async()=>data.customer},subscriptions:{list:async()=>({data:[data.subscription],has_more:false})},subscriptionItems:{list:async()=>({data:[data.item],has_more:false})},invoices:{retrieve:async()=>data.invoice},invoicePayments:{list:async()=>({data:[data.payment],has_more:false})},paymentIntents:{retrieve:async()=>data.intent},charges:{retrieve:async()=>data.intent.latest_charge}};
  return {data,db,stripe,verify:()=>createPaidVerifier({db,stripe,priceId:'price_123',now:()=>200000})('user1')};
}

test('verified active paid subscription grants access only to its mapped customer', async () => {
  const f=fixtures(); assert.equal(await f.verify(),true);
  f.data.reverse.uid='another'; await assert.rejects(f.verify());
  f.data.reverse.uid='user1'; f.data.forward=null; assert.equal(await f.verify(),false);
});

test('trials, failed payments, cancellation and expired periods never grant access', async () => {
  for (const status of ['trialing','past_due','unpaid','canceled','incomplete','paused']) {
    const f=fixtures(); f.data.subscription.status=status; assert.equal(await f.verify(),false,status);
  }
  const f=fixtures(); f.data.item.current_period_end=200; assert.equal(await f.verify(),false);
  f.data.item.current_period_end=500; f.data.invoice.status='open'; assert.equal(await f.verify(),false);
  f.data.invoice.status='paid'; f.data.invoice.amount_paid=0; assert.equal(await f.verify(),false);
});

test('wrong product, out-of-band or refunded/disputed payment cannot grant access', async () => {
  const f=fixtures(); f.data.item.price.id='price_other'; assert.equal(await f.verify(),false);
  f.data.item.price.id='price_123'; f.data.invoice.parent.subscription_details.subscription='sub_other'; assert.equal(await f.verify(),false);
  f.data.invoice.parent.subscription_details.subscription='sub_123'; f.data.payment.payment.type='payment_record'; assert.equal(await f.verify(),false);
  f.data.payment.payment.type='payment_intent'; f.data.intent.latest_charge.amount_refunded=4900; assert.equal(await f.verify(),false);
  f.data.intent.latest_charge.amount_refunded=0; f.data.intent.latest_charge.disputed=true; assert.equal(await f.verify(),false);
});

test('risk hold or payment-service outage fails closed', async () => {
  const f=fixtures(); f.data.forward.riskHold=true; assert.equal(await f.verify(),false);
  f.data.forward.riskHold=false; f.stripe.subscriptions.list=async()=>{throw new Error('offline');}; await assert.rejects(f.verify());
  await assert.rejects(createPaidVerifier({db:f.db,stripe:f.stripe})('user1'));
});
