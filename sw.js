const APP_VERSION = '2.4.74'; // Must match version.json
const OFFLINE_CACHE = `iqamah-offline-v${APP_VERSION}`;

// Install: cache index.html as offline fallback, then skip waiting
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(OFFLINE_CACHE)
      .then(cache => cache.add('./index.html').catch(() => null))
      .then(() => self.skipWaiting())
  );
});

// Activate: nuke every previous cache and take control
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

// Allow clients to trigger skipWaiting
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// Push: server-sent reminder (v1). Payload is JSON with the rendered copy +
// routing data; the scheduler Worker builds it. Falls back gracefully if empty.
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || 'Prayer reminder';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || undefined,
      icon: '/iqamah-icon.png',
      badge: '/iqamah-icon-transparent.png',
      data: { url: data.url || '/', prayer: data.prayer },
      actions: [
        { action: 'view', title: 'View times' },
        { action: 'prayed', title: 'Prayed' },
      ],
    })
  );
});

// Notification click: focus an existing tab (navigating it to the target) or
// open a new one. data.url is set by the foreground scheduler (js/utils/notifications.js).
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};

  // "Prayed" — don't open the app. Mark the salah done so its remaining
  // jama'at/end reminders are suppressed, both client-side (open page →
  // localStorage, v0) and server-side (POST /api/push/prayed → KV, v1).
  if (event.action === 'prayed') {
    event.waitUntil((async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clients.forEach(c => c.postMessage({ type: 'iqamah-prayed', prayer: data.prayer }));
      try {
        const sub = await self.registration.pushManager.getSubscription();
        if (sub && data.prayer) {
          await fetch('/api/push/prayed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: sub.endpoint, prayer: data.prayer }),
          });
        }
      } catch { /* offline / no sub — page-side marker still applies */ }
    })());
    return;
  }

  const target = data.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if ('focus' in client) {
          if ('navigate' in client) client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});

// Fetch: network-only, cache populated only as an offline fallback
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Don't intercept non-http(s) (chrome-extension, data:, etc.)
  if (!url.protocol.startsWith('http')) return;

  // Don't intercept analytics or API calls
  if (url.hostname === 'gc.zgo.at' || url.hostname.endsWith('.goatcounter.com')) return;
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then(response => {
        // Stash a copy for offline fallback only — never read from on success
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(OFFLINE_CACHE).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === 'navigate') {
          const fallback = await caches.match('./index.html');
          if (fallback) return fallback;
        }
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      })
  );
});
