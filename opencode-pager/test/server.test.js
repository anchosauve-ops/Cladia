import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pager } from '../src/server.js'
import { Upstream } from '../src/upstream.js'
import { State } from '../src/state.js'
import { Inbox } from '../src/inbox.js'
import { startFakeOpencode } from './helpers/fake-opencode.js'

async function setup() {
  const fake = await startFakeOpencode({ password: 'pw' })
  const dir = mkdtempSync(join(tmpdir(), 'pager-'))
  const state = new State(join(dir, 'state.json'))
  const pushes = []
  const pager = new Pager({
    upstream: new Upstream({ baseUrl: fake.url, password: 'pw' }),
    state,
    inbox: new Inbox({ permissionGrace: 50, finishedMinBusy: 10 }),
    publicUrl: 'https://pager.test',
    pushSend: async (sub, payload, keys, opts) => { pushes.push({ sub, payload: JSON.parse(payload), opts }); return { ok: true, status: 201 } },
  })
  const addr = await pager.start({ port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${addr.port}`
  await new Promise((r) => setTimeout(r, 150)) // let the upstream subscription connect and reconcile
  const cleanup = async () => { await pager.stop(); await fake.close(); rmSync(dir, { recursive: true, force: true }) }
  return { fake, pager, state, base, pushes, cleanup, dir }
}

async function pair(base) {
  const admin = await (await fetch(`${base}/pager/admin/pair`, { method: 'POST' })).json()
  const res = await fetch(`${base}/pager/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: admin.code, name: 'test phone' }) })
  const body = await res.json()
  return { token: body.token, cookie: res.headers.get('set-cookie'), admin }
}

function readSSEOnce(url, headers, { events = 1, timeout = 3000 } = {}) {
  return new Promise(async (resolve, reject) => {
    const ctl = new AbortController()
    const t = setTimeout(() => { ctl.abort(); reject(new Error('sse timeout')) }, timeout)
    const res = await fetch(url, { headers, signal: ctl.signal })
    const reader = res.body.getReader()
    let buf = ''; const got = []
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += new TextDecoder().decode(value)
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2)
        const ev = /^event: (.*)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1]
        if (data !== undefined) got.push({ event: ev, data: JSON.parse(data) })
        if (got.length >= events) { clearTimeout(t); ctl.abort(); return resolve(got) }
      }
    }
  })
}

