const CACHE_NAME = 'plant-care-v1';

// Install: cache the main page
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(['/']))
  );
  self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: serve from cache, fall back to network
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(r => r || fetch(event.request))
  );
});

// Notification click: open the site and go to tracker
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow('/#tracker');
    })
  );
});

// Periodic background sync (fires when browser allows it)
self.addEventListener('periodicsync', event => {
  if (event.tag === 'watering-check') {
    event.waitUntil(checkWateringFromSW());
  }
});

// Also check on SW activation and message from page
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'CHECK_WATERING') {
    checkWateringFromSW(event.data.plants, event.data.state);
  }
});

function checkWateringFromSW(plants, state) {
  if (!plants || !state) return Promise.resolve();

  const promises = plants.map(plant => {
    const last = state[plant.id] || null;
    if (!last) return Promise.resolve();

    const daysSince = Math.floor((Date.now() - last) / 86400000);
    const overdue = daysSince - plant.intervalDays;

    if (overdue >= 0) {
      const title = `💧 ${plant.name} needs water!`;
      const body = overdue === 0
        ? `Due today — check the soil before watering.`
        : `Overdue by ${overdue} day${overdue === 1 ? '' : 's'}.`;

      return self.registration.showNotification(title, {
        body,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: plant.id,
        renotify: false,
        requireInteraction: false,
        vibrate: [200, 100, 200],
        data: { url: '/#tracker' }
      });
    }
    return Promise.resolve();
  });

  return Promise.all(promises);
}