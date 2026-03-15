// Home view — hero card (pinned masjid) + recently viewed
import { navigate } from '../router.js';
import { canInstall, promptInstall, isStandalone, isIOSSafari } from '../utils/pwa.js';
import { parseCSV, getTodayRow } from '../utils/csv.js';
import { formatCountdown } from '../utils/countdown.js';
import { haversineDistance } from '../utils/geolocation.js';

let cachedConfigs = [];
let heroCountdownInterval = null;
let toastTimer = null;
let masjidsModule = null;

function getCityPostcode(address) {
  if (!address) return '';
  const pcMatch = address.match(/[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}/i);
  if (!pcMatch) return address.split(',').pop().trim();
  const postcode = pcMatch[0];
  const before = address.slice(0, pcMatch.index).replace(/,\s*$/, '');
  const parts = before.split(',').map(s => s.trim()).filter(Boolean);
  const city = parts.length > 0 ? parts[parts.length - 1] : '';
  return city ? `${city}, ${postcode}` : postcode;
}

// SVG icons
const STAR_FILLED_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.09 6.26L21 9.27l-5 4.87L17.18 21 12 17.27 6.82 21 8 14.14l-5-4.87 6.91-1.01z"/></svg>';
const CHEVRON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
const CLOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
const PIN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';
const MOSQUE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c-.4.6-.8 1.3-.6 2 .1.4.6.6.6.6s.5-.2.6-.6c.2-.7-.2-1.4-.6-2z"/><path d="M12 4.5C9.5 6.5 7 9 7 11.5c0 0 0 .5.2.5H16.8c.2 0 .2-.5.2-.5 0-2.5-2.5-5-5-7z"/><rect x="5" y="12" width="14" height="9"/><path d="M12 21v-5a2.5 2.5 0 0 0-2.5-2.5h0A2.5 2.5 0 0 0 7 16v5"/><rect x="2" y="10" width="3" height="11" rx=".5"/><rect x="19" y="10" width="3" height="11" rx=".5"/><line x1="3.5" y1="8" x2="3.5" y2="10"/><line x1="20.5" y1="8" x2="20.5" y2="10"/></svg>';

export function render(container) {
  const userName = localStorage.getItem('iqamah-user-name');
  let greetingHTML;
  if (userName) {
    greetingHTML = `<div class="greeting-salaam">Assalamu Alaikum,</div><div class="greeting-name">${userName}</div>`;
  } else {
    greetingHTML = `<div class="greeting-salaam">Assalamu Alaikum</div>`;
  }

  const showRebrand = !localStorage.getItem('iqamah-rebrand-dismissed');

  container.innerHTML = `
    <div class="home-view">
      <header class="home-header">
        <div class="header-content">
          <img src="/iqamah-logo.svg" alt="Iqamah" class="logo">
        </div>
      </header>
      <div class="greeting">${greetingHTML}</div>

      <div id="heroContainer"></div>

      <div id="recentSection"></div>

      <div class="home-browse-all">
        <a href="/masjids" class="home-browse-btn" data-link>
          ${MOSQUE_SVG}
          <span>Browse All Masjids</span>
          ${CHEVRON_SVG}
        </a>
      </div>

      <div id="desktopMasjidList" class="desktop-masjid-list"></div>

      <div class="install-banner" id="installBanner"></div>

      <div class="pin-toast" id="pinToast"></div>
    </div>
  `;

  loadMasjids();
  setupHeroClicks();
  setupInstallBanner();
  loadDesktopMasjidList();

  if (showRebrand) {
    showWelcomeScreen();
  }
  window.addEventListener('iqamah-pin-changed', onPinChanged);
}

