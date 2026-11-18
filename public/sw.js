// ==========================================================================
// KUJONG - SERVICE WORKER (PWA Offline Shell & Fast Assets)
// ==========================================================================
const CACHE_NAME = 'kujong-cache-v30';
const STATIC_ASSETS = [
  '/',
  'index.html',
  'style.css',
  'client.js',
  'svg-cards.svg',
  'manifest.json',
  'apple-touch-icon.png',
  'apple-touch-icon-precomposed.png',
  'icon-192.png',
  'icon-512.png',
  'icon.svg'
];

function isAppShellRequest(url) {
  const path = url.pathname;
  return (
    path === '/' ||
    path.endsWith('/index.html') ||
    path.endsWith('/client.js') ||
    path.endsWith('/style.css') ||
    path.endsWith('/manifest.json')
  );
}

async function fetchWithTimeout(request, timeoutMs = 3500, forceNoCache = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const fetchOpts = { signal: controller.signal };
    if (forceNoCache && request.mode !== 'navigate') {
      fetchOpts.cache = 'no-cache';
    }
    const response = await fetch(forceNoCache ? new Request(request, fetchOpts) : request, fetchOpts);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).catch(err => console.warn('PWA cache prefetch failed:', err))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Niemals Socket.io oder API-Calls cachen
  if (url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/api/') || event.request.method !== 'GET') {
    return;
  }

  // Fremde Origins (Google Fonts etc.) nicht im PWA-Fetch blockieren
  if (url.origin !== self.location.origin) {
    return;
  }

  const appShell = isAppShellRequest(url);

  // Network-First mit 3.5s Timeout-Schutz & Cache-Fallback, damit aufgeweckte PWAs im Funkloch nicht einfrieren
  event.respondWith(
    fetchWithTimeout(event.request, 3500, appShell)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});

// Vorbereitung für Web Push Benachrichtigungen
self.addEventListener('push', (event) => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    const title = data.title || 'Kujong';
    const options = {
      body: data.body || 'Eine neue Runde wartet auf dich!',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: [200, 100, 200],
      tag: 'kujong-game-invite',
      renotify: true,
      requireInteraction: true,
      data: { url: data.url || '/' },
      actions: [
        { action: 'join', title: '🎮 Jetzt beitreten' }
      ]
    };
    event.waitUntil(self.registration.showNotification(title, options));
  } catch (e) {
    console.warn('Push notification error:', e);
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const urlToOpen = (event.notification.data && event.notification.data.url) ? event.notification.data.url : '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(urlToOpen) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});
