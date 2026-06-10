// Follow Multiple Masjids — followed set + primary helpers
//
// localStorage keys:
//   iqamah-followed-masjids : JSON array of slugs (ordered, max FOLLOW_CAP)
//   iqamah-pinned-masjid    : the primary ("My Masjid") slug — unchanged key so
//                             the hero card, Times tab and existing
//                             iqamah-pin-changed listeners keep working.
//
// Invariants (enforced here):
//   - pinned ∈ followed (self-healed on read — the primary can be written
//     outside this module, e.g. the prayer-times page's "Set as My Masjid"
//     button writes the pinned key directly)
//   - no duplicates, cap at FOLLOW_CAP
//   - first follow auto-becomes primary
//   - unfollowing the primary auto-promotes the next followed masjid
//
// Events: every mutation dispatches BOTH `iqamah-follow-changed` (new) and
// `iqamah-pin-changed` (kept for back-compat) so every view re-renders
// consistently.

export const FOLLOW_CAP = 5;

const FOLLOWED_KEY = 'iqamah-followed-masjids';
const PRIMARY_KEY = 'iqamah-pinned-masjid';

function readFollowedRaw() {
  try {
    const raw = JSON.parse(localStorage.getItem(FOLLOWED_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter(s => typeof s === 'string' && s);
  } catch {
    return [];
  }
}

function writeFollowed(list) {
  try { localStorage.setItem(FOLLOWED_KEY, JSON.stringify(list)); } catch { /* ignore */ }
}

function readPrimary() {
  return localStorage.getItem(PRIMARY_KEY) || null;
}

function writePrimary(slug) {
  if (slug) localStorage.setItem(PRIMARY_KEY, slug);
  else localStorage.removeItem(PRIMARY_KEY);
}

// Read both keys and silently repair invariants (dedupe, pinned ∈ followed,
// cap). Never creates the followed key for a fresh user with nothing stored.
function normalise() {
  const raw = readFollowedRaw();
  const primary = readPrimary();

  const seen = new Set();
  let list = [];
  for (const s of raw) {
    if (!seen.has(s)) { seen.add(s); list.push(s); }
  }
  // pinned ∈ followed — prepend so it can never be dropped by the cap below
  if (primary && !seen.has(primary)) list.unshift(primary);
  if (list.length > FOLLOW_CAP) list = list.slice(0, FOLLOW_CAP);

  const changed = list.length !== raw.length || list.some((s, i) => s !== raw[i]);
  if (changed && (list.length > 0 || localStorage.getItem(FOLLOWED_KEY) !== null)) {
    writeFollowed(list);
  }
  return { followed: list, primary };
}

function dispatchChanged() {
  const detail = { followed: normalise().followed, primary: readPrimary() };
  window.dispatchEvent(new CustomEvent('iqamah-follow-changed', { detail }));
  window.dispatchEvent(new CustomEvent('iqamah-pin-changed'));
}

/** Ordered list of followed slugs (invariants repaired on read). */
export function getFollowed() {
  return normalise().followed;
}

/** Is this slug in the followed set? */
export function isFollowed(slug) {
  return getFollowed().includes(slug);
}

/** The primary ("My Masjid") slug, or null. */
export function getPrimary() {
  return readPrimary();
}

/**
 * Follow a masjid.
 * Returns { ok, reason?, becamePrimary }.
 *   ok=false, reason='cap'   → cap reached, blocked
 *   ok=true,  reason='already' → no-op, already followed
 *   becamePrimary=true       → this was the first follow, auto-promoted
 */
export function follow(slug) {
  if (!slug) return { ok: false, reason: 'invalid', becamePrimary: false };
  const { followed, primary } = normalise();
  if (followed.includes(slug)) return { ok: true, reason: 'already', becamePrimary: false };
  if (followed.length >= FOLLOW_CAP) return { ok: false, reason: 'cap', becamePrimary: false };

  followed.push(slug);
  writeFollowed(followed);

  let becamePrimary = false;
  if (!primary) {
    writePrimary(slug); // first follow auto-becomes primary
    becamePrimary = true;
  }
  dispatchChanged();
  return { ok: true, becamePrimary };
}

/**
 * Unfollow a masjid. If it was the primary, the next followed masjid is
 * auto-promoted (or the primary is cleared if none remain).
 * Returns { ok, removed, removedPrimary, newPrimary }.
 */
export function unfollow(slug) {
  const { followed, primary } = normalise();
  const idx = followed.indexOf(slug);
  if (idx === -1) return { ok: true, removed: false, removedPrimary: false, newPrimary: primary };

  followed.splice(idx, 1);
  writeFollowed(followed);

  let removedPrimary = false;
  let newPrimary = primary;
  if (primary === slug) {
    removedPrimary = true;
    newPrimary = followed[0] || null; // auto-promote next followed
    writePrimary(newPrimary);
  }
  dispatchChanged();
  return { ok: true, removed: true, removedPrimary, newPrimary };
}

/**
 * Follow if not followed, unfollow if followed.
 * Returns the underlying follow()/unfollow() result plus
 * action: 'followed' | 'unfollowed' | 'blocked'.
 */
export function toggleFollow(slug) {
  if (isFollowed(slug)) {
    const r = unfollow(slug);
    return { ...r, action: 'unfollowed' };
  }
  const r = follow(slug);
  return { ...r, action: r.ok ? 'followed' : 'blocked' };
}

/**
 * Set the primary ("My Masjid"). Follows the masjid first if needed
 * (respecting the cap).
 * Returns { ok, reason?, changed, followedAdded }.
 */
export function setPrimary(slug) {
  if (!slug) return { ok: false, reason: 'invalid', changed: false, followedAdded: false };
  const { followed, primary } = normalise();

  let followedAdded = false;
  if (!followed.includes(slug)) {
    if (followed.length >= FOLLOW_CAP) return { ok: false, reason: 'cap', changed: false, followedAdded: false };
    followed.push(slug);
    writeFollowed(followed);
    followedAdded = true;
  }
  if (primary === slug && !followedAdded) {
    return { ok: true, changed: false, followedAdded: false };
  }
  writePrimary(slug);
  dispatchChanged();
  return { ok: true, changed: true, followedAdded };
}