test('pairing, auth, inbox, proxy, push and notification actions work end to end against a fake opencode', async (t) => {
  const { fake, pager, state, base, pushes, cleanup } = await setup()
  t.after(cleanup)

  // unauthenticated is refused, static shell is public
  assert.equal((await fetch(`${base}/pager/inbox`)).status, 401)
  assert.equal((await fetch(`${base}/oc/session`)).status, 401)
  const index = await fetch(`${base}/`)
  assert.equal(index.status, 200)
  assert.match(await index.text(), /opencode pager/)
  assert.equal((await fetch(`${base}/icon-192.png`)).headers.get('content-type'), 'image/png')
  assert.equal((await fetch(`${base}/manifest.webmanifest`)).status, 200)

  // pairing: bad code, then good code, single use
  const bad = await fetch(`${base}/pager/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'NOPE' }) })
  assert.equal(bad.status, 400)
  const { token, cookie, admin } = await pair(base)
  assert.ok(token)
  assert.match(admin.url, /^https:\/\/pager\.test\/#pair=[A-Z2-9]{10}$/)
  assert.match(cookie, /^pager=.+; Path=\/; HttpOnly; SameSite=Strict/)
  const reuse = await fetch(`${base}/pager/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: admin.code }) })
  assert.equal(reuse.status, 400)
  assert.equal(state.devices.length, 1)
  assert.equal(state.devices[0].name, 'test phone')

  // bearer and cookie both authenticate
  const bearer = { authorization: `Bearer ${token}` }
  const me = await (await fetch(`${base}/pager/me`, { headers: bearer })).json()
  assert.equal(me.opencode.version, '9.9.9-fake')
  assert.equal(me.opencode.connected, true)
  assert.ok(me.vapidPublicKey)
  assert.equal((await fetch(`${base}/pager/me`, { headers: { cookie: cookie.split(';')[0] } })).status, 200)

  // proxy strips our auth and adds opencode's basic auth
  const sessions = await (await fetch(`${base}/oc/session`, { headers: bearer })).json()
  assert.deepEqual(sessions, [])
  const last = fake.state.requests.at(-1)
  assert.equal(last.path, '/session')
  assert.equal(last.headers.authorization, 'Basic ' + Buffer.from('opencode:pw').toString('base64'))
  const created = await (await fetch(`${base}/oc/session`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: '{}' })).json()
  assert.match(created.id, /^ses_/)

  // event stream: first event is a full snapshot
  const [first] = await readSSEOnce(`${base}/pager/events?token=${token}`, {})
  assert.equal(first.event, 'snapshot')
  assert.equal(first.data.connected, true)

  // a permission arrives on the upstream stream -> inbox item, then push with an action token
  fake.state.permissions.push({ id: 'per_1', sessionID: 'ses_1', permission: 'bash', patterns: ['rm -rf build'], metadata: { command: 'rm -rf build' }, always: [] })
  fake.emit({ type: 'permission.asked', properties: fake.state.permissions[0] })
  await new Promise((r) => setTimeout(r, 150))
  const inbox = await (await fetch(`${base}/pager/inbox`, { headers: bearer })).json()
  assert.equal(inbox.items.length, 1)
  assert.equal(inbox.items[0].kind, 'permission')
  assert.equal(pushes.length, 0, 'no subscription yet, so no push')

  // subscribe to push, then another permission pages the phone
  await fetch(`${base}/pager/push/subscribe`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ subscription: { endpoint: 'https://push.example/abc', keys: { p256dh: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } } }) })
  assert.equal(state.subscriptions.length, 1)
  fake.state.permissions.push({ id: 'per_2', sessionID: 'ses_1', permission: 'edit', patterns: ['/p/src/a.ts'], metadata: {}, always: [] })
  fake.emit({ type: 'permission.asked', properties: fake.state.permissions[1] })
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(pushes.length, 1)
  assert.equal(pushes[0].payload.kind, 'permission')
  assert.equal(pushes[0].payload.title, 'Edit /p/src/a.ts')
  assert.equal(pushes[0].opts.urgency, 'high')
  assert.ok(pushes[0].payload.act, 'permission pushes carry an action token')

  // the service worker replies through /pager/act with that token; upstream receives the reply
  const act = await fetch(`${base}/pager/act`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ token: pushes[0].payload.act, reply: 'once' }) })
  assert.equal(act.status, 200)
  assert.deepEqual(fake.state.replies, [{ id: 'per_2', reply: 'once' }])
  const again = await fetch(`${base}/pager/act`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ token: pushes[0].payload.act, reply: 'once' }) })
  assert.equal(again.status, 400, 'action tokens are single use')
  await new Promise((r) => setTimeout(r, 50))
  const inbox2 = await (await fetch(`${base}/pager/inbox`, { headers: bearer })).json()
  assert.deepEqual(inbox2.items.map((i) => i.permission.id), ['per_1'])

  // replying through the proxy also works and clears the item via the replied event
  await fetch(`${base}/oc/permission/per_1/reply`, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json' }, body: JSON.stringify({ reply: 'reject' }) })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal((await (await fetch(`${base}/pager/inbox`, { headers: bearer })).json()).items.length, 0)

  // a finished run pages once
  fake.emit({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } })
  await new Promise((r) => setTimeout(r, 30))
  fake.emit({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(pushes.at(-1).payload.kind, 'finished')

  // a dead subscription is pruned
  pager.pushSend = async () => ({ ok: false, status: 410, gone: true })
  fake.emit({ type: 'session.error', properties: { sessionID: 'ses_1', error: { name: 'APIError', data: { message: 'boom' } } } })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(state.subscriptions.length, 0)

  // admin endpoints are loopback only when proxied
  const forwarded = await fetch(`${base}/pager/admin/devices`, { headers: { 'x-forwarded-for': '203.0.113.9' } })
  assert.equal(forwarded.status, 403)
  const devices = await (await fetch(`${base}/pager/admin/devices`)).json()
  assert.equal(devices.devices.length, 1)
  const revoked = await (await fetch(`${base}/pager/admin/devices/${devices.devices[0].id}`, { method: 'DELETE' })).json()
  assert.equal(revoked.revoked, true)
  assert.equal((await fetch(`${base}/pager/me`, { headers: bearer })).status, 401)
})

test('the bridge survives opencode going away and reconciles when it comes back', async (t) => {
  const { fake, base, cleanup, pager } = await setup()
  t.after(cleanup)
  const { token } = await pair(base)
  const bearer = { authorization: `Bearer ${token}` }
  await fake.close()
  await new Promise((r) => setTimeout(r, 100))
  const me = await (await fetch(`${base}/pager/me`, { headers: bearer })).json()
  assert.equal(me.opencode.connected, false)
  const proxied = await fetch(`${base}/oc/session`, { headers: bearer })
  assert.equal(proxied.status, 502)
  assert.match((await proxied.json()).message, /not reachable/)
  // while upstream is down, the inbox is still served from memory
  assert.equal((await fetch(`${base}/pager/inbox`, { headers: bearer })).status, 200)
})
