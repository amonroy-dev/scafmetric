import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readAccount } from '../server/account.js';
import { saveProject } from '../server/project-collection.js';
import { getSessionCookie, sameOrigin, verifySession } from '../server/session-core.js';
import { isConfigured } from './auth/session.js';

function database(env) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const app = getApps().find(a => a.name === 'scafmetric') ?? initializeApp({
    credential: cert({ projectId, clientEmail: env.FIREBASE_CLIENT_EMAIL, privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') }),
    projectId
  }, 'scafmetric');
  return getFirestore(app);
}

function parseInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (Object.keys(body).some(k => !['project', 'preparer', 'submissionId'].includes(k))) return null;
  if (typeof body.submissionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.submissionId)) return null;
  const field = value => typeof value === 'string' && value.length <= 120 && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : '';
  const project = field(body.project), preparer = field(body.preparer);
  return project && preparer ? { project, preparer, submissionId: body.submissionId.toLowerCase() } : null;
}

export function createProjectsHandler({ env = process.env, accountFor = user => readAccount(database(env), user), store = (user, input) => saveProject(database(env), user, input) } = {}) {
  return async function projects(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Method not allowed.' });
    }
    if (!sameOrigin(req, env)) return res.status(403).json({ error: 'This request must come from the app.' });
    if (!isConfigured(env)) return res.status(503).json({ error: 'Project collection is unavailable.' });
    const user = verifySession(getSessionCookie(req.headers.cookie), env);
    if (!user) return res.status(401).json({ error: 'Sign in to save project information.' });
    if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return res.status(415).json({ error: 'Send JSON content.' });
    if (Number(req.headers['content-length']) > 4096) return res.status(413).json({ error: 'This request is too large.' });
    let body = req.body;
    try {
      if (typeof body === 'string') {
        if (Buffer.byteLength(body) > 4096) return res.status(413).json({ error: 'This request is too large.' });
        body = JSON.parse(body);
      }
      if (Buffer.byteLength(JSON.stringify(body)) > 4096) return res.status(413).json({ error: 'This request is too large.' });
    } catch { return res.status(400).json({ error: 'Invalid JSON body.' }); }
    const input = parseInput(body);
    if (!input) return res.status(400).json({ error: 'Enter a project name and preparer (up to 120 characters each).' });
    try {
      const account = await accountFor(user);
      if (!account) return res.status(401).json({ error: 'Account is unavailable. Please sign in again.' });
      if (account.termsAccepted !== true || account.profileComplete !== true) return res.status(403).json({ error: 'Complete your account details and accept the current terms before saving project information.' });
      const result = await store(user, input);
      if (result.conflict) return res.status(409).json({ error: 'This submission was already saved with different details.' });
      return res.status(200).json({ ok: true, duplicate: result.duplicate });
    } catch { return res.status(503).json({ error: 'Project collection is unavailable.' }); }
  };
}
export default createProjectsHandler();
