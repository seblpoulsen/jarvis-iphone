const CACHE_NAME = 'jarvis-shell-v4';
const SHELL_FILES = ['./', './index.html', './manifest.json', './service-worker.js', './voice-engine.js', './voice-repair.js', './assets/jarvis-icon.svg'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('jarvis-shell-') && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim())));
async function injectModules(response) {
  if (!response?.ok || !response.headers.get('content-type')?.includes('text/html')) return response;
  const html = await response.text();
  if (html.includes('voice-engine.js')) return new Response(html, response);
  const scripts = '<script src="./voice-engine.js" defer></script><script src="./voice-repair.js" defer></script>';
  const result = html.replace(/<\/body\s*>/i, `${scripts}</body>`);
  const headers = new Headers(response.headers); headers.delete('content-length'); headers.delete('content-encoding');
  return new Response(result,{status:response.status,statusText:response.statusText,headers});
}
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin)return;
  // AI API and any future speech-token requests remain network-only and uncached.
  if(request.mode==='navigate')event.respondWith((async()=>{const cache=await caches.open(CACHE_NAME);try{const response=await fetch(request);if(response.ok)await cache.put('./index.html',response.clone());return injectModules(response);}catch(_){const cached=await cache.match('./index.html');return cached?injectModules(cached):Response.error();}})());
  else event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{if(response.ok)caches.open(CACHE_NAME).then(cache=>cache.put(request,response.clone()));return response;})));
});
