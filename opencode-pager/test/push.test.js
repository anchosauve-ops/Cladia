import test from 'node:test'
import assert from 'node:assert/strict'
import { encryptPayload, generateVapidKeys, vapidAuthorization, verifyVapidJwt, sendPush, b64url, unb64url, _internal } from '../src/push.js'

// RFC 8291, Appendix A. Independently re-verified with python http_ece before being committed here.
const V = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

test('encryptPayload reproduces the RFC 8291 Appendix A message byte for byte', async () => {
  const asJwk = { ..._internal.uncompressedToJwk(unb64url(V.asPublic)), d: V.asPrivate }
  const privateKey = await crypto.subtle.importKey('jwk', asJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const publicKey = await crypto.subtle.importKey('jwk', _internal.uncompressedToJwk(unb64url(V.asPublic)), { name: 'ECDH', namedCurve: 'P-256' }, true, [])
  const body = await encryptPayload(
    { endpoint: 'https://push.example.net/x', keys: { p256dh: V.uaPublic, auth: V.auth } },
    V.plaintext,
    { asKeyPair: { privateKey, publicKey }, salt: unb64url(V.salt) },
  )
  assert.equal(b64url(body), V.body)
})

test('a receiver can decrypt what we encrypt (round trip with fresh keys)', async () => {
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const uaJwk = await crypto.subtle.exportKey('jwk', ua.publicKey)
  const p256dh = b64url(_internal.jwkToUncompressed(uaJwk))
  const auth = b64url(crypto.getRandomValues(new Uint8Array(16)))
  const msg = JSON.stringify({ kind: 'permission', title: 'bash: rm -rf build' })
  const body = await encryptPayload({ endpoint: 'https://p.example/', keys: { p256dh, auth } }, msg)
  // decrypt by hand
  const salt = body.slice(0, 16)
  const rs = (body[16] << 24) | (body[17] << 16) | (body[18] << 8) | body[19]
  assert.equal(rs, 4096)
  const idlen = body[20]
  assert.equal(idlen, 65)
  const asPublic = body.slice(21, 21 + idlen)
  const ct = body.slice(21 + idlen)
  const asKey = await crypto.subtle.importKey('jwk', _internal.uncompressedToJwk(asPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256))
  const te = new TextEncoder()
  const keyInfo = new Uint8Array([...te.encode('WebPush: info\0'), ...unb64url(p256dh), ...asPublic])
  const ikm = await _internal.hkdf(secret, unb64url(auth), keyInfo, 32)
  const cek = await _internal.hkdf(ikm, salt, te.encode('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await _internal.hkdf(ikm, salt, te.encode('Content-Encoding: nonce\0'), 12)
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt'])
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aes, ct))
  assert.equal(pt[pt.length - 1], 2)
  assert.equal(new TextDecoder().decode(pt.slice(0, -1)), msg)
})

test('VAPID authorization header carries a JWT that verifies with the public key', async () => {
  const keys = await generateVapidKeys()
  assert.equal(unb64url(keys.publicKey).length, 65)
  const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, { subject: 'mailto:you@example.com' })
  const m = header.match(/^vapid t=([^,]+), k=(.+)$/)
  assert.ok(m)
  assert.equal(m[2], keys.publicKey)
  const v = await verifyVapidJwt(m[1], keys.publicKey)
  assert.equal(v.ok, true)
  assert.equal(v.header.alg, 'ES256')
  assert.equal(v.claims.aud, 'https://fcm.googleapis.com')
  assert.equal(v.claims.sub, 'mailto:you@example.com')
  assert.ok(v.claims.exp > Date.now() / 1000 + 3600)
  // tampering breaks it (flip a character in the middle of the signature; the last one may only be padding bits)
  const [h, c, s] = m[1].split('.')
  const flipped = s.slice(0, 20) + (s[20] === 'A' ? 'B' : 'A') + s.slice(21)
  const bad = await verifyVapidJwt(`${h}.${c}.${flipped}`, keys.publicKey)
  assert.equal(bad.ok, false)
})

test('sendPush posts the right headers and reports dead subscriptions', async () => {
  const keys = await generateVapidKeys()
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const p256dh = b64url(_internal.jwkToUncompressed(await crypto.subtle.exportKey('jwk', ua.publicKey)))
  const sub = { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/xyz', keys: { p256dh, auth: b64url(crypto.getRandomValues(new Uint8Array(16))) } }
  let seen
  const fetch = async (url, init) => { seen = { url, init }; return { ok: true, status: 201 } }
  const r = await sendPush(sub, 'hi', keys, { subject: 'mailto:a@b.c', ttl: 30, urgency: 'high', topic: 'per_abc-1!', fetch })
  assert.equal(r.ok, true)
  assert.equal(seen.url, sub.endpoint)
  assert.equal(seen.init.headers['content-encoding'], 'aes128gcm')
  assert.equal(seen.init.headers.ttl, '30')
  assert.equal(seen.init.headers.urgency, 'high')
  assert.equal(seen.init.headers.topic, 'per_abc-1')
  assert.match(seen.init.headers.authorization, /^vapid t=/)
  const gone = await sendPush(sub, 'hi', keys, { subject: 'mailto:a@b.c', fetch: async () => ({ ok: false, status: 410, text: async () => 'gone' }) })
  assert.equal(gone.gone, true)
})
