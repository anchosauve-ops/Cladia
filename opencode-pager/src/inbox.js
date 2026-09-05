// The inbox: everything that needs a human, derived from the opencode event stream and
// reconciled against REST truth whenever we (re)connect. This is the heart of the pager.
//
// Emits:
//   'change'  -> snapshot()            (something a client should redraw)
//   'notify'  -> { kind, sessionID, id, title, body, tag, urgency }   (something worth a push)

export class Inbox {
  constructor({ now = () => Date.now(), permissionGrace = 1500, finishedMinBusy = 3000, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout } = {}) {
    this.now = now
    this.permissionGrace = permissionGrace
    this.finishedMinBusy = finishedMinBusy
    this._setTimeout = st
    this._clearTimeout = ct
    this.sessions = new Map() // id -> { id, title, directory, status, busySince, updated, parentID, finished, seen, error }
    this.permissions = new Map() // id -> normalized permission request
    this.questions = new Map() // id -> normalized question request
    this.todos = new Map() // sessionID -> todos[]
    this.listeners = { change: new Set(), notify: new Set() }
    this.pendingNotify = new Map() // permission id -> timer
    this.connected = false
  }

  on(evt, fn) { this.listeners[evt].add(fn); return () => this.listeners[evt].delete(fn) }
  emit(evt, payload) { for (const fn of this.listeners[evt]) { try { fn(payload) } catch {} } }
  changed() { this.emit('change', this.snapshot()) }

  session(id) {
    let s = this.sessions.get(id)
    if (!s) { s = { id, title: '', directory: '', status: 'idle', busySince: null, updated: this.now(), parentID: undefined, finished: null, seen: null, error: null }; this.sessions.set(id, s) }
    return s
  }

  /** Overwrite from REST truth: GET /session, /session/status, /permission, /question. */
  reconcile({ sessions = [], status = {}, permissions = [], questions = [] }) {
    const seenIds = new Set()
    for (const info of sessions) { this.upsertSession(info); seenIds.add(info.id) }
    for (const [id, st] of Object.entries(status)) this.setStatus(id, st, { quiet: true })
    for (const s of this.sessions.values()) if (!status[s.id] && s.status !== 'idle') this.setStatus(s.id, { type: 'idle' }, { quiet: true })
    const permIds = new Set(permissions.map((p) => p.id))
    for (const id of [...this.permissions.keys()]) if (!permIds.has(id)) this.removePermission(id)
    for (const p of permissions) this.addPermission(normalizePermission(p), { notify: !this.permissions.has(p.id) })
    const qIds = new Set(questions.map((q) => q.id))
    for (const id of [...this.questions.keys()]) if (!qIds.has(id)) this.questions.delete(id)
    for (const q of questions) this.addQuestion(normalizeQuestion(q), { notify: !this.questions.has(q.id) })
    this.changed()
  }

  upsertSession(info) {
    const s = this.session(info.id)
    if (info.title !== undefined) s.title = info.title
    if (info.directory !== undefined) s.directory = info.directory
    if (info.parentID !== undefined) s.parentID = info.parentID
    if (info.time?.updated) s.updated = info.time.updated
    if (info.time?.archived) s.archived = info.time.archived
    if (info.summary) s.summary = { additions: info.summary.additions, deletions: info.summary.deletions, files: info.summary.files }
    return s
  }

  setStatus(id, st, { quiet = false } = {}) {
    const s = this.session(id)
    const type = st?.type || 'idle'
    const prev = s.status
    if (type === 'busy' || type === 'retry') {
      if (prev === 'idle') s.busySince = this.now()
      s.status = type
      if (type === 'retry') s.retry = { attempt: st.attempt, message: st.message, next: st.next }
      else s.retry = null
      s.finished = null
      s.error = null
    } else {
      s.status = 'idle'
      s.retry = null
      if ((prev === 'busy' || prev === 'retry') && !quiet) {
        const busyFor = s.busySince ? this.now() - s.busySince : 0
        s.finished = this.now()
        s.seen = null
        if (busyFor >= this.finishedMinBusy && !s.parentID) {
          this.emit('notify', { kind: 'finished', sessionID: id, id: `fin_${id}_${s.finished}`, title: s.title || 'Session finished', body: 'The agent is waiting for you.', tag: `finished-${id}`, urgency: 'normal' })
        }
      }
      s.busySince = null
    }
  }

