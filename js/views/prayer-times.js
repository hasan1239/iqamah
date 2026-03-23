// Prayer times view — today/month toggle, countdowns, download/share
import { onThemeChange, getTheme } from '../theme.js';
import { gregorianToHijri, formatHijriDate } from '../utils/hijri.js';

let config = null;
let csvData = [];
let currentView = 'today';
let monthlyMode = 'jamaat';
let countdownInterval = null;
let eshaRerenderId = null;
let unsubTheme = null;
let masjidId = null;
let season = 'ramadan';

function use24h() {
  return localStorage.getItem('iqamah-time-format') !== '12';
}

// isAM: true = morning prayer (Sehri/Fajr/Sunrise), false = afternoon/evening
// skipSuffix: true = omit AM/PM in 12h mode (for month view)
function ft(timeStr, isAM, skipSuffix) {
  if (!timeStr || timeStr === '-' || timeStr === '\u2014') return timeStr;
  const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return timeStr;
  let hours = parseInt(match[1]);
  const minutes = match[2];
  // If hours >= 13, the time is already in 24h format — derive isAM from the value
  const already24h = hours >= 13 || (hours === 0);
  if (already24h) isAM = hours < 12;

  if (use24h()) {
    if (!already24h) {
      if (!isAM && hours !== 12) hours += 12;
      if (isAM && hours === 12) hours = 0;
    }
    return `${hours}:${minutes}`;
  }
  // Convert to 12h display
  if (already24h) {
    const suffix = hours >= 12 ? 'PM' : 'AM';
    const h12 = hours === 0 ? 12 : hours > 12 ? hours - 12 : hours;
    if (skipSuffix) return `${h12}:${minutes}`;
    return `${h12}:${minutes} ${suffix}`;
  }
  if (skipSuffix) return `${hours}:${minutes}`;
  return `${hours}:${minutes} ${isAM ? 'AM' : 'PM'}`;
}

// Column key → isAM mapping for CSV columns
const COL_IS_AM = {
  'Sehri Ends': true, 'Fajr Start': true, 'Subha Sadiq': true, "Fajr Jama'at": true, 'Sunrise': true,
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
    const CHEVRON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
    container.innerHTML = `<div class="prayer-times-view">
      <div class="home-no-hero">
        <div class="home-no-hero-icon">${MOSQUE_SVG}</div>
        <div class="home-no-hero-text">No masjid selected</div>
        <div class="home-no-hero-sub">Set a masjid as your primary from the Masjids tab to view prayer times here</div>
      </div>
      <div class="home-browse-all">
        <a href="/masjids" class="home-browse-btn" data-link>
          ${MOSQUE_SVG}
          <span>Browse All Masjids</span>
          ${CHEVRON_SVG}
        </a>
      </div>
    </div>`;
    return;
  }

  // Record visit for recently viewed
  recordRecentVisit(slug);

  // Show skeleton
  container.innerHTML = getSkeleton();

  try {
    const [configRes, seasonRes] = await Promise.all([
      fetch(`/data/mosques/${slug}.json`),
      fetch('/data/season.json').catch(() => null),
    ]);
    if (!configRes.ok) {
      container.innerHTML = `<div class="not-found">
        <div class="not-found-code">404</div>
        <p class="not-found-message">Masjid not found.<br>It may not have been added yet.</p>
        <a href="/" class="not-found-link" data-link>Go Home</a>
      </div>`;
      return;
    }
    config = await configRes.json();
    if (seasonRes && seasonRes.ok) {
      try { const s = await seasonRes.json(); season = s.season || 'ramadan'; } catch {}
    }
    document.title = `${config.display_name} - Iqamah`;

    const csvRes = await fetch(`/data/${config.csv}`);
    if (csvRes.ok) {
      csvData = parseCSV(await csvRes.text());
    } else {
      csvData = [];
    }

    renderContent(container);

    // Show pending notice if unapproved or pending update (only if future times exist)
    const hasFutureTimes = csvData.some(row => {
      const d = parseDate(row['Date']);
      return d && d >= new Date(new Date().setHours(0, 0, 0, 0));
    });
    if ((config.approved === false || config.pending_update === true) && hasFutureTimes) {
      const ptView = container.querySelector('.prayer-times-view');
      if (ptView) {
        const notice = document.createElement('div');
        notice.className = 'pending-notice';
        notice.innerHTML = config.pending_update
          ? 'Timetable update pending review<br>Times may not be verified yet'
          : 'This masjid is pending review<br>Times may not be verified yet';
        const toggle = ptView.querySelector('.view-toggle');
        if (toggle) {
          toggle.parentNode.insertBefore(notice, toggle);
        } else {
          ptView.insertBefore(notice, ptView.firstChild);
        }
      }
    }

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
  document.title = 'Iqamah';
}

