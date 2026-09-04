// clode: the agent loop and its tools. The model plans; the phone executes against a GitHub workspace.
// Environment-agnostic: no DOM. The UI supplies callbacks for approval, questions and rendering.

import { buildRequest, streamTurn, estimateTokens, modelInfo } from './llm.js'

export const SYSTEM_PROMPT = `You are clode, a software engineering agent that runs entirely on the user's phone. You work on a GitHub repository through tools: the repository is the filesystem, edits are staged locally, and a commit publishes them to a branch. There is no shell. Code runs only in GitHub Actions after a commit, or as small JavaScript snippets in run_js.

How to work:
- Start by understanding the task and the relevant code: list_files, search, read_file. Read before you edit. Keep exploration proportional to the task.
- Make edits with edit_file (exact string replacement) or write_file (whole file). Keep changes minimal and in the existing style. Do not reformat or tidy code you were not asked to touch.
- Stage everything, then commit once with a clear message; commit needs the user's approval. Use a feature branch unless the user says otherwise. Open a pull request when the change is ready for review.
- After committing, use ci_status to see whether the repository's CI passed. If it failed, read the failure, fix it, and commit again. Do not declare success while CI is red.
- When the task is ambiguous in a way that changes the work, use ask_user with concrete options rather than guessing. Otherwise decide and proceed.
- The user is on a phone: keep visible messages short and concrete. Say what you changed and where, and what is still uncertain. No long preambles.
- If something is impossible from a phone (needs a local build, a secret you do not have, a tool that does not exist), say so plainly and stop.`

/** JSON-schema tool definitions (strict). */
export const TOOLS = [
  tool('list_files', 'List files in the repository, optionally under a path and matching a glob (e.g. "**/*.test.js").', { path: str('Directory prefix, e.g. "src". Empty for the whole repo.'), glob: str('Glob pattern such as "*.py" or "src/**/*.ts". Empty for all.') }, []),
  tool('read_file', 'Read a file. Returns numbered lines. Use start_line/end_line for large files.', { path: str('File path'), start_line: int('First line (1-based). 0 for the start.'), end_line: int('Last line (inclusive). 0 for the end.') }, ['path']),
  tool('search', 'Search file contents (case-insensitive). Returns path:line matches.', { pattern: str('Text or regular expression to find'), path: str('Restrict to this directory prefix. Empty for all.'), regex: bool('Treat pattern as a regular expression') }, ['pattern']),
  tool('write_file', 'Create or fully overwrite a file with the given content (staged until commit).', { path: str('File path'), content: str('Complete file content') }, ['path', 'content']),
  tool('edit_file', 'Replace an exact string in a file with another (staged until commit). old_string must match exactly once unless replace_all.', { path: str('File path'), old_string: str('Exact text to replace, with enough context to be unique'), new_string: str('Replacement text'), replace_all: bool('Replace every occurrence') }, ['path', 'old_string', 'new_string']),
  tool('delete_file', 'Delete a file (staged until commit).', { path: str('File path') }, ['path']),
  tool('commit', 'Commit all staged changes to a branch on GitHub. Requires user approval. Creates the branch if it does not exist.', { message: str('Commit message: a short summary line, optionally a blank line and details'), branch: str('Branch to commit to. Empty for the current branch.') }, ['message']),
  tool('open_pull_request', 'Open a pull request from the current branch. Requires user approval.', { title: str('PR title'), body: str('PR description in Markdown'), base: str('Base branch. Empty for the repository default.'), draft: bool('Open as a draft') }, ['title', 'body']),
  tool('ci_status', 'Check GitHub Actions results for the latest commit on the current branch: runs, jobs, failed steps, and failure logs when available.', {}, []),
  tool('run_js', 'Run a JavaScript snippet in a sandboxed worker (no network, no filesystem, 10 s limit). Use for quick checks and calculations. console.log output and the returned value are captured.', { code: str('JavaScript source. The value of the last expression, or a returned value, is reported.') }, ['code']),
  tool('ask_user', 'Ask the user a question and wait for the answer. Use only when the answer changes the work.', { question: str('The question'), options: { type: 'array', items: { type: 'string' }, description: 'Optional short choices. The user can always type a free answer.' } }, ['question']),
]
function tool(name, description, props, required) {
  return { name, description, strict: true, input_schema: { type: 'object', properties: props, required: Object.keys(props), additionalProperties: false }, _optional: Object.keys(props).filter((k) => !required.includes(k)) }
}
function str(description) { return { type: 'string', description } }
function int(description) { return { type: 'integer', description } }
function bool(description) { return { type: 'boolean', description } }
/** Strict mode requires every property in `required`; we strip the private field before sending. */
export function toolDefs() { return TOOLS.map(({ _optional, ...t }) => t) }

