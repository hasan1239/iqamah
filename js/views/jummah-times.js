// Jummah Times view - all masjids with Friday jama'at times, grouped by city.
// Mirrors the /eid page card pattern (js/views/eid-times.js): parse the free-text
// jummah_times field into pills, plus a lazy CSV fallback (upcoming Friday's
// Dhuhr/Zohar jama'at) for masjids whose jummah_times is missing, unparseable,
// or contains only lecture/bayan times - per docs/jummah-times-spec.md.
//
// The parser classifies each time in a labelled string by its nearest label word
// so lecture/bayan/khutbah times are never shown as if they were jama'at times.
// Cities come from deriveCity (js/utils/cities.js), the same rollup the Masjids
// view uses (e.g. B-postcodes group under Birmingham).

import { parseCSV, parseDate } from '../utils/csv.js';
import { loadMasjidIndex } from '../utils/masjid-index.js';
import { deriveCity, getCityPostcode, OTHER_CITY } from '../utils/cities.js';

// How many CSV fallback fetches run at once (don't block initial paint; be kind to the network)
const FALLBACK_CONCURRENCY = 6;

let loadGeneration = 0;
let viewContainer = null;

// --- Parsing ---

function formatMinutes(mins) {
  const h24 = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const ampm = h24 >= 12 ? 'pm' : 'am';
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}

// Label classification keyword sets. Matching runs on a normalised string
// (lowercased, diacritics stripped, apostrophes removed), so "Bayān" matches
// "bayan" and "Jama'at" matches "jamaat".
//
// Lecture-ish: the talk before the salah. The khutbah/sermon counts as
// lecture-ish here because a jama'at-ish label is what marks the actual
// prayer time; "sermon" and "adhan" were added after auditing the real
// jummah_times values in data/mosques/*.json.
const LECTURE_RE = /\b(bayaan|bayan|lectures?|speech(?:es)?|talks?|dars|naseehah?|nasihah?|khutbahs?|khutbas?|kutbahs?|kutbas?|sermons?)\b/g;
// Jama'at-ish: the congregational prayer itself. Includes jummah/jumuah
// variants so "1st Jumu'ah: 1:30pm" is kept as a prayer time.
const JAMAAT_RE = /\b(jamaats?|jamats?|jamaahs?|jamahs?|salaah|salah|salaat|salat|namaaz|namaz|prayers?|iqaamah|iqamahs?|iqama|jumuahs?|jummahs?|jummas?|jumahs?|jumua|juma)\b/g;
// Adhan: not a lecture, but not the jama'at either - never shown as a pill
// and excluded from the bayan-note arithmetic.
const ADHAN_RE = /\b(adhaan|adhan|azaan|azan|athan)\b/g;

function normaliseLabelText(str) {
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’ʻʼ'`]/g, '');
}

function findKeywords(norm) {
  const keywords = [];
  const sets = [['lecture', LECTURE_RE], ['jamaat', JAMAAT_RE], ['other', ADHAN_RE]];
  for (const [cat, re] of sets) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(norm)) !== null) keywords.push({ index: m.index, cat });
  }
  keywords.sort((a, b) => a.index - b.index);
  return keywords;
}

// Same time grammar as before: "13:30", "1:05", "1pm", "1:30pm". Bare times are
// interpreted in Jummah (Dhuhr) context - PM unless already 24-hour - mirroring
// parseTimeTodayWithAMPM in prayer-times.js.
function extractTimeMatches(norm) {
  const regex = /(\d{1,2}):(\d{2})\s*(am|pm)?|(\d{1,2})\s*(am|pm)/gi;
  const found = [];
  let match;
  while ((match = regex.exec(norm)) !== null) {
    let h, m, ap;
    if (match[1] !== undefined) {
      h = Number(match[1]);
      m = Number(match[2]);
      ap = match[3] ? match[3].toLowerCase() : null;
    } else {
      h = Number(match[4]);
      m = 0;
      ap = match[5].toLowerCase();
    }
    if (h > 23 || m > 59) continue;
    if (ap === 'pm' && h < 12) h += 12;
    else if (ap === 'am' && h === 12) h = 0;
    else if (!ap && h < 12) h += 12; // bare time, Jummah context, so PM unless already 24h
    found.push({ minutes: h * 60 + m, index: match.index });
  }
  return found;
}

