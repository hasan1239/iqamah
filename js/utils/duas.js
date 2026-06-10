// Daily Dua utilities — loads the bundled dataset (data/duas.json) and picks
// a deterministic "dua of the day". Dependency-free so both the /dua view and
// the Home "Dua of the Day" card can import it.

const DATA_URL = '/data/duas.json';

// Day-index epoch (1 Jan 2026, per docs/daily-dua-hadith-spec.md §5).
const EPOCH_UTC = Date.UTC(2026, 0, 1);

const MS_PER_DAY = 86400000;

let cache = null;    // resolved dataset (array), kept for the session
let pending = null;  // in-flight fetch promise (dedupes concurrent callers)

/**
 * Load the full dua collection (cached after first load).
 * @returns {Promise<Array>} array of dua entries
 */
export function getAllDuas() {
  if (cache) return Promise.resolve(cache);
  if (!pending) {
    pending = fetch(DATA_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load duas: ${res.status}`);
        return res.json();
      })
      .then((data) => {
        cache = Array.isArray(data) ? data : [];
        return cache;
      })
      .catch((err) => {
        pending = null; // allow a retry on the next call
        throw err;
      });
  }
  return pending;
}

/**
 * Days elapsed since the epoch for the given date's LOCAL calendar day.
 * Using local date components (rather than raw Date.now()) means the dua
 * flips at local midnight, so it always matches the date the user sees —
 * still fully deterministic: every device shows the same dua on the same date.
 * @param {Date} [date]
 * @returns {number}
 */
export function dayIndex(date = new Date()) {
  const localMidnightUTC = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.floor((localMidnightUTC - EPOCH_UTC) / MS_PER_DAY);
}

/**
 * Deterministic "dua of the day" — day index modulo dataset length
 * (per spec: no randomness, no storage; same item everywhere on a given date).
 * @param {Date} [date] - defaults to today
 * @returns {Promise<Object|null>} today's dua entry, or null if dataset is empty
 */
export async function getTodayDua(date = new Date()) {
  const duas = await getAllDuas();
  if (!duas.length) return null;
  const idx = ((dayIndex(date) % duas.length) + duas.length) % duas.length;
  return duas[idx];
}
