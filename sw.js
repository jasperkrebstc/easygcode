/* Offline cache for the static app shell.
 *
 * No version number to bump: the worker is network-first and revalidates every
 * app asset against the server, so a plain refresh always gets the latest when
 * online. The cache is only an offline fallback, kept fresh as a side effect of
 * normal use. A single fixed cache name means there is never a version line for
 * collaborators to edit — and therefore never a merge conflict here. (Edit
 * ASSETS only when adding/removing a shipped file.)
 */
const CACHE = 'easygcode';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './geometry.js',
  './gcode.js',
  './app.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for same-origin app assets and navigations, revalidating past
// the HTTP cache so a refresh gets the freshest deploy; cache is the offline
// fallback and is refreshed on every successful fetch. Everything else is
// cache-first.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const sameOrigin = url.origin === self.location.origin;
  const isNav = e.request.mode === 'navigate';

  if (isNav || sameOrigin) {
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' })
        .then((resp) => {
          // Never let a 404/500 from a mid-deploy overwrite a good cached copy.
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() =>
          caches.match(e.request).then((hit) => hit || (isNav ? caches.match('./index.html') : undefined))
        )
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((resp) => {
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          }
          return resp;
        })
    )
  );
});
