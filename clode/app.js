// clode UI. Vanilla JS, no build step. Screens: setup, sessions, repos, session, settings.
import { Agent, APPROVAL_TOOLS } from './agent.js'
import { GitHub, Workspace } from './github.js'
import { MODELS, DEFAULT_MODEL, EFFORTS, costOf, modelInfo } from './llm.js'
import { sessions as sessionStore, blobCache, settings } from './store.js'

const $ = (sel, el = document) => el.querySelector(sel)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const VERSION = '0.1.0'

const S = {
  route: parseRoute(),
  view: null,
  keys: { anthropic: settings.get('anthropicKey', ''), github: settings.get('githubToken', '') },
  prefs: { model: settings.get('model', DEFAULT_MODEL), effort: settings.get('effort', 'xhigh'), anthropicUrl: settings.get('anthropicUrl', 'https://api.anthropic.com'), githubUrl: settings.get('githubUrl', 'https://api.github.com'), autoCommit: settings.get('autoCommit', false) },
  gh: null,
  sessionList: [],
  cur: null, // { row, ws, agent, live: { blocks }, pending: null (approval|question), wakeLock }
  sheet: null,
}
const configured = () => !!(S.keys.anthropic && S.keys.github)
function gh() { if (!S.gh || S.gh.token !== S.keys.github || S.gh.baseUrl !== S.prefs.githubUrl.replace(/\/+$/, '')) S.gh = new GitHub({ token: S.keys.github, baseUrl: S.prefs.githubUrl }); return S.gh }

// ---------- routing ----------
function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '')
  if (h.startsWith('s/')) return { name: 'session', id: h.slice(2) }
  if (h === 'repos') return { name: 'repos' }
  if (h === 'settings') return { name: 'settings' }
  if (h === 'setup') return { name: 'setup' }
  return { name: 'sessions' }
}
const go = (h) => { location.hash = h }
window.addEventListener('hashchange', () => { S.route = parseRoute(); render() })

// ---------- render ----------
async function render() {
  const app = $('#app')
  if (!configured() && S.route.name !== 'setup') { history.replaceState(null, '', '#setup'); S.route = { name: 'setup' } }
  const r = S.route
  if (r.name === 'session') {
    if (S.view !== 'session:' + r.id) { S.view = 'session:' + r.id; app.innerHTML = sessionShell(); bindSession(); await openSession(r.id) }
    renderSessionRegions(); return
  }
  if (S.view?.startsWith('session:')) closeSession()
  S.view = r.name
  const titles = { sessions: 'clode', repos: 'Choose a repository', settings: 'Settings', setup: 'Welcome to clode' }
  app.innerHTML = `<header class="top">${r.name === 'sessions' ? `<span class="brand"><img src="icon.svg" alt=""></span>` : `<button class="iconbtn" id="back" aria-label="Back">‹</button>`}<h1 id="title">${esc(titles[r.name])}</h1>${r.name === 'sessions' ? `<button class="iconbtn" id="settingsbtn" aria-label="Settings">⚙</button>` : ''}</header><main class="main" id="main"></main>`
  $('#back')?.addEventListener('click', () => (history.length > 1 ? history.back() : go('sessions')))
  $('#settingsbtn')?.addEventListener('click', () => go('settings'))
  if (r.name === 'setup' || r.name === 'settings') { $('#main').innerHTML = settingsView(r.name === 'setup'); bindSettings(r.name === 'setup') }
  else if (r.name === 'sessions') { $('#main').innerHTML = `<div class="empty">Loading…</div>`; await renderSessions() }
  else if (r.name === 'repos') { $('#main').innerHTML = `<div class="empty">Loading your repositories…</div>`; await renderRepos() }
}

