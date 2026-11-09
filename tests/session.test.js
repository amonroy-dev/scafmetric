import test from 'node:test';
import assert from 'node:assert/strict';
import { cookieFor, getSessionCookie, issueSession, sameOrigin, verifySession, SESSION_SECONDS } from '../server/session-core.js';

const env = { SESSION_SECRET: 'a sufficiently long unique test secret for signing', NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://example.com' };
const user = { uid: 'uid123', email: 'hello@example.com', name: 'Example User' };
const now = 1_800_000_000_000;

test('signed session round trips and expires after twelve hours', () => {
  const { token, expiresAt } = issueSession(user, env, now);
  assert.deepEqual(verifySession(token, env, now), user);
  assert.equal(expiresAt.getTime(), now + SESSION_SECONDS * 1000);
  assert.equal(verifySession(token, env, now + SESSION_SECONDS * 1000), null);
  assert.equal(verifySession(token, { ...env, SESSION_SECRET: 'b sufficiently long unique test secret for signing' }, now), null);
  assert.equal(verifySession(`${token.slice(0, 4)}X${token.slice(5)}`, env, now), null);
  assert.equal(verifySession('garbage', env, now), null);
});

test('session signing fails closed when secret is absent or short', () => {
  for (const secret of ['', 'small']) {
    assert.throws(() => issueSession(user, { SESSION_SECRET: secret }, now));
    assert.equal(verifySession('x.y', { SESSION_SECRET: secret }, now), null);
  }
});

test('cookie is http-only, same-site, secure in production and ambiguous cookies fail', () => {
  const { token, expiresAt } = issueSession(user, env, now);
  const cookie = cookieFor(token, expiresAt, env);
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/); assert.match(cookie, /Secure/);
  assert.equal(getSessionCookie(cookie), token);
  assert.equal(getSessionCookie(`__scafmetric_session=${token}; __scafmetric_session=attacker`), null);
});

test('session mutations require configured exact origin and reject cross-site fetches', () => {
  const req = origin => ({ headers: { origin } });
  assert.equal(sameOrigin(req('https://example.com'), env), true);
  assert.equal(sameOrigin(req('https://evil.example.com'), env), false);
  assert.equal(sameOrigin(req(undefined), env), false);
  assert.equal(sameOrigin({ headers: { origin: 'https://example.com', 'sec-fetch-site': 'cross-site' } }, env), false);
  assert.equal(sameOrigin(req('http://example.com'), { ...env, NEXT_PUBLIC_APP_URL: 'http://example.com' }), false);
  assert.equal(sameOrigin(req('https://example.com'), { ...env, NEXT_PUBLIC_APP_URL: '' }), false);
});
