// Home view — hero card (pinned masjid) + recently viewed
import { navigate } from '../router.js';
import { canInstall, promptInstall, isStandalone, isIOSSafari } from '../utils/pwa.js';
import { parseCSV, getTodayRow, getTomorrowRow } from '../utils/csv.js';
import { formatCountdown } from '../utils/countdown.js';
import { haversineDistance, getCurrentPosition } from '../utils/geolocation.js';
import { getOthers, getMyMasjid, clearMyMasjid } from '../utils/follow.js';
import { loadMasjidIndex } from '../utils/masjid-index.js';
// Tracker data layer (no side effects on import — top level is constants and
// function declarations only). Powers the "Today's Prayers" check-in card.
import { readLog, setPrayerStatus, computeStreaks, localDateKey, PRAYERS, STATUSES } from './tracker.js';
import { getTodayDua } from '../utils/duas.js';

let cachedConfigs = [];
let heroCountdownInterval = null;
let toastTimer = null;
let masjidsModule = null;
let seasonConfig = { season: 'ramadan', eid_date: '' };
let showEidContent = false;

// --- Feature-pack state (time-to-leave line + check-in card) ---
let heroLeaveLoc = null;        // {lat, lon} | null — user location, resolved silently
let heroLeaveLocPromise = null; // dedupes the silent location resolution per render
let checkinPickerFor = null;    // prayer key | null — open status picker on the check-in card
let checkinDocHandler = null;   // document-level capture handler that closes the picker

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
const WALK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="13" cy="4" r="1.8"/><path d="M13 7.5L11.5 13l2.5 3 .5 5"/><path d="M11.5 13L9 20.5"/><path d="M13 7.5l3 2 2 .5"/><path d="M13 7.5L10.5 9l-1 3"/></svg>';
const FLAME_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>';
const HCK_CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
const HCK_DASH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="6" y1="12" x2="18" y2="12"/></svg>';

