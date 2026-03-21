// Home view — hero card (pinned masjid) + recently viewed
import { navigate } from '../router.js';
import { canInstall, promptInstall, isStandalone, isIOSSafari } from '../utils/pwa.js';
import { parseCSV, getTodayRow, getTomorrowRow } from '../utils/csv.js';
import { formatCountdown } from '../utils/countdown.js';
import { haversineDistance } from '../utils/geolocation.js';

let cachedConfigs = [];
let heroCountdownInterval = null;
let toastTimer = null;
let masjidsModule = null;
let seasonConfig = { season: 'ramadan', eid_date: '' };
let showEidContent = false;

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

      <div id="eidBrowseSlot"></div>

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

  // Welcome screen priority: Eid welcome > rebrand welcome (never both)
  // Eid welcome is deferred until season.json is loaded (see loadMasjids)
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
            <strong>Add Your Masjid <span class="beta-badge">BETA</span></strong>
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

function showEidWelcome() {
  if (localStorage.getItem('iqamah-eid-dismissed')) return;
  // Don't show if rebrand welcome is being shown
  if (!localStorage.getItem('iqamah-rebrand-dismissed')) return;

  const overlay = document.createElement('div');
  overlay.className = 'welcome-overlay eid-overlay';
  overlay.innerHTML = `
    <div class="eid-string-lights">
      <svg viewBox="0 0 400 40" preserveAspectRatio="none" width="100%" height="40">
        <path d="M0 0 Q50 35 100 15 Q150 -5 200 15 Q250 35 300 15 Q350 -5 400 0" fill="none" stroke="#c9a227" stroke-width="1.2" opacity="0.6"/>
        <path d="M0 0 Q60 40 120 18 Q180 -2 240 18 Q300 38 360 15 Q390 5 400 0" fill="none" stroke="#c9a227" stroke-width="1" opacity="0.35"/>
        ${Array.from({length: 16}, (_, i) => {
          const x = i * 26 + 10;
          const y = 15 + 12 * Math.sin((x / 400) * Math.PI * 2);
          return `<circle cx="${x}" cy="${y}" r="2.5" fill="#f0d060" opacity="0.7"/>`;
        }).join('')}
        ${Array.from({length: 14}, (_, i) => {
          const x = i * 30 + 15;
          const y = 18 + 12 * Math.sin((x / 400) * Math.PI * 2 + 0.8);
          return `<circle cx="${x}" cy="${y}" r="2" fill="#d4af37" opacity="0.45"/>`;
        }).join('')}
      </svg>
    </div>
    <div class="eid-lantern eid-lantern-1">
      <svg viewBox="0 0 30 90" width="26" height="80">
        <line x1="15" y1="0" x2="15" y2="25" stroke="#c9a227" stroke-width="1"/>
        <rect x="10" y="23" width="10" height="4" rx="1" fill="#c9a227"/>
        <path d="M7 27 Q7 25 9 25 L21 25 Q23 25 23 27 L23 58 Q23 66 15 66 Q7 66 7 58Z" fill="none" stroke="#c9a227" stroke-width="1.5"/>
        <path d="M7 27 Q7 25 9 25 L21 25 Q23 25 23 27 L23 58 Q23 66 15 66 Q7 66 7 58Z" fill="#d4af37" opacity="0.12"/>
        <ellipse cx="15" cy="45" rx="4" ry="8" fill="#d4af37" opacity="0.25"/>
        <ellipse cx="15" cy="45" rx="2" ry="4" fill="#f0d060" opacity="0.3"/>
      </svg>
    </div>
    <div class="eid-lantern eid-lantern-2">
      <svg viewBox="0 0 30 110" width="22" height="95">
        <line x1="15" y1="0" x2="15" y2="40" stroke="#c9a227" stroke-width="1"/>
        <rect x="10" y="38" width="10" height="4" rx="1" fill="#c9a227"/>
        <path d="M7 42 Q7 40 9 40 L21 40 Q23 40 23 42 L23 73 Q23 81 15 81 Q7 81 7 73Z" fill="none" stroke="#c9a227" stroke-width="1.5"/>
        <path d="M7 42 Q7 40 9 40 L21 40 Q23 40 23 42 L23 73 Q23 81 15 81 Q7 81 7 73Z" fill="#d4af37" opacity="0.12"/>
        <ellipse cx="15" cy="60" rx="4" ry="8" fill="#d4af37" opacity="0.25"/>
        <ellipse cx="15" cy="60" rx="2" ry="4" fill="#f0d060" opacity="0.3"/>
      </svg>
    </div>
    <div class="eid-lantern eid-lantern-3">
      <svg viewBox="0 0 30 100" width="26" height="85">
        <line x1="15" y1="0" x2="15" y2="30" stroke="#c9a227" stroke-width="1"/>
        <rect x="10" y="28" width="10" height="4" rx="1" fill="#c9a227"/>
        <path d="M7 32 Q7 30 9 30 L21 30 Q23 30 23 32 L23 63 Q23 71 15 71 Q7 71 7 63Z" fill="none" stroke="#c9a227" stroke-width="1.5"/>
        <path d="M7 32 Q7 30 9 30 L21 30 Q23 30 23 32 L23 63 Q23 71 15 71 Q7 71 7 63Z" fill="#d4af37" opacity="0.12"/>
        <ellipse cx="15" cy="50" rx="4" ry="8" fill="#d4af37" opacity="0.25"/>
        <ellipse cx="15" cy="50" rx="2" ry="4" fill="#f0d060" opacity="0.3"/>
      </svg>
    </div>
    <div class="eid-lantern eid-lantern-4">
      <svg viewBox="0 0 30 90" width="26" height="80">
        <line x1="15" y1="0" x2="15" y2="25" stroke="#c9a227" stroke-width="1"/>
        <rect x="10" y="23" width="10" height="4" rx="1" fill="#c9a227"/>
        <path d="M7 27 Q7 25 9 25 L21 25 Q23 25 23 27 L23 58 Q23 66 15 66 Q7 66 7 58Z" fill="none" stroke="#c9a227" stroke-width="1.5"/>
        <path d="M7 27 Q7 25 9 25 L21 25 Q23 25 23 27 L23 58 Q23 66 15 66 Q7 66 7 58Z" fill="#d4af37" opacity="0.12"/>
        <ellipse cx="15" cy="45" rx="4" ry="8" fill="#d4af37" opacity="0.25"/>
        <ellipse cx="15" cy="45" rx="2" ry="4" fill="#f0d060" opacity="0.3"/>
      </svg>
    </div>
    <div class="eid-lantern eid-lantern-5">
      <svg viewBox="0 0 30 110" width="22" height="95">
        <line x1="15" y1="0" x2="15" y2="40" stroke="#c9a227" stroke-width="1"/>
        <rect x="10" y="38" width="10" height="4" rx="1" fill="#c9a227"/>
        <path d="M7 42 Q7 40 9 40 L21 40 Q23 40 23 42 L23 73 Q23 81 15 81 Q7 81 7 73Z" fill="none" stroke="#c9a227" stroke-width="1.5"/>
        <path d="M7 42 Q7 40 9 40 L21 40 Q23 40 23 42 L23 73 Q23 81 15 81 Q7 81 7 73Z" fill="#d4af37" opacity="0.12"/>
        <ellipse cx="15" cy="60" rx="4" ry="8" fill="#d4af37" opacity="0.25"/>
        <ellipse cx="15" cy="60" rx="2" ry="4" fill="#f0d060" opacity="0.3"/>
      </svg>
    </div>
    <div class="eid-lantern eid-lantern-6">
      <svg viewBox="0 0 30 100" width="20" height="75">
        <line x1="15" y1="0" x2="15" y2="30" stroke="#c9a227" stroke-width="1"/>
        <rect x="10" y="28" width="10" height="4" rx="1" fill="#c9a227"/>
        <path d="M7 32 Q7 30 9 30 L21 30 Q23 30 23 32 L23 63 Q23 71 15 71 Q7 71 7 63Z" fill="none" stroke="#c9a227" stroke-width="1.5"/>
        <path d="M7 32 Q7 30 9 30 L21 30 Q23 30 23 32 L23 63 Q23 71 15 71 Q7 71 7 63Z" fill="#d4af37" opacity="0.12"/>
        <ellipse cx="15" cy="50" rx="4" ry="8" fill="#d4af37" opacity="0.25"/>
        <ellipse cx="15" cy="50" rx="2" ry="4" fill="#f0d060" opacity="0.3"/>
      </svg>
    </div>
    <div class="welcome-card eid-welcome-card">
      <div class="eid-welcome-crescent">
        <img src="/templates/crescent2.svg" alt="" width="180" height="180">
      </div>
      <h1 class="eid-welcome-title">Eid Mubarak!</h1>
      <p class="eid-welcome-arabic">تَقَبَّلَ اللهُ مِنَّا وَمِنكُم</p>
      <p class="eid-welcome-dua">Taqabbalallahu minna wa minkum</p>
      <a href="/eid" class="welcome-btn eid-welcome-btn" id="eidWelcomeBtn" data-link>View Eid Salah Times</a>
    </div>
    <div class="eid-welcome-icon"><img src="/iqamah-icon-transparent.png" alt=""></div>
  `;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('visible'));

  overlay.querySelector('#eidWelcomeBtn').addEventListener('click', (e) => {
    e.preventDefault();
    overlay.classList.remove('visible');
    overlay.addEventListener('transitionend', () => overlay.remove());
    localStorage.setItem('iqamah-eid-dismissed', '1');
    // Navigate after dismiss
    import('../router.js').then(({ navigate }) => navigate('/eid'));
  });

  // Also dismiss on clicking overlay background
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      overlay.classList.remove('visible');
      overlay.addEventListener('transitionend', () => overlay.remove());
      localStorage.setItem('iqamah-eid-dismissed', '1');
    }
  });
}

