// DEV OVERRIDE — self-unregistering service worker.
//
// drawio's PWA Workbox precache (the original 2-line file) cached index.html,
// app.min.js and assets with `ignoreURLParametersMatching:[/.*/]`, serving STALE
// code during local development — edits to plugins (exporter.js) never reached
// the browser despite dev-server restarts, hard reloads, and incognito. On the
// next load this replacement DELETES every cache, unregisters itself, and
// reloads open tabs, so the browser always fetches fresh files.
//
// Restore the real offline/PWA service worker for a production build:
//   git checkout -- src/main/webapp/service-worker.js
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    try {
      var keys = await caches.keys();
      await Promise.all(keys.map(function (k) { return caches.delete(k); }));
    } catch (e) { /* ignore */ }
    try { await self.registration.unregister(); } catch (e) { /* ignore */ }
    try {
      var clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(function (c) { try { c.navigate(c.url); } catch (e) {} });
    } catch (e) { /* ignore */ }
  })());
});
