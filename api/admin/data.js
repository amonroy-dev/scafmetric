import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { FieldPath, getFirestore } from 'firebase-admin/firestore';
import { readAccount } from '../../server/account.js';
import { getSessionCookie, verifySession } from '../../server/session-core.js';
import { isConfigured } from '../auth/session.js';

const PAGE_SIZE = 100;
const fields = {
  accounts: ['uid', 'email', 'name', 'company', 'discovery', 'profileUpdatedAt'],
  projects: ['uid', 'email', 'project', 'preparer', 'createdAt']
};
const collections = { accounts: 'scafmetricAccounts', projects: 'scafmetricProjects' };
function database(env) {
  const projectId = env.FIREBASE_PROJECT_ID;
  const app = getApps().find(a => a.name === 'scafmetric') ?? initializeApp({
    credential: cert({ projectId, clientEmail: env.FIREBASE_CLIENT_EMAIL, privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') }), projectId
  }, 'scafmetric');
  return getFirestore(app);
}
function projectRow(kind, data) {
  if (kind === 'accounts') return { uid: data.uid, email: data.email, name: data.profile?.name, company: data.profile?.company, discovery: data.profile?.discovery, profileUpdatedAt: data.profileUpdatedAt };
  return { uid: data.uid, email: data.email, project: data.project, preparer: data.preparer, createdAt: data.createdAt };
}
async function fetchPage(env, kind, cursor) {
  let query = database(env).collection(collections[kind]).orderBy(FieldPath.documentId());
  if (cursor) query = query.startAfter(cursor);
  const snap = await query.limit(PAGE_SIZE).get();
  return { rows: snap.docs.map(doc => projectRow(kind, doc.data())), nextCursor: snap.docs.length === PAGE_SIZE ? snap.docs.at(-1).id : null };
}
function csvCell(value) {
  let text = typeof value === 'string' ? value : '';
  // Spreadsheets may treat formulas as commands even when the value is quoted.
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export function toCsv(kind, rows) {
  return [fields[kind].map(csvCell).join(','), ...rows.map(row => fields[kind].map(key => csvCell(row[key])).join(','))].join('\r\n') + '\r\n';
}

export function createAdminDataHandler({ env = process.env, accountFor = user => readAccount(database(env), user), page = (kind, cursor) => fetchPage(env, kind, cursor) } = {}) {
  return async function adminData(req, res) {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'Method not allowed.' }); }
    if (!isConfigured(env)) return res.status(503).json({ error: 'Owner data is unavailable.' });
    const user = verifySession(getSessionCookie(req.headers.cookie), env);
    if (!user) return res.status(401).json({ error: 'Sign in to view owner data.' });
    const allowed = (env.ADMIN_UIDS || '').split(',').map(uid => uid.trim()).filter(Boolean);
    if (!allowed.includes(user.uid)) return res.status(403).json({ error: 'Owner access required.' });
    const { type, format = 'json', cursor = '' } = req.query || {};
    if (typeof type !== 'string' || !Object.hasOwn(fields, type) || typeof format !== 'string' || !['json', 'csv'].includes(format) || typeof cursor !== 'string' || cursor.length > 1500 || cursor.includes('/') || (format === 'csv' && cursor)) return res.status(400).json({ error: 'Invalid request.' });
    try {
      const account = await accountFor(user);
      if (!account?.termsAccepted || !account?.profileComplete) return res.status(403).json({ error: 'Owner account is unavailable.' });
      if (format === 'json') return res.status(200).json(await page(type, cursor));
      const rows = []; let next = '';
      do { const batch = await page(type, next); rows.push(...batch.rows); next = batch.nextCursor; } while (next);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="scafmetric-${type}.csv"`);
      return res.status(200).send(toCsv(type, rows));
    } catch { return res.status(503).json({ error: 'Owner data is unavailable.' }); }
  };
}
export default createAdminDataHandler();
