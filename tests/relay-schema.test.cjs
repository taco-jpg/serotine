/* Actual database setup and server actions against SQLite; only the D1/Worker boundary is substituted. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { test } = require('node:test')
const ts = require('typescript')
const root = path.join(__dirname, '..')
function harness({ legacy = false, batch = true } = {}) {
  const sqlite = new DatabaseSync(':memory:')
  if (legacy) sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0001_init_schema.sql'), 'utf8'))
  const calls = [], state = { fail: null, binding: true }
  const db = {
    prepare(sql) {
      calls.push(sql)
      if (state.fail && state.fail(sql)) throw new Error('Temporary D1 failure')
      const statement = () => sqlite.prepare(sql)
      let args = []
      return {
        bind(...values) { args = values; return this },
        run() { return Promise.resolve(this.execute()) },
        execute() { return { meta: { changes: Number(statement().run(...args).changes) } } },
        first() { return Promise.resolve(statement().get(...args) ?? null) },
        all() { return Promise.resolve({ results: statement().all(...args) }) },
      }
    },
  }
  if (batch) db.batch = async statements => {
    sqlite.exec('BEGIN')
    try { const result = statements.map(statement => statement.execute()); sqlite.exec('COMMIT'); return result }
    catch (error) { sqlite.exec('ROLLBACK'); throw error }
  }
  const cache = new Map()
  function load(filename) {
    if (!path.extname(filename)) filename += '.ts'
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }; cache.set(filename, module)
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const requireSource = specifier => {
      if (specifier === '@opennextjs/cloudflare') return { getCloudflareContext: () => ({ env: state.binding ? { serotine_db: db } : {} }) }
      if (specifier.startsWith('@/')) return load(path.join(root, specifier.slice(2)))
      if (specifier.startsWith('.')) return load(path.resolve(path.dirname(filename), specifier))
      return require(specifier)
    }
    new Function('require', 'module', 'exports', output)(requireSource, module, module.exports)
    return module.exports
  }
  return { sqlite, calls, state, db, load, getDB: load(path.join(root, 'lib/db.ts')).getDB }
}
const schema = db => db.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => ({ ...row, sql: row.sql.replace(/\s+/g, ' ').trim() }))

test('blank bound database initializes exactly the v2 migration and caches only completed readiness', async t => {
  const h = harness(); t.after(() => h.sqlite.close())
  await h.getDB()
  const expected = new DatabaseSync(':memory:'); t.after(() => expected.close())
  expected.exec(fs.readFileSync(path.join(root, 'migrations/0002_authenticated_transport.sql'), 'utf8'))
  assert.deepEqual(schema(h.sqlite), schema(expected))
  const count = h.calls.length
  await h.getDB()
  assert.equal(h.calls.length, count)
})

test('legacy and partial relay databases are repaired without deleting existing rows', async t => {
  const h = harness({ legacy: true }); t.after(() => h.sqlite.close())
  h.sqlite.exec("INSERT INTO Message(id,receiverPubKeyHash,encryptedData,expiresAt,createdAt) VALUES('legacy','owner','keep','tomorrow','today')")
  h.sqlite.exec('CREATE TABLE RequestNonce(publicKey TEXT NOT NULL, nonce TEXT NOT NULL, action TEXT NOT NULL, expiresAt INTEGER NOT NULL, PRIMARY KEY(publicKey,nonce))')
  h.sqlite.exec("INSERT INTO RequestNonce VALUES('owner','nonce','action',123)")
  await h.getDB()
  assert.equal(h.sqlite.prepare('SELECT encryptedData FROM Message').get().encryptedData, 'keep')
  assert.equal(h.sqlite.prepare('SELECT nonce FROM RequestNonce').get().nonce, 'nonce')
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='idx_nonce_rate'").get().n, 1)
})

test('transient setup failures retry instead of poisoning readiness', async t => {
  const h = harness({ batch: false }); t.after(() => h.sqlite.close())
  h.state.fail = sql => sql.startsWith('CREATE TABLE IF NOT EXISTS RelayMessage')
  await assert.rejects(h.getDB(), /Temporary/)
  h.state.fail = null
  await h.getDB()
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n, 3)
})

test('incompatible existing tables fail without altering their schema or rows', async t => {
  const h = harness(); t.after(() => h.sqlite.close())
  h.sqlite.exec("CREATE TABLE RequestNonce(publicKey TEXT, nonce TEXT, expiresAt INTEGER, legacyData TEXT); INSERT INTO RequestNonce VALUES('owner','n',1,'keep')")
  const before = schema(h.sqlite).find(row => row.name === 'RequestNonce')
  await assert.rejects(h.getDB(), /no such column/)
  assert.deepEqual(schema(h.sqlite).find(row => row.name === 'RequestNonce'), before)
  assert.equal(h.sqlite.prepare('SELECT legacyData FROM RequestNonce').get().legacyData, 'keep')
})

test('missing binding fails explicitly and concurrent bootstrap remains idempotent', async t => {
  const h = harness(); t.after(() => h.sqlite.close())
  h.state.binding = false
  await assert.rejects(h.getDB(), /binding/)
  assert.equal(h.calls.length, 0)
  h.state.binding = true
  await Promise.all([h.getDB(), h.getDB()])
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n, 3)
})

test('a signed first send works on an unmigrated database; unsigned calls cannot trigger setup', async t => {
  const h = harness(); t.after(() => h.sqlite.close())
  const actions = h.load(path.join(root, 'app/actions.ts'))
  const cryptography = h.load(path.join(root, 'lib/crypto.ts'))
  const auth = h.load(path.join(root, 'lib/request-auth.ts'))
  const [sender, recipient] = await Promise.all([cryptography.generateEncryptionKeyPair(), cryptography.generateEncryptionKeyPair()])
  const senderPub = await cryptography.exportPublicKeyToHex(sender.publicKey)
  const recipientPubKey = await cryptography.exportPublicKeyToHex(recipient.publicKey)
  const request = { senderPubKey: senderPub }
  assert.equal((await actions.getMyMessages(request, undefined)).success, false)
  assert.equal(h.calls.length, 0)
  const data = { id: crypto.randomUUID(), recipientPubKey, encryptedData: await cryptography.encryptForPeer('hello', sender.privateKey, recipientPubKey) }
  const proof = await auth.createRequestProof('message:send', data, await cryptography.exportKey(sender.privateKey), senderPub)
  assert.equal((await actions.storeEncryptedMessage(data, proof)).success, true)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM RelayMessage').get().n, 1)
})