function showWelcomeScreen() {
  const overlay = document.createElement('div');
  overlay.className = 'welcome-overlay';
  overlay.innerHTML = `
    <div class="welcome-card">
      <img src="/iqamah-logo.svg" alt="Iqamah" class="welcome-logo">
      <h1 class="welcome-title">Prayerly is now Iqamah</h1>
      <p class="welcome-subtitle">Same app you know, with a fresh new look and new features.</p>
      <div class="welcome-features">
        <div class="welcome-feature">
          <span class="welcome-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z"/><path d="M19 13l.75 2.25L22 16l-2.25.75L19 19l-.75-2.25L16 16l2.25-.75L19 13z"/><path d="M5 17l.5 1.5L7 19l-1.5.5L5 21l-.5-1.5L3 19l1.5-.5L5 17z"/></svg></span>
          <div>
            <strong>New Design</strong>
            <span>A cleaner, more polished experience</span>
          </div>
        </div>
        <div class="welcome-feature">
          <span class="welcome-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></span>
          <div>
            <strong>Add Your Masjid</strong>
            <span>Upload a timetable and Iqamah will do the rest</span>
          </div>
        </div>
        <div class="welcome-feature">
          <span class="welcome-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></span>
          <div>
            <strong>Browse Masjids</strong>
            <span>Find and pin your local masjid for quick access</span>
          </div>
        </div>
        <div class="welcome-feature">
          <span class="welcome-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg></span>
          <div>
            <strong>Qibla Compass</strong>
            <span>Find the direction of the Qibla from anywhere</span>
          </div>
        </div>
        <div class="welcome-feature">
          <span class="welcome-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg></span>
          <div>
            <strong>12/24 Hour Format</strong>
            <span>Switch between time formats in settings</span>
          </div>
        </div>
        <div class="welcome-feature">
          <span class="welcome-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18" style="margin-left:3px"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="16" y1="11" x2="22" y2="11"/></svg></span>
          <div>
            <strong>Community Powered</strong>
            <span>Can't find your masjid? Add it in seconds</span>
          </div>
        </div>
      </div>
      <button class="welcome-btn" id="welcomeBtn">Explore</button>
      <p class="welcome-reinstall-hint">Already installed? Delete and reinstall to update the app name and icon.</p>
    </div>
  `;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('visible'));

  document.getElementById('welcomeBtn').addEventListener('click', () => {
    overlay.classList.remove('visible');
    overlay.addEventListener('transitionend', () => overlay.remove());
    localStorage.setItem('iqamah-rebrand-dismissed', '1');
  });
}

async function loadMasjids() {
  try {
    const res = await fetch('/data/mosques/index.json');
    if (!res.ok) return;
    cachedConfigs = await res.json();
    renderHero();
    renderRecentlyViewed();
  } catch (error) {
    console.error('Error loading masjids:', error);
  }
}

// --- Hero card ---

function renderHero() {
  const heroContainer = document.getElementById('heroContainer');
  if (!heroContainer) return;

  const pinnedSlug = localStorage.getItem('iqamah-pinned-masjid');
  const pinnedConfig = pinnedSlug ? cachedConfigs.find(c => c.slug === pinnedSlug) : null;

  if (!pinnedConfig) {
    renderSuggestedHero(heroContainer);
    return;
  }

  const heroPendingBadge = pinnedConfig.approved === false ? '<span class="pending-badge">Pending Review</span>' : '';

  heroContainer.innerHTML = `
    <a href="/${pinnedConfig.slug}" class="hero-card hero-card-link" data-link>
      <div class="hero-header">
        <span class="hero-badge hero-badge-primary">My Masjid</span>
        <div class="hero-header-right">
          ${heroPendingBadge}
          <button class="hero-unpin-btn" data-slug="${pinnedConfig.slug}" data-hero="true" aria-label="Remove from My Masjid" title="Remove from My Masjid">
            ${STAR_FILLED_SVG}
          </button>
        </div>
      </div>
      <div class="hero-name">${pinnedConfig.display_name}</div>
      <div class="hero-body">
        <div class="hero-next-prayer" id="heroNextStart">
          <div class="hero-next-skeleton">
            <div class="skeleton-bone"></div>
            <div class="skeleton-bone"></div>
          </div>
        </div>
        <div class="hero-next-prayer" id="heroNextJamaat">
          <div class="hero-next-skeleton">
            <div class="skeleton-bone"></div>
            <div class="skeleton-bone"></div>
          </div>
        </div>
      </div>
    </a>`;

  loadHeroNextPrayer(pinnedConfig);
}

// --- Suggested hero (no pinned masjid) ---

