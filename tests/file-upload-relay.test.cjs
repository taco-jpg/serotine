const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { test } = require('node:test')
const ts = require('typescript')
const root = path.join(__dirname, '..')
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
        async first() { return sqlite.prepare(sql).get(...values) ?? null },
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
    async put(key, value) {
      if (state.beforePut) await state.beforePut()
      objects.set(key, value.slice(0))
      if (state.afterPut) await state.afterPut()
    },
    async get(key) {
      const value = objects.get(key)
      return value ? { size: value.byteLength, body: new Blob([value]).stream() } : null
    },
    async delete(keys) {
      if (state.failDelete) throw new Error('R2 delete unavailable')
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key)
    },
  }
  const env = { serotine_db: db, serotine_files: bucket }
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

test('file service advertises absent R2 cleanly and rejects unsigned/cross-origin/malformed traffic before storage', async t => {
  const h = harness(t)
  delete h.env.serotine_files
  assert.equal((await (await h.routes.GET(new Request(`${origin}/api/files`))).json()).available, false)
  assert.equal((await h.post({ version: 1, action: 'file:init', data: {}, proof: {} })).status, 400)
  assert.equal((await h.post({}, { origin: 'https://other.example' })).status, 403)
  const who = await h.identity()
  const attempt = await h.init(who)
  assert.equal(attempt.response.status, 503)
  assert.equal(attempt.receipt.code, 'files-unavailable')
  assert.equal(h.queries.length, 0)
  let cancelled = false
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(9000)) }, cancel() { cancelled = true } })
  assert.equal((await h.routes.POST(new Request(`${origin}/api/files`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' }))).status, 413)
  assert.equal(cancelled, true)
})

test('staging sends only ciphertext and becomes readable with signed capability after publish', async t => {
  const h = harness(t)
  const [alice, bob] = await Promise.all([h.identity(), h.identity()])
  const plain = new TextEncoder().encode('private file').buffer
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain)
  const upload = await h.init(alice, plain.byteLength)
  assert.equal(upload.response.status, 200)
  assert.equal(upload.receipt.expiresAt, h.state.now + h.protocol.FILE_UPLOAD_STAGING_TTL_MS)
  assert.equal((await h.chunk(alice, upload, encrypted)).status, 200)
  assert.equal((await h.read(bob, upload)).status, 404, 'staged data cannot be read even with capability')
  assert.equal((await h.complete(alice, upload)).status, 200)
  assert.equal((await h.read(bob, upload)).status, 404, 'ready draft remains private until Send')
  const published = await (await h.publish(alice, upload)).json()
  assert.equal(published.status, 'published')
  assert.equal(published.expiresAt, h.state.now + h.protocol.FILE_UPLOAD_RETENTION_TTL_MS)
  assert.equal((await h.read(bob, upload, '0'.repeat(64))).status, 404)
  const read = await h.read(bob, upload)
  assert.equal(read.status, 200)
  assert.equal(read.headers.get('content-type'), 'application/octet-stream')
  const bytes = await read.arrayBuffer()
  assert.equal(read.headers.get('x-serotine-file-digest'), await h.protocol.fileUploadDigest(bytes))
  assert.deepEqual(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, bytes), plain)
  const stored = JSON.stringify(h.sqlite.prepare('SELECT * FROM FileUpload').get())
  assert.equal(stored.includes(upload.capability), false)
  assert.equal(new TextDecoder().decode(h.objects.values().next().value).includes('private file'), false)
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'RelayEvent'").get().n, 0)
})