function renderEidBrowseButton() {
  const slot = document.getElementById('eidBrowseSlot');
  if (!slot) return;

  if (seasonConfig.season === 'eid') {
    showEidWelcome();
  }

  if (showEidContent) {
    showEidBrowse(slot);
  }
}

function showEidBrowse(slot) {
  const EID_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  const CHEVRON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
  slot.innerHTML = `
    <div class="home-browse-all">
      <a href="/eid" class="home-browse-btn" data-link>
        ${EID_SVG}
        <span>Browse All Eid Salahs</span>
        ${CHEVRON_SVG}
      </a>
    </div>`;
}

async function isRamadanEndingSoon() {
  try {
    // Use pinned masjid or best masjid to check today's hijri date
    const pinnedSlug = localStorage.getItem('iqamah-pinned-masjid');
    const config = pinnedSlug
      ? cachedConfigs.find(c => c.slug === pinnedSlug)
      : findBestMasjid();
    if (!config) return false;
    const csvFile = config.csv || config.slug + '.csv';
    const res = await fetch(`/data/${csvFile}`);
    if (!res.ok) return false;
    const csvData = parseCSV(await res.text());
    const todayRow = getTodayRow(csvData);
    if (!todayRow) return false;
    const hijri = (todayRow['Islamic Day'] || todayRow['Ramadan'] || todayRow['Hijri'] || '').trim();
    // Check if hijri day is 28, 29 or 30 Ramadan
    const match = hijri.match(/^(\d+)\s+Ram/i);
    if (!match) return false;
    const hijriDay = parseInt(match[1]);
    return hijriDay >= 28;
  } catch {
    return false;
  }
}

