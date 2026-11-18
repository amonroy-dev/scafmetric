import { createHash, randomUUID } from 'node:crypto';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import Stripe from 'stripe';
import { readAccount } from './account.js';
import { getSessionCookie, sameOrigin, verifySession } from './session-core.js';
import { isConfigured } from '../api/auth/session.js';
import { stripeConfig } from './stripe-config.js';

const RESERVATION_MS = 23 * 60 * 60 * 1000;
const BLOCKING_SUBSCRIPTIONS = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused']);
export class BillingError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function billingDatabase(env) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const app = getApps().find(a => a.name === 'scafmetric') ?? initializeApp({
    credential: cert({ projectId, clientEmail: env.FIREBASE_CLIENT_EMAIL, privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') }), projectId
  }, 'scafmetric');
  return getFirestore(app);
}
export function billingStripe(env) {
  const config = stripeConfig(env);
  if (!config) throw new BillingError(503, 'Billing is temporarily unavailable.');
  return new Stripe(config.key);
}
const uidIsValid = uid => typeof uid === 'string' && uid.length > 0 && uid.length <= 128 && !uid.includes('/');
const customerIsValid = id => typeof id === 'string' && /^cus_[A-Za-z0-9]+$/.test(id);
const reservationIsValid = value => value && typeof value.id === 'string' && /^[0-9a-f-]{36}$/i.test(value.id) && Number.isFinite(value.createdAt);
const keyHash = s => createHash('sha256').update(s).digest('hex');
const doc = (db, name, id) => db.collection(name).doc(id);

// Persist a durable reservation before contacting Stripe. Concurrent requests
// share the idempotency key, including after a lost response or Firestore retry.
async function reserve(db, uid, kind, now = Date.now()) {
  const ref = doc(db, 'scafmetricBilling', uid), field = `${kind}Reservation`;
  return db.runTransaction(async tx => {
    const snapshot = await tx.get(ref), data = snapshot.exists ? snapshot.data() : {};
    if (kind === 'customer' && data.stripeCustomerId) return { customerId: data.stripeCustomerId };
    const previous = data[field];
    if (previous) {
      if (!reservationIsValid(previous) || now < previous.createdAt) throw new BillingError(503, 'Billing is temporarily unavailable.');
      // Stripe idempotency keys may be pruned after 24 hours. Never repeat a
      // lost create after that window; require manual reconciliation instead.
      if (!previous.sessionId && now - previous.createdAt >= RESERVATION_MS) throw new BillingError(503, 'Billing needs review. Please contact support.');
      return previous;
    }
    const next = { id: randomUUID(), createdAt: now };
    tx.set(ref, { [field]: next }, { merge: true });
    return next;
  });
}

export async function mappedCustomer(db, uid) {
  if (!uidIsValid(uid)) throw new BillingError(401, 'Sign in again.');
  const snap = await doc(db, 'scafmetricBilling', uid).get();
  const customerId = snap.exists ? snap.data()?.stripeCustomerId : null;
  if (!customerId) return null;
  if (!customerIsValid(customerId)) throw new BillingError(503, 'Billing is temporarily unavailable.');
  const reverse = await doc(db, 'scafmetricStripeCustomers', customerId).get();
  if (!reverse.exists || reverse.data()?.uid !== uid) throw new BillingError(503, 'Billing is temporarily unavailable.');
  return customerId;
}

export async function ensureCustomer(db, stripe, user) {
  const existing = await mappedCustomer(db, user.uid);
  if (existing) return existing;
  const reservation = await reserve(db, user.uid, 'customer');
  if (reservation.customerId) return mappedCustomer(db, user.uid);
  const customer = await stripe.customers.create({ email: user.email.trim().toLowerCase() }, { idempotencyKey: `scafmetric-customer-${keyHash(user.uid)}-${reservation.id}` });
  if (!customerIsValid(customer?.id)) throw new BillingError(503, 'Billing is temporarily unavailable.');
  const ref = doc(db, 'scafmetricBilling', user.uid), reverseRef = doc(db, 'scafmetricStripeCustomers', customer.id);
  await db.runTransaction(async tx => {
    const [current, reverse] = await Promise.all([tx.get(ref), tx.get(reverseRef)]);
    const data = current.exists ? current.data() : {};
    if (data.stripeCustomerId && data.stripeCustomerId !== customer.id) throw new BillingError(503, 'Billing needs review. Please contact support.');
    if (data.stripeCustomerId === customer.id && reverse.exists && reverse.data()?.uid === user.uid) return;
    if (data.customerReservation?.id !== reservation.id) throw new BillingError(503, 'Billing needs review. Please contact support.');
    if (reverse.exists && reverse.data()?.uid !== user.uid) throw new BillingError(503, 'Billing needs review. Please contact support.');
    tx.set(ref, { stripeCustomerId: customer.id, customerReservation: null }, { merge: true });
    if (!reverse.exists) tx.create(reverseRef, { uid: user.uid });
  });
  return customer.id;
}

export function isApprovedPrice(price, priceId) {
  return price?.id === priceId && price.active === true && price.currency === 'usd' && price.type === 'recurring' &&
    price.billing_scheme === 'per_unit' && price.unit_amount === 4900 && price.recurring?.interval === 'month' &&
    price.recurring.interval_count === 1 && price.recurring.usage_type === 'licensed' && !price.recurring.trial_period_days;
}
async function hasBlockingSubscription(stripe, customer) {
  let startingAfter;
  for (let page = 0; page < 10; page++) {
    const result = await stripe.subscriptions.list({ customer, status: 'all', limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
    if (result.data.some(item => BLOCKING_SUBSCRIPTIONS.has(item.status))) return true;
    if (!result.has_more) return false;
    if (!result.data.length) break;
    startingAfter = result.data.at(-1).id;
  }
  throw new BillingError(503, 'Billing is temporarily unavailable.');
}
function hostedUrl(url, hostname) {
  try { const value = new URL(url); if (value.protocol === 'https:' && value.hostname === hostname && !value.username && !value.password) return value.href; } catch { /* fail closed */ }
  throw new BillingError(503, 'Billing is temporarily unavailable.');
}
async function clearReservation(db, uid, reservation) {
  const ref = doc(db, 'scafmetricBilling', uid);
  await db.runTransaction(async tx => {
    const snapshot = await tx.get(ref), current = snapshot.exists ? snapshot.data()?.checkoutReservation : null;
    if (current?.id === reservation.id) tx.set(ref, { checkoutReservation: null }, { merge: true });
  });
}
async function saveCheckout(db, uid, customerId, reservation, sessionId) {
  const ref = doc(db, 'scafmetricBilling', uid);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref), current = snap.exists ? snap.data() : {};
    if (current.stripeCustomerId !== customerId || current.checkoutReservation?.id !== reservation.id) throw new BillingError(503, 'Billing needs review. Please contact support.');
    const priorId = current.checkoutReservation.sessionId;
    if (priorId && priorId !== sessionId) throw new BillingError(503, 'Billing needs review. Please contact support.');
    tx.set(ref, { checkoutReservation: { ...current.checkoutReservation, sessionId } }, { merge: true });
  });
}

