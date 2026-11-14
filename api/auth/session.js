import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { ensureAccount, readAccount, TERMS_VERSION } from '../../server/account.js';
import { COOKIE_NAME, cookieFor, getSessionCookie, issueSession, sameOrigin, verifySession } from '../../server/session-core.js';

let adminAuth;
let firestore;
function getAdminAuth(env) {
  if (adminAuth) return adminAuth;
  const projectId = env.FIREBASE_PROJECT_ID;
  const clientEmail = env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!projectId || !clientEmail || !privateKey) throw new Error('Firebase Admin is not configured');
  const app = getApps().find(a => a.name === 'scafmetric') ?? initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), projectId }, 'scafmetric');
  adminAuth = getAuth(app);
  firestore = getFirestore(app);
  return adminAuth;
}
async function verifyFirebase(idToken, env) {
  const auth = getAdminAuth(env);
  let token;
  try { token = await auth.verifyIdToken(idToken, true); } catch { return null; }
  const user = await auth.getUser(token.uid);
  if (user.disabled || user.emailVerified !== true || user.email?.toLowerCase() !== token.email?.toLowerCase()) return null;
  return { ...token, creationTime: user.metadata.creationTime };
}
function send(res, status, body) { return res.status(status).json(body); }

export function isConfigured(env = process.env) {
  try {
    const url = new URL(env.NEXT_PUBLIC_APP_URL);
    if (url.username || url.password || !['http:', 'https:'].includes(url.protocol) || (env.NODE_ENV === 'production' && url.protocol !== 'https:')) return false;
    return Boolean(env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY && env.SESSION_SECRET?.trim().length >= 32);
  } catch { return false; }
}

// This handler is exported with injected verification for isolated security tests.
export function createSessionHandler({ env = process.env, verifyToken = verifyFirebase, accountFor = (data) => ensureAccount(firestore, data), accountStatus = (user) => { getAdminAuth(env); return readAccount(firestore, user); } } = {}) {
  return async function session(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET') {
      const configured = isConfigured(env);
      const user = verifySession(getSessionCookie(req.headers.cookie), env);
      if (!configured || !user) return send(res, 200, { configured, authenticated: false });
      try {
        const trial = await accountStatus(user);
        return send(res, 200, trial ? { configured, authenticated: true, user, trial, termsAccepted: trial.termsAccepted === true, termsVersion: TERMS_VERSION } : { configured, authenticated: false });
      } catch { return send(res, 503, { configured, authenticated: false, error: 'Account storage is unavailable.' }); }
    }
    if (!['POST', 'DELETE'].includes(req.method)) {
      res.setHeader('Allow', 'GET, POST, DELETE');
      return send(res, 405, { error: 'Method not allowed.' });
    }
    if (!sameOrigin(req, env)) return send(res, 403, { error: 'This request must come from the app.' });
    if (req.method === 'DELETE') {
      const secure = env.NODE_ENV === 'production' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0`);
      return send(res, 200, { ok: true });
    }
    if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return send(res, 415, { error: 'Send JSON content.' });
    if (Number(req.headers['content-length']) > 16384) return send(res, 413, { error: 'This request is too large.' });
    let body = req.body;
    if (typeof body === 'string') {
      if (Buffer.byteLength(body) > 16384) return send(res, 413, { error: 'This request is too large.' });
      try { body = JSON.parse(body); } catch { return send(res, 400, { error: 'The JSON body could not be read.' }); }
    }
    if (body && typeof body === 'object') {
      try { if (Buffer.byteLength(JSON.stringify(body)) > 16384) return send(res, 413, { error: 'This request is too large.' }); }
      catch { return send(res, 400, { error: 'Invalid JSON body.' }); }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.idToken !== 'string' || !body.idToken || Buffer.byteLength(body.idToken) > 12000) return send(res, 400, { error: 'A Firebase ID token is required.' });
    if (body.acceptTermsVersion != null && body.acceptTermsVersion !== TERMS_VERSION) return send(res, 409, { error: 'Terms have changed. Please review them again.', termsVersion: TERMS_VERSION });
    if (!isConfigured(env)) return send(res, 503, { error: 'Sign-in is temporarily unavailable.' });
    let decoded;
    try { decoded = await verifyToken(body.idToken, env); } catch { return send(res, 503, { error: 'Sign-in is temporarily unavailable.' }); }
    if (!decoded || decoded.email_verified !== true || typeof decoded.uid !== 'string' || !decoded.uid || typeof decoded.email !== 'string' || !decoded.email) return send(res, 401, { error: 'ID token could not be verified.' });
    try {
      const account = await accountFor({ uid: decoded.uid, email: decoded.email, creationTime: decoded.creationTime, acceptTermsVersion: body.acceptTermsVersion });
      const { token, expiresAt } = issueSession({ uid: decoded.uid, email: decoded.email, name: typeof decoded.name === 'string' && decoded.name ? decoded.name : decoded.email }, env);
      res.setHeader('Set-Cookie', cookieFor(token, expiresAt, env));
      return send(res, 200, { ok: true, expiresAt: expiresAt.toISOString(), termsAccepted: account?.termsVersion === TERMS_VERSION && Number.isFinite(Date.parse(account?.termsAcceptedAt)), termsVersion: TERMS_VERSION });
    } catch { return send(res, 503, { error: 'Sign-in is temporarily unavailable.' }); }
  };
}
export default createSessionHandler();
