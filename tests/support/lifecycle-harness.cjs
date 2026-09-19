const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const ts = require('typescript')
const root = path.join(__dirname, '../..')
const origin = 'https://serotine.example'

function harness(t) {
  const sqlite = new DatabaseSync(':memory:')
  t.after(() => sqlite.close())
  const state = { now: Date.now() }
  class Clock extends Date { static now() { return state.now } }
  const objects = new Map()
  const queries = []
  const db = {
    prepare(sql) {
      queries.push(sql)
      let values = []
      return {
        bind(...args) { values = args; return this },
        execute() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } } },
        async run() { return this.execute() },
        async first() {
          const row = sqlite.prepare(sql).get(...values) ?? null
          if (state.afterScopeRead && sql === "SELECT closedAt, boundaryAt FROM RetentionScope WHERE scopeId = ?") {
            const hook = state.afterScopeRead; state.afterScopeRead = null; await hook()
          }
          return row
        },
        async all() {
          const results = sqlite.prepare(sql).all(...values)
          if (state.afterCleanupRead && sql.includes('ORDER BY cleanupAt, expiresAt LIMIT')) {
            const hook = state.afterCleanupRead; state.afterCleanupRead = null; await hook()
          }
          return { results }
        },
      }
    },
    async batch(statements) {
      sqlite.exec('BEGIN')
      try { const result = statements.map(item => item.execute()); sqlite.exec('COMMIT'); return result }
      catch (error) { sqlite.exec('ROLLBACK'); throw error }
    },
  }
  const bucket = {
    async put(key, value, options) {
      if (state.beforePut) await state.beforePut()
      if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null
      objects.set(key, value.slice(0))
      if (state.afterPut) await state.afterPut()
    },
    async get(key) {
      const value = objects.get(key)
      return value ? { size: value.byteLength, body: new Blob([value]).stream(), arrayBuffer: async () => value.slice(0) } : null
    },
    async delete(keys) {
      if (state.failDelete) throw new Error('R2 delete unavailable')
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key)
    },
  }
  const env = { SEROTINE_STORAGE_VERSION: '1', serotine_db: db, serotine_files: bucket }
  const cache = new Map()
  function load(filename) {
    if (!path.extname(filename)) filename += '.ts'
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }; cache.set(filename, module)
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const sourceRequire = specifier => {
      if (specifier === '@opennextjs/cloudflare') return { getCloudflareContext: async () => ({ env }) }
      if (specifier.startsWith('@/')) return load(path.join(root, specifier.slice(2)))
      if (specifier.startsWith('.')) return load(path.resolve(path.dirname(filename), specifier))
      return require(specifier)
    }
    new Function('require', 'module', 'exports', 'Date', output)(sourceRequire, module, module.exports, Clock)
    return module.exports
  }
  const routes = load(path.join(root, 'app/api/files/route.ts'))
  const cryptography = load(path.join(root, 'lib/crypto.ts'))
  const auth = load(path.join(root, 'lib/request-auth.ts'))
  const protocol = load(path.join(root, 'lib/file-upload-protocol.ts'))
  async function identity() {
    const pair = await cryptography.generateEncryptionKeyPair()
    return { privateKey: await cryptography.exportKey(pair.privateKey), publicKey: await cryptography.exportPublicKeyToHex(pair.publicKey) }
  }
  async function signed(who, action, data) { return { version: 1, action, data, proof: await auth.createRequestProof(action, data, who.privateKey, who.publicKey) } }
  function post(body, headers = {}) { return routes.POST(new Request(`${origin}/api/files`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })) }
  async function request(who, action, data) { return post(await signed(who, action, data)) }
  async function init(who, size = 12, uploadId = crypto.randomUUID()) {
    const capability = protocol.fileUploadDigest(crypto.getRandomValues(new Uint8Array(32)).buffer)
    const token = await capability
    const data = { uploadId, size, chunkCount: protocol.fileUploadChunkCount(size), accessHash: await protocol.fileUploadDigest(new TextEncoder().encode(token).buffer) }
    const response = await request(who, 'file:init', data)
    return { uploadId, capability: token, data, response, receipt: await response.json() }
  }
  async function chunk(who, upload, bytes, index = 0, signedData) {
    const data = signedData ?? { uploadId: upload.uploadId, index, size: bytes.byteLength, digest: await protocol.fileUploadDigest(bytes) }
    const body = await signed(who, 'file:chunk', data)
    return routes.PUT(new Request(`${origin}/api/files`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-serotine-file-request': JSON.stringify(body) }, body: bytes }))
  }
  async function complete(who, upload) { return request(who, 'file:complete', { uploadId: upload.uploadId }) }
  async function publish(who, upload) { return request(who, 'file:publish', { uploadId: upload.uploadId }) }
  async function read(who, upload, capability = upload.capability, index = 0) { return request(who, 'file:read', { uploadId: upload.uploadId, index, capability }) }
  return { sqlite, state, db, bucket, env, objects, queries, load, routes, cryptography, auth, protocol, identity, signed, post, request, init, chunk, complete, publish, read }
}

module.exports = { harness, root, origin }
