const CACHE_NAME = 'multimillonarios-cache-v51';
const FONT_CACHE_NAME = 'multimillonarios-fonts-v1';
const PRECACHE_URLS = [
  './',
  './index.html',
  './app.js',
  './theme-boot.js',
  './tailwind.min.css',
  './styles.css',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.all(
        PRECACHE_URLS.map(url =>
          fetch(new Request(url, { cache: 'reload' })).then(res => {
            if (!res || !res.ok) {
              throw new Error('Error precargando recurso (' + (res ? res.status : 'sin respuesta') + '): ' + url);
            }
            return cache.put(url, res);
          })
        )
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== FONT_CACHE_NAME)
          .map(k => caches.delete(k))
      ))
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

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(
      caches.open(FONT_CACHE_NAME).then(cache =>
        cache.match(e.request).then(cached => {
          const networkPromise = fetch(e.request)
            .then(res => {
              if (res && res.ok) {
                cache.put(e.request, res.clone()).catch(() => {});
              }
              return res;
            })
            .catch(() => null);
          if (cached) return cached;
          return networkPromise.then(res => res || new Response('', { status: 504, statusText: 'Offline' }));
        })
      )
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request)
          .then(res => {
            if (res && res.ok && res.type === 'basic') {
              cache.put(e.request, res.clone()).catch(() => {});
            }
            return res;
          })
          .catch(() => {
            if (e.request.mode === 'navigate') {
              return cache.match('./index.html').then(idx => idx || caches.match('./index.html'));
            }
            return cached;
          });
      })
    )
  );
});
