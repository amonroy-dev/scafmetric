// Local work-in-progress storage for the beam analysis and the scaffold builder.
//
// Saved in this browser and kept for RETENTION_DAYS; anything older than that
// is dropped on the next read. A signed-in visitor's work is also copied to
// their account (see "server sync" below), so it follows them to another
// device.

export const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const PREFIX = 'scafmetric:wip:';

export const KEYS = {
  beam: `${PREFIX}beam`,
  scaffold: `${PREFIX}scaffold`,
  // Saved camera views are UI state, kept beside the model under the same
  // retention window so a reopened session finds them again.
  views: `${PREFIX}views`,
};

export const RETENTION_NOTICE =
  `Your beam inputs and scaffold model are saved in this browser and with your account for ${RETENTION_DAYS} days.`;

function storage() {
  try {
    const s = window.localStorage;
    const probe = `${PREFIX}__probe`;
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null; // private mode / blocked storage
  }
}

export function save(key, data) {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(key, JSON.stringify({ savedAt: Date.now(), data }));
    return true;
  } catch {
    return false;
  }
}

/** Returns { data, savedAt } or null when missing, unreadable or expired. */
export function load(key) {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.savedAt !== 'number') { s.removeItem(key); return null; }
    if (Date.now() - parsed.savedAt > RETENTION_MS) { s.removeItem(key); return null; }
    return { data: parsed.data, savedAt: parsed.savedAt };
  } catch {
    return null;
  }
}

export function clear(key) {
  const s = storage();
  if (!s) return;
  try { s.removeItem(key); } catch { /* ignore */ }
}

/** Drop every expired Scafmetric entry. Safe to call on load. */
export function purgeExpired() {
  const s = storage();
  if (!s) return;
  try {
    for (const key of Object.keys(s)) {
      if (!key.startsWith(PREFIX)) continue;
      const raw = s.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > RETENTION_MS) {
          s.removeItem(key);
        }
      } catch {
        s.removeItem(key);
      }
    }
  } catch { /* ignore */ }
}

/** Debounce helper so we do not write on every keystroke. */
export function debounce(fn, ms = 400) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
}

export function formatSavedAt(savedAt) {
  if (!savedAt) return '';
  const mins = Math.round((Date.now() - savedAt) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

// --- server sync ------------------------------------------------------------
// When the visitor is signed in, work is also mirrored to their account so it
// survives a cleared browser or a different device. Local storage stays the
// fast path; the server is best-effort and never blocks the UI.

let serverAvailable = true;

export async function loadServerWorkspace() {
  if (!serverAvailable) return null;
  try {
    const res = await fetch('/api/workspace', { method: 'GET', cache: 'no-store', credentials: 'same-origin' });
    if ([401, 403, 404, 501].includes(res.status)) { serverAvailable = false; return null; }
    if (!res.ok) return null;
    const data = await res.json();
    return data?.workspace ?? null;
  } catch {
    return null;
  }
}

export async function saveServerWorkspace(patch) {
  if (!serverAvailable) return false;
  try {
    const res = await fetch('/api/workspace', {
      method: 'PUT',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if ([401, 403, 404, 501].includes(res.status)) { serverAvailable = false; return false; }
    return res.ok;
  } catch {
    return false;
  }
}

export async function clearServerWorkspace() {
  if (!serverAvailable) return false;
  try {
    const res = await fetch('/api/workspace', { method: 'DELETE', cache: 'no-store', credentials: 'same-origin' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Whichever copy is newer: the local one or the server one.
 *
 * `half` says which part is being compared, 'beam' or 'scaffold'. The account
 * keeps a time for each, because each is saved on its own: judged by the
 * record's one time, a beam saved a minute ago would make a week-old scaffold
 * on the account look newer than this morning's on this device.
 */
export function pickNewer(local, server, half = null) {
  const l = local?.savedAt ?? 0;
  const stamp = (half === 'beam' ? server?.beamUpdatedAt : half === 'scaffold' ? server?.scaffoldUpdatedAt : null) ?? server?.updatedAt;
  const s = stamp ? Date.parse(stamp) : 0;
  if (!l && !s) return null;
  return s > l ? { source: 'account', savedAt: s, data: server } : { source: 'device', savedAt: l, data: local?.data };
}
