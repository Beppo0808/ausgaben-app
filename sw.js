// Offline-Unterstützung: Netzwerk zuerst (für Updates), sonst Cache.
const CACHE = 'ausgaben-v22';
const ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'sync.js', 'konto.js', 'receipt.js', 'scanner.js', 'lock.js', 'manifest.webmanifest', 'icon.svg', 'fonts/fraunces-latin.woff2', 'fonts/nunito-latin.woff2', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/einladung/') || u.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { // nur echte App-Dateien aufheben, nie die Einladungsseite
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
