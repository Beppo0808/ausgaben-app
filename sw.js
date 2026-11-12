// Offline-Unterstützung und schneller Start:
// App-Dateien kommen sofort aus dem Speicher des Geräts. Neue Versionen erkennt der Browser an dieser
// Datei (CACHE-Name ändert sich bei jeder Veröffentlichung) – dann wird alles einmal komplett neu geladen.
const CACHE = 'ausgaben-v65';
const ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'sync.js', 'konto.js', 'receipt.js', 'shop.js', 'pull.js', 'recipes-data.js', 'scanner.js', 'lock.js', 'manifest.webmanifest', 'icon.svg', 'fonts/fraunces-latin.woff2', 'fonts/nunito-latin.woff2', 'icon-180.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/einladung/') || u.pathname.startsWith('/api/')) return;
  if (u.searchParams.has('gate')) return; // „Zugang erneuern“: immer frisch vom Server (Einladungsseite)
  const isPage = e.request.mode === 'navigate';
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Seite (auch mit ?betrag=… vom Kurzbefehl) und App-Dateien: sofort aus dem Speicher
    const hit = await cache.match(isPage ? './' : e.request, { ignoreSearch: isPage });
    if (hit) return hit;
    try {
      const res = await fetch(e.request);
      if (res.ok && !isPage) cache.put(e.request, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      return (await cache.match(e.request, { ignoreSearch: true })) || Response.error();
    }
  })());
});
