// Prayer reminder schedule builder — shared pure logic.
//
// Turns a parsed CSV "today" row + notification prefs into a list of concrete
// reminder instants for the day. Mirrors the column mapping in
// js/views/prayer-times.js (getNextPrayer / prayerRows / start times) so the
// notification times always match what the prayer-times view shows.
//
// This is the canonical builder: v0 (app-open scheduler) calls it client-side;
// the v1 server scheduler re-implements the same mapping (see
// docs/push-notifications-spec.md — keep them in sync).

// Prayer definitions: which CSV column feeds each kind, and AM/PM hint for
// 12h→24h disambiguation (matches COL_IS_AM in prayer-times.js).
// `start` lists fallback keys in priority order; ramadan Fajr start = Sehri Ends.
const PRAYERS = [
  {
    key: 'fajr', label: 'Fajr', isAM: true,
    startKeys: ['Fajr Start', 'Subha Sadiq', 'Sehri Ends'],
    startKeysRamadan: ['Sehri Ends'],
    jamaatKeys: ["Fajr Jama'at"],
    endKeys: ['Sunrise'], endIsAM: true,
  },
  {
    key: 'dhuhr', label: 'Dhuhr', isAM: false,
    startKeys: ['Zohr'],
    jamaatKeys: ["Zohar Jama'at"], jamaatDefault: '1:00',
    endKeys: ['Asr'], endIsAM: false,
  },
  {
    key: 'asr', label: 'Asr', isAM: false,
    startKeys: ['Asr'],
    jamaatKeys: ["Asr Jama'at"],
    endKeys: ['Maghrib Iftari'], endIsAM: false,
  },
  {
    key: 'maghrib', label: 'Maghrib', isAM: false,
    startKeys: ['Maghrib Iftari'],
    jamaatKeys: ["Maghrib Jama'at", 'Maghrib Iftari'],
    // no end reminder — pray ASAP
  },
  {
    key: 'esha', label: 'Esha', isAM: false,
    startKeys: ['Esha'],
    jamaatKeys: ["Esha Jama'at"],
    // no end reminder — no clean CSV end time
  },
];

// Parse "HH:MM" into a Date on the given reference day. Handles both 24h CSV
// values (mawaqit/mymasjid) and 12h-ish image-extraction values via isAM hint.
function parseTimeToDate(timeStr, isAM, refDate) {
  if (!timeStr) return null;
  const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  let hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  const already24h = hours >= 13 || hours === 0;
  if (!already24h) {
    if (!isAM && hours !== 12) hours += 12;
    if (isAM && hours === 12) hours = 0;
  }
  const d = new Date(refDate);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

// First non-empty value across a list of column keys.
function firstVal(row, keys, fallback) {
  for (const k of keys) {
    if (row[k] && row[k].trim()) return row[k].trim();
  }
  return fallback || null;
}

/**
 * Build the day's reminder instants from a CSV row and prefs.
 *
 * @param {object} todayRow  parsed CSV row (title-case keys, via csv.js parseCSV)
 * @param {object} prefs     notification prefs (see docs/push-notifications-spec.md §4)
 * @param {string} season    'ramadan' | 'eid' | 'default'
 * @param {Date}   refDate   day to compute for (defaults to now)
 * @returns {Array<{at:Date, targetAt:Date, kind:string, prayer:string, label:string, lead:number, timeStr:string}>}
 *          sorted ascending by `at`, same-minute duplicates collapsed.
 */
export function buildReminders(todayRow, prefs, season, refDate = new Date()) {
  if (!todayRow || !prefs || !prefs.master) return [];
  const isRamadan = season === 'ramadan';
  const out = [];

  const add = (timeStr, isAM, lead, kind, prayer, label) => {
    if (!timeStr) return;
    const targetAt = parseTimeToDate(timeStr, isAM, refDate);
    if (!targetAt) return;
    const at = new Date(targetAt.getTime() - (lead || 0) * 60000);
    out.push({ at, targetAt, kind, prayer, label, lead: lead || 0, timeStr, isAM: !!isAM });
  };

  for (const p of PRAYERS) {
    const pref = prefs.prayers && prefs.prayers[p.key];
    if (!pref) continue;

    if (pref.start && pref.start.on) {
      const keys = isRamadan && p.startKeysRamadan ? p.startKeysRamadan : p.startKeys;
      add(firstVal(todayRow, keys), p.isAM, pref.start.lead, 'start', p.key, p.label);
    }
    if (pref.jamaat && pref.jamaat.on) {
      add(firstVal(todayRow, p.jamaatKeys, p.jamaatDefault), p.isAM, pref.jamaat.lead, 'jamaat', p.key, p.label);
    }
    if (pref.end && pref.end.on && p.endKeys) {
      add(firstVal(todayRow, p.endKeys), p.endIsAM, pref.end.lead, 'end', p.key, p.label);
    }
  }

  // Ramadan extras only in ramadan season.
  if (isRamadan && prefs.ramadanExtras) {
    const suhoor = prefs.ramadanExtras.suhoor;
    const iftar = prefs.ramadanExtras.iftar;
    if (suhoor && suhoor.on) add(firstVal(todayRow, ['Sehri Ends']), true, suhoor.lead, 'suhoor', 'suhoor', 'Suhoor');
    if (iftar && iftar.on) add(firstVal(todayRow, ['Maghrib Iftari']), false, iftar.lead, 'iftar', 'iftar', 'Iftar');
  }

  out.sort((a, b) => a.at - b.at);

  // Collapse reminders that land on the same minute for the same device,
  // preferring the Ramadan-specific label (suhoor/iftar) — see spec §8.
  const seen = new Map();
  const RAMADAN_KINDS = new Set(['suhoor', 'iftar']);
  for (const r of out) {
    const minute = Math.floor(r.at.getTime() / 60000);
    const existing = seen.get(minute);
    if (!existing) { seen.set(minute, r); continue; }
    if (RAMADAN_KINDS.has(r.kind) && !RAMADAN_KINDS.has(existing.kind)) seen.set(minute, r);
  }
  return Array.from(seen.values()).sort((a, b) => a.at - b.at);
}
