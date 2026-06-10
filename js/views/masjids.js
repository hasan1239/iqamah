// Masjids view — full searchable list with location toggle
import { navigate } from '../router.js';
import { haversineDistance, getCurrentPosition } from '../utils/geolocation.js';
import { parseCSV, getTodayRow } from '../utils/csv.js';
import { formatCountdown } from '../utils/countdown.js';
import { mountMap, unmountMap, focusBounds, refreshMap } from './masjid-map.js';
import { getFollowed, isFollowed, getPrimary, follow, unfollow, setPrimary, FOLLOW_CAP } from '../utils/follow.js';
import { openContextMenu, closeContextMenu } from '../utils/context-menu.js';
import { loadMasjidIndex } from '../utils/masjid-index.js';
import { deriveCity, getCityPostcode, OTHER_CITY } from '../utils/cities.js';
import { parsePostcodeQuery, lookupPostcode } from '../utils/postcode.js';

let cachedConfigs = [];
let userLocation = null;
let distanceMap = {};
let locationActive = false;
let longPressTimer = null;
let toastTimer = null;
let viewContainer = null;
let longPressCleanup = null;
let selectedCity = null;
let resizeListener = null;
let lastIsMobile = null;

const MOBILE_BREAKPOINT = 768;

function isMobile() {
  return window.innerWidth < MOBILE_BREAKPOINT;
}

function isCityListMode() {
  return isMobile() && !selectedCity && !locationActive;
}

// SVG icons
const STAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.09 6.26L21 9.27l-5 4.87L17.18 21 12 17.27 6.82 21 8 14.14l-5-4.87 6.91-1.01z"/></svg>';
const STAR_FILLED_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.09 6.26L21 9.27l-5 4.87L17.18 21 12 17.27 6.82 21 8 14.14l-5-4.87 6.91-1.01z"/></svg>';
const CHEVRON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
const MOSQUE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2c-.4.6-.8 1.3-.6 2 .1.4.6.6.6.6s.5-.2.6-.6c.2-.7-.2-1.4-.6-2z"/><path d="M12 4.5C9.5 6.5 7 9 7 11.5c0 0 0 .5.2.5H16.8c.2 0 .2-.5.2-.5 0-2.5-2.5-5-5-7z"/><rect x="5" y="12" width="14" height="9"/><path d="M12 21v-5a2.5 2.5 0 0 0-2.5-2.5h0A2.5 2.5 0 0 0 7 16v5"/><rect x="2" y="10" width="3" height="11" rx=".5"/><rect x="19" y="10" width="3" height="11" rx=".5"/><line x1="3.5" y1="8" x2="3.5" y2="10"/><line x1="20.5" y1="8" x2="20.5" y2="10"/></svg>';
const SEARCH_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
const KEBAB_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>';
const CLOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
const MAP_PIN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';

let searchQuery = '';
let loadGeneration = 0;
let masjidsLoadPromise = null;
let hasTimesMap = {}; // slug -> true/false, populated after CSV check
let viewMode = 'list'; // 'list' | 'map'
let mapMounted = false;
let mapReadyPromise = null;

// Postcode search — a typed postcode/outcode becomes the location source
// (no permission prompt needed), feeding the same distance-sort path as
// the geolocation button.
const POSTCODE_STORE_KEY = 'iqamah-postcode';
const POSTCODE_DEBOUNCE_MS = 550;
let postcodeActive = false;   // postcode is the current location source
let postcodeInfo = null;      // { lat, lon, postcode, outcode }
let postcodeHint = null;      // null | 'looking' | 'notfound'
let postcodeHintLabel = '';
let postcodeTimer = null;
let postcodeGen = 0;          // cancels stale debounces / in-flight lookups

const BACK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>';