test('signed chunk hashes reject tampering; owner proof, nonce, index and exact chunk lengths are enforced', async t => {
  const h = harness(t)
  const [alice, bob] = await Promise.all([h.identity(), h.identity()])
  const upload = await h.init(alice, 3)
  const bytes = new Uint8Array(19).buffer
  assert.equal((await h.chunk(bob, upload, bytes)).status, 404)
  assert.equal((await h.chunk(alice, upload, bytes, 1)).status, 400)
  assert.equal((await h.chunk(alice, upload, new Uint8Array(20).buffer)).status, 400)
  const data = { uploadId: upload.uploadId, index: 0, size: 19, digest: await h.protocol.fileUploadDigest(bytes) }
  assert.equal((await h.chunk(alice, upload, new Uint8Array(19).fill(1).buffer, 0, data)).status, 400)
  const body = await h.signed(alice, 'file:complete', { uploadId: upload.uploadId })
  assert.equal((await h.post(body)).status, 409)
  assert.match((await (await h.post(body)).json()).error, /already used/)
  const forged = await h.signed(alice, 'file:complete', { uploadId: upload.uploadId })
  forged.data.uploadId = crypto.randomUUID()
  assert.equal((await h.post(forged)).status, 401)
  assert.equal(h.objects.size, 0)
})

test('chunk retries are idempotent while conflicting writes and incomplete finalize are rejected', async t => {
  const h = harness(t)
  const alice = await h.identity()
  const upload = await h.init(alice, 2)
  const bytes = new Uint8Array(18).buffer
  assert.equal((await h.complete(alice, upload)).status, 409)
  assert.equal((await h.publish(alice, upload)).status, 409)
  const responses = await Promise.all([h.chunk(alice, upload, bytes), h.chunk(alice, upload, bytes)])
  assert.deepEqual(responses.map(response => response.status), [200, 200])
  assert.equal(h.objects.size, 1)
  assert.equal((await h.chunk(alice, upload, new Uint8Array(18).fill(1).buffer)).status, 409)
  assert.equal((await h.complete(alice, upload)).status, 200)
  assert.equal((await h.publish(alice, upload)).status, 200)
  assert.equal((await h.chunk(alice, upload, bytes)).status, 200, 'lost response can be retried after finalization')
  const expiry = (await (await h.publish(alice, upload)).json()).expiresAt
  h.state.now += 1000
  assert.equal((await (await h.publish(alice, upload)).json()).expiresAt, expiry, 'retry cannot extend retention forever')
})

test('1 GiB uses 256 bounded binary chunks; concurrent reservations cannot exceed owner quota', async t => {
  const h = harness(t)
  const alice = await h.identity()
  const size = 1024 * 1024 * 1024
  const attempts = await Promise.all(Array.from({ length: 6 }, () => h.init(alice, size)))
  assert.equal(attempts.filter(result => result.response.status === 200).length, 5)
  assert.equal(attempts.filter(result => result.receipt.code === 'file-quota').length, 1)
  assert.equal(attempts[0].data.chunkCount, 256)
  assert.equal(h.protocol.fileUploadChunkSize(size, 255), 4 * 1024 * 1024 + 16)
  assert.equal((await h.init(alice, size + 1)).response.status, 400)
  const reserved = h.sqlite.prepare('SELECT SUM(reservedBytes) AS bytes FROM FileUpload').get().bytes
  assert.equal(reserved, 5 * size)
  const upload = attempts.find(result => result.response.status === 200)
  assert.equal((await h.request(alice, 'file:delete', { uploadId: upload.uploadId })).status, 200)
  assert.equal((await h.init(alice, size)).response.status, 200)
})

test('a full 1 GiB upload passes through 256 bounded HTTP bodies and finalizes outside the event store', async t => {
  const h = harness(t)
  const alice = await h.identity()
  const upload = await h.init(alice, h.protocol.MAX_FILE_UPLOAD_BYTES)
  const bytes = new Uint8Array(h.protocol.FILE_UPLOAD_CHUNK_BYTES + 16).buffer
  const digest = await h.protocol.fileUploadDigest(bytes)
  let receivedBytes = 0
  const keys = new Set()
  // A sink preserves the real HTTP/digest/SQLite path without allocating 1 GiB
  // inside the test process just to stand in for object storage.
  h.bucket.put = async (key, value) => {
    assert.equal(value.byteLength, bytes.byteLength)
    assert.equal(keys.has(key), false)
    keys.add(key)
    receivedBytes += value.byteLength
  }
  for (let index = 0; index < 256; index += 1) {
    const response = await h.chunk(alice, upload, bytes, index, { uploadId: upload.uploadId, index, size: bytes.byteLength, digest })
    assert.equal(response.status, 200, `chunk ${index}`)
  }
  assert.equal(receivedBytes, h.protocol.MAX_FILE_UPLOAD_BYTES + 16 * 256)
  assert.equal((await h.complete(alice, upload)).status, 200)
  assert.equal((await (await h.publish(alice, upload)).json()).status, 'published')
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM FileUploadChunk WHERE ready = 1').get().n, 256)
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'RelayEvent'").get().n, 0)
})

