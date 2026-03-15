// Qibla compass view -points to the Kaaba using device orientation
import { calculateQiblaBearing, getCurrentPosition, getCardinalDirection } from '../utils/geolocation.js';

let watchId = null;
let orientationHandler = null;
let qiblaBearing = null;
let currentHeading = null;

const MOSQUE_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2c-.4.6-.8 1.3-.6 2 .1.4.6.6.6.6s.5-.2.6-.6c.2-.7-.2-1.4-.6-2z"/><path d="M12 4.5C9.5 6.5 7 9 7 11.5c0 0 0 .5.2.5H16.8c.2 0 .2-.5.2-.5 0-2.5-2.5-5-5-7z"/><rect x="5" y="12" width="14" height="9"/><path d="M12 21v-5a2.5 2.5 0 0 0-2.5-2.5h0A2.5 2.5 0 0 0 7 16v5"/><rect x="2" y="10" width="3" height="11" rx=".5"/><rect x="19" y="10" width="3" height="11" rx=".5"/></svg>';

function isMobile() {
  return window.innerWidth < 768 || /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function render(container) {
  if (!isMobile()) {
    container.innerHTML = `<div class="qibla-view">
      <header><h1>Qibla Finder</h1></header>
      <div class="qibla-desktop-msg">
        <p>The Qibla Finder uses your phone's compass and is only available on mobile devices.</p>
        <p class="qibla-desktop-sub">Open Iqamah on your phone to use this feature.</p>
      </div>
    </div>`;
    return;
  }

  container.innerHTML = `
    <div class="qibla-view">
      <div class="qibla-bearing-display" id="qiblaBearingDisplay">
        <div class="qibla-bearing-value" id="qiblaBearing">--°</div>
        <div class="qibla-badge" id="qiblaBadge">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>
          <span id="qiblaStatus">Getting location...</span>
        </div>
      </div>

      <div class="compass-container" id="compassContainer">
        <div class="compass-outer-ring"></div>
        <div class="compass-inner-ring"></div>
        <div class="compass" id="compass">
          <span class="compass-dir compass-n">N</span>
          <span class="compass-dir compass-e">E</span>
          <span class="compass-dir compass-s">S</span>
          <span class="compass-dir compass-w">W</span>

          <div class="qibla-needle" id="qiblaNeedle">
            <div class="needle-line"></div>
            <div class="needle-icon">${MOSQUE_SVG}</div>
          </div>

          <div class="compass-center"></div>
        </div>
      </div>

      <div class="qibla-actions">
        <div class="qibla-permission" id="qiblaPermission" style="display:none;">
          <button class="qibla-enable-btn" id="enableCompassBtn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>
            Enable Compass
          </button>
        </div>
        <div class="qibla-location" id="qiblaLocation"></div>
      </div>
    </div>
  `;

  initQibla();
}

export function destroy() {
  if (orientationHandler) {
    window.removeEventListener('deviceorientationabsolute', orientationHandler);
    window.removeEventListener('deviceorientation', orientationHandler);
    orientationHandler = null;
  }
  watchId = null;
  qiblaBearing = null;
  currentHeading = null;
}

async function initQibla() {
  const bearingEl = document.getElementById('qiblaBearing');
  const statusEl = document.getElementById('qiblaStatus');
  const badgeEl = document.getElementById('qiblaBadge');
  const locationEl = document.getElementById('qiblaLocation');

  try {
    const pos = await getCurrentPosition({ timeout: 15000 });
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;
    localStorage.setItem('iqamah-cached-location', JSON.stringify({ lat, lon }));

    qiblaBearing = calculateQiblaBearing(lat, lon);
    const direction = getCardinalDirection(qiblaBearing);

    bearingEl.textContent = `${Math.round(qiblaBearing)}° ${direction}`;
    statusEl.textContent = 'Qibla Direction';

    // Reverse geocode for location display
    const locIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';
    locationEl.innerHTML = `${locIcon}<span>${lat.toFixed(2)}°, ${lon.toFixed(2)}°</span>`;
    try {
      const geoRes = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10`);
      if (geoRes.ok) {
        const geoData = await geoRes.json();
        const addr = geoData.address || {};
        const city = addr.city || addr.town || addr.village || addr.suburb || '';
        const country = addr.country || '';
        const display = [city, country].filter(Boolean).join(', ');
        if (display) locationEl.innerHTML = `${locIcon}<span>${display}</span>`;
      }
    } catch {};

    // Set initial needle position (static)
    const needle = document.getElementById('qiblaNeedle');
    if (needle) needle.style.transform = `rotate(${qiblaBearing}deg)`;

    await startCompass();
  } catch (err) {
    badgeEl.classList.add('qibla-badge-error');
    bearingEl.textContent = '--°';
    if (err.code === 1) {
      // Check if permission is permanently blocked
      if (navigator.permissions) {
        try {
          const perm = await navigator.permissions.query({ name: 'geolocation' });
          if (perm.state === 'denied') {
            statusEl.textContent = 'Location blocked - enable in browser settings';
            return;
          }
        } catch {}
      }
      statusEl.textContent = 'Location denied - tap to retry';
    } else {
      statusEl.textContent = 'Location unavailable - tap to retry';
    }
    badgeEl.style.cursor = 'pointer';
    badgeEl.addEventListener('click', () => {
      badgeEl.classList.remove('qibla-badge-error');
      badgeEl.style.cursor = '';
      statusEl.textContent = 'Getting location...';
      bearingEl.textContent = '--°';
      initQibla();
    }, { once: true });
  }
}

async function startCompass() {
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    const permissionEl = document.getElementById('qiblaPermission');
    const enableBtn = document.getElementById('enableCompassBtn');

    permissionEl.style.display = 'block';

    enableBtn.addEventListener('click', async () => {
      try {
        const response = await DeviceOrientationEvent.requestPermission();
        if (response === 'granted') {
          permissionEl.style.display = 'none';
          attachOrientationListener();
        } else {
          permissionEl.querySelector('button').textContent = 'Permission denied';
          enableBtn.disabled = true;
        }
      } catch (e) {
        permissionEl.querySelector('button').textContent = 'Compass unavailable';
        enableBtn.disabled = true;
      }
    });
  } else if ('DeviceOrientationEvent' in window) {
    attachOrientationListener();
  }
}

function attachOrientationListener() {
  // Remove previous listener if one exists (prevents accumulation)
  if (orientationHandler) {
    window.removeEventListener('deviceorientationabsolute', orientationHandler);
    window.removeEventListener('deviceorientation', orientationHandler);
  }

  orientationHandler = (e) => {
    let heading = null;

    if (e.webkitCompassHeading !== undefined) {
      heading = e.webkitCompassHeading;
    } else if (e.alpha !== null && e.absolute) {
      heading = (360 - e.alpha) % 360;
    } else if (e.alpha !== null) {
      heading = (360 - e.alpha) % 360;
    }

    if (heading !== null && qiblaBearing !== null) {
      currentHeading = heading;
      updateCompass(heading);
    }
  };

  if ('ondeviceorientationabsolute' in window) {
    window.addEventListener('deviceorientationabsolute', orientationHandler);
  } else {
    window.addEventListener('deviceorientation', orientationHandler);
  }
}

function updateCompass(deviceHeading) {
  const compass = document.getElementById('compass');
  const needle = document.getElementById('qiblaNeedle');
  if (!compass || !needle) return;

  compass.style.transform = `rotate(${-deviceHeading}deg)`;
  needle.style.transform = `rotate(${qiblaBearing}deg)`;

  const diff = Math.abs(((deviceHeading - qiblaBearing) + 540) % 360 - 180);
  const container = document.getElementById('compassContainer');
  const badgeEl = document.getElementById('qiblaBadge');
  const statusEl = document.getElementById('qiblaStatus');

  if (container) {
    if (diff < 5) {
      container.classList.add('on-qibla');
      if (badgeEl) badgeEl.classList.add('qibla-badge-aligned');
      if (statusEl) statusEl.textContent = 'Facing the Kaaba';
    } else {
      container.classList.remove('on-qibla');
      if (badgeEl) badgeEl.classList.remove('qibla-badge-aligned');
      if (statusEl) statusEl.textContent = 'Qibla Direction';
    }
  }
}
