// Prayer times view — today/month toggle, countdowns, download/share
import { onThemeChange, getTheme } from '../theme.js';

let config = null;
let csvData = [];
let currentView = 'today';
let monthlyMode = 'jamaat';
let countdownInterval = null;
let eshaRerenderId = null;
let unsubTheme = null;
let masjidId = null;

function use24h() {
  return localStorage.getItem('prayerly-time-format') !== '12';
}

// isAM: true = morning prayer (Sehri/Fajr/Sunrise), false = afternoon/evening
// skipSuffix: true = omit AM/PM in 12h mode (for month view)
function ft(timeStr, isAM, skipSuffix) {
  if (!timeStr || timeStr === '-' || timeStr === '\u2014') return timeStr;
  const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return timeStr;
  let hours = parseInt(match[1]);
  const minutes = match[2];

  if (use24h()) {
    if (!isAM && hours !== 12) hours += 12;
    if (isAM && hours === 12) hours = 0;
    return `${hours}:${minutes}`;
  }
  if (skipSuffix) return `${hours}:${minutes}`;
  return `${hours}:${minutes} ${isAM ? 'AM' : 'PM'}`;
}

// Column key → isAM mapping for CSV columns
const COL_IS_AM = {
  'Sehri Ends': true, "Fajr Jama'at": true, 'Sunrise': true,
  'Zohr': false, "Zohar Jama'at": false, 'Zawal': false,
  'Asr': false, "Asr Jama'at": false,
  'Maghrib Iftari': false, "Maghrib Jama'at": false,
  'Esha': false, "Esha Jama'at": false,
};

export async function render(container, { slug }) {
  masjidId = slug;
  currentView = 'today';
  config = null;
  csvData = [];

  if (!slug) {
    const MOSQUE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c-.4.6-.8 1.3-.6 2 .1.4.6.6.6.6s.5-.2.6-.6c.2-.7-.2-1.4-.6-2z"/><path d="M12 4.5C9.5 6.5 7 9 7 11.5c0 0 0 .5.2.5H16.8c.2 0 .2-.5.2-.5 0-2.5-2.5-5-5-7z"/><rect x="5" y="12" width="14" height="9"/><path d="M12 21v-5a2.5 2.5 0 0 0-2.5-2.5h0A2.5 2.5 0 0 0 7 16v5"/><rect x="2" y="10" width="3" height="11" rx=".5"/><rect x="19" y="10" width="3" height="11" rx=".5"/></svg>';
    container.innerHTML = `<div class="prayer-times-view">
      <div class="home-no-hero">
        <div class="home-no-hero-icon">${MOSQUE_SVG}</div>
        <div class="home-no-hero-text">No masjid selected</div>
        <div class="home-no-hero-sub">Set a masjid as your primary from the <a href="/masjids" data-link>Masjids</a> tab to view prayer times here</div>
      </div>
    </div>`;
    return;
  }

  // Record visit for recently viewed
  recordRecentVisit(slug);

  // Show skeleton
  container.innerHTML = getSkeleton();

  try {
    const configRes = await fetch(`/data/mosques/${slug}.json`);
    if (!configRes.ok) {
      container.innerHTML = `<div class="not-found">
        <div class="not-found-code">404</div>
        <p class="not-found-message">Masjid not found.<br>It may not have been added yet.</p>
        <a href="/" class="not-found-link" data-link>Go Home</a>
      </div>`;
      return;
    }
    config = await configRes.json();
    document.title = `${config.display_name} - Prayerly`;

    const csvRes = await fetch(`/data/${config.csv}`);
    if (!csvRes.ok) throw new Error('Timetable not found');
    csvData = parseCSV(await csvRes.text());

    renderContent(container);

    // Update download link on theme change
    unsubTheme = onThemeChange(() => updateDownloadLink());
  } catch (error) {
    container.innerHTML = `<div class="error">${error.message}</div>`;
  }
}

export function destroy() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  if (eshaRerenderId) { clearTimeout(eshaRerenderId); eshaRerenderId = null; }
  if (unsubTheme) { unsubTheme(); unsubTheme = null; }
  document.title = 'Prayerly';
}

function recordRecentVisit(slug) {
  const key = 'prayerly-recent-masjids';
  const max = 6;
  try {
    let recent = JSON.parse(localStorage.getItem(key) || '[]');
    recent = recent.filter(s => s !== slug);
    recent.unshift(slug);
    if (recent.length > max) recent = recent.slice(0, max);
    localStorage.setItem(key, JSON.stringify(recent));
  } catch { /* ignore */ }
}

