const APP_VERSION = '2.4.9'; // Must match version.json
const CACHE_NAME = `iqamah-v${APP_VERSION}`;

const PRECACHE_URLS = [
  './',
  './index.html',
  './iqamah-icon.svg',
  './iqamah-icon.png',
  './iqamah-logo.svg',
  // JS modules
  './js/app.js',
  './js/router.js',
  './js/nav.js',
  './js/theme.js',
  './js/background.js',
  './js/utils/csv.js',
  './js/utils/countdown.js',
  './js/utils/geolocation.js',
  './js/utils/pwa.js',
  './js/views/home.js',
  './js/views/prayer-times.js',
  './js/views/qibla.js',
  './js/views/settings.js',
  './js/views/add-masjid.js',
  './js/views/update-masjid.js',
  './js/views/eid-times.js',
  './js/views/not-found.js',
];

// Install: precache core assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// Message: allow clients to trigger skipWaiting
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Fetch: route requests by caching strategy
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip GoatCounter analytics — network only
  if (url.hostname === 'gc.zgo.at' || url.hostname.endsWith('.goatcounter.com')) {
    return;
  }

  // Skip API calls — network only
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // App shell navigation: serve cached index.html for all navigation requests
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put('index.html', clone));
          return response;
        })
        .catch(() => caches.match('index.html'))
    );
    return;
  }

  // Google Fonts font files (fonts.gstatic.com) — cache first (immutable)
  if (url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        });
      })
    );
    return;
  }

  // Google Fonts CSS (fonts.googleapis.com) — stale while revalidate
  if (url.hostname === 'fonts.googleapis.com') {
    event.respondWith(
      caches.match(event.request).then(cached => {
        const fetchPromise = fetch(event.request).then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        });
        return cached || fetchPromise;
      })
    );
    return;
  }

  // CSV data and lockscreen images — network first, fall back to cache
  if (url.pathname.endsWith('.csv') || url.pathname.includes('/latest/')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Same-origin assets (JS, JSON, images) — network first, fall back to cache
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() =>
          caches.match(event.request).then(cached =>
            cached || new Response('Offline', { status: 503, statusText: 'Service Unavailable' })
          )
        )
    );
    return;
  }

  // Third-party assets — stale while revalidate
  event.respondWith(
    caches.match(event.request).then(cached => {
      const fetchPromise = fetch(event.request).then(response => {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        return response;
      }).catch(() => {
        if (cached) return cached;
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      });
      return cached || fetchPromise;
    })
  );
});
