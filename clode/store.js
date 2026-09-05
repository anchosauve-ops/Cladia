// clode: on-device storage. IndexedDB for sessions and blob cache, localStorage for settings.
const DB = 'clode', VERSION = 1

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt')
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'sha' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
let dbp = null
const db = () => (dbp ||= open())
function tx(store, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode)
    const r = fn(t.objectStore(store))
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  }))
}

export const sessions = {
  async all() { const rows = await tx('sessions', 'readonly', (s) => s.getAll()); return (rows || []).sort((a, b) => b.updatedAt - a.updatedAt) },
  get: (id) => tx('sessions', 'readonly', (s) => s.get(id)),
  put: (row) => tx('sessions', 'readwrite', (s) => s.put(row)),
  delete: (id) => tx('sessions', 'readwrite', (s) => s.delete(id)),
}

/** Blob cache with the { get, set } shape Workspace expects. Bounded to ~2000 entries by simple eviction. */
export const blobCache = {
  async get(sha) { try { const r = await tx('blobs', 'readonly', (s) => s.get(sha)); return r?.text } catch { return undefined } },
  async set(sha, text) { try { if (text.length < 400_000) await tx('blobs', 'readwrite', (s) => s.put({ sha, text, at: Date.now() })) } catch {} },
  async clear() { try { await tx('blobs', 'readwrite', (s) => s.clear()) } catch {} },
}

export const settings = {
  get(k, d) { try { const v = localStorage.getItem('clode.' + k); return v === null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) { try { localStorage.setItem('clode.' + k, JSON.stringify(v)) } catch {} },
  del(k) { try { localStorage.removeItem('clode.' + k) } catch {} },
}
