/* Das Experten Mail PWA — minimal service worker for Android installability.
   Network-first for navigations; cache-first for static mail-app icons. */
const CACHE = 'dx-mail-v1';
const PRECACHE = [
  '/mail-app/icon-192.png',
  '/mail-app/icon-512.png',
  '/mail-manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // App shell / HTML — always network first so deploys apply immediately
  if (req.mode === 'navigate' || url.pathname === '/mail' || url.pathname.startsWith('/mail/')) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req))
    );
    return;
  }

  // Icons + manifest — cache first
  if (url.pathname.startsWith('/mail-app/') || url.pathname === '/mail-manifest.webmanifest') {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      }))
    );
  }
});
