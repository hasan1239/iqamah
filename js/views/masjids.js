// Masjids view — full searchable list with location toggle
import { navigate } from '../router.js';
import { haversineDistance, getCurrentPosition } from '../utils/geolocation.js';
import { parseCSV, getTodayRow } from '../utils/csv.js';
import { formatCountdown } from '../utils/countdown.js';

let cachedConfigs = [];
let userLocation = null;
let distanceMap = {};
let locationActive = false;
let longPressTimer = null;
let toastTimer = null;
let viewContainer = null;
let longPressCleanup = null;

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
const STAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.09 6.26L21 9.27l-5 4.87L17.18 21 12 17.27 6.82 21 8 14.14l-5-4.87 6.91-1.01z"/></svg>';
const STAR_FILLED_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.09 6.26L21 9.27l-5 4.87L17.18 21 12 17.27 6.82 21 8 14.14l-5-4.87 6.91-1.01z"/></svg>';
const CHEVRON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
const MOSQUE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c-.4.6-.8 1.3-.6 2 .1.4.6.6.6.6s.5-.2.6-.6c.2-.7-.2-1.4-.6-2z"/><path d="M12 4.5C9.5 6.5 7 9 7 11.5c0 0 0 .5.2.5H16.8c.2 0 .2-.5.2-.5 0-2.5-2.5-5-5-7z"/><rect x="5" y="12" width="14" height="9"/><path d="M12 21v-5a2.5 2.5 0 0 0-2.5-2.5h0A2.5 2.5 0 0 0 7 16v5"/><rect x="2" y="10" width="3" height="11" rx=".5"/><rect x="19" y="10" width="3" height="11" rx=".5"/><line x1="3.5" y1="8" x2="3.5" y2="10"/><line x1="20.5" y1="8" x2="20.5" y2="10"/></svg>';
const SEARCH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';

let searchQuery = '';
let loadGeneration = 0;
let masjidsLoadPromise = null;

export function render(container) {
  viewContainer = container;
  container.innerHTML = `
    <div class="masjids-view">
      <header class="masjids-header">
        <h1 class="masjids-title">Masjids</h1>
      </header>

      <div class="masjids-search-bar">
        <span class="masjids-search-icon">${SEARCH_SVG}</span>
        <input type="text" id="masjidSearch" class="masjids-search-input" placeholder="Search masjids..." autocomplete="off">
        <button class="location-btn" id="masjidsLocationBtn">
          <svg class="location-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
            <circle cx="12" cy="10" r="3"/>
          </svg>
          <span class="location-btn-text">Nearby</span>
        </button>
      </div>

      ${!localStorage.getItem('iqamah-pin-hint-dismissed') ? `<div class="pin-hint" id="pinHint">
        <span>Tip: Long press a masjid to set it as My Masjid</span>
        <button class="pin-hint-dismiss" aria-label="Dismiss">&times;</button>
      </div>` : ''}

      <div class="masjid-grid" id="masjidsGrid"></div>

      <div class="cta-section">
        <p class="cta-heading">Can't find your masjid?</p>
        <a class="cta-btn" href="/add" data-link>Add it here</a>
      </div>

      <div class="pin-toast" id="masjidsPinToast"></div>
    </div>
  `;

  // Show skeleton immediately
  const grid = viewContainer.querySelector('#masjidsGrid');
  grid.innerHTML = buildSkeletonCards(6);

  masjidsLoadPromise = loadMasjids();
  setupSearch();
  setupLocationBtn();
  setupGridClicks();
  setupLongPress();
  setupPinHint();
}