export const APPROVAL_TOOLS = new Set(['commit', 'open_pull_request'])

/**
 * Agent session. Persist `messages` and `usage`; everything else is rebuilt.
 * hooks: { onEvent(evt), approve({tool, input}) -> 'once'|'always'|'reject', ask({question, options}) -> string, runJs(code) -> {logs, result, error}, fetch }
 */
export class Agent {
  constructor({ workspace, apiKey, baseUrl, model, effort = 'high', messages = [], hooks = {}, maxTurns = 60 }) {
    this.ws = workspace
    this.apiKey = apiKey; this.baseUrl = baseUrl; this.model = model; this.effort = effort
    this.messages = messages
    this.hooks = hooks
    this.maxTurns = maxTurns
    this.usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    this.alwaysAllow = new Set()
    this.controller = null
    this.running = false
  }
  emit(evt) { try { this.hooks.onEvent?.(evt) } catch {} }
  abort() { this.controller?.abort() }

  system() {
    const ws = this.ws
    const files = ws.tree.size
    const staged = ws.changes.length
    return `${SYSTEM_PROMPT}\n\nRepository: ${ws.owner}/${ws.repo}, branch ${ws.branch} (${files} files${ws.truncated ? ', listing truncated by GitHub' : ''}). Head commit ${ws.headSha?.slice(0, 7)}.${staged ? ` ${staged} file(s) currently staged and uncommitted.` : ''}`
  }

  /** Send a user message and run until the model stops. */
  async run(userText) {
    if (this.running) throw new Error('already running')
    this.running = true
    this.controller = new AbortController()
    this.messages.push({ role: 'user', content: userText })
    this.emit({ type: 'user', text: userText })
    try {
      for (let turn = 0; turn < this.maxTurns; turn++) {
        const { body, betas } = buildRequest({ model: this.model, system: this.system(), tools: toolDefs(), messages: this.messages, effort: this.effort })
        this.emit({ type: 'turn_start', turn, tokens: estimateTokens(this.messages) })
        const res = await streamTurn({ apiKey: this.apiKey, baseUrl: this.baseUrl, request: body, betas, signal: this.controller.signal, fetch: this.hooks.fetch, onEvent: (e) => this.emit({ type: 'stream', ...e }) })
        for (const k of Object.keys(this.usage)) this.usage[k] += res.usage[k] || 0
        this.emit({ type: 'usage', usage: this.usage, turnUsage: res.usage, model: res.model })
        // Echo the full content back (thinking blocks included) so the next turn continues the same reasoning.
        this.messages.push({ role: 'assistant', content: res.content })
        this.emit({ type: 'assistant', content: res.content, stop_reason: res.stop_reason })
        if (res.stop_reason === 'refusal') { this.emit({ type: 'refusal', details: res.stop_details }); return { stop: 'refusal', details: res.stop_details } }
        if (res.stop_reason === 'max_tokens') { this.messages.push({ role: 'user', content: 'You hit the output limit. Continue from where you stopped; do not repeat what you already wrote.' }); continue }
        if (res.stop_reason === 'pause_turn') continue
        const uses = res.content.filter((b) => b.type === 'tool_use')
        if (res.stop_reason !== 'tool_use' || uses.length === 0) return { stop: res.stop_reason || 'end_turn' }
        const results = []
        for (const u of uses) {
          const r = await this.runTool(u)
          results.push({ type: 'tool_result', tool_use_id: u.id, content: r.content, is_error: !!r.is_error })
        }
        this.messages.push({ role: 'user', content: results })
        if (this.controller.signal.aborted) return { stop: 'aborted' }
      }
      return { stop: 'max_turns' }
    } catch (e) {
      if (this.controller.signal.aborted) { this.repairHistory(); return { stop: 'aborted' } }
      this.repairHistory()
      throw e
    } finally { this.running = false }
  }

