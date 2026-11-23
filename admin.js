// The owner page: find a user and act on the account, manage invites, read the
// activity log, and browse or export the account and project tables. Every
// rule is enforced by the server (api/admin/*); this file only presents it.
const $ = id => document.getElementById(id);
const PANELS = { users: 'users-panel', invites: 'invites-panel', activity: 'activity-panel', accounts: 'data-panel', projects: 'data-panel' };
const columns = {
  accounts: [['name', 'Name'], ['email', 'Email'], ['company', 'Company'], ['discovery', 'How they found us'], ['profileUpdatedAt', 'Profile updated'], ['uid', 'Account ID']],
  projects: [['project', 'Project'], ['preparer', 'Prepared by'], ['email', 'Account email'], ['createdAt', 'Submitted'], ['uid', 'Account ID']],
};
const ACTION_LABEL = {
  'send-reset': 'Password reset emailed', block: 'Blocked', unblock: 'Unblocked',
  'grant-access': 'Free access granted', 'remove-access': 'Free access removed',
  invite: 'Invited', 'remove-invite': 'Invite removed',
};
const when = value => { const t = Date.parse(value); return Number.isFinite(t) ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—'; };

function denied(status) {
  $('admin-content').hidden = true;
  $('admin-status').hidden = false;
  $('admin-status').textContent = status === 401 ? 'Sign-in required.' : status === 403 ? 'This account does not have owner access or has not completed account setup.' : 'Unable to load the owner tools. Please try again.';
  $('admin-signin').hidden = status !== 401;
}
/** Call the users endpoint. Returns { ok, status, data }. */
async function api(query, body) {
  try {
    const response = await fetch(`/api/admin/users${query}`, body
      ? { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { cache: 'no-store' });
    let data = null;
    try { data = await response.json(); } catch { /* no body */ }
    if (response.status === 401 || (response.status === 403 && !body)) denied(response.status);
    return { ok: response.ok, status: response.status, data };
  } catch { return { ok: false, status: 0, data: null }; }
}
function say(el, text, tone = '') { el.hidden = !text; el.textContent = text || ''; el.dataset.tone = tone; }
function confirmAction(title, text, okLabel) {
  $('confirm-title').textContent = title; $('confirm-text').textContent = text; $('confirm-ok').textContent = okLabel;
  const dialog = $('confirm');
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    dialog.returnValue = 'cancel';
    dialog.showModal();
  });
}

