// My Masjid + Other Masjids — two distinct saved-masjid concepts.
//
//   My Masjid     — the single local masjid the user attends regularly.
//                   localStorage key iqamah-pinned-masjid (unchanged so the
//                   hero card, nav and existing iqamah-pin-changed listeners
//                   keep working; the prayer-times page's "Set as My Masjid"
//                   button writes this key directly).
//   Other Masjids — a separate saved list (work masjid, occasional ones).
//                   localStorage key iqamah-followed-masjids (kept from the
//                   old follow model) but it now EXCLUDES the pinned slug.
//                   Ordered, capped at OTHERS_CAP.
//
// Invariants (self-healed on read, which also migrates old-model users who
// had the pinned masjid inside the followed array):
//   - the My Masjid slug is stripped from the others list
//   - no duplicates, cap at OTHERS_CAP
//
// Promotion swap: setMyMasjid() on a saved other masjid removes it from the
// others list and moves the old My Masjid into Other Masjids, so nothing is
// lost. If others are somehow at cap during the swap, the oldest other is
// dropped. Setting an unsaved masjid simply replaces the old My Masjid
// (original star semantics — nothing is auto-saved).
//
// Events: every mutation dispatches BOTH `iqamah-follow-changed` (carries
// { myMasjid, others } detail) and `iqamah-pin-changed` (kept for back-compat)
// so every view re-renders consistently.

export const OTHERS_CAP = 5;

const OTHERS_KEY = 'iqamah-followed-masjids';
const MY_KEY = 'iqamah-pinned-masjid';

function readOthersRaw() {
  try {
    const raw = JSON.parse(localStorage.getItem(OTHERS_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter(s => typeof s === 'string' && s);
  } catch {
    return [];
  }
}

function writeOthers(list) {
  try { localStorage.setItem(OTHERS_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

function readMy() {
  return localStorage.getItem(MY_KEY) || null;
}

function writeMy(slug) {
  if (slug) localStorage.setItem(MY_KEY, slug);
  else localStorage.removeItem(MY_KEY);
}

// Read both keys and silently repair invariants (dedupe, strip the My Masjid
// slug, cap). Never creates the others key for a fresh user with nothing
// stored.
function normalise() {
  const raw = readOthersRaw();
  const my = readMy();

  const seen = new Set();
  let others = [];
  for (const s of raw) {
    if (s !== my && !seen.has(s)) { seen.add(s); others.push(s); }
  }
  if (others.length > OTHERS_CAP) others = others.slice(0, OTHERS_CAP);

  const changed = others.length !== raw.length || others.some((s, i) => s !== raw[i]);
  if (changed && (others.length > 0 || localStorage.getItem(OTHERS_KEY) !== null)) {
    writeOthers(others);
  }
  return { others, my };
}

function dispatchChanged() {
  const { others, my } = normalise();
  window.dispatchEvent(new CustomEvent('iqamah-follow-changed', { detail: { myMasjid: my, others } }));
  window.dispatchEvent(new CustomEvent('iqamah-pin-changed'));
}

/** The My Masjid slug, or null. */
export function getMyMasjid() {
  return readMy();
}

/** Ordered list of Other Masjid slugs (invariants repaired on read). */
export function getOthers() {
  return normalise().others;
}

/** Is this slug saved in Other Masjids? */
export function isOther(slug) {
  return getOthers().includes(slug);
}

/**
 * Set My Masjid. If the slug was saved in Other Masjids it is promoted: it
 * leaves the others list and the old My Masjid takes its place there (oldest
 * other dropped if the list is somehow at cap). Setting an unsaved masjid
 * simply replaces the old My Masjid.
 * Returns { ok, reason?, changed, demoted } — demoted is the old My Masjid
 * slug when it was moved into Other Masjids, else null.
 */
export function setMyMasjid(slug) {
  if (!slug) return { ok: false, reason: 'invalid', changed: false, demoted: null };
  const { others, my } = normalise();
  if (my === slug) return { ok: true, changed: false, demoted: null };

  let demoted = null;
  const idx = others.indexOf(slug);
  if (idx !== -1) {
    others.splice(idx, 1);
    if (my) {
      others.push(my);
      demoted = my;
      while (others.length > OTHERS_CAP) others.shift(); // defensive: drop oldest
    }
    writeOthers(others);
  }
  writeMy(slug);
  dispatchChanged();
  return { ok: true, changed: true, demoted };
}

/**
 * Unset My Masjid. No auto-promotion from Other Masjids.
 * Returns { ok, changed, cleared } — cleared is the slug that was unset.
 */
export function clearMyMasjid() {
  const my = readMy();
  if (!my) return { ok: true, changed: false, cleared: null };
  writeMy(null);
  dispatchChanged();
  return { ok: true, changed: true, cleared: my };
}

/**
 * Save a masjid to Other Masjids.
 * Returns { ok, reason? }.
 *   ok=false, reason='cap'          → cap reached, blocked
 *   ok=false, reason='is_my_masjid' → slug is the current My Masjid, blocked
 *   ok=true,  reason='already'      → no-op, already saved
 */
export function saveOther(slug) {
  if (!slug) return { ok: false, reason: 'invalid' };
  const { others, my } = normalise();
  if (slug === my) return { ok: false, reason: 'is_my_masjid' };
  if (others.includes(slug)) return { ok: true, reason: 'already' };
  if (others.length >= OTHERS_CAP) return { ok: false, reason: 'cap' };
  others.push(slug);
  writeOthers(others);
  dispatchChanged();
  return { ok: true };
}

/**
 * Remove a masjid from Other Masjids.
 * Returns { ok, removed }.
 */
export function removeOther(slug) {
  const { others } = normalise();
  const idx = others.indexOf(slug);
  if (idx === -1) return { ok: true, removed: false };
  others.splice(idx, 1);
  writeOthers(others);
  dispatchChanged();
  return { ok: true, removed: true };
}

/**
 * Save if not saved, remove if saved.
 * Returns the underlying saveOther()/removeOther() result plus
 * action: 'saved' | 'removed' | 'blocked'.
 */
export function toggleOther(slug) {
  if (isOther(slug)) {
    const r = removeOther(slug);
    return { ...r, action: 'removed' };
  }
  const r = saveOther(slug);
  return { ...r, action: r.ok ? 'saved' : 'blocked' };
}
