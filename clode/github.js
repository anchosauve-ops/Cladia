// clode: GitHub as the filesystem. A lazy tree over the Git Data API plus a local overlay of edits,
// committed in one shot (blobs -> tree -> commit -> ref). Works from the browser: api.github.com allows CORS.

export class GitHubError extends Error {
  constructor(status, message, path) { super(`GitHub ${status} on ${path}: ${message}`); this.status = status; this.path = path }
}

export class GitHub {
  constructor({ token, baseUrl = 'https://api.github.com', fetch: f = globalThis.fetch } = {}) {
    this.token = token
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.fetch = (url, init) => f(url, init) // never call window.fetch as a method of another object
  }
  async req(method, path, body, { raw = false, headers = {} } = {}) {
    const h = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...headers }
    if (this.token) h.authorization = `Bearer ${this.token}`
    if (body !== undefined) h['content-type'] = 'application/json'
    const res = await this.fetch(this.baseUrl + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined })
    if (raw) return res
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    if (!res.ok) throw new GitHubError(res.status, data?.message || (typeof data === 'string' ? data.slice(0, 200) : `HTTP ${res.status}`), path)
    return data
  }
  get(path, opts) { return this.req('GET', path, undefined, opts) }
  post(path, body) { return this.req('POST', path, body) }
  patch(path, body) { return this.req('PATCH', path, body) }

  me() { return this.get('/user') }
  async repos({ page = 1 } = {}) { return this.get(`/user/repos?sort=pushed&per_page=50&page=${page}&affiliation=owner,collaborator,organization_member`) }
  repo(owner, repo) { return this.get(`/repos/${owner}/${repo}`) }
  branches(owner, repo) { return this.get(`/repos/${owner}/${repo}/branches?per_page=100`) }
  async headSha(owner, repo, branch) {
    const r = await this.get(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch).replace(/%2F/g, '/')}`)
    return r.object.sha
  }
  async commit(owner, repo, sha) { return this.get(`/repos/${owner}/${repo}/git/commits/${sha}`) }
  async tree(owner, repo, sha) { return this.get(`/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`) }
  async blob(owner, repo, sha) { return this.get(`/repos/${owner}/${repo}/git/blobs/${sha}`) }
  createBlob(owner, repo, content, encoding = 'utf-8') { return this.post(`/repos/${owner}/${repo}/git/blobs`, { content, encoding }) }
  createTree(owner, repo, base_tree, tree) { return this.post(`/repos/${owner}/${repo}/git/trees`, { base_tree, tree }) }
  createCommit(owner, repo, message, tree, parents) { return this.post(`/repos/${owner}/${repo}/git/commits`, { message, tree, parents }) }
  updateRef(owner, repo, branch, sha) { return this.patch(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, { sha, force: false }) }
  createRef(owner, repo, branch, sha) { return this.post(`/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha }) }
  createPull(owner, repo, { title, body, head, base, draft = false }) { return this.post(`/repos/${owner}/${repo}/pulls`, { title, body, head, base, draft }) }
  pulls(owner, repo, head) { return this.get(`/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(owner + ':' + head)}`) }
  runsFor(owner, repo, sha) { return this.get(`/repos/${owner}/${repo}/actions/runs?head_sha=${sha}&per_page=20`) }
  jobs(owner, repo, runId) { return this.get(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=50`) }
  async jobLogs(owner, repo, jobId) {
    // Redirects to a signed storage URL; browsers may refuse it (no CORS there). Callers fall back to step summaries.
    const res = await this.req('GET', `/repos/${owner}/${repo}/actions/jobs/${jobId}/logs`, undefined, { raw: true })
    if (!res.ok) throw new GitHubError(res.status, 'logs unavailable', 'logs')
    return res.text()
  }
  dispatchWorkflow(owner, repo, workflowId, ref, inputs = {}) { return this.post(`/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`, { ref, inputs }) }
  workflows(owner, repo) { return this.get(`/repos/${owner}/${repo}/actions/workflows`) }
}

const SKIP_DIRS = /(^|\/)(node_modules|\.git|dist|build|\.next|vendor|__pycache__|\.venv|target)\//
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|jar|woff2?|ttf|otf|mp[34]|mov|avi|wasm|so|dylib|exe|bin|lock)$/i

function b64ToUtf8(b64) {
  const clean = b64.replace(/\n/g, '')
  const bin = typeof atob === 'function' ? atob(clean) : Buffer.from(clean, 'base64').toString('binary')
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return { bytes, text: new TextDecoder('utf-8', { fatal: false }).decode(bytes) }
}
function looksBinary(bytes) {
  const n = Math.min(bytes.length, 8000)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
  return false
}

/**
 * A repository at a branch, with a local overlay of pending edits.
 * `cache` is optional: { get(sha) -> text|undefined, set(sha, text) } (clode uses IndexedDB in the browser).
 */
export class Workspace {
  constructor(gh, { owner, repo, branch, cache = new Map() }) {
    this.gh = gh; this.owner = owner; this.repo = repo; this.branch = branch
    this.cache = cache
    this.headSha = null; this.treeSha = null
    this.tree = new Map() // path -> { sha, size, mode }
    this.overlay = new Map() // path -> { content } | { deleted: true }
    this.original = new Map() // path -> original text (for diffs), loaded lazily
    this.truncated = false
  }
  async load() {
    this.headSha = await this.gh.headSha(this.owner, this.repo, this.branch)
    const commit = await this.gh.commit(this.owner, this.repo, this.headSha)
    this.treeSha = commit.tree.sha
    const t = await this.gh.tree(this.owner, this.repo, this.treeSha)
    this.tree = new Map()
    for (const e of t.tree || []) if (e.type === 'blob') this.tree.set(e.path, { sha: e.sha, size: e.size, mode: e.mode })
    this.truncated = !!t.truncated
    return this
  }
  get changes() {
    const out = []
    for (const [path, v] of this.overlay) out.push({ path, deleted: !!v.deleted, added: !this.tree.has(path) })
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }
  listFiles({ path = '', glob = '' } = {}) {
    const prefix = path.replace(/^\/+|\/+$/g, '')
    const re = glob ? globToRegex(glob) : null
    const paths = new Set()
    for (const p of this.tree.keys()) if (!this.overlay.get(p)?.deleted) paths.add(p)
    for (const [p, v] of this.overlay) if (!v.deleted) paths.add(p)
    return [...paths].filter((p) => (!prefix || p === prefix || p.startsWith(prefix + '/')) && (!re || re.test(p))).sort()
  }
  exists(path) { const o = this.overlay.get(path); if (o) return !o.deleted; return this.tree.has(path) }
  async readFile(path) {
    const o = this.overlay.get(path)
    if (o) { if (o.deleted) throw new Error(`${path} was deleted in this session`); return o.content }
    const entry = this.tree.get(path)
    if (!entry) throw new Error(`No such file: ${path}`)
    return this.readBlob(entry.sha, path)
  }
  async readBlob(sha, path) {
    const cached = await this.cache.get(sha)
    if (cached !== undefined) return cached
    if (BINARY_EXT.test(path)) throw new Error(`${path} is a binary file`)
    const b = await this.gh.blob(this.owner, this.repo, sha)
    const { bytes, text } = b64ToUtf8(b.content)
    if (looksBinary(bytes)) throw new Error(`${path} is a binary file`)
    await this.cache.set(sha, text)
    return text
  }
  async original_(path) {
    if (this.original.has(path)) return this.original.get(path)
    const entry = this.tree.get(path)
    const text = entry ? await this.readBlob(entry.sha, path).catch(() => null) : null
    this.original.set(path, text)
    return text
  }
  async writeFile(path, content) {
    path = normalize(path)
    await this.original_(path)
    if (content === (await this.original_(path))) { this.overlay.delete(path); return { path, unchanged: true } }
    this.overlay.set(path, { content })
    return { path, created: !this.tree.has(path) }
  }
  async editFile(path, oldString, newString, { replaceAll = false } = {}) {
    path = normalize(path)
    const text = await this.readFile(path)
    if (oldString === '') throw new Error('old_string must not be empty')
    const count = text.split(oldString).length - 1
    if (count === 0) throw new Error(`old_string not found in ${path}. Read the file again and copy the text exactly, including whitespace.`)
    if (count > 1 && !replaceAll) throw new Error(`old_string occurs ${count} times in ${path}; include more surrounding context to make it unique, or set replace_all.`)
    const next = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString)
    await this.writeFile(path, next)
    return { path, replacements: replaceAll ? count : 1 }
  }
  async deleteFile(path) {
    path = normalize(path)
    if (!this.exists(path)) throw new Error(`No such file: ${path}`)
    if (!this.tree.has(path)) { this.overlay.delete(path); return { path, deleted: true } }
    this.overlay.set(path, { deleted: true })
    return { path, deleted: true }
  }
  discard(path) { if (path) this.overlay.delete(path); else this.overlay.clear() }
  /** Search file contents. Fetches lazily; bounded so a phone on cellular stays responsive. */
  async search(pattern, { path = '', regex = false, maxFiles = 300, maxMatches = 100, maxBytes = 200_000 } = {}) {
    const re = regex ? new RegExp(pattern, 'i') : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    const files = this.listFiles({ path }).filter((p) => !SKIP_DIRS.test(p) && !BINARY_EXT.test(p))
    const matches = []
    let scanned = 0, skipped = 0
    for (const p of files) {
      if (scanned >= maxFiles) { skipped++; continue }
      const entry = this.tree.get(p)
      if (entry && entry.size > maxBytes && !this.overlay.has(p)) { skipped++; continue }
      let text
      try { text = await this.readFile(p) } catch { continue }
      scanned++
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) { matches.push({ path: p, line: i + 1, text: lines[i].slice(0, 200) }); if (matches.length >= maxMatches) return { matches, scanned, skipped, truncated: true } }
      }
    }
    return { matches, scanned, skipped, truncated: false }
  }
  /** Unified diff of all pending changes. */
  async diff() {
    const out = []
    for (const c of this.changes) {
      const before = c.added ? '' : (await this.original_(c.path)) ?? ''
      const after = c.deleted ? '' : this.overlay.get(c.path).content
      out.push({ path: c.path, added: c.added, deleted: c.deleted, patch: unifiedDiff(before, after, c.path), ...countChanges(before, after) })
    }
    return out
  }
  /**
   * Commit the overlay to `branch` (default: the workspace branch). Creates the branch from the current head if it does not exist.
   * Returns { sha, url, branch, files }.
   */
  async commit(message, { branch } = {}) {
    if (this.overlay.size === 0) throw new Error('Nothing to commit')
    const target = branch || this.branch
    let parent
    try { parent = await this.gh.headSha(this.owner, this.repo, target) } catch (e) { if (e.status !== 404) throw e; parent = null }
    const baseCommit = await this.gh.commit(this.owner, this.repo, parent || this.headSha)
    const entries = []
    for (const [path, v] of this.overlay) {
      if (v.deleted) entries.push({ path, mode: '100644', type: 'blob', sha: null })
      else {
        const blob = await this.gh.createBlob(this.owner, this.repo, v.content, 'utf-8')
        entries.push({ path, mode: this.tree.get(path)?.mode || '100644', type: 'blob', sha: blob.sha })
      }
    }
    const tree = await this.gh.createTree(this.owner, this.repo, baseCommit.tree.sha, entries)
    const commit = await this.gh.createCommit(this.owner, this.repo, message, tree.sha, [parent || this.headSha])
    if (parent) await this.gh.updateRef(this.owner, this.repo, target, commit.sha)
    else await this.gh.createRef(this.owner, this.repo, target, commit.sha)
    // fold the overlay into the tree view
    for (const e of entries) { if (e.sha === null) this.tree.delete(e.path); else this.tree.set(e.path, { sha: e.sha, size: this.overlay.get(e.path).content.length, mode: e.mode }) }
    for (const [path, v] of this.overlay) if (!v.deleted) { await this.cache.set(this.tree.get(path).sha, v.content); this.original.set(path, v.content) }
    const files = [...this.overlay.keys()]
    this.overlay.clear()
    this.branch = target
    this.headSha = commit.sha
    this.treeSha = tree.sha
    return { sha: commit.sha, url: commit.html_url, branch: target, files }
  }
}

function normalize(path) {
  const p = String(path).replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/+$/, '')
  if (!p || p.split('/').includes('..')) throw new Error(`Invalid path: ${path}`)
  return p
}
export function globToRegex(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') { if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++ } else re += '[^/]*' }
    else if (c === '?') re += '[^/]'
    else if ('.+^$(){}|[]\\'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp(`(^|/)${re}$`)
}
function countChanges(a, b) {
  const d = lineDiff(a.split('\n'), b.split('\n'))
  let additions = 0, deletions = 0
  for (const [op] of d) { if (op === '+') additions++; else if (op === '-') deletions++ }
  return { additions, deletions }
}
/** Minimal line diff (LCS) -> [[op, line]] with op in ' ', '+', '-'. Fine for files a phone edits. */
export function lineDiff(a, b) {
  // A trailing newline yields an empty last element; drop it so it is not diffed as a line.
  if (a.length && a[a.length - 1] === '') a = a.slice(0, -1)
  if (b.length && b[b.length - 1] === '') b = b.slice(0, -1)
  const n = a.length, m = b.length
  if (n * m > 4_000_000) { // too big for LCS; fall back to whole-file replace
    return [...a.map((l) => ['-', l]), ...b.map((l) => ['+', l])]
  }
  const dp = new Uint32Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i * (m + 1) + j] = a[i] === b[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1])
  const out = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([' ', a[i]]); i++; j++ }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) out.push(['-', a[i++]])
    else out.push(['+', b[j++]])
  }
  while (i < n) out.push(['-', a[i++]])
  while (j < m) out.push(['+', b[j++]])
  return out
}
export function unifiedDiff(a, b, path, context = 3) {
  const d = lineDiff(a.split('\n'), b.split('\n'))
  const lines = [`--- a/${path}`, `+++ b/${path}`]
  let i = 0
  while (i < d.length) {
    if (d[i][0] === ' ') { i++; continue }
    const start = Math.max(0, i - context)
    let end = i
    while (end < d.length) { if (d[end][0] !== ' ') { end++; continue } let k = end; while (k < d.length && d[k][0] === ' ' && k - end < context * 2) k++; if (k < d.length && d[k][0] !== ' ') { end = k; continue } break }
    end = Math.min(d.length, end + context)
    let aStart = 1, bStart = 1
    for (let k = 0; k < start; k++) { if (d[k][0] !== '+') aStart++; if (d[k][0] !== '-') bStart++ }
    let aLen = 0, bLen = 0
    for (let k = start; k < end; k++) { if (d[k][0] !== '+') aLen++; if (d[k][0] !== '-') bLen++ }
    lines.push(`@@ -${aLen === 0 ? aStart - 1 : aStart},${aLen} +${bLen === 0 ? bStart - 1 : bStart},${bLen} @@`)
    for (let k = start; k < end; k++) lines.push(d[k][0] + d[k][1])
    i = end
  }
  return lines.join('\n')
}
