import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../billing.js', import.meta.url), 'utf8');
const ids = ['signin-required','billing-unavailable','billing-pending','billing-plan','billing-active','billing-status','billing-error','retry-status','refresh-payment','start-checkout','manage-existing','manage-active'];
const settle = () => new Promise(resolve => setImmediate(resolve));
function browser({search = '', status = {status:200, body:{hasAccess:false,reason:'payment_required',canManageBilling:false}}, checkout} = {}) {
 const elements = Object.fromEntries(ids.map(id => [id, {hidden:true,disabled:false,textContent:'',listeners:{},addEventListener(name,fn){this.listeners[name]=fn}}]));
 const location = {search, destination:null, replace(url){this.destination=url}, assign(url){this.destination=url}};
 const fetch = async url => {
  const result = url === '/api/billing/status' ? status : checkout;
  if (result instanceof Error) throw result;
  if (!result) throw Error('Unexpected request');
  return {status:result.status,ok:result.status >= 200 && result.status < 300,json:async()=>result.body};
 };
 runInNewContext(source,{document:{getElementById:id=>elements[id]},location,fetch,URL,URLSearchParams,setTimeout:()=>1,clearTimeout:()=>{}});
 return {elements,location};
}

test('anonymous users sign in; unpaid members see the monthly price path', async () => {
 const anonymous=browser({status:{status:401}}); await settle(); assert.equal(anonymous.elements['signin-required'].hidden,false); assert.equal(anonymous.location.destination,null);
 const unpaid=browser(); await settle(); assert.equal(unpaid.elements['billing-plan'].hidden,false); assert.equal(unpaid.elements['manage-existing'].hidden,true);
});

test('success return is not proof of payment; only verified access opens the workspace', async () => {
 const pending=browser({search:'?checkout=success'}); await settle(); assert.equal(pending.elements['billing-pending'].hidden,false); assert.equal(pending.location.destination,null);
 const paid=browser({search:'?checkout=success',status:{status:200,body:{hasAccess:true,reason:'paid',canManageBilling:true}}}); await settle(); assert.equal(paid.location.destination,'/calculator.html');
 const lifetime=browser({status:{status:200,body:{hasAccess:true,reason:'lifetime',canManageBilling:false}}}); await settle(); assert.equal(lifetime.location.destination,'/calculator.html');
});

test('billing outages fail closed and Stripe redirects only to the expected HTTPS host', async () => {
 const unavailable=browser({status:new Error('offline')}); await settle(); assert.equal(unavailable.elements['billing-unavailable'].hidden,false); assert.equal(unavailable.location.destination,null);
 const invalid=browser({checkout:{status:200,body:{url:'https://evil.example/checkout'}}}); await settle(); invalid.elements['start-checkout'].listeners.click({currentTarget:invalid.elements['start-checkout']}); await settle(); assert.equal(invalid.location.destination,null); assert.equal(invalid.elements['billing-error'].hidden,false);
 const valid=browser({checkout:{status:200,body:{url:'https://checkout.stripe.com/c/pay/example'}}}); await settle(); valid.elements['start-checkout'].listeners.click({currentTarget:valid.elements['start-checkout']}); await settle(); assert.match(valid.location.destination,/^https:\/\/checkout\.stripe\.com\//);
});

test('paid subscribers can explicitly open the billing management page', async () => {
 const b=browser({search:'?manage=1',status:{status:200,body:{hasAccess:true,reason:'paid',canManageBilling:true}},checkout:{status:200,body:{url:'https://billing.stripe.com/p/session/example'}}});
 await settle(); assert.equal(b.elements['billing-active'].hidden,false); assert.equal(b.location.destination,null);
 b.elements['manage-active'].listeners.click({currentTarget:b.elements['manage-active']}); await settle(); assert.match(b.location.destination,/^https:\/\/billing\.stripe\.com\//);
});
