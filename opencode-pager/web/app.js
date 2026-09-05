// opencode pager — the app. Vanilla JS, no build step.
// Principles: inbox first; reconcile on every reconnect; never trust the stream alone; Enter is a newline.

const $ = (sel, el = document) => el.querySelector(sel)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const LS = { get: (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v) } catch { return d } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }, del: (k) => { try { localStorage.removeItem(k) } catch {} } }

const S = {
  token: LS.get('pager.token', null),
  me: null,
  snap: LS.get('pager.snap', null), // last inbox snapshot, for offline glance
  route: parseRoute(),
  session: null, // { id, messages: [], byId: Map, diff: null, loading }
  agents: [], providers: null,
  prefs: LS.get('pager.prefs', {}),
  es: null, lastEvent: 0, online: false,
  view: null,
  sheet: null,
}

// ---------- api ----------
async function api(path, { method = 'GET', body, raw = false } = {}) {
  const headers = {}
  if (S.token) headers.authorization = `Bearer ${S.token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  let res
  try { res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'include' }) }
  catch (e) { throw new Error('Cannot reach the bridge. Check your connection.') }
  if (res.status === 401 && !path.startsWith('/pager/pair')) { forget(); throw new Error('This device is not paired.') }
  if (raw) return res
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!res.ok) { const e = new Error(data?.message || data?.error || (typeof data === 'string' && data) || `HTTP ${res.status}`); e.status = res.status; e.data = data; throw e }
  return data
}
const oc = (path, init) => api('/oc' + path, init)

function forget() { S.token = null; LS.del('pager.token'); S.me = null; S.es?.close(); S.es = null; render() }

// ---------- routing ----------
function parseRoute() {
  const h = location.hash.replace(/^#\/?/, '')
  if (h.startsWith('pair=')) return { name: 'pair', code: decodeURIComponent(h.slice(5)) }
  if (h.startsWith('s/')) return { name: 'session', id: h.slice(2) }
  if (h === 'sessions') return { name: 'sessions' }
  if (h === 'settings') return { name: 'settings' }
  return { name: 'inbox' }
}
function go(hash) { location.hash = hash }
window.addEventListener('hashchange', () => { S.route = parseRoute(); onRoute() })

// ---------- events / reconnect ----------
function connectEvents() {
  if (!S.token) return
  S.es?.close()
  const u = new URL('/pager/events', location.origin)
  if (S.route.name === 'session' && S.route.id) u.searchParams.set('session', S.route.id)
  u.searchParams.set('token', S.token)
  const es = new EventSource(u.toString())
  S.es = es
  es.addEventListener('snapshot', (e) => { S.snap = JSON.parse(e.data); LS.set('pager.snap', S.snap); S.lastEvent = Date.now(); S.online = true; renderRegions() })
  es.addEventListener('hb', () => { S.lastEvent = Date.now(); S.online = true; renderConn() })
  es.addEventListener('oc', (e) => { S.lastEvent = Date.now(); handleOc(JSON.parse(e.data)) })
  es.onopen = () => { S.online = true; renderConn() }
  es.onerror = () => { S.online = false; renderConn() }
}
async function resync(reason) {
  if (!S.token) return
  const stale = !S.es || S.es.readyState === EventSource.CLOSED || Date.now() - S.lastEvent > 40_000
  if (stale) connectEvents()
  try { S.snap = await api('/pager/inbox'); LS.set('pager.snap', S.snap); S.online = true } catch { S.online = false }
  if (S.route.name === 'session' && S.session?.id === S.route.id) await loadSession(S.route.id, { quiet: true })
  renderRegions()
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resync('visible') })
window.addEventListener('online', () => resync('online'))
window.addEventListener('pageshow', (e) => { if (e.persisted) resync('pageshow') })
window.addEventListener('focus', () => { if (Date.now() - S.lastEvent > 40_000) resync('focus') })

function handleOc(evt) {
  const t = evt.type, p = evt.properties || {}
  const sess = S.session
  if (!sess || p.sessionID !== sess.id) return
  if (t === 'message.updated') { upsertMessage(p.info); scheduleRenderMessages(); return }
  if (t === 'message.part.updated') { upsertPart(p.part); scheduleRenderMessages(); return }
  if (t === 'message.part.delta') {
    const m = sess.byId.get(p.messageID); const part = m?.parts.find((x) => x.id === p.partID)
    if (part) { part[p.field] = (part[p.field] || '') + p.delta; scheduleRenderMessages() }
    return
  }
  if (t === 'message.removed') { sess.messages = sess.messages.filter((m) => m.info.id !== p.messageID); sess.byId.delete(p.messageID); scheduleRenderMessages(); return }
  if (t === 'message.part.removed') { const m = sess.byId.get(p.messageID); if (m) m.parts = m.parts.filter((x) => x.id !== p.partID); scheduleRenderMessages(); return }
  if (t === 'session.diff') { sess.diff = p.diff; if (S.sheet === 'diff') renderSheet(); return }
}
function upsertMessage(info) {
  const sess = S.session
  let m = sess.byId.get(info.id)
  if (m) { m.info = info; return m }
  m = { info, parts: [] }
  sess.byId.set(info.id, m)
  sess.messages.push(m)
  // drop optimistic local echo
  if (info.role === 'user') sess.messages = sess.messages.filter((x) => !x.local)
  return m
}
function upsertPart(part) {
  const sess = S.session
  let m = sess.byId.get(part.messageID)
  if (!m) m = upsertMessage({ id: part.messageID, sessionID: part.sessionID, role: 'assistant', time: { created: Date.now() } })
  const i = m.parts.findIndex((x) => x.id === part.id)
  if (i >= 0) m.parts[i] = part; else m.parts.push(part)
}

// ---------- session loading ----------
async function loadSession(id, { quiet = false } = {}) {
  if (!S.session || S.session.id !== id) S.session = { id, messages: [], byId: new Map(), diff: null, loading: true, info: null }
  if (!quiet) renderRegions()
  try {
    const [msgs, info] = await Promise.all([oc(`/session/${encodeURIComponent(id)}/message?limit=80`), oc(`/session/${encodeURIComponent(id)}`).catch(() => null)])
    if (S.session?.id !== id) return
    const byId = new Map(); const messages = []
    for (const m of msgs) { byId.set(m.info.id, m); messages.push(m) }
    // keep any optimistic local message not yet acknowledged
    for (const m of S.session.messages) if (m.local && Date.now() - m.info.time.created < 15_000 && !messages.some((x) => x.info.role === 'user' && textOf(x) === textOf(m))) messages.push(m)
    S.session.messages = messages; S.session.byId = byId; S.session.loading = false; if (info) S.session.info = info
    api('/pager/seen', { method: 'POST', body: { sessionID: id } }).catch(() => {})
  } catch (e) { S.session.loading = false; S.session.error = e.message }
  renderRegions()
}
const textOf = (m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n')

// ---------- render ----------
function render() {
  const app = $('#app')
  if (!S.token) { S.view = 'pair'; app.innerHTML = pairView(); bindPair(); return }
  const r = S.route
  if (r.name === 'session') {
    if (S.view !== 'session:' + r.id) {
      S.view = 'session:' + r.id
      app.innerHTML = sessionShell(r.id)
      bindSession()
      loadSession(r.id)
      connectEvents()
    }
    renderRegions()
    return
  }
  if (S.view && S.view.startsWith('session:')) { S.session = null; connectEvents() }
  S.view = r.name
  app.innerHTML = `
    <header class="top"><span class="dot" id="conn"></span><h1 id="title"></h1><button class="iconbtn" id="refresh" aria-label="Refresh">↻</button></header>
    <main class="main" id="main"></main>
    <nav class="nav">
      <button data-go="inbox" class="${r.name === 'inbox' ? 'active' : ''}"><span class="ic">◉</span>Inbox<span class="badge" id="badge" hidden></span></button>
      <button data-go="sessions" class="${r.name === 'sessions' ? 'active' : ''}"><span class="ic">≣</span>Sessions</button>
      <button data-go="settings" class="${r.name === 'settings' ? 'active' : ''}"><span class="ic">⚙</span>Settings</button>
    </nav>`
  for (const b of app.querySelectorAll('[data-go]')) b.onclick = () => go(b.dataset.go)
  $('#refresh').onclick = () => resync('manual')
  renderRegions()
}

function renderConn() {
  const d = $('#conn'); if (!d) return
  const up = S.snap?.connected
  d.className = 'dot ' + (!S.online ? 'bad' : up ? 'ok' : 'warn')
  d.title = !S.online ? 'Bridge unreachable' : up ? 'Connected to opencode' : 'Bridge up, opencode not reachable'
}
function renderRegions() {
  renderConn()
  const badge = $('#badge')
  const n = (S.snap?.items || []).length
  if (badge) { badge.hidden = n === 0; badge.textContent = n }
  if (S.view === 'inbox') { $('#title').innerHTML = 'Inbox' + (S.snap?.connected === false ? '<span class="sub">opencode not reachable</span>' : ''); $('#main').innerHTML = inboxView(); bindInbox() }
  else if (S.view === 'sessions') { $('#title').textContent = 'Sessions'; $('#main').innerHTML = sessionsView(); bindSessions() }
  else if (S.view === 'settings') { $('#title').textContent = 'Settings'; $('#main').innerHTML = settingsView(); bindSettings() }
  else if (S.view?.startsWith('session:')) renderSessionRegions()
  if (S.sheet) renderSheet()
}

// ---------- inbox ----------
function inboxView() {
  const items = S.snap?.items || []
  if (!S.snap) return `<div class="empty"><div class="big">◌</div>Connecting…</div>`
  if (items.length === 0) {
    const busy = S.snap.counts?.busy || 0
    return `<div class="empty"><div class="big">☺</div>Nothing needs you.${busy ? `<div class="small" style="margin-top:6px">${busy} session${busy > 1 ? 's' : ''} working</div>` : ''}</div>`
  }
  return items.map(itemCard).join('')
}
function itemCard(it) {
  const s = it.session || {}
  const title = esc(s.title || s.id || '')
  if (it.kind === 'permission') {
    const p = it.permission
    return `<div class="card" data-perm="${esc(p.id)}" data-sess="${esc(p.sessionID)}">
      <div class="k perm"><span class="kind">Permission</span><span>${title}</span><span class="t">${ago(it.at)}</span></div>
      <div class="title">${esc(permTitle(p))}</div>
      ${permDetail(p)}
      <div class="row"><button class="btn danger" data-reply="reject">Deny</button><button class="btn" data-reply="always">Always</button><button class="btn primary" data-reply="once">Allow</button></div>
    </div>`
  }
  if (it.kind === 'question') {
    const q = it.question
    return `<div class="card" data-question="${esc(q.id)}" data-sess="${esc(q.sessionID)}">
      <div class="k q"><span class="kind">Question</span><span>${title}</span><span class="t">${ago(it.at)}</span></div>
      ${questionForm(q)}
    </div>`
  }
  if (it.kind === 'error') {
    return `<div class="card tap" data-open="${esc(it.sessionID)}">
      <div class="k err"><span class="kind">Error</span><span>${title}</span><span class="t">${ago(it.at)}</span></div>
      <div class="title">${esc(it.error?.name || 'Error')}</div><div class="desc">${esc(it.error?.message || '')}</div>
    </div>`
  }
  return `<div class="card tap" data-open="${esc(it.sessionID)}">
    <div class="k fin"><span class="kind">Finished</span><span class="t">${ago(it.at)}</span></div>
    <div class="title">${title || 'Session'}</div><div class="desc">Waiting for your next instruction${s.summary?.files ? ` · ${s.summary.files} file${s.summary.files > 1 ? 's' : ''} changed <span class="add">+${s.summary.additions}</span> <span class="del">−${s.summary.deletions}</span>` : ''}</div>
  </div>`
}
function permTitle(p) {
  const cmd = p.metadata?.command || p.metadata?.title
  if (p.permission === 'bash') return cmd || p.patterns?.[0] || 'Run a command'
  if (p.permission === 'edit' || p.permission === 'write') return `Edit ${short(p.patterns?.[0] || '')}`
  if (p.permission === 'external_directory') return `Access outside the project`
  if (p.permission === 'webfetch') return `Fetch ${p.patterns?.[0] || ''}`
  return `${p.permission}${p.patterns?.[0] ? ': ' + p.patterns[0] : ''}`
}
function permDetail(p) {
  const bits = []
  if (p.permission === 'bash' && (p.metadata?.command || p.patterns?.[0])) bits.push(`<pre class="cmd">${esc(p.metadata?.command || p.patterns.join('\n'))}</pre>`)
  else if (p.patterns?.length) bits.push(`<pre class="cmd">${esc(p.patterns.join('\n'))}</pre>`)
  if (p.metadata?.description) bits.push(`<div class="desc">${esc(p.metadata.description)}</div>`)
  if (p.metadata?.diff) bits.push(`<div class="diff" style="margin-top:8px;max-height:220px;overflow:auto">${diffHtml(p.metadata.diff)}</div>`)
  if (p.always?.length) bits.push(`<div class="desc small">“Always” allows: ${esc(p.always.join(', '))}</div>`)
  return bits.join('')
}
function short(path) { const s = String(path).split('/'); return s.length > 3 ? '…/' + s.slice(-3).join('/') : path }
function questionForm(q) {
  return q.questions.map((qq, qi) => `
    <div class="form" data-qi="${qi}">
      <div class="title">${esc(qq.header || '')}</div><div class="desc">${esc(qq.question)}</div>
      ${qq.options.map((o, oi) => `<div class="opt" data-oi="${oi}" role="${qq.multiple ? 'checkbox' : 'radio'}"><div><div class="lb">${esc(o.label)}</div>${o.description ? `<div class="ds">${esc(o.description)}</div>` : ''}</div></div>`).join('')}
      ${qq.custom ? `<label>Or type an answer</label><input type="text" data-custom placeholder="Your answer" autocomplete="off">` : ''}
    </div>`).join('') + `<div class="row"><button class="btn ghost" data-qreject>Dismiss</button><button class="btn primary" data-qsubmit>Answer</button></div>`
}
function bindInbox() {
  const main = $('#main')
  for (const el of main.querySelectorAll('[data-open]')) el.onclick = () => go('s/' + el.dataset.open)
  for (const card of main.querySelectorAll('[data-perm]')) for (const b of card.querySelectorAll('[data-reply]')) b.onclick = () => replyPermission(card.dataset.perm, card.dataset.sess, b.dataset.reply, card)
  for (const card of main.querySelectorAll('[data-question]')) bindQuestion(card)
}
function bindQuestion(card) {
  for (const form of card.querySelectorAll('.form')) {
    const multiple = form.querySelector('.opt')?.getAttribute('role') === 'checkbox'
    for (const o of form.querySelectorAll('.opt')) o.onclick = () => { if (!multiple) for (const x of form.querySelectorAll('.opt')) x.classList.remove('on'); o.classList.toggle('on') }
  }
  card.querySelector('[data-qreject]').onclick = async () => { try { await oc(`/question/${encodeURIComponent(card.dataset.question)}/reject`, { method: 'POST' }); card.remove() } catch (e) { toast(e.message) } }
  card.querySelector('[data-qsubmit]').onclick = async () => {
    const answers = []
    for (const form of card.querySelectorAll('.form')) {
      const picked = [...form.querySelectorAll('.opt.on .lb')].map((x) => x.textContent)
      const custom = form.querySelector('[data-custom]')?.value.trim()
      if (custom) picked.push(custom)
      if (picked.length === 0) return toast('Pick an option or type an answer.')
      answers.push(picked)
    }
    try { await oc(`/question/${encodeURIComponent(card.dataset.question)}/reply`, { method: 'POST', body: { answers } }); card.remove(); toast('Answered') } catch (e) { toast(e.message) }
  }
}
async function replyPermission(id, sessionID, reply, card) {
  for (const b of card.querySelectorAll('button')) b.disabled = true
  try {
    try { await oc(`/permission/${encodeURIComponent(id)}/reply`, { method: 'POST', body: { reply } }) }
    catch (e) {
      if (e.status !== 404) throw e
      const v2 = { once: 'allow', always: 'allow_always', reject: 'reject' }[reply]
      await oc(`/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(id)}/reply`, { method: 'POST', body: { reply: v2 } })
    }
    card.remove()
    toast(reply === 'reject' ? 'Denied' : 'Allowed')
    if (S.snap) { S.snap.items = S.snap.items.filter((i) => i.permission?.id !== id); renderRegions() }
  } catch (e) { toast(e.message); for (const b of card.querySelectorAll('button')) b.disabled = false }
}

// ---------- sessions ----------
function sessionsView() {
  const list = S.snap?.sessions || []
  const head = `<div class="row" style="margin:0 0 12px"><button class="btn primary" id="newsess">＋ New session</button></div>`
  if (list.length === 0) return head + `<div class="empty">No sessions yet.</div>`
  return head + list.map((s) => `<div class="card tap sess" data-open="${esc(s.id)}">
    <span class="st ${s.error ? 'err' : s.status === 'idle' ? '' : s.status}"></span>
    <div class="body"><div class="title">${esc(s.title || 'Untitled')}</div>
    <div class="meta"><span>${s.status !== 'idle' ? esc(s.status === 'retry' ? 'retrying' : 'working') : ago(s.updated)}</span>${s.directory ? `<span>${esc(s.directory.split('/').pop())}</span>` : ''}${s.summary?.files ? `<span><span class="add">+${s.summary.additions}</span> <span class="del">−${s.summary.deletions}</span></span>` : ''}</div></div>
  </div>`).join('')
}
function bindSessions() {
  for (const el of $('#main').querySelectorAll('[data-open]')) el.onclick = () => go('s/' + el.dataset.open)
  $('#newsess').onclick = async () => { try { const s = await oc('/session', { method: 'POST', body: {} }); go('s/' + s.id) } catch (e) { toast(e.message) } }
}

// ---------- session view ----------
function sessionShell(id) {
  return `
    <header class="top"><button class="iconbtn" id="back" aria-label="Back">‹</button><span class="dot" id="conn"></span><h1 id="title"><span id="stitle">Session</span><span class="sub" id="ssub"></span></h1><button class="iconbtn" id="changes" aria-label="Changes">±</button></header>
    <main class="main session" id="main"><div class="msgs" id="msgs"></div><div id="inline-items"></div></main>
    <div class="composer">
      <div class="opts" id="opts" hidden><select id="agent"></select><select id="model"></select></div>
      <div class="in">
        <button class="iconbtn" id="optsbtn" aria-label="Agent and model">⚙</button>
        <textarea id="ta" rows="1" placeholder="Message the agent…" enterkeyhint="enter" autocapitalize="sentences"></textarea>
        <button class="send" id="send" aria-label="Send">➤</button>
      </div>
      <div class="hint">Enter for a new line · ⌘/Ctrl+Enter to send</div>
    </div>`
}
function bindSession() {
  $('#back').onclick = () => { if (history.length > 1) history.back(); else go('inbox') }
  $('#changes').onclick = () => openSheet('diff')
  const ta = $('#ta')
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(160, ta.scrollHeight) + 'px' }
  ta.oninput = grow
  ta.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendOrStop() } }
  $('#send').onclick = sendOrStop
  $('#optsbtn').onclick = async () => { const o = $('#opts'); o.hidden = !o.hidden; if (!o.hidden) await loadPickers() }
}
function currentSessionLite() { return (S.snap?.sessions || []).find((s) => s.id === S.session?.id) }
function renderSessionRegions() {
  const lite = currentSessionLite()
  const info = S.session?.info
  const title = lite?.title || info?.title || 'Session'
  $('#stitle').textContent = title
  const status = lite?.status || 'idle'
  const todos = S.snap?.todos?.[S.session?.id]
  const done = todos ? todos.filter((t) => t.status === 'completed').length : 0
  $('#ssub').textContent = [status === 'idle' ? '' : status === 'retry' ? `retrying: ${lite?.retry?.message || ''}` : 'working…', todos?.length ? `${done}/${todos.length} tasks` : '', lite?.directory ? lite.directory.split('/').pop() : ''].filter(Boolean).join(' · ')
  const send = $('#send'); const busy = status !== 'idle'
  send.className = 'send' + (busy ? ' stop' : ''); send.textContent = busy ? '■' : '➤'; send.setAttribute('aria-label', busy ? 'Stop' : 'Send')
  renderMessages()
  const items = (S.snap?.items || []).filter((i) => i.sessionID === S.session?.id && (i.kind === 'permission' || i.kind === 'question'))
  const box = $('#inline-items')
  const key = items.map((i) => i.permission?.id || i.question?.id).join(',')
  if (box.dataset.key !== key) { box.dataset.key = key; box.innerHTML = items.map(itemCard).join(''); bindInboxIn(box); if (items.length) scrollBottom(true) }
}
function bindInboxIn(box) {
  for (const card of box.querySelectorAll('[data-perm]')) for (const b of card.querySelectorAll('[data-reply]')) b.onclick = () => replyPermission(card.dataset.perm, card.dataset.sess, b.dataset.reply, card)
  for (const card of box.querySelectorAll('[data-question]')) bindQuestion(card)
}
let renderQueued = false
function scheduleRenderMessages() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; renderMessages() }) }
function renderMessages() {
  const box = $('#msgs'); if (!box || !S.session) return
  const main = $('#main')
  const nearBottom = main.scrollHeight - main.scrollTop - main.clientHeight < 120
  if (S.session.loading && S.session.messages.length === 0) { box.innerHTML = `<div class="empty">Loading…</div>`; return }
  if (S.session.error) { box.innerHTML = `<div class="empty">${esc(S.session.error)}</div>`; return }
  if (S.session.messages.length === 0) { box.innerHTML = `<div class="empty"><div class="big">✎</div>Say what you need.</div>`; return }
  box.innerHTML = S.session.messages.map(messageHtml).join('')
  for (const t of box.querySelectorAll('.tool .hd')) t.onclick = () => { const bd = t.nextElementSibling; if (bd) bd.hidden = !bd.hidden }
  if (nearBottom) scrollBottom()
}
function scrollBottom(force) { const main = $('#main'); if (main) main.scrollTop = main.scrollHeight }
function messageHtml(m) {
  const info = m.info
  if (info.role === 'user') return `<div class="msg user${m.local ? ' pending' : ''}">${esc(textOf(m) || m.parts.filter((p) => p.type === 'file').map((p) => p.filename || 'file').join(', '))}</div>`
  const parts = m.parts.map(partHtml).filter(Boolean).join('')
  const err = info.error && info.error.name !== 'MessageAbortedError' ? `<div class="card" style="border-color:var(--bad)"><div class="k err"><span class="kind">${esc(info.error.name)}</span></div><div class="desc">${esc(info.error.data?.message || '')}</div></div>` : ''
  const aborted = info.error?.name === 'MessageAbortedError' ? `<div class="small">Stopped.</div>` : ''
  return `<div class="msg assistant">${parts}${err}${aborted}</div>`
}
function partHtml(p) {
  switch (p.type) {
    case 'text': return p.ignored ? '' : `<div class="md">${md(p.text)}</div>`
    case 'reasoning': return p.text ? `<details class="think"><summary>Thinking</summary><div class="bd">${esc(p.text)}</div></details>` : ''
    case 'tool': return toolHtml(p)
    case 'file': return `<div class="small">📎 ${esc(p.filename || p.mime)}</div>`
    case 'subtask': return `<div class="tool"><div class="hd"><span class="name">task</span><span class="ttl">${esc(p.description)}</span><span class="stt">${esc(p.agent)}</span></div></div>`
    case 'patch': return p.files?.length ? `<div class="small">Patch: ${p.files.length} file${p.files.length > 1 ? 's' : ''}</div>` : ''
    case 'compaction': return `<div class="small">— context compacted —</div>`
    case 'retry': return `<div class="small">retrying…</div>`
    default: return ''
  }
}
function toolHtml(p) {
  const st = p.state || {}
  const input = st.input || {}
  const title = st.title || input.command || input.filePath || input.path || input.pattern || input.url || input.description || input.query || ''
  const status = st.status || 'pending'
  let body = ''
  if (Object.keys(input).length) body += `<b>input</b>\n${esc(pretty(input))}\n`
  if (st.metadata?.diff) body += `<b>diff</b>\n<div class="diff">${diffHtml(st.metadata.diff)}</div>`
  if (status === 'completed' && st.output) body += `<b>output</b>\n${esc(truncate(st.output, 6000))}`
  if (status === 'error') body += `<b>error</b>\n${esc(st.error)}`
  return `<div class="tool"><div class="hd"><span class="name">${esc(p.tool)}</span><span class="ttl">${esc(title)}</span><span class="stt ${status}">${status}</span></div><div class="bd" hidden>${body || 'no details'}</div></div>`
}
function pretty(v) { try { return typeof v === 'string' ? v : JSON.stringify(v, null, 1).replace(/^\{\n|\n\}$/g, '') } catch { return String(v) } }
function truncate(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more chars)` : s }
function diffHtml(patch) {
  return String(patch).split('\n').map((l) => { const c = l.startsWith('+') && !l.startsWith('+++') ? 'a' : l.startsWith('-') && !l.startsWith('---') ? 'd' : l.startsWith('@@') ? 'h' : ''; return `<div class="l ${c}">${esc(l) || ' '}</div>` }).join('')
}
async function sendOrStop() {
  const lite = currentSessionLite()
  if (lite && lite.status !== 'idle' && !$('#ta').value.trim()) {
    try { await oc(`/session/${encodeURIComponent(S.session.id)}/abort`, { method: 'POST' }); toast('Stopping…') } catch (e) { toast(e.message) }
    return
  }
  const ta = $('#ta'); const text = ta.value.trim()
  if (!text) return
  ta.value = ''; ta.style.height = 'auto'
  const body = { parts: [{ type: 'text', text }] }
  if (S.prefs.agent) body.agent = S.prefs.agent
  if (S.prefs.model) body.model = S.prefs.model
  const local = { local: true, info: { id: 'local_' + Date.now(), role: 'user', time: { created: Date.now() } }, parts: [{ type: 'text', text }] }
  S.session.messages.push(local); renderMessages(); scrollBottom(true)
  try { await oc(`/session/${encodeURIComponent(S.session.id)}/prompt_async`, { method: 'POST', body }) }
  catch (e) { S.session.messages = S.session.messages.filter((m) => m !== local); renderMessages(); ta.value = text; toast(e.message) }
}
async function loadPickers() {
  try {
    if (S.agents.length === 0) S.agents = (await oc('/agent')).filter((a) => (a.mode === 'primary' || a.mode === 'all') && !a.hidden)
    if (!S.providers) S.providers = await oc('/config/providers')
  } catch (e) { toast(e.message); return }
  const ag = $('#agent'); const mo = $('#model')
  ag.innerHTML = `<option value="">agent: default</option>` + S.agents.map((a) => `<option value="${esc(a.name)}" ${S.prefs.agent === a.name ? 'selected' : ''}>${esc(a.name)}</option>`).join('')
  const opts = [`<option value="">model: default</option>`]
  for (const pr of S.providers.providers || []) for (const m of Object.values(pr.models || {})) { const v = `${pr.id}/${m.id}`; opts.push(`<option value="${esc(v)}" ${S.prefs.model && `${S.prefs.model.providerID}/${S.prefs.model.modelID}` === v ? 'selected' : ''}>${esc(pr.name)} · ${esc(m.name || m.id)}</option>`) }
  mo.innerHTML = opts.join('')
  ag.onchange = () => { S.prefs.agent = ag.value || undefined; LS.set('pager.prefs', S.prefs) }
  mo.onchange = () => { const [providerID, ...rest] = mo.value.split('/'); S.prefs.model = mo.value ? { providerID, modelID: rest.join('/') } : undefined; LS.set('pager.prefs', S.prefs) }
}