function updateGreetingForSeason() {
  if (seasonConfig.season !== 'eid') return;
  const greetingEl = document.querySelector('.greeting');
  if (!greetingEl) return;
  const userName = localStorage.getItem('iqamah-user-name');
  greetingEl.className = 'greeting eid-greeting';
  greetingEl.innerHTML = userName
    ? `<div class="eid-greeting-title">Eid Mubarak,</div><div class="eid-greeting-name">${userName}!</div>`
    : `<div class="eid-greeting-title">Eid Mubarak!</div>`;
}

async function loadMasjids() {
  try {
    const [masjidRes, seasonRes] = await Promise.all([
      fetch('/data/mosques/index.json'),
      fetch('/data/season.json').catch(() => null),
    ]);
    if (!masjidRes.ok) return;
    cachedConfigs = (await masjidRes.json()).filter(c => !c.test_masjid);
    if (seasonRes && seasonRes.ok) {
      try { seasonConfig = await seasonRes.json(); } catch {}
    }
    // Determine if Eid content should show
    if (seasonConfig.season === 'eid') {
      showEidContent = true;
    } else if (seasonConfig.season === 'ramadan') {
      showEidContent = await isRamadanEndingSoon();
    }

    renderHero();
    renderRecentlyViewed();
    renderEidBrowseButton();
    updateGreetingForSeason();
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

  // Eid pills for hero card
  let heroEidHtml = '';
  if (showEidContent && pinnedConfig.eid_salah) {
    const regex = /(\d{1,2}(?::\d{2})?)\s*(am|pm)/gi;
    const pills = [];
    let m;
    while ((m = regex.exec(pinnedConfig.eid_salah)) !== null) {
      pills.push(`<span class="eid-time-pill">${m[0]}</span>`);
    }
    if (pills.length > 0) {
      const salahLabel = 'Eid Salah:';
      heroEidHtml = `<div class="hero-eid-times"><span class="hero-eid-label">${salahLabel}</span>${pills.join('')}</div>`;
    }
  }

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
      ${heroEidHtml}
      <div class="sehri-iftari-body" id="heroNextPrayer">
        <div class="sehri-iftari-loading">
          <div class="skeleton-bone" style="width:80px;height:14px"></div>
          <div class="skeleton-bone" style="width:80px;height:14px"></div>
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

  // Only show Sehri/Iftari card in ramadan mode
  if (seasonConfig.season === 'ramadan') {
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
    return;
  }

  // Default/eid mode: show next prayer card like pinned hero
  heroContainer.innerHTML = `
    <div class="sehri-iftari-card">
      <div class="sehri-iftari-header">
        <span class="sehri-iftari-badge">Today's Times</span>
        <span class="sehri-iftari-source">${config.display_name}</span>
      </div>
      <div class="sehri-iftari-body" id="suggestedNextPrayer">
        <div class="sehri-iftari-loading">
          <div class="skeleton-bone" style="width:80px;height:14px"></div>
          <div class="skeleton-bone" style="width:80px;height:14px"></div>
        </div>
      </div>
      <a href="/masjids" class="sehri-iftari-cta sehri-iftari-cta-mobile" data-link>Choose My Masjid</a>
      <div class="sehri-iftari-cta-desktop">Choose My Masjid below</div>
    </div>`;
  loadSuggestedNextPrayer(config);
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
        <div class="sehri-iftari-label">Maghrib/Iftar</div>
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

async function loadSuggestedNextPrayer(config) {
  const body = document.getElementById('suggestedNextPrayer');
  if (!body) return;

  try {
    const csvFile = config.csv || config.slug + '.csv';
    const res = await fetch(`/data/${csvFile}`);
    if (!res.ok) { body.innerHTML = ''; return; }
    const text = await res.text();
    const csvData = parseCSV(text);
    const todayRow = getTodayRow(csvData);
    if (!todayRow) { body.innerHTML = '<div class="sehri-iftari-empty">No times available for today</div>'; return; }

    function renderSuggestedPanels() {
      const nextStart = getNextStartFromRow(todayRow);
      const nextJamaat = getNextJamaatFromRow(todayRow);
      const startHtml = nextStart
        ? `<div class="sehri-iftari-item">
            <div class="sehri-iftari-label">Next Start</div>
            <div class="sehri-iftari-time">${formatCardTime(nextStart.time, nextStart.isAM)}</div>
            <div class="sehri-iftari-countdown">${nextStart.name}${nextStart.countdown ? ' ' + nextStart.countdown : ''}</div>
          </div>`
        : `<div class="sehri-iftari-item"><div class="sehri-iftari-label">No more prayers today</div></div>`;
      const jamaatHtml = nextJamaat
        ? `<div class="sehri-iftari-item">
            <div class="sehri-iftari-label">Next Jama'at</div>
            <div class="sehri-iftari-time">${formatCardTime(nextJamaat.time, nextJamaat.isAM)}</div>
            <div class="sehri-iftari-countdown">${nextJamaat.name}${nextJamaat.countdown ? ' ' + nextJamaat.countdown : ''}</div>
          </div>`
        : `<div class="sehri-iftari-item"><div class="sehri-iftari-label">No more jama'at today</div></div>`;
      body.innerHTML = `${startHtml}<div class="sehri-iftari-divider"></div>${jamaatHtml}`;
    }

    renderSuggestedPanels();

    if (heroCountdownInterval) clearInterval(heroCountdownInterval);
    heroCountdownInterval = setInterval(() => {
      const b = document.getElementById('suggestedNextPrayer');
      if (!b) { clearInterval(heroCountdownInterval); heroCountdownInterval = null; return; }
      renderSuggestedPanels();
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
  const sehriLabel = seasonConfig.season === 'ramadan' ? 'Sehri' : 'Fajr';
  const prayers = [
    { name: sehriLabel, keys: ['Sehri Ends', 'Fajr Start', 'Subha Sadiq'], isAM: true },
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
  const body = document.getElementById('heroNextPrayer');
  if (!body) return;

  try {
    const csvFile = config.csv || config.slug + '.csv';
    const res = await fetch(`/data/${csvFile}`);
    if (!res.ok) { body.innerHTML = ''; return; }
    const text = await res.text();
    const csvData = parseCSV(text);
    const todayRow = getTodayRow(csvData);
    if (!todayRow) {
      body.innerHTML = `<a href="/update/${config.slug}" data-link class="hero-upload-cta" onclick="event.stopPropagation()">Upload timetable</a>`;
      return;
    }

    function renderHeroPanels() {
      const nextStart = getNextStartFromRow(todayRow);
      const nextJamaat = getNextJamaatFromRow(todayRow);

      // If both have upcoming prayers, show them
      if (nextStart || nextJamaat) {
        const startHtml = nextStart
          ? `<div class="sehri-iftari-item">
              <div class="sehri-iftari-label">Next Start</div>
              <div class="sehri-iftari-time">${formatCardTime(nextStart.time, nextStart.isAM)}</div>
              <div class="sehri-iftari-countdown">${nextStart.name}${nextStart.countdown ? ' ' + nextStart.countdown : ''}</div>
            </div>`
          : `<div class="sehri-iftari-item">
              <div class="sehri-iftari-label">Next Start</div>
              <div class="sehri-iftari-countdown">Done for today</div>
            </div>`;
        const jamaatHtml = nextJamaat
          ? `<div class="sehri-iftari-item">
              <div class="sehri-iftari-label">Next Jama'at</div>
              <div class="sehri-iftari-time">${formatCardTime(nextJamaat.time, nextJamaat.isAM)}</div>
              <div class="sehri-iftari-countdown">${nextJamaat.name}${nextJamaat.countdown ? ' ' + nextJamaat.countdown : ''}</div>
            </div>`
          : `<div class="sehri-iftari-item">
              <div class="sehri-iftari-label">Next Jama'at</div>
              <div class="sehri-iftari-countdown">Done for today</div>
            </div>`;
        body.innerHTML = `${startHtml}<div class="sehri-iftari-divider"></div>${jamaatHtml}`;
        return;
      }

      // All prayers done — show tomorrow's Fajr if available
      const tomorrowRow = getTomorrowRow(csvData);
      if (tomorrowRow) {
        const fajrStart = tomorrowRow['Fajr Start'] || tomorrowRow['Subha Sadiq'] || tomorrowRow['Sehri Ends'] || '';
        const fajrJamaat = tomorrowRow["Fajr Jama'at"] || '';
        const startHtml = fajrStart
          ? `<div class="sehri-iftari-item">
              <div class="sehri-iftari-label">Tomorrow's Fajr</div>
              <div class="sehri-iftari-time">${formatCardTime(fajrStart, true)}</div>
            </div>`
          : '';
        const jamaatHtml = fajrJamaat
          ? `<div class="sehri-iftari-item">
              <div class="sehri-iftari-label">Fajr Jama'at</div>
              <div class="sehri-iftari-time">${formatCardTime(fajrJamaat, true)}</div>
            </div>`
          : '';
        if (startHtml || jamaatHtml) {
          body.innerHTML = startHtml && jamaatHtml
            ? `${startHtml}<div class="sehri-iftari-divider"></div>${jamaatHtml}`
            : startHtml || jamaatHtml;
          return;
        }
      }

      // No tomorrow data either — collapse
      body.innerHTML = '';
    }

    renderHeroPanels();

    if (heroCountdownInterval) clearInterval(heroCountdownInterval);
    heroCountdownInterval = setInterval(() => {
      const b = document.getElementById('heroNextPrayer');
      if (!b) { clearInterval(heroCountdownInterval); heroCountdownInterval = null; return; }
      renderHeroPanels();
    }, 60000);
  } catch {
    body.innerHTML = '';
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
  if (localStorage.getItem('iqamah-install-dismissed')) return;
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
      localStorage.setItem('iqamah-install-dismissed', '1');
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
      localStorage.setItem('iqamah-install-dismissed', '1');
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
