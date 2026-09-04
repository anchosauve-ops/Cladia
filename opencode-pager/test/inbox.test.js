import test from 'node:test'
import assert from 'node:assert/strict'
import { Inbox, normalizePermission, permissionTitle } from '../src/inbox.js'

function fakeClock() {
  let t = 1_000_000
  const timers = []
  return {
    now: () => t,
    advance(ms) { t += ms; for (const tm of [...timers]) if (tm.at <= t && !tm.done) { tm.done = true; tm.fn() } },
    setTimeout: (fn, ms) => { const tm = { fn, at: t + ms, done: false }; timers.push(tm); return tm },
    clearTimeout: (tm) => { if (tm) tm.done = true },
  }
}
function make() {
  const clock = fakeClock()
  const inbox = new Inbox({ now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout })
  const notes = []
  inbox.on('notify', (n) => notes.push(n))
  return { clock, inbox, notes }
}
const perm = (id = 'per_1', sessionID = 'ses_1') => ({ type: 'permission.asked', properties: { id, sessionID, permission: 'bash', patterns: ['rm -rf build'], metadata: { command: 'rm -rf build' }, always: ['rm *'], tool: { messageID: 'msg_1', callID: 'call_1' } } })

test('a permission that is auto-resolved within the grace period never pages the human', () => {
  const { clock, inbox, notes } = make()
  inbox.applyEvent(perm())
  assert.equal(inbox.items().length, 1)
  clock.advance(500)
  inbox.applyEvent({ type: 'permission.replied', properties: { sessionID: 'ses_1', requestID: 'per_1', reply: 'once' } })
  clock.advance(5000)
  assert.equal(notes.length, 0)
  assert.equal(inbox.items().length, 0)
})

test('a permission that waits pages the human with a useful title', () => {
  const { clock, inbox, notes } = make()
  inbox.applyEvent({ type: 'session.created', properties: { sessionID: 'ses_1', info: { id: 'ses_1', title: 'Fix the build', time: { created: 1, updated: 2 } } } })
  inbox.applyEvent(perm())
  clock.advance(1600)
  assert.equal(notes.length, 1)
  assert.equal(notes[0].kind, 'permission')
  assert.equal(notes[0].title, 'Run: rm -rf build')
  assert.equal(notes[0].urgency, 'high')
  const item = inbox.items()[0]
  assert.equal(item.kind, 'permission')
  assert.equal(item.session.title, 'Fix the build')
})

test('v2 permission shape is normalized and replies clear it', () => {
  const { clock, inbox } = make()
  inbox.applyEvent({ type: 'permission.v2.asked', properties: { id: 'per_9', sessionID: 'ses_2', action: 'edit', resources: ['/home/u/proj/src/a.ts'], save: [], metadata: {}, source: { messageID: 'm', callID: 'c' } } })
  const p = inbox.permissions.get('per_9')
  assert.equal(p.permission, 'edit')
  assert.deepEqual(p.patterns, ['/home/u/proj/src/a.ts'])
  assert.equal(p.v2, true)
  assert.equal(permissionTitle(p), 'Edit …/proj/src/a.ts')
  inbox.applyEvent({ type: 'permission.v2.replied', properties: { sessionID: 'ses_2', requestID: 'per_9', reply: 'allow' } })
  clock.advance(5000)
  assert.equal(inbox.permissions.size, 0)
})

test('questions page immediately and are ordered before errors and finished sessions', () => {
  const { clock, inbox, notes } = make()
  inbox.applyEvent({ type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'busy' } } })
  clock.advance(10_000)
  inbox.applyEvent({ type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'idle' } } })
  inbox.applyEvent({ type: 'session.error', properties: { sessionID: 'ses_b', error: { name: 'APIError', data: { message: 'rate limited' } } } })
  inbox.applyEvent({ type: 'question.asked', properties: { id: 'que_1', sessionID: 'ses_c', questions: [{ header: 'Framework', question: 'Which framework?', options: [{ label: 'React', description: '' }, { label: 'Svelte', description: '' }] }] } })
  assert.deepEqual(notes.map((n) => n.kind), ['finished', 'error', 'question'])
  assert.deepEqual(inbox.items().map((i) => i.kind), ['question', 'error', 'finished'])
  inbox.markSeen('ses_a')
  inbox.markSeen('ses_b')
  assert.deepEqual(inbox.items().map((i) => i.kind), ['question'])
})

test('short busy blips (title generation etc.) do not count as finished', () => {
  const { clock, inbox, notes } = make()
  inbox.applyEvent({ type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'busy' } } })
  clock.advance(800)
  inbox.applyEvent({ type: 'session.status', properties: { sessionID: 'ses_a', status: { type: 'idle' } } })
  assert.equal(notes.length, 0)
})

test('aborts are not errors; subagent sessions do not page on finish', () => {
  const { clock, inbox, notes } = make()
  inbox.applyEvent({ type: 'session.error', properties: { sessionID: 'ses_a', error: { name: 'MessageAbortedError', data: { message: 'aborted' } } } })
  inbox.applyEvent({ type: 'session.created', properties: { sessionID: 'ses_sub', info: { id: 'ses_sub', parentID: 'ses_a', title: 'child', time: { created: 1, updated: 1 } } } })
  inbox.applyEvent({ type: 'session.status', properties: { sessionID: 'ses_sub', status: { type: 'busy' } } })
  clock.advance(10_000)
  inbox.applyEvent({ type: 'session.idle', properties: { sessionID: 'ses_sub' } })
  assert.equal(notes.length, 0)
  assert.equal(inbox.snapshot().sessions.length, 0, 'child sessions are hidden from the session list')
})

test('reconcile replaces pending state with REST truth and notifies only for new items', () => {
  const { clock, inbox, notes } = make()
  inbox.applyEvent(perm('per_old'))
  clock.advance(2000)
  assert.equal(notes.length, 1)
  inbox.reconcile({
    sessions: [{ id: 'ses_1', title: 'T', time: { created: 1, updated: 5 } }],
    status: { ses_1: { type: 'busy' } },
    permissions: [{ id: 'per_new', sessionID: 'ses_1', permission: 'bash', patterns: ['ls'], metadata: {}, always: [] }],
    questions: [],
  })
  assert.deepEqual([...inbox.permissions.keys()], ['per_new'])
  clock.advance(2000)
  assert.equal(notes.length, 2)
  assert.equal(inbox.snapshot().sessions[0].status, 'busy')
  assert.equal(inbox.snapshot().counts.busy, 1)
})

test('normalizePermission tolerates missing fields', () => {
  const p = normalizePermission({ id: 'per_x', sessionID: 'ses_x' })
  assert.equal(p.permission, 'unknown')
  assert.deepEqual(p.patterns, [])
  assert.equal(permissionTitle(p), 'Permission: unknown')
})
