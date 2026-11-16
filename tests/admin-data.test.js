import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminDataHandler, toCsv } from '../api/admin/data.js';
import { COOKIE_NAME, issueSession } from '../server/session-core.js';

const env = { NODE_ENV: 'production', NEXT_PUBLIC_APP_URL: 'https://example.com', FIREBASE_PROJECT_ID: 'project', FIREBASE_CLIENT_EMAIL: 'service@example.com', FIREBASE_PRIVATE_KEY: 'test', SESSION_SECRET: 'a strong sufficiently long secret for testing', ADMIN_UIDS: 'owner-1, owner-2' };
const user = uid => ({ uid, email:`${uid}@example.com`, name:uid });
const cookie = identity => `${COOKIE_NAME}=${issueSession(identity, env).token}`;
function response() { return { headers:{}, statusCode:0, body:null, setHeader(k,v) { this.headers[k]=v; }, status(n) { this.statusCode=n; return this; }, json(v) { this.body=v; return this; }, send(v) { this.body=v; return this; } }; }
const request = (uid, query = { type:'accounts' }) => ({ method:'GET', query, headers: uid ? { cookie:cookie(user(uid)) } : {} });

test('only signed-in, allowlisted, active and fully onboarded accounts can read owner data', async () => {
  let calls = 0;
  const page = async () => { calls++; return { rows:[{ name:'Alice' }], nextCursor:null }; };
  const handler = createAdminDataHandler({ env, page, accountFor:async () => ({ termsAccepted:true, profileComplete:true }) });
  let res=response(); await handler(request(),res); assert.equal(res.statusCode,401);
  res=response(); await handler(request('other'),res); assert.equal(res.statusCode,403);
  assert.equal(calls,0);
  res=response(); await handler(request('owner-1'),res); assert.equal(res.statusCode,200); assert.equal(res.body.rows[0].name,'Alice'); assert.match(res.headers['Cache-Control'], /no-store/);
  for (const state of [null, { termsAccepted:false, profileComplete:true }, { termsAccepted:true, profileComplete:false }]) {
    const denied = createAdminDataHandler({ env, page, accountFor:async () => state });
    res=response(); await denied(request('owner-1'),res); assert.equal(res.statusCode,403);
  }
  const missingList = createAdminDataHandler({ env:{...env,ADMIN_UIDS:''}, page, accountFor:async () => ({ termsAccepted:true, profileComplete:true }) });
  res=response(); await missingList(request('owner-1'),res); assert.equal(res.statusCode,403);
  const unavailable = createAdminDataHandler({ env, page, accountFor:async () => { throw Error('unavailable'); } });
  res=response(); await unavailable(request('owner-1'),res); assert.equal(res.statusCode,503);
});

test('export reads all pages and protects spreadsheet formulas', async () => {
  const handler = createAdminDataHandler({ env, accountFor:async () => ({ termsAccepted:true, profileComplete:true }), page:async (_kind, cursor) => cursor ? { rows:[{ project:'=2+2', preparer:'A "quoted" name' }], nextCursor:null } : { rows:[{ project:'First', preparer:' @danger' }], nextCursor:'page2' } });
  const res=response(); await handler(request('owner-1', { type:'projects', format:'csv' }),res);
  assert.equal(res.statusCode,200); assert.match(res.headers['Content-Disposition'], /attachment/);
  assert.match(res.body, /"'=2\+2"/); assert.match(res.body, /"' @danger"/); assert.match(res.body, /"A ""quoted"" name"/);
  assert.match(toCsv('accounts', [{ name:'\t+evil' }]), /"'\t\+evil"/);
});

test('invalid operations and malformed pagination fail without reading data', async () => {
  let calls=0;
  const handler=createAdminDataHandler({env,accountFor:async () => ({termsAccepted:true,profileComplete:true}),page:async () => { calls++; }});
  let res=response(); await handler({...request('owner-1'),method:'POST'},res); assert.equal(res.statusCode,405);
  for (const query of [{type:'bad'}, {type:'accounts',cursor:'../foo'}, {type:'projects',format:'csv',cursor:'x'}]) { res=response(); await handler(request('owner-1',query),res); assert.equal(res.statusCode,400); }
  assert.equal(calls,0);
});
