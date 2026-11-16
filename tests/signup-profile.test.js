import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSignupProfile, savePendingSignup, readPendingSignup, clearPendingSignup, pendingForUser } from '../src/auth/signup-profile.js';

const store = () => { const map = new Map(); return { setItem:(k,v)=>map.set(k,v), getItem:k=>map.get(k), removeItem:k=>map.delete(k), map }; };
const profile = { name:'  Alex Rivera ', company:' Example Co ', discovery:'LinkedIn', password:'never-save', token:'never-save' };

test('signup profile requires a valid name, company and discovery choice', () => {
  assert.deepEqual(validateSignupProfile(profile), {name:'Alex Rivera', company:'Example Co', discovery:'LinkedIn'});
  for (const invalid of [{...profile,name:' '}, {...profile,company:''}, {...profile,discovery:''}, {...profile,discovery:'unlisted'}, {...profile,name:'A\nB'}]) assert.equal(validateSignupProfile(invalid), null);
});

test('pending signup retains only profile metadata and is bound to the authenticated account', () => {
  const storage=store();
  assert.equal(savePendingSignup(storage, {profile,uid:'one',provider:'email'}, 1000), true);
  const saved=readPendingSignup(storage, 2000);
  assert.deepEqual(saved.profile, {name:'Alex Rivera', company:'Example Co', discovery:'LinkedIn'});
  assert.equal(pendingForUser(saved,'one'), true);
  assert.equal(pendingForUser(saved,'different'), false);
  assert.ok(![...storage.map.values()][0].includes('never-save'));
  assert.equal(readPendingSignup(storage, 1000 + 24*60*60*1000 + 1), null);
  assert.equal(storage.map.size, 0);
  clearPendingSignup(storage);
  assert.equal(readPendingSignup(storage, 2000), null);
});

test('Google redirect profile can be staged without a user but cannot be used by a user until bound', () => {
  const storage=store();
  assert.equal(savePendingSignup(storage,{profile,provider:'google'},1000),true);
  const staged=readPendingSignup(storage,2000);
  assert.equal(staged.uid,null);
  assert.equal(pendingForUser(staged,'one'),false);
  assert.equal(savePendingSignup(storage,{profile:staged.profile,provider:'google',uid:'one'},2000),true);
  assert.equal(pendingForUser(readPendingSignup(storage,3000),'one'),true);
});
