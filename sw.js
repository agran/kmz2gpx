const CACHE_NAME = "kmz2gpx-v4";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./vendor/jszip/jszip.min.js",
  "./vendor/leaflet/leaflet.js",
  "./vendor/leaflet/leaflet.css",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

// Core app files (HTML/JS/CSS) use network-first, so a new deploy is picked up
// immediately when online, with cache as an offline fallback. Everything else
// (Leaflet/JSZip vendor files, icons, map tiles) uses stale-while-revalidate,
// serving instantly from cache while refreshing in the background.
const CORE_FILES = new Set(["", "index.html", "app.js", "style.css"]);

function isCoreRequest(request) {
  if (request.mode === "navigate") return true;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  const fileName = url.pathname.split("/").pop();
  return CORE_FILES.has(fileName);
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  if (isCoreRequest(event.request)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches
              .open(CACHE_NAME)
              .then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request)),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches
              .open(CACHE_NAME)
              .then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
