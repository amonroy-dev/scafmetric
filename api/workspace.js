import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { readWorkspace, saveWorkspace, deleteWorkspace, RETENTION_DAYS } from '../server/workspace-store.js';
import { getSessionCookie, sameOrigin, verifySession } from '../server/session-core.js';
import { isConfigured } from './auth/session.js';

// Saved work in progress for the signed-in account: beam inputs and the
// scaffold model, kept for RETENTION_DAYS. GET loads, PUT saves, DELETE clears.

const MAX_BYTES = 256 * 1024;

function database(env) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const app = getApps().find(a => a.name === 'scafmetric') ?? initializeApp({
    credential: cert({ projectId, clientEmail: env.FIREBASE_CLIENT_EMAIL, privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') }),
    projectId
  }, 'scafmetric');
  return getFirestore(app);
}

// The scaffold snapshot is an opaque JSON string from the builder; the beam
// payload is a flat map of form values plus its load rows. Both are bounded.
export function parseInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (Object.keys(body).some(k => !['beam', 'scaffold'].includes(k))) return null;
  const scaffold = body.scaffold;
  if (scaffold !== undefined && scaffold !== null && typeof scaffold !== 'string') return null;
  if (typeof scaffold === 'string' && scaffold.length > MAX_BYTES) return null;
  const beam = body.beam;
  if (beam !== undefined && beam !== null && (typeof beam !== 'object' || Array.isArray(beam))) return null;
  if (scaffold === undefined && beam === undefined) return null;
  return { beam: beam ?? null, scaffold: scaffold ?? null };
}

export function createWorkspaceHandler({
  env = process.env,
  read = user => readWorkspace(database(env), user),
  write = (user, input) => saveWorkspace(database(env), user, input),
  remove = user => deleteWorkspace(database(env), user),
} = {}) {
  return async function workspace(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    const method = (req.method || '').toUpperCase();
    if (!['GET', 'PUT', 'DELETE'].includes(method)) {
      res.setHeader('Allow', 'GET, PUT, DELETE');
      return res.status(405).json({ error: 'Method not allowed.' });
    }
    if (!sameOrigin(req, env)) return res.status(403).json({ error: 'This request must come from the app.' });
    if (!isConfigured(env)) return res.status(503).json({ error: 'Saved work is unavailable.' });
    const user = verifySession(getSessionCookie(req.headers.cookie), env);
    if (!user) return res.status(401).json({ error: 'Sign in to use saved work.' });

    try {
      if (method === 'GET') {
        const found = await read(user);
        return res.status(200).json({ ok: true, retentionDays: RETENTION_DAYS, workspace: found });
      }
      if (method === 'DELETE') {
        await remove(user);
        return res.status(200).json({ ok: true });
      }

      if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        return res.status(415).json({ error: 'Send JSON content.' });
      }
      if (Number(req.headers['content-length']) > MAX_BYTES) return res.status(413).json({ error: 'This request is too large.' });
      let body = req.body;
      if (typeof body === 'string') {
        if (Buffer.byteLength(body) > MAX_BYTES) return res.status(413).json({ error: 'This request is too large.' });
        body = JSON.parse(body);
      }
      if (Buffer.byteLength(JSON.stringify(body ?? null)) > MAX_BYTES) return res.status(413).json({ error: 'This request is too large.' });
      const input = parseInput(body);
      if (!input) return res.status(400).json({ error: 'Send a beam object and/or a scaffold snapshot string.' });
      const saved = await write(user, input);
      return res.status(200).json({ ok: true, retentionDays: RETENTION_DAYS, ...saved });
    } catch (error) {
      if (error instanceof SyntaxError) return res.status(400).json({ error: 'Invalid JSON body.' });
      return res.status(503).json({ error: 'Saved work is unavailable.' });
    }
  };
}

export default createWorkspaceHandler();