function uniqSorted(arr) {
  return [...new Set(arr)].sort((a, b) => a - b);
}

// Classify every time in the string by its nearest label word (nearest
// preceding keyword wins; if none precedes, the first following one is used).
// Strings with no label words at all are bare lists: every time is a jama'at.
// Exported for audits/tests.
export function classifyJummahTimes(str) {
  const norm = normaliseLabelText(str || '');
  const keywords = findKeywords(norm);
  const found = extractTimeMatches(norm);
  const cats = { jamaat: [], lecture: [], other: [] };
  for (const t of found) {
    if (keywords.length === 0) { cats.jamaat.push(t.minutes); continue; }
    let chosen = null;
    for (const k of keywords) {
      if (k.index < t.index) chosen = k;
      else break;
    }
    if (!chosen) chosen = keywords.find(k => k.index > t.index) || null;
    cats[chosen ? chosen.cat : 'jamaat'].push(t.minutes);
  }
  return {
    jamaat: uniqSorted(cats.jamaat),
    lecture: uniqSorted(cats.lecture),
    other: uniqSorted(cats.other),
    hasKeywords: keywords.length > 0,
    timeCount: found.length,
    norm,
  };
}

// Which word the note should lead with: "Bayan" when a pre-khutbah talk word
// appears, "Khutbah" when the only lecture-ish wording is the sermon itself.
function lectureWord(norm) {
  if (/\b(bayaan|bayan|lectures?|speech(?:es)?|talks?|dars|naseehah?|nasihah?)\b/.test(norm)) return 'Bayan';
  if (/\b(khutbahs?|khutbas?|kutbahs?|kutbas?|sermons?)\b/.test(norm)) return 'Khutbah';
  return 'Bayan';
}

// Per-masjid note under the pills.
// - Both a lecture and a jama'at time parsed: "Bayan {N} mins before jama'at",
//   only when 0 < N <= 90 and the offset is unambiguous (a single lecture time,
//   or a consistent lecture/jama'at offset).
// - No jama'at time but a "N minutes before" phrase (prose like "Khutbah begins
//   about 30 minutes before the Jama'ah"): "Khutbah approx {N} mins before
//   jama'at" - the time itself comes from the CSV fallback.
function buildNote(cls) {
  const { jamaat, lecture, norm } = cls;
  if (jamaat.length > 0 && lecture.length > 0) {
    let offset = null;
    if (lecture.length === 1) {
      offset = jamaat[0] - lecture[0];
    } else if (lecture.length === jamaat.length) {
      const diffs = lecture.map((l, i) => jamaat[i] - l);
      if (diffs.every(d => d === diffs[0])) offset = diffs[0];
    }
    if (offset != null && offset > 0 && offset <= 90) {
      return `${lectureWord(norm)} ${offset} mins before jama'at`;
    }
    return '';
  }
  if (jamaat.length === 0) {
    const m = norm.match(/(\d{1,3})\s*min(?:ute)?s?\s+before/);
    if (m) {
      const n = Number(m[1]);
      if (n > 0 && n <= 90) return `${lectureWord(norm)} approx ${n} mins before jama'at`;
    }
  }
  return '';
}

// Jama'at-classified times only. Lecture-only strings come back with no times,
// which routes them down the existing CSV fallback path. Exported for audits.
export function parseJummahTimes(str) {
  if (!str) return { times: [], earliest: Infinity, raw: '', note: '' };
  const cls = classifyJummahTimes(str);
  const times = cls.jamaat.map(mins => ({ label: formatMinutes(mins), minutes: mins }));
  return {
    times,
    earliest: times.length > 0 ? times[0].minutes : Infinity,
    raw: str,
    note: buildNote(cls),
  };
}

// --- Helpers ---

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// --- CSV fallback: upcoming Friday's Dhuhr (Zohar) jama'at ---

function getFridayRow(csvData) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const offset = (5 - today.getDay() + 7) % 7; // 0 when today is Friday
  const friday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
  for (const row of csvData) {
    const dateStr = row['Date'] || row['date'] || '';
    const d = parseDate(dateStr);
    if (d && d.getTime() === friday.getTime()) return row;
  }
  return null;
}

