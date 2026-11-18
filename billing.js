const $ = id => document.getElementById(id);
const sections = ['signin-required', 'billing-unavailable', 'billing-pending', 'billing-plan', 'billing-active'];
const result = new URLSearchParams(location.search).get('checkout');
const manage = new URLSearchParams(location.search).get('manage') === '1';
let pendingChecks = 0, pollTimer, requestGeneration = 0;

function show(id, message = '') {
  for (const name of sections) $(name).hidden = name !== id;
  $('billing-status').textContent = message;
}
function error(message = '') { $('billing-error').textContent = message; $('billing-error').hidden = !message; }

async function checkAccess() {
  clearTimeout(pollTimer); error();
  const generation = ++requestGeneration;
  $('billing-status').textContent = 'Checking your account…';
  try {
    const response = await fetch('/api/billing/status', { cache:'no-store' });
    if (generation !== requestGeneration) return;
    if (response.status === 401) return show('signin-required');
    if (response.status === 403) return show('signin-required', 'Complete your account details and accept the current terms first.');
    if (!response.ok) return show('billing-unavailable');
    const state = await response.json();
    if (generation !== requestGeneration) return;
    if (state.hasAccess === true) {
      if (!manage || state.reason === 'lifetime') { location.replace('/calculator.html'); return; }
      show('billing-active');
      return;
    }
    if (state.hasAccess !== false) return show('billing-unavailable');
    $('manage-existing').hidden = state.canManageBilling !== true;
    if (result === 'success') {
      show('billing-pending', pendingChecks >= 8 ? 'Payment has not yet been confirmed. Check again or contact support if it remains pending.' : '');
      if (pendingChecks++ < 8) pollTimer = setTimeout(checkAccess, 4000);
      return;
    }
    show('billing-plan', result === 'cancelled' ? 'Checkout was canceled. You can start again when you’re ready.' : '');
  } catch { if (generation === requestGeneration) show('billing-unavailable'); }
}

function stripeUrl(value, host) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === host && !url.port && !url.username && !url.password ? url.href : null; } catch { return null; }
}
async function openBilling(button, route, host) {
  error(); button.disabled = true;
  try {
    const response = await fetch(route, { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    if (response.status === 401 || response.status === 403) { show('signin-required', 'Please sign in and complete your account setup.'); return; }
    if (response.status === 409) { error('Your checkout or subscription needs attention. If you already have a subscription, manage it in billing.'); return; }
    const body = await response.json();
    const url = response.ok && stripeUrl(body.url, host);
    if (!url) throw new Error('Billing unavailable');
    location.assign(url);
  } catch { error('Billing is temporarily unavailable. Please try again.'); }
  finally { button.disabled = false; }
}
$('retry-status').addEventListener('click', checkAccess);
$('refresh-payment').addEventListener('click', () => { pendingChecks = 0; void checkAccess(); });
$('start-checkout').addEventListener('click', event => void openBilling(event.currentTarget, '/api/billing/checkout', 'checkout.stripe.com'));
for (const id of ['manage-existing', 'manage-active']) $(id).addEventListener('click', event => void openBilling(event.currentTarget, '/api/billing/portal', 'billing.stripe.com'));
void checkAccess();