function recordRecentVisit(slug) {
  const key = 'iqamah-recent-masjids';
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
  // If hours >= 13 or === 0, already in 24h format — skip conversion
  const already24h = hours >= 13 || (hours === 0);
  if (!already24h) {
    if (!isAM && hours !== 12) hours += 12;
    if (isAM && hours === 12) hours = 0;
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
}

function formatCountdown(prayerDate) {
  const now = new Date();
  const diffMs = prayerDate - now;
  if (diffMs <= 0) return null;
  const totalMinutes = Math.floor(diffMs / 60000);
  if (totalMinutes < 1) return '<1m';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
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

  // Remove any existing tomorrow banner
  document.querySelectorAll('.tomorrow-fajr-banner').forEach(el => el.remove());

  if (!next) {
    // All prayers done — show tomorrow's Fajr banner if available
    const tomorrowRow = getTomorrowRow();
    if (tomorrowRow) {
      const fajrStart = tomorrowRow['Fajr Start'] || tomorrowRow['Subha Sadiq'] || tomorrowRow['Sehri Ends'] || '';
      const fajrJamaat = tomorrowRow["Fajr Jama'at"] || '';
      if (fajrStart || fajrJamaat) {
        const tableCard = document.querySelector('.times-table-card');
        if (tableCard) {
          const banner = document.createElement('div');
          banner.className = 'tomorrow-fajr-banner';
          const startHtml = fajrStart ? `<div class="sehri-iftari-item"><div class="sehri-iftari-label">Tomorrow's Fajr</div><div class="sehri-iftari-time">${ft(fajrStart, true)}</div></div>` : '';
          const jamaatHtml = fajrJamaat ? `<div class="sehri-iftari-item"><div class="sehri-iftari-label">Fajr Jama'at</div><div class="sehri-iftari-time">${ft(fajrJamaat, true)}</div></div>` : '';
          banner.innerHTML = startHtml && jamaatHtml
            ? `${startHtml}<div class="sehri-iftari-divider"></div>${jamaatHtml}`
            : startHtml || jamaatHtml;
          tableCard.parentNode.insertBefore(banner, tableCard);
        }
      }
    }
    if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
    return;
  }
  const countdown = formatCountdown(next.date);

  // Next start time (independent)
  const startTimes = [
    { name: 'Fajr', keys: ['Sehri Ends', 'Fajr Start', 'Subha Sadiq'], isAM: true },
    { name: 'Dhuhr', keys: ['Zohr'], isAM: false },
    { name: 'Asr', keys: ['Asr'], isAM: false },
    { name: 'Maghrib', keys: ['Maghrib Iftari'], isAM: false },
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
      const startVal = row.querySelector('.time-start .time-value');
      if (cd && startVal) {
        const span = document.createElement('span');
        span.className = 'countdown';
        span.textContent = cd;
        startVal.appendChild(span);
      }
    }
    // Highlight jama'at time column
    if (prayerName === next.name) {
      row.classList.add('next-jamaat');
      const jamaatVal = row.querySelector('.time-jamaat .time-value');
      if (countdown && jamaatVal) {
        const span = document.createElement('span');
        span.className = 'countdown';
        span.textContent = countdown;
        jamaatVal.appendChild(span);
      }
    }
  });

  // Sehri/Iftari countdowns only in Ramadan mode
  if (season === 'ramadan') {
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

    // Build Eid banner even when no timetable data
    let noTimesEidHtml = '';
    if ((season === 'eid' || season === 'ramadan') && config.eid_salah) {
      const regex = /(\d{1,2}(?::\d{2})?)\s*(am|pm)/gi;
      const pills = [];
      let m;
      while ((m = regex.exec(config.eid_salah)) !== null) {
        pills.push(`<span class="eid-time-pill">${m[0]}</span>`);
      }
      noTimesEidHtml = `
        <div class="eid-banner">
          <div class="eid-banner-label">Eid Salah</div>
          <div class="eid-banner-times">${pills.join('')}</div>
          <div class="eid-banner-raw">${config.eid_salah}</div>
        </div>`;
    }

    if (isStale) {
      target.innerHTML = `
        <div class="prayer-times-view">
          <header><h1>${config.display_name}</h1></header>
          ${noTimesEidHtml}
          <div class="stale-notice">
            <h2>No times for ${currentMonth}</h2>
            <p>Could you help by uploading the latest timetable?</p>
            <a href="/update/${masjidId}" data-link class="btn btn-primary update-btn">Upload Timetable <span class="beta-badge" style="background:rgba(0,0,0,0.3);color:#fff">BETA</span></a>
          </div>
          ${renderInfoSection()}
          <div class="btn-row">
            ${renderPrimaryButton()}
          </div>
        </div>`;
    } else if (csvData.length === 0) {
      target.innerHTML = `<div class="prayer-times-view">
        <header><h1>${config.display_name}</h1></header>
        ${noTimesEidHtml}
        <div class="error">No timetable available yet.<br><small>Times will appear once a timetable is uploaded.</small></div>
        ${renderInfoSection()}
        <div class="btn-row">
          ${renderPrimaryButton()}
        </div>
      </div>`;
    } else {
      target.innerHTML = `<div class="prayer-times-view">
        <header><h1>${config.display_name}</h1></header>
        ${noTimesEidHtml}
        <div class="error">No prayer times available for today.<br><small>Check back when the timetable period begins.</small></div>
        ${renderInfoSection()}
        <div class="btn-row">
          ${renderPrimaryButton()}
        </div>
      </div>`;
    }
    setupInfoToggle();
    setupPrimaryButton();
    return;
  }

  const englishDate = formatFullDate(todayRow['Date'], todayRow['Day']);
  const hijriDate = formatHijriDate(new Date());

  const isRamadan = season === 'ramadan';
  const isEid = season === 'eid';

  // Override hijri line for Eid
  const hijriDisplay = isEid ? '1 Shawwal 1447 - Eid al-Fitr' : hijriDate;

  // Sehri/Iftari banner only in Ramadan mode
  let sehriBannerHtml = '';
  if (isRamadan) {
    const tomorrowRow = getTomorrowRow();
    const tomorrowSehri = tomorrowRow ? tomorrowRow['Sehri Ends'] : null;
    const todaySehri = todayRow['Sehri Ends'];
    const sehriPassed = todaySehri && parseTimeToDate(todaySehri, true) < new Date();

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
  }

  // Maghrib label changes by season
  const maghribLabel = isRamadan ? 'Maghrib/Iftar' : 'Maghrib';

  // Eid banner (shown in eid mode, or last few days of ramadan)
  let showEidBanner = isEid;
  if (isRamadan && config.eid_salah) {
    const hijri = (todayRow['Islamic Day'] || todayRow['Ramadan'] || todayRow['Hijri'] || '').trim();
    const hijriMatch = hijri.match(/^(\d+)\s+Ram/i);
    if (hijriMatch && parseInt(hijriMatch[1]) >= 28) showEidBanner = true;
  }
  let eidBannerHtml = '';
  if (showEidBanner && config.eid_salah) {
    const regex = /(\d{1,2}(?::\d{2})?)\s*(am|pm)/gi;
    const pills = [];
    let m;
    while ((m = regex.exec(config.eid_salah)) !== null) {
      pills.push(`<span class="eid-time-pill">${m[0]}</span>`);
    }
    eidBannerHtml = `
      <div class="eid-banner">
        <div class="eid-banner-label">Eid Salah</div>
        <div class="eid-banner-times">${pills.length > 0 ? pills.join('') : ''}</div>
        <div class="eid-banner-raw">${config.eid_salah}</div>
      </div>`;
  }

  // Build section banner HTML
  let sectionBannerHtml = '';
  if (isRamadan) {
    sectionBannerHtml = `
      <div class="section-banner">
        ${sehriBannerHtml}
        <div class="banner-item">
          <div class="banner-label">${maghribLabel}</div>
          <div class="banner-time">${ft(todayRow['Maghrib Iftari'], false)}</div>
        </div>
      </div>
      ${eidBannerHtml}`;
  } else if (eidBannerHtml) {
    sectionBannerHtml = eidBannerHtml;
  }

  // Build unified prayer rows: Start | Name | Jama'at
  const fajrStart = isRamadan ? (todayRow['Sehri Ends'] || null) : (todayRow['Fajr Start'] || todayRow['Subha Sadiq'] || todayRow['Sehri Ends'] || null);
  const prayerRows = [];
  prayerRows.push({ name: 'Fajr', isAM: true, start: fajrStart, jamaat: todayRow["Fajr Jama'at"] });
  if (todayRow['Zawal']) prayerRows.push({ name: 'Zawal', isAM: false, start: todayRow['Zawal'], jamaat: null });
  prayerRows.push({ name: 'Dhuhr', isAM: false, start: todayRow['Zohr'] || null, jamaat: todayRow["Zohar Jama'at"] || '1:00' });
  prayerRows.push({ name: 'Asr', isAM: false, start: todayRow['Asr'] || null, jamaat: todayRow["Asr Jama'at"] });
  prayerRows.push({ name: 'Maghrib', isAM: false, start: todayRow['Maghrib Iftari'] || null, jamaat: todayRow["Maghrib Jama'at"] || todayRow['Maghrib Iftari'] });
  prayerRows.push({ name: 'Esha', isAM: false, start: todayRow['Esha'] || null, jamaat: todayRow["Esha Jama'at"] });

  const prayerRowsHtml = prayerRows.map(p => `
    <div class="time-row" data-prayer="${p.name}">
      <div class="time-col time-start"><span class="time-value">${ft(p.start, p.isAM) || '-'}</span></div>
      <div class="time-col time-name">${p.name}</div>
      <div class="time-col time-jamaat"><span class="time-value">${ft(p.jamaat, p.isAM) || '-'}</span></div>
    </div>`).join('');

  target.innerHTML = `
    <div class="prayer-times-view" id="pt-content">
      <header>
        <button class="share-icon-btn" id="shareBtn" aria-label="Share"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg></button>
        <h1>${config.display_name}</h1>
        <div class="date-line">${englishDate}</div>
        <div class="hijri-line">${hijriDisplay}</div>
      </header>

      ${renderToggle('today')}

      ${sectionBannerHtml}

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

  // Expiring soon banner
  const lastRow = csvData[csvData.length - 1];
  if (lastRow) {
    const lastDate = parseDate(lastRow['Date']);
    const daysLeft = Math.ceil((lastDate - new Date()) / (1000 * 60 * 60 * 24));
    if (daysLeft >= 0 && daysLeft <= 5) {
      const ptView = target.querySelector('.prayer-times-view');
      if (ptView) {
        const notice = document.createElement('div');
        notice.className = 'update-notice';
        const endsText = daysLeft === 0 ? 'This timetable ends today' : `This timetable ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`;
        notice.innerHTML = `<p>${endsText}</p><a href="/update/${masjidId}" data-link class="btn btn-primary update-btn">Upload New Timetable <span class="beta-badge" style="background:rgba(0,0,0,0.3);color:#fff">BETA</span></a>`;
        const btnRow = ptView.querySelector('.btn-row');
        if (btnRow) ptView.insertBefore(notice, btnRow);
        else ptView.appendChild(notice);
      }
    }
  }

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

  // Re-render after Esha to update countdowns
  if (eshaRerenderId) clearTimeout(eshaRerenderId);
  const eshaTime = todayRow["Esha Jama'at"];
  if (eshaTime) {
    const eshaDate = parseTimeToDate(eshaTime, false);
    const msUntilEsha = eshaDate - new Date();
    if (msUntilEsha > 0) {
      const ptContent = document.getElementById('pt-content');
      eshaRerenderId = setTimeout(() => {
        // Only re-render if this view is still active
        if (currentView === 'today' && ptContent && document.contains(ptContent)) {
          renderContent();
        }
      }, msUntilEsha + 60000);
    }
  }
}

function renderMonthlyView(target) {
  const isDesktop = window.innerWidth >= 768;
  const isJamaat = monthlyMode === 'jamaat';
  const isRamadanMode = season === 'ramadan';

  // Filter rows: in non-ramadan mode, show only current calendar month
  const now = new Date();
  const displayRows = isRamadanMode
    ? csvData
    : csvData.filter(row => {
        const d = parseDate(row['Date']);
        return d && d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
      });

  if (displayRows.length === 0) {
    target.innerHTML = `<div class="prayer-times-view" id="pt-content">
      <header><h1>${config.display_name}</h1></header>
      ${renderToggle('monthly')}
      <div class="error">No timetable data for this month.</div>
    </div>`;
    setupToggle(target);
    return;
  }

  const todayStr = now.toDateString();
  let tableHtml;
  let activeCols = [];

  // Helper: check if a column has at least one non-empty value across display rows
  function colHasData(col) {
    return displayRows.some(row => {
      const val = row[col.key] || (col.altKey && row[col.altKey]) || (col.fallbackKey && row[col.fallbackKey]);
      return val && val.trim();
    });
  }

  if (isDesktop) {
    // Combined view: start + jama'at columns
    const allStartCols = [
      ...(isRamadanMode
        ? [{ label: 'Sehri', key: 'Sehri Ends', isAM: true, group: 'start' }]
        : [{ label: 'Fajr', key: 'Fajr Start', altKey: 'Subha Sadiq', isAM: true, group: 'start' }]),
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

    const rowsHtml = displayRows.map(row => {
      const isToday = parseDate(row['Date']).toDateString() === todayStr;
      const dateParts = row['Date'].trim().split(' ');
      const dateDisplay = `${dateParts[0]} ${dateParts[1]}`;
      const rowDate = parseDate(row['Date']);
      const h = gregorianToHijri(rowDate);
      const hijri = `${h.day} ${h.monthShort}`;
      const cells = combinedCols.map(col => {
        const val = row[col.key] || (col.altKey && row[col.altKey]) || (col.fallbackKey && row[col.fallbackKey]) || col.fallback || '\u2014';
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
      ...(isRamadanMode
        ? [{ label: 'Sehri', key: 'Sehri Ends', isAM: true }]
        : []),
      { label: 'Fajr', key: "Fajr Jama'at", isAM: true },
      { label: 'Dhuhr', key: "Zohar Jama'at", fallback: '1:00', isAM: false },
      { label: 'Asr', key: "Asr Jama'at", isAM: false },
      { label: 'Magh', key: "Maghrib Jama'at", fallbackKey: 'Maghrib Iftari', isAM: false },
      { label: 'Esha', key: "Esha Jama'at", isAM: false },
    ];
    const allStartCols = [
      ...(isRamadanMode
        ? [{ label: 'Sehri', key: 'Sehri Ends', isAM: true }]
        : [{ label: 'Fajr', key: 'Fajr Start', altKey: 'Subha Sadiq', isAM: true }]),
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

    const rowsHtml = displayRows.map(row => {
      const isToday = parseDate(row['Date']).toDateString() === todayStr;
      const dateParts = row['Date'].trim().split(' ');
      const dateDisplay = `${dateParts[0]} ${dateParts[1]}`;
      const rowDate = parseDate(row['Date']);
      const h = gregorianToHijri(rowDate);
      const hijri = `${h.day} ${h.monthShort}`;
      const cells = columns.map(col => {
        const val = row[col.key] || (col.altKey && row[col.altKey]) || (col.fallbackKey && row[col.fallbackKey]) || col.fallback || '\u2014';
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

  // Header: Ramadan title vs month name
  const headerTitle = isRamadanMode
    ? 'Ramadan 2026 Timetable'
    : `${now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })} Timetable`;

  // Hijri range for header
  const firstDate = parseDate(displayRows[0]['Date']);
  const lastDate = parseDate(displayRows[displayRows.length - 1]['Date']);
  const firstH = gregorianToHijri(firstDate);
  const lastH = gregorianToHijri(lastDate);
  const hijriRange = firstH.month === lastH.month
    ? `${firstH.day}-${lastH.day} ${firstH.monthName} ${firstH.year}`
    : `${firstH.day} ${firstH.monthName} \u2013 ${lastH.day} ${lastH.monthName} ${lastH.year}`;

  target.innerHTML = `
    <div class="prayer-times-view" id="pt-content">
      <header>
        <h1>${config.display_name}</h1>
        <div class="date-line">${headerTitle}</div>
        <div class="hijri-line">${hijriRange}</div>
      </header>

      ${renderToggle('monthly')}

      ${!isDesktop ? `<div class="month-mode-toggle">
        <button class="month-mode-btn${!isJamaat ? ' active' : ''}" data-mode="start">Start</button>
        <button class="month-mode-btn${isJamaat ? ' active' : ''}" data-mode="jamaat">Jama'at</button>
      </div>` : ''}

      <div class="times-table-card month-table-card">
        ${tableHtml}
      </div>

      <div class="month-footer-links">
        ${config.source_image ? `<a href="/data/${config.source_image}" target="_blank" class="month-footer-link">Source</a>` : ''}
        <a href="mailto:prayerly@hotmail.com?subject=${encodeURIComponent('Iqamah Report Issue - ' + config.display_name)}" class="month-footer-link">Report</a>
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
        await navigator.share({ title: `${config.display_name} - Iqamah`, text: `Prayer times for ${config.display_name} on Iqamah`, url: shareUrl });
      } catch (err) { /* user cancelled */ }
    } else if (navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(`Prayer times for ${config.display_name} on Iqamah\n${shareUrl}`);
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
  const isSeasonalMode = season === 'ramadan' || season === 'eid';
  const hasInfo = config.address || config.phone || (config.eid_salah && isSeasonalMode) || (config.sadaqatul_fitr && isSeasonalMode) || config.radio_frequency || config.jummah_times;
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
  if (config.eid_salah && (season === 'ramadan' || season === 'eid')) {
    gridItems += `<div class="info-grid-item info-grid-full"><div class="info-field-label">Eid Salah</div><div class="info-field-value info-field-bold">${config.eid_salah}</div></div>`;
  }
  if (config.sadaqatul_fitr && (season === 'ramadan' || season === 'eid')) {
    gridItems += `<div class="info-grid-item info-grid-full info-fitrana"><div class="info-field-label">Sadaqah al-Fitr</div><div class="info-field-value info-field-bold">${config.sadaqatul_fitr}</div></div>`;
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
        <div class="info-layout">
          ${locationHtml ? `<div class="info-layout-left">${locationHtml}${mapsBtn}</div>` : ''}
          ${gridItems ? `<div class="info-layout-right"><div class="info-grid">${gridItems}</div></div>` : ''}
        </div>
        ${!locationHtml ? mapsBtn : ''}
      </div>
    </div>
  </div>`;
}


function renderPrimaryButton() {
  const current = localStorage.getItem('iqamah-pinned-masjid');
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
    const current = localStorage.getItem('iqamah-pinned-masjid');
    if (current === masjidId) {
      localStorage.removeItem('iqamah-pinned-masjid');
    } else {
      localStorage.setItem('iqamah-pinned-masjid', masjidId);
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
