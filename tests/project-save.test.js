import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectSaver } from '../src/project-save.js';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture(request) {
  const status = {}, message = {}, retry = { addEventListener(event, fn) { this.click = fn; } }, signIn = {};
  let sequence = 0;
  const saver = createProjectSaver({ status, message, retry, signIn, request, newId: () => `id-${++sequence}` });
  return { saver, status, message, retry, signIn };
}

test('failed project saves can be retried with the same submission ID', async () => {
  const calls = [];
  const f = fixture(async (url, options) => { calls.push(JSON.parse(options.body)); return { ok: calls.length > 1, status: 503 }; });
  f.saver.capture('  Project A ', ' Pat ');
  await flush();
  assert.match(f.message.textContent, /not saved/);
  assert.equal(f.retry.hidden, false);
  f.retry.click();
  await flush();
  assert.deepEqual(calls, [{ project: 'Project A', preparer: 'Pat', submissionId: 'id-1' }, { project: 'Project A', preparer: 'Pat', submissionId: 'id-1' }]);
  assert.equal(f.message.textContent, 'Project details saved.');
  assert.equal(f.retry.hidden, true);
});

test('guests are told their project was not saved', async () => {
  const f = fixture(async () => ({ ok: false, status: 401 }));
  f.saver.capture('Project', 'Pat');
  await flush();
  assert.match(f.message.textContent, /not saved/);
  assert.equal(f.signIn.hidden, false);
});

test('a failed submission remains queued across later analysis runs', async () => {
  const calls = [];
  let online = false;
  const f = fixture(async (url, options) => { calls.push(JSON.parse(options.body)); return { ok: online, status: online ? 200 : 503 }; });
  f.saver.capture('First', 'Pat');
  await flush();
  f.saver.capture('Second', 'Pat');
  await flush();
  assert.match(f.message.textContent, /2 projects are not saved/);
  assert.match(f.message.textContent, /only while this page stays open/);
  online = true;
  f.retry.click();
  await flush();
  assert.deepEqual(calls.map(item => item.submissionId), ['id-1', 'id-1', 'id-1', 'id-2']);
  assert.equal(f.message.textContent, 'Project details saved.');
});

test('an older success cannot falsely report a newer analysis was saved', async () => {
  let completeOld;
  const f = fixture((url, options) => JSON.parse(options.body).project === 'Old'
    ? new Promise(resolve => { completeOld = resolve; })
    : Promise.resolve({ ok: false, status: 503 }));
  f.saver.capture('Old', 'Pat');
  f.saver.capture('New', 'Pat');
  await flush();
  completeOld({ ok: true });
  await flush();
  assert.match(f.message.textContent, /not saved/);
  assert.equal(f.retry.hidden, false);
});
