// clode service worker: cache the app shell so it opens with no signal. API calls are never cached.
const VERSION = 'clode-v1'
const SHELL = ['./', './index.html', './app.js', './agent.js', './llm.js', './github.js', './store.js', './manifest.webmanifest', './icon.svg', './icon-192.png']
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())) })
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())) })
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.origin !== location.origin || e.request.method !== 'GET') return
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((cached) => {
    const net = fetch(e.request).then((r) => { if (r.ok) caches.open(VERSION).then((c) => c.put(e.request, r.clone())); return r }).catch(() => cached)
    return cached || net
  }))
})