function buildSkeletonCards(count) {
  const nameWidths = [120, 90, 140, 100, 110, 130];
  const subWidths = [80, 60, 95, 70, 85, 75];
  let html = '';
  for (let i = 0; i < count; i++) {
    const nw = nameWidths[i % nameWidths.length];
    const sw = subWidths[i % subWidths.length];
    html += `<div class="masjid-card" style="pointer-events:none">
      <div class="masjid-card-top">
        <div class="skeleton-bone" style="width:40px;height:40px;border-radius:8px;flex-shrink:0"></div>
        <div class="masjid-card-info">
          <div class="skeleton-bone" style="width:${nw}px;height:12px;margin-bottom:6px"></div>
          <div class="skeleton-bone" style="width:${sw}px;height:8px"></div>
        </div>
      </div>
      <div class="masjid-card-bottom">
        <div class="masjid-card-next">
          <div class="skeleton-bone" style="width:32px;height:8px;margin-bottom:4px"></div>
          <div class="skeleton-bone" style="width:52px;height:12px"></div>
        </div>
        <div class="skeleton-bone" style="width:28px;height:28px;border-radius:8px"></div>
      </div>
    </div>`;
  }
  return html;
}

async function loadMasjids() {
  try {
    const res = await fetch('/data/mosques/index.json');
    if (!res.ok) return;
    cachedConfigs = await res.json();
    renderCards();
  } catch (error) {
    console.error('Error loading masjids:', error);
  }
}

