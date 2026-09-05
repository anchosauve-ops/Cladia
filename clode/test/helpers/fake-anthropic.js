// A scripted Messages API: streams SSE like the real thing. Each script step is either
// { text } | { tool: name, input } | { refusal } and consumes one request.
import http from 'node:http'

export function startFakeAnthropic({ script = [], apiKey = 'sk-test' } = {}) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const url = new URL(req.url, 'http://x')
    if (url.pathname !== '/v1/messages') { res.writeHead(404); return res.end('{}') }
    if (req.headers['x-api-key'] !== apiKey) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })) }
    const parsed = JSON.parse(body)
    requests.push({ headers: req.headers, body: parsed })
    const step = script[Math.min(requests.length - 1, script.length - 1)] || { text: 'Done.' }
    if (step.status) { res.writeHead(step.status, { 'content-type': 'application/json', ...(step.retryAfter ? { 'retry-after': String(step.retryAfter) } : {}) }); return res.end(JSON.stringify({ type: 'error', error: { type: step.type || 'api_error', message: step.message || 'boom' } })) }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    send('message_start', { message: { id: 'msg_' + requests.length, type: 'message', role: 'assistant', model: parsed.model, content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 50, cache_read_input_tokens: 0 } } })
    let idx = 0
    if (parsed.thinking) {
      send('content_block_start', { index: idx, content_block: { type: 'thinking', thinking: '' } })
      send('content_block_delta', { index: idx, delta: { type: 'thinking_delta', thinking: 'Considering the request.' } })
      send('content_block_delta', { index: idx, delta: { type: 'signature_delta', signature: 'sig_abc' } })
      send('content_block_stop', { index: idx }); idx++
    }
    if (step.refusal) {
      send('message_delta', { delta: { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'declined' } }, usage: { output_tokens: 2 } })
      send('message_stop', {}); return res.end()
    }
    if (step.text) {
      send('content_block_start', { index: idx, content_block: { type: 'text', text: '' } })
      for (const word of step.text.split(' ')) send('content_block_delta', { index: idx, delta: { type: 'text_delta', text: word + ' ' } })
      send('content_block_stop', { index: idx }); idx++
    }
    if (step.tool) {
      const json = JSON.stringify(step.input || {})
      send('content_block_start', { index: idx, content_block: { type: 'tool_use', id: 'toolu_' + requests.length, name: step.tool, input: {} } })
      const half = Math.ceil(json.length / 2)
      send('content_block_delta', { index: idx, delta: { type: 'input_json_delta', partial_json: json.slice(0, half) } })
      send('content_block_delta', { index: idx, delta: { type: 'input_json_delta', partial_json: json.slice(half) } })
      send('content_block_stop', { index: idx }); idx++
    }
    send('message_delta', { delta: { stop_reason: step.tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } })
    send('message_stop', {})
    res.end()
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(() => r())) })))
}
