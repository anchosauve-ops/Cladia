#!/usr/bin/env node
// opencode-pager: the agent pages you.
//
//   opencode-pager [serve] [--opencode URL] [--port N] [--host H] [--url PUBLIC_URL] [--subject mailto:you@x]
//                  [--state PATH] [--tls-cert F --tls-key F] [--spawn]
//   opencode-pager pair        print a fresh pairing QR for the running bridge
//   opencode-pager devices     list paired devices and push subscriptions
//   opencode-pager revoke ID   forget a device
//   opencode-pager status      bridge + opencode status

import { readFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { spawn } from 'node:child_process'
import { Upstream } from '../src/upstream.js'
import { State, defaultStatePath } from '../src/state.js'
import { Pager, VERSION } from '../src/server.js'
import { encode, toTerminal } from '../src/qr.js'

const args = process.argv.slice(2)
const cmd = args[0] && !args[0].startsWith('-') ? args.shift() : 'serve'
const opts = {}
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a.startsWith('--')) {
    const key = a.slice(2)
    const next = args[i + 1]
    if (next === undefined || next.startsWith('--')) opts[key] = true
    else { opts[key] = next; i++ }
  } else opts._ = [...(opts._ || []), a]
}
if (opts.help || opts.h || cmd === 'help') { usage(); process.exit(0) }
if (opts.version || cmd === 'version') { console.log(VERSION); process.exit(0) }

const port = Number(opts.port || process.env.OPENCODE_PAGER_PORT || 4097)
const host = opts.host || process.env.OPENCODE_PAGER_HOST || '0.0.0.0'
const opencodeUrl = opts.opencode || process.env.OPENCODE_URL || 'http://127.0.0.1:4096'
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a)

const commands = { serve, pair, devices, revoke, status }
if (!commands[cmd]) { console.error(`unknown command: ${cmd}\n`); usage(); process.exit(2) }
commands[cmd]().catch((e) => { console.error('error:', e.message); process.exit(1) })

async function serve() {
  const state = new State(opts.state || defaultStatePath())
  if (opts.subject) state.subject = opts.subject
  const upstream = new Upstream({ baseUrl: opencodeUrl, username: process.env.OPENCODE_SERVER_USERNAME || 'opencode', password: process.env.OPENCODE_SERVER_PASSWORD || '', log })
  let child = null
  if (opts.spawn) {
    const u = new URL(opencodeUrl)
    const password = process.env.OPENCODE_SERVER_PASSWORD || ''
    log(`spawning: opencode serve --hostname ${u.hostname} --port ${u.port || 4096}`)
    child = spawn('opencode', ['serve', '--hostname', u.hostname, '--port', u.port || '4096'], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, OPENCODE_SERVER_PASSWORD: password } })
    child.on('exit', (code) => { log(`opencode exited with ${code}`); process.exit(code ?? 1) })
    upstream.password = password
  }
  const tls = opts['tls-cert'] && opts['tls-key'] ? { cert: readFileSync(opts['tls-cert']), key: readFileSync(opts['tls-key']) } : null
  const scheme = tls ? 'https' : 'http'
  const publicUrl = (opts.url || process.env.OPENCODE_PAGER_URL || `${scheme}://${lanAddress()}:${port}`).replace(/\/+$/, '')
  const pager = new Pager({ upstream, state, publicUrl, log, tls })
  const addr = await pager.start({ port, host })
  const health = await upstream.health().catch((e) => ({ error: e.message }))

  console.error('')
  console.error(`  opencode-pager ${VERSION}`)
  console.error(`  bridge     ${scheme}://${host}:${addr.port}  (public: ${publicUrl})`)
  console.error(`  opencode   ${opencodeUrl}  ${health.version ? 'v' + health.version : 'NOT REACHABLE: ' + health.error}`)
  console.error(`  state      ${state.path}`)
  if (!process.env.OPENCODE_SERVER_PASSWORD && !opts.spawn) console.error('  note       OPENCODE_SERVER_PASSWORD is not set; the bridge assumes opencode runs without a password')
  if (!/^https:/.test(publicUrl) && !/localhost|127\.0\.0\.1/.test(publicUrl)) {
    console.error('  warning    the public URL is plain http. Phones only allow push notifications and "Add to Home Screen"')
    console.error('             on https. Put the bridge behind `tailscale serve` or a Cloudflare Tunnel and pass --url https://…')
  }
  printPairing(pager)
  console.error('  Paired devices: ' + (state.devices.length || 'none') + '. Run `opencode-pager pair` for another code.\n')

  const shutdown = async () => { log('shutting down'); await pager.stop(); child?.kill(); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

function printPairing(pager) {
  const code = pager.newPairingCode({ ttlMs: 30 * 60_000, label: 'startup' })
  const url = pager.pairUrl(code)
  console.error('')
  console.error(toTerminal(encode(url, { ecl: 'M' }), { margin: 1 }).split('\n').map((l) => '  ' + l).join('\n'))
  console.error('')
  console.error(`  Scan with your phone, or open ${url}`)
  console.error(`  Pairing code: ${code}  (valid 30 minutes, single use)`)
  console.error('')
}

async function adminFetch(path, init) {
  const res = await fetch(`http://127.0.0.1:${port}/pager/admin/${path}`, init).catch((e) => { throw new Error(`bridge not reachable on 127.0.0.1:${port} (${e.message}). Is \`opencode-pager serve\` running?`) })
  const body = await res.json()
  if (!res.ok) throw new Error(body.message || body.error)
  return body
}

async function pair() {
  const { code, url } = await adminFetch('pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label: 'cli' }) })
  console.error('')
  console.error(toTerminal(encode(url, { ecl: 'M' }), { margin: 1 }).split('\n').map((l) => '  ' + l).join('\n'))
  console.error(`\n  Scan with your phone, or open ${url}\n  Pairing code: ${code}  (valid 10 minutes, single use)\n`)
}

async function devices() {
  const { devices, subscriptions } = await adminFetch('devices')
  if (devices.length === 0) return console.log('no paired devices')
  for (const d of devices) {
    const subs = subscriptions.filter((s) => s.deviceId === d.id).length
    console.log(`${d.id}  ${d.name.padEnd(20)}  paired ${new Date(d.createdAt).toISOString().slice(0, 10)}  last seen ${d.lastSeen ? ago(d.lastSeen) : 'never'}  push: ${subs ? subs + ' subscription(s)' : 'off'}`)
  }
}

async function revoke() {
  const id = opts._?.[0]
  if (!id) throw new Error('usage: opencode-pager revoke <device-id>')
  const { revoked } = await adminFetch(`devices/${encodeURIComponent(id)}`, { method: 'DELETE' })
  console.log(revoked ? `revoked ${id}` : `no such device: ${id}`)
}

async function status() {
  console.log(JSON.stringify(await adminFetch('status'), null, 2))
}

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address
  return 'localhost'
}
function ago(t) {
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 90) return `${s}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 172800) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
function usage() {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').filter((l) => l.startsWith('//')).slice(1).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'))
}
