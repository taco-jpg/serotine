/* Real backup encryption, validation and merge logic; only browser storage is replaced. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test, before, beforeEach } = require('node:test')
const ts = require('typescript')
const root = path.join(__dirname, '..')
const local = new Map(), databases = new Map(), cache = new Map()
let writes = 0
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
    async get(key) { return structuredClone((staging?.get(store) ?? rows(store)).get(JSON.stringify(key))) },
    async getAll() { return structuredClone([...(staging?.get(store) ?? rows(store)).values()]) },
    index(index) {
      assert.equal(index, 'by-peer')
      return { async getAll(peerPubKey) {
        return structuredClone([...(staging?.get(store) ?? rows(store)).values()].filter(row => row.peerPubKey === peerPubKey))
      } }
    },
    async put(value, key) {
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
    async getAll(store) { return structuredClone([...rows(store).values()]) },
    async get(store, key) { return facade(store).get(key) },
    async put(store, value, key) { return facade(store).put(value, key) },
    transaction(stores) {
      const staged = new Map()
      return {
        store: facade(stores, staged),
        objectStore: store => facade(store, staged),
        get done() { for (const [store, values] of staged) data.set(store, values); return Promise.resolve() },
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
const identity = load(path.join(root, 'lib/identity.ts'))
const storage = load(path.join(root, 'lib/storage.ts'))
const events = load(path.join(root, 'lib/messaging-store.ts'))
const backup = load(path.join(root, 'lib/full-backup.ts'))
const messaging = load(path.join(root, 'lib/messaging.ts'))
const password = 'a-correct-and-long-backup-password'
let alice, bob, charlie, encrypted, expectedMessages, expectedMessaging

// Produces an authenticated but semantically invalid fixture, as a corrupt export
// or someone who knows the backup password could. Restore must still reject it.
async function encryptPayload(value) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12))
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode('serotine-full-backup:v1:PBKDF2-SHA256-600000:AES-256-GCM') }, key, new TextEncoder().encode(JSON.stringify(value)))
  return JSON.stringify({ format: 'serotine-full-backup', version: 1, salt: Buffer.from(salt).toString('base64'), iv: Buffer.from(iv).toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64') })
}
async function decryptPayload(text) {
  const envelope = JSON.parse(text)
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: Buffer.from(envelope.salt, 'base64') }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(envelope.iv, 'base64'), additionalData: new TextEncoder().encode('serotine-full-backup:v1:PBKDF2-SHA256-600000:AES-256-GCM') }, key, Buffer.from(envelope.ciphertext, 'base64'))
  return JSON.parse(new TextDecoder().decode(plain))
}
const snapshot = () => ({ format: 'serotine-full-snapshot', version: 1, createdAt: Date.now(), identity: alice,
  contacts: [{ pub: bob.publicKey, alias: 'Bob' }], messages: structuredClone(expectedMessages), messaging: structuredClone(expectedMessaging) })
before(async () => {
  async function generate() {
    const pair = await cryptography.generateEncryptionKeyPair()
    return { version: 2, publicKey: await cryptography.exportPublicKeyToHex(pair.publicKey), privateKey: await cryptography.exportKey(pair.privateKey) }
  }
  ;[alice, bob, charlie] = await Promise.all([generate(), generate(), generate()])
  local.set('serotine_identity_v2', JSON.stringify(alice))
  identity.saveContacts(alice.publicKey, [{ pub: bob.publicKey, alias: 'Bob' }])
  expectedMessages = [{ id: crypto.randomUUID(), peerPubKey: bob.publicKey, senderPubKey: alice.publicKey, content: 'A legacy message', timestamp: Date.now(), delivery: 'sent', attachments: [
    { name: 'legacy.bin', type: 'application/octet-stream', size: 3, data: 'AH//' },
    { name: 'empty.txt', type: 'text/plain', size: 0, data: '' },
  ] }]
  await storage.importMessagesToStorage(alice.publicKey, expectedMessages)
  const event = { version: 3, id: crypto.randomUUID(), author: bob.publicKey, conversationId: alice.publicKey, recipients: [alice.publicKey], timestamp: Date.now(), kind: 'message', payload: { content: 'History from Bob' }, signature: '' }
  await events.saveStoredEvent(alice.publicKey, { key: events.eventStorageKey(event), event, local: false, delivered: [alice.publicKey], receivedAt: Date.now(), legacy: true })
  const bytes = new TextEncoder().encode('backup test bytes')
  const attachment = { id: crypto.randomUUID(), name: 'notes.txt', mime: 'text/plain', size: bytes.length, chunks: 1, sha256: Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex'), kind: 'file' }
  for (const [kind, payload] of [['attachment', { attachment }], ['attachment-chunk', { attachmentId: attachment.id, index: 0, data: Buffer.from(bytes).toString('base64') }]]) {
    const event = await messaging.signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: alice.publicKey, conversationId: bob.publicKey, recipients: [bob.publicKey], timestamp: Date.now(), kind, payload }, alice)
    await events.saveStoredEvent(alice.publicKey, { key: events.eventStorageKey(event), event, local: true, delivered: [], receivedAt: Date.now(), error: 'Offline', failedRecipients: [bob.publicKey] })
  }
  await events.saveMessagingPreferences(alice.publicKey, { accepted: [bob.publicKey], blocked: [], notifications: { [bob.publicKey]: 'mentions' }, readAt: { [bob.publicKey]: Date.now() }, readReceipts: false })
  await events.saveSyncCursor(alice.publicKey, 999)
  expectedMessaging = await events.exportMessagingSnapshot(alice.publicKey)
  encrypted = await backup.exportFullBackup(alice, password)
})
beforeEach(() => { local.clear(); databases.clear(); writes = 0 })

test('full encrypted backup restores identity, contacts, legacy history, signed attachment chunks, pending outbox and preferences without transplanting the feed cursor', async () => {
  assert.equal(encrypted.includes(alice.privateKey.d), false)
  assert.equal(encrypted.includes(bob.publicKey), false)
  assert.equal(encrypted.includes('A legacy message'), false)
  assert.deepEqual(await backup.restoreBackup(encrypted, password), alice)
  assert.deepEqual(identity.loadContacts(alice.publicKey), [{ pub: bob.publicKey, alias: 'Bob' }])
  assert.deepEqual(await storage.exportAllMessagesFromStorage(alice.publicKey), expectedMessages)
  assert.deepEqual(await events.exportMessagingSnapshot(alice.publicKey), expectedMessaging)
  assert.equal(await events.getSyncCursor(alice.publicKey), 0)
})

test('wrong password and tampered ciphertext cannot mutate identity or chat storage', async () => {
  await assert.rejects(backup.restoreBackup(encrypted, 'incorrect-password'), /password.*incorrect|damaged/i)
  assert.equal(writes, 0)
  const modified = JSON.parse(encrypted), bytes = Buffer.from(modified.ciphertext, 'base64')
  bytes[0] ^= 1; modified.ciphertext = bytes.toString('base64')
  await assert.rejects(backup.restoreBackup(JSON.stringify(modified), password), /password.*incorrect|damaged/i)
  assert.equal(writes, 0)
})

test('backup recipient failures are validated while older failed outboxes remain restorable', async () => {
  const older = structuredClone(expectedMessaging)
  for (const record of older.events) delete record.failedRecipients
  await events.validateMessagingSnapshot(older, alice.publicKey)
  for (const failedRecipients of ['not an array', [charlie.publicKey]]) {
    const invalid = structuredClone(expectedMessaging)
    invalid.events.find(record => record.local).failedRecipients = failedRecipients
    await assert.rejects(events.validateMessagingSnapshot(invalid, alice.publicKey), /invalid failed recipients/)
  }
  assert.equal(writes, 0)
})

test('another identity cannot be replaced by a full backup', async () => {
  local.set('serotine_identity_v2', JSON.stringify(bob))
  await assert.rejects(backup.restoreBackup(encrypted, password), /different identity.*already saved/i)
  assert.equal(writes, 0)
  assert.deepEqual(await identity.loadIdentity(), bob)
})

test('confirmed desktop-to-mobile restore preserves the phone identity and its isolated history', async () => {
  local.set('serotine_identity_v2', JSON.stringify(bob))
  const phoneMessage = { id: crypto.randomUUID(), peerPubKey: charlie.publicKey, senderPubKey: bob.publicKey, content: 'Only on the phone identity', timestamp: Date.now() }
  await storage.importMessagesToStorage(bob.publicKey, [phoneMessage])
  identity.saveContacts(bob.publicKey, [{ pub: charlie.publicKey, alias: 'Phone contact' }])
  await backup.restoreBackup(encrypted, password, { replaceIdentity: bob.publicKey })
  assert.deepEqual(await identity.loadIdentity(), alice)
  assert.equal((await identity.loadArchivedIdentities())[0].publicKey, bob.publicKey)
  assert.deepEqual(await storage.exportAllMessagesFromStorage(bob.publicKey), [phoneMessage])
  assert.deepEqual(await storage.exportAllMessagesFromStorage(alice.publicKey), expectedMessages)
  assert.deepEqual(identity.loadContacts(bob.publicKey), [{ pub: charlie.publicKey, alias: 'Phone contact' }])
  assert.deepEqual(identity.loadContacts(alice.publicKey), [{ pub: bob.publicKey, alias: 'Bob' }])
})

test('confirmation never bypasses backup ownership validation', async () => {
  local.set('serotine_identity_v2', JSON.stringify(bob))
  const invalid = snapshot(); invalid.messaging.owner = charlie.publicKey
  await assert.rejects(backup.restoreBackup(await encryptPayload(invalid), password, { replaceIdentity: bob.publicKey }), /different identity|invalid/i)
  assert.equal(writes, 0)
  assert.deepEqual(await identity.loadIdentity(), bob)
})

test('chat storage failure during a switch leaves the old identity active for retry', async () => {
  local.set('serotine_identity_v2', JSON.stringify(bob))
  const original = events.importMessagingSnapshot
  events.importMessagingSnapshot = async () => { throw new Error('Quota exceeded') }
  try {
    await assert.rejects(backup.restoreBackup(encrypted, password, { replaceIdentity: bob.publicKey }), /active identity has not changed/i)
    assert.deepEqual(await identity.loadIdentity(), bob)
    assert.equal((await identity.loadArchivedIdentities())[0].publicKey, bob.publicKey)
  } finally { events.importMessagingSnapshot = original }
  await backup.restoreBackup(encrypted, password, { replaceIdentity: bob.publicKey })
  assert.deepEqual(await identity.loadIdentity(), alice)
})

test('ownership and record validation happens before any storage mutation even when the encryption is valid', async () => {
  const wrongOwner = snapshot(); wrongOwner.messaging.owner = bob.publicKey
  await assert.rejects(backup.restoreBackup(await encryptPayload(wrongOwner), password), /different identity|invalid/i)
  assert.equal(writes, 0)
  const unrelated = snapshot(), record = unrelated.messaging.events[0]
  record.event.author = charlie.publicKey; record.event.recipients = [bob.publicKey]
  record.key = events.eventStorageKey(record.event); record.delivered = []
  await assert.rejects(backup.restoreBackup(await encryptPayload(unrelated), password), /another identity/i)
  assert.equal(writes, 0)
  const badMessage = snapshot(); badMessage.messages[0].senderPubKey = charlie.publicKey
  await assert.rejects(backup.restoreBackup(await encryptPayload(badMessage), password), /unrelated message/i)
  assert.equal(writes, 0)
  const badAttachment = snapshot(); badAttachment.messages[0].attachments[0].size++
  await assert.rejects(backup.restoreBackup(await encryptPayload(badAttachment), password), /invalid or unrelated message/i)
  assert.equal(writes, 0)
  const badSignature = snapshot(); badSignature.messaging.events[1].event.signature = '0'.repeat(128)
  await assert.rejects(backup.restoreBackup(await encryptPayload(badSignature), password), /signature|invalid/i)
  assert.equal(writes, 0)
})

test('backup merge preserves newer local message rows and existing contact aliases', async () => {
  local.set('serotine_identity_v2', JSON.stringify(alice))
  identity.saveContacts(alice.publicKey, [{ pub: bob.publicKey, alias: 'Robert' }, { pub: charlie.publicKey, alias: 'Charlie' }])
  const newer = { ...expectedMessages[0], content: 'Existing local content' }
  await storage.importMessagesToStorage(alice.publicKey, [newer])
  await backup.restoreBackup(encrypted, password)
  assert.deepEqual(await storage.exportAllMessagesFromStorage(alice.publicKey), [newer])
  assert.deepEqual(identity.loadContacts(alice.publicKey), [{ pub: bob.publicKey, alias: 'Robert' }, { pub: charlie.publicKey, alias: 'Charlie' }])
})

test('full backup export excludes deleted legacy history and files while retaining later messages', async () => {
  const deletedAt = expectedMessages[0].timestamp
  const fresh = { ...expectedMessages[0], id: crypto.randomUUID(), timestamp: deletedAt + 1, content: 'After deletion', attachments: [] }
  await storage.importMessagesToStorage(alice.publicKey, [...expectedMessages, fresh])
  await events.saveMessagingPreferences(alice.publicKey, { ...expectedMessaging.preferences,
    deleted: { [bob.publicKey]: { deletedAt, eventKeys: [] } } })
  const exported = await decryptPayload(await backup.exportFullBackup(alice, password))
  assert.deepEqual(exported.messages, [fresh])
  assert.equal(exported.messaging.preferences.deleted[bob.publicKey].deletedAt, deletedAt)
  assert.equal(JSON.stringify(exported).includes('legacy.bin'), false)
})

test('restoring an older backup cannot resurrect locally deleted legacy messages or files', async () => {
  const deletedAt = expectedMessages[0].timestamp
  const fresh = { ...expectedMessages[0], id: crypto.randomUUID(), timestamp: deletedAt + 1, content: 'New conversation', attachments: [] }
  await storage.importMessagesToStorage(alice.publicKey, [...expectedMessages, fresh])
  await events.saveMessagingPreferences(alice.publicKey, { ...expectedMessaging.preferences,
    deleted: { [bob.publicKey]: { deletedAt, eventKeys: [] } } })
  await backup.restoreBackup(encrypted, password)
  assert.deepEqual(await storage.exportAllMessagesFromStorage(alice.publicKey), [fresh])
  assert.equal((await events.getMessagingPreferences(alice.publicKey)).deleted[bob.publicKey].deletedAt, deletedAt)
})

test('restored deletion markers purge existing legacy files but preserve other chats and newer messages', async () => {
  const deletedAt = expectedMessages[0].timestamp
  const fresh = { ...expectedMessages[0], id: crypto.randomUUID(), timestamp: deletedAt + 1, content: 'After deletion', attachments: [] }
  const unrelated = { ...expectedMessages[0], peerPubKey: charlie.publicKey }
  await storage.importMessagesToStorage(alice.publicKey, [...expectedMessages, fresh, unrelated])
  const incoming = snapshot()
  incoming.messaging.preferences.deleted = { [bob.publicKey]: { deletedAt, eventKeys: [] } }
  await backup.restoreBackup(await encryptPayload(incoming), password)
  assert.deepEqual(await storage.exportAllMessagesFromStorage(alice.publicKey), [fresh, unrelated])
})

test('deleting a stored chat removes incoming history and outgoing file chunks while preserving other conversations', async () => {
  await events.importMessagingSnapshot(alice.publicKey, structuredClone(expectedMessaging))
  const otherEvent = await messaging.signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: alice.publicKey,
    conversationId: charlie.publicKey, recipients: [charlie.publicKey], timestamp: Date.now(), kind: 'message', payload: { content: 'Keep this chat' } }, alice)
  const unrelated = { key: events.eventStorageKey(otherEvent), event: otherEvent, local: true, delivered: [], receivedAt: Date.now() }
  await events.saveStoredEvent(alice.publicKey, unrelated)
  await events.saveMessagingPreferences(alice.publicKey, { ...expectedMessaging.preferences, archived: [bob.publicKey, charlie.publicKey] })
  await events.deleteStoredConversation(alice.publicKey, bob.publicKey)
  assert.deepEqual(await events.getStoredEvents(alice.publicKey), [unrelated])
  const exported = await events.exportMessagingSnapshot(alice.publicKey)
  assert.deepEqual(exported.events, [unrelated])
  assert.deepEqual(exported.preferences.archived, [charlie.publicKey])
  assert.deepEqual(new Set(exported.preferences.deleted[bob.publicKey].eventKeys), new Set(expectedMessaging.events.map(record => record.key)))
  await events.validateMessagingSnapshot(exported, alice.publicKey)
  for (const record of expectedMessaging.events) assert.equal(await events.saveStoredEvent(alice.publicKey, record), false)
  assert.deepEqual(await events.getStoredEvents(alice.publicKey), [unrelated])
})

test('old v3 backups and stale preference saves cannot resurrect deleted events or erase their tombstone', async () => {
  await events.importMessagingSnapshot(alice.publicKey, structuredClone(expectedMessaging))
  await events.deleteStoredConversation(alice.publicKey, bob.publicKey)
  const deletion = (await events.getMessagingPreferences(alice.publicKey)).deleted[bob.publicKey]
  await events.saveMessagingPreferences(alice.publicKey, structuredClone(expectedMessaging.preferences))
  await events.importMessagingSnapshot(alice.publicKey, structuredClone(expectedMessaging))
  assert.deepEqual(await events.getStoredEvents(alice.publicKey), [])
  assert.deepEqual((await events.getMessagingPreferences(alice.publicKey)).deleted[bob.publicKey], deletion)

  const freshEvent = await messaging.signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: bob.publicKey,
    conversationId: alice.publicKey, recipients: [alice.publicKey], timestamp: deletion.deletedAt + 1, kind: 'message', payload: { content: 'Start again' } }, bob)
  const fresh = { key: events.eventStorageKey(freshEvent), event: freshEvent, local: false, delivered: [alice.publicKey], receivedAt: deletion.deletedAt + 1 }
  assert.equal(await events.saveStoredEvent(alice.publicKey, fresh), true)
  await backup.restoreBackup(encrypted, password)
  assert.deepEqual(await events.getStoredEvents(alice.publicKey), [fresh])
  assert.deepEqual(await storage.exportAllMessagesFromStorage(alice.publicKey), [])
  assert.deepEqual((await events.exportMessagingSnapshot(alice.publicKey)).preferences.deleted[bob.publicKey], deletion)
})

test('older preferences without archive or deletion fields load and validate with empty defaults', async () => {
  const older = structuredClone(expectedMessaging)
  delete older.preferences.archived; delete older.preferences.deleted
  const validated = await events.validateMessagingSnapshot(older, alice.publicKey)
  assert.deepEqual(validated.preferences.archived, [])
  assert.deepEqual(validated.preferences.deleted, {})
  const oldPreferences = structuredClone(older.preferences)
  delete oldPreferences.archived; delete oldPreferences.deleted
  await database(`serotine-events:${alice.publicKey}`).put('metadata', oldPreferences, 'preferences')
  const loaded = await events.getMessagingPreferences(alice.publicKey)
  assert.deepEqual(loaded.archived, [])
  assert.deepEqual(loaded.deleted, {})
})

test('archive and deletion backup fields reject malformed data before writes', async () => {
  for (const archived of [null, bob.publicKey, ['invalid-conversation']]) {
    const invalid = structuredClone(expectedMessaging); invalid.preferences.archived = archived
    await assert.rejects(events.validateMessagingSnapshot(invalid, alice.publicKey), /archived chats are invalid/)
  }
  for (const deleted of [null, [], { invalid: { deletedAt: 1, eventKeys: [] } },
    { [bob.publicKey]: { deletedAt: -1, eventKeys: [] } },
    { [bob.publicKey]: { deletedAt: 1, eventKeys: 'not-an-array' } },
    { [charlie.publicKey]: { deletedAt: 1, eventKeys: [expectedMessaging.events[0].key] } }]) {
    const invalid = structuredClone(expectedMessaging); invalid.preferences.deleted = deleted
    await assert.rejects(events.validateMessagingSnapshot(invalid, alice.publicKey), /deleted chats are invalid/)
  }
  assert.equal(writes, 0)
})

test('existing encrypted identity backups and raw legacy private keys still restore', async () => {
  const oldBackup = await identity.exportIdentityBackup(alice, password)
  assert.deepEqual(await backup.restoreBackup(oldBackup, password), alice)
  local.clear(); databases.clear()
  assert.deepEqual(await backup.restoreBackup(JSON.stringify(alice.privateKey), ''), alice)
})

test('oversized inputs, invalid contacts and short export passwords are refused', async () => {
  await assert.rejects(backup.restoreBackup(' '.repeat(backup.MAX_BACKUP_FILE_BYTES + 1), password), /100 MiB/i)
  await assert.rejects(backup.exportFullBackup(alice, 'short'), /at least 12/i)
  const invalid = snapshot(); invalid.contacts[0].pub = '04' + '0'.repeat(128)
  await assert.rejects(backup.validateFullBackupSnapshot(invalid))
  assert.throws(() => storage.validateStoredMessages([...expectedMessages, ...expectedMessages], alice.publicKey), /duplicate/i)
  assert.equal(writes, 0)
})