export function render(container) {
  // Reset feature-pack state from any previous render
  checkinPickerFor = null;
  heroLeaveLoc = null;
  heroLeaveLocPromise = null;

  const userName = localStorage.getItem('iqamah-user-name');
  let greetingHTML;
  if (userName) {
    greetingHTML = `<div class="greeting-salaam">Assalamu Alaikum,</div><div class="greeting-name">${userName}</div>`;
  } else {
    greetingHTML = `<div class="greeting-salaam">Assalamu Alaikum</div>`;
  }

  // The "Prayerly is now Iqamah" rebrand welcome is retired — no longer shown
  // to anyone. showWelcomeScreen() below is kept as a template for future
  // feature-announcement overlays (e.g. the map / new-masjids showcase).
  const showRebrand = false;

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

      <div id="yourMasjidsSection"></div>

      <div id="checkInSection"></div>

      <div id="recentSection"></div>

      <div id="duaSection"></div>

      <div id="desktopMasjidList" class="desktop-masjid-list"></div>

      <div class="install-banner" id="installBanner"></div>

      <div class="pin-toast" id="pinToast"></div>
    </div>
  `;

  loadMasjids();
  setupHeroClicks();
  setupInstallBanner();
  loadDesktopMasjidList();
  setupCheckInCard();
  renderDuaCard();

  // Rebrand welcome is retired (showRebrand is always false). The call is kept
  // so showWelcomeScreen() stays as a working template for future overlays.
  // The Eid welcome (deferred until season.json loads, see loadMasjids) is now
  // the only overlay actually shown.
  if (showRebrand) {
    showWelcomeScreen();
  }
  window.addEventListener('iqamah-pin-changed', onPinChanged);
  window.addEventListener('iqamah-follow-changed', onFollowChanged);
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
    const [masjidIndex, seasonRes] = await Promise.all([
      loadMasjidIndex(),
      fetch('/data/season.json').catch(() => null),
    ]);
    cachedConfigs = masjidIndex.filter(c =>
      !c.test_masjid && !c.hidden && !(c.quality && c.quality.status === 'needs_review')
    );
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
    renderYourMasjids();
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

  const pinnedSlug = getMyMasjid();
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
          <button class="hero-unpin-btn" data-slug="${pinnedConfig.slug}" data-hero="true" aria-label="Unset ${pinnedConfig.display_name} as My Masjid" title="Unset My Masjid">
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
      <div class="hero-leave-line" id="heroLeaveLine" hidden></div>
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
      const coordOf = c => ({
        lat: c.lat != null ? c.lat : c.latitude,
        lon: c.lon != null ? c.lon : c.longitude,
      });
      const withCoords = approved
        .map(c => ({ c, ...coordOf(c) }))
        .filter(x => x.lat != null && x.lon != null);
      if (withCoords.length > 0) {
        withCoords.sort((a, b) =>
          haversineDistance(cached.lat, cached.lon, a.lat, a.lon) -
          haversineDistance(cached.lat, cached.lon, b.lat, b.lon)
        );
        return withCoords[0].c;
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

      // All prayers done — show tomorrow's Fajr
      const tomorrowRow = getTomorrowRow(csvData);
      if (tomorrowRow) {
        const fajrStart = tomorrowRow['Fajr Start'] || tomorrowRow['Subha Sadiq'] || tomorrowRow['Sehri Ends'] || '';
        const fajrJamaat = tomorrowRow["Fajr Jama'at"] || '';
        if (fajrStart || fajrJamaat) {
          const startHtml = fajrStart
            ? `<div class="sehri-iftari-item"><div class="sehri-iftari-label">Tomorrow's Fajr</div><div class="sehri-iftari-time">${formatCardTime(fajrStart, true)}</div></div>`
            : '';
          const jamaatHtml = fajrJamaat
            ? `<div class="sehri-iftari-item"><div class="sehri-iftari-label">Fajr Jama'at</div><div class="sehri-iftari-time">${formatCardTime(fajrJamaat, true)}</div></div>`
            : '';
          body.innerHTML = startHtml && jamaatHtml
            ? `${startHtml}<div class="sehri-iftari-divider"></div>${jamaatHtml}`
            : startHtml || jamaatHtml;
          return;
        }
      }

      // No tomorrow data — collapse
      body.innerHTML = '';
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

// --- Other Masjids (saved others only — My Masjid lives in the hero above) ---

function renderYourMasjids() {
  const section = document.getElementById('yourMasjidsSection');
  if (!section) return;

  // Saved others only, in save order. My Masjid is deliberately excluded —
  // it already leads the page as the hero card, so repeating it here would
  // duplicate it.
  const configs = getOthers()
    .map(s => cachedConfigs.find(c => c.slug === s))
    .filter(Boolean);

  // Zero-UI: section only appears once there's at least one other masjid
  if (configs.length === 0) {
    section.innerHTML = '';
    return;
  }

  section.innerHTML = `
    <div class="recent-section your-masjids-section">
      <div class="masjid-scroll-header">
        <span class="masjid-scroll-title">Pinned Masjids</span>
        <a href="/settings" class="your-masjids-edit" data-link>Edit ${CHEVRON_SVG}</a>
      </div>
      <div class="masjid-grid horizontal">
        ${configs.map(config => {
          const shortAddr = getCityPostcode(config.address);
          const fullAddr = config.address || '';
          const isPending = config.approved === false;
          let subHtml = '';
          if (isPending) {
            subHtml = `<div class="masjid-card-sub"><span class="pending-badge">Pending Review</span></div>`;
          } else if (config.address) {
            subHtml = `<div class="masjid-card-sub"><span class="addr-short">${shortAddr}</span><span class="addr-full">${fullAddr}</span></div>`;
          }
          const thumbContent = config.logo
            ? `<img src="${config.logo}" alt="" loading="lazy" decoding="async">`
            : MOSQUE_SVG;
          const cityAttr = config.city ? ` data-city="${config.city}"` : '';
          return `<a href="/${config.slug}" class="masjid-card" data-link${cityAttr} aria-label="${config.display_name}: view prayer times">
            <div class="masjid-card-top">
              <div class="masjid-card-thumb${config.logo ? ' has-logo' : ''}">${thumbContent}</div>
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
            </div>
          </a>`;
        }).join('')}
      </div>
    </div>`;

  // Reuse the recently-viewed prayer loader (cards share the
  // data-recent-next attribute; My Masjid and the saved others are excluded
  // from Recently Viewed so there are no duplicate attributes).
  loadRecentCardPrayers(configs);
}