// --- CSV parsing (local to this view, matches original exactly) ---

function parseCSV(text) {
  const lines = text.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',').map(v => v.trim());
    const row = {};
    headers.forEach((header, index) => { row[header] = values[index]; });
    rows.push(row);
  }
  return rows;
}

function parseDate(dateStr) {
  const parts = dateStr.trim().split(' ');
  const day = parseInt(parts[0]);
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthIndex = monthNames.indexOf(parts[1]);
  return new Date(2026, monthIndex, day);
}

function getTodayRow() {
  const today = new Date();
  for (const row of csvData) {
    if (parseDate(row['Date']).toDateString() === today.toDateString()) return row;
  }
  return null;
}

function getTomorrowRow() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  for (const row of csvData) {
    if (parseDate(row['Date']).toDateString() === tomorrow.toDateString()) return row;
  }
  return null;
}

function formatFullDate(dateStr, dayStr) {
  const dayMap = { 'Mon': 'Monday', 'Tue': 'Tuesday', 'Wed': 'Wednesday', 'Thu': 'Thursday', 'Fri': 'Friday', 'Sat': 'Saturday', 'Sun': 'Sunday' };
  return `${dayMap[dayStr] || dayStr} ${dateStr} 2026`;
}

function parseTimeToDate(timeStr, isAM) {
  const parts = timeStr.trim().split(':');
  let hours = parseInt(parts[0]);
  const minutes = parseInt(parts[1]);
  if (!isAM && hours !== 12) hours += 12;
  if (isAM && hours === 12) hours = 0;
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
}

