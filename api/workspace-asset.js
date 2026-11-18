import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readAccount } from '../server/account.js';
import { checkEntitlement } from '../server/entitlement.js';
import { createPaidVerifier } from '../server/stripe-paid.js';
import { billingStripe } from '../server/billing.js';
import { getSessionCookie, verifySession } from '../server/session-core.js';
import { isConfigured } from './auth/session.js';

// Only files required by the calculator may be served. Never concatenate a
// request-supplied path into a file path without this explicit allowlist.
const assets = new Map([
  ['calculator', { file: 'calculator.html', contentType: 'text/html; charset=utf-8' }],
  ['app', { file: 'workspace-private/app.js', contentType: 'text/javascript; charset=utf-8' }],
  ['scaffold-app', { file: 'workspace-private/scaffold-app.js', contentType: 'text/javascript; charset=utf-8' }]
]);

function database(env) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const app = getApps().find(a => a.name === 'scafmetric') ?? initializeApp({
    credential: cert({ projectId, clientEmail: env.FIREBASE_CLIENT_EMAIL, privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') }),
    projectId
  }, 'scafmetric');
  return getFirestore(app);
}

// verifyPaid is server-only: without a verified payment provider, paid access
// fails closed. It is injectable for isolated tests and future billing setup.
export function createWorkspaceHandler({ env = process.env, getDatabase = () => database(env), accountFor = readAccount, entitlementFor = checkEntitlement, verifyPaid, readAsset = file => readFile(path.join(process.cwd(), file), 'utf8') } = {}) {
  return async function workspace(req, res) {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.setHeader('Allow', 'GET, HEAD');
      return res.status(405).send('Method not allowed.');
    }
    const key = req.query?.asset;
    if (typeof key !== 'string' || !assets.has(key)) return res.status(404).send('Not found.');
    if (!isConfigured(env)) return res.status(503).send('Workspace access is temporarily unavailable.');
    const user = verifySession(getSessionCookie(req.headers.cookie), env);
    if (!user) {
      if (key === 'calculator') { res.setHeader('Location', '/signin.html'); return res.status(302).send('Sign in to access the beam workspace.'); }
      return res.status(401).send('Sign in to access the beam workspace.');
    }
    try {
      const db = getDatabase();
      const account = await accountFor(db, user);
      if (!account || account.termsAccepted !== true || account.profileComplete !== true) {
        if (key === 'calculator') { res.setHeader('Location', '/signin.html'); return res.status(302).send('Complete your account setup.'); }
        return res.status(403).send('Complete your account setup.');
      }
      const access = await entitlementFor({ db, uid: user.uid, verifyPaid });
      if (access?.hasAccess !== true) {
        if (key === 'calculator') { res.setHeader('Location', '/billing.html'); return res.status(302).send('Paid access is required to use the beam workspace.'); }
        return res.status(403).send('Paid access is required to use the beam workspace.');
      }
      const asset = assets.get(key);
      const content = await readAsset(asset.file);
      res.setHeader('Content-Type', asset.contentType);
      return res.status(200).send(req.method === 'HEAD' ? '' : content);
    } catch {
      return res.status(503).send('Workspace access is temporarily unavailable.');
    }
  };
}

export default createWorkspaceHandler({verifyPaid: uid => createPaidVerifier({stripe:billingStripe(process.env),db:database(process.env),priceId:process.env.STRIPE_PRICE_ID})(uid)});