// --- Recently viewed ---

function renderRecentlyViewed() {
  const section = document.getElementById('recentSection');
  if (!section) return;

  const recentSlugs = getRecentSlugs();
  const pinnedSlug = getMyMasjid();
  const savedSet = new Set(getOthers());

  // Filter out My Masjid + saved others (they live in Your Masjids) and
  // only show ones that exist in configs
  const recentConfigs = recentSlugs
    .filter(s => s !== pinnedSlug && !savedSet.has(s))
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
          const thumbContent = config.logo
            ? `<img src="${config.logo}" alt="" loading="lazy" decoding="async">`
            : MOSQUE_SVG;
          const cityAttr = config.city ? ` data-city="${config.city}"` : '';
          return `<a href="/${config.slug}" class="masjid-card" data-link${cityAttr} aria-label="${config.display_name}: view prayer times">
            <div class="masjid-card-top">
              <div class="masjid-card-thumb${config.logo ? ' has-logo' : ''}">${thumbContent}</div>
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
  // If hours >= 13, time is already in 24h format — no conversion needed
  if (hours < 13) {
    if (!isAM && hours !== 12) hours += 12;
    if (isAM && hours === 12) hours = 0;
  }
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
    // If already 24h (h >= 13), convert to 12h
    if (h >= 13) return `${h - 12}:${m} <span class="hero-next-ampm">PM</span>`;
    if (h === 0) return `12:${m} <span class="hero-next-ampm">AM</span>`;
    return `${h}:${m} <span class="hero-next-ampm">${isAM ? 'AM' : 'PM'}</span>`;
  }
  // 24h: convert using isAM flag only if not already 24h
  if (h >= 13) return `${h}:${m}`;
  const h24 = isAM ? (h === 12 ? 0 : h) : (h === 12 ? 12 : h + 12);
  return `${h24}:${m}`;
}

function formatCardTime(timeStr, isAM) {
  const parts = timeStr.trim().split(':');
  if (parts.length < 2) return timeStr;
  const h = parseInt(parts[0]);
  const m = parts[1];
  if (localStorage.getItem('iqamah-time-format') === '12') {
    // If already 24h (h >= 13), convert to 12h
    if (h >= 13) return `${h - 12}:${m} PM`;
    if (h === 0) return `12:${m} AM`;
    return `${h}:${m} ${isAM ? 'AM' : 'PM'}`;
  }
  // 24h: convert using isAM flag only if not already 24h
  if (h >= 13) return `${h}:${m}`;
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
      // Quiet "time to leave" line — recomputed on the same 60s tick as the
      // countdowns (runs first; the body branches below early-return).
      updateHeroLeaveLine(config, todayRow);

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

    // Resolve the user's location silently (cached fix or already-granted
    // permission only — never prompts) and refresh the leave line once
    // available. The 60s tick keeps it updated after that.
    resolveLeaveLocation().then(() => {
      if (heroLeaveLoc) updateHeroLeaveLine(config, todayRow);
    });

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

// --- Time to leave (hero) ---
// Shows "Leave by 7:05pm · 18 min walk" under the hero countdowns when the
// primary masjid has coordinates, a user location is available silently and
// the next jama'at is within ~3 hours. Zero-UI: never prompts, never adds
// settings — the line is simply absent when any input is unavailable.

const LEAVE_WINDOW_MS = 3 * 60 * 60 * 1000; // only show within ~3h of jama'at
const WALK_MINS_PER_KM = 12;                // gentle walking pace
const WALK_BUFFER_MINS = 2;                 // shoes-on buffer
const MILES_TO_KM = 1.60934;                // haversineDistance returns miles
const WALK_MIN_MINS = 3;                    // next door — not worth a line
const WALK_MAX_MINS = 120;                  // beyond this it isn't a walk

function resolveLeaveLocation() {
  if (heroLeaveLocPromise) return heroLeaveLocPromise;
  heroLeaveLocPromise = (async () => {
    // 1) Cached fix from a previous Nearby/Qibla use — no permission involved
    try {
      const cached = JSON.parse(localStorage.getItem('iqamah-cached-location') || 'null');
      if (cached && cached.lat != null && cached.lon != null) {
        heroLeaveLoc = { lat: cached.lat, lon: cached.lon };
        return heroLeaveLoc;
      }
    } catch { /* ignore */ }
    // 2) Live read ONLY if permission is already granted — never prompt from Home
    try {
      if (!navigator.geolocation || !navigator.permissions || !navigator.permissions.query) return null;
      const status = await navigator.permissions.query({ name: 'geolocation' });
      if (status.state !== 'granted') return null;
      const pos = await getCurrentPosition({ enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 });
      heroLeaveLoc = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      return heroLeaveLoc;
    } catch { /* silent — the line simply stays hidden */ }
    return null;
  })();
  return heroLeaveLocPromise;
}

function estimateWalkMins(miles) {
  let mins = Math.round(miles * MILES_TO_KM * WALK_MINS_PER_KM + WALK_BUFFER_MINS);
  if (mins >= 20) mins = Math.round(mins / 5) * 5; // round longer walks to 5 min
  return mins;
}

function formatClockTime(d) {
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  if (localStorage.getItem('iqamah-time-format') === '12') {
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${m}${h < 12 ? 'am' : 'pm'}`;
  }
  return `${String(h).padStart(2, '0')}:${m}`;
}

