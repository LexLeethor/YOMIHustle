// Service worker for the installable site.
//
// It deliberately caches nothing. The game is a ~32 MB payload that is updated
// by uploading new files, and a cached copy would keep serving an old build -
// the reason the mod archives are name-hashed in the first place. It exists
// because a browser only offers to install a site that has a service worker
// with a fetch handler.

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function () {
  // No respondWith(): every request goes straight to the network as usual.
});
