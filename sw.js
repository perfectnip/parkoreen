/**
 * PARKOREEN - Service Worker
 * Handles offline caching and PWA functionality
 */

const CACHE_NAME = 'parkoreen-v230';
const ASSETS_TO_CACHE = [
    '/parkoreen/',
    '/parkoreen/index.html',
    '/parkoreen/dashboard/',
    '/parkoreen/dashboard/index.html',
    '/parkoreen/join.html',
    '/parkoreen/host.html',
    '/parkoreen/settings/',
    '/parkoreen/settings/index.html',
    '/parkoreen/login/',
    '/parkoreen/login/index.html',
    '/parkoreen/signup/',
    '/parkoreen/signup/index.html',
    '/parkoreen/assets/css/style.css',
    '/parkoreen/assets/js/game.js',
    '/parkoreen/assets/js/mechanicsData.js',
    '/parkoreen/assets/js/editor.js',
    '/parkoreen/assets/js/style.js',
    '/parkoreen/assets/js/exportImport.js',
    '/parkoreen/runtime.js',
    '/parkoreen/manifest.json',
    // SVG images (spikes and portals)
    '/parkoreen/assets/svg/spike-64x.svg',
    '/parkoreen/assets/svg/spike-512x.svg',
    '/parkoreen/assets/svg/portal-64x.svg',
    '/parkoreen/assets/svg/portal-512x.svg',
    '/parkoreen/assets/svg/block-brick-pattern.svg',
    '/parkoreen/assets/svg/block-stone-pattern.svg',
    '/parkoreen/assets/svg/block-wood-pattern.svg',
    '/parkoreen/assets/svg/block-moss-pattern.svg',
    // Icons
    '/parkoreen/assets/png/icons/icon-play-32.png',
    '/parkoreen/assets/png/icons/icon-play-64.png',
    '/parkoreen/assets/png/icons/icon-play-128.png',
    '/parkoreen/assets/png/icons/icon-play-512.png',
    '/parkoreen/assets/png/icons/icon-dashboard-32.png',
    '/parkoreen/assets/png/icons/icon-dashboard-64.png',
    '/parkoreen/assets/png/icons/icon-dashboard-128.png',
    '/parkoreen/assets/png/icons/icon-editor-32.png',
    '/parkoreen/assets/png/icons/icon-editor-64.png',
    '/parkoreen/assets/png/icons/icon-editor-128.png',
    '/parkoreen/assets/png/icons/icon-join-32.png',
    '/parkoreen/assets/png/icons/icon-join-64.png',
    '/parkoreen/assets/png/icons/icon-join-128.png',
    '/parkoreen/assets/png/icons/icon-settings-32.png',
    '/parkoreen/assets/png/icons/icon-settings-64.png',
    '/parkoreen/assets/png/icons/icon-settings-128.png'
];

// Install event - cache assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('Caching assets...');
                return cache.addAll(ASSETS_TO_CACHE);
            })
            .then(() => {
                return self.skipWaiting();
            })
            .catch((error) => {
                console.error('Cache installation failed:', error);
            })
    );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames.map((cacheName) => {
                        if (cacheName !== CACHE_NAME) {
                            console.log('Deleting old cache:', cacheName);
                            return caches.delete(cacheName);
                        }
                    })
                );
            })
            .then(() => {
                return self.clients.claim();
            })
    );
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET requests
    if (event.request.method !== 'GET') {
        return;
    }

    // Skip API requests (should always go to network)
    if (url.hostname.includes('workers.dev') || url.pathname.startsWith('/api')) {
        return;
    }

    // Admin (and mail) panels: never cache — stale HTML caused hard-to-debug script errors
    if (url.pathname.includes('/admin') || url.pathname.includes('/mails')) {
        return;
    }

    // Skip WebSocket requests
    if (url.protocol === 'ws:' || url.protocol === 'wss:') {
        return;
    }

    event.respondWith(
        caches.match(event.request)
            .then((cachedResponse) => {
                // Return cached response if found
                if (cachedResponse) {
                    // Fetch in background to update cache
                    event.waitUntil(
                        fetch(event.request)
                            .then((networkResponse) => {
                                if (networkResponse.ok) {
                                    caches.open(CACHE_NAME)
                                        .then((cache) => {
                                            cache.put(event.request, networkResponse.clone());
                                        });
                                }
                            })
                            .catch(() => {
                                // Network failed, but we have cache
                            })
                    );
                    return cachedResponse;
                }

                // No cache, fetch from network
                return fetch(event.request)
                    .then((networkResponse) => {
                        // Cache the response for future (only cache complete 200 responses)
                        if (networkResponse.ok && networkResponse.status === 200) {
                            const responseToCache = networkResponse.clone();
                            caches.open(CACHE_NAME)
                                .then((cache) => {
                                    cache.put(event.request, responseToCache);
                                })
                                .catch(() => {
                                    // Ignore cache errors
                                });
                        }
                        return networkResponse;
                    })
                    .catch(() => {
                        // Network failed and no cache
                        // Return offline page for navigation requests
                        if (event.request.mode === 'navigate') {
                            return caches.match('/parkoreen/dashboard/');
                        }
                        return new Response('Offline', { status: 503 });
                    });
            })
    );
});

// Handle messages from clients
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

// Background sync for saving maps
self.addEventListener('sync', (event) => {
    if (event.tag === 'save-map') {
        event.waitUntil(
            // Attempt to sync pending map saves
            syncPendingMaps()
        );
    }
});

async function syncPendingMaps() {
    // Get pending saves from IndexedDB
    // This would be implemented with IndexedDB in a full implementation
    console.log('Syncing pending map saves...');
}

// Push notification handling (for future features)
self.addEventListener('push', (event) => {
    if (!event.data) return;

    const data = event.data.json();
    
    const options = {
        body: data.body || 'New notification from Parkoreen',
        data: data.url || '/parkoreen/'
    };

    event.waitUntil(
        self.registration.showNotification(data.title || 'Parkoreen', options)
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    
    event.waitUntil(
        clients.openWindow(event.notification.data)
    );
});
