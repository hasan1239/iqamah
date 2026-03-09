// Qibla compass view — points to the Kaaba using device orientation
import { calculateQiblaBearing, getCurrentPosition, getCardinalDirection } from '../utils/geolocation.js';

let watchId = null;
let orientationHandler = null;
let qiblaBearing = null;

function isMobile() {
  return window.innerWidth < 768 || /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

export function render(container) {
  if (!isMobile()) {
    container.innerHTML = `<div class="qibla-view">
      <header><h1>Qibla Finder</h1></header>
      <div style="text-align:center; padding:60px 20px; color:var(--text-tertiary);">
        <p style="font-size:1.1rem; margin-bottom:8px;">The Qibla Finder uses your phone's compass and is only available on mobile devices.</p>
        <p style="font-size:0.9rem;">Open Prayerly on your phone to use this feature.</p>
      </div>
    </div>`;
    return;
  }

  container.innerHTML = `
    <div class="qibla-view">
      <header>
        <h1>Qibla Finder</h1>
        <p class="qibla-subtitle">Point your phone towards the Qibla</p>
      </header>

      <div class="compass-container" id="compassContainer">
        <div class="compass" id="compass">
          <div class="compass-ring">
            <span class="compass-dir compass-n">N</span>
            <span class="compass-dir compass-e">E</span>
            <span class="compass-dir compass-s">S</span>
            <span class="compass-dir compass-w">W</span>
          </div>
          <div class="qibla-needle" id="qiblaNeedle">
            <svg viewBox="0 0 24 80" width="24" height="80">
              <polygon points="12,0 20,70 12,60 4,70" fill="var(--gold)" stroke="var(--gold-dark)" stroke-width="1"/>
            </svg>
          </div>
          <div class="kaaba-icon" id="kaabaIcon">&#x1F54B;</div>
        </div>
      </div>

      <div class="qibla-info" id="qiblaInfo">
        <div class="qibla-status" id="qiblaStatus">Getting your location...</div>
        <div class="qibla-bearing" id="qiblaBearing"></div>
      </div>

      <div class="qibla-permission" id="qiblaPermission" style="display:none;">
        <p>Enable compass access to use the Qibla finder.</p>
        <button class="qibla-enable-btn" id="enableCompassBtn">Enable Compass</button>
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
}

async function initQibla() {
  const statusEl = document.getElementById('qiblaStatus');
  const bearingEl = document.getElementById('qiblaBearing');

  try {
    const pos = await getCurrentPosition({ timeout: 15000 });
    const lat = pos.coords.latitude;
    const lon = pos.coords.longitude;

    qiblaBearing = calculateQiblaBearing(lat, lon);
    const direction = getCardinalDirection(qiblaBearing);

    statusEl.textContent = 'Qibla Direction';
    bearingEl.textContent = `${Math.round(qiblaBearing)}\u00B0 ${direction}`;

    // Try to start compass
    await startCompass();
  } catch (err) {
    if (err.code === 1) {
      statusEl.textContent = 'Location access denied';
      bearingEl.textContent = 'Please allow location access to find Qibla direction';
    } else {
      statusEl.textContent = 'Could not get location';
      bearingEl.textContent = 'Please ensure location services are enabled';
    }
  }
}

async function startCompass() {
  // iOS 13+ requires permission
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
          permissionEl.querySelector('p').textContent = 'Compass permission denied. The bearing is shown above.';
          enableBtn.style.display = 'none';
        }
      } catch (e) {
        permissionEl.querySelector('p').textContent = 'Could not request compass permission.';
        enableBtn.style.display = 'none';
      }
    });
  } else if ('DeviceOrientationEvent' in window) {
    attachOrientationListener();
  }
  // If no device orientation, just show the static bearing
}

function attachOrientationListener() {
  orientationHandler = (e) => {
    let heading = null;

    // iOS uses webkitCompassHeading
    if (e.webkitCompassHeading !== undefined) {
      heading = e.webkitCompassHeading;
    }
    // Android/Chrome uses alpha (but needs absolute orientation)
    else if (e.alpha !== null && e.absolute) {
      heading = (360 - e.alpha) % 360;
    }
    else if (e.alpha !== null) {
      heading = (360 - e.alpha) % 360;
    }

    if (heading !== null && qiblaBearing !== null) {
      updateCompass(heading);
    }
  };

  // Prefer absolute orientation
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

  // Rotate entire compass opposite to device heading
  compass.style.transform = `rotate(${-deviceHeading}deg)`;

  // Needle always points to qibla bearing (relative to north)
  needle.style.transform = `rotate(${qiblaBearing}deg)`;

  // Highlight when pointing towards qibla (within 5 degrees)
  const diff = Math.abs(((deviceHeading - qiblaBearing) + 540) % 360 - 180);
  const container = document.getElementById('compassContainer');
  if (container) {
    if (diff < 5) {
      container.classList.add('on-qibla');
    } else {
      container.classList.remove('on-qibla');
    }
  }
}
