const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test, before, beforeEach } = require('node:test')
const ts = require('typescript')
const root = path.join(__dirname, '..')
const modules = new Map(), stores = new Map(), prefs = new Map(), cursors = new Map()
const packets = [], attempts = []
let rejectRecipient, failPersistence = false, failAfter = Infinity
const history = new Map(), legacyPackets = [], acknowledgments = []
const defaults = () => ({ accepted: [], blocked: [], notifications: {}, readAt: {}, readReceipts: true })
const recordsFor = owner => { if (!stores.has(owner)) stores.set(owner, new Map()); return stores.get(owner) }
const store = {
  defaultMessagingPreferences: defaults,
  eventStorageKey: e => `${e.author}:${e.conversationId}:${e.id}`,
  getStoredEvents: async owner => structuredClone([...recordsFor(owner).values()]),
  saveStoredEvent: async (owner, record) => {
    if (failPersistence || failAfter-- <= 0) throw new Error('Disk full')
    const prior = recordsFor(owner).get(record.key)
    if (prior && JSON.stringify(prior.event) !== JSON.stringify(record.event)) throw new Error('Conflicting message identifier')
    recordsFor(owner).set(record.key, structuredClone(prior ? { ...prior, ...record, local: prior.local || record.local, receivedAt: Math.min(prior.receivedAt, record.receivedAt), delivered: [...new Set([...prior.delivered, ...record.delivered])] } : record))
  },
  getMessagingPreferences: async owner => structuredClone(prefs.get(owner) || defaults()),
  saveMessagingPreferences: async (owner, value) => { prefs.set(owner, structuredClone(value)) },
  getSyncCursor: async owner => cursors.get(owner) || 0,
  saveSyncCursor: async (owner, value) => { cursors.set(owner, value) },
}
const relay = {
  storeEncryptedEvent: async (data, proof) => {
    assert.equal(await authentication.verifyRequestProof('event:send', data, proof), true)
    attempts.push({ owner: proof.publicKey, ...data })
    if (data.recipientPubKey === rejectRecipient) return { success: false, error: 'Recipient relay unavailable' }
    if (!packets.some(p => p.senderPubKey === proof.publicKey && p.recipientPubKey === data.recipientPubKey && p.id === data.id)) packets.push({ ...data, senderPubKey: proof.publicKey, sequence: packets.length + 1, createdAt: Date.now() })
    return { success: true }
  },
  getEventFeed: async (data, proof) => {
    assert.equal(await authentication.verifyRequestProof('event:sync', data, proof), true)
    const messages = packets.filter(p => p.sequence > (data.after || 0) && (p.senderPubKey === proof.publicKey || p.recipientPubKey === proof.publicKey))
    return { success: true, messages, nextCursor: messages.at(-1)?.sequence || data.after || 0, hasMore: false }
  },
  getLegacyInbox: async () => ({ success: true, messages: legacyPackets, nextCursor: null }),
  deleteMessage: async data => { acknowledgments.push(data); return { success: true } },
}
function load(filename) {
  if (!path.extname(filename)) filename += '.ts'
  if (modules.has(filename)) return modules.get(filename).exports
  const module = { exports: {} }; modules.set(filename, module)
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  function sourceRequire(specifier) {
    if (specifier === 'idb') return { openDB: async () => { throw new Error('No IndexedDB expected during validation') } }
    if (specifier === './messaging-store') return store
    if (specifier === './relay-client') return relay
    if (specifier === './storage') return { exportAllMessagesFromStorage: async owner => structuredClone(history.get(owner) || []), migrateLegacyHistory: async () => {} }
    if (specifier === './message-notifications') return { notifyIncoming() {}, requestMessagingNotifications: async () => 'denied' }
    if (specifier.startsWith('.')) return load(path.resolve(path.dirname(filename), specifier))
    return require(specifier)
  }
  new Function('require', 'module', 'exports', 'navigator', 'window', 'localStorage', output)(sourceRequire, module, module.exports, {}, new EventTarget(), { getItem: () => null })
  return module.exports
}
const cryptography = load(path.join(root, 'lib/crypto.ts'))
const authentication = load(path.join(root, 'lib/request-auth.ts'))
const { MessagingEngine } = load(path.join(root, 'lib/messaging.ts'))
let alice, bob
before(async () => {
  async function identity() { const keys = await cryptography.generateEncryptionKeyPair(); return { version: 2, publicKey: await cryptography.exportPublicKeyToHex(keys.publicKey), privateKey: await cryptography.exportKey(keys.privateKey) } }
  ;[alice, bob] = await Promise.all([identity(), identity()])
})
beforeEach(() => { stores.clear(); prefs.clear(); cursors.clear(); packets.length = attempts.length = 0; rejectRecipient = undefined; failPersistence = false; failAfter = Infinity; history.clear(); legacyPackets.length = acknowledgments.length = 0 })
async function engine(identity) {
  const instance = new MessagingEngine(identity)
  instance.key = await cryptography.importKey(identity.privateKey, 'encryption', 'private')
  const synchronize = instance.sync
  instance.sync = async () => {}
  await instance.refresh()
  return { instance, synchronize }
}


