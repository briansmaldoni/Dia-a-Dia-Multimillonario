const CACHE_NAME = 'multimillonarios-cache-v50';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll([
        './',
        './index.html',
        './app.js',
        './theme-boot.js',
        './tailwind.min.css',
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
  if (e.request.method !== 'GET') return;

  let url = null;
  try {
    url = new URL(e.request.url);
  } catch (err) {
    return;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (
    url.hostname === 'script.google.com' ||
    url.hostname === 'script.googleusercontent.com' ||
    url.pathname.endsWith('assetlinks.json')
  ) {
    return;
  }

  const isSameOrigin = url.origin === self.location.origin;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (isSameOrigin && res && res.ok && res.type === 'basic') {
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
