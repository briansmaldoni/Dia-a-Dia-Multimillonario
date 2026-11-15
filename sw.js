const CACHE_NAME = 'multimillonarios-cache-v43';

const CACHEABLE_CDN_HOSTS = [
  'cdn.tailwindcss.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

function isCacheableStaticCdn_(urlStr) {
  return CACHEABLE_CDN_HOSTS.some(h => urlStr.includes(h));
}

function fetchWithTimeout_(request, timeoutMs) {
  if (typeof AbortController === 'undefined') return fetch(request);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(request, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll([
      './',
      './index.html',
      './app.js',
      './styles.css',
      './manifest.json',
      './icon-192.png',
      './icon-512.png'
    ]))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (
    e.request.method !== 'GET' ||
    e.request.url.includes('script.google.com') ||
    e.request.url.includes('assetlinks.json') ||
    e.request.url.toLowerCase().includes('onesignal')
  ) return;
  e.respondWith(
    fetchWithTimeout_(e.request, 4000)
      .then(res => {
        if (res && (res.ok || (res.type === 'opaque' && isCacheableStaticCdn_(e.request.url))) && (res.type === 'basic' || res.type === 'cors' || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(cached => cached || (e.request.mode === 'navigate' ? caches.match('./index.html') : undefined)))
  );
});

self.addEventListener('push', e => {
  let data = {};
  if (e.data) {
    try {
      data = e.data.json();
    } catch (_) {
      data = { title: 'Dia a Dia Multimillonarios 💰', body: e.data.text() };
    }
  }

  const title = data.title || (data.headings && (data.headings.es || data.headings.en)) || 'Dia a Dia Multimillonarios 💰';
  const body = data.body || data.alert || (data.contents && (data.contents.es || data.contents.en)) || 'Tenés una novedad en la aplicación.';
  const options = {
    body: body,
    icon: data.icon || './icon-192.png',
    badge: './icon-192.png',
    vibrate: [200, 100, 200, 100, 300],
    tag: data.tag || 'multimillonarios-msg',
    renotify: true,
    requireInteraction: false,
    data: { url: data.url || './index.html', tipo: data.tipo || '' }
  };

  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const data = e.notification.data || {};
  const notifTipo = String(data.tipo || '').trim();
  const targetUrl = String(data.url || (notifTipo === 'compras' ? './index.html?openShop=1' : (notifTipo === 'gasto' ? './index.html' : './index.html?openMsg=1')));
  const isCompras = notifTipo === 'compras' || targetUrl.includes('openShop=1');
  const isGasto = notifTipo === 'gasto';

  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (let i = 0; i < clientList.length; i++) {
        const client = clientList[i];
        if ('focus' in client) {
          if (isCompras) {
            try { client.postMessage({ type: 'OPEN_SHOPPING_LIST' }); } catch (_) {}
          } else if (!isGasto) {
            try { client.postMessage({ type: 'OPEN_QUICK_MSG' }); } catch (_) {}
          }
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

self.addEventListener('message', e => {
  if (!e.data || e.data.type !== 'SHOW_NOTIFICATION') return;
  const opts = Object.assign({
    icon: './icon-192.png',
    badge: './icon-192.png',
    vibrate: [200, 100, 200, 100, 300],
    renotify: true
  }, e.data.options || {});
  e.waitUntil(self.registration.showNotification(e.data.title || 'Dia a Dia Multimillonarios 💰', opts));
});