export function renderCards() {
  const grid = (viewContainer && viewContainer.querySelector('#masjidsGrid')) || document.getElementById('masjidsGrid');
  if (!grid) return;

  const pinnedSlug = localStorage.getItem('iqamah-pinned-masjid');

  let filtered = cachedConfigs.slice();

  // Apply search filter
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(c =>
      c.display_name.toLowerCase().includes(q) ||
      (c.address && c.address.toLowerCase().includes(q))
    );
  }

  // Sort: approved first, then by distance if location active, otherwise alphabetical
  filtered.sort((a, b) => {
    const aApproved = a.approved !== false ? 1 : 0;
    const bApproved = b.approved !== false ? 1 : 0;
    if (aApproved !== bApproved) return bApproved - aApproved;

    if (locationActive) {
      const distA = distanceMap[a.slug];
      const distB = distanceMap[b.slug];
      if (distA == null && distB == null) return 0;
      if (distA == null) return 1;
      if (distB == null) return -1;
      return distA - distB;
    }
    return a.display_name.localeCompare(b.display_name, undefined, { sensitivity: 'base', ignorePunctuation: true });
  });

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="masjids-empty">No masjids found</div>`;
    return;
  }

  grid.innerHTML = filtered.map(config => {
    const distText = getDistText(config.slug);
    const shortAddr = getCityPostcode(config.address);
    const fullAddr = config.address || '';
    const isPinned = config.slug === pinnedSlug;
    const pinIcon = isPinned ? STAR_FILLED_SVG : STAR_SVG;
    const pinClass = isPinned ? ' pinned' : '';
    const pendingBadge = config.approved === false ? '<span class="pending-badge">Pending Review</span>' : '';

    let subHtml = '';
    if (distText) {
      subHtml = `<div class="masjid-card-sub">${distText}</div>`;
    } else if (config.address) {
      subHtml = `<div class="masjid-card-sub"><span class="addr-short">${shortAddr}</span><span class="addr-full">${fullAddr}</span></div>`;
    }

    return `<a href="/${config.slug}" class="masjid-card" data-link data-slug="${config.slug}">
      <div class="masjid-card-top">
        <div class="masjid-card-thumb">${MOSQUE_SVG}</div>
        <div class="masjid-card-info">
          <div class="masjid-name-row">
            <div class="masjid-name">${config.display_name}${pendingBadge}</div>
            <button class="pin-btn${pinClass}" data-slug="${config.slug}" aria-label="Set ${config.display_name} as My Masjid" title="Set as My Masjid">
              ${pinIcon}
            </button>
          </div>
          ${subHtml}
        </div>
      </div>
      <div class="masjid-card-bottom">
        <div class="masjid-card-next" data-card-next="${config.slug}">
          <div class="skeleton-bone" style="width:40px;height:8px;margin-bottom:4px"></div>
          <div class="skeleton-bone" style="width:56px;height:12px"></div>
        </div>
        <div class="masjid-card-chevron">${CHEVRON_SVG}</div>
      </div>
    </a>`;
  }).join('');

  // Async load next prayer for each card
  loadCardPrayers(filtered);
}

function getDistText(slug) {
  if (!locationActive || distanceMap[slug] == null) return '';
  const d = distanceMap[slug];
  return d < 0.1 ? '< 0.1 mi away' : d.toFixed(1) + ' mi away';
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
      return { name: prayer.name, time: timeStr, isAM: prayer.isAM };
    }
  }
  return null;
}

async function loadCardPrayers(configs) {
  const gen = ++loadGeneration;
  const promises = configs.map(async (config) => {
    try {
      const csvFile = config.csv || config.slug + '.csv';
      const res = await fetch(`/data/${csvFile}`);
      if (gen !== loadGeneration) return;
      const root = (viewContainer && viewContainer.isConnected) ? viewContainer : document;
      const el = root.querySelector(`[data-card-next="${config.slug}"]`);
      if (!el) return;
      if (!res.ok) { el.innerHTML = ''; return; }
      const text = await res.text();
      if (gen !== loadGeneration) return;
      const csvData = parseCSV(text);
      const todayRow = getTodayRow(csvData);
      if (!todayRow) { el.innerHTML = ''; return; }
      const next = getNextPrayerFromRow(todayRow);
      if (next) {
        el.innerHTML = `
          <span class="masjid-card-next-label">${next.name}</span>
          <span class="masjid-card-next-time">${formatCardTime(next.time, next.isAM)}</span>`;
      } else {
        el.innerHTML = '';
      }
    } catch {
      if (gen !== loadGeneration) return;
      const root = (viewContainer && viewContainer.isConnected) ? viewContainer : document;
      const el = root.querySelector(`[data-card-next="${config.slug}"]`);
      if (el) el.innerHTML = '';
    }
  });
  await Promise.all(promises);
}

// --- Search ---

function setupSearch() {
  const input = (viewContainer && viewContainer.querySelector('#masjidSearch')) || document.getElementById('masjidSearch');
  if (!input) return;
  input.addEventListener('input', () => {
    searchQuery = input.value.trim();
    renderCards();
  });
}

// --- Pin interactions ---

function setupGridClicks() {
  document.addEventListener('click', handlePinClick, true);
}

function handlePinClick(e) {
  const pinBtn = e.target.closest('.pin-btn');
  if (!pinBtn) return;
  const masjidsView = e.target.closest('.masjids-view');
  if (!masjidsView) return;

  e.preventDefault();
  e.stopPropagation();
  const slug = pinBtn.dataset.slug;
  togglePin(slug);
}

function setupLongPress() {
  const view = (viewContainer && viewContainer.querySelector('.masjids-view')) || document.querySelector('.masjids-view');
  if (!view) return;

  let pressTarget = null;
  let didLongPress = false;

  const onTouchStart = (e) => {
    const card = e.target.closest('.masjid-card[data-slug]');
    if (!card) return;
    pressTarget = card;
    didLongPress = false;

    longPressTimer = setTimeout(() => {
      didLongPress = true;
      card.classList.add('long-pressing');
      if (navigator.vibrate) navigator.vibrate(30);
      togglePin(card.dataset.slug);
      setTimeout(() => card.classList.remove('long-pressing'), 200);
    }, 500);
  };

  const onTouchMove = () => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    if (pressTarget) pressTarget.classList.remove('long-pressing');
  };

  const onContextMenu = (e) => {
    if (e.target.closest('.masjid-card[data-slug]')) e.preventDefault();
  };

  const onTouchEnd = (e) => {
    if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    if (pressTarget) pressTarget.classList.remove('long-pressing');
    if (didLongPress) {
      e.preventDefault();
      didLongPress = false;
    }
    pressTarget = null;
  };

  view.addEventListener('touchstart', onTouchStart, { passive: true });
  view.addEventListener('touchmove', onTouchMove, { passive: true });
  view.addEventListener('contextmenu', onContextMenu);
  view.addEventListener('touchend', onTouchEnd);

  longPressCleanup = () => {
    view.removeEventListener('touchstart', onTouchStart);
    view.removeEventListener('touchmove', onTouchMove);
    view.removeEventListener('contextmenu', onContextMenu);
    view.removeEventListener('touchend', onTouchEnd);
  };
}

function togglePin(slug) {
  const current = localStorage.getItem('iqamah-pinned-masjid');
  if (current === slug) {
    localStorage.removeItem('iqamah-pinned-masjid');
    showToast('Removed from My Masjid');
  } else {
    localStorage.setItem('iqamah-pinned-masjid', slug);
    const config = cachedConfigs.find(c => c.slug === slug);
    const name = config ? config.display_name : 'Masjid';
    showToast(`<span class="toast-star">\u2605</span> ${name} set as My Masjid`);
    dismissPinHint();
  }
  renderCards();
  window.dispatchEvent(new CustomEvent('iqamah-pin-changed'));
}

function setupPinHint() {
  const hint = (viewContainer && viewContainer.querySelector('#pinHint')) || document.getElementById('pinHint');
  if (!hint) return;
  hint.querySelector('.pin-hint-dismiss').addEventListener('click', dismissPinHint);
}

function dismissPinHint() {
  localStorage.setItem('iqamah-pin-hint-dismissed', '1');
  const hint = (viewContainer && viewContainer.querySelector('#pinHint')) || document.getElementById('pinHint');
  if (hint) hint.remove();
}

function showToast(html) {
  const toast = (viewContainer && viewContainer.querySelector('#masjidsPinToast')) || document.getElementById('masjidsPinToast');
  if (!toast) return;
  toast.innerHTML = html;
  toast.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2500);
}

// --- Location ---

function setupLocationBtn() {
  const btn = (viewContainer && viewContainer.querySelector('#masjidsLocationBtn')) || document.getElementById('masjidsLocationBtn');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const textEl = btn.querySelector('.location-btn-text');

    if (locationActive) {
      locationActive = false;
      userLocation = null;
      distanceMap = {};
      btn.classList.remove('active');
      textEl.textContent = 'Nearby';
      renderCards();
      return;
    }

    btn.classList.add('loading');
    textEl.textContent = 'Locating...';

    try {
      const pos = await getCurrentPosition();
      btn.classList.remove('loading');
      userLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      localStorage.setItem('iqamah-cached-location', JSON.stringify(userLocation));

      // Ensure masjid configs are loaded before computing distances
      if (masjidsLoadPromise) await masjidsLoadPromise;
      if (!cachedConfigs.length) {
        // Retry if configs didn't load (e.g. race condition or failed fetch)
        await loadMasjids();
      }

      distanceMap = {};
      cachedConfigs.forEach(config => {
        if (config.lat != null && config.lon != null) {
          distanceMap[config.slug] = haversineDistance(
            userLocation.lat, userLocation.lon, config.lat, config.lon
          );
        }
      });

      locationActive = true;
      btn.classList.add('active');
      textEl.textContent = 'Nearby';
      renderCards();
    } catch (err) {
      btn.classList.remove('loading');
      const msg = err.code === 1 ? 'Location denied'
        : err.code === 3 ? 'Timed out'
        : 'Location error';
      btn.classList.add('error');
      textEl.textContent = msg;
      setTimeout(() => {
        btn.classList.remove('error');
        textEl.textContent = 'Nearby';
      }, 3000);
    }
  });
}

export function destroy() {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  if (longPressCleanup) { longPressCleanup(); longPressCleanup = null; }
  document.removeEventListener('click', handlePinClick, true);
  locationActive = false;
  userLocation = null;
  distanceMap = {};
  searchQuery = '';
  viewContainer = null;
}
