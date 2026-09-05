// Persistent state for the bridge: VAPID keys, paired devices (token hashes only) and push subscriptions.
// Lives in $OPENCODE_PAGER_STATE or ~/.config/opencode-pager/state.json, mode 0600.

import { readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export function defaultStatePath() {
  if (process.env.OPENCODE_PAGER_STATE) return process.env.OPENCODE_PAGER_STATE
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'opencode-pager', 'state.json')
}

export class State {
  constructor(path = defaultStatePath()) {
    this.path = path
    this.data = { version: 1, vapid: null, subject: null, devices: [], subscriptions: [], settings: {} }
    this.load()
  }

  load() {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      this.data = { ...this.data, ...parsed }
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
    }
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 })
    try { chmodSync(tmp, 0o600) } catch {}
    renameSync(tmp, this.path)
  }

  get vapid() { return this.data.vapid }
  set vapid(v) { this.data.vapid = v; this.save() }
  get subject() { return this.data.subject }
  set subject(v) { this.data.subject = v; this.save() }

  static hashToken(token) { return createHash('sha256').update(token).digest('hex') }

  /** Create a device; returns the raw bearer token exactly once. */
  addDevice({ name, ua } = {}) {
    const token = randomBytes(32).toString('base64url')
    const device = { id: 'dev_' + randomBytes(6).toString('hex'), name: String(name || 'phone').slice(0, 80), ua: String(ua || '').slice(0, 200), tokenHash: State.hashToken(token), createdAt: Date.now(), lastSeen: null }
    this.data.devices.push(device)
    this.save()
    return { token, device }
  }

  findDeviceByToken(token) {
    if (!token) return null
    const h = Buffer.from(State.hashToken(token))
    for (const d of this.data.devices) {
      const dh = Buffer.from(d.tokenHash)
      if (dh.length === h.length && timingSafeEqual(dh, h)) return d
    }
    return null
  }

  touchDevice(id) {
    const d = this.data.devices.find((x) => x.id === id)
    if (!d) return
    const now = Date.now()
    if (!d.lastSeen || now - d.lastSeen > 60_000) { d.lastSeen = now; this.save() }
  }

  revokeDevice(id) {
    const before = this.data.devices.length
    this.data.devices = this.data.devices.filter((d) => d.id !== id)
    this.data.subscriptions = this.data.subscriptions.filter((s) => s.deviceId !== id)
    this.save()
    return this.data.devices.length !== before
  }

  get devices() { return this.data.devices.map(({ tokenHash, ...d }) => d) }

  addSubscription(deviceId, sub) {
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new Error('invalid subscription')
    this.data.subscriptions = this.data.subscriptions.filter((s) => s.endpoint !== sub.endpoint)
    this.data.subscriptions.push({ deviceId, endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, createdAt: Date.now() })
    this.save()
  }

  removeSubscription(endpoint) {
    const before = this.data.subscriptions.length
    this.data.subscriptions = this.data.subscriptions.filter((s) => s.endpoint !== endpoint)
    if (before !== this.data.subscriptions.length) this.save()
  }

  get subscriptions() { return this.data.subscriptions }
}