  /** If we stopped between an assistant tool_use and its results, add error results so the history stays valid. */
  repairHistory() {
    const last = this.messages[this.messages.length - 1]
    if (last?.role === 'assistant' && Array.isArray(last.content)) {
      const uses = last.content.filter((b) => b.type === 'tool_use')
      if (uses.length) this.messages.push({ role: 'user', content: uses.map((u) => ({ type: 'tool_result', tool_use_id: u.id, content: 'Interrupted by the user before this tool ran.', is_error: true })) })
    }
  }

  async runTool(use) {
    const name = use.name, input = use.input || {}
    this.emit({ type: 'tool_start', id: use.id, name, input })
    let out
    try {
      if (APPROVAL_TOOLS.has(name) && !this.alwaysAllow.has(name)) {
        const decision = await this.hooks.approve?.({ tool: name, input, id: use.id })
        if (decision === 'always') this.alwaysAllow.add(name)
        else if (decision !== 'once') { out = { content: 'The user denied this action. Ask what they would like instead, or continue with other work.', is_error: true }; this.emit({ type: 'tool_end', id: use.id, name, ...out, denied: true }); return out }
      }
      out = { content: await this.exec(name, input) }
    } catch (e) {
      out = { content: `Error: ${e.message}`, is_error: true }
    }
    if (typeof out.content !== 'string') out.content = JSON.stringify(out.content, null, 1)
    if (out.content.length > 60_000) out.content = out.content.slice(0, 60_000) + `\n… truncated (${out.content.length} chars)`
    this.emit({ type: 'tool_end', id: use.id, name, ...out })
    return out
  }