// ---------- sheets ----------
function openSheet(name) { S.sheet = name; renderSheet(); if (name === 'diff' && S.session && !S.session.diff) oc(`/session/${encodeURIComponent(S.session.id)}/diff`).then((d) => { S.session.diff = d; renderSheet() }).catch((e) => toast(e.message)) }
function closeSheet() { S.sheet = null; $('#sheet')?.remove(); $('#sheet-bg')?.remove() }
function renderSheet() {
  $('#sheet')?.remove(); $('#sheet-bg')?.remove()
  if (!S.sheet) return
  const bg = document.createElement('div'); bg.className = 'sheet-bg'; bg.id = 'sheet-bg'; bg.onclick = closeSheet
  const sh = document.createElement('div'); sh.className = 'sheet'; sh.id = 'sheet'
  const diff = S.session?.diff
  const files = diff || []
  const total = files.reduce((a, f) => ({ add: a.add + (f.additions || 0), del: a.del + (f.deletions || 0) }), { add: 0, del: 0 })
  sh.innerHTML = `<div class="hd">Changes${files.length ? ` <span class="small" style="margin-left:8px"><span class="add">+${total.add}</span> <span class="del">−${total.del}</span></span>` : ''}<button class="iconbtn x" id="sheet-x">✕</button></div>
    <div class="bd">${!diff ? '<div class="empty">Loading…</div>' : files.length === 0 ? '<div class="empty">No changes in this session.</div>' : files.map((f, i) => `<div class="file"><div class="fn" data-fi="${i}"><span class="nm">${esc(f.file)}</span><span class="add">+${f.additions}</span><span class="del">−${f.deletions}</span></div><div class="diff" hidden>${diffHtml(f.patch || '')}</div></div>`).join('')}</div>`
  document.body.append(bg, sh)
  $('#sheet-x').onclick = closeSheet
  for (const fn of sh.querySelectorAll('.fn')) fn.onclick = () => { const d = fn.nextElementSibling; d.hidden = !d.hidden }
}