export function render(container) {
  selectedCity = null;
  // Restore a persisted postcode sort before building markup — locationActive
  // feeds isCityListMode(), so this must happen before data-mode is computed.
  restorePostcodeState();
  container.innerHTML = `
    <div class="masjids-view" data-mode="${isCityListMode() ? 'cities' : 'list'}">
      <header class="masjids-header">
        <button class="masjids-back-btn" id="masjidsBackBtn" aria-label="Back to cities">${BACK_SVG}</button>
        <h1 class="masjids-title" id="masjidsTitle">Masjids</h1>
      </header>

      <div class="masjids-mode-toggle toggle-container" id="masjidsModeToggle" role="tablist" aria-label="View mode">
        <div class="toggle-slider"></div>
        <button class="toggle-btn active" data-mode="list" role="tab" aria-selected="true">List</button>
        <button class="toggle-btn" data-mode="map" role="tab" aria-selected="false">Map</button>
      </div>

      <div class="masjids-list-pane" id="masjidsListPane">
        <div class="masjids-search-bar" id="masjidsSearchBar">
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

        <div class="postcode-chip-row" id="postcodeChipRow" hidden>
          <span class="postcode-chip">
            ${MAP_PIN_SVG}
            <span class="postcode-chip-text">Near <strong id="postcodeChipLabel"></strong></span>
            <button type="button" class="postcode-chip-clear" id="postcodeChipClear" aria-label="Clear postcode sort">&times;</button>
          </span>
        </div>

        <div class="masjids-cities-actions" id="masjidsCitiesActions">
          <button class="masjids-nearby-pill" id="masjidsNearbyPill">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
              <circle cx="12" cy="10" r="3"/>
            </svg>
            <span>Find masjids near me</span>
          </button>
        </div>

        <div class="postcode-cities-row" id="postcodeCitiesRow">
          <button type="button" class="masjids-postcode-pill" id="postcodePill">
            ${SEARCH_SVG}
            <span>Search by postcode</span>
          </button>
          <form class="postcode-inline-form" id="postcodeInlineForm" hidden>
            <input type="text" id="postcodeInlineInput" class="postcode-inline-input"
              placeholder="e.g. B12 0XS or M14" autocomplete="postal-code"
              autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="8">
            <button type="submit" class="postcode-inline-go">Go</button>
          </form>
          <div class="postcode-inline-hint" id="postcodeInlineHint" hidden></div>
        </div>

        ${!localStorage.getItem('iqamah-pin-hint-dismissed') ? `<div class="pin-hint" id="pinHint">
          <span>Tip: Long press a masjid to follow it or set it as My Masjid</span>
          <button class="pin-hint-dismiss" aria-label="Dismiss">&times;</button>
        </div>` : ''}

        <div class="masjid-city-grid" id="masjidsCityGrid"></div>

        <div class="masjid-grid" id="masjidsGrid"></div>

        <div class="cta-section">
          <p class="cta-heading">Can't find your masjid?</p>
          <a class="cta-btn" href="/add" data-link>Add it here <span class="beta-badge" style="background:rgba(0,0,0,0.3);color:#fff">BETA</span></a>
        </div>
      </div>

      <div class="masjids-map-pane" id="masjidsMapPane" hidden>
        <div class="masjids-map" id="masjidsMap"></div>
      </div>

      <div class="pin-toast" id="masjidsPinToast"></div>
    </div>
  `;

  // Hold a reference to .masjids-view itself (not the outer container).
  // The router moves children out of the transition wrapper after the slide
  // animation, so the outer container goes empty — but .masjids-view itself
  // is the moved node, so this reference survives.
  viewContainer = container.querySelector('.masjids-view');

  // Show skeleton immediately
  const grid = viewContainer.querySelector('#masjidsGrid');
  grid.innerHTML = buildSkeletonCards(6);
  const cityGrid = viewContainer.querySelector('#masjidsCityGrid');
  cityGrid.innerHTML = buildCitySkeletons(6);

  lastIsMobile = isMobile();
  masjidsLoadPromise = loadMasjids();
  setupSearch();
  setupPostcodeUI();
  setupLocationBtn();
  setupGridClicks();
  setupLongPress();
  setupPinHint();
  setupCityNav();
  setupNearbyPill();
  setupResizeListener();
  setupModeToggle();
  updateHeaderState();

  // Re-render when the follow set / primary changes anywhere (settings, home
  // hero, prayer-times set-primary). Defensive remove first — render() can be
  // called again (embedded desktop list) before destroy().
  window.removeEventListener('iqamah-follow-changed', onFollowChanged);
  window.addEventListener('iqamah-follow-changed', onFollowChanged);
}

function onFollowChanged() {
  renderCards();
}

function buildCitySkeletons(count) {
  let html = '';
  const widths = [80, 110, 70, 95, 85, 100];
  for (let i = 0; i < count; i++) {
    const w = widths[i % widths.length];
    html += `<div class="masjid-city-card" style="pointer-events:none">
      <div class="masjid-city-card-info">
        <div class="skeleton-bone" style="width:${w}px;height:14px;margin-bottom:6px"></div>
        <div class="skeleton-bone" style="width:60px;height:9px"></div>
      </div>
      <div class="skeleton-bone" style="width:24px;height:24px;border-radius:8px"></div>
    </div>`;
  }
  return html;
}

function setupResizeListener() {
  resizeListener = () => {
    const nowMobile = isMobile();
    if (nowMobile !== lastIsMobile) {
      lastIsMobile = nowMobile;
      updateHeaderState();
      renderCards();
    }
  };
  window.addEventListener('resize', resizeListener);
}

function setupCityNav() {
  const backBtn = viewContainer && viewContainer.querySelector('#masjidsBackBtn');
  if (!backBtn) return;
  backBtn.addEventListener('click', () => {
    selectedCity = null;
    searchQuery = '';
    const input = viewContainer.querySelector('#masjidSearch');
    if (input) input.value = '';
    // Cancel any pending/in-flight postcode lookup so it can't apply a
    // distance sort after the user has returned to the cities list.
    if (postcodeTimer) { clearTimeout(postcodeTimer); postcodeTimer = null; }
    postcodeGen++;
    // Reset Nearby too — going back returns the user to the clean cities list,
    // which doesn't use distance sort.
    if (locationActive) {
      if (postcodeActive) clearPostcodeMode(true);
      locationActive = false;
      userLocation = null;
      distanceMap = {};
      const locBtn = viewContainer.querySelector('#masjidsLocationBtn');
      if (locBtn) {
        locBtn.classList.remove('active');
        const txt = locBtn.querySelector('.location-btn-text');
        if (txt) txt.textContent = 'Nearby';
      }
    }
    updateHeaderState();
    renderCards();
  });
}

function setupNearbyPill() {
  const pill = viewContainer && viewContainer.querySelector('#masjidsNearbyPill');
  if (!pill) return;
  pill.addEventListener('click', () => {
    const locBtn = viewContainer.querySelector('#masjidsLocationBtn');
    if (locBtn) locBtn.click();
  });
}

