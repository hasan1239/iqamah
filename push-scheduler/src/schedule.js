// Reminder schedule builder for the push-scheduler Worker.
//
// Ported from js/utils/prayer-schedule.js (client v0) — KEEP IN SYNC. The column
// mapping mirrors js/views/prayer-times.js. Difference vs the client version:
// here we resolve each reminder to a real UTC instant, treating CSV times as
// Europe/London wall-clock on the given date (DST handled per-date).

const HEADER_ALIASES = {
  'date': 'Date', 'day': 'Day', 'islamic_day': 'Islamic Day',
  'sehri_ends': 'Sehri Ends', 'fajr_start': 'Fajr Start',
  'sunrise': 'Sunrise', 'zawal': 'Zawal', 'zohr': 'Zohr', 'asr': 'Asr', 'esha': 'Esha',
  'fajr_jamaat': "Fajr Jama'at", 'zohar_jamaat': "Zohar Jama'at",
  'asr_jamaat': "Asr Jama'at", 'maghrib_iftari': 'Maghrib Iftari',
  'maghrib_jamaat': "Maghrib Jama'at", 'esha_jamaat': "Esha Jama'at",
};

export function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => {
    const t = h.trim();
    return HEADER_ALIASES[t] || t;
  });
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',').map(v => v.trim());
    const row = {};
    headers.forEach((h, j) => { row[h] = vals[j] || ''; });
    rows.push(row);
  }
  return rows;
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// CSV date → "YYYY-MM-DD" (ISO from providers, or "18 Feb" legacy → 2026).
function rowDateStr(row) {
  const s = (row['Date'] || '').trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const parts = s.split(/\s+/);
  if (parts.length < 2 || !(parts[1] in MONTHS)) return null;
  const d = parseInt(parts[0], 10);
  const mo = MONTHS[parts[1]] + 1;
  return `2026-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function rowForDate(rows, dateStr) {
  return rows.find(r => rowDateStr(r) === dateStr) || null;
}

// "H:MM" + AM hint → 24h {h, m}. Mirrors parseTimeToDate in the client.
function parseHHMM(timeStr, isAM) {
  const m = (timeStr || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mi = parseInt(m[2], 10);
  const already24h = h >= 13 || h === 0;
  if (!already24h) {
    if (!isAM && h !== 12) h += 12;
    if (isAM && h === 12) h = 0;
  }
  return { h, m: mi };
}

// Offset (ms) of a timezone from UTC at a given instant.
function tzOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  let hour = p.hour === '24' ? 0 : +p.hour;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second);
  return asUTC - date.getTime();
}

// Wall-clock components in `timeZone` → the UTC instant. Refines once for DST edges.
function wallClockToInstant(y, mo, d, h, mi, timeZone) {
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi);
  let offset = tzOffsetMs(new Date(utcGuess), timeZone);
  let instant = utcGuess - offset;
  offset = tzOffsetMs(new Date(instant), timeZone);
  return new Date(utcGuess - offset);
}

const PRAYERS = [
  { key: 'fajr', label: 'Fajr', isAM: true, startKeys: ['Fajr Start', 'Subha Sadiq', 'Sehri Ends'], startKeysRamadan: ['Sehri Ends'], jamaatKeys: ["Fajr Jama'at"], endKeys: ['Sunrise'], endIsAM: true },
  { key: 'dhuhr', label: 'Dhuhr', isAM: false, startKeys: ['Zohr'], jamaatKeys: ["Zohar Jama'at"], jamaatDefault: '1:00', endKeys: ['Asr'], endIsAM: false },
  { key: 'asr', label: 'Asr', isAM: false, startKeys: ['Asr'], jamaatKeys: ["Asr Jama'at"], endKeys: ['Maghrib Iftari'], endIsAM: false },
  { key: 'maghrib', label: 'Maghrib', isAM: false, startKeys: ['Maghrib Iftari'], jamaatKeys: ["Maghrib Jama'at", 'Maghrib Iftari'] },
  { key: 'esha', label: 'Esha', isAM: false, startKeys: ['Esha'], jamaatKeys: ["Esha Jama'at"] },
];

function firstVal(row, keys, fallback) {
  for (const k of keys) if (row[k] && row[k].trim()) return row[k].trim();
  return fallback || null;
}

/**
 * Resolve the day's reminders to UTC instants.
 * @returns [{prayer, kind, label, lead, timeStr, isAM, targetAt:Date, fireAt:Date}]
 *          sorted by fireAt, same-minute duplicates collapsed (Ramadan label wins).
 */
export function buildReminderInstants(row, prefs, season, dateStr, timeZone = 'Europe/London') {
  if (!row || !prefs || !prefs.master) return [];
  const isRamadan = season === 'ramadan';
  const [y, mo, d] = dateStr.split('-').map(n => parseInt(n, 10));
  const out = [];

  const add = (timeStr, isAM, lead, kind, prayer, label) => {
    const hm = parseHHMM(timeStr, isAM);
    if (!hm) return;
    const targetAt = wallClockToInstant(y, mo, d, hm.h, hm.m, timeZone);
    const fireAt = new Date(targetAt.getTime() - (lead || 0) * 60000);
    out.push({ prayer, kind, label, lead: lead || 0, timeStr, isAM: !!isAM, targetAt, fireAt });
  };

  for (const p of PRAYERS) {
    const pref = prefs.prayers && prefs.prayers[p.key];
    if (!pref) continue;
    if (pref.start && pref.start.on) {
      const keys = isRamadan && p.startKeysRamadan ? p.startKeysRamadan : p.startKeys;
      add(firstVal(row, keys), p.isAM, pref.start.lead, 'start', p.key, p.label);
    }
    if (pref.jamaat && pref.jamaat.on) {
      add(firstVal(row, p.jamaatKeys, p.jamaatDefault), p.isAM, pref.jamaat.lead, 'jamaat', p.key, p.label);
    }
    if (pref.end && pref.end.on && p.endKeys) {
      add(firstVal(row, p.endKeys), p.endIsAM, pref.end.lead, 'end', p.key, p.label);
    }
  }

  if (isRamadan && prefs.ramadanExtras) {
    const { suhoor, iftar } = prefs.ramadanExtras;
    if (suhoor && suhoor.on) add(firstVal(row, ['Sehri Ends']), true, suhoor.lead, 'suhoor', 'suhoor', 'Suhoor');
    if (iftar && iftar.on) add(firstVal(row, ['Maghrib Iftari']), false, iftar.lead, 'iftar', 'iftar', 'Iftar');
  }

  out.sort((a, b) => a.fireAt - b.fireAt);
  const seen = new Map();
  const RAMADAN_KINDS = new Set(['suhoor', 'iftar']);
  for (const r of out) {
    const minute = Math.floor(r.fireAt.getTime() / 60000);
    const ex = seen.get(minute);
    if (!ex) { seen.set(minute, r); continue; }
    if (RAMADAN_KINDS.has(r.kind) && !RAMADAN_KINDS.has(ex.kind)) seen.set(minute, r);
  }
  return Array.from(seen.values()).sort((a, b) => a.fireAt - b.fireAt);
}

// Notification copy — mirrors buildCopy in js/utils/notifications.js.
function formatTime(timeStr, isAM, use24h) {
  const m = (timeStr || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return timeStr || '';
  let h = parseInt(m[1], 10);
  const mi = m[2];
  const already24h = h >= 13 || h === 0;
  if (already24h) isAM = h < 12;
  if (use24h) {
    if (!already24h) { if (!isAM && h !== 12) h += 12; if (isAM && h === 12) h = 0; }
    return `${h}:${mi}`;
  }
  if (already24h) {
    const suffix = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${mi} ${suffix}`;
  }
  return `${h}:${mi} ${isAM ? 'AM' : 'PM'}`;
}

export function buildCopy(reminder, masjidName, use24h) {
  const { kind, label, lead } = reminder;
  const time = formatTime(reminder.timeStr, reminder.isAM, use24h);
  const tail = masjidName ? ` · ${masjidName}` : '';
  switch (kind) {
    case 'start': return { title: `${label} has begun`, body: `${time}${tail}` };
    case 'jamaat': return lead > 0
      ? { title: `${label} jama'at in ${lead} min`, body: `${time}${tail}` }
      : { title: `${label} jama'at now`, body: `${time}${tail}` };
    case 'end': return { title: `${label} ends in ${lead} min`, body: `Pray before ${time}${tail}` };
    case 'suhoor': return { title: `Suhoor ends in ${lead} min`, body: `${time}${tail}` };
    case 'iftar': return { title: 'Iftar — time to break your fast', body: `${time}${tail}` };
    default: return { title: label, body: `${time}${tail}` };
  }
}