function formatCountdown(prayerDate) {
  const now = new Date();
  const diffMs = prayerDate - now;
  if (diffMs <= 0) return null;
  const diffMinutes = Math.ceil(diffMs / 60000);
  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;
  if (diffMinutes < 1) return '<1m';
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function getNextPrayer(todayRow) {
  const prayers = [
    { name: 'Fajr', keys: ["Fajr Jama'at"], isAM: true },
    { name: 'Dhuhr', keys: ["Zohar Jama'at"], isAM: false, defaultTime: '1:00' },
    { name: 'Asr', keys: ["Asr Jama'at"], isAM: false },
    { name: 'Maghrib', keys: ["Maghrib Jama'at", "Maghrib Iftari"], isAM: false },
    { name: 'Esha', keys: ["Esha Jama'at"], isAM: false },
  ];
  const now = new Date();
  for (const prayer of prayers) {
    let timeStr = null;
    for (const key of prayer.keys) {
      if (todayRow[key]) { timeStr = todayRow[key]; break; }
    }
    if (!timeStr && prayer.defaultTime) timeStr = prayer.defaultTime;
    if (!timeStr) continue;
    if (parseTimeToDate(timeStr, prayer.isAM) > now) {
      return { name: prayer.name, date: parseTimeToDate(timeStr, prayer.isAM) };
    }
  }
  return null;
}

// --- Countdown highlighting ---

function applyNextPrayerHighlight(todayRow) {
  document.querySelectorAll('.next-prayer').forEach(el => el.classList.remove('next-prayer'));
  document.querySelectorAll('.countdown').forEach(el => el.remove());

  const next = getNextPrayer(todayRow);
  if (!next) {
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    return;
  }
  const countdown = formatCountdown(next.date);

  // Next start time (independent)
  const startTimes = [
    { name: 'Fajr', keys: ['Sehri Ends'], isAM: true },
    { name: 'Dhuhr', keys: ['Zohr'], isAM: false },
    { name: 'Asr', keys: ['Asr'], isAM: false },
    { name: 'Esha', keys: ['Esha'], isAM: false },
  ];
  let nextStart = null;
  for (const st of startTimes) {
    let timeStr = null;
    for (const key of st.keys) { if (todayRow[key]) { timeStr = todayRow[key]; break; } }
    if (!timeStr) continue;
    if (parseTimeToDate(timeStr, st.isAM) > new Date()) {
      nextStart = { name: st.name, date: parseTimeToDate(timeStr, st.isAM) };
      break;
    }
  }

  // Highlight rows in unified table
  document.querySelectorAll('.time-row').forEach(row => {
    const prayerName = row.dataset.prayer;
    const nameEl = row.querySelector('.time-name');
    // Highlight start time column
    if (nextStart && prayerName === nextStart.name) {
      row.classList.add('next-start');
      const cd = formatCountdown(nextStart.date);
      if (cd && nameEl) {
        const span = document.createElement('span');
        span.className = 'countdown countdown-left';
        span.textContent = cd;
        nameEl.appendChild(span);
      }
    }
    // Highlight jama'at time column
    if (prayerName === next.name) {
      row.classList.add('next-jamaat');
      if (countdown && nameEl) {
        const span = document.createElement('span');
        span.className = 'countdown countdown-right';
        span.textContent = countdown;
        nameEl.appendChild(span);
      }
    }
  });

  // Sehri countdown
  const sehriTime = todayRow['Sehri Ends'];
  if (sehriTime) {
    const sehriDate = parseTimeToDate(sehriTime, true);
    const sehriCountdown = formatCountdown(sehriDate);
    if (sehriCountdown) {
      document.querySelectorAll('.banner-label').forEach(label => {
        if (label.textContent.trim() === 'Sehri Ends') {
          const span = document.createElement('span'); span.className = 'countdown'; span.textContent = sehriCountdown; label.appendChild(span);
        }
      });
    }
  }

  // Tomorrow's sehri countdown
  const eshaJamaatTime = todayRow["Esha Jama'at"];
  if (eshaJamaatTime) {
    const eshaDate = parseTimeToDate(eshaJamaatTime, false);
    if (new Date() > eshaDate) {
      const tomorrowRow = getTomorrowRow();
      if (tomorrowRow) {
        const tomorrowSehriTime = tomorrowRow['Sehri Ends'];
        if (tomorrowSehriTime) {
          const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
          const parts = tomorrowSehriTime.trim().split(':');
          let hours = parseInt(parts[0]); const minutes = parseInt(parts[1]);
          if (hours === 12) hours = 0;
          const tomorrowSehriDate = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), hours, minutes);
          const tc = formatCountdown(tomorrowSehriDate);
          if (tc) {
            document.querySelectorAll('.banner-label').forEach(label => {
              if (label.textContent.includes("Tomorrow")) {
                const span = document.createElement('span'); span.className = 'countdown'; span.textContent = tc; label.appendChild(span);
              }
            });
          }
        }
      }
    }
  }

  // Iftari countdown
  const maghribTime = todayRow['Maghrib Iftari'];
  if (maghribTime) {
    const maghribDate = parseTimeToDate(maghribTime, false);
    const iftariCountdown = formatCountdown(maghribDate);
    if (iftariCountdown || (next && next.name === 'Maghrib')) {
      document.querySelectorAll('.banner-item').forEach(item => {
        const label = item.querySelector('.banner-label');
        if (label && label.textContent.includes('Maghrib')) {
          if (next && next.name === 'Maghrib') item.classList.add('next-prayer');
          if (iftariCountdown) {
            const span = document.createElement('span'); span.className = 'countdown'; span.textContent = iftariCountdown; label.appendChild(span);
          }
        }
      });
    }
  }
}

// --- View rendering ---

function renderContent(container) {
  const target = container || document.getElementById('pt-content');
  if (!target) return;
  if (currentView === 'today') renderTodayView(target);
  else renderMonthlyView(target);
}

