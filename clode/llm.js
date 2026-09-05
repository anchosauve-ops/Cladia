// clode: the model client. Raw HTTP to the Claude Messages API from the browser, streaming, with tool use.
// No SDK because clode is a single-origin PWA with no bundler; the request shapes follow the Messages API docs.
// Runs in the browser and in Node (tests) alike: only fetch, TextDecoder and ReadableStream are used.

export const MODELS = [
  { id: 'claude-opus-5', name: 'Claude Opus 5', input: 5, output: 25, thinking: 'adaptive', effort: true, compaction: true, fallbacks: true },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', input: 2, output: 10, thinking: 'adaptive', effort: true, compaction: true, fallbacks: false },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', input: 5, output: 25, thinking: 'adaptive', effort: true, compaction: true, fallbacks: false },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', input: 1, output: 5, thinking: 'budget', effort: false, compaction: false, fallbacks: false },
]
export const DEFAULT_MODEL = 'claude-opus-5'
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

export class LLMError extends Error {
  constructor(status, type, message, retryAfter) { super(message); this.status = status; this.type = type; this.retryAfter = retryAfter }
}

export function modelInfo(id) { return MODELS.find((m) => m.id === id) || { id, name: id, input: 0, output: 0, thinking: 'adaptive', effort: true, compaction: false, fallbacks: false } }

/** Estimated USD for a usage object. */
export function costOf(usage, model) {
  const m = modelInfo(model)
  const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1
  return (inTok * m.input + (usage.output_tokens || 0) * m.output) / 1e6
}

/**
 * Build the request body for one turn.
 * opts: { model, system, tools, messages, effort, maxTokens, compaction }
 */
export function buildRequest({ model, system, tools, messages, effort = 'high', maxTokens = 64000, compaction = true }) {
  const m = modelInfo(model)
  const body = {
    model,
    max_tokens: maxTokens,
    stream: true,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    tools,
    messages,
  }
  if (m.thinking === 'adaptive') body.thinking = { type: 'adaptive', display: 'summarized' }
  else if (m.thinking === 'budget') body.thinking = { type: 'enabled', budget_tokens: 8000 }
  if (m.effort) body.output_config = { effort }
  if (m.fallbacks) body.fallbacks = 'default'
  if (m.compaction && compaction) body.context_management = { edits: [{ type: 'compact_20260112' }] }
  const betas = []
  if (m.fallbacks) betas.push('server-side-fallback-2026-07-01')
  if (m.compaction && compaction) betas.push('compact-2026-01-12')
  return { body, betas }
}

/**
 * Stream one assistant turn. Calls onEvent for UI updates:
 *   { type: 'text', index, delta } | { type: 'thinking', index, delta } | { type: 'tool_input', index, name, id, partial }
 *   | { type: 'block_start', index, block } | { type: 'block_stop', index } | { type: 'usage', usage }
 * Resolves to { content: [...blocks], stop_reason, stop_details, usage, model }.
 * The returned content blocks are ready to be echoed back as the assistant message (thinking blocks included, unchanged).
 */
export async function streamTurn({ apiKey, baseUrl = 'https://api.anthropic.com', request, betas = [], signal, fetch: f = globalThis.fetch, onEvent = () => {}, maxRetries = 2 }) {
  let attempt = 0
  for (;;) {
    const headers = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    }
    if (betas.length) headers['anthropic-beta'] = betas.join(',')
    let res
    try {
      res = await f(`${baseUrl.replace(/\/+$/, '')}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(request), signal })
    } catch (e) {
      if (signal?.aborted) throw e
      if (attempt++ < maxRetries) { await sleep(1000 * 2 ** attempt); continue }
      throw new LLMError(0, 'network', `Could not reach the model API: ${e.message}`)
    }
    if (!res.ok) {
      let err = { type: 'api_error', message: `HTTP ${res.status}` }
      try { const j = await res.json(); if (j.error) err = j.error } catch {}
      const retryAfter = Number(res.headers.get('retry-after')) || null
      if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt++ < maxRetries) { await sleep((retryAfter || 2 ** attempt) * 1000); continue }
      throw new LLMError(res.status, err.type, err.message, retryAfter)
    }
    return readStream(res.body, onEvent)
  }
}

async function readStream(body, onEvent) {
  const blocks = []
  const partials = new Map() // index -> accumulated input json
  let stop_reason = null, stop_details = null, model = null
  let usage = {}
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const handle = (evt) => {
    switch (evt.type) {
      case 'message_start':
        model = evt.message?.model || model
        usage = { ...usage, ...(evt.message?.usage || {}) }
        onEvent({ type: 'usage', usage })
        break
      case 'content_block_start': {
        const b = { ...evt.content_block }
        if (b.type === 'tool_use') { b.input = {}; partials.set(evt.index, '') }
        if (b.type === 'text') b.text = b.text || ''
        if (b.type === 'thinking') b.thinking = b.thinking || ''
        blocks[evt.index] = b
        onEvent({ type: 'block_start', index: evt.index, block: b })
        break
      }
      case 'content_block_delta': {
        const b = blocks[evt.index]
        if (!b) break
        const d = evt.delta
        if (d.type === 'text_delta') { b.text += d.text; onEvent({ type: 'text', index: evt.index, delta: d.text }) }
        else if (d.type === 'thinking_delta') { b.thinking += d.thinking; onEvent({ type: 'thinking', index: evt.index, delta: d.thinking }) }
        else if (d.type === 'signature_delta') { b.signature = (b.signature || '') + d.signature }
        else if (d.type === 'input_json_delta') { const s = partials.get(evt.index) + d.partial_json; partials.set(evt.index, s); onEvent({ type: 'tool_input', index: evt.index, name: b.name, id: b.id, partial: s }) }
        break
      }
      case 'content_block_stop': {
        const b = blocks[evt.index]
        if (b?.type === 'tool_use') { const s = partials.get(evt.index); try { b.input = s ? JSON.parse(s) : {} } catch { b.input = {}; b._badJson = s } }
        onEvent({ type: 'block_stop', index: evt.index, block: b })
        break
      }
      case 'message_delta':
        if (evt.delta?.stop_reason) stop_reason = evt.delta.stop_reason
        if (evt.delta?.stop_details) stop_details = evt.delta.stop_details
        if (evt.usage) { usage = { ...usage, ...evt.usage }; onEvent({ type: 'usage', usage }) }
        break
      case 'error':
        throw new LLMError(0, evt.error?.type || 'stream_error', evt.error?.message || 'stream error')
      default:
        break
    }
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2)
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data) continue
        let evt
        try { evt = JSON.parse(data) } catch { continue }
        handle(evt)
      }
    }
  }
  // Drop holes and strip our private fields
  const content = blocks.filter(Boolean).map((b) => { const { _badJson, ...rest } = b; return rest })
  return { content, stop_reason, stop_details, usage, model }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

/** Rough token estimate for budgeting (chars / 3.5). */
export function estimateTokens(messages) {
  let chars = 0
  for (const m of messages) chars += typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length
  return Math.round(chars / 3.5)
}
