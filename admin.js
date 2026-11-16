const $ = id => document.getElementById(id);
const columns = {
  accounts: [['name', 'Name'], ['email', 'Email'], ['company', 'Company'], ['discovery', 'How they found us'], ['profileUpdatedAt', 'Profile updated'], ['uid', 'Account ID']],
  projects: [['project', 'Project'], ['preparer', 'Prepared by'], ['email', 'Account email'], ['createdAt', 'Submitted'], ['uid', 'Account ID']]
};
let kind = 'accounts', cursor = '', loading = false, requestId = 0;
async function load(reset = false) {
  if (loading && !reset) return;
  const generation = ++requestId;
  if (reset) { cursor = ''; $('table-body').replaceChildren(); }
  loading = true; $('load-more').hidden = true; $('admin-signin').hidden = true; $('admin-status').textContent = 'Loading…'; $('admin-status').hidden = false;
  try {
    const params = new URLSearchParams({ type: kind });
    if (cursor) params.set('cursor', cursor);
    const response = await fetch(`/api/admin/data?${params}`, { cache: 'no-store' });
    if (generation !== requestId) return;
    if (!response.ok) {
      $('admin-content').hidden = true;
      $('admin-status').textContent = response.status === 401 ? 'Sign-in required.' : response.status === 403 ? 'This account does not have owner access or has not completed account setup.' : 'Unable to load owner data. Please try again.';
      $('admin-signin').hidden = response.status !== 401;
      return;
    }
    const data = await response.json();
    if (generation !== requestId) return;
    $('admin-content').hidden = false; $('admin-status').hidden = true;
    for (const row of data.rows) {
      const tr = document.createElement('tr');
      for (const [key] of columns[kind]) { const td = document.createElement('td'); td.textContent = row[key] || '—'; tr.append(td); }
      $('table-body').append(tr);
    }
    cursor = data.nextCursor || '';
    $('load-more').hidden = !cursor;
    if (!$('table-body').children.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = columns[kind].length; td.textContent = 'No records yet.'; tr.append(td); $('table-body').append(tr); }
  } catch { if (generation === requestId) { $('admin-content').hidden = true; $('admin-signin').hidden = true; $('admin-status').hidden = false; $('admin-status').textContent = 'Unable to load owner data. Please try again.'; } }
  finally { if (generation === requestId) loading = false; }
}
function select(next) {
  kind = next;
  for (const name of Object.keys(columns)) $(`${name}-tab`).setAttribute('aria-pressed', String(name === kind));
  $('data-description').textContent = kind === 'accounts' ? 'Account details supplied during sign-in.' : 'Project details submitted by signed-in users.';
  $('download').href = `/api/admin/data?type=${kind}&format=csv`;
  const tr = document.createElement('tr');
  for (const [, label] of columns[kind]) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = label; tr.append(th); }
  $('table-head').replaceChildren(tr);
  load(true);
}
$('accounts-tab').addEventListener('click', () => select('accounts'));
$('projects-tab').addEventListener('click', () => select('projects'));
$('load-more').addEventListener('click', () => load());
select('accounts');