function renderTodayView(target) {
  const todayRow = getTodayRow();

  if (!todayRow) {
    const lastRow = csvData[csvData.length - 1];
    const lastDate = lastRow ? parseDate(lastRow['Date']) : null;
    const isStale = lastDate && lastDate < new Date();
    const currentMonth = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    if (isStale) {
      target.innerHTML = `
        <div class="prayer-times-view">
          <header><h1>${config.display_name}</h1></header>
          ${renderToggle('today')}
          <div class="stale-notice">
            <h2>Times for ${currentMonth} are not yet available</h2>
            <p>The current timetable has ended. New times will be added soon.</p>
          </div>
        </div>`;
    } else {
      target.innerHTML = `<div class="prayer-times-view"><div class="error">No prayer times available for today.<br><small>Check back when the timetable period begins.</small></div></div>`;
    }
    return;
  }

  const englishDate = formatFullDate(todayRow['Date'], todayRow['Day']);
  const hijriRaw = todayRow['Islamic Day'] || todayRow['Ramadan'] || todayRow['Hijri'] || '';
  const monthAbbrevMap = { 'Ram': 'Ramadan', 'Shaw': 'Shawwal', 'Sha': "Sha'ban" };
  const hijriParts = hijriRaw.trim().split(' ');
  const hijriDate = (hijriParts.length === 2 && monthAbbrevMap[hijriParts[1]])
    ? `${hijriParts[0]} ${monthAbbrevMap[hijriParts[1]]} 1447`
    : `${hijriRaw} Ramadan 1447`;

  const tomorrowRow = getTomorrowRow();
  const tomorrowSehri = tomorrowRow ? tomorrowRow['Sehri Ends'] : null;
  const todaySehri = todayRow['Sehri Ends'];
  const sehriPassed = todaySehri && parseTimeToDate(todaySehri, true) < new Date();

  let sehriBannerHtml;
  if (tomorrowSehri) {
    const frontLabel = sehriPassed ? "Tomorrow's Sehri" : 'Sehri Ends';
    const frontTime = sehriPassed ? tomorrowSehri : todaySehri;
    const backLabel = sehriPassed ? 'Sehri Ends' : "Tomorrow's Sehri";
    const backTime = sehriPassed ? todaySehri : tomorrowSehri;
    sehriBannerHtml = `<div class="flip-card" id="sehriFlip">
      <div class="flip-card-inner">
        <div class="flip-card-front banner-item">
          <div class="flip-hint">\u21BB</div>
          <div class="banner-label">${frontLabel}</div>
          <div class="banner-time">${ft(frontTime, true)}</div>
        </div>
        <div class="flip-card-back banner-item">
          <div class="flip-hint">\u21BB</div>
          <div class="banner-label">${backLabel}</div>
          <div class="banner-time">${ft(backTime, true)}</div>
        </div>
      </div>
    </div>`;
  } else {
    sehriBannerHtml = `<div class="banner-item"><div class="banner-label">Sehri Ends</div><div class="banner-time">${ft(todaySehri, true)}</div></div>`;
  }

  // Build unified prayer rows: Start | Name | Jama'at
  const prayerRows = [];
  prayerRows.push({ name: 'Fajr', isAM: true, start: todayRow['Sehri Ends'] || null, jamaat: todayRow["Fajr Jama'at"] });
  if (todayRow['Zawal']) prayerRows.push({ name: 'Zawal', isAM: false, start: todayRow['Zawal'], jamaat: null });
  prayerRows.push({ name: 'Dhuhr', isAM: false, start: todayRow['Zohr'] || null, jamaat: todayRow["Zohar Jama'at"] || '1:00' });
  prayerRows.push({ name: 'Asr', isAM: false, start: todayRow['Asr'] || null, jamaat: todayRow["Asr Jama'at"] });
  prayerRows.push({ name: 'Maghrib', isAM: false, start: todayRow['Maghrib Iftari'] || null, jamaat: todayRow["Maghrib Jama'at"] || todayRow['Maghrib Iftari'] });
  prayerRows.push({ name: 'Esha', isAM: false, start: todayRow['Esha'] || null, jamaat: todayRow["Esha Jama'at"] });

  const prayerRowsHtml = prayerRows.map(p => `
    <div class="time-row" data-prayer="${p.name}">
      <div class="time-col time-start">${ft(p.start, p.isAM) || '-'}</div>
      <div class="time-col time-name">${p.name}</div>
      <div class="time-col time-jamaat">${ft(p.jamaat, p.isAM) || '-'}</div>
    </div>`).join('');

  target.innerHTML = `
    <div class="prayer-times-view" id="pt-content">
      <header>
        <button class="share-icon-btn" id="shareBtn" aria-label="Share"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg></button>
        <h1>${config.display_name}</h1>
        <div class="date-line">${englishDate}</div>
        <div class="hijri-line">${hijriDate}</div>
      </header>

      ${renderToggle('today')}

      <div class="section-banner">
        ${sehriBannerHtml}
        <div class="banner-item">
          <div class="banner-label">Maghrib/Iftari</div>
          <div class="banner-time">${ft(todayRow['Maghrib Iftari'], false)}</div>
        </div>
      </div>

      <div class="times-table-card">
        <div class="times-table-header">
          <div class="time-col">Start</div>
          <div class="time-col">Prayer</div>
          <div class="time-col">Jama'at</div>
        </div>
        <div class="times-table-body">
          ${prayerRowsHtml}
        </div>
      </div>

      ${renderInfoSection()}

      <div class="btn-row">
        <a href="/latest/ramadan_lockscreen_${masjidId}_latest.png" class="download-btn" id="downloadBtn" download>Download</a>
        ${renderPrimaryButton()}
      </div>
    </div>
  `;

  // Wire up events
  setupToggle(target);
  setupFlipCard();
  setupShareButton();
  setupInfoToggle();
  setupDownloadTracking();
  updateDownloadLink();
  setupPrimaryButton();

  // Countdowns
  applyNextPrayerHighlight(todayRow);
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    const row = getTodayRow();
    if (row && currentView === 'today') applyNextPrayerHighlight(row);
  }, 60000);

  // Re-render after Esha
  if (eshaRerenderId) clearTimeout(eshaRerenderId);
  const eshaTime = todayRow["Esha Jama'at"];
  if (eshaTime) {
    const eshaDate = parseTimeToDate(eshaTime, false);
    const msUntilEsha = eshaDate - new Date();
    if (msUntilEsha > 0) {
      eshaRerenderId = setTimeout(() => {
        if (currentView === 'today') renderContent();
      }, msUntilEsha + 60000);
    }
  }
}

