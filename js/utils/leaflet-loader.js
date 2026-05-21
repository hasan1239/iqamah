// Lazy-loads Leaflet + MarkerCluster + MapLibre GL (for vector tiles) from CDN
// on first use. Keeps the map libs off the critical path — only fetched when
// the user actually opens the map. Resolves to window.L once ready.

const LEAFLET_VERSION = '1.9.4';
const CLUSTER_VERSION = '1.5.3';
const MAPLIBRE_VERSION = '4.7.1';
const MAPLIBRE_LEAFLET_VERSION = '0.0.22';

const CSS = [
  `https://cdn.jsdelivr.net/npm/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`,
  `https://cdn.jsdelivr.net/npm/leaflet.markercluster@${CLUSTER_VERSION}/dist/MarkerCluster.css`,
  `https://cdn.jsdelivr.net/npm/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.css`,
];

// Leaflet core first; MapLibre GL before its Leaflet bridge; cluster plugin
// extends L so it can come after core.
const LEAFLET_CORE = `https://cdn.jsdelivr.net/npm/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;
const CLUSTER_JS = `https://cdn.jsdelivr.net/npm/leaflet.markercluster@${CLUSTER_VERSION}/dist/leaflet.markercluster.js`;
const MAPLIBRE_JS = `https://cdn.jsdelivr.net/npm/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.js`;
const MAPLIBRE_LEAFLET_JS = `https://cdn.jsdelivr.net/npm/@maplibre/maplibre-gl-leaflet@${MAPLIBRE_LEAFLET_VERSION}/leaflet-maplibre-gl.js`;

let loadPromise = null;

function loadCss(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.appendChild(link);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded) resolve();
      else {
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)));
      }
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.addEventListener('load', () => { script.dataset.loaded = '1'; resolve(); });
    script.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)));
    document.head.appendChild(script);
  });
}

export function loadLeaflet() {
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    CSS.forEach(loadCss);
    // Leaflet core and MapLibre GL are independent — load in parallel.
    await Promise.all([loadScript(LEAFLET_CORE), loadScript(MAPLIBRE_JS)]);
    if (!window.L) throw new Error('Leaflet failed to initialise');
    if (!window.maplibregl) throw new Error('MapLibre GL failed to initialise');
    // These extend L / depend on both globals, so they come after.
    await Promise.all([loadScript(CLUSTER_JS), loadScript(MAPLIBRE_LEAFLET_JS)]);
    if (!window.L.maplibreGL) throw new Error('maplibre-gl-leaflet failed to initialise');
    return window.L;
  })().catch((err) => {
    loadPromise = null; // allow retry on next open
    throw err;
  });

  return loadPromise;
}