function updateHeaderState() {
  if (!viewContainer) return;
  const title = viewContainer.querySelector('#masjidsTitle');
  if (!title) return;
  if (isCityListMode()) {
    viewContainer.setAttribute('data-mode', 'cities');
    title.textContent = 'Masjids';
  } else {
    viewContainer.setAttribute('data-mode', selectedCity ? 'city-detail' : 'list');
    title.textContent = selectedCity || 'Masjids';
  }
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
    cachedConfigs = (await loadMasjidIndex()).filter(c =>
      !c.test_masjid && !c.hidden && !(c.quality && c.quality.status === 'needs_review')
    );
    // A restored postcode sort needs distances once configs are available.
    if (locationActive && userLocation) computeDistances();
    renderCards();
  } catch (error) {
    console.error('Error loading masjids:', error);
  }
}

export function renderCards() {
  if (!viewContainer) return;
  updateHeaderState();

  if (isCityListMode()) {
    renderCityGrid();
    return;
  }
  renderMasjidGrid();
}

function getCachedLocation() {
  if (userLocation) return userLocation;
  try {
    const c = JSON.parse(localStorage.getItem('iqamah-cached-location') || 'null');
    if (c && c.lat != null && c.lon != null) return c;
  } catch { /* ignore */ }
  return null;
}