function findBestMasjid() {
  if (cachedConfigs.length === 0) return null;

  // Only consider approved masjids for suggestions
  const approved = cachedConfigs.filter(c => c.approved !== false);
  if (approved.length === 0) return null;

  // Try cached location → nearest masjid
  try {
    const cached = JSON.parse(localStorage.getItem('iqamah-cached-location'));
    if (cached && cached.lat && cached.lon) {
      const withCoords = approved.filter(c => c.lat != null && c.lon != null);
      if (withCoords.length > 0) {
        withCoords.sort((a, b) =>
          haversineDistance(cached.lat, cached.lon, a.lat, a.lon) -
          haversineDistance(cached.lat, cached.lon, b.lat, b.lon)
        );
        return withCoords[0];
      }
    }
  } catch {}

  // Try recently viewed (only approved)
  const recentSlugs = getRecentSlugs();
  if (recentSlugs.length > 0) {
    const recent = approved.find(c => recentSlugs.includes(c.slug));
    if (recent) return recent;
  }

  // Fallback: first alphabetically
  return [...approved].sort((a, b) => a.display_name.localeCompare(b.display_name))[0];
}

function renderSuggestedHero(heroContainer) {
  const config = findBestMasjid();
  if (!config) {
    heroContainer.innerHTML = `
      <div class="home-no-hero">
        <div class="home-no-hero-icon">${MOSQUE_SVG}</div>
        <div class="home-no-hero-text">No masjid selected</div>
        <div class="home-no-hero-sub">Set a masjid as My Masjid from the <a href="/masjids" data-link>Masjids</a> tab</div>
      </div>`;
    return;
  }

  heroContainer.innerHTML = `
    <div class="sehri-iftari-card">
      <div class="sehri-iftari-header">
        <span class="sehri-iftari-badge">Today's Times</span>
        <span class="sehri-iftari-source">${config.display_name}</span>
      </div>
      <div class="sehri-iftari-body" id="sehriIftariBody">
        <div class="sehri-iftari-loading">
          <div class="skeleton-bone" style="width:80px;height:14px"></div>
          <div class="skeleton-bone" style="width:80px;height:14px"></div>
        </div>
      </div>
      <a href="/masjids" class="sehri-iftari-cta sehri-iftari-cta-mobile" data-link>Choose My Masjid</a>
      <div class="sehri-iftari-cta-desktop">Choose My Masjid below</div>
    </div>`;

  loadSehriIftari(config);
}

async function loadSehriIftari(config) {
  const body = document.getElementById('sehriIftariBody');
  if (!body) return;

  try {
    const csvFile = config.csv || config.slug + '.csv';
    const res = await fetch(`/data/${csvFile}`);
    if (!res.ok) { body.innerHTML = ''; return; }
    const text = await res.text();
    const csvData = parseCSV(text);
    const todayRow = getTodayRow(csvData);
    if (!todayRow) { body.innerHTML = '<div class="sehri-iftari-empty">No times available for today</div>'; return; }

    const sehri = todayRow['Sehri Ends'] || '';
    const maghrib = todayRow['Maghrib Iftari'] || '';

    const sehriFormatted = formatCardTime(sehri, true);
    const maghribFormatted = formatCardTime(maghrib, false);

    // Countdowns
    const now = new Date();
    const sehriDate = sehri ? parseTimeTodayWithAMPM(sehri, true) : null;
    const maghribDate = maghrib ? parseTimeTodayWithAMPM(maghrib, false) : null;
    const sehriCd = sehriDate && sehriDate > now ? formatCountdown(sehriDate - now) : null;
    const maghribCd = maghribDate && maghribDate > now ? formatCountdown(maghribDate - now) : null;

    body.innerHTML = `
      <div class="sehri-iftari-item">
        <div class="sehri-iftari-label">Sehri Ends</div>
        <div class="sehri-iftari-time">${sehriFormatted}</div>
        ${sehriCd ? `<div class="sehri-iftari-countdown">${sehriCd}</div>` : ''}
      </div>
      <div class="sehri-iftari-divider"></div>
      <div class="sehri-iftari-item">
        <div class="sehri-iftari-label">Maghrib/Iftari</div>
        <div class="sehri-iftari-time">${maghribFormatted}</div>
        ${maghribCd ? `<div class="sehri-iftari-countdown">${maghribCd}</div>` : ''}
      </div>`;

    // Update countdowns every minute
    if (heroCountdownInterval) clearInterval(heroCountdownInterval);
    heroCountdownInterval = setInterval(() => {
      const b = document.getElementById('sehriIftariBody');
      if (!b) { clearInterval(heroCountdownInterval); heroCountdownInterval = null; return; }
      loadSehriIftari(config);
    }, 60000);
  } catch {
    body.innerHTML = '';
  }
}

// --- Recently viewed ---