  addPermission(p, { notify = true } = {}) {
    const fresh = !this.permissions.has(p.id)
    this.permissions.set(p.id, { ...p, at: this.permissions.get(p.id)?.at ?? this.now() })
    if (fresh && notify) {
      // Give opencode a moment: permissions auto-resolved by rules never reach a human.
      const t = this._setTimeout(() => {
        this.pendingNotify.delete(p.id)
        if (!this.permissions.has(p.id)) return
        const s = this.sessions.get(p.sessionID)
        this.emit('notify', { kind: 'permission', sessionID: p.sessionID, id: p.id, title: permissionTitle(p), body: permissionBody(p), tag: `permission-${p.id}`, urgency: 'high' })
      }, this.permissionGrace)
      this.pendingNotify.set(p.id, t)
    }
  }

  removePermission(id) {
    const t = this.pendingNotify.get(id)
    if (t) { this._clearTimeout(t); this.pendingNotify.delete(id) }
    return this.permissions.delete(id)
  }

  addQuestion(q, { notify = true } = {}) {
    const fresh = !this.questions.has(q.id)
    this.questions.set(q.id, { ...q, at: this.questions.get(q.id)?.at ?? this.now() })
    if (fresh && notify) {
      const first = q.questions[0]
      this.emit('notify', { kind: 'question', sessionID: q.sessionID, id: q.id, title: first?.header || 'The agent has a question', body: first?.question || '', tag: `question-${q.id}`, urgency: 'high' })
    }
  }

  markSeen(sessionID) {
    const s = this.sessions.get(sessionID)
    if (!s) return
    s.seen = this.now()
    s.error = null
    this.changed()
  }

  /** Feed one opencode event. Returns true when it was relevant to the inbox. */
  applyEvent(evt) {
    const t = evt?.type
    const p = evt?.properties || {}
    switch (t) {
      case 'session.created':
      case 'session.updated':
        this.upsertSession(p.info); this.changed(); return true
      case 'session.deleted':
        this.sessions.delete(p.sessionID)
        for (const [id, perm] of this.permissions) if (perm.sessionID === p.sessionID) this.removePermission(id)
        for (const [id, q] of this.questions) if (q.sessionID === p.sessionID) this.questions.delete(id)
        this.changed(); return true
      case 'session.status':
        this.setStatus(p.sessionID, p.status); this.changed(); return true
      case 'session.idle':
        this.setStatus(p.sessionID, { type: 'idle' }); this.changed(); return true
      case 'session.error': {
        const err = p.error
        if (p.sessionID && err && err.name !== 'MessageAbortedError') {
          const s = this.session(p.sessionID)
          s.error = { name: err.name, message: err.data?.message || err.message || err.name, at: this.now() }
          s.seen = null
          this.emit('notify', { kind: 'error', sessionID: p.sessionID, id: `err_${p.sessionID}_${s.error.at}`, title: s.title || 'Session error', body: s.error.message.slice(0, 200), tag: `error-${p.sessionID}`, urgency: 'high' })
          this.changed()
        }
        return true
      }
      case 'permission.asked':
        this.addPermission(normalizePermission(p)); this.changed(); return true
      case 'permission.v2.asked':
        this.addPermission(normalizePermission(p)); this.changed(); return true
      case 'permission.replied':
      case 'permission.v2.replied':
        if (this.removePermission(p.requestID)) this.changed(); return true
      case 'question.asked':
      case 'question.v2.asked':
        this.addQuestion(normalizeQuestion(p)); this.changed(); return true
      case 'question.replied':
      case 'question.rejected':
      case 'question.v2.replied':
      case 'question.v2.rejected':
        if (this.questions.delete(p.requestID)) this.changed(); return true
      case 'todo.updated':
        this.todos.set(p.sessionID, p.todos || []); this.changed(); return true
      case 'message.updated': {
        const info = p.info
        if (info?.role === 'assistant' && info.error && info.error.name !== 'MessageAbortedError') {
          const s = this.session(p.sessionID)
          s.error = { name: info.error.name, message: info.error.data?.message || info.error.name, at: this.now() }
          this.changed()
        }
        return false
      }
      default:
        return false
    }
  }

