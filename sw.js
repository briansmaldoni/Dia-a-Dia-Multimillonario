const CACHE_NAME = 'multimillonarios-cache-v49';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll([
        './',
        './index.html',
        './app.js',
        './styles.css',
        './manifest.json',
        './icon-192.png',
        './icon-512.png'
      ]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (
    e.request.method !== 'GET' ||
    e.request.url.includes('script.google.com') ||
    e.request.url.includes('assetlinks.json')
  ) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => {
        if (e.request.mode === 'navigate') {
          return caches.match(e.request).then(r => r || caches.match('./index.html'));
        }
        return caches.match(e.request);
      })
  );
});