function renderRecentlyViewed() {
  const section = document.getElementById('recentSection');
  if (!section) return;

  const recentSlugs = getRecentSlugs();
  const pinnedSlug = localStorage.getItem('iqamah-pinned-masjid');

  // Filter out pinned masjid and only show ones that exist in configs
  const recentConfigs = recentSlugs
    .filter(s => s !== pinnedSlug)
    .map(s => cachedConfigs.find(c => c.slug === s))
    .filter(Boolean)
    .slice(0, 3);

  if (recentConfigs.length === 0) {
    section.innerHTML = `
      <div class="recent-section">
        <div class="masjid-scroll-header">
          <span class="masjid-scroll-title">Recently Viewed</span>
        </div>
        ${window.innerWidth >= 768
          ? `<div class="recent-hint-card">
              <div class="recent-hint-icon">${MOSQUE_SVG}</div>
              <div class="recent-hint-text">Masjids you view will appear here</div>
            </div>`
          : `<a href="/masjids" class="recent-hint-card" data-link>
              <div class="recent-hint-icon">${MOSQUE_SVG}</div>
              <div class="recent-hint-text">Masjids you view will appear here</div>
            </a>`
        }
      </div>`;
    return;
  }

  section.innerHTML = `
    <div class="recent-section">
      <div class="masjid-scroll-header">
        <span class="masjid-scroll-title">Recently Viewed</span>
      </div>
      <div class="masjid-grid">
        ${recentConfigs.map(config => {
          const shortAddr = getCityPostcode(config.address);
          const fullAddr = config.address || '';
          const isPending = config.approved === false;
          let subHtml = '';
          if (isPending) {
            subHtml = `<div class="masjid-card-sub"><span class="pending-badge">Pending Review</span></div>`;
          } else if (config.address) {
            subHtml = `<div class="masjid-card-sub"><span class="addr-short">${shortAddr}</span><span class="addr-full">${fullAddr}</span></div>`;
          }
          return `<a href="/${config.slug}" class="masjid-card" data-link>
            <div class="masjid-card-top">
              <div class="masjid-card-thumb">${MOSQUE_SVG}</div>
              <div class="masjid-card-info">
                <div class="masjid-name">${config.display_name}</div>
                ${subHtml}
              </div>
            </div>
            <div class="masjid-card-bottom">
              <div class="masjid-card-next" data-recent-next="${config.slug}">
                <div class="skeleton-bone" style="width:40px;height:8px;margin-bottom:4px"></div>
                <div class="skeleton-bone" style="width:56px;height:12px"></div>
              </div>
              <div class="masjid-card-chevron">${CHEVRON_SVG}</div>
            </div>
          </a>`;
        }).join('')}
      </div>
    </div>`;

  loadRecentCardPrayers(recentConfigs);
}

function getRecentSlugs() {
  try {
    return JSON.parse(localStorage.getItem('iqamah-recent-masjids') || '[]');
  } catch { return []; }
}

// --- Prayer time helpers ---

function parseTimeTodayWithAMPM(timeStr, isAM) {
  const parts = timeStr.trim().split(':');
  if (parts.length < 2) return null;
  let hours = parseInt(parts[0]);
  const minutes = parseInt(parts[1]);
  if (isNaN(hours) || isNaN(minutes)) return null;
  if (!isAM && hours !== 12) hours += 12;
  if (isAM && hours === 12) hours = 0;
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
}

function getNextJamaatFromRow(row) {
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
      if (row[key]) { timeStr = row[key]; break; }
    }
    if (!timeStr && prayer.defaultTime) timeStr = prayer.defaultTime;
    if (!timeStr) continue;
    const date = parseTimeTodayWithAMPM(timeStr, prayer.isAM);
    if (date && date > now) {
      const diff = date.getTime() - now.getTime();
      return { name: prayer.name, time: timeStr, countdown: formatCountdown(diff), isAM: prayer.isAM };
    }
  }
  return null;
}

