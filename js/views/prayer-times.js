// Prayer times view — today/month toggle, countdowns, download/share
import { onThemeChange, getTheme } from '../theme.js';

let config = null;
let csvData = [];
let currentView = 'today';
let countdownInterval = null;
let eshaRerenderId = null;
let unsubTheme = null;
let masjidId = null;

export async function render(container, { slug }) {
  masjidId = slug;
  currentView = 'today';
  config = null;
  csvData = [];

  if (!slug) {
    container.innerHTML = '<div class="error">No masjid specified. Please select a masjid from the home page.</div>';
    return;
  }

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
  if (diffMinutes < 1) return 'in <1m';
  if (hours === 0) return `in ${minutes}m`;
  return `in ${hours}h ${minutes}m`;
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
    { name: 'Sunrise', keys: ['Sunrise'], isAM: true },
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

  // Highlight rows
  const grids = document.querySelectorAll('.times-grid');
  grids.forEach((grid, gridIndex) => {
    grid.querySelectorAll('.time-item').forEach(item => {
      const label = item.querySelector('.time-label');
      const labelText = label && label.textContent.trim();
      if (gridIndex === 0 && nextStart && labelText === nextStart.name) {
        item.classList.add('next-prayer');
        const cd = formatCountdown(nextStart.date);
        if (cd) { const span = document.createElement('span'); span.className = 'countdown'; span.textContent = cd; label.appendChild(span); }
      } else if (gridIndex === 1 && labelText === next.name) {
        item.classList.add('next-prayer');
        if (countdown) { const span = document.createElement('span'); span.className = 'countdown'; span.textContent = countdown; label.appendChild(span); }
      }
    });
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
          <div class="banner-time">${frontTime}</div>
        </div>
        <div class="flip-card-back banner-item">
          <div class="flip-hint">\u21BB</div>
          <div class="banner-label">${backLabel}</div>
          <div class="banner-time">${backTime}</div>
        </div>
      </div>
    </div>`;
  } else {
    sehriBannerHtml = `<div class="banner-item"><div class="banner-label">Sehri Ends</div><div class="banner-time">${todaySehri}</div></div>`;
  }

  target.innerHTML = `
    <div class="prayer-times-view" id="pt-content">
      <header>
        <h1>${config.display_name}</h1>
        <div class="date-line">${englishDate}</div>
        <div class="hijri-line">${hijriDate}</div>
      </header>

      ${renderToggle('today')}

      <div class="times-card">
        <div class="lockscreen-section">
          <div class="section-banner">
            ${sehriBannerHtml}
            <div class="banner-item">
              <div class="banner-label">Maghrib/Iftari</div>
              <div class="banner-time">${todayRow['Maghrib Iftari']}</div>
            </div>
          </div>
        </div>

        <div class="gold-divider"><div class="line"></div><div class="diamond"></div><div class="line"></div></div>

        <div class="lockscreen-section">
          <div class="section-title">Start Times</div>
          <div class="times-grid">
            ${todayRow['Fajr Start'] ? `<div class="time-item"><div class="time-label">Fajr</div><div class="time-value">${todayRow['Fajr Start']}</div></div>` : ''}
            <div class="time-item"><div class="time-label">Sunrise</div><div class="time-value">${todayRow['Sunrise']}</div></div>
            ${todayRow['Zawal'] ? `<div class="time-item"><div class="time-label">Zawal</div><div class="time-value">${todayRow['Zawal']}</div></div>` : ''}
            <div class="time-item"><div class="time-label">Dhuhr</div><div class="time-value">${todayRow['Zohr']}</div></div>
            <div class="time-item"><div class="time-label">Asr</div><div class="time-value">${todayRow['Asr']}</div></div>
            ${todayRow['Esha'] ? `<div class="time-item"><div class="time-label">Esha</div><div class="time-value">${todayRow['Esha']}</div></div>` : ''}
          </div>

          <div class="section-title" style="margin-top: 16px;">Jama'at Times</div>
          <div class="times-grid">
            <div class="time-item"><div class="time-label">Fajr</div><div class="time-value">${todayRow["Fajr Jama'at"]}</div></div>
            <div class="time-item"><div class="time-label">Dhuhr</div><div class="time-value">${todayRow["Zohar Jama'at"] || '1:00'}</div></div>
            <div class="time-item"><div class="time-label">Asr</div><div class="time-value">${todayRow["Asr Jama'at"]}</div></div>
            ${todayRow["Maghrib Jama'at"] ? `<div class="time-item"><div class="time-label">Maghrib</div><div class="time-value">${todayRow["Maghrib Jama'at"]}</div></div>` : ''}
            <div class="time-item"><div class="time-label">Esha</div><div class="time-value">${todayRow["Esha Jama'at"]}</div></div>
          </div>
        </div>
      </div>

      ${renderInfoSection()}

      <div class="btn-row">
        <a href="/latest/ramadan_lockscreen_${masjidId}_latest.png" class="download-btn" id="downloadBtn" download>Download</a>
        <button class="share-btn" id="shareBtn">Share</button>
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
  const hasFajrStart = csvData.some(row => row['Fajr Start']);
  const hasZawal = csvData.some(row => row['Zawal']);
  const hasEshaStart = csvData.some(row => row['Esha']);
  const hasMaghribJamaat = csvData.some(row => row["Maghrib Jama'at"]);
  const startColspan = (hasFajrStart ? 1 : 0) + (hasZawal ? 1 : 0) + (hasEshaStart ? 5 : 4) + (hasMaghribJamaat ? 1 : 0);

  target.innerHTML = `
    <div class="prayer-times-view" id="pt-content">
      <header>
        <h1>${config.display_name}</h1>
        <div class="date-line">Ramadan 2026 Timetable</div>
        <div class="hijri-line">${getHijriRange()}</div>
      </header>

      ${renderToggle('monthly')}

      <div class="calendar-grid">
        <table class="calendar-table">
          <thead>
            <tr>
              <th class="section-header"></th><th class="section-header"></th><th class="section-header"></th>
              <th class="section-header section-divider" colspan="${startColspan}">Start Times</th>
              <th class="section-header section-divider" colspan="5">Jama'at Times</th>
            </tr>
            <tr>
              <th>Date</th><th>Day</th><th>Hijri</th>
              <th class="section-divider">Sehri</th>
              ${hasFajrStart ? '<th>Fajr</th>' : ''}
              <th>Sunrise</th>
              ${hasZawal ? '<th>Zawal</th>' : ''}
              <th>Dhuhr</th><th>Asr</th>
              ${hasMaghribJamaat ? '<th>Maghrib</th>' : ''}
              ${hasEshaStart ? '<th>Esha</th>' : ''}
              <th class="section-divider">Fajr</th><th>Dhuhr</th><th>Asr</th><th>Maghrib</th><th>Esha</th>
            </tr>
          </thead>
          <tbody>
            ${csvData.map(row => {
              const isToday = parseDate(row['Date']).toDateString() === new Date().toDateString();
              return `<tr ${isToday ? 'class="today"' : ''}>
                <td class="date-col">${row['Date']}</td>
                <td>${row['Day']}</td>
                <td>${row['Islamic Day'] || row['Ramadan'] || row['Hijri']}</td>
                <td class="section-divider">${row['Sehri Ends']}</td>
                ${hasFajrStart ? `<td>${row['Fajr Start']}</td>` : ''}
                <td>${row['Sunrise']}</td>
                ${hasZawal ? `<td>${row['Zawal']}</td>` : ''}
                <td>${row['Zohr']}</td>
                <td>${row['Asr']}</td>
                ${hasMaghribJamaat ? `<td>${row['Maghrib Iftari']}</td>` : ''}
                ${hasEshaStart ? `<td>${row['Esha']}</td>` : ''}
                <td class="section-divider">${row["Fajr Jama'at"]}</td>
                <td>${row["Zohar Jama'at"] || '\u2014'}</td>
                <td>${row["Asr Jama'at"]}</td>
                <td>${hasMaghribJamaat ? (row["Maghrib Jama'at"] || '\u2014') : row['Maghrib Iftari']}</td>
                <td>${row["Esha Jama'at"]}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  setupToggle(target);

  // Highlight next prayer cell
  const todayRow = getTodayRow();
  if (todayRow) {
    const next = getNextPrayer(todayRow);
    if (next) {
      const dhuhrStartIdx = 5 + (hasFajrStart ? 1 : 0) + (hasZawal ? 1 : 0);
      const eshaOffset = hasEshaStart ? 1 : 0;
      const jamaatIdx = dhuhrStartIdx + 2 + eshaOffset;
      const colMap = { 'Fajr': jamaatIdx, 'Dhuhr': dhuhrStartIdx, 'Asr': dhuhrStartIdx + 1, 'Maghrib': jamaatIdx + 3, 'Esha': jamaatIdx + 4 };
      const colIndex = colMap[next.name];
      if (colIndex !== undefined) {
        const row = document.querySelector('.calendar-table tbody tr.today');
        if (row && row.children[colIndex]) row.children[colIndex].classList.add('next-prayer-cell');
      }
    }
  }
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

  let rows = '';
  if (config.address) {
    const mapUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(config.address);
    const addrHtml = config.address.split(', ').join(',<br class="mobile-br"> ');
    rows += `<div class="info-row"><span class="info-row-label">Address</span><span class="info-row-value"><a href="${mapUrl}" target="_blank" rel="noopener">${addrHtml}</a></span></div>`;
  }
  if (config.phone) {
    const phoneParts = config.phone.split(/\s*[|\/]\s*/);
    const phoneHtml = phoneParts.map(part => {
      const m = part.match(/[\d\s]{10,}/);
      return m ? `<a href="tel:${m[0].replace(/\s+/g, '')}">${part.trim()}</a>` : part.trim();
    }).join('<br class="mobile-br"> ');
    rows += `<div class="info-row"><span class="info-row-label">Contact</span><span class="info-row-value">${phoneHtml}</span></div>`;
  }
  if (config.radio_frequency) rows += `<div class="info-row"><span class="info-row-label">Radio</span><span class="info-row-value">${config.radio_frequency}</span></div>`;
  if (config.eid_salah) {
    const eidHtml = config.eid_salah.split(', ').join(',<br class="mobile-br"> ');
    rows += `<div class="info-row"><span class="info-row-label">Eid Salah</span><span class="info-row-value">${eidHtml}</span></div>`;
  }
  if (config.sadaqatul_fitr) rows += `<div class="info-row"><span class="info-row-label">Fitrana</span><span class="info-row-value">${config.sadaqatul_fitr}</span></div>`;

  return `<div class="info-section">
    <div class="info-header" id="infoHeader"><span>Masjid Info</span><div class="chevron"></div></div>
    <div class="info-body" id="infoBody"><div class="info-body-inner">${rows}</div></div>
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