test('a cancelled draft physically removes ciphertext and cannot be revived or cancel another identity upload', async t => {
  const h = harness(t)
  const [alice, bob] = await Promise.all([h.identity(), h.identity()])
  const upload = await h.init(alice, 3)
  assert.equal((await h.chunk(alice, upload, new Uint8Array(19).buffer)).status, 200)
  assert.equal((await h.request(bob, 'file:delete', { uploadId: upload.uploadId })).status, 404)
  assert.equal((await h.request(alice, 'file:delete', { uploadId: upload.uploadId })).status, 200)
  assert.equal(h.objects.size, 0)
  assert.equal((await h.complete(alice, upload)).status, 410)
  assert.equal((await h.publish(alice, upload)).status, 410)
  assert.equal((await h.request(alice, 'file:init', upload.data)).status, 410)
  assert.equal((await h.chunk(alice, upload, new Uint8Array(19).buffer)).status, 410)
})

test('a chunk completing after cancellation is physically deleted and cannot restore the draft', async t => {
  const h = harness(t)
  const alice = await h.identity()
  const upload = await h.init(alice, 3)
  h.state.beforePut = async () => {
    h.state.beforePut = null
    assert.equal((await h.request(alice, 'file:delete', { uploadId: upload.uploadId })).status, 200)
  }
  assert.equal((await h.chunk(alice, upload, new Uint8Array(19).buffer)).status, 410)
  assert.equal(h.objects.size, 0)
  assert.equal(h.sqlite.prepare('SELECT status, reservedBytes FROM FileUpload').get().status, 'deleted')
})

test('discard after publish preserves ciphertext, including a simultaneous Send/discard race', async t => {
  const h = harness(t)
  const alice = await h.identity()
  const upload = await h.init(alice, 3)
  await h.chunk(alice, upload, new Uint8Array(19).buffer)
  await h.complete(alice, upload)
  await h.publish(alice, upload)
  assert.equal((await (await h.request(alice, 'file:delete', { uploadId: upload.uploadId })).json()).status, 'published')
  assert.equal(h.objects.size, 1)
  assert.equal((await h.read(alice, upload)).status, 200)
  const second = await h.init(alice, 3)
  await h.chunk(alice, second, new Uint8Array(19).buffer)
  await h.complete(alice, second)
  await Promise.all([h.publish(alice, second), h.request(alice, 'file:delete', { uploadId: second.uploadId })])
  const state = h.sqlite.prepare('SELECT status FROM FileUpload WHERE uploadId = ?').get(second.uploadId).status
  assert.ok(state === 'published' || state === 'deleted')
  assert.equal((await h.read(alice, second)).status, state === 'published' ? 200 : 410)
})

test('expiry blocks reads immediately and cleanup physically reclaims orphaned data, retaining quota on deletion failure', async t => {
  const h = harness(t)
  const alice = await h.identity()
  const upload = await h.init(alice, 3)
  await h.chunk(alice, upload, new Uint8Array(19).buffer)
  h.state.now += h.protocol.FILE_UPLOAD_STAGING_TTL_MS + 1
  assert.equal((await h.complete(alice, upload)).status, 410)
  h.state.failDelete = true
  assert.equal((await h.request(alice, 'file:cleanup', {})).status, 503)
  assert.equal(h.sqlite.prepare('SELECT reservedBytes FROM FileUpload').get().reservedBytes, 3)
  assert.equal(h.objects.size, 1)
  h.state.failDelete = false
  assert.equal((await h.request(alice, 'file:cleanup', {})).status, 200)
  assert.equal(h.objects.size, 0)
  assert.equal(h.sqlite.prepare('SELECT reservedBytes FROM FileUpload').get().reservedBytes, 0)
  // Simulate an isolate that stopped after its late R2 write; retained keys are swept again.
  h.objects.set(`encrypted-files/v1/${upload.uploadId}/0`, new Uint8Array(19).buffer)
  h.state.now += 60 * 60_000 + 1
  await h.request(alice, 'file:cleanup', {})
  assert.equal(h.objects.size, 0)
})

