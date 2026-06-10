// Jummah Times view — list all masjids with Friday jama'at times, sorted by earliest.
// Mirrors the /eid page pattern (js/views/eid-times.js): parse free-text times field
// → pills → sort by earliest. Adds a lazy CSV fallback (upcoming Friday's Dhuhr/Zohar
// jama'at) for masjids whose jummah_times is missing or unparseable — per
// docs/jummah-times-spec.md.

import { parseCSV, parseDate } from '../utils/csv.js';

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

// Same approach as parseEidTimes (js/views/eid-times.js), extended for the formats
// jummah_times actually contains: most provider configs store bare 24-hour times
// ("13:30, 14:00") with no am/pm marker, and a few store bare 12-hour times
// ("Jumu'ah Jamat 1:05"). Bare times are interpreted in Jummah (Dhuhr) context —
// PM unless already 24-hour — mirroring parseTimeTodayWithAMPM in prayer-times.js.
function parseJummahTimes(str) {
  if (!str) return { times: [], earliest: Infinity, raw: '' };
  const regex = /(\d{1,2}):(\d{2})\s*(am|pm)?|(\d{1,2})\s*(am|pm)/gi;
  const seen = new Set();
  const times = [];
  let match;
  while ((match = regex.exec(str)) !== null) {
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
    else if (!ap && h < 12) h += 12; // bare time, Jummah context → PM unless already 24h
    const minutes = h * 60 + m;
    if (seen.has(minutes)) continue;
    seen.add(minutes);
    times.push({ label: formatMinutes(minutes), minutes });
  }
  times.sort((a, b) => a.minutes - b.minutes);
  return { times, earliest: times.length > 0 ? times[0].minutes : Infinity, raw: str };
}

// --- Helpers (same shapes as eid-times.js) ---

function getCityPostcode(address) {
  if (!address) return '';
  const pcMatch = address.match(/[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/i);
  if (!pcMatch) return address.split(',').pop().trim();
  const before = address.slice(0, pcMatch.index).replace(/,\s*$/, '');
  const parts = before.split(',').map(s => s.trim()).filter(Boolean);
  const city = parts.length > 0 ? parts[parts.length - 1] : '';
  return city ? `${city}, ${pcMatch[0]}` : pcMatch[0];
}

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
    // Awaiting CSV fallback — small skeleton pill, filled in (or replaced) as CSVs resolve
    body = `<div class="jummah-card-pills" data-jummah-pills="${c.slug}"><span class="skeleton-bone jummah-pill-skeleton"></span></div>`;
  }

  // Raw label adds value only when it says more than the times themselves
  // (e.g. "Urdu khutbah at 1:15pm" — not a bare "13:30, 14:00")
  const raw = entry.parsed.raw && /[a-z]/i.test(entry.parsed.raw)
    ? `<div class="jummah-card-raw">${escapeHtml(entry.parsed.raw)}</div>` : '';

  return `
    <a href="/${c.slug}" class="jummah-card" data-link data-slug="${c.slug}">
      <div class="jummah-card-content">
        <div class="jummah-card-name">${escapeHtml(c.display_name)}</div>
        ${addr}
        ${body}
        ${raw}
      </div>
    </a>`;
}

function reorderCards(entries) {
  const root = getRoot();
  const listEl = root.querySelector('.jummah-list');
  if (!listEl) return;
  const order = entries.slice().sort((a, b) =>
    (a.parsed.earliest - b.parsed.earliest) ||
    String(a.config.display_name).localeCompare(String(b.config.display_name))
  );
  for (const entry of order) {
    const card = listEl.querySelector(`[data-slug="${entry.config.slug}"]`);
    if (card) listEl.appendChild(card);
  }
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
      // fall through — treated as unresolved
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

  // Re-sort once, after all CSVs have landed (avoids cards jumping repeatedly)
  if (gen === loadGeneration) reorderCards(entries);
}

export async function render(container) {
  const gen = ++loadGeneration;
  viewContainer = container;

  container.innerHTML = `
    <div class="jummah-view">
      <header class="jummah-header">
        <h1>Jummah Times</h1>
        <p class="jummah-subtitle">All masjids with Friday jama'at, earliest first</p>
        <p class="jummah-hint">See masjid info for full details</p>
      </header>
      <div class="jummah-loading">
        <div class="skeleton-bone" style="width:100%;height:80px;border-radius:14px;margin-bottom:12px"></div>
        <div class="skeleton-bone" style="width:100%;height:80px;border-radius:14px;margin-bottom:12px"></div>
        <div class="skeleton-bone" style="width:100%;height:80px;border-radius:14px"></div>
      </div>
    </div>`;

  try {
    const res = await fetch('/data/mosques/index.json');
    if (!res.ok || gen !== loadGeneration) return;
    const configs = await res.json();
    if (gen !== loadGeneration) return;

    // Exclude test masjids + quality-flagged ones (same gate as eid-times.js).
    // Unlike /eid we keep masjids without the config field — the CSV fallback covers them.
    const entries = configs
      .filter(c =>
        !c.test_masjid &&
        !c.hidden &&
        !(c.quality && c.quality.status === 'needs_review')
      )
      .map(c => ({ config: c, parsed: parseJummahTimes(c.jummah_times) }))
      .sort((a, b) =>
        (a.parsed.earliest - b.parsed.earliest) ||
        String(a.config.display_name).localeCompare(String(b.config.display_name))
      );

    const root = getRoot();
    const loadingEl = root.querySelector('.jummah-loading');
    if (!loadingEl) return;

    if (entries.length === 0) {
      loadingEl.innerHTML = `<div class="jummah-empty">No Jummah times available yet.</div>`;
      return;
    }

    // Paint immediately from configs — CSV fallbacks fill in lazily afterwards
    loadingEl.className = 'jummah-list';
    loadingEl.innerHTML = entries.map(cardHtml).join('');

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
