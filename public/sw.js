// ==========================================================================
// KUJONG - SERVICE WORKER (PWA Offline Shell & Fast Assets)
// ==========================================================================
const CACHE_NAME = 'kujong-cache-v1';
const STATIC_ASSETS = [
  '/',
  'index.html',
  'style.css',
  'client.js',
  'svg-cards.svg',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'icon.svg'
];

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

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Niemals Socket.io oder API-Calls cachen
  if (url.pathname.startsWith('/socket.io/') || event.request.method !== 'GET') {
    return;
  }

  // Network-First mit Cache-Fallback für HTML, JS und CSS damit Updates sofort ankommen
  event.respondWith(
    fetch(event.request)
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
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      data: { url: data.url || '/' }
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