// ---------- settings / setup ----------
function settingsView(first) {
  return `
    ${first ? `<div class="card"><div class="title">A coding agent that lives on this phone.</div><div class="desc">clode talks to Claude and to GitHub directly from here. Your keys stay on this device. Nothing runs on anyone else's server.</div></div>` : ''}
    <div class="form">
      <label>Anthropic API key</label><input type="password" id="k-anthropic" value="${esc(S.keys.anthropic)}" placeholder="sk-ant-…" autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="help">Create one at <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a>. You pay Anthropic directly for what the agent uses; clode shows the running cost.</div>
      <label>GitHub token</label><input type="password" id="k-github" value="${esc(S.keys.github)}" placeholder="github_pat_…" autocomplete="off" autocapitalize="off" spellcheck="false">
      <div class="help">A fine-grained token from <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens</a> with repository permissions: Contents (read and write), Pull requests (read and write), Actions (read), Metadata (read). Pick only the repositories you want the agent to touch.</div>
      <label>Model</label><select id="p-model">${MODELS.map((m) => `<option value="${m.id}" ${S.prefs.model === m.id ? 'selected' : ''}>${esc(m.name)} · $${m.input}/$${m.output} per 1M tokens</option>`).join('')}</select>
      <label>Effort</label><select id="p-effort">${EFFORTS.map((e) => `<option value="${e}" ${S.prefs.effort === e ? 'selected' : ''}>${e}</option>`).join('')}</select>
      <div class="help">xhigh is the best setting for coding. low is fine for small edits and costs much less.</div>
      <label><input type="checkbox" id="p-auto" ${S.prefs.autoCommit ? 'checked' : ''}> Commit and open pull requests without asking</label>
      <details class="adv"><summary>Advanced</summary>
        <label>Anthropic API base URL</label><input type="text" id="p-aurl" value="${esc(S.prefs.anthropicUrl)}">
        <label>GitHub API base URL</label><input type="text" id="p-gurl" value="${esc(S.prefs.githubUrl)}">
      </details>
      <div class="row"><button class="btn primary" id="save">${first ? 'Start' : 'Save'}</button>${first ? '' : `<button class="btn danger" id="forget">Forget keys</button>`}</div>
      ${first ? '' : `<div class="row"><button class="btn ghost" id="clearcache">Clear file cache</button></div>`}
      <p class="small" style="margin-top:18px">clode ${VERSION} · <a href="https://github.com/anchosauve-ops/Cladia/tree/main/clode" target="_blank" rel="noopener">source</a> · keys are stored in this browser's local storage and sent only to api.anthropic.com and api.github.com.</p>
    </div>`
}
function bindSettings(first) {
  $('#save').onclick = async () => {
    const a = $('#k-anthropic').value.trim(), g = $('#k-github').value.trim()
    if (!a || !g) return toast('Both keys are needed.')
    S.keys = { anthropic: a, github: g }; settings.set('anthropicKey', a); settings.set('githubToken', g)
    S.prefs.model = $('#p-model').value; S.prefs.effort = $('#p-effort').value; S.prefs.autoCommit = $('#p-auto').checked
    S.prefs.anthropicUrl = $('#p-aurl').value.trim() || 'https://api.anthropic.com'; S.prefs.githubUrl = $('#p-gurl').value.trim() || 'https://api.github.com'
    for (const k of ['model', 'effort', 'autoCommit', 'anthropicUrl', 'githubUrl']) settings.set(k, S.prefs[k])
    S.gh = null
    try { const me = await gh().me(); toast(`GitHub: signed in as ${me.login}`) } catch (e) { return toast(`GitHub token check failed: ${e.message}`) }
    go(first ? 'repos' : 'sessions')
  }
  $('#forget')?.addEventListener('click', () => { if (confirm('Forget both keys on this device?')) { S.keys = { anthropic: '', github: '' }; settings.del('anthropicKey'); settings.del('githubToken'); go('setup') } })
  $('#clearcache')?.addEventListener('click', async () => { await blobCache.clear(); toast('File cache cleared') })
}

// ---------- sessions list ----------
async function renderSessions() {
  S.sessionList = await sessionStore.all()
  const main = $('#main'); if (!main || S.view !== 'sessions') return
  if (S.sessionList.length === 0) main.innerHTML = `<div class="empty"><div class="big">☺</div>No sessions yet.<div class="small" style="margin-top:6px">Pick a repository and tell the agent what to do.</div></div>`
  else main.innerHTML = `<div class="list">${S.sessionList.map((s) => `<div class="card tap item" data-open="${esc(s.id)}"><div class="body"><div class="title">${esc(s.title || 'New session')}</div><div class="meta"><span>${esc(s.owner)}/${esc(s.repo)}</span><span>${esc(s.branch)}</span><span>${ago(s.updatedAt)}</span>${s.usage?.output_tokens ? `<span>$${costOf(s.usage, s.model).toFixed(2)}</span>` : ''}${s.overlay?.length ? `<span class="add">${s.overlay.length} staged</span>` : ''}</div></div></div>`).join('')}</div>`
  main.insertAdjacentHTML('beforeend', `<button class="fab" id="new" aria-label="New session">＋</button>`)
  for (const el of main.querySelectorAll('[data-open]')) el.onclick = () => go('s/' + el.dataset.open)
  $('#new').onclick = () => go('repos')
}

// ---------- repos ----------
async function renderRepos() {
  let repos
  try { repos = await gh().repos() } catch (e) { $('#main').innerHTML = `<div class="empty">${esc(e.message)}<div class="row"><button class="btn" onclick="location.hash='settings'">Check the GitHub token</button></div></div>`; return }
  const main = $('#main'); if (!main || S.view !== 'repos') return
  const draw = (filter = '') => {
    const list = repos.filter((r) => r.full_name.toLowerCase().includes(filter.toLowerCase()))
    $('#repolist').innerHTML = list.map((r) => `<div class="card tap item" data-repo="${esc(r.full_name)}" data-default="${esc(r.default_branch)}"><div class="body"><div class="title">${esc(r.full_name)}</div><div class="meta"><span>${r.private ? 'private' : 'public'}</span><span>${esc(r.default_branch)}</span><span>${ago(Date.parse(r.pushed_at))}</span></div></div></div>`).join('') || `<div class="empty">No repositories match. The token only sees the repositories you granted it.</div>`
    for (const el of $('#repolist').querySelectorAll('[data-repo]')) el.onclick = () => pickBranch(el.dataset.repo, el.dataset.default)
  }
  main.innerHTML = `<div class="form"><input type="text" id="filter" placeholder="Filter repositories" autocomplete="off"></div><div class="list" id="repolist" style="margin-top:10px"></div>`
  $('#filter').oninput = (e) => draw(e.target.value)
  draw()
}
async function pickBranch(fullName, def) {
  const [owner, repo] = fullName.split('/')
  let branches = []
  try { branches = await gh().branches(owner, repo) } catch (e) { return toast(e.message) }
  openSheet(`<div class="hd">${esc(fullName)}<button class="iconbtn x" data-x>✕</button></div><div class="bd"><div class="form" style="padding:0 16px 12px"><label>Work on branch</label><select id="br">${branches.map((b) => `<option value="${esc(b.name)}" ${b.name === def ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select><div class="help">The agent stages edits locally and commits when you approve. It will suggest a feature branch for the commit; the default branch stays untouched unless you say otherwise.</div><div class="row"><button class="btn primary" id="start">Start session</button></div></div></div>`)
  $('#start').onclick = async () => {
    const branch = $('#br').value
    const row = { id: 'ses_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), owner, repo, branch, title: '', createdAt: Date.now(), updatedAt: Date.now(), messages: [], usage: null, model: S.prefs.model, effort: S.prefs.effort, overlay: [] }
    await sessionStore.put(row)
    closeSheet(); go('s/' + row.id)
  }
}

// ---------- session ----------
function sessionShell() {
  return `<header class="top"><button class="iconbtn" id="back" aria-label="Back">‹</button><span class="dot" id="dot"></span><h1><span id="stitle">Session</span><span class="sub" id="ssub"></span></h1><button class="iconbtn" id="changes" aria-label="Changes">±<span class="n" id="nchanges" hidden></span></button></header>
  <main class="main" id="main"><div class="msgs" id="msgs"></div><div id="live"></div><div id="pending"></div></main>
  <div class="composer"><div class="in"><textarea id="ta" rows="1" placeholder="What should I do in this repo?" enterkeyhint="enter"></textarea><button class="send" id="send" aria-label="Send">➤</button></div><div class="hint"><span id="cost"></span><span>Enter for a new line · ⌘/Ctrl+Enter to send</span></div></div>`
}
function bindSession() {
  $('#back').onclick = () => go('sessions')
  $('#changes').onclick = () => openChanges()
  const ta = $('#ta')
  ta.oninput = () => { ta.style.height = 'auto'; ta.style.height = Math.min(160, ta.scrollHeight) + 'px' }
  ta.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendOrStop() } }
  $('#send').onclick = sendOrStop
}
async function openSession(id) {
  const row = await sessionStore.get(id)
  if (!row) { toast('Session not found'); go('sessions'); return }
  S.cur = { row, ws: null, agent: null, live: null, pending: null, error: null, loading: true }
  renderSessionRegions()
  try {
    const ws = new Workspace(gh(), { owner: row.owner, repo: row.repo, branch: row.branch, cache: blobCache })
    await ws.load()
    for (const c of row.overlay || []) ws.overlay.set(c.path, c.deleted ? { deleted: true } : { content: c.content })
    const agent = new Agent({ workspace: ws, apiKey: S.keys.anthropic, baseUrl: S.prefs.anthropicUrl, model: row.model || S.prefs.model, effort: row.effort || S.prefs.effort, messages: row.messages || [], hooks: { onEvent: onAgentEvent, approve: askApproval, ask: askQuestion, runJs: runJsInWorker } })
    if (row.usage) agent.usage = { ...agent.usage, ...row.usage }
    if (S.prefs.autoCommit) for (const t of APPROVAL_TOOLS) agent.alwaysAllow.add(t)
    if (S.cur?.row.id !== id) return
    S.cur.ws = ws; S.cur.agent = agent; S.cur.loading = false
    // a turn that was cut off (phone locked) may have left tool calls unanswered
    agent.repairHistory()
  } catch (e) { S.cur.loading = false; S.cur.error = e.message }
  renderSessionRegions()
}
function closeSession() { S.cur?.agent?.abort(); releaseWakeLock(); S.cur = null }
async function persist() {
  const c = S.cur; if (!c) return
  const row = c.row
  row.messages = c.agent?.messages || row.messages
  row.usage = c.agent?.usage || row.usage
  row.overlay = c.ws ? [...c.ws.overlay].map(([path, v]) => (v.deleted ? { path, deleted: true } : { path, content: v.content })) : row.overlay
  row.branch = c.ws?.branch || row.branch
  row.updatedAt = Date.now()
  if (!row.title) { const first = row.messages.find((m) => m.role === 'user' && typeof m.content === 'string'); if (first) row.title = first.content.slice(0, 80) }
  try { await sessionStore.put(row) } catch (e) { console.warn('persist failed', e) }
}
function renderSessionRegions() {
  const c = S.cur; if (!c || !$('#stitle')) return
  $('#stitle').textContent = `${c.row.owner}/${c.row.repo}`
  const running = !!c.agent?.running
  $('#ssub').textContent = [c.ws?.branch || c.row.branch, c.loading ? 'loading repository…' : running ? 'working…' : c.error ? 'error' : `${c.ws?.tree.size ?? 0} files`].join(' · ')
  $('#dot').className = 'dot ' + (running ? 'run' : c.error ? 'bad' : c.ws ? 'ok' : '')
  const n = c.ws?.changes.length || 0
  const badge = $('#nchanges'); badge.hidden = n === 0; badge.textContent = n
  const send = $('#send'); send.className = 'send' + (running ? ' stop' : ''); send.textContent = running ? '■' : '➤'
  const usage = c.agent?.usage || c.row.usage
  $('#cost').textContent = usage?.output_tokens ? `$${costOf(usage, c.agent?.model || c.row.model).toFixed(3)} · ${Math.round(((usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)) / 1000)}k in / ${Math.round(usage.output_tokens / 1000)}k out` : modelInfo(c.agent?.model || c.row.model).name
  renderMessages()
}
function renderMessages() {
  const c = S.cur; const box = $('#msgs'); if (!c || !box) return
  const main = $('#main'); const nearBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 140
  const msgs = c.agent?.messages || c.row.messages || []
  if (c.error) { box.innerHTML = `<div class="card"><div class="k"><span class="kind" style="color:var(--bad)">Could not open</span></div><div class="desc">${esc(c.error)}</div><div class="row"><button class="btn" onclick="location.reload()">Retry</button></div></div>`; return }
  if (msgs.length === 0 && !c.loading) { box.innerHTML = `<div class="empty"><div class="big">✎</div>Tell the agent what to change.<div class="small" style="margin-top:6px">It reads the repo, edits, asks before committing, and watches CI.</div></div>`; return }
  // map tool results by id for status rendering
  const results = new Map()
  for (const m of msgs) if (m.role === 'user' && Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_result') results.set(b.tool_use_id, b)
  box.innerHTML = msgs.map((m) => messageHtml(m, results)).join('')
  for (const t of box.querySelectorAll('.tool .hd')) t.onclick = () => { const bd = t.nextElementSibling; if (bd) bd.hidden = !bd.hidden }
  if (nearBottom) main.scrollTop = main.scrollHeight
}
function messageHtml(m, results) {
  if (m.role === 'user') {
    if (typeof m.content === 'string') return `<div class="msg user">${esc(m.content)}</div>`
    return '' // tool results are rendered inside their tool cards
  }
  if (m.role !== 'assistant') return ''
  const parts = (Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }]).map((b) => blockHtml(b, results)).filter(Boolean).join('')
  return `<div class="msg assistant">${parts}</div>`
}
function blockHtml(b, results, live = false) {
  if (b.type === 'text') return b.text?.trim() ? `<div class="md">${md(b.text)}</div>` : ''
  if (b.type === 'thinking') return b.thinking?.trim() ? `<details class="think"><summary>Thinking</summary><div class="bd">${esc(b.thinking)}</div></details>` : ''
  if (b.type === 'tool_use') {
    const r = results.get(b.id)
    const status = live ? 'running' : !r ? 'running' : r.is_error ? (/denied/.test(r.content) ? 'denied' : 'error') : 'done'
    const input = b.input || {}
    const summary = input.path || input.message || input.title || input.question || input.pattern || input.glob || (input.code ? input.code.slice(0, 60) : '') || ''
    let body = ''
    if (b.name === 'edit_file') body = `<div class="diff">${diffHtml(['--- ' + input.path, '+++ ' + input.path, ...String(input.old_string || '').split('\n').map((l) => '-' + l), ...String(input.new_string || '').split('\n').map((l) => '+' + l)].join('\n'))}</div>`
    else if (b.name === 'write_file') body = `<b>${esc(input.path)}</b>\n${esc(truncate(input.content, 4000))}`
    else if (Object.keys(input).length) body = `<b>input</b>\n${esc(truncate(JSON.stringify(input, null, 1), 3000))}`
    if (r) body += `\n<b>${r.is_error ? 'error' : 'result'}</b>\n${esc(truncate(r.content, 6000))}`
    return `<div class="tool"><div class="hd"><span class="name">${esc(b.name)}</span><span class="ttl">${esc(summary)}</span><span class="stt ${status}">${status}</span></div><div class="bd" hidden>${body || 'no details'}</div></div>`
  }
  if (b.type === 'compaction') return `<div class="small">— earlier context compacted —</div>`
  return ''
}
function truncate(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more)` : s }
function diffHtml(patch) { return String(patch).split('\n').map((l) => { const c = l.startsWith('+') && !l.startsWith('+++') ? 'a' : l.startsWith('-') && !l.startsWith('---') ? 'd' : l.startsWith('@@') ? 'h' : ''; return `<div class="l ${c}">${esc(l) || ' '}</div>` }).join('') }

// live streaming region
let liveQueued = false
function renderLive() {
  if (liveQueued) return; liveQueued = true
  requestAnimationFrame(() => {
    liveQueued = false
    const c = S.cur; const el = $('#live'); if (!c || !el) return
    if (!c.live) { el.innerHTML = ''; return }
    const main = $('#main'); const nearBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 140
    el.innerHTML = `<div class="msg assistant">${c.live.blocks.filter(Boolean).map((b) => blockHtml(b, new Map(), true)).join('')}${c.live.toolStatus ? `<div class="small">${esc(c.live.toolStatus)}</div>` : ''}</div>`
    if (nearBottom) main.scrollTop = main.scrollHeight
  })
}
function onAgentEvent(e) {
  const c = S.cur; if (!c) return
  switch (e.type) {
    case 'turn_start': c.live = { blocks: [], toolStatus: '' }; renderLive(); break
    case 'stream':
      if (!c.live) c.live = { blocks: [], toolStatus: '' }
      if (e.type === 'stream' && e.block !== undefined && e.index !== undefined && e.delta === undefined && e.partial === undefined) { c.live.blocks[e.index] = e.block }
      if (e.delta !== undefined && c.live.blocks[e.index]) { /* block object is shared with llm.js and already mutated */ }
      if (e.partial !== undefined && c.live.blocks[e.index]) c.live.blocks[e.index].input = safeParsePartial(e.partial)
      renderLive(); break
    case 'assistant': c.live = null; renderLive(); renderMessages(); persist(); break
    case 'tool_start': c.live = { blocks: [], toolStatus: `running ${e.name}…` }; renderLive(); break
    case 'tool_end': c.live = null; renderLive(); renderMessages(); persist(); break
    case 'changes': renderSessionRegions(); break
    case 'commit': toast(`Committed ${e.sha.slice(0, 7)} to ${e.branch}`); break
    case 'pull_request': toast(`Opened PR #${e.number}`); break
    case 'usage': renderSessionRegions(); break
    case 'refusal': toast(`The model declined this request (${e.details?.category || 'policy'}).`); break
  }
}
function safeParsePartial(s) { try { return JSON.parse(s) } catch { return { _partial: s.slice(-80) } } }

