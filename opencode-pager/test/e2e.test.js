// End-to-end against a REAL `opencode serve`, driven by a mock model that asks to run a bash command.
// Runs only when OPENCODE_BIN points at an opencode binary (CI installs one; locally: OPENCODE_BIN=$(which opencode)).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { startMockLLM } from './helpers/mock-llm.js'
import { Pager } from '../src/server.js'
import { Upstream } from '../src/upstream.js'
import { State } from '../src/state.js'
import { Inbox } from '../src/inbox.js'

const BIN = process.env.OPENCODE_BIN
const freePort = () => new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)) }) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, { timeout = 60_000, every = 250, what = 'condition' } = {}) {
  const t0 = Date.now()
  for (;;) {
    const left = timeout - (Date.now() - t0)
    if (left <= 0) throw new Error(`timed out waiting for ${what}`)
    const v = await Promise.race([Promise.resolve().then(fn).catch(() => null), sleep(Math.min(left, 10_000)).then(() => null)])
    if (v) return v
    await sleep(every)
  }
}

test('real opencode: a bash permission reaches the inbox, is approved from the pager, and the run finishes', { skip: !BIN && 'set OPENCODE_BIN to run' }, async (t) => {
  const llm = await startMockLLM()
  const dir = mkdtempSync(join(tmpdir(), 'pager-e2e-'))
  const proj = join(dir, 'proj'); mkdirSync(proj)
  const home = join(dir, 'home'); mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
  // opencode fetches models.dev on first start; seed the fresh HOME's cache from the real one so the test also runs offline
  const realCache = join(process.env.HOME || '', '.cache', 'opencode')
  if (existsSync(realCache)) cpSync(realCache, join(home, '.cache', 'opencode'), { recursive: true })
  writeFileSync(join(proj, 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: { mock: { npm: '@ai-sdk/openai-compatible', name: 'Mock', options: { baseURL: `${llm.url}/v1`, apiKey: 'mock' }, models: { m1: { name: 'Mock 1', tool_call: true } } } },
    model: 'mock/m1', small_model: 'mock/m1',
    permission: { bash: 'ask' },
    share: 'disabled', autoupdate: false,
  }, null, 2))
  writeFileSync(join(proj, 'README.md'), '# e2e\n')
  const port = await freePort()
  const password = 'e2e-secret'
  const oc = spawn(BIN, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], { cwd: proj, env: { ...process.env, OPENCODE_SERVER_PASSWORD: password, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state'), XDG_CACHE_HOME: join(home, '.cache'), OPENCODE_DISABLE_AUTOUPDATE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let ocLog = ''
  oc.stdout.on('data', (d) => (ocLog += d)); oc.stderr.on('data', (d) => (ocLog += d))
  const upstream = new Upstream({ baseUrl: `http://127.0.0.1:${port}`, password })
  const pushes = []
  const pager = new Pager({ upstream, state: new State(join(dir, 'state.json')), inbox: new Inbox({ permissionGrace: 200, finishedMinBusy: 500 }), publicUrl: 'https://pager.test', pushSend: async (s, payload) => { pushes.push(JSON.parse(payload)); return { ok: true, status: 201 } } })
  t.after(async () => { await pager.stop(); oc.kill('SIGTERM'); await llm.close(); rmSync(dir, { recursive: true, force: true }); if (process.env.E2E_LOG) console.log(ocLog) })

  await waitFor(() => upstream.json('GET', '/global/health', undefined, { signal: AbortSignal.timeout(5000) }), { what: 'opencode to start', timeout: 180_000 }).catch((e) => { throw new Error(e.message + '\n' + ocLog.slice(-2000)) })
  const addr = await pager.start({ port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${addr.port}`
  await waitFor(async () => (await (await fetch(`${base}/pager/admin/status`)).json()).connected, { what: 'bridge to connect to opencode' })

  const { code } = await (await fetch(`${base}/pager/admin/pair`, { method: 'POST' })).json()
  const { token } = await (await fetch(`${base}/pager/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'e2e phone' }) })).json()
  const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  await fetch(`${base}/pager/push/subscribe`, { method: 'POST', headers: h, body: JSON.stringify({ subscription: { endpoint: 'https://push.example/e2e', keys: { p256dh: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } } }) })

  // the phone creates a session and sends a prompt through the proxy, exactly as the app does
  const session = await (await fetch(`${base}/oc/session`, { method: 'POST', headers: h, body: JSON.stringify({ title: 'e2e' }) })).json()
  assert.match(session.id, /^ses_/)
  const sent = await fetch(`${base}/oc/session/${session.id}/prompt_async`, { method: 'POST', headers: h, body: JSON.stringify({ parts: [{ type: 'text', text: 'Please say hello.' }] }) })
  assert.equal(sent.status, 204, 'prompt_async returns 204 immediately; no long-lived response to time out on mobile')

  // opencode asks for bash permission -> it shows up in the inbox and pages the phone
  const inbox = await waitFor(async () => { const s = await (await fetch(`${base}/pager/inbox`, { headers: h })).json(); return s.items.find((i) => i.kind === 'permission') && s }, { what: 'a permission in the inbox', timeout: 90_000 }).catch((e) => { throw new Error(e.message + '\nmock calls: ' + llm.calls.length + '\n' + ocLog.slice(-3000)) })
  const item = inbox.items.find((i) => i.kind === 'permission')
  assert.equal(item.permission.permission, 'bash')
  assert.match(item.permission.metadata?.command || item.permission.patterns.join(' '), /echo hello from pager/)
  assert.equal(inbox.sessions.find((s) => s.id === session.id)?.status, 'busy')
  await waitFor(() => pushes.find((p) => p.kind === 'permission'), { what: 'a permission push', timeout: 5000 })
  const push = pushes.find((p) => p.kind === 'permission')
  assert.match(push.title, /^Run: echo hello from pager/)
  assert.ok(push.act)

  // REST truth agrees with the stream-derived inbox (this is what a reconnecting phone relies on)
  const pending = await (await fetch(`${base}/oc/permission`, { headers: h })).json()
  assert.deepEqual(pending.map((p) => p.id), [item.permission.id])

  // approve straight from the notification action
  const act = await fetch(`${base}/pager/act`, { method: 'POST', headers: h, body: JSON.stringify({ token: push.act, reply: 'once' }) })
  assert.equal(act.status, 200, await act.text())

  // the run completes: assistant text arrives and the session pages "finished"
  const messages = await waitFor(async () => { const m = await (await fetch(`${base}/oc/session/${session.id}/message`, { headers: h })).json(); return m.some((x) => x.info.role === 'assistant' && x.parts.some((p) => p.type === 'text' && /hello from pager/.test(p.text))) && m }, { what: 'the final assistant message', timeout: 60_000 })
  const toolPart = messages.flatMap((m) => m.parts).find((p) => p.type === 'tool' && p.tool === 'bash')
  assert.equal(toolPart.state.status, 'completed')
  assert.match(toolPart.state.output, /hello from pager/)
  await waitFor(async () => { const s = await (await fetch(`${base}/pager/inbox`, { headers: h })).json(); return s.sessions.find((x) => x.id === session.id)?.status === 'idle' && s.items.some((i) => i.kind === 'finished') && s }, { what: 'finished item', timeout: 30_000 })
  assert.ok(pushes.some((p) => p.kind === 'finished'))
  assert.equal((await (await fetch(`${base}/pager/inbox`, { headers: h })).json()).items.filter((i) => i.kind === 'permission').length, 0)
})