function renderMonthlyView(target) {
  const isDesktop = window.innerWidth >= 768;
  const isJamaat = monthlyMode === 'jamaat';

  const todayStr = new Date().toDateString();
  let tableHtml;
  let activeCols = [];

  // Helper: check if a column has at least one non-empty value across all rows
  function colHasData(col) {
    return csvData.some(row => {
      const val = row[col.key];
      return val && val.trim();
    });
  }

  if (isDesktop) {
    // Combined view: start + jama'at columns
    const allStartCols = [
      { label: 'Sehri', key: 'Sehri Ends', isAM: true, group: 'start' },
      { label: 'Sunrise', key: 'Sunrise', isAM: true, group: 'start' },
      { label: 'Dhuhr', key: 'Zohr', isAM: false, group: 'start' },
      { label: 'Asr', key: 'Asr', isAM: false, group: 'start' },
      { label: 'Maghrib', key: 'Maghrib Iftari', isAM: false, group: 'start' },
      { label: 'Esha', key: 'Esha', isAM: false, group: 'start' },
    ];
    const allJamaatCols = [
      { label: 'Fajr J', key: "Fajr Jama'at", isAM: true, group: 'jamaat' },
      { label: 'Dhuhr J', key: "Zohar Jama'at", fallback: '1:00', isAM: false, group: 'jamaat' },
      { label: 'Asr J', key: "Asr Jama'at", isAM: false, group: 'jamaat' },
      { label: 'Magh J', key: "Maghrib Jama'at", fallbackKey: 'Maghrib Iftari', isAM: false, group: 'jamaat' },
      { label: 'Esha J', key: "Esha Jama'at", isAM: false, group: 'jamaat' },
    ];
    const startCols = allStartCols.filter(colHasData);
    const jamaatCols = allJamaatCols.filter(colHasData);
    const combinedCols = [...startCols, ...jamaatCols];
    activeCols = combinedCols;

    const rowsHtml = csvData.map(row => {
      const isToday = parseDate(row['Date']).toDateString() === todayStr;
      const dateParts = row['Date'].trim().split(' ');
      const dateDisplay = `${dateParts[0]} ${dateParts[1]}`;
      const hijri = row['Islamic Day'] || row['Ramadan'] || row['Hijri'] || '';
      const cells = combinedCols.map(col => {
        const val = row[col.key] || (col.fallbackKey && row[col.fallbackKey]) || col.fallback || '\u2014';
        return `<td>${ft(val, col.isAM, true) || val}</td>`;
      }).join('');
      return `<tr${isToday ? ' class="today" id="monthTodayRow"' : ''}><td class="date-col">${dateDisplay}</td><td class="hijri-col">${hijri}</td>${cells}</tr>`;
    }).join('');

    const startHeader = startCols.length > 0 ? `<th colspan="${startCols.length}" class="month-group-header">Start Times</th>` : '';
    const jamaatHeader = jamaatCols.length > 0 ? `<th colspan="${jamaatCols.length}" class="month-group-header">Jama'at Times</th>` : '';

    tableHtml = `
      <table class="month-table month-table-combined">
        <thead>
          <tr>
            <th class="month-group-header" colspan="2"></th>
            ${startHeader}
            ${jamaatHeader}
          </tr>
          <tr>
            <th class="date-col">Date</th>
            <th class="hijri-col">Hijri</th>
            ${combinedCols.map(col => `<th>${col.label}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>`;
  } else {
    // Mobile: toggle between start/jama'at
    const allJamaatCols = [
      { label: 'Sehri', key: 'Sehri Ends', isAM: true },
      { label: 'Fajr', key: "Fajr Jama'at", isAM: true },
      { label: 'Dhuhr', key: "Zohar Jama'at", fallback: '1:00', isAM: false },
      { label: 'Asr', key: "Asr Jama'at", isAM: false },
      { label: 'Magh', key: "Maghrib Jama'at", fallbackKey: 'Maghrib Iftari', isAM: false },
      { label: 'Esha', key: "Esha Jama'at", isAM: false },
    ];
    const allStartCols = [
      { label: 'Sehri', key: 'Sehri Ends', isAM: true },
      { label: 'Sunrise', key: 'Sunrise', isAM: true },
      { label: 'Dhuhr', key: 'Zohr', isAM: false },
      { label: 'Asr', key: 'Asr', isAM: false },
      { label: 'Magh', key: 'Maghrib Iftari', isAM: false },
      { label: 'Esha', key: 'Esha', isAM: false },
    ];
    const columns = isJamaat
      ? allJamaatCols.filter(colHasData)
      : allStartCols.filter(colHasData);
    activeCols = columns;

    const rowsHtml = csvData.map(row => {
      const isToday = parseDate(row['Date']).toDateString() === todayStr;
      const dateParts = row['Date'].trim().split(' ');
      const dateDisplay = `${dateParts[0]} ${dateParts[1]}`;
      const hijri = row['Islamic Day'] || row['Ramadan'] || row['Hijri'] || '';
      const cells = columns.map(col => {
        const val = row[col.key] || (col.fallbackKey && row[col.fallbackKey]) || col.fallback || '\u2014';
        return `<td>${ft(val, col.isAM, true) || val}</td>`;
      }).join('');
      return `<tr${isToday ? ' class="today" id="monthTodayRow"' : ''}><td class="date-col">${dateDisplay}<span class="month-hijri">${hijri}</span></td>${cells}</tr>`;
    }).join('');

    tableHtml = `
      <table class="month-table">
        <thead>
          <tr>
            <th class="date-col">Date</th>
            ${columns.map(col => `<th>${col.label}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>`;
  }

  target.innerHTML = `
    <div class="prayer-times-view" id="pt-content">
      <header>
        <h1>${config.display_name}</h1>
        <div class="date-line">Ramadan 2026 Timetable</div>
        <div class="hijri-line">${getHijriRange()}</div>
      </header>

      ${renderToggle('monthly')}

      ${!isDesktop ? `<div class="month-mode-toggle">
        <button class="month-mode-btn${!isJamaat ? ' active' : ''}" data-mode="start">Start</button>
        <button class="month-mode-btn${isJamaat ? ' active' : ''}" data-mode="jamaat">Jama'at</button>
      </div>` : ''}

      <div class="times-table-card month-table-card">
        ${tableHtml}
      </div>
    </div>
  `;

  setupToggle(target);
  setupMonthModeToggle(target);

  // Scroll today into view
  const todayEl = document.getElementById('monthTodayRow');
  if (todayEl) {
    requestAnimationFrame(() => {
      todayEl.scrollIntoView({ block: 'center', behavior: 'instant' });
    });
  }

  // Highlight next prayer cell in today row
  const todayRow = getTodayRow();
  if (todayRow && todayEl) {
    const next = getNextPrayer(todayRow);
    if (next) {
      // Map prayer name to jama'at column key
      const prayerKeyMap = { 'Fajr': ["Fajr Jama'at"], 'Dhuhr': ["Zohar Jama'at"], 'Asr': ["Asr Jama'at"], 'Maghrib': ["Maghrib Jama'at", "Maghrib Iftari"], 'Esha': ["Esha Jama'at"] };
      const keys = prayerKeyMap[next.name] || [];
      const colIdx = activeCols.findIndex(c => keys.includes(c.key));
      // +1 for desktop (date + hijri = 2 prefix cols), +1 for mobile (date = 1 prefix col)
      const offset = isDesktop ? 2 : 1;
      if (colIdx !== -1 && todayEl.children[colIdx + offset]) {
        todayEl.children[colIdx + offset].classList.add('next-prayer-cell');
      }
    }
  }
}

function setupMonthModeToggle(container) {
  container.querySelectorAll('.month-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === monthlyMode) return;
      monthlyMode = mode;
      renderContent();
    });
  });
}

