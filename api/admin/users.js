// Owner endpoint for user accounts: look up, reset email, block, free access,
// invites and the activity log. Gated exactly like the owner data endpoint:
// a signed-in session, on the ADMIN_UIDS allowlist, with a complete account.
// Changes are POST only and must come from this site.
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { readAccount } from '../../server/account.js';
import { getSessionCookie, sameOrigin, verifySession } from '../../server/session-core.js';
import { isConfigured } from '../auth/session.js';
import { isAdminUid, canAccessAdmin } from '../../server/admin-access.js';
import { AdminActionError, createAdminUsers, sendFirebaseReset } from '../../server/admin-users.js';

function firebase(env) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const app = getApps().find(a => a.name === 'scafmetric') ?? initializeApp({
    credential: cert({ projectId, clientEmail: env.FIREBASE_CLIENT_EMAIL, privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') }), projectId,
  }, 'scafmetric');
  return { auth: getAuth(app), db: getFirestore(app) };
}

export function createAdminUsersHandler({
  env = process.env,
  services = () => { const { auth, db } = firebase(env); return { db, users: createAdminUsers({ auth, db, env, sendReset: email => sendFirebaseReset(email, env) }) }; },
  accountFor = (user, db) => readAccount(db, user),
} = {}) {
  return async function adminUsers(req, res) {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'Method not allowed.' }); }
    if (!isConfigured(env)) return res.status(503).json({ error: 'Owner tools are unavailable.' });
    const admin = verifySession(getSessionCookie(req.headers.cookie), env);
    if (!admin) return res.status(401).json({ error: 'Sign in to use the owner tools.' });
    if (!isAdminUid(admin, env)) return res.status(403).json({ error: 'Owner access required.' });
    if (req.method === 'POST') {
      if (!sameOrigin(req, env)) return res.status(403).json({ error: 'This request must come from the app.' });
      if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return res.status(415).json({ error: 'Send JSON content.' });
    }
    let body = req.body;
    if (req.method === 'POST') {
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'The JSON body could not be read.' }); } }
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.action !== 'string' || JSON.stringify(body).length > 2000) return res.status(400).json({ error: 'Invalid request.' });
    }
    try {
      const { db, users } = services();
      if (!canAccessAdmin(admin, await accountFor(admin, db), env)) return res.status(403).json({ error: 'Owner account is unavailable.' });
      if (req.method === 'POST') return res.status(200).json(await users.act(body.action, { uid: body.uid, email: body.email }, admin));
      const { q, list } = req.query || {};
      if (list === 'invites') return res.status(200).json({ invites: await users.invites() });
      if (list === 'log') return res.status(200).json({ log: await users.log() });
      if (typeof q !== 'string' || !q.trim() || q.length > 300) return res.status(400).json({ error: 'Enter an email address or account ID.' });
      const user = await users.find(q);
      return user ? res.status(200).json({ user }) : res.status(404).json({ error: 'No user with that email address or account ID.' });
    } catch (error) {
      if (error instanceof AdminActionError) return res.status(error.status).json({ error: error.message });
      return res.status(503).json({ error: 'Owner tools are unavailable.' });
    }
  };
}
export default createAdminUsersHandler();
