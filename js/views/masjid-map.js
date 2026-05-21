// Masjid map pane — Leaflet map with clustered masjid markers and a "locate me"
// control. Mounted lazily by the Masjids view when the user switches to Map.
import { loadLeaflet } from '../utils/leaflet-loader.js';
import { onThemeChange, getTheme } from '../theme.js';
import { getCurrentPosition } from '../utils/geolocation.js';

// MapLibre GL vector tiles via OpenFreeMap — free, no API key.
// Light mode uses OpenFreeMap's Positron style; dark/night use a custom style
// with white roads and labels on a black background (see DARK_STYLE below).
const OFM_GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
const OFM_SOURCE = { openmaptiles: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' } };
const LIGHT_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const TILE_ATTRIB = '&copy; <a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
// Centre of Great Britain — fallback view when no markers and no user location.
const GB_CENTER = [54.0, -2.5];

// White roads + white labels on black. OpenMapTiles schema (matches OpenFreeMap).
const DARK_STYLE = {
  version: 8,
  glyphs: OFM_GLYPHS,
  sources: OFM_SOURCE,
  layers: [
    { id: 'bg', type: 'background', paint: { 'background-color': '#000000' } },
    { id: 'water', type: 'fill', source: 'openmaptiles', 'source-layer': 'water',
      paint: { 'fill-color': '#0c1118' } },
    // Minor roads — thinner, slightly dimmed white so the hierarchy reads.
    { id: 'roads-minor', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation',
      filter: ['all',
        ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
        ['!', ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary'], true, false]]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#cfd4da',
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.4, 14, 1, 17, 3, 19, 7],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.45, 14, 0.75] } },
    // Major roads — full white, thicker.
    { id: 'roads-major', type: 'line', source: 'openmaptiles', 'source-layer': 'transportation',
      filter: ['all',
        ['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false],
        ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary'], true, false]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 10, 1.4, 13, 2.4, 16, 5, 19, 12] } },
    // Road name labels.
    { id: 'road-labels', type: 'symbol', source: 'openmaptiles', 'source-layer': 'transportation_name',
      minzoom: 13,
      layout: { 'symbol-placement': 'line', 'text-font': ['Noto Sans Regular'], 'text-size': 11,
        'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']] },
      paint: { 'text-color': '#ffffff', 'text-halo-color': '#000000', 'text-halo-width': 1.2 } },
    // Place labels (cities, towns, suburbs).
    { id: 'place-labels', type: 'symbol', source: 'openmaptiles', 'source-layer': 'place',
      filter: ['match', ['get', 'class'], ['city', 'town', 'village', 'suburb', 'neighbourhood'], true, false],
      layout: { 'text-font': ['Noto Sans Regular'],
        'text-size': ['interpolate', ['linear'], ['zoom'], 5, 11, 12, 16],
        'text-field': ['coalesce', ['get', 'name_en'], ['get', 'name']] },
      paint: { 'text-color': '#ffffff', 'text-halo-color': '#000000', 'text-halo-width': 1.4 } },
  ],
};

let map = null;
let tileLayer = null;
let clusterGroup = null;
let userMarker = null;
let themeUnsub = null;
let loadTodayFn = null;

function styleForTheme(theme) {
  return theme === 'light' ? LIGHT_STYLE : DARK_STYLE;
}

function addBaseLayer(L, theme) {
  if (tileLayer) { map.removeLayer(tileLayer); tileLayer = null; }
  tileLayer = L.maplibreGL({ style: styleForTheme(theme) });
  tileLayer.addTo(map);
  // Keep the GL canvas beneath the marker/cluster panes.
  if (tileLayer.getContainer) {
    const c = tileLayer.getContainer();
    if (c) c.style.zIndex = '200';
  }
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
      <div class="map-popup-times" data-popup-times="${config.slug}">
        <div class="map-popup-times-loading">Loading today's times…</div>
      </div>
      <a class="map-popup-link" href="/${config.slug}" data-link>View prayer times &rsaquo;</a>
    </div>`;
}

// Fill in the popup's today's-times table once it opens (lazy CSV fetch).
async function fillPopupTimes(config) {
  if (!loadTodayFn) return;
  const el = document.querySelector(`[data-popup-times="${config.slug}"]`);
  if (!el) return;
  let data = null;
  try {
    data = await loadTodayFn(config.slug);
  } catch { /* ignore */ }
  const fresh = document.querySelector(`[data-popup-times="${config.slug}"]`);
  if (!fresh) return;
  if (!data || !data.rows || !data.rows.length) {
    fresh.innerHTML = `<div class="map-popup-times-none">Times not available today</div>`;
    return;
  }
  const body = data.rows.map(r => `
    <tr>
      <td class="map-popup-salah">${r.name}</td>
      <td>${r.start}</td>
      <td>${r.jamaat}</td>
    </tr>`).join('');
  fresh.innerHTML = `
    <table class="map-popup-table">
      <thead><tr><th>Salah</th><th>Start</th><th>Jama'at</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

export async function mountMap(container, { configs = [], userLocation = null, loadToday = null } = {}) {
  loadTodayFn = loadToday;
  const L = await loadLeaflet();

  // Container may have been torn down while Leaflet loaded.
  if (!container || !container.isConnected) return;

  const theme = getTheme();

  map = L.map(container, {
    zoomControl: true,
    attributionControl: true,
    scrollWheelZoom: true,
    maxZoom: 19,
  });

  addBaseLayer(L, theme);
  if (map.attributionControl) map.attributionControl.addAttribution(TILE_ATTRIB);

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
    marker.on('popupopen', () => fillPopupTimes(config));
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

  // Swap the basemap when the user toggles theme while the map is open.
  themeUnsub = onThemeChange((t) => {
    if (map) addBaseLayer(L, t);
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
  loadTodayFn = null;
}