// --- Helpers ---

function renderToggle(activeView) {
  return `<div class="view-toggle">
    <div class="toggle-container">
      <div class="toggle-slider${activeView === 'monthly' ? ' monthly' : ''}" id="toggleSlider"></div>
      <button class="toggle-btn${activeView === 'today' ? ' active' : ''}" data-view="today">Today</button>
      <button class="toggle-btn${activeView === 'monthly' ? ' active' : ''}" data-view="monthly">Month</button>
    </div>
  </div>`;
}

function setupToggle(container) {
  container.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view === currentView) return;
      if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
      if (eshaRerenderId) { clearTimeout(eshaRerenderId); eshaRerenderId = null; }
      currentView = view;
      renderContent();
      if (window.goatcounter) {
        window.goatcounter.count({ path: `/masjid/${view}`, title: `${config.display_name} - ${view} view`, event: true });
      }
    });
  });
}

function setupFlipCard() {
  const flipCard = document.getElementById('sehriFlip');
  if (!flipCard) return;
  flipCard.addEventListener('click', () => flipCard.classList.toggle('flipped'));
  let startX = 0;
  flipCard.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
  flipCard.addEventListener('touchend', (e) => {
    if (Math.abs(e.changedTouches[0].clientX - startX) > 30) flipCard.classList.toggle('flipped');
  }, { passive: true });
}