async function sendOrStop() {
  const c = S.cur; if (!c) return
  if (c.agent?.running) { c.agent.abort(); toast('Stopping…'); return }
  if (!c.agent) return toast(c.loading ? 'Still loading the repository.' : 'Session is not ready.')
  const ta = $('#ta'); const text = ta.value.trim(); if (!text) return
  ta.value = ''; ta.style.height = 'auto'
  await runAgent(text)
}
async function runAgent(text) {
  const c = S.cur
  await requestWakeLock()
  renderSessionRegions()
  try {
    const r = await c.agent.run(text)
    if (r.stop === 'max_turns') toast('Stopped after many steps. Say "continue" to keep going.')
  } catch (e) {
    toast(e.message)
    $('#pending').innerHTML = `<div class="card"><div class="k"><span class="kind" style="color:var(--bad)">Error</span></div><div class="desc">${esc(e.message)}</div><div class="row"><button class="btn" id="retry">Retry the last message</button></div></div>`
    $('#retry').onclick = () => { $('#pending').innerHTML = ''; const last = [...c.agent.messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string'); if (last) { c.agent.messages.splice(c.agent.messages.lastIndexOf(last), 1); runAgent(last.content) } }
  } finally { releaseWakeLock(); c.live = null; renderLive(); renderSessionRegions(); persist(); if (S.view?.startsWith('session:')) renderSessions() }
}

// approval and questions: rendered as cards under the transcript; the agent awaits the promise
function askApproval({ tool, input }) {
  return new Promise((resolve) => {
    const c = S.cur; if (!c) return resolve('reject')
    const title = tool === 'commit' ? `Commit to ${esc(input.branch || c.ws.branch)}` : `Open pull request${input.draft ? ' (draft)' : ''}`
    const detail = tool === 'commit' ? `<pre class="cmd">${esc(input.message)}</pre><div class="desc">${c.ws.changes.length} file(s): ${esc(c.ws.changes.map((x) => x.path).join(', '))}</div>` : `<pre class="cmd">${esc(input.title)}</pre><div class="desc">${esc(truncate(input.body, 600))}</div>`
    $('#pending').innerHTML = `<div class="card"><div class="k"><span class="kind">Approval</span></div><div class="title">${title}</div>${detail}<div class="row"><button class="btn danger" data-d="reject">Deny</button><button class="btn" data-d="always">Always</button><button class="btn primary" data-d="once">Allow</button></div><div class="row"><button class="btn ghost" id="viewdiff">View changes</button></div></div>`
    $('#viewdiff').onclick = () => openChanges({ readOnly: true })
    for (const b of $('#pending').querySelectorAll('[data-d]')) b.onclick = () => { $('#pending').innerHTML = ''; resolve(b.dataset.d) }
    $('#main').scrollTop = $('#main').scrollHeight
    if (navigator.vibrate) navigator.vibrate(30)
    notifyIfHidden('clode needs you', title)
  })
}
function askQuestion({ question, options }) {
  return new Promise((resolve) => {
    $('#pending').innerHTML = `<div class="card"><div class="k"><span class="kind" style="color:var(--info)">Question</span></div><div class="title">${esc(question)}</div>${(options || []).map((o) => `<div class="opt" data-o="${esc(o)}">${esc(o)}</div>`).join('')}<div class="form"><input type="text" id="qa" placeholder="Or type an answer"></div><div class="row"><button class="btn ghost" id="qskip">Skip</button><button class="btn primary" id="qok">Answer</button></div></div>`
    const done = (v) => { $('#pending').innerHTML = ''; resolve(v) }
    for (const o of $('#pending').querySelectorAll('.opt')) o.onclick = () => done(o.dataset.o)
    $('#qok').onclick = () => { const v = $('#qa').value.trim(); if (v) done(v) }
    $('#qa').onkeydown = (e) => { if (e.key === 'Enter') $('#qok').click() }
    $('#qskip').onclick = () => done(null)
    $('#main').scrollTop = $('#main').scrollHeight
    if (navigator.vibrate) navigator.vibrate(30)
    notifyIfHidden('clode has a question', question)
  })
}
function notifyIfHidden(title, body) {
  try { if (document.visibilityState === 'hidden' && 'Notification' in window && Notification.permission === 'granted') navigator.serviceWorker?.ready.then((r) => r.showNotification(title, { body, icon: 'icon-192.png', tag: 'clode-pending' })) } catch {}
}

// changes sheet: diff of staged edits, commit, discard
async function openChanges({ readOnly = false } = {}) {
  const c = S.cur; if (!c?.ws) return
  openSheet(`<div class="hd">Changes <span class="pill" id="chn"></span><button class="iconbtn x" data-x>✕</button></div><div class="bd" id="chbody"><div class="empty">Computing diff…</div></div>`)
  const diff = await c.ws.diff()
  const body = $('#chbody'); if (!body) return
  $('#chn').textContent = `${diff.length} file${diff.length === 1 ? '' : 's'}`
  if (diff.length === 0) { body.innerHTML = `<div class="empty">Nothing staged.</div>`; return }
  body.innerHTML = diff.map((f, i) => `<div class="file"><div class="fn" data-fi="${i}"><span class="nm">${esc(f.path)}</span>${f.added ? '<span class="add">new</span>' : ''}${f.deleted ? '<span class="del">deleted</span>' : ''}<span class="add">+${f.additions}</span><span class="del">−${f.deletions}</span></div><div class="diff" hidden>${diffHtml(f.patch)}</div></div>`).join('') + (readOnly ? '' : `<div class="form" style="padding:12px 16px"><label>Commit message</label><textarea id="cm" rows="2" placeholder="Short summary"></textarea><label>Branch</label><input type="text" id="cb" value="${esc(c.ws.branch)}"><div class="row"><button class="btn danger" id="discard">Discard all</button><button class="btn primary" id="docommit">Commit</button></div><div class="help">Committing straight to a protected branch will fail; use a feature branch and let the agent open a pull request.</div></div>`)
  for (const fn of body.querySelectorAll('.fn')) fn.onclick = () => { const d = fn.nextElementSibling; d.hidden = !d.hidden }
  $('#discard')?.addEventListener('click', () => { if (confirm('Discard all staged changes?')) { c.ws.discard(); closeSheet(); renderSessionRegions(); persist() } })
  $('#docommit')?.addEventListener('click', async () => {
    const message = $('#cm').value.trim(); const branch = $('#cb').value.trim()
    if (!message) return toast('Write a commit message.')
    try { const r = await c.ws.commit(message, { branch }); toast(`Committed ${r.sha.slice(0, 7)} to ${r.branch}`); closeSheet(); renderSessionRegions(); persist() } catch (e) { toast(e.message) }
  })
}

// ---------- sandboxed JS ----------
function runJsInWorker(code) {
  return new Promise((resolve) => {
    const src = `self.onmessage = (e) => { const logs = []; self.console = { log: (...a) => logs.push(a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')), error: (...a) => logs.push('error: ' + a.join(' ')), warn: (...a) => logs.push('warn: ' + a.join(' ')) }; try { const result = (0, eval)(e.data); Promise.resolve(result).then((r) => postMessage({ logs, result: r === undefined ? undefined : (typeof r === 'object' ? JSON.parse(JSON.stringify(r)) : r) })).catch((err) => postMessage({ logs, error: String(err && err.message || err) })) } catch (err) { postMessage({ logs, error: String(err && err.message || err) }) } }`
    let w
    try { w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))) } catch (e) { return resolve({ logs: [], error: 'Workers are not available here: ' + e.message }) }
    const t = setTimeout(() => { w.terminate(); resolve({ logs: [], error: 'timed out after 10 s' }) }, 10_000)
    w.onmessage = (e) => { clearTimeout(t); w.terminate(); resolve(e.data) }
    w.onerror = (e) => { clearTimeout(t); w.terminate(); resolve({ logs: [], error: e.message }) }
    w.postMessage(code)
  })
}

