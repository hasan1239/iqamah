// Home view — hero card (pinned masjid) + recently viewed
import { navigate } from '../router.js';
import { canInstall, promptInstall, isStandalone, isIOSSafari } from '../utils/pwa.js';
import { parseCSV, getTodayRow } from '../utils/csv.js';
import { formatCountdown } from '../utils/countdown.js';

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
  const userName = localStorage.getItem('prayerly-user-name');
  let greetingHTML;
  if (userName) {
    greetingHTML = `<div class="greeting-salaam">Assalamu Alaikum,</div><div class="greeting-name">${userName}</div>`;
  } else {
    greetingHTML = `<div class="greeting-salaam">Assalamu Alaikum</div>`;
  }

  container.innerHTML = `
    <div class="home-view">
      <header class="home-header">
        <div class="header-content">
          <img src="/salahdaily_icon.png" alt="Prayerly" class="logo">
          <h1>Prayerly</h1>
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
  window.addEventListener('prayerly-pin-changed', onPinChanged);
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

  const pinnedSlug = localStorage.getItem('prayerly-pinned-masjid');
  const pinnedConfig = pinnedSlug ? cachedConfigs.find(c => c.slug === pinnedSlug) : null;

  if (!pinnedConfig) {
    heroContainer.innerHTML = `
      <div class="home-no-hero">
        <div class="home-no-hero-icon">${MOSQUE_SVG}</div>
        <div class="home-no-hero-text">No masjid selected</div>
        <div class="home-no-hero-sub">Set a masjid as your primary from the <a href="/masjids" data-link>Masjids</a> tab</div>
      </div>`;
    return;
  }

  heroContainer.innerHTML = `
    <div class="hero-card">
      <div class="hero-header">
        <span class="hero-badge hero-badge-primary">My Masjid</span>
        <button class="hero-unpin-btn" data-slug="${pinnedConfig.slug}" data-hero="true" aria-label="Unpin ${pinnedConfig.display_name}" title="Unpin masjid">
          ${STAR_FILLED_SVG}
        </button>
      </div>
      <div class="hero-name">${pinnedConfig.display_name}</div>
      <div class="hero-body">
        <div class="hero-next-prayer" id="heroNextPrayer">
          <div class="hero-next-skeleton">
            <div class="skeleton-bone"></div>
            <div class="skeleton-bone"></div>
          </div>
        </div>
        <div class="hero-actions">
          <a href="/${pinnedConfig.slug}" class="hero-view-btn" data-link>${CLOCK_SVG} View Times</a>
        </div>
      </div>
    </div>`;

  loadHeroNextPrayer(pinnedConfig);
}

// --- Recently viewed ---

function renderRecentlyViewed() {
  const section = document.getElementById('recentSection');
  if (!section) return;

  const recentSlugs = getRecentSlugs();
  const pinnedSlug = localStorage.getItem('prayerly-pinned-masjid');

  // Filter out pinned masjid and only show ones that exist in configs
  const recentConfigs = recentSlugs
    .filter(s => s !== pinnedSlug)
    .map(s => cachedConfigs.find(c => c.slug === s))
    .filter(Boolean)
    .slice(0, window.innerWidth >= 768 ? 3 : 4);

  if (recentConfigs.length === 0) {
    section.innerHTML = '';
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
          return `<a href="/${config.slug}" class="masjid-card" data-link>
            <div class="masjid-card-top">
              <div class="masjid-card-thumb">${MOSQUE_SVG}</div>
              <div class="masjid-card-info">
                <div class="masjid-name">${config.display_name}</div>
                ${config.address ? `<div class="masjid-card-sub"><span class="addr-short">${shortAddr}</span><span class="addr-full">${fullAddr}</span></div>` : ''}
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
    return JSON.parse(localStorage.getItem('prayerly-recent-masjids') || '[]');
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

function getNextPrayerFromRow(row) {
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

function formatTimeDisplay(timeStr, isAM) {
  const parts = timeStr.trim().split(':');
  if (parts.length < 2) return timeStr;
  const h = parseInt(parts[0]);
  const m = parts[1];
  if (localStorage.getItem('prayerly-time-format') === '12') {
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
  if (localStorage.getItem('prayerly-time-format') === '12') {
    return `${h}:${m} ${isAM ? 'AM' : 'PM'}`;
  }
  const h24 = isAM ? (h === 12 ? 0 : h) : (h === 12 ? 12 : h + 12);
  return `${h24}:${m}`;
}

// --- Hero next prayer ---

async function loadHeroNextPrayer(config) {
  const panel = document.getElementById('heroNextPrayer');
  if (!panel) return;

  try {
    const csvFile = config.csv || config.slug + '.csv';
    const res = await fetch(`/data/${csvFile}`);
    if (!res.ok) { panel.innerHTML = ''; return; }
    const text = await res.text();
    const csvData = parseCSV(text);
    const todayRow = getTodayRow(csvData);
    if (!todayRow) { panel.innerHTML = ''; return; }

    updateHeroPanel(panel, todayRow);

    if (heroCountdownInterval) clearInterval(heroCountdownInterval);
    heroCountdownInterval = setInterval(() => {
      const p = document.getElementById('heroNextPrayer');
      if (!p) { clearInterval(heroCountdownInterval); heroCountdownInterval = null; return; }
      updateHeroPanel(p, todayRow);
    }, 60000);
  } catch {
    panel.innerHTML = '';
  }
}

function updateHeroPanel(panel, todayRow) {
  const next = getNextPrayerFromRow(todayRow);
  if (!next) {
    panel.innerHTML = `<div class="hero-next-label">No more prayers today</div>`;
    return;
  }
  panel.innerHTML = `
    <div class="hero-next-label">Next Prayer</div>
    <div class="hero-next-time">${formatTimeDisplay(next.time, next.isAM)}</div>
    <div class="hero-next-detail">${next.name}${next.countdown ? ` <span class="hero-next-countdown">${next.countdown}</span>` : ''}</div>`;
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
      const next = getNextPrayerFromRow(todayRow);
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
  localStorage.removeItem('prayerly-pinned-masjid');
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

  if (canInstall()) {
    banner.classList.add('has-button');
    banner.innerHTML = `
      <button class="install-dismiss" aria-label="Dismiss">&times;</button>
      <div class="install-banner-text"><strong>Install Prayerly</strong> for quick access from your home screen.</div>
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
  } else if (isIOSSafari()) {
    banner.innerHTML = `
      <button class="install-dismiss" aria-label="Dismiss">&times;</button>
      <div class="install-banner-text"><strong>Install Prayerly</strong> — tap <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin: 0 2px;"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> then <strong>"Add to Home Screen"</strong>.</div>`;
    banner.classList.add('visible');
    banner.querySelector('.install-dismiss').addEventListener('click', () => {
      banner.classList.remove('visible');
    });
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
  window.removeEventListener('prayerly-pin-changed', onPinChanged);
}