export async function startCheckout({ db, stripe, user, env }) {
  const lifetime = await doc(db, 'billingEntitlements', user.uid).get();
  if (lifetime.exists && lifetime.data()?.lifetimeFree === true) throw new BillingError(409, 'Your account already has access.');
  const price = await stripe.prices.retrieve(env.STRIPE_PRICE_ID);
  if (!isApprovedPrice(price, env.STRIPE_PRICE_ID)) throw new BillingError(503, 'Subscription pricing is unavailable.');
  const customer = await ensureCustomer(db, stripe, user);
  for (let attempts = 0; attempts < 3; attempts++) {
    if (await hasBlockingSubscription(stripe, customer)) throw new BillingError(409, 'You already have a subscription. Manage it in billing.');
    const reservation = await reserve(db, user.uid, 'checkout');
    if (reservation.sessionId) {
      const session = await stripe.checkout.sessions.retrieve(reservation.sessionId);
      if (session.customer !== customer) throw new BillingError(503, 'Billing needs review. Please contact support.');
      if (session.status === 'open' && session.expires_at * 1000 > Date.now()) return hostedUrl(session.url, 'checkout.stripe.com');
      if (session.status !== 'expired') throw new BillingError(409, 'Your checkout is being processed. Please check billing.');
      await clearReservation(db, user.uid, reservation);
      continue;
    }
    const identifier = `scafmetric-${[...keyHash(reservation.id).slice(0, 8)].map(c => 'abcdefghijklmnop'[parseInt(c, 16)]).join('')}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription', customer, line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${new URL(env.NEXT_PUBLIC_APP_URL).origin}/billing.html?checkout=success`,
      cancel_url: `${new URL(env.NEXT_PUBLIC_APP_URL).origin}/billing.html?checkout=cancelled`,
      integration_identifier: identifier
    }, { idempotencyKey: `scafmetric-checkout-${reservation.id}` });
    if (!session?.id || session.customer !== customer || session.status !== 'open') throw new BillingError(503, 'Billing is temporarily unavailable.');
    const url = hostedUrl(session.url, 'checkout.stripe.com');
    await saveCheckout(db, user.uid, customer, reservation, session.id);
    return url;
  }
  throw new BillingError(503, 'Billing is temporarily unavailable.');
}