function getNextStartFromRow(row) {
  const prayers = [
    { name: 'Sehri', keys: ['Sehri Ends'], isAM: true },
    { name: 'Dhuhr', keys: ['Zohr Start', 'Zuhr Start', 'Zohr'], isAM: false },
    { name: 'Asr', keys: ['Asr Start', 'Asr'], isAM: false },
    { name: 'Maghrib', keys: ['Maghrib Iftari'], isAM: false },
    { name: 'Esha', keys: ['Esha Start', 'Isha Start', 'Esha'], isAM: false },
  ];
  const now = new Date();
  for (const prayer of prayers) {
    let timeStr = null;
    for (const key of prayer.keys) {
      if (row[key]) { timeStr = row[key]; break; }
    }
    if (!timeStr) continue;
    const date = parseTimeTodayWithAMPM(timeStr, prayer.isAM);
    if (date && date > now) {
      const diff = date.getTime() - now.getTime();
      return { name: prayer.name, time: timeStr, countdown: formatCountdown(diff), isAM: prayer.isAM };
    }
  }
  return null;
}

function formatTimeDisplay(timeStr, isAM) {
  const parts = timeStr.trim().split(':');
  if (parts.length < 2) return timeStr;
  const h = parseInt(parts[0]);
  const m = parts[1];
  if (localStorage.getItem('iqamah-time-format') === '12') {
    return `${h}:${m} <span class="hero-next-ampm">${isAM ? 'AM' : 'PM'}</span>`;
  }
  // 24h: convert using isAM flag
  const h24 = isAM ? (h === 12 ? 0 : h) : (h === 12 ? 12 : h + 12);
  return `${h24}:${m}`;
}

function formatCardTime(timeStr, isAM) {
  const parts = timeStr.trim().split(':');
  if (parts.length < 2) return timeStr;
  const h = parseInt(parts[0]);
  const m = parts[1];
  if (localStorage.getItem('iqamah-time-format') === '12') {
    return `${h}:${m} ${isAM ? 'AM' : 'PM'}`;
  }
  const h24 = isAM ? (h === 12 ? 0 : h) : (h === 12 ? 12 : h + 12);
  return `${h24}:${m}`;
}

// --- Hero next prayer ---

async function loadHeroNextPrayer(config) {
  const startPanel = document.getElementById('heroNextStart');
  const jamaatPanel = document.getElementById('heroNextJamaat');
  if (!startPanel && !jamaatPanel) return;

  try {
    const csvFile = config.csv || config.slug + '.csv';
    const res = await fetch(`/data/${csvFile}`);
    if (!res.ok) { if (startPanel) startPanel.innerHTML = ''; if (jamaatPanel) jamaatPanel.innerHTML = ''; return; }
    const text = await res.text();
    const csvData = parseCSV(text);
    const todayRow = getTodayRow(csvData);
    if (!todayRow) { if (startPanel) startPanel.innerHTML = ''; if (jamaatPanel) jamaatPanel.innerHTML = ''; return; }

    updateHeroPanels(todayRow);

    if (heroCountdownInterval) clearInterval(heroCountdownInterval);
    heroCountdownInterval = setInterval(() => {
      const s = document.getElementById('heroNextStart');
      if (!s) { clearInterval(heroCountdownInterval); heroCountdownInterval = null; return; }
      updateHeroPanels(todayRow);
    }, 60000);
  } catch {
    if (startPanel) startPanel.innerHTML = '';
    if (jamaatPanel) jamaatPanel.innerHTML = '';
  }
}

function updateHeroPanels(todayRow) {
  const startPanel = document.getElementById('heroNextStart');
  const jamaatPanel = document.getElementById('heroNextJamaat');

  // Next start time
  if (startPanel) {
    const nextStart = getNextStartFromRow(todayRow);
    if (nextStart) {
      startPanel.innerHTML = `
        <div class="hero-next-label">Next Start</div>
        <div class="hero-next-time">${formatTimeDisplay(nextStart.time, nextStart.isAM)}</div>
        <div class="hero-next-detail">${nextStart.name}${nextStart.countdown ? ` <span class="hero-next-countdown">${nextStart.countdown}</span>` : ''}</div>`;
    } else {
      startPanel.innerHTML = `<div class="hero-next-label">No more prayers today</div>`;
    }
  }

  // Next jama'at time
  if (jamaatPanel) {
    const nextJamaat = getNextJamaatFromRow(todayRow);
    if (nextJamaat) {
      jamaatPanel.innerHTML = `
        <div class="hero-next-label">Next Jama'at</div>
        <div class="hero-next-time">${formatTimeDisplay(nextJamaat.time, nextJamaat.isAM)}</div>
        <div class="hero-next-detail">${nextJamaat.name}${nextJamaat.countdown ? ` <span class="hero-next-countdown">${nextJamaat.countdown}</span>` : ''}</div>`;
    } else {
      jamaatPanel.innerHTML = `<div class="hero-next-label">No more jama'at today</div>`;
    }
  }
}

