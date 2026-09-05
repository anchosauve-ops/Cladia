// The bridge: serves the PWA, proxies to opencode, keeps the inbox, streams events with heartbeats,
// pairs devices, and sends Web Push when the agent needs a human.

import http from 'node:http'
import https from 'node:https'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { Inbox } from './inbox.js'
import { generateVapidKeys, sendPush } from './push.js'
import { iconPNG, iconSVG } from './icons.js'

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' }
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'authorization', 'cookie', 'content-length'])

export function pairingCode(len = 10) {
  const bytes = randomBytes(len)
  let s = ''
  for (let i = 0; i < len; i++) s += PAIR_ALPHABET[bytes[i] % PAIR_ALPHABET.length]
  return s
}

export class Pager {
  constructor({ upstream, state, inbox = new Inbox(), publicUrl, staticDir = new URL('../web/', import.meta.url).pathname, log = () => {}, subject, tls, fetch = globalThis.fetch, pushSend = sendPush }) {
    this.upstream = upstream
    this.state = state
    this.inbox = inbox
    this.publicUrl = publicUrl
    this.log = log
    this.subject = subject || state.subject || 'mailto:opencode-pager@localhost'
    this.fetch = fetch
    this.pushSend = pushSend
    this.pairCodes = new Map() // code -> { exp, label }
    this.actionTokens = new Map() // token -> { permissionID, sessionID, exp }
    this.sseClients = new Set()
    this.pairAttempts = [] // timestamps for rate limiting
    this.static = loadStatic(staticDir)
    this.icons = { 192: iconPNG(192), 512: iconPNG(512), m192: iconPNG(192, { maskable: true }), m512: iconPNG(512, { maskable: true }), svg: iconSVG() }
    this.server = tls ? https.createServer(tls, (req, res) => this.handle(req, res)) : http.createServer((req, res) => this.handle(req, res))
    this.server.on('clientError', (err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n') })
    this.info = { opencodeVersion: null }
    this.stopUpstream = null
    this.heartbeat = null
    this.inbox.on('change', (snap) => this.broadcast('snapshot', snap))
    this.inbox.on('notify', (n) => this.notify(n).catch((e) => this.log('push error', e.message)))
  }

  async start({ port = 4097, host = '0.0.0.0' } = {}) {
    if (!this.state.vapid) this.state.vapid = await generateVapidKeys()
    if (!this.state.subject) this.state.subject = this.subject
    this.stopUpstream = this.upstream.subscribe((evt) => this.onUpstreamEvent(evt), {
      onOpen: () => { this.log('opencode event stream connected'); this.reconcile().catch((e) => this.log('reconcile failed', e.message)) },
      onClose: (err) => { if (this.inbox.connected) { this.inbox.connected = false; this.inbox.changed() } if (err) this.log('opencode event stream dropped:', err.message) },
    })
    this.heartbeat = setInterval(() => { for (const c of this.sseClients) c.res.write('event: hb\ndata: {}\n\n') }, 15_000)
    this.heartbeat.unref?.()
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(port, host, () => { this.server.off('error', reject); resolve() }) })
    return this.server.address()
  }

  async stop() {
    this.stopUpstream?.()
    clearInterval(this.heartbeat)
    for (const c of this.sseClients) c.res.end()
    await new Promise((r) => this.server.close(() => r()))
  }

  newPairingCode({ ttlMs = 10 * 60_000, label = '' } = {}) {
    const code = pairingCode()
    this.pairCodes.set(code, { exp: Date.now() + ttlMs, label })
    return code
  }

  pairUrl(code) {
    const base = (this.publicUrl || `http://localhost:${this.server.address()?.port || 4097}`).replace(/\/+$/, '')
    return `${base}/#pair=${code}`
  }

  // ---- upstream -------------------------------------------------------------

  async reconcile() {
    const [health, sessions, status, permissions, questions] = await Promise.all([
      this.upstream.json('GET', '/global/health').catch(() => null),
      this.upstream.json('GET', '/session'),
      this.upstream.json('GET', '/session/status'),
      this.upstream.json('GET', '/permission').catch(() => []),
      this.upstream.json('GET', '/question').catch(() => []),
    ])
    if (health?.version) this.info.opencodeVersion = health.version
    this.inbox.connected = true
    this.inbox.reconcile({ sessions, status, permissions, questions })
  }

