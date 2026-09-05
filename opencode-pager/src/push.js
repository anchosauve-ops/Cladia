// Web Push with zero dependencies: VAPID (RFC 8292) and aes128gcm content encryption (RFC 8188 / RFC 8291),
// implemented on WebCrypto (globalThis.crypto.subtle), which Node >= 20 and Bun both ship.
// Verified against the RFC 8291 Appendix A test vector in test/push.test.js.

const subtle = globalThis.crypto.subtle
const te = new TextEncoder()

export function b64url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}
export function unb64url(s) {
  return new Uint8Array(Buffer.from(s, 'base64url'))
}

function concat(...arrs) {
  const len = arrs.reduce((n, a) => n + a.length, 0)
  const out = new Uint8Array(len)
  let o = 0
  for (const a of arrs) { out.set(a, o); o += a.length }
  return out
}

function jwkToUncompressed(jwk) {
  return concat(new Uint8Array([4]), unb64url(jwk.x), unb64url(jwk.y))
}
function uncompressedToJwk(pub) {
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('expected 65-byte uncompressed P-256 point')
  return { kty: 'EC', crv: 'P-256', x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)) }
}

/** Generate a VAPID key pair. Returns base64url strings: publicKey (65 bytes, uncompressed) and privateKey (32 bytes). */
export async function generateVapidKeys() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const jwk = await subtle.exportKey('jwk', kp.privateKey)
  return { publicKey: b64url(jwkToUncompressed(jwk)), privateKey: jwk.d }
}

async function importVapidPrivate(keys) {
  const pub = unb64url(keys.publicKey)
  const jwk = { ...uncompressedToJwk(pub), d: keys.privateKey }
  return subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}

/** Build the `Authorization: vapid t=..., k=...` header value for a push endpoint. */
export async function vapidAuthorization(endpoint, keys, { subject, expiresIn = 12 * 3600 } = {}) {
  if (!subject || !/^(mailto:|https?:)/.test(subject)) throw new Error('VAPID subject must be a mailto: or https: URL')
  const aud = new URL(endpoint).origin
  const header = b64url(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64url(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + expiresIn, sub: subject })))
  const signingInput = te.encode(`${header}.${claims}`)
  const key = await importVapidPrivate(keys)
  // WebCrypto ECDSA returns r||s (64 bytes), which is exactly the JWS ES256 format.
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signingInput))
  return `vapid t=${header}.${claims}.${b64url(sig)}, k=${keys.publicKey}`
}

async function hkdf(ikm, salt, info, length) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8))
}

/**
 * Encrypt a payload for a PushSubscription per RFC 8291 (aes128gcm, single record).
 * `sub` is { endpoint, keys: { p256dh, auth } } as produced by the browser.
 * `opts.asKeyPair` and `opts.salt` are only for tests (deterministic output).
 */
export async function encryptPayload(sub, payload, opts = {}) {
  const uaPublic = unb64url(sub.keys.p256dh)
  const authSecret = unb64url(sub.keys.auth)
  if (uaPublic.length !== 65) throw new Error('p256dh must be a 65-byte uncompressed point')
  if (authSecret.length !== 16) throw new Error('auth must be 16 bytes')
  const plaintext = typeof payload === 'string' ? te.encode(payload) : new Uint8Array(payload)
  if (plaintext.length > 3993) throw new Error('payload too large (max 3993 bytes for a 4096-byte record)')

  const asKeyPair = opts.asKeyPair || (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']))
  const asPublic = jwkToUncompressed(await subtle.exportKey('jwk', asKeyPair.publicKey))
  const uaKey = await subtle.importKey('jwk', uncompressedToJwk(uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const ecdhSecret = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeyPair.privateKey, 256))

  const keyInfo = concat(te.encode('WebPush: info\0'), uaPublic, asPublic)
  const ikm = await hkdf(ecdhSecret, authSecret, keyInfo, 32)
  const salt = opts.salt || globalThis.crypto.getRandomValues(new Uint8Array(16))
  const cek = await hkdf(ikm, salt, te.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(ikm, salt, te.encode('Content-Encoding: nonce\0'), 12)

  const aesKey = await subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const record = concat(plaintext, new Uint8Array([2])) // 0x02 delimiter: last record
  const ciphertext = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, record))

  const rs = 4096
  const header = concat(salt, new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255, asPublic.length]), asPublic)
  return concat(header, ciphertext)
}

/**
 * Send a push message. Returns { ok, status, gone } where gone=true means the subscription is dead (404/410).
 * opts: { ttl (s), urgency: 'very-low'|'low'|'normal'|'high', topic, subject, fetch }
 */
export async function sendPush(sub, payload, keys, opts = {}) {
  const body = await encryptPayload(sub, payload)
  const auth = await vapidAuthorization(sub.endpoint, keys, { subject: opts.subject })
  const headers = {
    'content-type': 'application/octet-stream',
    'content-encoding': 'aes128gcm',
    'content-length': String(body.length),
    ttl: String(opts.ttl ?? 60 * 60),
    urgency: opts.urgency || 'normal',
    authorization: auth,
  }
  if (opts.topic) headers.topic = String(opts.topic).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32)
  const f = opts.fetch || globalThis.fetch
  const res = await f(sub.endpoint, { method: 'POST', headers, body })
  const gone = res.status === 404 || res.status === 410
  let text = ''
  if (!res.ok) { try { text = await res.text() } catch {} }
  return { ok: res.ok, status: res.status, gone, text }
}

/** Verify a VAPID JWT with the public key. Used by tests and by `opencode-pager doctor`. */
export async function verifyVapidJwt(jwt, publicKeyB64) {
  const [h, c, s] = jwt.split('.')
  const key = await subtle.importKey('jwk', uncompressedToJwk(unb64url(publicKeyB64)), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
  const ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64url(s), te.encode(`${h}.${c}`))
  return { ok, header: JSON.parse(Buffer.from(h, 'base64url')), claims: JSON.parse(Buffer.from(c, 'base64url')) }
}

export const _internal = { uncompressedToJwk, jwkToUncompressed, hkdf }