// --- Recent card prayers ---

async function loadRecentCardPrayers(configs) {
  for (const config of configs) {
    const el = document.querySelector(`[data-recent-next="${config.slug}"]`);
    if (!el) continue;
    try {
      const csvFile = config.csv || config.slug + '.csv';
      const res = await fetch(`/data/${csvFile}`);
      if (!res.ok) { el.innerHTML = ''; continue; }
      const text = await res.text();
      const csvData = parseCSV(text);
      const todayRow = getTodayRow(csvData);
      if (!todayRow) { el.innerHTML = ''; continue; }
      const next = getNextJamaatFromRow(todayRow);
      if (next) {
        el.innerHTML = `
          <span class="masjid-card-next-label">${next.name}</span>
          <span class="masjid-card-next-time">${formatCardTime(next.time, next.isAM)}</span>`;
      } else {
        el.innerHTML = '';
      }
    } catch {
      el.innerHTML = '';
    }
  }
}

// --- Hero interactions ---

function setupHeroClicks() {
  document.addEventListener('click', handleHeroClick, true);
}

function handleHeroClick(e) {
  const unpinBtn = e.target.closest('.hero-unpin-btn');
  if (!unpinBtn) return;
  const homeView = e.target.closest('.home-view');
  if (!homeView) return;

  e.preventDefault();
  e.stopPropagation();
  localStorage.removeItem('iqamah-pinned-masjid');
  showToast('Removed from My Masjid');
  renderHero();
  renderRecentlyViewed();
  if (masjidsModule && masjidsModule.renderCards) masjidsModule.renderCards();
}

function showToast(html) {
  const toast = document.getElementById('pinToast');
  if (!toast) return;
  toast.innerHTML = html;
  toast.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2500);
}

// --- Install banner ---

function setupInstallBanner() {
  if (isStandalone()) return;
  const banner = document.getElementById('installBanner');
  if (!banner) return;

  function showAndroidBanner() {
    if (banner.classList.contains('visible')) return;
    banner.classList.add('has-button');
    banner.innerHTML = `
      <button class="install-dismiss" aria-label="Dismiss">&times;</button>
      <div class="install-banner-text"><strong>Install Iqamah</strong> for quick access from your home screen.</div>
      <button class="install-btn">Install</button>`;
    banner.classList.add('visible');
    banner.querySelector('.install-btn').addEventListener('click', () => {
      promptInstall().then(accepted => {
        if (accepted) banner.classList.remove('visible');
      });
    });
    banner.querySelector('.install-dismiss').addEventListener('click', () => {
      banner.classList.remove('visible');
    });
  }

  if (canInstall()) {
    showAndroidBanner();
  } else if (isIOSSafari()) {
    banner.innerHTML = `
      <button class="install-dismiss" aria-label="Dismiss">&times;</button>
      <div class="install-banner-text"><strong>Install Iqamah</strong> — tap <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin: 0 2px;"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> then <strong>"Add to Home Screen"</strong>.</div>`;
    banner.classList.add('visible');
    banner.querySelector('.install-dismiss').addEventListener('click', () => {
      banner.classList.remove('visible');
    });
  } else {
    // Listen for late-firing beforeinstallprompt
    const onPrompt = () => {
      showAndroidBanner();
      window.removeEventListener('beforeinstallprompt', onPrompt);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
  }
}

// --- Pin sync (from embedded masjid list) ---

function onPinChanged() {
  renderHero();
  renderRecentlyViewed();
}

// --- Desktop masjid list ---

async function loadDesktopMasjidList() {
  if (window.innerWidth < 768) return;
  const container = document.getElementById('desktopMasjidList');
  if (!container) return;

  try {
    masjidsModule = await import('./masjids.js');
    masjidsModule.render(container);
  } catch (err) {
    console.error('Could not load masjid list:', err);
  }
}

export function destroy() {
  if (heroCountdownInterval) {
    clearInterval(heroCountdownInterval);
    heroCountdownInterval = null;
  }
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  if (masjidsModule) {
    masjidsModule.destroy();
    masjidsModule = null;
  }
  document.removeEventListener('click', handleHeroClick, true);
  window.removeEventListener('iqamah-pin-changed', onPinChanged);
}