function setupInfoToggle() {
  const header = document.getElementById('infoHeader');
  if (!header) return;
  header.addEventListener('click', () => {
    const body = document.getElementById('infoBody');
    header.classList.toggle('expanded');
    if (body.style.maxHeight) {
      body.style.maxHeight = null;
    } else {
      body.style.maxHeight = body.scrollHeight + 'px';
    }
  });
}

function setupShareButton() {
  const btn = document.getElementById('shareBtn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const shareUrl = window.location.href;
    if (window.goatcounter) {
      window.goatcounter.count({ path: `/share/${masjidId}`, title: `Share - ${config.display_name}`, event: true });
    }
    if (navigator.share) {
      try {
        await navigator.share({ title: `${config.display_name} - Prayerly`, text: `Prayer times for ${config.display_name} on Prayerly`, url: shareUrl });
      } catch (err) { /* user cancelled */ }
    } else if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(`Prayer times for ${config.display_name} on Prayerly\n${shareUrl}`);
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Share'; }, 2000);
      } catch (err) { /* fallback failed */ }
    }
  });
}

function setupDownloadTracking() {
  const btn = document.getElementById('downloadBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (window.goatcounter) {
      window.goatcounter.count({ path: `/download/${masjidId}`, title: `Download - ${config.display_name}`, event: true });
    }
  });
}

function updateDownloadLink() {
  const btn = document.getElementById('downloadBtn');
  if (!btn) return;
  const isLight = getTheme() === 'light';
  const darkUrl = `/latest/ramadan_lockscreen_${masjidId}_latest.png`;
  const lightUrl = `/latest/ramadan_lockscreen_${masjidId}_light_latest.png`;

  if (isLight) {
    fetch(lightUrl, { method: 'HEAD' }).then(res => {
      btn.href = res.ok ? lightUrl : darkUrl;
    }).catch(() => { btn.href = darkUrl; });
  } else {
    btn.href = darkUrl;
  }
}

