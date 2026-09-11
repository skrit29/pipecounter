// Service Worker — offline support for PipeCounter.
//
// The model itself is NOT cached here; app.js stores it in IndexedDB so it can
// show download progress on first load.
//
// Strategy matters a lot here. The previous version was cache-first for
// everything, which meant that once app.js/detector.js had been cached they
// were served forever — a deploy only reached the user if the cache name
// changed AND the worker happened to reinstall. That is how "I pushed a fix
// but nothing changed" kept happening.
//
// Now:
//   • the app's own HTML/CSS/JS  → network-first (cache refreshed on success,
//     cache used only when offline). Always current when online.
//   • versioned CDN + wasm files → cache-first (immutable URLs, safe forever).

// Keep in step with APP_VERSION in app.js, which shows this number in the UI.
const CACHE_NAME = 'pipecounter-v17';

const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './detector.js',
  './pipeBreakdown.js',
  './manifest.json',
];

const CDN_ASSETS = [
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort.min.js',
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort-wasm.wasm',
  'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort-wasm-simd.wasm',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      // Never let one failed CDN request abort the whole install.
      Promise.all([...APP_SHELL, ...CDN_ASSETS].map(u =>
        cache.add(u).catch(() => {})
      ))
    )
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
  const req = event.request;
  if (req.method !== 'GET') return;

  // The model is handled by app.js via IndexedDB (needs progress reporting,
  // and is far too big to sit in the SW cache). Matches any build variant.
  if (/pipe-counter[\w-]*\.onnx/.test(req.url)) return;

  const url = new URL(req.url);
  const isAppCode = url.origin === self.location.origin;

  if (isAppCode) {
    // Network-first: the running app is always the deployed app when online.
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
    );
    return;
  }

  // Third-party, version-pinned URLs: cache-first is safe and fast.
  event.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res && res.status === 200 && res.type !== 'opaque') {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }))
  );
});
