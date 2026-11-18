// Webhook processing never grants access from an event payload. Each event is
// resolved through Stripe's API and server-owned customer mappings; access is
// determined separately from Stripe's current subscription and payment state.
const EVENT_TYPES = new Set([
  'checkout.session.completed', 'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed', 'customer.subscription.created',
  'customer.subscription.updated', 'customer.subscription.deleted',
  'invoice.paid', 'invoice.payment_failed', 'invoice.payment_action_required',
  'charge.refunded', 'charge.dispute.created', 'radar.early_fraud_warning.created'
]);
const RISK_TYPES = new Set(['charge.refunded', 'charge.dispute.created', 'radar.early_fraud_warning.created']);
const idOf = value => typeof value === 'string' ? value : typeof value?.id === 'string' ? value.id : null;
const validId = (id, prefix) => typeof id === 'string' && id.startsWith(`${prefix}_`) && /^[A-Za-z0-9_]+$/.test(id) && id.length <= 200;

async function collectPages(getPage, limit = 100) {
  const found = [];
  let cursor;
  for (let page = 0; page < 100; page++) {
    const result = await getPage({limit, ...(cursor ? {starting_after:cursor} : {})});
    if (!result || !Array.isArray(result.data) || typeof result.has_more !== 'boolean') throw new Error('Invalid Stripe pagination');
    found.push(...result.data);
    if (!result.has_more) return found;
    cursor = idOf(result.data.at(-1));
    if (!cursor) throw new Error('Invalid Stripe pagination cursor');
  }
  throw new Error('Stripe pagination limit exceeded');
}

function subscriptionId(invoice) {
  return invoice?.parent?.type === 'subscription_details' ? idOf(invoice.parent.subscription_details?.subscription) : null;
}

async function matchesPrice(stripe, subscription, priceId) {
  if (!validId(subscription?.id, 'sub') || !validId(priceId, 'price')) throw new Error('Invalid subscription or price');
  const items = await collectPages(params => stripe.subscriptionItems.list({subscription:subscription.id, ...params}));
  return items.some(item => idOf(item.price) === priceId);
}

async function subscriptionsForRisk(stripe, event) {
  const object = event.data?.object;
  let chargeId, risk;
  if (event.type === 'charge.refunded') {
    chargeId = idOf(object);
    risk = 'refund';
  } else if (event.type === 'charge.dispute.created') {
    if (!validId(idOf(object), 'dp')) throw new Error('Invalid dispute');
    const dispute = await stripe.disputes.retrieve(idOf(object));
    chargeId = idOf(dispute.charge);
    // A late delivery should not impose a new hold on a dispute already won.
    risk = dispute.status === 'won' ? 'review' : 'dispute';
  } else {
    if (!validId(idOf(object), 'issfr')) throw new Error('Invalid fraud warning');
    const warning = await stripe.radar.earlyFraudWarnings.retrieve(idOf(object));
    chargeId = idOf(warning.charge);
    risk = warning.actionable === true ? 'fraud' : 'review';
  }
  if (!validId(chargeId, 'ch')) throw new Error('Invalid charge');
  const charge = await stripe.charges.retrieve(chargeId);
  if (risk === 'refund') risk = Number.isInteger(charge.amount) && charge.amount > 0 && Number.isInteger(charge.amount_refunded) && charge.amount_refunded >= charge.amount ? 'full_refund' : 'review';
  const paymentIntent = idOf(charge.payment_intent);
  if (!validId(paymentIntent, 'pi')) return [];
  const invoicePayments = await collectPages(params => stripe.invoicePayments.list({payment:{type:'payment_intent',payment_intent:paymentIntent},status:'paid',...params}));
  const resolved = [];
  for (const invoiceId of new Set(invoicePayments.map(payment => idOf(payment.invoice)).filter(id => validId(id,'in')))) {
    const invoice = await stripe.invoices.retrieve(invoiceId);
    const subId = subscriptionId(invoice);
    if (!validId(subId,'sub')) continue;
    const subscription = await stripe.subscriptions.retrieve(subId);
    if (idOf(invoice.customer) !== idOf(subscription.customer) || idOf(charge.customer) !== idOf(subscription.customer)) throw new Error('Stripe customer mismatch');
    resolved.push({subscription, risk});
  }
  return resolved;
}

