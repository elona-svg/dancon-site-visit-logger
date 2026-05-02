// Bump CACHE_VERSION on every release to invalidate stale shells.
const CACHE_VERSION = 'dancon-svl-v9';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/config.js',
  './js/db.js',
  './js/auth.js',
  './js/drive.js',
  './js/capture.js',
  './js/audio.js',
  './js/notes.js',
  './js/annotate.js',
  './js/viewer.js',
  './js/video-player.js',
  './js/ui.js',
  './js/app.js'
];

// Cache shell on install but DO NOT block install on a single 404 — addAll
// rejects atomically. Use Promise.all + per-URL catches so a transient miss
// doesn't kill the whole install (which has bitten iOS Safari before).
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      Promise.all(APP_SHELL.map((url) =>
        cache.add(url).catch((err) => console.warn('SW skip', url, err.message))
      ))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Network-first for same-origin GETs so updates ship fast; cache fallback
// when offline. NEVER intercept cross-origin requests (Google APIs, GIS) —
// the auth/drive flows handle their own headers.
//
// Critical: respondWith must always resolve to a Response (or the page hangs
// on iOS Safari). The final fallback is a 504 stub so we never return undefined.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(handleFetch(req));
});

async function handleFetch(req) {
  try {
    const res = await fetch(req);
    if (res && res.ok) {
      // Best-effort cache refresh.
      try {
        const cache = await caches.open(CACHE_VERSION);
        cache.put(req, res.clone());
      } catch (e) { /* ignore */ }
    }
    return res;
  } catch (networkErr) {
    const cached = await caches.match(req);
    if (cached) return cached;
    if (req.mode === 'navigate' || req.destination === 'document') {
      const shell = await caches.match('./index.html');
      if (shell) return shell;
    }
    return new Response(
      'Offline and not cached.',
      { status: 504, statusText: 'Gateway Timeout', headers: { 'Content-Type': 'text/plain' } }
    );
  }
}

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