function updateHeroLeaveLine(config, todayRow) {
  const el = document.getElementById('heroLeaveLine');
  if (!el) return;
  const hide = () => { el.hidden = true; el.innerHTML = ''; el.classList.remove('is-now'); };

  const mLat = config.latitude != null ? config.latitude : config.lat;
  const mLon = config.longitude != null ? config.longitude : config.lon;
  if (mLat == null || mLon == null || !heroLeaveLoc) { hide(); return; }

  // getNextJamaatFromRow only returns future jama'ats, so once a jama'at
  // passes the line moves on to the next prayer (or hides after Esha).
  const next = getNextJamaatFromRow(todayRow);
  if (!next) { hide(); return; }
  const jamaatDate = parseTimeTodayWithAMPM(next.time, next.isAM);
  const now = new Date();
  if (!jamaatDate || jamaatDate <= now) { hide(); return; }
  if (jamaatDate.getTime() - now.getTime() > LEAVE_WINDOW_MS) { hide(); return; }

  const walkMins = estimateWalkMins(haversineDistance(heroLeaveLoc.lat, heroLeaveLoc.lon, mLat, mLon));
  if (walkMins < WALK_MIN_MINS || walkMins > WALK_MAX_MINS) { hide(); return; }

  const leaveBy = new Date(jamaatDate.getTime() - walkMins * 60000);
  const isNow = leaveBy <= now;
  const label = isNow
    ? `Leave now · ${walkMins} min walk`
    : `Leave by <strong class="hero-leave-time">${formatClockTime(leaveBy)}</strong> · ${walkMins} min walk`;
  el.innerHTML = `${WALK_SVG}<span>${label}</span>`;
  el.classList.toggle('is-now', isNow);
  el.hidden = false;
}

// --- Recent card prayers ---

