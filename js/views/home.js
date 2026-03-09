// Home view — masjid grid with pin and nearby features
import { navigate } from '../router.js';
import { haversineDistance, getCurrentPosition } from '../utils/geolocation.js';
import { canInstall, promptInstall, isStandalone, isIOSSafari } from '../utils/pwa.js';

let cachedConfigs = [];
let userLocation = null;
let distanceMap = {};
let locationActive = false;

export function render(container) {
  container.innerHTML = `
    <div class="home-view">
      <header class="home-header">
        <div class="header-content">
          <img src="/salahdaily_icon.png" alt="Prayerly" class="logo">
          <h1>Prayerly</h1>
        </div>
      </header>

      <div class="grid-controls">
        <button class="location-btn" id="locationBtn">
          <svg class="location-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>
            <circle cx="12" cy="10" r="3"/>
          </svg>
          <span class="location-btn-text">Nearby</span>
        </button>
      </div>

      <div class="masjid-grid" id="masjidGrid"></div>

      <div class="cta-section">
        <p class="cta-heading">Can't find your masjid?</p>
        <a class="cta-btn" href="/add" data-link>Add it here</a>
      </div>

      <div class="install-banner" id="installBanner"></div>

      <footer class="home-footer">
        <p>&copy; Prayerly <span id="homeVersion"></span></p>
      </footer>
    </div>
  `;

  // Show skeleton cards immediately
  const grid = document.getElementById('masjidGrid');
  grid.innerHTML = '<div class="skeleton-card"><div class="skeleton-bone"></div></div>'.repeat(3);

  // Load version
  fetch('/version.json').then(r => r.json()).then(d => {
    const el = document.getElementById('homeVersion');
    if (el) el.textContent = 'v' + d.version;
  }).catch(() => {});

  loadMasjids();
  setupLocationBtn();
  setupGridClicks();
  setupInstallBanner();
}

async function loadMasjids() {
  try {
    const res = await fetch('/data/mosques/index.json');
    if (!res.ok) return;
    cachedConfigs = await res.json();
    if (cachedConfigs.length === 0) return;
    renderMasjidCards(cachedConfigs);
  } catch (error) {
    console.error('Error loading masjids:', error);
    const grid = document.getElementById('masjidGrid');
    if (grid) {
      grid.innerHTML =
        '<a href="/faizul" class="masjid-card" data-link><div class="masjid-name">Masjid Faizul Islam</div></a>'
        + '<a href="/quba" class="masjid-card" data-link><div class="masjid-name">Masjid Quba Trust</div></a>';
    }
  }
}

function renderMasjidCards(configs) {
  const grid = document.getElementById('masjidGrid');
  if (!grid) return;

  const pinnedSlug = localStorage.getItem('prayerly-pinned-masjid');
  const sorted = configs.slice().sort((a, b) => {
    if (locationActive) {
      const distA = distanceMap[a.slug];
      const distB = distanceMap[b.slug];
      if (distA == null && distB == null) return 0;
      if (distA == null) return 1;
      if (distB == null) return -1;
      return distA - distB;
    }
    if (a.slug === pinnedSlug && b.slug !== pinnedSlug) return -1;
    if (b.slug === pinnedSlug && a.slug !== pinnedSlug) return 1;
    return a.display_name.localeCompare(b.display_name);
  });

  grid.innerHTML = sorted.map(config => {
    const isPinned = config.slug === pinnedSlug;
    let distBadge = '';
    if (locationActive && distanceMap[config.slug] != null) {
      const d = distanceMap[config.slug];
      const label = d < 0.1 ? '< 0.1 mi' : d.toFixed(1) + ' mi';
      distBadge = `<span class="distance-badge">${label}</span>`;
    }
    return `<a href="/${config.slug}" class="masjid-card${isPinned ? ' pinned' : ''}" data-link>
      <button class="pin-btn" data-slug="${config.slug}" aria-label="${isPinned ? 'Unpin' : 'Pin'} ${config.display_name}" title="${isPinned ? 'Unpin masjid' : 'Pin as my masjid'}">
        <svg viewBox="0 0 24 24" fill="${isPinned ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2l2.09 6.26L21 9.27l-5 4.87L17.18 21 12 17.27 6.82 21 8 14.14l-5-4.87 6.91-1.01z"/>
        </svg>
      </button>
      ${distBadge}
      <div>
        <div class="pinned-label">My Masjid</div>
        <div class="masjid-name">${config.display_name}</div>
      </div>
    </a>`;
  }).join('');
}

function setupGridClicks() {
  const grid = document.getElementById('masjidGrid');
  if (!grid) return;

  grid.addEventListener('click', (e) => {
    // Pin button
    const pinBtn = e.target.closest('.pin-btn');
    if (pinBtn) {
      e.preventDefault();
      e.stopPropagation();
      const slug = pinBtn.dataset.slug;
      const current = localStorage.getItem('prayerly-pinned-masjid');
      if (current === slug) {
        localStorage.removeItem('prayerly-pinned-masjid');
      } else {
        localStorage.setItem('prayerly-pinned-masjid', slug);
      }
      renderMasjidCards(cachedConfigs);
      return;
    }
  });
}

function setupLocationBtn() {
  const btn = document.getElementById('locationBtn');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const textEl = btn.querySelector('.location-btn-text');

    if (locationActive) {
      locationActive = false;
      userLocation = null;
      distanceMap = {};
      btn.classList.remove('active');
      textEl.textContent = 'Nearby';
      renderMasjidCards(cachedConfigs);
      return;
    }

    btn.classList.add('loading');
    textEl.textContent = 'Locating...';

    try {
      const pos = await getCurrentPosition();
      btn.classList.remove('loading');
      userLocation = { lat: pos.coords.latitude, lon: pos.coords.longitude };

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
      renderMasjidCards(cachedConfigs);
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

function setupInstallBanner() {
  if (isStandalone()) return;
  const banner = document.getElementById('installBanner');
  if (!banner) return;

  if (canInstall()) {
    // Android — show install button
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
    // iOS Safari — show share instructions
    banner.innerHTML = `
      <button class="install-dismiss" aria-label="Dismiss">&times;</button>
      <div class="install-banner-text"><strong>Install Prayerly</strong> — tap <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: middle; margin: 0 2px;"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> then <strong>"Add to Home Screen"</strong>.</div>`;
    banner.classList.add('visible');
    banner.querySelector('.install-dismiss').addEventListener('click', () => {
      banner.classList.remove('visible');
    });
  }
}

export function destroy() {
  // Reset location state when leaving home
  locationActive = false;
  userLocation = null;
  distanceMap = {};
}
