// sw.js - Cache-first strategy for offline functionality
const VERSION = '1.0.0';
const CACHE_NAME = `mcp-cat-v${VERSION}`;
const STATIC_CACHE = `mcp-cat-static-v${VERSION}`;
const DYNAMIC_CACHE = `mcp-cat-dynamic-v${VERSION}`;

const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  `./css/app.css?v=${VERSION}`,
  `./css/tailwind.css?v=${VERSION}`,
  `./js/app.js?v=${VERSION}`,
  `./js/store.js?v=${VERSION}`,
  `./js/crypto.js?v=${VERSION}`,
  './data/servers.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  // SVG Icons
  './icons/search.svg',
  './icons/close.svg',
  './icons/back.svg',
  './icons/down.svg',
  './icons/right.svg',
  './icons/add.svg',
  './icons/edit.svg',
  './icons/delete.svg',
  './icons/share.svg',
  './icons/download.svg',
  './icons/info.svg',
  './icons/key.svg',
  './icons/official.svg',
  './icons/warning.svg',
  './icons/success.svg',
  './icons/server.svg',
  './icons/calendar.svg',
  './icons/package.svg',
  './icons/folder.svg',
  './icons/settings.svg',
  'https://cdn.jsdelivr.net/npm/alpinejs@3.x.x/dist/cdn.min.js',
  'https://cdn.tailwindcss.com'
];

// Install event - cache static assets
self.addEventListener('install', event => {
  console.log('[SW] Installing service worker...');
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => {
        console.log('[SW] Caching static assets');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => {
        console.log('[SW] Static assets cached successfully');
        return self.skipWaiting();
      })
      .catch(error => {
        console.error('[SW] Failed to cache static assets:', error);
      })
  );
});

// Activate event - clean old caches
self.addEventListener('activate', event => {
  console.log('[SW] Activating service worker...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      const currentCaches = [STATIC_CACHE, DYNAMIC_CACHE, CACHE_NAME];
      return Promise.all(
        cacheNames.map(cacheName => {
          // Delete any cache that doesn't match current version
          if (!currentCaches.includes(cacheName) && cacheName.startsWith('mcp-cat-')) {
            console.log('[SW] Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('[SW] Service worker activated with version:', VERSION);
      return self.clients.claim();
    })
  );
});

// Fetch event - cache-first strategy
self.addEventListener('fetch', event => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  // Skip chrome-extension and other non-http requests
  if (!event.request.url.startsWith('http')) {
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          console.log('[SW] Serving from cache:', event.request.url);
          return response;
        }
        
        console.log('[SW] Fetching from network:', event.request.url);
        return fetch(event.request)
          .then(fetchResponse => {
            // Don't cache non-successful responses
            if (!fetchResponse || fetchResponse.status !== 200 || fetchResponse.type !== 'basic') {
              return fetchResponse;
            }
            
            // Cache dynamic content
            const responseClone = fetchResponse.clone();
            caches.open(DYNAMIC_CACHE)
              .then(cache => {
                console.log('[SW] Caching dynamic content:', event.request.url);
                cache.put(event.request, responseClone);
              })
              .catch(error => {
                console.warn('[SW] Failed to cache dynamic content:', error);
              });
            
            return fetchResponse;
          })
          .catch(error => {
            console.log('[SW] Network fetch failed:', error);
            
            // Return offline page for navigation requests
            if (event.request.mode === 'navigate') {
              return caches.match('/index.html');
            }
            
            // For other requests, try to return a cached version
            return caches.match(event.request);
          });
      })
  );
});

// Handle shared bundle URLs - route bundle sharing URLs to main app
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'HANDLE_BUNDLE_URL') {
    const bundleData = event.data.bundleData;
    console.log('[SW] Handling bundle URL import:', bundleData);
    
    // Post message to main app to handle bundle import
    self.clients.matchAll().then(clients => {
      clients.forEach(client => {
        client.postMessage({
          type: 'IMPORT_BUNDLE',
          bundleData: bundleData
        });
      });
    });
  }
});

// Handle skip waiting message
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    console.log('[SW] Received skip waiting message');
    self.skipWaiting();
  }
});

// Background sync for updating server catalogue
self.addEventListener('sync', event => {
  if (event.tag === 'update-servers') {
    console.log('[SW] Background sync: updating server catalogue');
    event.waitUntil(
      fetch('/data/servers.json')
        .then(response => response.json())
        .then(data => {
          // Store updated data for the main app
          return caches.open(DYNAMIC_CACHE)
            .then(cache => cache.put('/data/servers.json', new Response(JSON.stringify(data))));
        })
        .catch(error => {
          console.error('[SW] Failed to update server catalogue:', error);
        })
    );
  }
});

// Periodic background sync (if supported)
self.addEventListener('periodicsync', event => {
  if (event.tag === 'update-servers-periodic') {
    console.log('[SW] Periodic sync: updating server catalogue');
    event.waitUntil(
      fetch('/data/servers.json')
        .then(response => response.json())
        .then(data => {
          return caches.open(DYNAMIC_CACHE)
            .then(cache => cache.put('/data/servers.json', new Response(JSON.stringify(data))));
        })
        .catch(error => {
          console.error('[SW] Periodic sync failed:', error);
        })
    );
  }
});

// Handle push notifications (future feature)
self.addEventListener('push', event => {
  if (event.data) {
    const data = event.data.json();
    console.log('[SW] Push notification received:', data);
    
    const options = {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: data.data || {},
      actions: data.actions || []
    };
    
    event.waitUntil(
      self.registration.showNotification(data.title, options)
    );
  }
});

// Handle notification clicks
self.addEventListener('notificationclick', event => {
  console.log('[SW] Notification clicked:', event.notification);
  event.notification.close();
  
  // Handle notification actions
  if (event.action) {
    console.log('[SW] Notification action clicked:', event.action);
  }
  
  // Open/focus the app
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(clientList => {
      // If app is already open, focus it
      for (const client of clientList) {
        if (client.url === '/' && 'focus' in client) {
          return client.focus();
        }
      }
      
      // Otherwise open a new window
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});

console.log('[SW] Service worker script loaded');