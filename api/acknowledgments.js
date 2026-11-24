// Agreement to the scaffold builder notice, for the signed-in account.
//   GET   has this account agreed to the notice in force?
//   POST  record that it has: { notice, version, confirmed: [ids] }
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import {
  readScaffoldNotice, acceptScaffoldNotice, StaleNoticeError, NoAccountError,
  SCAFFOLD_NOTICE_VERSION, SCAFFOLD_NOTICE_ID,
} from '../server/acknowledgments.js';
import { getSessionCookie, sameOrigin, sameSiteRead, verifySession } from '../server/session-core.js';
import { isConfigured } from './auth/session.js';

function database(env) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const app = getApps().find(a => a.name === 'scafmetric') ?? initializeApp({
    credential: cert({ projectId, clientEmail: env.FIREBASE_CLIENT_EMAIL, privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') }),
    projectId,
  }, 'scafmetric');
  return getFirestore(app);
}

export function createAcknowledgmentsHandler({
  env = process.env,
  read = user => readScaffoldNotice(database(env), user),
  accept = (user, agreement) => acceptScaffoldNotice(database(env), user, agreement),
} = {}) {
  return async function acknowledgments(req, res) {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const method = (req.method || '').toUpperCase();
    if (!['GET', 'POST'].includes(method)) {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed.' });
    }
    // A read is checked by the fetch metadata browsers send with it; a write
    // must name this site as its origin (see sameSiteRead).
    if (!(method === 'GET' ? sameSiteRead(req, env) : sameOrigin(req, env))) return res.status(403).json({ error: 'This request must come from the app.' });
    if (!isConfigured(env)) return res.status(503).json({ error: 'Agreements cannot be recorded right now.' });
    const user = verifySession(getSessionCookie(req.headers.cookie), env);
    if (!user) return res.status(401).json({ error: 'Sign in first.' });

    try {
      if (method === 'GET') {
        const status = await read(user);
        if (!status) return res.status(403).json({ error: 'Account is unavailable.' });
        return res.status(200).json({ ok: true, scaffoldNotice: status });
      }

      if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        return res.status(415).json({ error: 'Send JSON content.' });
      }
      let body = req.body;
      if (typeof body === 'string') {
        if (body.length > 2000) return res.status(413).json({ error: 'This request is too large.' });
        body = JSON.parse(body);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) || body.notice !== SCAFFOLD_NOTICE_ID
        || typeof body.version !== 'string' || !Array.isArray(body.confirmed) || body.confirmed.length > 10
        || body.confirmed.some(id => typeof id !== 'string' || id.length > 40)) {
        return res.status(400).json({ error: 'Invalid request.' });
      }
      const status = await accept(user, { version: body.version, confirmed: body.confirmed });
      return res.status(200).json({ ok: true, scaffoldNotice: status });
    } catch (error) {
      if (error instanceof SyntaxError) return res.status(400).json({ error: 'Invalid JSON body.' });
      if (error instanceof StaleNoticeError) return res.status(409).json({ error: 'This notice has changed. Reload the page to read the current one.', version: SCAFFOLD_NOTICE_VERSION });
      if (error instanceof NoAccountError) return res.status(403).json({ error: 'Account is unavailable.' });
      if (error?.message === 'Every statement must be confirmed') return res.status(400).json({ error: 'Confirm every statement to continue.' });
      return res.status(503).json({ error: 'Agreements cannot be recorded right now.' });
    }
  };
}
export default createAcknowledgmentsHandler();
