// Service worker: offline shell, push notifications, and approve/deny straight from the notification.
const VERSION = 'pager-v1'
const SHELL = ['/', '/app.js', '/manifest.webmanifest', '/icon.svg', '/icon-192.png']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.origin !== location.origin || e.request.method !== 'GET') return
  if (url.pathname.startsWith('/oc/') || url.pathname.startsWith('/pager/')) return // live data: network only
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => { caches.open(VERSION).then((c) => c.put('/', r.clone())); return r }).catch(() => caches.match('/')))
    return
  }
  e.respondWith(caches.match(e.request).then((cached) => {
    const net = fetch(e.request).then((r) => { if (r.ok) caches.open(VERSION).then((c) => c.put(e.request, r.clone())); return r }).catch(() => cached)
    return cached || net
  }))
})

self.addEventListener('push', (e) => {
  let data = {}
  try { data = e.data ? e.data.json() : {} } catch { data = { title: 'opencode', body: e.data?.text() } }
  const kind = data.kind || 'info'
  const actions = kind === 'permission' && data.act ? [{ action: 'once', title: 'Allow' }, { action: 'reject', title: 'Deny' }] : []
  const opts = {
    body: data.body || '',
    tag: data.tag || data.id || kind,
    renotify: true,
    requireInteraction: kind === 'permission' || kind === 'question',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data,
    actions,
  }
  const title = data.title || 'opencode'
  e.waitUntil(self.registration.showNotification(title, opts))
})

self.addEventListener('notificationclick', (e) => {
  const data = e.notification.data || {}
  const action = e.action
  e.notification.close()
  if ((action === 'once' || action === 'reject') && data.act) {
    e.waitUntil(
      fetch('/pager/act', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: data.act, reply: action }), credentials: 'include' })
        .then(async (r) => {
          if (r.ok) return self.registration.showNotification(action === 'once' ? 'Allowed' : 'Denied', { body: data.title || '', tag: data.tag, icon: '/icon-192.png', silent: true })
          const b = await r.json().catch(() => ({}))
          return openApp(data.url || '/#inbox').then(() => self.registration.showNotification('Could not reply from here', { body: b.message || 'Open the app to respond.', tag: data.tag, icon: '/icon-192.png' }))
        })
        .catch(() => openApp(data.url || '/#inbox')),
    )
    return
  }
  e.waitUntil(openApp(data.url || '/#inbox'))
})

async function openApp(url) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
  for (const c of all) {
    if ('focus' in c) { await c.focus(); c.postMessage({ type: 'navigate', url }); return c }
  }
  return self.clients.openWindow(url)
}