// --- one user ----------------------------------------------------------------
let current = null;
function badge(text, tone) { const b = document.createElement('span'); b.className = 'badge'; b.dataset.tone = tone; b.textContent = text; return b; }
function showUser(user) {
  current = user;
  $('user-card').hidden = !user;
  if (!user) return;
  $('user-name').textContent = user.name || user.email;
  $('user-email').textContent = user.email;
  const paid = Boolean(user.access.stripeCustomerId);
  $('user-badges').replaceChildren(...[
    user.isOwner && badge('Owner', 'ink'),
    user.blocked && badge('Blocked', 'bad'),
    user.access.free && badge('Free access', 'ok'),
    !user.emailVerified && badge('Email not verified', 'warn'),
    user.access.riskHold && badge('Payment hold', 'bad'),
  ].filter(Boolean));
  const google = user.signsInWith.includes('google.com'), password = user.signsInWith.includes('password');
  const facts = [
    ['Signs in with', [password && 'Email and password', google && 'Google'].filter(Boolean).join(' and ') || '—'],
    ['Joined', when(user.createdAt)],
    ['Last sign-in', when(user.lastSignInAt)],
    ['Company', user.account?.company || '—'],
    ['Found us through', user.account?.discovery || '—'],
    ['Account setup', !user.account ? 'Not started' : user.account.profileComplete && user.account.termsAccepted ? 'Complete' : 'Incomplete'],
    ['Billing', paid ? 'Has a Stripe customer record' : 'No Stripe customer'],
    ['Account ID', user.uid],
  ];
  $('user-facts').replaceChildren(...facts.flatMap(([k, v]) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; return [dt, dd]; }));
  $('reset-note').textContent = password ? 'Firebase emails them a link to choose a new password. You never see the link.' : 'This account signs in with Google, so there is no password here to reset.';
  $('act-reset').disabled = !password;
  $('access-note').textContent = user.access.free
    ? `Free access is on${user.access.freeGrantedBy ? `, granted by ${user.access.freeGrantedBy} on ${when(user.access.freeGrantedAt)}` : ''}.`
    : paid ? 'No free access. Their subscription, if active, still applies.' : 'No free access and no subscription on file.';
  $('act-access').textContent = user.access.free ? 'Remove free access' : 'Give free access';
  $('act-access').disabled = false;
  $('block-note').textContent = user.isOwner ? 'Owner accounts cannot be blocked here.' : user.blocked ? 'This account is blocked and cannot sign in.' : 'Blocking stops new sign-ins. Anyone already signed in is signed out within 12 hours.';
  $('act-block').textContent = user.blocked ? 'Unblock this account' : 'Block this account';
  $('act-block').disabled = user.isOwner && !user.blocked;
}
async function findUser(query) {
  say($('user-message'), 'Looking…');
  showUser(null);
  const { ok, status, data } = await api(`?q=${encodeURIComponent(query)}`);
  if (ok) { say($('user-message'), ''); showUser(data.user); return; }
  say($('user-message'), status === 404 ? 'No user with that email address or account ID.' : data?.error || 'Unable to look that up. Please try again.', 'bad');
}
async function act(action, done) {
  if (!current) return;
  for (const b of document.querySelectorAll('#user-card button')) b.disabled = true;
  const { ok, data } = await api('', { action, uid: current.uid });
  if (ok) { showUser(data.user || current); say($('user-message'), done, 'ok'); }
  else { showUser(current); say($('user-message'), data?.error || 'That did not go through. Please try again.', 'bad'); }
}
$('user-search').addEventListener('submit', e => { e.preventDefault(); const q = $('user-query').value.trim(); if (q) findUser(q); });
$('act-reset').addEventListener('click', async () => {
  if (await confirmAction('Email a password reset?', `Firebase will email ${current.email} a link to choose a new password.`, 'Send email')) act('send-reset', `Password reset emailed to ${current.email}.`);
});
$('act-access').addEventListener('click', async () => {
  const free = current.access.free;
  if (await confirmAction(free ? 'Remove free access?' : 'Give free access?', free ? `${current.email} will need a paid subscription to use the calculator.` : `${current.email} will be able to use the calculator without paying.`, free ? 'Remove access' : 'Give access')) act(free ? 'remove-access' : 'grant-access', free ? 'Free access removed.' : 'Free access granted.');
});
$('act-block').addEventListener('click', async () => {
  const blocked = current.blocked;
  if (await confirmAction(blocked ? 'Unblock this account?' : 'Block this account?', blocked ? `${current.email} will be able to sign in again.` : `${current.email} will not be able to sign in. Their projects and billing are left as they are.`, blocked ? 'Unblock' : 'Block account')) act(blocked ? 'unblock' : 'block', blocked ? 'Account unblocked.' : 'Account blocked.');
});

