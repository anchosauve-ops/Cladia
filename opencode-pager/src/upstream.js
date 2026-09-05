// Client for an `opencode serve` instance: JSON calls, raw passthrough for the proxy,
// and a resilient SSE subscription to /event with reconnect and backoff.

export class UpstreamError extends Error {
  constructor(status, body, path) {
    super(`opencode ${status} on ${path}: ${typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)}`)
    this.status = status
    this.body = body
  }
}

export class Upstream {
  constructor({ baseUrl, username = 'opencode', password = '', fetch = globalThis.fetch, log = () => {} } = {}) {
    this.baseUrl = String(baseUrl || 'http://127.0.0.1:4096').replace(/\/+$/, '')
    this.username = username
    this.password = password
    this.fetch = fetch
    this.log = log
  }

  authHeader() {
    if (!this.password) return null
    return 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64')
  }

  headers(extra = {}) {
    const h = { ...extra }
    const a = this.authHeader()
    if (a) h.authorization = a
    return h
  }

  url(path, query) {
    const u = new URL(this.baseUrl + path)
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v))
    return u.toString()
  }

  async json(method, path, body, { query, signal } = {}) {
    const res = await this.fetch(this.url(path, query), {
      method,
      headers: this.headers(body !== undefined ? { 'content-type': 'application/json' } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    })
    const text = await res.text()
    let parsed = text
    try { parsed = text ? JSON.parse(text) : null } catch {}
    if (!res.ok) throw new UpstreamError(res.status, parsed, path)
    return parsed
  }

  /** Raw passthrough used by the reverse proxy. Caller streams the Response. */
  async raw(method, path, { headers = {}, body, signal, query } = {}) {
    return this.fetch(this.url(path, query), { method, headers: this.headers(headers), body, signal, duplex: body ? 'half' : undefined })
  }

  async health() {
    return this.json('GET', '/global/health')
  }

  /**
   * Subscribe to /event. Calls onEvent(parsedJson) for each event, onOpen() when the stream (re)connects,
   * onClose(err) when it drops. Returns a stop() function. Reconnects with capped exponential backoff.
   */
  subscribe(onEvent, { onOpen = () => {}, onClose = () => {}, signal, minDelay = 500, maxDelay = 15000 } = {}) {
    let stopped = false
    let delay = minDelay
    let controller = null
    const stop = () => { stopped = true; controller?.abort() }
    signal?.addEventListener('abort', stop)
    const loop = async () => {
      while (!stopped) {
        controller = new AbortController()
        try {
          const res = await this.fetch(this.url('/event'), { headers: this.headers({ accept: 'text/event-stream' }), signal: controller.signal })
          if (!res.ok || !res.body) throw new UpstreamError(res.status, await res.text().catch(() => ''), '/event')
          delay = minDelay
          onOpen()
          await readSSE(res.body, (evt) => {
            if (evt.data === undefined) return
            try { onEvent(JSON.parse(evt.data)) } catch (e) { this.log('bad event json', e.message) }
          })
          onClose(null)
        } catch (err) {
          if (!stopped) onClose(err)
        }
        if (stopped) break
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(maxDelay, delay * 2)
      }
    }
    loop()
    return stop
  }
}

/** Minimal, spec-shaped SSE reader over a WHATWG ReadableStream of bytes. */
export async function readSSE(body, onMessage) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let data = []
  let event, id
  const flush = () => {
    if (data.length === 0 && event === undefined && id === undefined) return
    onMessage({ data: data.length ? data.join('\n') : undefined, event, id })
    data = []; event = undefined; id = undefined
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      let line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (line === '') { flush(); continue }
      if (line.startsWith(':')) continue
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      let value = colon < 0 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'data') data.push(value)
      else if (field === 'event') event = value
      else if (field === 'id') id = value
    }
  }
  flush()
}
