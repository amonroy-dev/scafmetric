// Paid access is based on the current Stripe state, never a webhook payload,
// client return URL, metadata UID, or a locally cached subscription flag.
const idOf = value => typeof value === 'string' ? value : typeof value?.id === 'string' ? value.id : null;
const validId = (id,prefix) => typeof id === 'string' && id.startsWith(`${prefix}_`) && /^[A-Za-z0-9_]+$/.test(id) && id.length <= 200;

async function allPages(getPage) {
  const items=[]; let cursor;
  for (let page=0;page<100;page++) {
    const result=await getPage({limit:100,...(cursor?{starting_after:cursor}:{})});
    if (!result || !Array.isArray(result.data) || typeof result.has_more !== 'boolean') throw new Error('Invalid Stripe pagination');
    items.push(...result.data);
    if (!result.has_more) return items;
    cursor=idOf(result.data.at(-1));
    if (!cursor) throw new Error('Invalid Stripe pagination cursor');
  }
  throw new Error('Stripe pagination limit exceeded');
}

function matchingPaidItem(item, priceId, nowSeconds) {
  const p = item?.price, recurring = p?.recurring;
  return idOf(p) === priceId && p?.currency === 'usd' && p?.unit_amount === 4900 && recurring?.interval === 'month' && recurring?.interval_count === 1 &&
    Number.isInteger(item?.quantity) && item.quantity > 0 && Number.isFinite(item.current_period_start) && Number.isFinite(item.current_period_end) &&
    item.current_period_start <= nowSeconds && item.current_period_end > nowSeconds;
}

async function hasPaidStripeCharge(stripe, invoice, customerId) {
  const payments=await allPages(params => stripe.invoicePayments.list({invoice:invoice.id,status:'paid',...params}));
  for (const entry of payments) {
    if (entry.status !== 'paid' || !Number.isFinite(entry.amount_paid) || entry.amount_paid <= 0 || idOf(entry.invoice) !== invoice.id || entry.payment?.type !== 'payment_intent') continue;
    const paymentIntentId=idOf(entry.payment.payment_intent);
    if (!validId(paymentIntentId,'pi')) continue;
    const intent=await stripe.paymentIntents.retrieve(paymentIntentId,{expand:['latest_charge']});
    if (intent.status !== 'succeeded' || idOf(intent.customer) !== customerId) continue;
    let charge=intent.latest_charge;
    if (typeof charge === 'string') charge=await stripe.charges.retrieve(charge);
    if (!charge || charge.paid !== true || charge.disputed === true || idOf(charge.customer) !== customerId) continue;
    if (!Number.isFinite(charge.amount_captured) || charge.amount_captured <= 0 || !Number.isFinite(charge.amount_refunded) || charge.amount_refunded >= charge.amount_captured) continue;
    return true;
  }
  return false;
}

export function createPaidVerifier({stripe, db, priceId, now = () => Date.now()} = {}) {
  return async function verifyPaid(uid) {
    if (!stripe || !db || !validId(priceId,'price')) throw new Error('Payment verification is not configured');
    if (typeof uid !== 'string' || !uid || uid.includes('/') || uid.length > 128) throw new Error('Invalid account');
    const forward=await db.collection('scafmetricBilling').doc(uid).get();
    if (!forward.exists) return false;
    const billing=forward.data(), customerId=billing?.stripeCustomerId;
    if (billing?.riskHold === true) return false;
    if (!validId(customerId,'cus')) throw new Error('Customer mapping is invalid');
    const reverse=await db.collection('scafmetricStripeCustomers').doc(customerId).get();
    if (!reverse.exists || reverse.data()?.uid !== uid) throw new Error('Customer mapping is invalid');
    const customer=await stripe.customers.retrieve(customerId);
    if (customer?.deleted === true || customer?.id !== customerId) return false;
    const subscriptions=await allPages(params => stripe.subscriptions.list({customer:customerId,status:'all',...params}));
    const nowSeconds=Math.floor(now()/1000);
    for (const sub of subscriptions) {
      if (sub.status !== 'active' || idOf(sub.customer) !== customerId || !validId(idOf(sub),'sub')) continue;
      const items=await allPages(params => stripe.subscriptionItems.list({subscription:sub.id,...params}));
      if (!items.some(item => matchingPaidItem(item,priceId,nowSeconds))) continue;
      const invoiceId=idOf(sub.latest_invoice);
      if (!validId(invoiceId,'in')) continue;
      const invoice=await stripe.invoices.retrieve(invoiceId);
      if (invoice.status !== 'paid' || idOf(invoice.customer) !== customerId || invoice.parent?.type !== 'subscription_details' || idOf(invoice.parent.subscription_details?.subscription) !== sub.id ||
          invoice.currency !== 'usd' || !Number.isFinite(invoice.amount_due) || invoice.amount_due <= 0 || !Number.isFinite(invoice.amount_paid) || invoice.amount_paid < invoice.amount_due) continue;
      if (!await hasPaidStripeCharge(stripe,invoice,customerId)) continue;
      // An asynchronous risk webhook may have set a hold while Stripe was
      // queried; check the server-owned record again before granting access.
      const current=await db.collection('scafmetricBilling').doc(uid).get();
      return current.exists && current.data()?.stripeCustomerId === customerId && current.data()?.riskHold !== true;
    }
    return false;
  };
}
