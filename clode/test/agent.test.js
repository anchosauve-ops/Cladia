import test from 'node:test'
import assert from 'node:assert/strict'
import { Agent, toolDefs, APPROVAL_TOOLS } from '../agent.js'
import { GitHub, Workspace } from '../github.js'
import { buildRequest, streamTurn, costOf, LLMError } from '../llm.js'
import { startFakeAnthropic } from './helpers/fake-anthropic.js'
import { startFakeGitHub } from './helpers/fake-github.js'

async function setup(script, ghOpts = {}) {
  const llm = await startFakeAnthropic({ script })
  const gh = await startFakeGitHub(ghOpts)
  const ws = await new Workspace(new GitHub({ token: 'ghp_test', baseUrl: gh.url }), { owner: 'octo', repo: 'proj', branch: 'main' }).load()
  const events = []
  const agent = new Agent({ workspace: ws, apiKey: 'sk-test', baseUrl: llm.url, model: 'claude-opus-5', effort: 'high', hooks: { onEvent: (e) => events.push(e), approve: async () => 'once', ask: async () => 'blue' } })
  return { llm, gh, ws, agent, events, close: async () => { await llm.close(); await gh.close() } }
}

test('tool definitions are strict and every property is required', () => {
  for (const t of toolDefs()) {
    assert.equal(t.strict, true)
    assert.equal(t.input_schema.additionalProperties, false)
    assert.deepEqual(t.input_schema.required, Object.keys(t.input_schema.properties))
    assert.ok(!('_optional' in t))
  }
  assert.ok(APPROVAL_TOOLS.has('commit'))
})

test('request shape: opus 5 gets adaptive thinking, effort, fallbacks and compaction; haiku gets a budget', () => {
  const { body, betas } = buildRequest({ model: 'claude-opus-5', system: 'S', tools: [], messages: [], effort: 'xhigh' })
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' })
  assert.deepEqual(body.output_config, { effort: 'xhigh' })
  assert.equal(body.fallbacks, 'default')
  assert.equal(body.stream, true)
  assert.deepEqual(body.system, [{ type: 'text', text: 'S', cache_control: { type: 'ephemeral' } }])
  assert.deepEqual(betas.sort(), ['compact-2026-01-12', 'server-side-fallback-2026-07-01'])
  const h = buildRequest({ model: 'claude-haiku-4-5', system: 'S', tools: [], messages: [] })
  assert.deepEqual(h.body.thinking, { type: 'enabled', budget_tokens: 8000 })
  assert.equal(h.body.output_config, undefined)
  assert.equal(h.body.fallbacks, undefined)
  assert.deepEqual(h.betas, [])
  const s = buildRequest({ model: 'claude-sonnet-5', system: 'S', tools: [], messages: [] })
  assert.equal(s.body.fallbacks, undefined)
  assert.deepEqual(s.betas, ['compact-2026-01-12'])
})

