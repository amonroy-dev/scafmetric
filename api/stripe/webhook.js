import Stripe from 'stripe';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { processStripeEvent } from '../../server/stripe-events.js';
import { stripeConfig } from '../../server/stripe-config.js';

const MAX_BYTES = 1024 * 1024;
function database(env) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const app = getApps().find(a => a.name === 'scafmetric') ?? initializeApp({
    credential:cert({projectId,clientEmail:env.FIREBASE_CLIENT_EMAIL,privateKey:env.FIREBASE_PRIVATE_KEY.replace(/\\n/g,'\n')}),projectId
  },'scafmetric');
  return getFirestore(app);
}
const reply = (status, body) => Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});

// Web-standard request body is read as raw bytes. Never parse or reserialize
// the signed payload before Stripe verifies its signature and timestamp.
export function createStripeWebhook({env = process.env, stripe, getDatabase = () => database(env), processEvent = processStripeEvent} = {}) {
  return async function webhook(request) {
    if (request.method !== 'POST') return new Response('Method not allowed.',{status:405,headers:{Allow:'POST','Cache-Control':'no-store'}});
    const config = stripeConfig(env);
    if (!config || !/^whsec_/.test(env.STRIPE_WEBHOOK_SECRET || '') || !/^price_[A-Za-z0-9]+$/.test(env.STRIPE_PRICE_ID || '')) return reply(503,{error:'Webhook is unavailable.'});
    const signature = request.headers.get('stripe-signature');
    if (!signature || signature.length > 4096) return reply(400,{error:'Invalid webhook signature.'});
    const length = request.headers.get('content-length');
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) return reply(413,{error:'Webhook payload is too large.'});
    let raw, event;
    try {
      raw = Buffer.from(await request.arrayBuffer());
      if (!raw.length || raw.length > MAX_BYTES) return reply(413,{error:'Webhook payload is too large.'});
      const client = stripe || new Stripe(config.key,{apiVersion:'2026-09-30.endive',maxNetworkRetries:2});
      event = await client.webhooks.constructEventAsync(raw,signature,env.STRIPE_WEBHOOK_SECRET);
      if (event?.livemode !== config.livemode) return reply(400,{error:'Webhook mode does not match configuration.'});
      await processEvent({stripe:client,db:getDatabase(),event,priceId:env.STRIPE_PRICE_ID});
      return reply(200,{received:true});
    } catch (error) {
      // Verification failures are client errors; processing/storage errors must
      // be retried by Stripe. Do not reveal credentials or event contents.
      if (!event) return reply(400,{error:'Invalid webhook signature or payload.'});
      return reply(503,{error:'Webhook processing is temporarily unavailable.'});
    }
  };
}

const handler = createStripeWebhook();
export default { fetch:handler };
