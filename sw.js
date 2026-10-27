const VERSION = 'reflect-portal-v2-11';
const SHELL = [
  './', './index.html', './styles.css', './app.js', './config.js',
  './frame-buster.js', './sw-register.js',
  './manifest.json', './icon.png', './icon-192.png', './icon-512.png'
];

self.addEventListener('install', e => {
  /* No silent catch — if a SHELL asset 404s during install (bad deploy,
     renamed file), FAIL the install so the browser keeps the old
     working SW active instead of activating a half-populated cache.
     Errors show up as "ServiceWorker install failed" in the browser
     devtools, which is loud enough to notice. */
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.hostname.includes('supabase.co') || url.hostname.includes('supabase.in')) return;
  if (url.hostname !== self.location.hostname) return;
  if (e.request.method !== 'GET') return;

  const isCode = /\.(html|js|css|json)$/.test(url.pathname) || url.pathname.endsWith('/');
  if (isCode) {
    e.respondWith(
      fetch(e.request).then(r => {
        const copy = r.clone();
        caches.open(VERSION).then(c => c.put(e.request, copy));
        return r;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(VERSION).then(c => c.put(e.request, copy));
      return r;
    }))
  );
});
