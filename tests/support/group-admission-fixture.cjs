const { DatabaseSync } = require('node:sqlite')
module.exports = function groupDatabase() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('CREATE TABLE RequestNonce(publicKey TEXT,nonce TEXT,action TEXT,expiresAt INTEGER,PRIMARY KEY(publicKey,nonce)); CREATE TABLE RetiredIdentity(publicKey TEXT PRIMARY KEY,retiredAt INTEGER)')
  const db = { prepare(sql) {
    let values = []
    const statement = { bind(...args) { values = args; return statement },
      async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } } },
      async first() { return sqlite.prepare(sql).get(...values) ?? null },
      async all() { return { results: sqlite.prepare(sql).all(...values) } } }
    return statement
  } }
  const objects = new Map(), state = { failDelete: false }
  const bucket = {
    async put(key, bytes) { objects.set(key, bytes.slice(0)) },
    async get(key) { const bytes = objects.get(key); return bytes ? { size: bytes.byteLength, arrayBuffer: async () => bytes.slice(0), body: new Blob([bytes]).stream() } : null },
    async delete(keys) { if (state.failDelete) throw new Error('R2 delete unavailable'); for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key) },
  }
  const env = { SEROTINE_STORAGE_VERSION: '1', serotine_db: db, serotine_files: bucket }
  return { sqlite, db, objects, state, bucket, env }
}