// --- invites and activity ------------------------------------------------------
function rows(body, list, cells, empty, span) {
  body.replaceChildren(...(list.length ? list.map(item => { const tr = document.createElement('tr'); tr.append(...cells(item).map(c => { const td = document.createElement('td'); td.append(c); return td; })); return tr; })
    : [(() => { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = span; td.textContent = empty; tr.append(td); return tr; })()]));
}
async function loadInvites() {
  const { ok, data } = await api('?list=invites');
  if (!ok) return;
  rows($('invite-rows'), data.invites, invite => {
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'link'; remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      if (!await confirmAction('Remove this invite?', `${invite.email} will no longer be able to create an account while sign-ups are paused. An account they already created is not affected.`, 'Remove invite')) return;
      const out = await api('', { action: 'remove-invite', email: invite.email });
      say($('invite-message'), out.ok ? `Invite for ${invite.email} removed.` : out.data?.error || 'That did not go through.', out.ok ? 'ok' : 'bad');
      loadInvites();
    });
    return [invite.email, when(invite.invitedAt), invite.invitedBy || '—', remove];
  }, 'Nobody is invited yet.', 4);
}
$('invite-form').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('invite-email').value.trim();
  const out = await api('', { action: 'invite', email });
  say($('invite-message'), out.ok ? `${email} can now create an account.` : out.data?.error || 'That did not go through.', out.ok ? 'ok' : 'bad');
  if (out.ok) { $('invite-email').value = ''; loadInvites(); }
});
async function loadActivity() {
  const { ok, data } = await api('?list=log');
  if (ok) rows($('activity-rows'), data.log, l => [when(l.at), ACTION_LABEL[l.action] || l.action, l.targetEmail || l.targetUid || '—', l.adminEmail || '—'], 'Nothing has been changed from this page yet.', 4);
}

// --- account and project tables ------------------------------------------------
let kind = 'accounts', cursor = '', loading = false, requestId = 0;
async function load(reset = false) {
  if (loading && !reset) return;
  const generation = ++requestId;
  if (reset) { cursor = ''; $('table-body').replaceChildren(); }
  loading = true; $('load-more').hidden = true;
  try {
    const params = new URLSearchParams({ type: kind });
    if (cursor) params.set('cursor', cursor);
    const response = await fetch(`/api/admin/data?${params}`, { cache: 'no-store' });
    if (generation !== requestId) return;
    if (!response.ok) return denied(response.status);
    const data = await response.json();
    if (generation !== requestId) return;
    for (const row of data.rows) {
      const tr = document.createElement('tr');
      for (const [key] of columns[kind]) {
        const td = document.createElement('td');
        // An email opens that user in the Users section.
        if (key === 'email' && row.email) { const b = document.createElement('button'); b.type = 'button'; b.className = 'link'; b.textContent = row.email; b.addEventListener('click', () => { select('users'); $('user-query').value = row.email; findUser(row.email); }); td.append(b); }
        else td.textContent = row[key] || '—';
        tr.append(td);
      }
      $('table-body').append(tr);
    }
    cursor = data.nextCursor || '';
    $('load-more').hidden = !cursor;
    if (!$('table-body').children.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = columns[kind].length; td.textContent = 'No records yet.'; tr.append(td); $('table-body').append(tr); }
  } catch { if (generation === requestId) denied(0); }
  finally { if (generation === requestId) loading = false; }
}

function select(next) {
  for (const name of Object.keys(PANELS)) $(`${name}-tab`).setAttribute('aria-pressed', String(name === next));
  for (const id of new Set(Object.values(PANELS))) $(id).hidden = id !== PANELS[next];
  if (next === 'invites') loadInvites();
  if (next === 'activity') loadActivity();
  if (next === 'accounts' || next === 'projects') {
    kind = next;
    $('data-description').textContent = kind === 'accounts' ? 'Account details supplied during sign-in. Select an email to manage that user.' : 'Project details submitted by signed-in users.';
    $('download').href = `/api/admin/data?type=${kind}&format=csv`;
    const tr = document.createElement('tr');
    for (const [, label] of columns[kind]) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = label; tr.append(th); }
    $('table-head').replaceChildren(tr);
    load(true);
  }
}
for (const name of Object.keys(PANELS)) $(`${name}-tab`).addEventListener('click', () => select(name));
$('load-more').addEventListener('click', () => load());

// Opening the page: the activity list doubles as the access check.
(async () => {
  const { ok } = await api('?list=log');
  if (!ok) return;
  $('admin-status').hidden = true;
  $('admin-content').hidden = false;
  select('users');
  $('user-query').focus();
})();