const { assembleAttachment } = load(path.join(root, 'lib/attachments.ts'))
const { validateMessagingEvent } = load(path.join(root, 'lib/messaging.ts'))
const { validateMessagingSnapshot } = load(path.join(root, 'lib/messaging-store.ts'))
function attachment(name, bytes) { return { name, type: 'application/octet-stream', size: bytes.length, data: Buffer.from(bytes).toString('base64') } }
const binary = Buffer.from(Array.from({ length: 75000 }, (_, index) => (index * 97) % 256))
function oldRow(delivery, content = 'Caption') {
  return { id: crypto.randomUUID(), peerPubKey: bob.publicKey, senderPubKey: alice.publicKey,
    content, timestamp: Date.now(), delivery, attachments: [attachment('binary.bin', binary), attachment('empty.bin', [])] }
}
async function assertFiles(instance, expected = binary) {
  await instance.refresh()
  const files = instance.model.messages.filter(message => message.attachment)
  assert.equal(files.length, 2)
  for (const message of files) {
    const blob = await assembleAttachment(message.attachment, instance.getAttachmentChunks(message.conversationId, message.id))
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()), message.attachment.name === 'binary.bin' ? expected : Buffer.alloc(0))
  }
  return files
}

test('legacy local history preserves captions, multiple files, empty files and stable IDs across repeated migration', async () => {
  history.set(alice.publicKey, [oldRow('sent')])
  const sender = await engine(alice)
  await sender.instance.migrateLocalHistory()
  const initial = structuredClone([...recordsFor(alice.publicKey).values()])
  const files = await assertFiles(sender.instance)
  assert.ok(files.every(file => file.delivery === 'sent'))
  assert.equal(sender.instance.model.messages.find(message => !message.attachment).content, 'Caption')
  await sender.instance.migrateLocalHistory()
  assert.deepEqual([...recordsFor(alice.publicKey).values()], initial)
})

test('pending file-only legacy messages become valid signed events and deliver every byte through the new relay', async () => {
  history.set(alice.publicKey, [oldRow('pending', '')])
  const sender = await engine(alice)
  await sender.instance.migrateLocalHistory()
  for (const record of recordsFor(alice.publicKey).values()) assert.equal(await validateMessagingEvent(record.event), true)
  await sender.instance.migrateLocalHistory()
  await sender.synchronize()
  assert.equal(sender.instance.model.messages.length, 2, 'file-only sends do not add an empty text bubble')
  assert.ok((await assertFiles(sender.instance)).every(file => file.delivery === 'sent'))
  const receiver = await engine(bob)
  await receiver.synchronize()
  await assertFiles(receiver.instance)
})

test('legacy inbox keeps the encrypted packet until every migrated file piece is durable and resumes after a partial write', async () => {
  const row = oldRow('sent')
  const envelope = { version: 3, id: row.id, sender: alice.publicKey, recipient: bob.publicKey, timestamp: row.timestamp, content: row.content, attachments: row.attachments }
  const key = await cryptography.importKey(alice.privateKey, 'encryption', 'private')
  legacyPackets.push({ id: row.id, senderPubKey: alice.publicKey, createdAt: row.timestamp,
    encryptedData: await cryptography.encryptForPeer(JSON.stringify(envelope), key, bob.publicKey) })
  const receiver = await engine(bob)
  failAfter = 2
  await receiver.instance.readLegacyInbox()
  assert.equal(acknowledgments.length, 0)
  assert.equal(recordsFor(bob.publicKey).size, 2)
  failAfter = Infinity
  await receiver.instance.readLegacyInbox()
  assert.equal(acknowledgments.length, 1)
  await assertFiles(receiver.instance)
  const count = recordsFor(bob.publicKey).size
  await receiver.instance.readLegacyInbox()
  assert.equal(recordsFor(bob.publicKey).size, count)
  // Importing the same message from the legacy local database also deduplicates.
  history.set(bob.publicKey, [{ ...row, peerPubKey: alice.publicKey, delivery: 'received' }])
  await receiver.instance.migrateLocalHistory()
  assert.equal(recordsFor(bob.publicKey).size, count)
})

test('converted legacy attachment snapshots restore as display-only history and reject executable controls or malformed chunks', async () => {
  history.set(alice.publicKey, [oldRow('sent')])
  const sender = await engine(alice)
  await sender.instance.migrateLocalHistory()
  const snapshot = { version: 3, owner: alice.publicKey, events: structuredClone([...recordsFor(alice.publicKey).values()]), preferences: defaults() }
  const validated = await validateMessagingSnapshot(structuredClone(snapshot), alice.publicKey)
  assert.ok(validated.events.every(record => record.legacy && !record.local))
  recordsFor(alice.publicKey).clear()
  for (const record of validated.events) await store.saveStoredEvent(alice.publicKey, record)
  await assertFiles(sender.instance)
  const invalidControl = structuredClone(snapshot)
  invalidControl.events[0].event.kind = 'pin'
  invalidControl.events[0].event.payload = { targetId: crypto.randomUUID(), pinned: true }
  await assert.rejects(validateMessagingSnapshot(invalidControl, alice.publicKey), /invalid legacy history/)
  const invalidChunk = structuredClone(snapshot)
  invalidChunk.events.find(record => record.event.kind === 'attachment-chunk').event.payload.index = -1
  await assert.rejects(validateMessagingSnapshot(invalidChunk, alice.publicKey), /invalid legacy history/)
})
