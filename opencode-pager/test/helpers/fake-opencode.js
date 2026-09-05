// A tiny stand-in for `opencode serve`: enough of the REST surface for the bridge, plus an SSE /event
// stream we can push events into from tests.
import http from 'node:http'

export function startFakeOpencode({ password = 'pw' } = {}) {
  const state = { sessions: [], status: {}, permissions: [], questions: [], replies: [], requests: [] }
  const clients = new Set()
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    state.requests.push({ method: req.method, path: url.pathname, headers: req.headers })
    const expected = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64')
    if (password && req.headers.authorization !== expected) { res.writeHead(401); return res.end('unauthorized') }
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (url.pathname === '/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ type: 'server.connected', properties: {} })}\n\n`)
      clients.add(res)
      req.on('close', () => clients.delete(res))
      return
    }
    if (url.pathname === '/global/health') return send(200, { healthy: true, version: '9.9.9-fake' })
    if (url.pathname === '/session' && req.method === 'GET') return send(200, state.sessions)
    if (url.pathname === '/session' && req.method === 'POST') { const s = { id: 'ses_' + Math.random().toString(36).slice(2, 8), title: 'new', time: { created: Date.now(), updated: Date.now() } }; state.sessions.push(s); return send(200, s) }
    if (url.pathname === '/session/status') return send(200, state.status)
    if (url.pathname === '/permission') return send(200, state.permissions)
    if (url.pathname === '/question') return send(200, state.questions)
    const perm = url.pathname.match(/^\/permission\/([^/]+)\/reply$/)
    if (perm && req.method === 'POST') {
      let body = ''; for await (const c of req) body += c
      const id = decodeURIComponent(perm[1])
      if (!state.permissions.some((p) => p.id === id)) return send(404, { name: 'PermissionNotFoundError' })
      state.replies.push({ id, ...JSON.parse(body) })
      state.permissions = state.permissions.filter((p) => p.id !== id)
      emit({ type: 'permission.replied', properties: { sessionID: 'ses_1', requestID: id, reply: JSON.parse(body).reply } })
      return send(200, true)
    }
    const msgs = url.pathname.match(/^\/session\/([^/]+)\/message$/)
    if (msgs && req.method === 'GET') return send(200, [{ info: { id: 'msg_1', sessionID: msgs[1], role: 'user', time: { created: 1 } }, parts: [{ id: 'prt_1', type: 'text', text: 'hi' }] }])
    if (url.pathname === '/slow-stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"n":1}\n\n')
      return // never ends; the bridge should inject heartbeats
    }
    send(404, { name: 'NotFoundError', path: url.pathname })
  })
  const emit = (evt) => { for (const c of clients) c.write(`data: ${JSON.stringify(evt)}\n\n`) }
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, emit, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { for (const c of clients) c.end(); server.close(() => r()) }) })))
}