// ---------- wake lock ----------
async function requestWakeLock() { try { if ('wakeLock' in navigator && S.cur) S.cur.wakeLock = await navigator.wakeLock.request('screen') } catch {} }
function releaseWakeLock() { try { S.cur?.wakeLock?.release(); if (S.cur) S.cur.wakeLock = null } catch {} }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.cur?.agent?.running) requestWakeLock() })

// ---------- sheet / toast / md ----------
function openSheet(html) { closeSheet(); const bg = document.createElement('div'); bg.className = 'sheet-bg'; bg.id = 'sheet-bg'; bg.onclick = closeSheet; const sh = document.createElement('div'); sh.className = 'sheet'; sh.id = 'sheet'; sh.innerHTML = html; document.body.append(bg, sh); sh.querySelector('[data-x]')?.addEventListener('click', closeSheet) }
function closeSheet() { $('#sheet')?.remove(); $('#sheet-bg')?.remove() }
let toastTimer
function toast(text) { $('#toast')?.remove(); const t = document.createElement('div'); t.className = 'toast'; t.id = 'toast'; t.textContent = text; document.body.append(t); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 3500) }
function ago(t) { if (!t) return ''; const s = Math.round((Date.now() - t) / 1000); if (s < 45) return 'now'; if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`; if (s < 86400) return `${Math.round(s / 3600)}h`; return `${Math.round(s / 86400)}d` }
function md(src) {
  const lines = String(src ?? '').split('\n'); const out = []; let i = 0
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  while (i < lines.length) {
    const l = lines[i]
    if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`); continue }
    if (/^#{1,3}\s/.test(l)) { out.push(`<h3>${inline(l.replace(/^#+\s/, ''))}</h3>`); i++; continue }
    if (/^\s*[-*]\s/.test(l)) { const items = []; while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\s*[-*]\s/, ''))}</li>`); out.push(`<ul>${items.join('')}</ul>`); continue }
    if (/^\s*\d+[.)]\s/.test(l)) { const items = []; while (i < lines.length && /^\s*\d+[.)]\s/.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\s*\d+[.)]\s/, ''))}</li>`); out.push(`<ol>${items.join('')}</ol>`); continue }
    if (l.trim() === '') { i++; continue }
    const para = []; while (i < lines.length && lines[i].trim() !== '' && !/^```|^#{1,3}\s|^\s*[-*]\s|^\s*\d+[.)]\s/.test(lines[i])) para.push(inline(lines[i++]))
    out.push(`<p>${para.join('<br>')}</p>`)
  }
  return out.join('')
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {})
window.addEventListener('unhandledrejection', (e) => { if (e.reason?.message) toast(e.reason.message) })
render()