export async function startPortal({ db, stripe, user, env }) {
  const customer = await mappedCustomer(db, user.uid);
  if (!customer) throw new BillingError(404, 'No billing account is available yet.');
  const session = await stripe.billingPortal.sessions.create({ customer, return_url: `${new URL(env.NEXT_PUBLIC_APP_URL).origin}/billing.html` });
  return hostedUrl(session?.url, 'billing.stripe.com');
}

// The client cannot choose a customer, price, amount, or redirect destination.
export function createBillingHandler(action, { env = process.env, getDatabase = () => billingDatabase(env), accountFor = user => readAccount(getDatabase(), user), getStripe = () => billingStripe(env), execute = action === 'checkout' ? startCheckout : startPortal } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed.' }); }
    if (!sameOrigin(req, env)) return res.status(403).json({ error: 'This request must come from the app.' });
    if (!isConfigured(env) || !stripeConfig(env) || (action === 'checkout' && !/^price_[A-Za-z0-9]+$/.test(env.STRIPE_PRICE_ID || ''))) return res.status(503).json({ error: 'Billing is temporarily unavailable.' });
    const user = verifySession(getSessionCookie(req.headers.cookie), env);
    if (!user || !uidIsValid(user.uid)) return res.status(401).json({ error: 'Sign in before continuing.' });
    if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return res.status(415).json({ error: 'Send JSON content.' });
    if (Number(req.headers['content-length']) > 1024) return res.status(413).json({ error: 'This request is too large.' });
    let body = req.body;
    try { if (typeof body === 'string') { if (Buffer.byteLength(body) > 1024) return res.status(413).json({error:'This request is too large.'}); body = JSON.parse(body); } if (Buffer.byteLength(JSON.stringify(body)) > 1024) return res.status(413).json({error:'This request is too large.'}); } catch { return res.status(400).json({ error: 'Invalid JSON body.' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) return res.status(400).json({ error: 'Invalid request.' });
    try {
      const account = await accountFor(user);
      if (!account) return res.status(401).json({ error: 'Account is unavailable. Please sign in again.' });
      if (account.termsAccepted !== true || account.profileComplete !== true) return res.status(403).json({ error: 'Complete your account and accept the current terms first.' });
      const url = await execute({ db:getDatabase(), stripe:getStripe(), user, env });
      return res.status(200).json({ url });
    } catch (error) {
      if (error instanceof BillingError) return res.status(error.status).json({ error: error.message });
      return res.status(503).json({ error: 'Billing is temporarily unavailable.' });
    }
  };
}