  onUpstreamEvent(evt) {
    this.inbox.applyEvent(evt)
    const t = evt.type || ''
    const sid = evt.properties?.sessionID
    const sessionScoped = t.startsWith('message.') || t === 'session.diff' || t.startsWith('session.next.')
    for (const c of this.sseClients) {
      if (sessionScoped && c.session !== sid) continue
      if (t === 'server.connected' || t.startsWith('tui.') || t.startsWith('pty.') || t.startsWith('lsp') || t.startsWith('file.watcher')) continue
      c.res.write(`event: oc\ndata: ${JSON.stringify(evt)}\n\n`)
    }
  }

  broadcast(event, payload) {
    const data = JSON.stringify(payload)
    for (const c of this.sseClients) c.res.write(`event: ${event}\ndata: ${data}\n\n`)
  }

  async notify(n) {
    const subs = this.state.subscriptions
    if (subs.length === 0) return
    const payload = { kind: n.kind, sessionID: n.sessionID, id: n.id, title: n.title, body: n.body, tag: n.tag, url: `/#s/${n.sessionID}` }
    if (n.kind === 'permission') {
      const token = randomBytes(24).toString('base64url')
      this.actionTokens.set(token, { permissionID: n.id, sessionID: n.sessionID, exp: Date.now() + 6 * 3600_000 })
      payload.act = token
    }
    this.gcTokens()
    const results = await Promise.allSettled(subs.map((s) => this.pushSend(s, JSON.stringify(payload), this.state.vapid, { subject: this.state.subject, ttl: n.kind === 'finished' ? 3600 : 6 * 3600, urgency: n.urgency || 'normal', topic: n.tag, fetch: this.fetch })))
    results.forEach((r, i) => {
      if (r.status === 'rejected') return this.log('push failed', subs[i].endpoint.slice(0, 40), r.reason?.message)
      if (r.value.gone) { this.log('push subscription gone, removing', subs[i].endpoint.slice(0, 40)); this.state.removeSubscription(subs[i].endpoint) }
      else if (!r.value.ok) this.log('push rejected', r.value.status, r.value.text?.slice(0, 120))
    })
  }

  gcTokens() {
    const now = Date.now()
    for (const [k, v] of this.actionTokens) if (v.exp < now) this.actionTokens.delete(k)
    for (const [k, v] of this.pairCodes) if (v.exp < now) this.pairCodes.delete(k)
  }

  // ---- http -----------------------------------------------------------------

  async handle(req, res) {
    const url = new URL(req.url, 'http://x')
    const path = url.pathname
    try {
      if (path.startsWith('/oc/')) return await this.proxy(req, res, url)
      if (path.startsWith('/pager/admin/')) return await this.admin(req, res, url)
      if (path.startsWith('/pager/')) return await this.api(req, res, url)
      return this.serveStatic(req, res, path)
    } catch (err) {
      this.log('request error', req.method, path, err.message)
      if (!res.headersSent) json(res, 500, { error: 'internal', message: err.message })
      else res.end()
    }
  }

  deviceFor(req, url) {
    let token = null
    const auth = req.headers.authorization
    if (auth && /^Bearer /i.test(auth)) token = auth.slice(7).trim()
    if (!token) {
      const cookies = parseCookies(req.headers.cookie)
      if (cookies.pager) token = cookies.pager
    }
    if (!token && url) token = url.searchParams.get('token')
    const device = this.state.findDeviceByToken(token)
    if (device) this.state.touchDevice(device.id)
    return device
  }

  requireDevice(req, res, url) {
    const device = this.deviceFor(req, url)
    if (!device) { json(res, 401, { error: 'unauthorized', message: 'Pair this device first.' }); return null }
    return device
  }

  isSecure(req) {
    return !!req.socket.encrypted || /https/i.test(req.headers['x-forwarded-proto'] || '')
  }

