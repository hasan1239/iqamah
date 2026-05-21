// Lazy-loads Leaflet + MarkerCluster from CDN on first use.
// Keeps the ~50KB of map libs off the critical path — only fetched when
// the user actually opens the map. Resolves to window.L once ready.

const LEAFLET_VERSION = '1.9.4';
const CLUSTER_VERSION = '1.5.3';

const ASSETS = {
  css: [
    `https://cdn.jsdelivr.net/npm/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`,
    `https://cdn.jsdelivr.net/npm/leaflet.markercluster@${CLUSTER_VERSION}/dist/MarkerCluster.css`,
  ],
  js: [
    `https://cdn.jsdelivr.net/npm/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`,
    `https://cdn.jsdelivr.net/npm/leaflet.markercluster@${CLUSTER_VERSION}/dist/leaflet.markercluster.js`,
  ],
};

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
    ASSETS.css.forEach(loadCss);
    // Leaflet core must finish before the cluster plugin (which extends L).
    await loadScript(ASSETS.js[0]);
    await loadScript(ASSETS.js[1]);
    if (!window.L) throw new Error('Leaflet failed to initialise');
    return window.L;
  })().catch((err) => {
    loadPromise = null; // allow retry on next open
    throw err;
  });

  return loadPromise;
}
