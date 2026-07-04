/* Oathforge service worker
   Strategy: NETWORK-FIRST for every GET request.
   - When online, the installed home-screen app always fetches the latest
     files from GitHub Pages, so new deploys show up automatically
     (no more clearing cache / re-adding the home-screen icon).
   - When offline, it falls back to the last-cached copy so the app still opens.
   This intentionally contains NO auto-reload logic, so it cannot loop.
*/
var CACHE = 'oathforge-cache-v1';

self.addEventListener('install', function (e) {
  // Activate this SW immediately instead of waiting for old tabs to close.
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    // Take control of open clients and drop any stale named caches.
    Promise.resolve()
      .then(function () { return self.clients.claim(); })
      .then(function () { return caches.keys(); })
      .then(function (keys) {
        return Promise.all(keys.map(function (k) {
          if (k !== CACHE) { return caches.delete(k); }
        }));
      })
      .catch(function () {})
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') { return; }

  e.respondWith(
    fetch(req)
      .then(function (res) {
        // Cache a copy for offline fallback (best-effort).
        try {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        } catch (_) {}
        return res;
      })
      .catch(function () {
        // Offline: serve last-known copy if we have it.
        return caches.match(req).then(function (r) {
          return r || caches.match('./index.html');
        });
      })
  );
});
