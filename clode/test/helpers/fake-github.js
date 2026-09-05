// The slice of api.github.com clode uses: refs, commits, trees, blobs, pulls, actions. Objects live in memory.
import http from 'node:http'
import { createHash } from 'node:crypto'

const sha1 = (s) => createHash('sha1').update(s).digest('hex')

export function startFakeGitHub({ owner = 'octo', repo = 'proj', branch = 'main', files = { 'README.md': '# proj\n', 'src/a.js': 'export const a = 1\n' }, token = 'ghp_test', runs = [] } = {}) {
  const blobs = new Map() // sha -> text
  const trees = new Map() // sha -> [{path, mode, type, sha}]
  const commits = new Map() // sha -> { sha, tree, parents, message }
  const refs = new Map() // branch -> sha
  const pulls = []
  const log = []
  const makeTree = (entries) => { const sha = sha1('tree' + JSON.stringify(entries)); trees.set(sha, entries); return sha }
  const makeCommit = (message, tree, parents) => { const sha = sha1('commit' + message + tree + parents.join()); commits.set(sha, { sha, tree, parents, message, html_url: `https://github.com/${owner}/${repo}/commit/${sha}` }); return sha }
  const flat = (treeSha) => trees.get(treeSha).map((e) => ({ ...e, size: blobs.get(e.sha)?.length ?? 0 }))
  // seed
  const entries = Object.entries(files).map(([path, content]) => { const sha = sha1('blob' + content); blobs.set(sha, content); return { path, mode: '100644', type: 'blob', sha } })
  refs.set(branch, makeCommit('initial', makeTree(entries), []))

  const server = http.createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    const url = new URL(req.url, 'http://x')
    const p = url.pathname
    log.push({ method: req.method, path: p })
    const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (req.headers.authorization !== `Bearer ${token}`) return json(401, { message: 'Bad credentials' })
    const base = `/repos/${owner}/${repo}`
    let m
    if (p === '/user') return json(200, { login: owner })
    if (p === '/user/repos') return json(200, [{ full_name: `${owner}/${repo}`, name: repo, owner: { login: owner }, default_branch: branch, private: false, pushed_at: '2026-09-01T00:00:00Z' }])
    if (p === base) return json(200, { full_name: `${owner}/${repo}`, default_branch: branch, private: false })
    if (p === `${base}/branches`) return json(200, [...refs.keys()].map((name) => ({ name, commit: { sha: refs.get(name) } })))
    if ((m = p.match(new RegExp(`^${base}/git/ref/heads/(.+)$`)))) { const b = decodeURIComponent(m[1]); if (!refs.has(b)) return json(404, { message: 'Not Found' }); return json(200, { ref: `refs/heads/${b}`, object: { sha: refs.get(b), type: 'commit' } }) }
    if ((m = p.match(new RegExp(`^${base}/git/commits/([0-9a-f]+)$`)))) { const c = commits.get(m[1]); if (!c) return json(404, { message: 'no commit' }); return json(200, { sha: c.sha, message: c.message, tree: { sha: c.tree }, parents: c.parents.map((sha) => ({ sha })), html_url: c.html_url }) }
    if ((m = p.match(new RegExp(`^${base}/git/trees/([0-9a-f]+)$`)))) { if (!trees.has(m[1])) return json(404, { message: 'no tree' }); return json(200, { sha: m[1], tree: flat(m[1]), truncated: false }) }
    if ((m = p.match(new RegExp(`^${base}/git/blobs/([0-9a-f]+)$`))) && req.method === 'GET') { const t = blobs.get(m[1]); if (t === undefined) return json(404, { message: 'no blob' }); const b64 = Buffer.from(t).toString('base64').replace(/(.{60})/g, '$1\n'); return json(200, { sha: m[1], size: t.length, encoding: 'base64', content: b64 }) }
    if (p === `${base}/git/blobs` && req.method === 'POST') { const { content, encoding } = JSON.parse(body); const text = encoding === 'base64' ? Buffer.from(content, 'base64').toString() : content; const sha = sha1('blob' + text); blobs.set(sha, text); return json(201, { sha }) }
    if (p === `${base}/git/trees` && req.method === 'POST') {
      const { base_tree, tree } = JSON.parse(body)
      const map = new Map((base_tree ? trees.get(base_tree) : []).map((e) => [e.path, e]))
      for (const e of tree) { if (e.sha === null) map.delete(e.path); else map.set(e.path, { path: e.path, mode: e.mode, type: 'blob', sha: e.sha }) }
      return json(201, { sha: makeTree([...map.values()]) })
    }
    if (p === `${base}/git/commits` && req.method === 'POST') { const { message, tree, parents } = JSON.parse(body); const sha = makeCommit(message, tree, parents); return json(201, { sha, html_url: commits.get(sha).html_url }) }
    if ((m = p.match(new RegExp(`^${base}/git/refs/heads/(.+)$`))) && req.method === 'PATCH') { const b = decodeURIComponent(m[1]); const { sha, force } = JSON.parse(body); if (!refs.has(b)) return json(422, { message: 'Reference does not exist' }); const c = commits.get(sha); if (!force && !c.parents.includes(refs.get(b))) return json(422, { message: 'Update is not a fast forward' }); refs.set(b, sha); return json(200, { ref: `refs/heads/${b}`, object: { sha } }) }
    if (p === `${base}/git/refs` && req.method === 'POST') { const { ref, sha } = JSON.parse(body); const b = ref.replace('refs/heads/', ''); if (refs.has(b)) return json(422, { message: 'Reference already exists' }); refs.set(b, sha); return json(201, { ref, object: { sha } }) }
    if (p === `${base}/pulls` && req.method === 'POST') { const pr = { number: pulls.length + 1, ...JSON.parse(body), html_url: `https://github.com/${owner}/${repo}/pull/${pulls.length + 1}` }; pulls.push(pr); return json(201, pr) }
    if (p === `${base}/pulls` && req.method === 'GET') return json(200, pulls)
    if (p === `${base}/actions/runs`) { const sha = url.searchParams.get('head_sha'); return json(200, { workflow_runs: runs.filter((r) => r.head_sha === sha || r.head_sha === '*').map((r) => ({ id: r.id, name: r.name, status: r.status, conclusion: r.conclusion, html_url: `https://github.com/${owner}/${repo}/actions/runs/${r.id}` })) }) }
    if ((m = p.match(new RegExp(`^${base}/actions/runs/(\\d+)/jobs$`)))) { const r = runs.find((x) => String(x.id) === m[1]); return json(200, { jobs: r?.jobs || [] }) }
    if ((m = p.match(new RegExp(`^${base}/actions/jobs/(\\d+)/logs$`)))) { const job = runs.flatMap((r) => r.jobs || []).find((j) => String(j.id) === m[1]); if (!job?.log) return json(404, { message: 'no log' }); res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(job.log) }
    json(404, { message: `fake github: no route ${req.method} ${p}` })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, refs, commits, blobs, trees, pulls, log, url: `http://127.0.0.1:${server.address().port}`, fileAt(b, path) { const c = commits.get(refs.get(b)); const e = trees.get(c.tree).find((x) => x.path === path); return e ? blobs.get(e.sha) : undefined }, close: () => new Promise((r) => server.close(() => r())) })))
}