// Run worker(item) over items with a small concurrency cap
async function runQueue(items, worker, concurrency) {
  let i = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      await worker(item);
    }
  });
  await Promise.all(lanes);
}

// --- Rendering ---

function getRoot() {
  return (viewContainer && viewContainer.isConnected) ? viewContainer : document;
}

function pillsHtml(times) {
  return times.map(t => `<span class="jummah-time-pill">${t.label}</span>`).join('');
}

function cardHtml(entry) {
  const c = entry.config;
  const addr = c.address
    ? `<div class="jummah-card-address">${escapeHtml(getCityPostcode(c.address))}</div>` : '';

  let body;
  if (entry.parsed.times.length > 0) {
    body = `<div class="jummah-card-pills" data-jummah-pills="${c.slug}">${pillsHtml(entry.parsed.times)}</div>`;
  } else {
    // Awaiting CSV fallback - small skeleton pill, filled in (or replaced) as CSVs resolve
    body = `<div class="jummah-card-pills" data-jummah-pills="${c.slug}"><span class="skeleton-bone jummah-pill-skeleton"></span></div>`;
  }

  // Bayan/khutbah offset note (e.g. "Bayan 30 mins before jama'at")
  const note = entry.parsed.note
    ? `<div class="jummah-card-note">${escapeHtml(entry.parsed.note)}</div>` : '';

  // Raw label adds value only when it says more than the times themselves
  // (e.g. "Urdu khutbah at 1:15pm" - not a bare "13:30, 14:00")
  const raw = entry.parsed.raw && /[a-z]/i.test(entry.parsed.raw)
    ? `<div class="jummah-card-raw">${escapeHtml(entry.parsed.raw)}</div>` : '';

  return `
    <a href="/${c.slug}" class="jummah-card" data-link data-slug="${c.slug}">
      <div class="jummah-card-content">
        <div class="jummah-card-name">${escapeHtml(c.display_name)}</div>
        ${addr}
        ${body}
        ${note}
        ${raw}
      </div>
    </a>`;
}

// --- City grouping ---

function sortEntries(a, b) {
  return (a.parsed.earliest - b.parsed.earliest) ||
    String(a.config.display_name).localeCompare(String(b.config.display_name));
}

// City groups alphabetical with "Other" last; entries earliest-first within each.
function buildGroups(entries) {
  const byCity = new Map();
  for (const e of entries) {
    if (!byCity.has(e.city)) byCity.set(e.city, []);
    byCity.get(e.city).push(e);
  }
  const cities = [...byCity.keys()].sort((a, b) => {
    if (a === OTHER_CITY && b !== OTHER_CITY) return 1;
    if (b === OTHER_CITY && a !== OTHER_CITY) return -1;
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  });
  return cities.map(city => ({ city, entries: byCity.get(city).sort(sortEntries) }));
}

function groupHtml(group) {
  const n = group.entries.length;
  return `
    <section class="jummah-city-group" data-city-group="${escapeHtml(group.city)}">
      <h2 class="jummah-city-header">
        <span class="jummah-city-header-name">${escapeHtml(group.city)}</span>
        <span class="jummah-city-header-count">${n} masjid${n === 1 ? '' : 's'}</span>
      </h2>
      <div class="jummah-city-cards">${group.entries.map(cardHtml).join('')}</div>
    </section>`;
}

// Re-sort cards inside each city group (CSV fallbacks resolve after first paint,
// so a masjid's earliest time can change; its city never does).
function reorderCards(entries) {
  const root = getRoot();
  const byCity = new Map();
  for (const e of entries) {
    if (!byCity.has(e.city)) byCity.set(e.city, []);
    byCity.get(e.city).push(e);
  }
  root.querySelectorAll('.jummah-city-group').forEach(section => {
    const list = byCity.get(section.dataset.cityGroup);
    const cardsEl = section.querySelector('.jummah-city-cards');
    if (!list || !cardsEl) return;
    for (const entry of list.sort(sortEntries)) {
      const card = cardsEl.querySelector(`[data-slug="${entry.config.slug}"]`);
      if (card) cardsEl.appendChild(card);
    }
  });
}

