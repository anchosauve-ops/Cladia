// An OpenAI-compatible chat completions server with a script: when it sees tools and no tool
// results, it calls `bash`; after a tool result it answers with text. Title/summary requests
// (no tools) get a short text. Used to drive a real `opencode serve` deterministically.
import http from 'node:http'

export function startMockLLM({ command = 'echo hello from pager', finalText = 'Done. The command printed **hello from pager**.' } = {}) {
  const calls = []
  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const url = new URL(req.url, 'http://x')
    if (url.pathname.endsWith('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ object: 'list', data: [{ id: 'm1', object: 'model' }] })) }
    if (!url.pathname.endsWith('/chat/completions')) { res.writeHead(404); return res.end('{}') }
    let reqBody = {}
    try { reqBody = JSON.parse(body) } catch {}
    calls.push(reqBody)
    const messages = reqBody.messages || []
    const hasTools = Array.isArray(reqBody.tools) && reqBody.tools.length > 0
    const hasToolResult = messages.some((m) => m.role === 'tool')
    const id = 'chatcmpl-' + calls.length
    const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'm1', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
    const usage = `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'm1', choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`
    const stream = reqBody.stream !== false
    let out
    if (hasTools && !hasToolResult) {
      const args = JSON.stringify({ command, description: 'Say hello' })
      out = { kind: 'tool', chunks: [chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: '' } }] }), chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }), chunk({}, 'tool_calls')], full: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: args } }] }, finish: 'tool_calls' }
    } else {
      const text = hasTools ? finalText : 'Pager smoke test'
      out = { kind: 'text', chunks: [chunk({ role: 'assistant', content: '' }), ...text.split(' ').map((w, i) => chunk({ content: (i ? ' ' : '') + w })), chunk({}, 'stop')], full: { role: 'assistant', content: text }, finish: 'stop' }
    }
    if (stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const c of out.chunks) res.write(c)
      res.write(usage)
      res.end('data: [DONE]\n\n')
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'm1', choices: [{ index: 0, message: out.full, finish_reason: out.finish }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
    }
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(() => r())) })))
}