// ---------- settings ----------
function settingsView() {
  const me = S.me || {}
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  const perm = pushSupported ? Notification.permission : 'unsupported'
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent)
  return `
    <div class="section">Notifications</div>
    <div class="card">
      <div class="kv"><span>Status</span><span class="v" id="push-status">${perm === 'granted' ? (me.subscriptions ? 'On' : 'Permission granted, not subscribed') : perm === 'denied' ? 'Blocked in browser settings' : perm === 'unsupported' ? 'Not supported here' : 'Off'}</span></div>
      ${isIOS && !standalone ? `<div class="desc" style="margin:8px 0">On iPhone, notifications only work after you add this page to your Home Screen (Share → Add to Home Screen) and open it from there.</div>` : ''}
      ${!location.protocol.startsWith('https') && location.hostname !== 'localhost' ? `<div class="desc" style="margin:8px 0">This page is not served over https, so the browser will not allow push notifications or installation. Put the bridge behind tailscale serve or a tunnel.</div>` : ''}
      <div class="row"><button class="btn primary" id="push-on" ${perm === 'denied' || !pushSupported ? 'disabled' : ''}>Enable</button><button class="btn" id="push-test" ${!me.subscriptions ? 'disabled' : ''}>Send test</button><button class="btn ghost" id="push-off" ${!me.subscriptions ? 'disabled' : ''}>Disable</button></div>
    </div>
    <div class="section">This device</div>
    <div class="card">
      <div class="kv"><span>Name</span><span class="v">${esc(me.device?.name || '')}</span></div>
      <div class="kv"><span>Bridge</span><span class="v">${esc(location.origin)}</span></div>
      <div class="kv"><span>opencode</span><span class="v">${esc(me.opencode?.version ? 'v' + me.opencode.version : 'unknown')} · ${me.opencode?.connected ? 'connected' : 'not connected'}</span></div>
      <div class="kv"><span>pager</span><span class="v">${esc(me.version || '')}</span></div>
      <div class="row"><button class="btn danger" id="unpair">Unpair this device</button></div>
    </div>
    <div class="section">Habits</div>
    <div class="card small">Every reconnect re-reads the truth from opencode, so what you see after unlocking your phone is what is actually pending, not what a dropped stream last said. Permissions that opencode auto-resolves within 1.5 s never page you.</div>`
}
function bindSettings() {
  $('#push-on').onclick = enablePush
  $('#push-test').onclick = async () => { try { const r = await api('/pager/push/test', { method: 'POST' }); const bad = r.results.filter((x) => !x.ok); toast(bad.length ? `Push service said ${bad[0].status}: ${bad[0].text || ''}` : 'Sent. It should arrive in a moment.') } catch (e) { toast(e.message) } }
  $('#push-off').onclick = async () => { try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (sub) { await api('/pager/push/subscribe', { method: 'DELETE', body: { endpoint: sub.endpoint } }); await sub.unsubscribe() } await loadMe(); renderRegions(); toast('Notifications off') } catch (e) { toast(e.message) } }
  $('#unpair').onclick = () => { if (confirm('Unpair this device? You will need a new pairing code.')) forget() }
}
async function enablePush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Push is not supported in this browser context.')
    const reg = await navigator.serviceWorker.ready
    const perm = await Notification.requestPermission()
    if (perm !== 'granted') throw new Error('Notification permission was not granted.')
    let sub = await reg.pushManager.getSubscription()
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(S.me.vapidPublicKey) })
    await api('/pager/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } })
    await loadMe(); renderRegions(); toast('Notifications on')
  } catch (e) { toast(e.message) }
}
function b64ToBytes(s) { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')); return Uint8Array.from(b, (c) => c.charCodeAt(0)) }

// ---------- pairing ----------
function pairView() {
  return `<div class="pairbox"><img src="/icon.svg" width="72" height="72" alt=""><h2>opencode pager</h2><p>Scan the QR code printed by <code>opencode-pager</code> on your computer, or type the pairing code.</p>
    <input id="code" inputmode="text" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="PAIRING CODE" maxlength="12">
    <button class="btn primary" id="pair" style="width:100%">Pair this phone</button><p class="small" id="pair-msg"></p></div>`
}
function bindPair() {
  const code = $('#code'); const btn = $('#pair'); const msg = $('#pair-msg')
  const doPair = async (c) => {
    btn.disabled = true; msg.textContent = 'Pairing…'
    try {
      const r = await api('/pager/pair', { method: 'POST', body: { code: c, name: deviceName() } })
      S.token = r.token; LS.set('pager.token', r.token)
      history.replaceState(null, '', '#inbox'); S.route = parseRoute()
      await boot()
    } catch (e) { msg.textContent = e.message; btn.disabled = false }
  }
  btn.onclick = () => doPair(code.value.trim())
  code.onkeydown = (e) => { if (e.key === 'Enter') doPair(code.value.trim()) }
  if (S.route.name === 'pair' && S.route.code) { code.value = S.route.code; doPair(S.route.code) }
}
function deviceName() {
  const ua = navigator.userAgent
  const dev = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'device'
  const br = /CriOS|Chrome/.test(ua) ? 'Chrome' : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : 'browser'
  return `${dev} · ${br}`
}

// ---------- misc ----------
function ago(t) {
  if (!t) return ''
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 45) return 'now'
  if (s < 90) return '1m'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}
