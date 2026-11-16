// Pending submissions live only in this page's memory; no project information
// is put into browser storage. Retries preserve IDs and save in submission order.
export function createProjectSaver({ status, message, retry, signIn, request = fetch, newId = () => crypto.randomUUID() }) {
  const pending = [];
  let running = false;
  function show(text, { retryable = false, login = false } = {}) {
    status.hidden = false;
    message.textContent = text;
    retry.hidden = !retryable;
    signIn.hidden = !login;
  }
  function count() { return `${pending.length} ${pending.length === 1 ? 'project is' : 'projects are'}`; }
  async function save() {
    if (running || !pending.length) return;
    running = true;
    show('Saving project details…');
    while (pending.length) {
      let response;
      try {
        response = await request('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending[0]) });
      } catch { response = null; }
      if (!response?.ok) {
        running = false;
        const temporary = 'Unsaved details are kept only while this page stays open.';
        if (response?.status === 401) show(`${count()} not saved. Sign in, return here, and retry. ${temporary}`, { retryable: true, login: true });
        else if (response?.status === 403) show(`${count()} not saved. Complete your account details and accept the current terms, then return here and retry. ${temporary}`, { retryable: true, login: true });
        else show(`${count()} not saved. Please retry. ${temporary}`, { retryable: true });
        return;
      }
      pending.shift();
    }
    running = false;
    show('Project details saved.');
  }
  retry.addEventListener('click', save);
  return {
    capture(project, preparer) {
      try { pending.push({ project: project.trim(), preparer: preparer.trim(), submissionId: newId() }); }
      catch { show('Project details for this analysis could not be queued in this browser.' + (pending.length ? ` ${count()} not saved; retry before closing this page.` : ''), { retryable: pending.length > 0 }); return; }
      void save();
    }
  };
}