async function loadRecentCardPrayers(configs) {
  // The bottom row (and its top divider) stays rendered even with no
  // next-prayer content, so cards in the scroller keep a consistent shape.
  const setNext = (el, html) => {
    el.innerHTML = html;
  };
  for (const config of configs) {
    const el = document.querySelector(`[data-recent-next="${config.slug}"]`);
    if (!el) continue;
    try {
      const csvFile = config.csv || config.slug + '.csv';
      const res = await fetch(`/data/${csvFile}`);
      if (!res.ok) { setNext(el, ''); continue; }
      const text = await res.text();
      const csvData = parseCSV(text);
      const todayRow = getTodayRow(csvData);
      if (!todayRow) { setNext(el, ''); continue; }
      const next = getNextJamaatFromRow(todayRow);
      if (next) {
        setNext(el, `
          <span class="masjid-card-next-label">${next.name}</span>
          <span class="masjid-card-next-time">${formatCardTime(next.time, next.isAM)}</span>`);
      } else {
        // All of today's jama'ats have passed — fall back to tomorrow's Fajr
        // so the line still carries content instead of sitting empty.
        const tomorrowRow = getTomorrowRow(csvData);
        const fajrJamaat = tomorrowRow ? (tomorrowRow["Fajr Jama'at"] || '') : '';
        setNext(el, fajrJamaat
          ? `
          <span class="masjid-card-next-label">Fajr</span>
          <span class="masjid-card-next-time">${formatCardTime(fajrJamaat, true)}</span>`
          : '');
      }
    } catch {
      setNext(el, '');
    }
  }
}

// --- Today's prayers check-in (mini tracker card) ---
// Visible ONLY when the tracker has ever been used: the existing
// 'iqamah-tracker-log' key has at least one day entry, or the tracker meta
// key exists (written on first log). Nothing new is stored just to decide
// visibility — everyone else gets zero UI.

function hasTrackerHistory() {
  try {
    const log = JSON.parse(localStorage.getItem('iqamah-tracker-log') || 'null');
    if (log && typeof log === 'object' && !Array.isArray(log) && Object.keys(log).length > 0) {
      return true;
    }
  } catch { /* malformed log — fall through to the meta check */ }
  try {
    return localStorage.getItem('iqamah-tracker-meta') !== null;
  } catch {
    return false;
  }
}

function checkinStatusLabel(status) {
  const s = STATUSES.find(x => x.key === status);
  return s ? s.label : null;
}

function setupCheckInCard() {
  renderCheckInCard();
  const section = document.getElementById('checkInSection');
  if (section) section.addEventListener('click', onCheckinClick);

  // Close the status picker on taps outside the card (capture phase so it
  // runs before navigation handlers). Removed in destroy().
  checkinDocHandler = (e) => {
    if (!checkinPickerFor) return;
    if (e.target.closest('#homeCheckin')) return;
    checkinPickerFor = null;
    renderCheckInCard();
  };
  document.addEventListener('click', checkinDocHandler, true);
}

function renderCheckInCard() {
  const section = document.getElementById('checkInSection');
  if (!section) return;
  if (!hasTrackerHistory()) { section.innerHTML = ''; return; }

  const todayK = localDateKey(new Date());
  const log = readLog();
  const entry = log[todayK] || {};
  const { current } = computeStreaks(log);

  const chips = PRAYERS.map(p => {
    const st = entry[p.key] || null;
    const stClass = st ? `tr-st-${st}` : 'tr-st-none';
    const icon = st ? (st === 'missed' ? HCK_DASH_SVG : HCK_CHECK_SVG) : '';
    return `
      <button type="button" class="hck-chip${checkinPickerFor === p.key ? ' is-open' : ''}"
              data-prayer="${p.key}" aria-haspopup="menu"
              aria-expanded="${checkinPickerFor === p.key}"
              aria-label="${p.label}: ${checkinStatusLabel(st) || 'not logged yet'}">
        <span class="hck-dot ${stClass}">${icon}</span>
        <span class="hck-name">${p.label}</span>
      </button>`;
  }).join('');

  let pickerHtml = '';
  if (checkinPickerFor) {
    const cur = entry[checkinPickerFor] || null;
    const opts = STATUSES.map(s => `
      <button type="button" class="hck-opt tr-st-${s.key}${cur === s.key ? ' active' : ''}"
              data-status="${s.key}" role="menuitemradio"
              aria-checked="${cur === s.key}">${s.label}</button>`).join('');
    pickerHtml = `
      <div class="hck-picker" role="menu">
        ${opts}
        <button type="button" class="hck-opt hck-opt-clear" data-status="">Clear</button>
      </div>`;
  }

  const streakHtml = current > 0
    ? `<span class="hck-streak">${FLAME_SVG}<span><strong>${current}</strong>-day streak</span></span>`
    : `<span class="hck-streak hck-streak-zero">${FLAME_SVG}<span>Log all five to start a streak</span></span>`;

  section.innerHTML = `
    <div class="hck-card" id="homeCheckin" role="link" aria-label="Today's prayers: open Prayer Tracker">
      <div class="hck-head">
        <span class="hck-title">Today's Prayers</span>
        <a href="/tracker" class="hck-viewall" data-link>View all ${CHEVRON_SVG}</a>
      </div>
      <div class="hck-row">${chips}</div>
      ${pickerHtml}
      <div class="hck-foot">${streakHtml}</div>
    </div>`;
}