test('the loop: read, edit, commit with approval, open PR, check CI, finish', async (t) => {
  const s = await setup([
    { text: 'Let me look.', tool: 'read_file', input: { path: 'README.md', start_line: 0, end_line: 0 } },
    { tool: 'edit_file', input: { path: 'README.md', old_string: '# proj', new_string: '# proj\n\nRuns on a phone.', replace_all: false } },
    { tool: 'commit', input: { message: 'Add tagline', branch: 'clode/tagline' } },
    { tool: 'open_pull_request', input: { title: 'Add tagline', body: 'From my phone.', base: '', draft: false } },
    { tool: 'ci_status', input: {} },
    { text: 'Done: added a tagline to README.md on clode/tagline and opened PR #1. CI is green.' },
  ], { runs: [{ id: 7, name: 'test', status: 'completed', conclusion: 'success', head_sha: '*', jobs: [{ id: 70, name: 'unit', status: 'completed', conclusion: 'success', steps: [] }] }] })
  t.after(s.close)
  const r = await s.agent.run('Add a tagline to the README')
  assert.equal(r.stop, 'end_turn')
  // history is valid: user, assistant(tool_use), user(tool_result), ... assistant(text)
  const roles = s.agent.messages.map((m) => m.role)
  assert.equal(roles[0], 'user')
  for (let i = 1; i < roles.length; i++) assert.notEqual(roles[i], roles[i - 1], 'roles alternate')
  const firstAssistant = s.agent.messages[1].content
  assert.equal(firstAssistant[0].type, 'thinking', 'thinking block echoed back unchanged')
  assert.equal(firstAssistant[0].signature, 'sig_abc')
  // the second request carried the thinking block and the tool result
  const req2 = s.llm.requests[1].body
  assert.equal(req2.messages[1].content[0].type, 'thinking')
  assert.equal(req2.messages[2].content[0].type, 'tool_result')
  assert.match(req2.messages[2].content[0].content, /1\| # proj/)
  assert.equal(s.llm.requests[0].headers['anthropic-dangerous-direct-browser-access'], 'true')
  assert.match(s.llm.requests[0].headers['anthropic-beta'], /server-side-fallback-2026-07-01/)
  // side effects on GitHub
  assert.equal(s.gh.fileAt('clode/tagline', 'README.md'), '# proj\n\nRuns on a phone.\n')
  assert.equal(s.gh.fileAt('main', 'README.md'), '# proj\n')
  assert.equal(s.gh.pulls.length, 1)
  assert.equal(s.gh.pulls[0].head, 'clode/tagline')
  assert.equal(s.gh.pulls[0].base, 'main')
  const ci = s.agent.messages.find((m) => m.role === 'user' && Array.isArray(m.content) && /job unit/.test(m.content[0].content))
  assert.ok(ci, 'ci_status result present')
  const kinds = s.events.map((e) => e.type)
  assert.ok(kinds.includes('commit') && kinds.includes('pull_request') && kinds.includes('changes'))
  assert.ok(s.agent.usage.input_tokens > 0)
  assert.ok(costOf(s.agent.usage, 'claude-opus-5') > 0)
})

test('denied approval becomes an error tool result and the loop continues', async (t) => {
  const s = await setup([
    { tool: 'write_file', input: { path: 'x.txt', content: 'x' } },
    { tool: 'commit', input: { message: 'x', branch: '' } },
    { text: 'Understood, not committing.' },
  ])
  t.after(s.close)
  s.agent.hooks.approve = async () => 'reject'
  const r = await s.agent.run('write x')
  assert.equal(r.stop, 'end_turn')
  const denied = s.agent.messages[4].content[0]
  assert.equal(denied.is_error, true)
  assert.match(denied.content, /denied/)
  assert.equal(s.gh.refs.size, 1, 'nothing committed')
  assert.equal(s.ws.changes.length, 1, 'staged change kept')
})

test('ask_user, run_js and always-allow', async (t) => {
  const s = await setup([
    { tool: 'ask_user', input: { question: 'Which colour?', options: ['red', 'blue'] } },
    { tool: 'run_js', input: { code: 'console.log("hi"); 6*7' } },
    { tool: 'write_file', input: { path: 'c.txt', content: 'blue' } },
    { tool: 'commit', input: { message: 'c', branch: '' } },
    { tool: 'write_file', input: { path: 'd.txt', content: 'd' } },
    { tool: 'commit', input: { message: 'd', branch: '' } },
    { text: 'ok' },
  ])
  t.after(s.close)
  let approvals = 0
  s.agent.hooks.approve = async () => { approvals++; return 'always' }
  await s.agent.run('go')
  const results = s.agent.messages.filter((m) => m.role === 'user' && Array.isArray(m.content)).map((m) => m.content[0].content)
  assert.match(results[0], /User answered: blue/)
  assert.match(results[1], /console:\nhi\nresult: 42/)
  assert.equal(approvals, 1, 'second commit did not ask again')
  assert.equal(s.gh.fileAt('main', 'd.txt'), 'd')
})

test('refusal stops cleanly; API errors surface with type; 429 is retried', async (t) => {
  const s = await setup([{ refusal: true }])
  t.after(s.close)
  const r = await s.agent.run('x')
  assert.equal(r.stop, 'refusal')
  assert.equal(r.details.category, 'cyber')
  const bad = await startFakeAnthropic({ script: [{ status: 400, type: 'invalid_request_error', message: 'max_tokens too large' }] })
  t.after(() => bad.close())
  await assert.rejects(() => streamTurn({ apiKey: 'sk-test', baseUrl: bad.url, request: { model: 'm', messages: [] } }), (e) => e instanceof LLMError && e.status === 400 && /max_tokens/.test(e.message))
  const flaky = await startFakeAnthropic({ script: [{ status: 429, type: 'rate_limit_error', message: 'slow down', retryAfter: 0 }, { text: 'after retry' }] })
  t.after(() => flaky.close())
  const res = await streamTurn({ apiKey: 'sk-test', baseUrl: flaky.url, request: { model: 'm', messages: [] } })
  assert.equal(res.content[0].text.trim(), 'after retry')
  assert.equal(flaky.requests.length, 2)
})

test('abort mid-run leaves a valid history', async (t) => {
  const s = await setup([{ tool: 'read_file', input: { path: 'README.md', start_line: 0, end_line: 0 } }, { tool: 'read_file', input: { path: 'README.md', start_line: 0, end_line: 0 } }, { text: 'done' }])
  t.after(s.close)
  s.agent.hooks.onEvent = (e) => { if (e.type === 'tool_start') s.agent.abort() }
  const r = await s.agent.run('x')
  assert.equal(r.stop, 'aborted')
  const last = s.agent.messages.at(-1)
  assert.equal(last.role, 'user')
  assert.equal(last.content[0].type, 'tool_result')
})
