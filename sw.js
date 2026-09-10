// Service Worker — caches all app assets for offline use.
// The 79 MB model is stored separately in IndexedDB by app.js so that
// progress can be shown during the first download.

const CACHE_NAME = 'pipecounter-v8';
const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './detector.js',
  './pipeBreakdown.js',
  './manifest.json',
  // onnxruntime-web: JS bundle + WASM files
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort.min.js',
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort-wasm.wasm',
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort-wasm-simd.wasm',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  // For the model file: the app handles it via IndexedDB — let it pass through
  // so the fetch-with-progress in app.js works on first load.
  if (event.request.url.includes('pipe-counter.onnx')) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response && response.status === 200 && response.type !== 'opaque') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