async function loadFallbacks(entries, gen) {
  const pending = entries.filter(e => e.parsed.times.length === 0);
  if (pending.length === 0) return;

  await runQueue(pending, async (entry) => {
    if (gen !== loadGeneration) return;
    const c = entry.config;
    let resolved = null;
    try {
      const csvFile = c.csv || c.slug + '.csv';
      const res = await fetch(`/data/${csvFile}`);
      if (gen !== loadGeneration) return;
      if (res.ok) {
        const text = await res.text();
        if (gen !== loadGeneration) return;
        const fridayRow = getFridayRow(parseCSV(text));
        if (fridayRow) {
          // On Fridays the Jummah jama'at is the Friday Dhuhr jama'at.
          // Default '1:00' matches prayer-times.js / home.js Dhuhr handling.
          const timeStr = fridayRow["Zohar Jama'at"] || '1:00';
          const parsed = parseJummahTimes(timeStr);
          if (parsed.times.length > 0) resolved = parsed;
        }
      }
    } catch {
      // fall through - treated as unresolved
    }
    if (gen !== loadGeneration) return;

    const pillsEl = getRoot().querySelector(`[data-jummah-pills="${c.slug}"]`);
    if (resolved) {
      entry.parsed.times = resolved.times;
      entry.parsed.earliest = resolved.earliest;
      if (pillsEl) {
        pillsEl.innerHTML = pillsHtml(resolved.times) +
          `<span class="jummah-card-hint">Friday Dhuhr jama'at</span>`;
      }
    } else if (pillsEl) {
      pillsEl.innerHTML = `<span class="jummah-card-none">See masjid info</span>`;
    }
  }, FALLBACK_CONCURRENCY);

  // Re-sort each city group once, after all CSVs have landed (avoids cards
  // jumping repeatedly). Resolved masjids slot into their group's time order.
  if (gen === loadGeneration) reorderCards(entries);
}

export async function render(container) {
  const gen = ++loadGeneration;
  viewContainer = container;

  container.innerHTML = `
    <div class="jummah-view">
      <header class="jummah-header">
        <h1>Jummah Times</h1>
        <p class="jummah-subtitle">Friday jama'at times by city, earliest first</p>
        <p class="jummah-hint">See masjid info for full details</p>
      </header>
      <div class="jummah-loading">
        <div class="skeleton-bone" style="width:100%;height:80px;border-radius:14px;margin-bottom:12px"></div>
        <div class="skeleton-bone" style="width:100%;height:80px;border-radius:14px;margin-bottom:12px"></div>
        <div class="skeleton-bone" style="width:100%;height:80px;border-radius:14px"></div>
      </div>
    </div>`;

  try {
    const configs = await loadMasjidIndex();
    if (gen !== loadGeneration) return;

    // Exclude test masjids + quality-flagged ones (same gate as eid-times.js).
    // Unlike /eid we keep masjids without the config field - the CSV fallback covers them.
    const entries = configs
      .filter(c =>
        !c.test_masjid &&
        !c.hidden &&
        !(c.quality && c.quality.status === 'needs_review')
      )
      .map(c => ({
        config: c,
        city: deriveCity(c),
        parsed: parseJummahTimes(c.jummah_times),
      }));

    const root = getRoot();
    const loadingEl = root.querySelector('.jummah-loading');
    if (!loadingEl) return;

    if (entries.length === 0) {
      loadingEl.innerHTML = `<div class="jummah-empty">No Jummah times available yet.</div>`;
      return;
    }

    // Paint immediately from configs - CSV fallbacks fill in lazily afterwards
    const groups = buildGroups(entries);
    loadingEl.className = 'jummah-list';
    loadingEl.innerHTML = groups.map(groupHtml).join('');

    const viewEl = root.querySelector('.jummah-view');
    if (viewEl) {
      viewEl.insertAdjacentHTML('beforeend', `
        <div class="jummah-footer">
          Showing ${entries.length} masjid${entries.length === 1 ? '' : 's'} &middot;
          Don't see yours? <a href="/add" data-link>Add it</a>
        </div>`);
    }

    loadFallbacks(entries, gen);
  } catch (err) {
    console.error('Error loading jummah times:', err);
  }
}

export function destroy() {
  loadGeneration++;
  viewContainer = null;
}
