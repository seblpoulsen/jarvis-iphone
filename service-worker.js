const CACHE_NAME = 'jarvis-shell-v2';
const SHELL_FILES = ['./', './index.html', './manifest.json', './service-worker.js', './voice-repair.js', './assets/jarvis-icon.svg'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith('jarvis-shell-') && key !== CACHE_NAME).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

async function addVoiceRepairScript(response) {
  if (!response || !response.ok || !response.headers.get('content-type')?.includes('text/html')) return response;
  const html = await response.text();
  if (html.includes('voice-repair.js')) return new Response(html, response);
  const injected = html.replace(/<\/body\s*>/i, '<script src="./voice-repair.js" defer></script></body>');
  return new Response(injected, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // API requests remain network-only and cross-origin. The Worker endpoint is unchanged.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put('./index.html', response.clone());
        return addVoiceRepairScript(response);
      } catch (_) {
        const cached = await cache.match('./index.html');
        return cached ? addVoiceRepairScript(cached) : Response.error();
      }
    })());
    return;
  }

  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
    return response;
  })));
});