  /** Ordered list of things that need the human right now. */
  items() {
    const out = []
    for (const p of this.permissions.values()) out.push({ kind: 'permission', at: p.at, sessionID: p.sessionID, session: this.sessionLite(p.sessionID), permission: p })
    for (const q of this.questions.values()) out.push({ kind: 'question', at: q.at, sessionID: q.sessionID, session: this.sessionLite(q.sessionID), question: q })
    for (const s of this.sessions.values()) {
      if (s.error && !(s.seen && s.seen > s.error.at)) out.push({ kind: 'error', at: s.error.at, sessionID: s.id, session: this.sessionLite(s.id), error: s.error })
      else if (s.finished && !s.parentID && !(s.seen && s.seen >= s.finished)) out.push({ kind: 'finished', at: s.finished, sessionID: s.id, session: this.sessionLite(s.id) })
    }
    const rank = { permission: 0, question: 0, error: 1, finished: 2 }
    out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.at - b.at)
    return out
  }

  sessionLite(id) {
    const s = this.sessions.get(id)
    if (!s) return { id, title: '', status: 'idle' }
    return { id: s.id, title: s.title, directory: s.directory, status: s.status, retry: s.retry || undefined, updated: s.updated, parentID: s.parentID, summary: s.summary, busySince: s.busySince, finished: s.finished, seen: s.seen, error: s.error, archived: s.archived }
  }

  snapshot() {
    const sessions = [...this.sessions.values()].filter((s) => !s.parentID && !s.archived).map((s) => this.sessionLite(s.id)).sort((a, b) => (b.updated || 0) - (a.updated || 0))
    return {
      at: this.now(),
      connected: this.connected,
      items: this.items(),
      sessions,
      todos: Object.fromEntries(this.todos),
      counts: { permissions: this.permissions.size, questions: this.questions.size, busy: sessions.filter((s) => s.status !== 'idle').length },
    }
  }
}

/** Accept both the v1 (`permission`, `patterns`, `always`) and v2 (`action`, `resources`, `save`) shapes. */
export function normalizePermission(p) {
  return {
    id: p.id,
    sessionID: p.sessionID,
    permission: p.permission ?? p.action ?? 'unknown',
    patterns: p.patterns ?? p.resources ?? [],
    always: p.always ?? p.save ?? [],
    metadata: p.metadata ?? {},
    tool: p.tool ?? p.source ?? undefined,
    v2: p.action !== undefined && p.permission === undefined,
  }
}

export function normalizeQuestion(q) {
  return { id: q.id, sessionID: q.sessionID, questions: (q.questions || []).map((x) => ({ question: x.question, header: x.header, options: x.options || [], multiple: !!x.multiple, custom: x.custom !== false })), tool: q.tool }
}

export function permissionTitle(p) {
  const kind = p.permission
  const cmd = p.metadata?.command || p.metadata?.title
  if (kind === 'bash' && (cmd || p.patterns?.[0])) return `Run: ${(cmd || p.patterns[0]).slice(0, 80)}`
  if ((kind === 'edit' || kind === 'write') && p.patterns?.[0]) return `Edit ${shortPath(p.patterns[0])}`
  if (kind === 'external_directory' && p.patterns?.[0]) return `Access outside project: ${shortPath(p.patterns[0])}`
  if (kind === 'webfetch' && p.patterns?.[0]) return `Fetch ${p.patterns[0].slice(0, 80)}`
  if (p.patterns?.length) return `${kind}: ${p.patterns[0].slice(0, 80)}`
  return `Permission: ${kind}`
}

export function permissionBody(p) {
  const parts = []
  if (p.metadata?.description) parts.push(String(p.metadata.description))
  if (p.patterns?.length > 1) parts.push(`${p.patterns.length} targets`)
  return parts.join(' · ') || 'Tap to allow or deny.'
}

function shortPath(path) {
  const segs = String(path).split('/').filter(Boolean)
  return segs.length > 3 ? '…/' + segs.slice(-3).join('/') : path
}
