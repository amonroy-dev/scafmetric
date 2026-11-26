// Stands between the scaffold button and the builder.
//
// The first time someone opens the builder they are shown a page saying what
// it is for (estimating) and what it is not (engineering), and must tick both
// statements and agree before it opens. The agreement is recorded on their
// account, so it is asked once per person and not once per browser: a second
// person signing in on the same computer is asked too. If the record cannot be
// written (the server is unreachable) the builder still opens, because they
// did agree, and they are simply asked again next visit.
//
// The wording lives in src/scaffold-notice.js.

import {
  SCAFFOLD_NOTICE, SCAFFOLD_NOTICE_VERSION, SCAFFOLD_NOTICE_ID, SCAFFOLD_NOTICE_CONFIRMATIONS,
} from '../../scaffold-notice.js';

const ENDPOINT = '/api/acknowledgments';
const STALE = 'This notice has been updated. Reload the page to read the current one.';

/**
 * `fetchImpl` and `present` are injectable so the gate can be tested without a
 * server or a page. `present({ onAgree, onCancel })` shows the notice;
 * `onAgree()` resolves to { done: true } or { error: 'why not' }.
 */
export function createUseNotice({ fetchImpl = (...args) => fetch(...args), present = presentNotice } = {}) {
  let agreed = false;  // known to have agreed: on the server, or in this page
  let asking = null;   // the one lookup, shared by the prefetch and the first click
  const lookup = () => (asking ||= fetchImpl(ENDPOINT, { method: 'GET', cache: 'no-store', credentials: 'same-origin' })
    .then(r => (r.ok ? r.json() : null))
    .then(d => d?.scaffoldNotice?.accepted === true)
    .catch(() => false));

  /** 'recorded', 'unrecorded' (carry on, ask again next visit) or 'stale'. */
  const record = async () => {
    try {
      const r = await fetchImpl(ENDPOINT, {
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ notice: SCAFFOLD_NOTICE_ID, version: SCAFFOLD_NOTICE_VERSION, confirmed: SCAFFOLD_NOTICE_CONFIRMATIONS }),
      });
      if (r.status === 409) return 'stale';
      return r.ok ? 'recorded' : 'unrecorded';
    } catch {
      return 'unrecorded';
    }
  };

  return {
    /** Ask the server ahead of the first click, so the click does not wait on it. */
    prefetch() { lookup().then(yes => { if (yes) agreed = true; }); },

    /**
     * Run `proceed` once the person has agreed, now or on an earlier visit.
     * Resolves to what happened: 'already', 'recorded', 'unrecorded' or 'cancelled'.
     */
    async request(proceed) {
      if (!agreed) agreed = await lookup();
      if (agreed) { proceed(); return 'already'; }
      return new Promise(resolve => {
        present({
          onAgree: async () => {
            const outcome = await record();
            if (outcome === 'stale') return { error: STALE };
            agreed = true;
            proceed();
            resolve(outcome);
            return { done: true };
          },
          onCancel: () => resolve('cancelled'),
        });
      });
    },
  };
}

// --- the page itself ---------------------------------------------------------

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Show the notice as a page over everything, until it is agreed to or cancelled. */
export function presentNotice({ onAgree, onCancel }) {
  if (document.querySelector('dialog.sfn')) return; // already up
  const dialog = el('dialog', 'sfn');
  dialog.setAttribute('aria-labelledby', 'sfn-title');
  const page = el('div', 'sfn-page');

  const title = el('h1', '', SCAFFOLD_NOTICE.title);
  title.id = 'sfn-title';
  title.tabIndex = -1;
  page.append(title, el('p', 'sfn-lead', SCAFFOLD_NOTICE.lead));

  for (const section of SCAFFOLD_NOTICE.sections) {
    const block = el('section');
    block.append(el('h2', '', section.heading), el('p', '', section.text));
    page.append(block);
  }

  const boxes = [];
  const confirm = el('fieldset', 'sfn-confirm');
  confirm.append(el('legend', 'sfn-legend', 'Check both to continue'));
  for (const item of SCAFFOLD_NOTICE.confirmations) {
    const label = el('label');
    const box = el('input');
    box.type = 'checkbox';
    box.name = item.id;
    boxes.push(box);
    label.append(box, el('span', '', item.text));
    confirm.append(label);
  }
  page.append(confirm);

  const assent = el('p', 'sfn-assent', `${SCAFFOLD_NOTICE.assent} `);
  const terms = el('a', '', SCAFFOLD_NOTICE.termsLabel);
  terms.href = SCAFFOLD_NOTICE.termsHref;
  terms.target = '_blank';
  terms.rel = 'noopener';
  assent.append(terms, '.');
  const error = el('p', 'sfn-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;

  const actions = el('div', 'sfn-actions');
  const cancel = el('button', 'sfn-cancel', SCAFFOLD_NOTICE.cancel);
  cancel.type = 'button';
  const agree = el('button', 'sfn-agree', SCAFFOLD_NOTICE.agree);
  agree.type = 'button';
  agree.disabled = true;
  actions.append(cancel, agree);
  page.append(assent, error, actions);
  dialog.append(page);
  document.body.append(dialog);

  const close = () => { if (dialog.open) dialog.close(); dialog.remove(); };
  const allTicked = () => boxes.every(b => b.checked);
  for (const box of boxes) box.addEventListener('change', () => { agree.disabled = !allTicked(); });

  cancel.addEventListener('click', () => { close(); onCancel(); });
  // Esc closes a dialog on its own; treat it as Cancel.
  dialog.addEventListener('cancel', e => { e.preventDefault(); close(); onCancel(); });
  agree.addEventListener('click', async () => {
    if (!allTicked()) return;
    agree.disabled = true;
    cancel.disabled = true;
    error.hidden = true;
    const result = await onAgree();
    if (result && result.error) {
      error.textContent = result.error;
      error.hidden = false;
      cancel.disabled = false;
      return; // stays up: there is nothing to agree to until the page is reloaded
    }
    close();
  });

  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  dialog.scrollTop = 0;
  title.focus();
}
