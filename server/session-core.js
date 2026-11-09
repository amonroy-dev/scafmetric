import { createHmac, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = '__scafmetric_session';
export const SESSION_SECONDS = 12 * 60 * 60;

function signingKey(env) {
  const secret = env.SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) throw new Error('Session signing is not configured');
  return secret;
}
function mac(data, key) { return createHmac('sha256', key).update(data).digest(); }
export function issueSession(user, env = process.env, now = Date.now()) {
  if (!user || typeof user.uid !== 'string' || !user.uid || typeof user.email !== 'string' || !user.email || typeof user.name !== 'string' || !user.name) throw new Error('Invalid identity');
  const iat = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({ uid: user.uid, email: user.email, name: user.name, iat, exp: iat + SESSION_SECONDS })).toString('base64url');
  return { token: `${payload}.${mac(payload, signingKey(env)).toString('base64url')}`, expiresAt: new Date((iat + SESSION_SECONDS) * 1000) };
}
export function verifySession(token, env = process.env, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 8192) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 2 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))) return null;
    const expected = mac(parts[0], signingKey(env));
    const signature = Buffer.from(parts[1], 'base64url');
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
    const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const time = Math.floor(now / 1000);
    if (!data || typeof data.uid !== 'string' || !data.uid || typeof data.email !== 'string' || !data.email || typeof data.name !== 'string' || !data.name || !Number.isSafeInteger(data.iat) || !Number.isSafeInteger(data.exp) || data.iat > time || data.exp <= time || data.exp <= data.iat || data.exp - data.iat > SESSION_SECONDS) return null;
    return { uid: data.uid, email: data.email, name: data.name };
  } catch { return null; }
}
export function getSessionCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length > 16384) return null;
  const matches = cookieHeader.split(';').map(s => s.trim()).filter(s => s.startsWith(`${COOKIE_NAME}=`));
  // An ambiguous cookie header must not select an attacker-controlled value.
  return matches.length === 1 ? matches[0].slice(COOKIE_NAME.length + 1) : null;
}
export function sameOrigin(req, env = process.env) {
  try {
    const configured = new URL(env.NEXT_PUBLIC_APP_URL);
    if (!['https:', 'http:'].includes(configured.protocol) || configured.username || configured.password) return false;
    if (env.NODE_ENV === 'production' && configured.protocol !== 'https:') return false;
    return req.headers.origin === configured.origin && req.headers['sec-fetch-site'] !== 'cross-site';
  } catch { return false; }
}
export function cookieFor(token, expires, env = process.env) {
  const secure = env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}; Expires=${expires.toUTCString()}`;
}
