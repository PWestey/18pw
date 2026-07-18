/* Oathforge service worker
   Strategy, per request type:
   - index.html / navigations: NETWORK-FIRST with HTTP-cache revalidation
     (cache:'no-cache'), so a fresh deploy shows up on the very next open —
     GitHub Pages' 10-minute max-age can no longer serve a stale shell.
   - art/ assets (portraits, bosses): STALE-WHILE-REVALIDATE — served
     instantly from cache, silently re-fetched in the background so
     replacements (e.g. a portrait swap) appear on the following load.
     Keeps 112+ portraits from re-downloading on every single visit.
   - everything else: NETWORK-FIRST with offline fallback (unchanged).
   When offline, everything falls back to the last-cached copy.
   This intentionally contains NO auto-reload logic, so it cannot loop.
*/
var CACHE = 'oathforge-cache-v2';

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

  var path = '';
  try { path = new URL(req.url).pathname; } catch (_) {}

  var isNav = (req.mode === 'navigate') || /\/$|\/index\.html$/.test(path);
  var isArt = path.indexOf('/art/') !== -1;

  if (isNav) {
    // Revalidate past the HTTP cache so deploys are visible immediately.
    e.respondWith(
      fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
        .then(function (res) {
          try {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
          } catch (_) {}
          return res;
        })
        .catch(function () {
          return caches.match(req).then(function (r) {
            return r || caches.match('./index.html');
          });
        })
    );
    return;
  }

  if (isArt) {
    // Serve from cache instantly; refresh the copy in the background.
    e.respondWith(
      caches.match(req).then(function (hit) {
        var refresh = fetch(req)
          .then(function (res) {
            try {
              var copy = res.clone();
              caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
            } catch (_) {}
            return res;
          })
          .catch(function () { return hit; });
        return hit || refresh;
      })
    );
    return;
  }

  // Default: network-first with offline fallback.
  e.respondWith(
    fetch(req)
      .then(function (res) {
        try {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); }).catch(function () {});
        } catch (_) {}
        return res;
      })
      .catch(function () {
        return caches.match(req).then(function (r) {
          return r || caches.match('./index.html');
        });
      })
  );
});
