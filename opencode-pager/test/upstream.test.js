import test from 'node:test'
import assert from 'node:assert/strict'
import { readSSE, Upstream } from '../src/upstream.js'

function streamOf(chunks) {
  const enc = new TextEncoder()
  return new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close() } })
}

test('readSSE handles split chunks, comments, CRLF and multi-line data', async () => {
  const got = []
  await readSSE(streamOf(['data: {"a":1}\n\n: heartbeat\r\n\r\nid: 7\nda', 'ta: line1\ndata: line2\n\nevent: x\ndata:\n\n']), (m) => got.push(m))
  assert.deepEqual(got, [
    { data: '{"a":1}', event: undefined, id: undefined },
    { data: 'line1\nline2', event: undefined, id: '7' },
    { data: '', event: 'x', id: undefined },
  ])
})

test('Upstream adds basic auth and parses JSON errors', async () => {
  const calls = []
  const up = new Upstream({ baseUrl: 'http://oc:4096/', password: 'pw', fetch: async (url, init) => { calls.push({ url, init }); return { ok: false, status: 404, text: async () => '{"name":"NotFoundError"}' } } })
  await assert.rejects(() => up.json('GET', '/session/ses_1'), (e) => e.status === 404 && e.body.name === 'NotFoundError')
  assert.equal(calls[0].url, 'http://oc:4096/session/ses_1')
  assert.equal(calls[0].init.headers.authorization, 'Basic ' + Buffer.from('opencode:pw').toString('base64'))
})

test('subscribe reconnects after the stream drops', async () => {
  let n = 0
  const up = new Upstream({ baseUrl: 'http://oc', fetch: async () => { n++; return { ok: true, body: streamOf([`data: {"type":"server.connected","n":${n}}\n\n`]) } } })
  const events = []
  const opens = []
  const stop = up.subscribe((e) => events.push(e), { onOpen: () => opens.push(1), minDelay: 5, maxDelay: 10 })
  await new Promise((r) => setTimeout(r, 60))
  stop()
  assert.ok(events.length >= 2, `expected reconnects, got ${events.length}`)
  assert.equal(opens.length, events.length)
})