  async api(req, res, url) {
    const path = url.pathname
    if (path === '/pager/pair' && req.method === 'POST') {
      this.gcTokens()
      const now = Date.now()
      this.pairAttempts = this.pairAttempts.filter((t) => t > now - 60_000)
      if (this.pairAttempts.length >= 10) return json(res, 429, { error: 'rate_limited', message: 'Too many pairing attempts. Wait a minute.' })
      const body = await readJson(req)
      const code = String(body?.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
      const entry = this.pairCodes.get(code)
      if (!entry || entry.exp < now) { this.pairAttempts.push(now); return json(res, 400, { error: 'bad_code', message: 'That pairing code is not valid or has expired.' }) }
      this.pairCodes.delete(code)
      const { token, device } = this.state.addDevice({ name: body?.name, ua: req.headers['user-agent'] })
      const cookie = `pager=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${365 * 86400}${this.isSecure(req) ? '; Secure' : ''}`
      res.setHeader('set-cookie', cookie)
      this.log('paired device', device.id, device.name)
      return json(res, 200, { token, device: { id: device.id, name: device.name } })
    }
    const device = this.requireDevice(req, res, url)
    if (!device) return
    if (path === '/pager/me' && req.method === 'GET') {
      return json(res, 200, { device: { id: device.id, name: device.name }, opencode: { url: this.upstream.baseUrl, version: this.info.opencodeVersion, connected: this.inbox.connected }, vapidPublicKey: this.state.vapid?.publicKey, publicUrl: this.publicUrl, subscriptions: this.state.subscriptions.filter((s) => s.deviceId === device.id).length, version: VERSION })
    }
    if (path === '/pager/inbox' && req.method === 'GET') return json(res, 200, this.inbox.snapshot())
    if (path === '/pager/seen' && req.method === 'POST') {
      const body = await readJson(req)
      if (body?.sessionID) this.inbox.markSeen(body.sessionID)
      return json(res, 200, { ok: true })
    }
    if (path === '/pager/events' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
      res.write(`retry: 3000\n: connected\n\n`)
      const client = { res, session: url.searchParams.get('session') || null, device: device.id }
      this.sseClients.add(client)
      res.write(`event: snapshot\ndata: ${JSON.stringify(this.inbox.snapshot())}\n\n`)
      req.on('close', () => this.sseClients.delete(client))
      return
    }
    if (path === '/pager/push/subscribe' && req.method === 'POST') {
      const body = await readJson(req)
      try { this.state.addSubscription(device.id, body?.subscription || body) } catch (e) { return json(res, 400, { error: 'bad_subscription', message: e.message }) }
      return json(res, 200, { ok: true })
    }
    if (path === '/pager/push/subscribe' && req.method === 'DELETE') {
      const body = await readJson(req)
      if (body?.endpoint) this.state.removeSubscription(body.endpoint)
      return json(res, 200, { ok: true })
    }
    if (path === '/pager/push/test' && req.method === 'POST') {
      const subs = this.state.subscriptions.filter((s) => s.deviceId === device.id)
      if (subs.length === 0) return json(res, 400, { error: 'no_subscription', message: 'This device has no push subscription.' })
      const results = await Promise.all(subs.map((s) => this.pushSend(s, JSON.stringify({ kind: 'test', title: 'opencode-pager', body: 'Push works. The agent can reach you here.', tag: 'test', url: '/#inbox' }), this.state.vapid, { subject: this.state.subject, ttl: 60, urgency: 'high', fetch: this.fetch }).catch((e) => ({ ok: false, status: 0, text: e.message }))))
      results.forEach((r, i) => { if (r.gone) this.state.removeSubscription(subs[i].endpoint) })
      return json(res, 200, { results: results.map((r) => ({ ok: r.ok, status: r.status, text: r.text })) })
    }
    if (path === '/pager/act' && req.method === 'POST') {
      // From the service worker notification action. Authenticated by the device cookie plus a per-notification token.
      const body = await readJson(req)
      const entry = this.actionTokens.get(String(body?.token || ''))
      if (!entry || entry.exp < Date.now()) return json(res, 400, { error: 'bad_token', message: 'This notification action has expired. Open the app.' })
      const reply = ['once', 'always', 'reject'].includes(body?.reply) ? body.reply : null
      if (!reply) return json(res, 400, { error: 'bad_reply' })
      this.actionTokens.delete(body.token)
      try {
        await this.replyPermission(entry.permissionID, entry.sessionID, reply)
        return json(res, 200, { ok: true })
      } catch (e) {
        return json(res, e.status === 404 ? 410 : 502, { error: 'reply_failed', message: e.message })
      }
    }
    return json(res, 404, { error: 'not_found' })
  }

  async replyPermission(permissionID, sessionID, reply) {
    try {
      return await this.upstream.json('POST', `/permission/${encodeURIComponent(permissionID)}/reply`, { reply })
    } catch (e) {
      if (e.status !== 404) throw e
      // v2 API surface
      const v2 = { once: 'allow', always: 'allow_always', reject: 'reject' }[reply]
      return this.upstream.json('POST', `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(permissionID)}/reply`, { reply: v2 })
    }
  }

  async admin(req, res, url) {
    if (!isLoopback(req)) return json(res, 403, { error: 'forbidden', message: 'Admin endpoints are loopback only.' })
    const path = url.pathname
    if (path === '/pager/admin/pair' && req.method === 'POST') {
      const body = await readJson(req).catch(() => ({}))
      const code = this.newPairingCode({ label: body?.label })
      return json(res, 200, { code, url: this.pairUrl(code), expiresIn: 600 })
    }
    if (path === '/pager/admin/devices' && req.method === 'GET') return json(res, 200, { devices: this.state.devices, subscriptions: this.state.subscriptions.map((s) => ({ deviceId: s.deviceId, endpoint: s.endpoint.slice(0, 48) + '…', createdAt: s.createdAt })) })
    const m = path.match(/^\/pager\/admin\/devices\/([^/]+)$/)
    if (m && req.method === 'DELETE') return json(res, 200, { revoked: this.state.revokeDevice(decodeURIComponent(m[1])) })
    if (path === '/pager/admin/status' && req.method === 'GET') return json(res, 200, { opencode: this.info, connected: this.inbox.connected, clients: this.sseClients.size, inbox: this.inbox.snapshot().counts, vapidPublicKey: this.state.vapid?.publicKey })
    return json(res, 404, { error: 'not_found' })
  }

  async proxy(req, res, url) {
    const device = this.requireDevice(req, res, url)
    if (!device) return
    const method = req.method.toUpperCase()
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return json(res, 405, { error: 'method' })
    const upstreamPath = url.pathname.slice(3) // strip "/oc"
    const query = {}
    for (const [k, v] of url.searchParams) if (k !== 'token') query[k] = v
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k) && typeof v === 'string') headers[k] = v
    const body = method === 'GET' ? undefined : await readBody(req)
    const controller = new AbortController()
    req.on('close', () => controller.abort())
    let up
    try {
      up = await this.upstream.raw(method, upstreamPath, { headers, body: body?.length ? body : undefined, signal: controller.signal, query })
    } catch (e) {
      if (controller.signal.aborted) return
      return json(res, 502, { error: 'upstream_unreachable', message: `opencode at ${this.upstream.baseUrl} is not reachable: ${e.message}` })
    }
    const outHeaders = {}
    for (const [k, v] of up.headers) if (!HOP_BY_HOP.has(k) && k !== 'content-encoding' && k !== 'content-length') outHeaders[k] = v
    res.writeHead(up.status, outHeaders)
    if (!up.body) return res.end()
    const isSSE = /text\/event-stream/.test(up.headers.get('content-type') || '')
    const stream = Readable.fromWeb(up.body)
    stream.on('error', () => res.end())
    if (isSSE) {
      const hb = setInterval(() => { if (!res.writableEnded) res.write(': hb\n\n') }, 15_000)
      res.on('close', () => { clearInterval(hb); controller.abort() })
    }
    stream.pipe(res)
  }

  serveStatic(req, res, path) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method' })
    if (path === '/icon-192.png') return blob(res, this.icons[192], 'image/png')
    if (path === '/icon-512.png') return blob(res, this.icons[512], 'image/png')
    if (path === '/icon-192-maskable.png') return blob(res, this.icons.m192, 'image/png')
    if (path === '/icon-512-maskable.png') return blob(res, this.icons.m512, 'image/png')
    if (path === '/icon.svg') return blob(res, Buffer.from(this.icons.svg), 'image/svg+xml')
    let file = this.static.get(path === '/' ? '/index.html' : path)
    if (!file && !path.includes('.')) file = this.static.get('/index.html') // SPA fallback
    if (!file) return json(res, 404, { error: 'not_found' })
    const etag = file.etag
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end() }
    res.writeHead(200, { 'content-type': file.type, etag, 'cache-control': file.type.startsWith('text/html') || path === '/sw.js' ? 'no-cache' : 'public, max-age=300', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })
    res.end(req.method === 'HEAD' ? undefined : file.body)
  }
}

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

function loadStatic(dir) {
  const map = new Map()
  const walk = (d, prefix) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      if (statSync(full).isDirectory()) { walk(full, `${prefix}${name}/`); continue }
      const body = readFileSync(full)
      map.set(`${prefix}${name}`, { body, type: MIME[extname(name)] || 'application/octet-stream', etag: `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"` })
    }
  }
  walk(dir, '/')
  return map
}

function json(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  res.end(body)
}
function blob(res, buf, type) {
  res.writeHead(200, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'public, max-age=86400' })
  res.end(buf)
}
async function readBody(req, limit = 8 * 1024 * 1024) {
  const chunks = []
  let n = 0
  for await (const c of req) { n += c.length; if (n > limit) throw new Error('body too large'); chunks.push(c) }
  return Buffer.concat(chunks)
}
async function readJson(req) {
  const b = await readBody(req, 1024 * 1024)
  if (!b.length) return {}
  try { return JSON.parse(b.toString('utf8')) } catch { return {} }
}
function parseCookies(header) {
  const out = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}
function isLoopback(req) {
  if (req.headers['x-forwarded-for']) return false
  const a = req.socket.remoteAddress || ''
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}
