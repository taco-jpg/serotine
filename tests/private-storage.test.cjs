/* Actual signed-event storage and backup boundaries with transactional IndexedDB emulation. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test, before, beforeEach } = require('node:test')
const ts = require('typescript')
const root = path.join(__dirname, '..')
const local = new Map(), databases = new Map(), cache = new Map()
let writes = 0, failCommit = false, beforeLegacyPut
const reads = { full: 0, payloadBytes: 0 }
function copyRead(value, full = false) {
  if (full) reads.full++
  for (const record of Array.isArray(value) ? value : [value]) reads.payloadBytes += record?.event?.payload?.data?.length ?? record?.event?.payload?.community?.data?.length ?? 0
  return structuredClone(value)
}
const localStorage = {
  getItem(key) { return local.get(key) ?? null },
  setItem(key, value) { writes++; local.set(key, String(value)) },
  removeItem(key) { writes++; local.delete(key) },
}
function database(name) {
  if (!databases.has(name)) databases.set(name, new Map())
  const data = databases.get(name)
  const rows = store => { if (!data.has(store)) data.set(store, new Map()); return data.get(store) }
  const keyFor = (store, value, key) => key !== undefined ? JSON.stringify(key) : JSON.stringify(store === 'messages' ? [value.peerPubKey, value.senderPubKey, value.id] : value.key)
  const facade = (store, staging) => ({
    async get(key) { return copyRead((staging?.get(store) ?? rows(store)).get(JSON.stringify(key))) },
    async getAll() { return copyRead([...(staging?.get(store) ?? rows(store)).values()], store === 'events') },
    index(index) {
      assert.ok(index === 'by-peer' || index === 'by-kind')
      return { async getAll(peerPubKey) {
        return copyRead([...(staging?.get(store) ?? rows(store)).values()].filter(row => (index === 'by-kind' ? row.event.kind : row.peerPubKey) === peerPubKey))
      } }
    },
    async put(value, key) {
      if (store === 'messages' && beforeLegacyPut) { const hook = beforeLegacyPut; beforeLegacyPut = undefined; await hook() }
      writes++
      if (staging && !staging.has(store)) staging.set(store, new Map(rows(store)))
      ;(staging?.get(store) ?? rows(store)).set(keyFor(store, value, key), structuredClone(value))
    },
    async delete(key) {
      writes++
      if (staging && !staging.has(store)) staging.set(store, new Map(rows(store)))
      ;(staging?.get(store) ?? rows(store)).delete(JSON.stringify(key))
    },
  })
  return {
    close() {},
    async getAll(store) { return copyRead([...rows(store).values()], store === 'events') },
    async get(store, key) { return facade(store).get(key) },
    async put(store, value, key) { return facade(store).put(value, key) },
    transaction(stores) {
      const staged = new Map()
      let aborted = false, completion
      return {
        store: facade(stores, staged),
        objectStore: store => facade(store, staged),
        abort() { aborted = true },
        get done() {
          if (!completion) {
            if (aborted || (failCommit && staged.size)) completion = Promise.reject(new Error('Transaction aborted'))
            else { for (const [store, values] of staged) data.set(store, values); completion = Promise.resolve() }
          }
          return completion
        },
      }
    },
  }
}
const window = new EventTarget()
function load(filename) {
  if (!path.extname(filename)) filename += '.ts'
  if (cache.has(filename)) return cache.get(filename).exports
  const module = { exports: {} }
  cache.set(filename, module)
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  function sourceRequire(specifier) {
    if (specifier === 'idb') return { openDB: async name => database(name) }
    if (specifier.startsWith('.')) return load(path.resolve(path.dirname(filename), specifier))
    if (specifier.startsWith('@/')) return load(path.join(root, specifier.slice(2)))
    return require(specifier)
  }
  new Function('require', 'module', 'exports', 'localStorage', 'window', output)(sourceRequire, module, module.exports, localStorage, window)
  return module.exports
}
const cryptography = load(path.join(root, 'lib/crypto.ts'))
const events = load(path.join(root, 'lib/messaging-store.ts'))
const backup = load(path.join(root, 'lib/full-backup.ts'))
const messaging = load(path.join(root, 'lib/messaging.ts'))
let alice, bob, charlie
before(async () => {
  async function generate() {
    const pair = await cryptography.generateEncryptionKeyPair()
    return { version: 2, publicKey: await cryptography.exportPublicKeyToHex(pair.publicKey), privateKey: await cryptography.exportKey(pair.privateKey) }
  }
  ;[alice, bob, charlie] = await Promise.all([generate(), generate(), generate()])
})
beforeEach(() => { local.clear(); databases.clear(); writes = 0; failCommit = false; beforeLegacyPut = undefined; reads.full = 0; reads.payloadBytes = 0 })
async function signed(kind, payload, author = alice, recipient = bob, timestamp = Date.now() - 1000) {
  const event = await messaging.signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: author.publicKey,
    conversationId: recipient.publicKey, recipients: [recipient.publicKey], timestamp, kind, payload }, author)
  return { key: events.eventStorageKey(event), event, local: author === alice, delivered: [], receivedAt: Date.now() }
}
const owner = () => alice.publicKey
const rawRows = () => [...(databases.get(`serotine-events:${owner()}`)?.get('events')?.values() ?? [])]
const snapshot = records => ({ version: 3, owner: owner(), events: structuredClone(records), preferences: events.defaultMessagingPreferences() })

test('expiry physically removes plaintext on read and rejects stale retry writes', async () => {
  const timestamp = Date.now() - 1000
  const privateRow = await signed('private-message', { content: 'temporary credential', expiresAt: timestamp + 300000 }, alice, bob, timestamp)
  const ordinary = await signed('message', { content: 'ordinary history' })
  await events.saveStoredEvent(owner(), privateRow)
  await events.saveStoredEvent(owner(), ordinary)
  assert.equal(rawRows().length, 2)
  assert.equal(await events.pruneExpiredPrivateEvents(owner(), timestamp + 300000), 1)
  assert.deepEqual(rawRows().map(row => row.event.payload.content), ['ordinary history'])
  const originalNow = Date.now
  Date.now = () => timestamp + 300001
  try {
    assert.equal(await events.saveStoredEvent(owner(), privateRow), false)
    assert.equal((await events.getStoredEvents(owner())).length, 1)
  } finally { Date.now = originalNow }
})

test('an idle-device read prunes expired private messages even without a timer', async () => {
  const timestamp = Date.now() - 1000
  const privateRow = await signed('private-message', { content: 'idle secret', expiresAt: timestamp + 300000 }, alice, bob, timestamp)
  await events.saveStoredEvent(owner(), privateRow)
  const originalNow = Date.now
  Date.now = () => timestamp + 300001
  try { assert.deepEqual(await events.getStoredEvents(owner()), []) } finally { Date.now = originalNow }
  assert.deepEqual(rawRows(), [])
})

test('signed peer destruction is scoped, physically removes private content and blocks replay after deleting the chat', async () => {
  const timestamp = Date.now() - 5000
  const mine = await signed('private-message', { content: 'mine', expiresAt: timestamp + 300000 }, alice, bob, timestamp)
  const theirs = await signed('private-message', { content: 'theirs', expiresAt: timestamp + 300000 }, bob, alice, timestamp)
  const unrelated = await signed('private-message', { content: 'other peer', expiresAt: timestamp + 300000 }, alice, charlie, timestamp)
  const ordinary = await signed('message', { content: 'keep ordinary' }, alice, bob, timestamp)
  for (const row of [mine, theirs, unrelated, ordinary]) await events.saveStoredEvent(owner(), row)
  const destruction = await signed('private-destroy', { destroyBefore: timestamp + 1000 }, bob, alice, timestamp + 1000)
  await events.saveStoredEvent(owner(), destruction)
  assert.deepEqual(new Set(rawRows().map(row => row.key)), new Set([ordinary.key, unrelated.key, destruction.key]))
  assert.equal(await events.saveStoredEvent(owner(), mine), false)
  assert.equal(await events.saveStoredEvent(owner(), theirs), false)
  await events.deleteStoredConversation(owner(), bob.publicKey)
  assert.equal(rawRows().some(row => row.key === destruction.key), true)
  assert.equal((await events.exportMessagingSnapshot(owner())).events.some(row => row.key === destruction.key), true)
  assert.equal(await events.saveStoredEvent(owner(), mine), false)
})

test('invalid or unrelated signed destruction cannot purge private messages', async () => {
  const timestamp = Date.now() - 5000
  const row = await signed('private-message', { content: 'keep', expiresAt: timestamp + 300000 }, alice, bob, timestamp)
  await events.saveStoredEvent(owner(), row)
  const bad = await signed('private-destroy', { destroyBefore: timestamp + 1000 }, bob, alice, timestamp + 1000)
  bad.event.signature = '0'.repeat(128)
  await assert.rejects(events.saveStoredEvent(owner(), bad), /private.*invalid/i)
  const unrelated = await signed('private-destroy', { destroyBefore: timestamp + 1000 }, bob, charlie, timestamp + 1000)
  await assert.rejects(events.saveStoredEvent(owner(), unrelated), /private.*invalid/i)
  assert.deepEqual(rawRows().map(row => row.key), [row.key])
})

test('private edits arriving before or after expiration are removed and never exported', async () => {
  const timestamp = Date.now() - 1000
  const row = await signed('private-message', { content: 'original key', expiresAt: timestamp + 300000 }, alice, bob, timestamp)
  const edit = await signed('edit', { targetId: row.event.id, content: 'edited private key' })
  await events.saveStoredEvent(owner(), edit)
  assert.equal((await events.exportMessagingSnapshot(owner())).events.length, 0)
  await events.saveStoredEvent(owner(), row)
  assert.equal(rawRows().some(existing => existing.key === edit.key), false)
  assert.equal(await events.saveStoredEvent(owner(), edit), false)
  await events.pruneExpiredPrivateEvents(owner(), timestamp + 300000)
  assert.equal(await events.saveStoredEvent(owner(), edit), false)
  assert.deepEqual(rawRows(), [])
})

test('all private plaintext stays out of encrypted full backups before expiration', async () => {
  const timestamp = Date.now() - 1000
  const privateRow = await signed('private-message', { content: 'never-back-up-this-access-key', expiresAt: timestamp + 300000, secret: true }, alice, bob, timestamp)
  const ordinary = await signed('message', { content: 'ordinary backup text' })
  const settings = await signed('private-settings', { ttlSeconds: 300 })
  for (const row of [privateRow, ordinary, settings]) await events.saveStoredEvent(owner(), row)
  const exported = await events.exportMessagingSnapshot(owner())
  assert.deepEqual(new Set(exported.events.map(row => row.event.kind)), new Set(['message', 'private-settings']))
  const encrypted = await backup.exportFullBackup(alice, 'a-valid-long-test-password')
  databases.clear()
  await backup.restoreBackup(encrypted, 'a-valid-long-test-password')
  assert.equal(JSON.stringify(rawRows()).includes('never-back-up-this-access-key'), false)
  assert.equal(rawRows().some(row => row.event.payload.content === 'ordinary backup text'), true)
})

test('imports discard live private payloads and edits but retain signed destroy boundaries against delayed delivery', async () => {
  const timestamp = Date.now() - 5000
  const row = await signed('private-message', { content: 'private imported key', expiresAt: timestamp + 300000 }, alice, bob, timestamp)
  const edit = await signed('edit', { targetId: row.event.id, content: 'private edited key' })
  const ordinary = await signed('message', { content: 'public imported text' })
  const destruction = await signed('private-destroy', { destroyBefore: timestamp + 1000 }, bob, alice, timestamp + 1000)
  await events.importMessagingSnapshot(owner(), snapshot([edit, row, destruction, ordinary]))
  assert.deepEqual(new Set(rawRows().map(row => row.key)), new Set([ordinary.key, destruction.key]))
  assert.equal(await events.saveStoredEvent(owner(), row), false)
  assert.equal(await events.saveStoredEvent(owner(), edit), false)
})

test('imports validate private signatures before any write or destruction', async () => {
  const row = await signed('message', { content: 'history' })
  await events.saveStoredEvent(owner(), row)
  const destruction = await signed('private-destroy', { destroyBefore: Date.now() - 1000 })
  destruction.event.signature = '0'.repeat(128)
  const before = writes
  await assert.rejects(events.importMessagingSnapshot(owner(), snapshot([destruction])), /signature|invalid/i)
  assert.equal(writes, before)
  assert.deepEqual(rawRows().map(row => row.key), [row.key])
})

test('ephemeral plugin capabilities are excluded from backup export and ignored on import', async () => {
  const capability = await signed('plugin-capabilities', { capabilities: {
    protocol: 1, session: crypto.randomUUID(), sequence: 1,
    plugins: [{ id: 'serotine.private-chat', version: '1.0.0' }], request: crypto.randomUUID(),
  } })
  const ordinary = await signed('message', { content: 'Keep this ordinary history' })
  await events.saveStoredEvent(owner(), capability)
  await events.saveStoredEvent(owner(), ordinary)
  assert.deepEqual((await events.exportMessagingSnapshot(owner())).events.map(row => row.key), [ordinary.key])
  databases.clear()
  await events.importMessagingSnapshot(owner(), snapshot([capability, ordinary]))
  assert.deepEqual(rawRows().map(row => row.key), [ordinary.key])
})

test('failed destroy transaction leaves both history and replay boundaries unchanged', async () => {
  const timestamp = Date.now() - 5000
  const row = await signed('private-message', { content: 'transactional secret', expiresAt: timestamp + 300000 }, alice, bob, timestamp)
  await events.saveStoredEvent(owner(), row)
  const destruction = await signed('private-destroy', { destroyBefore: timestamp + 1000 }, bob, alice, timestamp + 1000)
  failCommit = true
  await assert.rejects(events.saveStoredEvent(owner(), destruction), /aborted/)
  failCommit = false
  assert.deepEqual(rawRows().map(row => row.key), [row.key])
  assert.equal(await events.saveStoredEvent(owner(), row), true)
})

test('local history deletion preserves the shared private mode across reload and backup', async () => {
  const settings = await signed('private-settings', { ttlSeconds: 3600 }, bob, alice)
  const message = await signed('message', { content: 'delete this local history' })
  await events.saveStoredEvent(owner(), settings)
  await events.saveStoredEvent(owner(), message)
  await events.deleteStoredConversation(owner(), bob.publicKey)
  const records = await events.getStoredEvents(owner())
  assert.deepEqual(records.map(row => row.key), [settings.key])
  const exported = await events.exportMessagingSnapshot(owner())
  assert.deepEqual(exported.events.map(row => row.key), [settings.key])
  assert.equal(await events.saveStoredEvent(owner(), settings), true)
  const model = messaging.buildMessagingModel(records, owner(), [], await events.getMessagingPreferences(owner()), undefined, true)
  assert.equal(model.conversations.find(row => row.id === bob.publicKey).privateTtlSeconds, 3600)
})


test('destruction cannot overwrite an existing signed event with the same identifier', async () => {
  const timestamp = Date.now() - 5000
  const row = await signed('private-message', { content: 'immutable private message', expiresAt: timestamp + 300000 }, alice, bob, timestamp)
  await events.saveStoredEvent(owner(), row)
  const conflicting = await messaging.signMessagingEvent({ ...row.event, kind: 'private-destroy',
    timestamp: timestamp + 1000, payload: { destroyBefore: timestamp + 1000 } }, alice)
  await assert.rejects(events.saveStoredEvent(owner(), { ...row, event: conflicting }), /Conflicting message identifier/)
  assert.deepEqual(rawRows().map(record => record.key), [row.key])
  assert.equal(await events.saveStoredEvent(owner(), row), true)
})

test('a 14.6 MiB attachment history is read once and never cloned again for idle refresh or a text send', async t => {
  const { ATTACHMENT_CHUNK_BYTES } = load(path.join(root, 'lib/attachments.ts'))
  const attachmentId = crypto.randomUUID(), bytes = Math.ceil(14.6 * 1024 * 1024)
  const db = database(`serotine-events:${owner()}`)
  let encodedBytes = 0
  for (let offset = 0, index = 0; offset < bytes; offset += ATTACHMENT_CHUNK_BYTES, index++) {
    const data = Buffer.alloc(Math.min(ATTACHMENT_CHUNK_BYTES, bytes - offset), index % 251).toString('base64')
    encodedBytes += data.length
    // Seed the old database format without a change log, as a schema upgrade does.
    await db.put('events', await signed('attachment-chunk', { attachmentId, index, data }))
  }
  const reader = events.createStoredEventReader(owner())
  const started = performance.now(), initial = await reader.read()
  const initialMs = performance.now() - started
  assert.equal(initial.length, Math.ceil(bytes / ATTACHMENT_CHUNK_BYTES))
  assert.equal(reads.full, 1)
  assert.equal(reads.payloadBytes, encodedBytes)
  reads.full = 0; reads.payloadBytes = 0
  const idleStarted = performance.now()
  for (let i = 0; i < 8; i++) assert.equal(await reader.read(), initial)
  const text = await signed('message', { content: 'This text must not deserialize an old GIF.' })
  await events.saveStoredEvent(owner(), text)
  const updated = await reader.read()
  assert.notEqual(updated, initial)
  assert.equal(updated.find(record => record.key === initial[0].key), initial[0])
  assert.equal(updated.find(record => record.key === text.key).event.payload.content, text.event.payload.content)
  assert.equal(reads.full, 0)
  assert.equal(reads.payloadBytes, 0)
  t.diagnostic(`14.6 MiB payload: initial ${initialMs.toFixed(1)} ms; 8 idle reads + text write/read ${(performance.now() - idleStarted).toFixed(1)} ms; 0 old attachment bytes read`)
  reader.dispose()
})

test('independent readers observe committed writes, confirmations and deletions without shared notifications', async () => {
  const one = events.createStoredEventReader(owner()), two = events.createStoredEventReader(owner())
  assert.deepEqual(await one.read(), [])
  const text = await signed('message', { content: 'cross-tab message' })
  await events.saveStoredEvent(owner(), text)
  const first = await one.read(), other = await two.read()
  assert.equal(first[0].event.payload.content, other[0].event.payload.content)
  assert.equal(Object.isFrozen(first[0].event.payload), true)
  await events.saveStoredEvent(owner(), { ...text, delivered: [bob.publicKey] })
  assert.deepEqual((await one.read())[0].delivered, [bob.publicKey])
  assert.deepEqual((await two.read())[0].delivered, [bob.publicKey])
  assert.deepEqual(first[0].delivered, [])
  await events.deleteStoredMessage(owner(), bob.publicKey, text.event.id)
  assert.deepEqual(await one.read(), [])
  assert.deepEqual(await two.read(), [])
  one.dispose(); two.dispose()
})

test('failed commits do not advance an incremental reader or publish pending records', async () => {
  const reader = events.createStoredEventReader(owner()), initial = await reader.read()
  const text = await signed('message', { content: 'rolled back text' })
  failCommit = true
  await assert.rejects(events.saveStoredEvent(owner(), text), /aborted/)
  failCommit = false
  assert.equal(await reader.read(), initial)
  assert.deepEqual(rawRows(), [])
  await events.saveStoredEvent(owner(), text)
  assert.equal((await reader.read()).length, 1)
  reader.dispose()
})

test('incremental readers reload after import and after a compacted change log', async () => {
  const reader = events.createStoredEventReader(owner())
  const first = await signed('message', { content: 'deleted before an old backup is restored' })
  await events.saveStoredEvent(owner(), first)
  const old = await events.exportMessagingSnapshot(owner())
  await reader.read()
  await events.deleteStoredMessage(owner(), bob.publicKey, first.event.id)
  await events.importMessagingSnapshot(owner(), old)
  assert.deepEqual(await reader.read(), [])
  const newRows = []
  for (let i = 0; i < 130; i++) { const row = await signed('message', { content: `new ${i}` }); newRows.push(row); await events.saveStoredEvent(owner(), row) }
  reads.full = 0
  assert.deepEqual(new Set((await reader.read()).map(record => record.key)), new Set(newRows.map(record => record.key)))
  assert.equal(reads.full, 1)
  reader.dispose()
})

test('incremental readers physically expire private payloads and refuse reads after disposal', async () => {
  const timestamp = Date.now() - 1000
  const row = await signed('private-message', { content: 'expire even with a warm reader', expiresAt: timestamp + 300000 }, alice, bob, timestamp)
  await events.saveStoredEvent(owner(), row)
  const reader = events.createStoredEventReader(owner())
  assert.equal((await reader.read()).length, 1)
  const originalNow = Date.now
  Date.now = () => timestamp + 300001
  try { assert.deepEqual(await reader.read(), []) } finally { Date.now = originalNow }
  assert.deepEqual(rawRows(), [])
  reader.dispose()
  await assert.rejects(reader.read(), /closed/)
})