let toastTimer
function toast(text) { $('#toast')?.remove(); const t = document.createElement('div'); t.className = 'toast'; t.id = 'toast'; t.textContent = text; document.body.append(t); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.remove(), 3200) }
function md(src) {
  const lines = String(src ?? '').split('\n')
  const out = []
  let i = 0
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
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

async function loadMe() { S.me = await api('/pager/me') }
async function boot() {
  if (!S.token) { render(); return }
  try { await loadMe() } catch (e) { if (!S.token) { render(); return } }
  render()
  connectEvents()
  try { S.snap = await api('/pager/inbox'); LS.set('pager.snap', S.snap); S.online = true } catch { S.online = false }
  renderRegions()
}
function onRoute() {
  if (!S.token) { render(); return }
  const wasSession = S.view?.startsWith('session:')
  render()
  if (S.route.name === 'session' && !wasSession) return // render() already connected with session filter
  if (S.route.name !== 'session' && wasSession) return
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {})
  navigator.serviceWorker.addEventListener('message', (e) => { if (e.data?.type === 'navigate' && e.data.url) { const h = e.data.url.split('#')[1]; if (h) go(h); resync('sw') } })
}
window.addEventListener('unhandledrejection', (e) => { if (e.reason?.message) toast(e.reason.message) })
boot()