function renderCityGrid() {
  const cityGrid = viewContainer.querySelector('#masjidsCityGrid');
  if (!cityGrid) return;

  const counts = {};
  cachedConfigs.forEach(config => {
    const city = deriveCity(config);
    counts[city] = (counts[city] || 0) + 1;
  });

  // Auto-surface the city of the pinned masjid (My Masjid) to the top.
  const pinnedSlug = getPrimary();
  const pinnedConfig = pinnedSlug ? cachedConfigs.find(c => c.slug === pinnedSlug) : null;
  const pinnedCity = pinnedConfig ? deriveCity(pinnedConfig) : null;

  // Last city the user drilled into (fallback ordering signal).
  const lastCity = localStorage.getItem('iqamah-last-city');

  // Distance to the nearest masjid in each city, from a cached/live location.
  const loc = getCachedLocation();
  const cityDist = {};
  if (loc) {
    cachedConfigs.forEach(config => {
      const lat = config.lat != null ? config.lat : config.latitude;
      const lon = config.lon != null ? config.lon : config.longitude;
      if (lat == null || lon == null) return;
      const city = deriveCity(config);
      const d = haversineDistance(loc.lat, loc.lon, lat, lon);
      if (cityDist[city] == null || d < cityDist[city]) cityDist[city] = d;
    });
  }

  const cities = Object.keys(counts).sort((a, b) => {
    // Pinned city (My Masjid's city) always floats to the top
    if (pinnedCity) {
      if (a === pinnedCity && b !== pinnedCity) return -1;
      if (b === pinnedCity && a !== pinnedCity) return 1;
    }
    // "Other" always sinks to the bottom
    if (a === OTHER_CITY && b !== OTHER_CITY) return 1;
    if (b === OTHER_CITY && a !== OTHER_CITY) return -1;
    // Last-viewed city next (below pinned)
    if (lastCity && lastCity !== pinnedCity) {
      if (a === lastCity && b !== lastCity) return -1;
      if (b === lastCity && a !== lastCity) return 1;
    }
    // Then by distance to nearest masjid when we know where the user is
    if (loc) {
      const da = cityDist[a], db = cityDist[b];
      if (da != null && db != null && da !== db) return da - db;
      if (da != null && db == null) return -1;
      if (da == null && db != null) return 1;
    }
    return a.localeCompare(b, undefined, { sensitivity: 'base' });
  });

  if (cities.length === 0) {
    cityGrid.innerHTML = `<div class="masjids-empty">No masjids found</div>`;
    return;
  }

  cityGrid.innerHTML = cities.map(city => {
    const n = counts[city];
    const safeCity = city.replace(/"/g, '&quot;');
    const isPinned = city === pinnedCity;
    const isRecent = !isPinned && city === lastCity && city !== OTHER_CITY;
    let badge = '';
    if (isPinned) badge = `<span class="masjid-city-badge">${STAR_FILLED_SVG} My city</span>`;
    else if (isRecent) badge = `<span class="masjid-city-badge recent">Recent</span>`;

    const d = cityDist[city];
    const distText = d != null ? ` &middot; ${d < 0.1 ? '< 0.1' : d.toFixed(1)} mi` : '';

    return `<button type="button" class="masjid-city-card${isPinned ? ' pinned-city' : ''}" data-city="${safeCity}">
      <div class="masjid-city-card-info">
        <div class="masjid-city-name">${city}${badge}</div>
        <div class="masjid-city-count">${n} masjid${n === 1 ? '' : 's'}${distText}</div>
      </div>
      <div class="masjid-city-actions">
        <span class="masjid-city-map-btn" role="button" tabindex="0" aria-label="Show ${safeCity} on map">${MAP_PIN_SVG}</span>
        <span class="masjid-city-chevron">${CHEVRON_SVG}</span>
      </div>
    </button>`;
  }).join('');
}

function renderMasjidGrid() {
  const grid = viewContainer.querySelector('#masjidsGrid');
  if (!grid) return;

  const followedSet = new Set(getFollowed());
  const primarySlug = getPrimary();

  let filtered = cachedConfigs.slice();

  // City filter — keep filtering when Nearby is on inside a city so distance
  // sort applies only to that city's masjids.
  if (selectedCity && isMobile()) {
    filtered = filtered.filter(c => deriveCity(c) === selectedCity);
  }

  // Apply search filter
  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filtered = filtered.filter(c =>
      c.display_name.toLowerCase().includes(q) ||
      (c.address && c.address.toLowerCase().includes(q))
    );
  }

  // Sort: approved first, then has-times first, then by distance if location active, otherwise alphabetical
  filtered.sort((a, b) => {
    const aApproved = a.approved !== false ? 1 : 0;
    const bApproved = b.approved !== false ? 1 : 0;
    if (aApproved !== bApproved) return bApproved - aApproved;

    // Masjids with current times above those without (only if we've checked)
    const aHas = hasTimesMap[a.slug] !== false ? 1 : 0;
    const bHas = hasTimesMap[b.slug] !== false ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;

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
    grid.innerHTML = buildEmptyStateHtml();
    return;
  }

  grid.innerHTML = filtered.map(config => {
    const distText = getDistText(config.slug);
    const shortAddr = getCityPostcode(config.address);
    const fullAddr = config.address || '';
    const isFollowedCard = followedSet.has(config.slug);
    const isPrimary = config.slug === primarySlug;
    const pinIcon = isFollowedCard ? STAR_FILLED_SVG : STAR_SVG;
    const pinClass = isFollowedCard ? ' pinned followed' : '';
    const isPending = config.approved === false;

    let subHtml = '';
    if (isPending) {
      subHtml = `<div class="masjid-card-sub"><span class="pending-badge">Pending Review</span></div>`;
    } else if (distText) {
      subHtml = `<div class="masjid-card-sub">${distText}</div>`;
    } else if (config.address) {
      subHtml = `<div class="masjid-card-sub"><span class="addr-short">${shortAddr}</span><span class="addr-full">${fullAddr}</span></div>`;
    }

    const primaryChip = isPrimary
      ? `<div class="my-masjid-chip-row"><span class="my-masjid-chip">★ My Masjid</span></div>`
      : '';
    const thumbContent = config.logo
      ? `<img src="${config.logo}" alt="" loading="lazy" decoding="async">`
      : MOSQUE_SVG;
    const cityAttr = config.city ? ` data-city="${config.city}"` : '';
    return `<a href="/${config.slug}" class="masjid-card" data-link data-slug="${config.slug}"${cityAttr}>
      <div class="masjid-card-top">
        <div class="masjid-card-thumb${config.logo ? ' has-logo' : ''}">${thumbContent}</div>
        <div class="masjid-card-info">
          <div class="masjid-name-row">
            <div class="masjid-name">${config.display_name}</div>
            <button class="pin-btn${pinClass}" data-slug="${config.slug}" aria-label="${isFollowedCard ? 'Unfollow' : 'Follow'} ${config.display_name}" title="${isFollowedCard ? 'Unfollow' : 'Follow'}">
              ${pinIcon}
            </button>
            <button class="kebab-btn" data-slug="${config.slug}" aria-label="More options for ${config.display_name}" title="More options">
              ${KEBAB_SVG}
            </button>
          </div>
          ${primaryChip}
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
    if (h >= 13) return `${h - 12}:${m} PM`;
    if (h === 0) return `12:${m} AM`;
    return `${h}:${m} ${isAM ? 'AM' : 'PM'}`;
  }
  if (h >= 13) return `${h}:${m}`;
  const h24 = isAM ? (h === 12 ? 0 : h) : (h === 12 ? 12 : h + 12);
  return `${h24}:${m}`;
}

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
  let changed = false;
  const promises = configs.map(async (config) => {
    try {
      const csvFile = config.csv || config.slug + '.csv';
      const res = await fetch(`/data/${csvFile}`);
      if (gen !== loadGeneration) return;
      const root = (viewContainer && viewContainer.isConnected) ? viewContainer : document;
      const el = root.querySelector(`[data-card-next="${config.slug}"]`);
      if (!res.ok) {
        if (hasTimesMap[config.slug] !== false) { hasTimesMap[config.slug] = false; changed = true; }
        if (el) el.innerHTML = '';
        return;
      }
      const text = await res.text();
      if (gen !== loadGeneration) return;
      const csvData = parseCSV(text);
      const todayRow = getTodayRow(csvData);
      const hasTimes = !!todayRow;
      if (hasTimesMap[config.slug] !== hasTimes) { hasTimesMap[config.slug] = hasTimes; changed = true; }
      if (!el) return;
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
      if (hasTimesMap[config.slug] !== false) { hasTimesMap[config.slug] = false; changed = true; }
      const root = (viewContainer && viewContainer.isConnected) ? viewContainer : document;
      const el = root.querySelector(`[data-card-next="${config.slug}"]`);
      if (el) el.innerHTML = '';
    }
  });
  await Promise.all(promises);
  // Re-sort cards now that we know which masjids have times
  if (gen === loadGeneration && changed) reorderCards();
}

function reorderCards() {
  const grid = (viewContainer && viewContainer.querySelector('#masjidsGrid')) || document.getElementById('masjidsGrid');
  if (!grid) return;
  const cards = Array.from(grid.children);
  cards.sort((a, b) => {
    const slugA = a.dataset.slug;
    const slugB = b.dataset.slug;
    const hasA = hasTimesMap[slugA] !== false ? 1 : 0;
    const hasB = hasTimesMap[slugB] !== false ? 1 : 0;
    return hasB - hasA;
  });
  cards.forEach(card => grid.appendChild(card));
}

// --- Search ---

function setupSearch() {
  const input = (viewContainer && viewContainer.querySelector('#masjidSearch')) || document.getElementById('masjidSearch');
  if (!input) return;
  input.addEventListener('input', () => {
    searchQuery = input.value.trim();
    renderCards();
    // Postcode-shaped query with no masjid matches → debounced lookup.
    schedulePostcodeLookup(searchQuery, 'search');
  });
}

// --- Pin interactions ---

function setupGridClicks() {
  document.addEventListener('click', handlePinClick, true);
  if (!viewContainer) return;
  const cityGrid = viewContainer.querySelector('#masjidsCityGrid');
  if (cityGrid) cityGrid.addEventListener('click', handleCityCardClick);
}

function handleCityCardClick(e) {
  // Map button on a city card → open the map focused on that city
  const mapBtn = e.target.closest('.masjid-city-map-btn');
  if (mapBtn) {
    e.preventDefault();
    e.stopPropagation();
    const c = mapBtn.closest('.masjid-city-card[data-city]');
    if (c) focusCityOnMap(c.dataset.city);
    return;
  }

  const card = e.target.closest('.masjid-city-card[data-city]');
  if (!card) return;
  selectedCity = card.dataset.city;
  searchQuery = '';
  try { localStorage.setItem('iqamah-last-city', selectedCity); } catch { /* ignore */ }
  const input = viewContainer && viewContainer.querySelector('#masjidSearch');
  if (input) input.value = '';
  updateHeaderState();
  renderCards();
  if (viewContainer) viewContainer.scrollIntoView({ behavior: 'instant', block: 'start' });
}

async function focusCityOnMap(city) {
  // Switch to map mode (mounts the map lazily) then frame that city's masjids.
  setMode('map');
  // Scroll back to the top so the map fills the viewport instead of opening
  // mid-scroll where the tapped card was.
  window.scrollTo({ top: 0, behavior: 'auto' });
  if (mapReadyPromise) await mapReadyPromise;
  // Recompute size after the scroll/show settles, then frame the city.
  refreshMap();
  const points = cachedConfigs
    .filter(c => deriveCity(c) === city)
    .map(c => {
      const lat = c.lat != null ? c.lat : c.latitude;
      const lon = c.lon != null ? c.lon : c.longitude;
      return (lat != null && lon != null) ? [lat, lon] : null;
    })
    .filter(Boolean);
  focusBounds(points);
}

function handlePinClick(e) {
  const masjidsView = e.target.closest('.masjids-view');
  if (!masjidsView) return;

  // ⋯ kebab (non-touch) → context menu anchored to the button
  const kebabBtn = e.target.closest('.kebab-btn');
  if (kebabBtn) {
    e.preventDefault();
    e.stopPropagation();
    openMasjidMenu(kebabBtn.dataset.slug, kebabBtn);
    return;
  }

  // Star → follow / unfollow
  const pinBtn = e.target.closest('.pin-btn');
  if (!pinBtn) return;
  e.preventDefault();
  e.stopPropagation();
  toggleFollowFor(pinBtn.dataset.slug);
}

function setupLongPress() {
  const view = viewContainer || document.querySelector('.masjids-view');
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
      openMasjidMenu(card.dataset.slug, card);
      dismissPinHint();
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

function masjidName(slug) {
  const config = cachedConfigs.find(c => c.slug === slug);
  return config ? config.display_name : 'Masjid';
}

// Star action \u2014 follow / unfollow. First follow auto-becomes primary;
// unfollowing the primary auto-promotes the next followed masjid.
// Re-renders happen via the iqamah-follow-changed listener.
function toggleFollowFor(slug) {
  const name = masjidName(slug);
  if (isFollowed(slug)) {
    const r = unfollow(slug);
    if (r.removedPrimary && r.newPrimary) {
      // Auto-promotion: the toast announces the new primary (.pin-toast is
      // nowrap, so keep it compact)
      showToast(`<span class="toast-star">\u2605</span> ${masjidName(r.newPrimary)} is now My Masjid`);
    } else {
      showToast(`Unfollowed ${name}`);
    }
  } else {
    const r = follow(slug);
    if (!r.ok && r.reason === 'cap') {
      showToast(`You can follow up to ${FOLLOW_CAP} masjids`);
      return;
    }
    showToast(r.becamePrimary
      ? `<span class="toast-star">\u2605</span> ${name} set as My Masjid`
      : `<span class="toast-star">\u2605</span> Following ${name}`);
    dismissPinHint();
  }
}

// Promote to primary (follows first if needed).
function setPrimaryFor(slug) {
  const name = masjidName(slug);
  const r = setPrimary(slug);
  if (!r.ok && r.reason === 'cap') {
    showToast(`You can follow up to ${FOLLOW_CAP} masjids`);
    return;
  }
  showToast(`<span class="toast-star">\u2605</span> ${name} set as My Masjid`);
  dismissPinHint();
}

// Context menu \u2014 opened by long-press (touch) or the \u22ef kebab (non-touch).
function openMasjidMenu(slug, anchor) {
  const name = masjidName(slug);
  const followed = isFollowed(slug);
  const primary = getPrimary() === slug;

  openContextMenu({
    title: name,
    anchor,
    items: [
      {
        icon: STAR_FILLED_SVG,
        label: 'Set as My Masjid',
        checked: primary,
        disabled: primary,
        onSelect: () => setPrimaryFor(slug),
      },
      {
        icon: followed ? STAR_SVG : STAR_FILLED_SVG,
        label: followed ? 'Unfollow' : 'Follow',
        onSelect: () => toggleFollowFor(slug),
      },
      {
        icon: CLOCK_SVG,
        label: 'View times',
        onSelect: () => navigate('/' + slug),
      },
    ],
  });
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

// --- Postcode search (Postcodes.io) ---
// No-permission alternative to the geolocation button: a query shaped like a
// UK postcode/outcode that matches no masjid names/addresses is looked up via
// Postcodes.io, and the resulting coords feed the exact same distance-sort
// path (userLocation / distanceMap / locationActive) as the Nearby button.

function queryRoot() {
  return (viewContainer && viewContainer.isConnected) ? viewContainer : document;
}

function getSearchInput() {
  return queryRoot().querySelector('#masjidSearch');
}

function restorePostcodeState() {
  postcodeActive = false;
  postcodeInfo = null;
  postcodeHint = null;
  postcodeHintLabel = '';
  try {
    const saved = JSON.parse(localStorage.getItem(POSTCODE_STORE_KEY) || 'null');
    if (saved && saved.lat != null && saved.lon != null && saved.outcode) {
      postcodeInfo = {
        lat: saved.lat,
        lon: saved.lon,
        postcode: saved.postcode || saved.outcode,
        outcode: saved.outcode,
      };
      postcodeActive = true;
      // Coords were persisted alongside the postcode — no fetch needed.
      userLocation = { lat: saved.lat, lon: saved.lon };
      locationActive = true;
    }
  } catch { /* ignore corrupt storage */ }
}

// Shared by the geolocation and postcode paths.
function computeDistances() {
  distanceMap = {};
  if (!userLocation) return;
  cachedConfigs.forEach(config => {
    const lat = config.lat != null ? config.lat : config.latitude;
    const lon = config.lon != null ? config.lon : config.longitude;
    if (lat != null && lon != null) {
      distanceMap[config.slug] = haversineDistance(
        userLocation.lat, userLocation.lon, lat, lon
      );
    }
  });
}

// How many masjids the normal text filter would show for this query —
// postcode lookup only kicks in when the answer is zero.
function countQueryMatches(q) {
  const ql = q.toLowerCase();
  let list = cachedConfigs;
  if (selectedCity && isMobile()) list = list.filter(c => deriveCity(c) === selectedCity);
  return list.filter(c =>
    c.display_name.toLowerCase().includes(ql) ||
    (c.address && c.address.toLowerCase().includes(ql))
  ).length;
}

function buildEmptyStateHtml() {
  if (postcodeHint === 'looking') {
    return `<div class="masjids-empty postcode-status"><span class="postcode-spinner" aria-hidden="true"></span>Finding masjids near <strong>${postcodeHintLabel}</strong>&hellip;</div>`;
  }
  if (postcodeHint === 'notfound') {
    return `<div class="masjids-empty postcode-status">Postcode not found &mdash; check it and try again</div>`;
  }
  return `<div class="masjids-empty">No masjids found</div>`;
}

// source: 'search' (main search input — requires zero masjid matches) or
// 'inline' (the dedicated postcode field on the cities screen).
function schedulePostcodeLookup(raw, source) {
  if (postcodeTimer) { clearTimeout(postcodeTimer); postcodeTimer = null; }
  postcodeGen++;
  const parsed = parsePostcodeQuery(raw);
  if (!parsed || (source === 'search' && countQueryMatches(raw) > 0)) {
    if (postcodeHint) setPostcodeHint(null);
    return;
  }
  const gen = postcodeGen;
  postcodeTimer = setTimeout(() => {
    postcodeTimer = null;
    if (gen !== postcodeGen) return;
    runPostcodeLookup(parsed, gen);
  }, POSTCODE_DEBOUNCE_MS);
}

async function runPostcodeLookup(parsed, gen) {
  setPostcodeHint('looking', parsed.display);
  let result;
  try {
    result = await lookupPostcode(parsed);
  } catch (err) {
    if (gen !== postcodeGen) return;
    if (err && err.notFound) {
      setPostcodeHint('notfound', parsed.display);
    } else {
      // Network error / timeout — degrade silently to normal search.
      setPostcodeHint(null);
    }
    return;
  }
  if (gen !== postcodeGen) return;
  applyPostcodeLocation(result);
}

function applyPostcodeLocation(result) {
  postcodeActive = true;
  postcodeInfo = result;
  postcodeHint = null;
  postcodeHintLabel = '';

  // The postcode coords become the active location source — same path as
  // the geolocation button.
  userLocation = { lat: result.lat, lon: result.lon };
  locationActive = true;
  computeDistances();

  try {
    localStorage.setItem(POSTCODE_STORE_KEY, JSON.stringify({
      postcode: result.postcode,
      outcode: result.outcode,
      lat: result.lat,
      lon: result.lon,
      ts: Date.now(),
    }));
  } catch { /* storage full / private mode */ }

  // The query was consumed as a location, not a text filter.
  searchQuery = '';
  const input = getSearchInput();
  if (input) input.value = '';
  collapseInlineForm();
  updateInlineHint();

  // The Nearby (GPS) button is not the source any more — chip communicates it.
  const locBtn = queryRoot().querySelector('#masjidsLocationBtn');
  if (locBtn) {
    locBtn.classList.remove('active', 'loading', 'error');
    const txt = locBtn.querySelector('.location-btn-text');
    if (txt) txt.textContent = 'Nearby';
  }

  updatePostcodeChip();
  updateHeaderState();
  renderCards();

  // If the map is already mounted, recentre it on the postcode.
  if (mapMounted) focusBounds([[result.lat, result.lon]], { maxZoom: 13 });
}

// Clears postcode state (and optionally the persisted record) without
// touching the location-sort variables — callers decide those.
function clearPostcodeMode(forget) {
  if (postcodeTimer) { clearTimeout(postcodeTimer); postcodeTimer = null; }
  postcodeGen++;
  postcodeActive = false;
  postcodeInfo = null;
  postcodeHint = null;
  postcodeHintLabel = '';
  if (forget) {
    try { localStorage.removeItem(POSTCODE_STORE_KEY); } catch { /* ignore */ }
  }
  updatePostcodeChip();
  updateInlineHint();
}

// Chip dismissed — back to default (alphabetical) ordering.
function dismissPostcode() {
  clearPostcodeMode(true);
  locationActive = false;
  userLocation = null;
  distanceMap = {};
  updateHeaderState();
  renderCards();
}

function setPostcodeHint(state, label) {
  postcodeHint = state;
  postcodeHintLabel = label || '';
  updateInlineHint();
  renderCards();
}

function updateInlineHint() {
  const el = queryRoot().querySelector('#postcodeInlineHint');
  if (!el) return;
  if (postcodeHint === 'looking') {
    el.textContent = `Finding masjids near ${postcodeHintLabel}…`;
  } else if (postcodeHint === 'notfound') {
    el.textContent = 'Postcode not found — check it and try again';
  } else {
    el.textContent = '';
  }
  el.hidden = !postcodeHint;
}

function updatePostcodeChip() {
  const row = queryRoot().querySelector('#postcodeChipRow');
  if (!row) return;
  if (postcodeActive && postcodeInfo) {
    const label = row.querySelector('#postcodeChipLabel');
    if (label) label.textContent = postcodeInfo.outcode;
    const chip = row.querySelector('.postcode-chip');
    if (chip) chip.title = `Sorted by distance from ${postcodeInfo.postcode}`;
    row.hidden = false;
  } else {
    row.hidden = true;
  }
}

function collapseInlineForm() {
  const root = queryRoot();
  const form = root.querySelector('#postcodeInlineForm');
  const pill = root.querySelector('#postcodePill');
  if (form) {
    form.hidden = true;
    const input = form.querySelector('#postcodeInlineInput');
    if (input) input.value = '';
  }
  if (pill) pill.hidden = false;
}

function setupPostcodeUI() {
  if (!viewContainer) return;

  // Dismissible "Near {OUTCODE}" chip.
  const chipClear = viewContainer.querySelector('#postcodeChipClear');
  if (chipClear) chipClear.addEventListener('click', dismissPostcode);
  updatePostcodeChip();

  // Cities screen (mobile landing) has no search input, so it gets a compact
  // pill that expands into a postcode field.
  const pill = viewContainer.querySelector('#postcodePill');
  const form = viewContainer.querySelector('#postcodeInlineForm');
  const input = viewContainer.querySelector('#postcodeInlineInput');
  if (!pill || !form || !input) return;

  pill.addEventListener('click', () => {
    pill.hidden = true;
    form.hidden = false;
    input.focus();
  });

  input.addEventListener('input', () => {
    schedulePostcodeLookup(input.value.trim(), 'inline');
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Cancel any pending/in-flight lookup before collapsing.
      if (postcodeTimer) { clearTimeout(postcodeTimer); postcodeTimer = null; }
      postcodeGen++;
      collapseInlineForm();
      setPostcodeHint(null);
    }
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (postcodeTimer) { clearTimeout(postcodeTimer); postcodeTimer = null; }
    const parsed = parsePostcodeQuery(input.value.trim());
    if (!parsed) {
      setPostcodeHint('notfound', input.value.trim());
      return;
    }
    runPostcodeLookup(parsed, ++postcodeGen);
  });
}

// --- Location ---

function setupLocationBtn() {
  const btn = (viewContainer && viewContainer.querySelector('#masjidsLocationBtn')) || document.getElementById('masjidsLocationBtn');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const textEl = btn.querySelector('.location-btn-text');

    // Toggle off — but if a postcode is the current source, fall through and
    // let GPS replace it instead.
    if (locationActive && !postcodeActive) {
      locationActive = false;
      userLocation = null;
      distanceMap = {};
      btn.classList.remove('active');
      textEl.textContent = 'Nearby';
      updateHeaderState();
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

      // GPS replaces any active postcode as the location source.
      if (postcodeActive) clearPostcodeMode(true);

      computeDistances();

      locationActive = true;
      btn.classList.add('active');
      textEl.textContent = 'Nearby';
      updateHeaderState();
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
      // Permission denied — point at the no-permission alternative.
      if (err.code === 1 && !postcodeActive) {
        showToast('Tip: type your postcode to sort by distance');
      }
    }
  });
}

// --- List / Map mode toggle ---

function setupModeToggle() {
  const toggle = (viewContainer && viewContainer.querySelector('#masjidsModeToggle')) || document.getElementById('masjidsModeToggle');
  if (!toggle) return;
  toggle.addEventListener('click', (e) => {
    const btn = e.target.closest('.toggle-btn');
    if (!btn) return;
    setMode(btn.dataset.mode);
  });
}

function setMode(mode) {
  if (mode === viewMode) return;
  viewMode = mode;

  const root = viewContainer || document;
  const slider = root.querySelector('#masjidsModeToggle .toggle-slider');
  const btns = root.querySelectorAll('#masjidsModeToggle .toggle-btn');
  const listPane = root.querySelector('#masjidsListPane');
  const mapPane = root.querySelector('#masjidsMapPane');

  if (slider) slider.classList.toggle('shifted', mode === 'map');
  btns.forEach(b => {
    const active = b.dataset.mode === mode;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  if (mode === 'map') {
    if (listPane) listPane.hidden = true;
    if (mapPane) mapPane.hidden = false;
    if (mapMounted) {
      // Re-showing an already-mounted map: recompute size so the GL canvas
      // doesn't render white after being hidden.
      mapReadyPromise = Promise.resolve();
      refreshMap();
    } else {
      mapReadyPromise = showMap();
    }
  } else {
    if (mapPane) mapPane.hidden = true;
    if (listPane) listPane.hidden = false;
  }
}

async function showMap() {
  if (mapMounted) return;
  mapMounted = true;
  const container = (viewContainer && viewContainer.querySelector('#masjidsMap')) || document.getElementById('masjidsMap');
  if (!container) { mapMounted = false; return; }

  // Make sure configs are loaded before plotting.
  if (masjidsLoadPromise) await masjidsLoadPromise;
  if (!cachedConfigs.length) await loadMasjids();

  // Use live location if "Nearby" was used, else any cached fix from a prior session.
  let startLoc = userLocation;
  if (!startLoc) {
    try {
      const cached = JSON.parse(localStorage.getItem('iqamah-cached-location') || 'null');
      if (cached && cached.lat != null && cached.lon != null) startLoc = cached;
    } catch { /* ignore */ }
  }

  try {
    await mountMap(container, {
      configs: cachedConfigs,
      userLocation: startLoc,
      loadToday: loadTodayForPopup,
    });
  } catch (err) {
    console.error('Map failed to load:', err);
    mapMounted = false;
    container.innerHTML = `<div class="masjids-map-error">Couldn't load the map. Check your connection and try again.</div>`;
  }
}

// Fetch today's prayer times (start + jama'at per salah) for a single masjid —
// used to fill the map popup table on demand. Mirrors prayer-times.js mapping.
async function loadTodayForPopup(slug) {
  const config = cachedConfigs.find(c => c.slug === slug);
  if (!config) return null;
  try {
    const csvFile = config.csv || slug + '.csv';
    const res = await fetch(`/data/${csvFile}`);
    if (!res.ok) return null;
    const r = getTodayRow(parseCSV(await res.text()));
    if (!r) return null;
    const fmt = (t, isAM) => (t ? formatCardTime(t, isAM) : '—');
    const fajrStart = r['Fajr Start'] || r['Subha Sadiq'] || r['Sehri Ends'] || '';
    const rows = [
      { name: 'Fajr', start: fmt(fajrStart, true), jamaat: fmt(r["Fajr Jama'at"], true) },
      { name: 'Dhuhr', start: fmt(r['Zohr'], false), jamaat: fmt(r["Zohar Jama'at"] || '1:00', false) },
      { name: 'Asr', start: fmt(r['Asr'], false), jamaat: fmt(r["Asr Jama'at"], false) },
      { name: 'Maghrib', start: fmt(r['Maghrib Iftari'], false), jamaat: fmt(r["Maghrib Jama'at"] || r['Maghrib Iftari'], false) },
      { name: 'Esha', start: fmt(r['Esha'], false), jamaat: fmt(r["Esha Jama'at"], false) },
    ];
    return { rows };
  } catch {
    return null;
  }
}

export function destroy() {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  if (postcodeTimer) { clearTimeout(postcodeTimer); postcodeTimer = null; }
  postcodeGen++;
  postcodeActive = false;
  postcodeInfo = null;
  postcodeHint = null;
  postcodeHintLabel = '';
  if (longPressCleanup) { longPressCleanup(); longPressCleanup = null; }
  if (resizeListener) { window.removeEventListener('resize', resizeListener); resizeListener = null; }
  document.removeEventListener('click', handlePinClick, true);
  window.removeEventListener('iqamah-follow-changed', onFollowChanged);
  closeContextMenu();
  unmountMap();
  mapMounted = false;
  mapReadyPromise = null;
  viewMode = 'list';
  locationActive = false;
  userLocation = null;
  distanceMap = {};
  searchQuery = '';
  selectedCity = null;
  viewContainer = null;
}