test('published retention is 30 days and retired identities cannot operate uploads', async t => {
  const h = harness(t)
  const [alice, bob] = await Promise.all([h.identity(), h.identity()])
  const upload = await h.init(alice, 3)
  await h.chunk(alice, upload, new Uint8Array(19).buffer)
  await h.complete(alice, upload)
  await h.publish(alice, upload)
  h.state.now += h.protocol.FILE_UPLOAD_RETENTION_TTL_MS + 1
  assert.equal((await h.read(bob, upload)).status, 410)
  await h.request(bob, 'file:cleanup', {})
  assert.equal(h.objects.size, 0)
  h.sqlite.prepare('INSERT INTO RetiredIdentity(publicKey, retiredAt) VALUES (?, ?)').run(alice.publicKey, h.state.now)
  assert.equal((await h.init(alice)).response.status, 403)
})

test('cleanup rechecks expiry atomically if publication changed a selected row', async t => {
  const h = harness(t)
  const alice = await h.identity()
  const upload = await h.init(alice, 3)
  await h.chunk(alice, upload, new Uint8Array(19).buffer)
  await h.complete(alice, upload)
  h.state.now += h.protocol.FILE_UPLOAD_STAGING_TTL_MS + 1
  h.state.afterCleanupRead = () => {
    // Model another Worker publishing from an earlier transaction boundary.
    h.sqlite.prepare("UPDATE FileUpload SET status = 'published', expiresAt = ? WHERE uploadId = ?")
      .run(h.state.now + h.protocol.FILE_UPLOAD_RETENTION_TTL_MS, upload.uploadId)
  }
  assert.equal((await h.request(alice, 'file:cleanup', {})).status, 200)
  assert.equal(h.objects.size, 1)
  assert.equal((await h.read(alice, upload)).status, 200)
})

test('global reservations and init rate are bounded even with separate identities', async t => {
  const h = harness(t)
  const alice = await h.identity()
  const upload = await h.init(alice, 3)
  h.sqlite.prepare('UPDATE FileUpload SET reservedBytes = ? WHERE uploadId = ?').run(h.protocol.FILE_UPLOAD_TOTAL_QUOTA_BYTES, upload.uploadId)
  const bob = await h.identity()
  assert.equal((await h.init(bob)).receipt.code, 'file-quota')
  h.sqlite.prepare('UPDATE FileUpload SET reservedBytes = 0').run()
  const attempts = await Promise.all(Array.from({ length: 21 }, () => h.init(bob)))
  assert.ok(attempts.some(result => /Too many file requests/.test(result.receipt.error)))
  assert.ok(h.sqlite.prepare('SELECT COUNT(*) AS n FROM FileUpload WHERE owner = ?').get(bob.publicKey).n <= 20)
})

test('file migration and runtime bootstrap produce the same schema', t => {
  const h = harness(t)
  const migrated = new DatabaseSync(':memory:')
  t.after(() => migrated.close())
  migrated.exec(fs.readFileSync(path.join(root, 'migrations/0006_encrypted_file_uploads.sql'), 'utf8'))
  for (const sql of h.load(path.join(root, 'lib/file-upload-schema.ts')).FILE_UPLOAD_SCHEMA) h.sqlite.exec(sql)
  const schema = db => db.prepare("SELECT name, type, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => ({ ...row, sql: row.sql.replace(/\s+/g, ' ').trim() }))
  assert.deepEqual(schema(h.sqlite), schema(migrated))
})
