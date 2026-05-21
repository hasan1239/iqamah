// Masjid map pane — Leaflet map with clustered masjid markers and a "locate me"
// control. Mounted lazily by the Masjids view when the user switches to Map.
import { loadLeaflet } from '../utils/leaflet-loader.js';
import { onThemeChange, getTheme } from '../theme.js';
import { getCurrentPosition } from '../utils/geolocation.js';

// CARTO basemaps — free, no API key. Light tiles in light mode, dark otherwise.
const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};
const TILE_ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
// Centre of Great Britain — fallback view when no markers and no user location.
const GB_CENTER = [54.0, -2.5];

let map = null;
let tileLayer = null;
let clusterGroup = null;
let userMarker = null;
let themeUnsub = null;
let loadNextFn = null;

function tileUrlForTheme(theme) {
  return theme === 'light' ? TILES.light : TILES.dark;
}

function markerIcon(L) {
  return L.divIcon({
    className: 'masjid-map-pin',
    html: `<span class="masjid-map-pin-dot"></span>`,
    iconSize: [28, 36],
    iconAnchor: [14, 34],
    popupAnchor: [0, -30],
  });
}

function userIcon(L) {
  return L.divIcon({
    className: 'masjid-map-user',
    html: `<span class="masjid-map-user-dot"></span>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

function popupHtml(config) {
  const addr = config.address ? `<div class="map-popup-addr">${config.address}</div>` : '';
  return `
    <div class="map-popup" data-slug="${config.slug}">
      <div class="map-popup-name">${config.display_name}</div>
      ${addr}
      <div class="map-popup-next" data-popup-next="${config.slug}"></div>
      <a class="map-popup-link" href="/${config.slug}" data-link>View prayer times &rsaquo;</a>
    </div>`;
}

// Fill in the popup's "next prayer" line once it opens (lazy CSV fetch).
async function fillPopupNext(config) {
  if (!loadNextFn) return;
  const el = document.querySelector(`[data-popup-next="${config.slug}"]`);
  if (!el) return;
  try {
    const next = await loadNextFn(config.slug);
    const fresh = document.querySelector(`[data-popup-next="${config.slug}"]`);
    if (!fresh) return;
    if (next) {
      fresh.innerHTML = `<span class="map-popup-next-label">${next.name}</span> <span class="map-popup-next-time">${next.time}</span>`;
    } else {
      fresh.innerHTML = '';
    }
  } catch { /* ignore */ }
}

export async function mountMap(container, { configs = [], userLocation = null, loadNext = null } = {}) {
  loadNextFn = loadNext;
  const L = await loadLeaflet();

  // Container may have been torn down while Leaflet loaded.
  if (!container || !container.isConnected) return;

  const theme = getTheme();

  map = L.map(container, {
    zoomControl: true,
    attributionControl: true,
    scrollWheelZoom: true,
  });

  tileLayer = L.tileLayer(tileUrlForTheme(theme), {
    maxZoom: 19,
    attribution: TILE_ATTRIB,
    detectRetina: true,
  }).addTo(map);

  clusterGroup = L.markerClusterGroup({
    showCoverageOnHover: false,
    maxClusterRadius: 50,
    iconCreateFunction: (cluster) => L.divIcon({
      className: 'masjid-map-cluster',
      html: `<span>${cluster.getChildCount()}</span>`,
      iconSize: [40, 40],
    }),
  });

  const icon = markerIcon(L);
  const bounds = [];
  configs.forEach((config) => {
    const lat = config.lat != null ? config.lat : config.latitude;
    const lon = config.lon != null ? config.lon : config.longitude;
    if (lat == null || lon == null) return;
    const marker = L.marker([lat, lon], { icon, title: config.display_name });
    marker.bindPopup(popupHtml(config), { closeButton: true, autoPan: true });
    marker.on('popupopen', () => fillPopupNext(config));
    clusterGroup.addLayer(marker);
    bounds.push([lat, lon]);
  });
  map.addLayer(clusterGroup);

  // Initial view: user location if known, else fit all markers, else GB.
  if (userLocation) {
    map.setView([userLocation.lat, userLocation.lon], 12);
    addUserMarker(L, userLocation);
  } else if (bounds.length) {
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
  } else {
    map.setView(GB_CENTER, 6);
  }

  addLocateControl(L);

  // Swap tiles when the user toggles theme while the map is open.
  themeUnsub = onThemeChange((t) => {
    if (tileLayer) tileLayer.setUrl(tileUrlForTheme(t));
  });

  // Leaflet mis-sizes if the container animated in; settle after layout.
  setTimeout(() => { if (map) map.invalidateSize(); }, 50);
}

function addUserMarker(L, loc) {
  if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
  userMarker = L.marker([loc.lat, loc.lon], { icon: userIcon(L), zIndexOffset: 1000, interactive: false });
  userMarker.addTo(map);
}

function addLocateControl(L) {
  const LocateControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const btn = L.DomUtil.create('button', 'masjid-map-locate leaflet-bar');
      btn.type = 'button';
      btn.title = 'Show my location';
      btn.setAttribute('aria-label', 'Show my location');
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>`;
      L.DomEvent.disableClickPropagation(btn);
      L.DomEvent.on(btn, 'click', async () => {
        btn.classList.add('loading');
        try {
          const pos = await getCurrentPosition();
          const loc = { lat: pos.coords.latitude, lon: pos.coords.longitude };
          addUserMarker(L, loc);
          map.setView([loc.lat, loc.lon], 13);
        } catch {
          btn.classList.add('error');
          setTimeout(() => btn.classList.remove('error'), 2000);
        } finally {
          btn.classList.remove('loading');
        }
      });
      return btn;
    },
  });
  map.addControl(new LocateControl());
}

export function unmountMap() {
  if (themeUnsub) { themeUnsub(); themeUnsub = null; }
  if (map) { map.remove(); map = null; }
  tileLayer = null;
  clusterGroup = null;
  userMarker = null;
  loadNextFn = null;
}