function onCheckinClick(e) {
  // Status picker option — set (or clear) and close
  const opt = e.target.closest('.hck-opt');
  if (opt && checkinPickerFor) {
    e.preventDefault();
    e.stopPropagation();
    setPrayerStatus(localDateKey(new Date()), checkinPickerFor, opt.dataset.status || null);
    if (navigator.vibrate) navigator.vibrate(20);
    checkinPickerFor = null;
    renderCheckInCard();
    return;
  }

  // Prayer chip — toggle the status picker
  const chip = e.target.closest('.hck-chip');
  if (chip) {
    e.preventDefault();
    e.stopPropagation();
    checkinPickerFor = checkinPickerFor === chip.dataset.prayer ? null : chip.dataset.prayer;
    renderCheckInCard();
    return;
  }

  // "View all" link — let the router's data-link handling take it
  if (e.target.closest('.hck-viewall')) return;

  // Card background: close an open picker, otherwise go to the full tracker
  if (e.target.closest('.hck-card')) {
    if (checkinPickerFor) {
      checkinPickerFor = null;
      renderCheckInCard();
      return;
    }
    navigate('/tracker');
  }
}

// --- Dua of the day card ---

async function renderDuaCard() {
  const section = document.getElementById('duaSection');
  if (!section) return;
  try {
    const dua = await getTodayDua();
    const sec = document.getElementById('duaSection'); // re-check after await
    if (!sec) return;
    if (!dua) { sec.innerHTML = ''; return; }
    sec.innerHTML = `
      <a href="/dua" class="home-dua-card" data-link aria-label="Dua of the Day: ${dua.occasion}. Open daily duas">
        <div class="home-dua-top">
          <span class="home-dua-badge">Dua of the Day</span>
        </div>
        <div class="home-dua-occasion">${dua.occasion}</div>
        <p class="home-dua-text">&ldquo;${dua.english}&rdquo;</p>
      </a>`;
  } catch {
    // Dataset unavailable — quietly absent
    const sec = document.getElementById('duaSection');
    if (sec) sec.innerHTML = '';
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
  // Unset My Masjid — no auto-promotion from Other Masjids. Events from
  // follow.js re-render the hero, sections and the embedded masjids list.
  clearMyMasjid();
  const config = cachedConfigs.find(c => c.slug === unpinBtn.dataset.slug);
  showToast(`${config ? config.display_name : 'Masjid'} is no longer My Masjid`);
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
      <div class="install-banner-text"><strong>Install Iqamah</strong>: tap <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin: 0 2px;"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> then <strong>"Add to Home Screen"</strong>.</div>`;
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

// --- Pin/follow sync (from embedded masjid list, settings, prayer-times) ---

function onPinChanged() {
  renderHero();
  renderYourMasjids();
  renderRecentlyViewed();
}

function onFollowChanged() {
  renderYourMasjids();
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
  window.removeEventListener('iqamah-follow-changed', onFollowChanged);
  if (checkinDocHandler) {
    document.removeEventListener('click', checkinDocHandler, true);
    checkinDocHandler = null;
  }
  checkinPickerFor = null;
  heroLeaveLoc = null;
  heroLeaveLocPromise = null;
}