async function subscriptionsForEvent(stripe, event) {
  if (RISK_TYPES.has(event.type)) return subscriptionsForRisk(stripe,event);
  const objectId = idOf(event.data?.object);
  let subId;
  if (event.type.startsWith('customer.subscription.')) subId = objectId;
  else if (event.type.startsWith('invoice.')) {
    if (!validId(objectId,'in')) throw new Error('Invalid invoice');
    subId = subscriptionId(await stripe.invoices.retrieve(objectId));
  } else {
    if (!validId(objectId,'cs')) throw new Error('Invalid checkout session');
    const session = await stripe.checkout.sessions.retrieve(objectId);
    if (session.mode !== 'subscription') return [];
    subId = idOf(session.subscription);
  }
  if (!subId) return [];
  if (!validId(subId,'sub')) throw new Error('Invalid subscription');
  return [{subscription:await stripe.subscriptions.retrieve(subId),risk:null}];
}

// Atomic write couples idempotence with the risk hold, preventing duplicate or
// out-of-order events from clearing a prior hold. A hold needs human review.
async function recordEvent(db, {event, customerId, uid, risk}) {
  const reverse = db.collection('scafmetricStripeCustomers').doc(customerId);
  const forward = db.collection('scafmetricBilling').doc(uid);
  const processed = db.collection('scafmetricStripeEvents').doc(`${event.livemode ? 'live' : 'test'}_${event.id}_${customerId}`);
  return db.runTransaction(async tx => {
    const [reverseSnap, forwardSnap, processedSnap] = await Promise.all([tx.get(reverse),tx.get(forward),tx.get(processed)]);
    if (!reverseSnap.exists || reverseSnap.data()?.uid !== uid || !forwardSnap.exists || forwardSnap.data()?.stripeCustomerId !== customerId) throw new Error('Customer mapping mismatch');
    if (processedSnap.exists) return false;
    const needsHold = ['full_refund','dispute','fraud'].includes(risk);
    const now = new Date().toISOString();
    tx.create(processed, {uid,customerId,type:event.type,createdAt:now,risk:risk || null});
    if (risk) tx.update(forward, {riskReviewRequired:true,riskReviewUpdatedAt:now,...(needsHold ? {riskHold:true,riskHoldReason:risk,riskHoldUpdatedAt:now} : {})});
    return true;
  });
}

export async function processStripeEvent({stripe, db, event, priceId}) {
  if (!validId(event?.id,'evt') || typeof event.type !== 'string' || typeof event.livemode !== 'boolean') throw new Error('Invalid Stripe event');
  if (!EVENT_TYPES.has(event.type)) return {ignored:true};
  const resolved = await subscriptionsForEvent(stripe,event);
  const byCustomer = new Map();
  for (const result of resolved) {
    const customer = idOf(result.subscription.customer);
    if (!validId(customer,'cus') || !await matchesPrice(stripe,result.subscription,priceId)) continue;
    // Multiple invoices can point to the same customer; keep the strongest hold.
    const previous = byCustomer.get(customer);
    if (!previous || ['full_refund','dispute','fraud'].includes(result.risk)) byCustomer.set(customer,result.risk);
  }
  for (const [customerId,risk] of byCustomer) {
    const mapping = await db.collection('scafmetricStripeCustomers').doc(customerId).get();
    const uid = mapping.exists ? mapping.data()?.uid : null;
    if (typeof uid !== 'string' || !uid || uid.includes('/') || uid.length > 128) throw new Error('Customer mapping unavailable');
    await recordEvent(db,{event,customerId,uid,risk});
  }
  return {ignored:byCustomer.size === 0};
}