  async exec(name, input) {
    const ws = this.ws
    switch (name) {
      case 'list_files': {
        const files = ws.listFiles({ path: input.path || '', glob: input.glob || '' })
        if (files.length === 0) return 'No files match.'
        const shown = files.slice(0, 500)
        return shown.join('\n') + (files.length > shown.length ? `\n… ${files.length - shown.length} more; narrow with path or glob` : '')
      }
      case 'read_file': {
        const text = await ws.readFile(input.path)
        const lines = text.split('\n')
        const start = Math.max(1, input.start_line || 1), end = Math.min(lines.length, input.end_line || lines.length)
        const cap = 1500
        const slice = lines.slice(start - 1, Math.min(end, start - 1 + cap))
        const numbered = slice.map((l, i) => `${String(start + i).padStart(5)}| ${l}`).join('\n')
        return numbered + (end - start + 1 > cap ? `\n… ${lines.length} lines total; read the rest with start_line=${start + cap}` : '')
      }
      case 'search': {
        const r = await ws.search(input.pattern, { path: input.path || '', regex: !!input.regex })
        if (r.matches.length === 0) return `No matches (${r.scanned} files scanned${r.skipped ? `, ${r.skipped} skipped as large or binary` : ''}).`
        return r.matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join('\n') + (r.truncated ? '\n… more matches; narrow the search' : '') + (r.skipped ? `\n(${r.skipped} files skipped as large or binary)` : '')
      }
      case 'write_file': { const r = await ws.writeFile(input.path, input.content); this.emit({ type: 'changes', changes: ws.changes }); return r.unchanged ? `${r.path} is unchanged.` : `${r.created ? 'Created' : 'Updated'} ${r.path} (staged).` }
      case 'edit_file': { const r = await ws.editFile(input.path, input.old_string, input.new_string, { replaceAll: !!input.replace_all }); this.emit({ type: 'changes', changes: ws.changes }); return `Edited ${r.path}: ${r.replacements} replacement(s) (staged).` }
      case 'delete_file': { const r = await ws.deleteFile(input.path); this.emit({ type: 'changes', changes: ws.changes }); return `Deleted ${r.path} (staged).` }
      case 'commit': {
        const r = await ws.commit(input.message, { branch: input.branch || undefined })
        this.emit({ type: 'changes', changes: ws.changes }); this.emit({ type: 'commit', ...r })
        return `Committed ${r.sha.slice(0, 7)} to ${r.branch}: ${r.files.length} file(s).${r.url ? ` ${r.url}` : ''}`
      }
      case 'open_pull_request': {
        let base = input.base
        if (!base) { const repo = await ws.gh.repo(ws.owner, ws.repo); base = repo.default_branch }
        if (base === ws.branch) throw new Error(`Current branch ${ws.branch} is the base branch; commit to a feature branch first.`)
        const pr = await ws.gh.createPull(ws.owner, ws.repo, { title: input.title, body: input.body, head: ws.branch, base, draft: !!input.draft })
        this.emit({ type: 'pull_request', number: pr.number, url: pr.html_url })
        return `Opened pull request #${pr.number}: ${pr.html_url}`
      }
      case 'ci_status': return this.ciStatus()
      case 'run_js': {
        const r = await (this.hooks.runJs || runJsNode)(input.code)
        return [r.logs?.length ? `console:\n${r.logs.join('\n')}` : '', r.error ? `error: ${r.error}` : `result: ${typeof r.result === 'string' ? r.result : JSON.stringify(r.result)}`].filter(Boolean).join('\n')
      }
      case 'ask_user': {
        const answer = await this.hooks.ask?.({ question: input.question, options: input.options || [] })
        if (answer === undefined || answer === null) return 'The user did not answer.'
        return `User answered: ${answer}`
      }
      default: throw new Error(`Unknown tool ${name}`)
    }
  }

  async ciStatus() {
    const ws = this.ws
    const sha = ws.headSha
    const runs = await ws.gh.runsFor(ws.owner, ws.repo, sha)
    const list = runs.workflow_runs || []
    if (list.length === 0) return `No GitHub Actions runs for ${sha.slice(0, 7)} yet. Either the repository has no workflows for this branch, or the run has not started; check again in a minute.`
    const out = []
    for (const run of list) {
      out.push(`${run.name}: ${run.status}${run.conclusion ? ' / ' + run.conclusion : ''} ${run.html_url}`)
      const jobs = (await ws.gh.jobs(ws.owner, ws.repo, run.id)).jobs || []
      for (const j of jobs) {
        out.push(`  job ${j.name}: ${j.status}${j.conclusion ? ' / ' + j.conclusion : ''}`)
        if (j.conclusion === 'failure') {
          for (const s of j.steps || []) if (s.conclusion === 'failure') out.push(`    failed step: ${s.name}`)
          try {
            const log = await ws.gh.jobLogs(ws.owner, ws.repo, j.id)
            const tail = log.split('\n').filter((l) => l.trim()).slice(-80).join('\n')
            out.push(`    log tail:\n${tail.replace(/^/gm, '      ')}`)
          } catch { out.push('    (log not readable from the phone; open the run URL for details)') }
        }
      }
    }
    return out.join('\n')
  }
}

/** Node fallback for run_js used in tests; the browser uses a Worker. */
export async function runJsNode(code) {
  const logs = []
  try {
    const { runInNewContext } = await import('node:vm')
    // Completion value of the last statement, like a REPL.
    const result = runInNewContext(code, { console: { log: (...a) => logs.push(a.map(String).join(' ')) } }, { timeout: 10_000 })
    return { logs, result }
  } catch (e) { return { logs, error: e.message } }
}