function renderInfoSection() {
  if (!config) return '';
  const hasInfo = config.address || config.phone || config.eid_salah || config.sadaqatul_fitr || config.radio_frequency;
  if (!hasInfo) return '';

  const mapUrl = config.address ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(config.address) : '';

  // Location block (address with icon)
  let locationHtml = '';
  if (config.address) {
    const addrHtml = config.address.split(', ').join(',<br> ');
    locationHtml = `
      <div class="info-location">
        <div class="info-location-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
          </svg>
        </div>
        <div>
          <div class="info-field-label">Location</div>
          <div class="info-location-text">${addrHtml}</div>
        </div>
      </div>`;
  }

  // Grid items
  let gridItems = '';
  if (config.phone) {
    const phoneParts = config.phone.split(/\s*[|\/]\s*/);
    const phoneHtml = phoneParts.map(part => {
      const m = part.match(/[\d\s]{10,}/);
      return m ? `<a href="tel:${m[0].replace(/\s+/g, '')}">${part.trim()}</a>` : part.trim();
    }).join('<br>');
    gridItems += `<div class="info-grid-item"><div class="info-field-label">Contact</div><div class="info-field-value">${phoneHtml}</div></div>`;
  }
  if (config.radio_frequency) {
    gridItems += `<div class="info-grid-item"><div class="info-field-label">Radio Freq</div><div class="info-field-value">${config.radio_frequency}</div></div>`;
  }
  if (config.jummah_times) {
    gridItems += `<div class="info-grid-item info-grid-full"><div class="info-field-label">Jumu'ah Times</div><div class="info-field-value">${config.jummah_times}</div></div>`;
  }
  if (config.eid_salah) {
    gridItems += `<div class="info-grid-item info-grid-full"><div class="info-field-label">Eid Salah</div><div class="info-field-value info-field-bold">${config.eid_salah}</div></div>`;
  }
  if (config.sadaqatul_fitr) {
    gridItems += `<div class="info-grid-item info-grid-full info-fitrana"><div class="info-field-label">Fitrana</div><div class="info-field-value info-field-bold">${config.sadaqatul_fitr}</div></div>`;
  }

  // Maps button
  let mapsBtn = '';
  if (mapUrl) {
    mapsBtn = `<a href="${mapUrl}" target="_blank" rel="noopener" class="info-maps-btn">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
        <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>
      </svg>
      <span>Open in Maps</span>
    </a>`;
  }

  return `<div class="info-section">
    <div class="info-header" id="infoHeader"><span>Masjid Info</span><div class="chevron"></div></div>
    <div class="info-body" id="infoBody">
      <div class="info-body-inner">
        ${locationHtml}
        ${gridItems ? `<div class="info-grid">${gridItems}</div>` : ''}
        ${mapsBtn}
      </div>
    </div>
  </div>`;
}

function getHijriRange() {
  const monthAbbrevMap = { 'Ram': 'Ramadan', 'Shaw': 'Shawwal', 'Sha': "Sha\u2019ban" };
  const getIslamic = row => (row['Islamic Day'] || row['Ramadan'] || row['Hijri'] || '').trim();
  const parseParts = raw => {
    const parts = raw.split(' ');
    if (parts.length === 2 && monthAbbrevMap[parts[1]]) return { day: parts[0], month: monthAbbrevMap[parts[1]] };
    return { day: parseInt(raw), month: 'Ramadan' };
  };
  const first = parseParts(getIslamic(csvData[0]));
  const last = parseParts(getIslamic(csvData[csvData.length - 1]));
  if (first.month === last.month) return `${first.day}-${last.day} ${first.month} 1447`;
  return `${first.day} ${first.month} \u2013 ${last.day} ${last.month} 1447`;
}

function renderPrimaryButton() {
  const current = localStorage.getItem('prayerly-pinned-masjid');
  const isPrimary = current === masjidId;
  const starSvg = '<svg viewBox="0 0 24 24" fill="' + (isPrimary ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.09 6.26L21 9.27l-5 4.87L17.18 21 12 17.27 6.82 21 8 14.14l-5-4.87 6.91-1.01z"/></svg>';
  const label = isPrimary ? 'My Masjid' : 'Set as My Masjid';
  const cls = isPrimary ? ' is-primary' : '';
  return `<button class="set-primary-btn${cls}" id="setPrimaryBtn">${starSvg} ${label}</button>`;
}

function setupPrimaryButton() {
  const btn = document.getElementById('setPrimaryBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const current = localStorage.getItem('prayerly-pinned-masjid');
    if (current === masjidId) {
      localStorage.removeItem('prayerly-pinned-masjid');
    } else {
      localStorage.setItem('prayerly-pinned-masjid', masjidId);
    }
    // Re-render button
    btn.outerHTML = renderPrimaryButton();
    setupPrimaryButton();
  });
}

function getSkeleton() {
  return `<div class="prayer-times-view">
    <div class="skeleton-header"><div class="skeleton-bone"></div><div class="skeleton-bone"></div><div class="skeleton-bone"></div></div>
    <div class="skeleton-toggle"><div class="skeleton-bone"></div></div>
    <div class="skeleton-card">
      <div class="skeleton-banner"><div class="skeleton-bone"></div><div class="skeleton-bone"></div></div>
      <div class="skeleton-divider"><div class="line"></div><div class="diamond"></div><div class="line"></div></div>
      <div class="skeleton-section-title skeleton-bone"></div>
      ${Array(5).fill('<div class="skeleton-row"><div class="skeleton-bone"></div><div class="skeleton-bone"></div></div>').join('')}
    </div>
  </div>`;
}
