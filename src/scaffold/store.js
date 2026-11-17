// Local work-in-progress storage for the beam analysis and the scaffold builder.
//
// Saved in this browser only, and kept for RETENTION_DAYS. Nothing is uploaded;
// anything older than the retention window is dropped on the next read.

export const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const PREFIX = 'scafmetric:wip:';

export const KEYS = {
  beam: `${PREFIX}beam`,
  scaffold: `${PREFIX}scaffold`,
};

export const RETENTION_NOTICE =
  `Your beam inputs and scaffold model are saved in this browser for ${RETENTION_DAYS} days.`;

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
