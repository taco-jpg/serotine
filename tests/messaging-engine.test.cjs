const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test, before, beforeEach } = require('node:test')
const ts = require('typescript')
const root = path.join(__dirname, '..')
const modules = new Map(), stores = new Map(), prefs = new Map(), cursors = new Map()
const packets = [], attempts = []
let rejectRecipient, failPersistence = false
const defaults = () => ({ accepted: [], blocked: [], notifications: {}, readAt: {}, readReceipts: true })
const recordsFor = owner => { if (!stores.has(owner)) stores.set(owner, new Map()); return stores.get(owner) }
const store = {
  defaultMessagingPreferences: defaults,
  eventStorageKey: e => `${e.author}:${e.conversationId}:${e.id}`,
  getStoredEvents: async owner => structuredClone([...recordsFor(owner).values()]),
  saveStoredEvent: async (owner, record) => {
    if (failPersistence) throw new Error('Disk full')
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
  getLegacyInbox: async () => ({ success: true, messages: [], nextCursor: null }),
  deleteMessage: async () => ({ success: true }),
}
function load(filename) {
  if (!path.extname(filename)) filename += '.ts'
  if (modules.has(filename)) return modules.get(filename).exports
  const module = { exports: {} }; modules.set(filename, module)
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  function sourceRequire(specifier) {
    if (specifier === './messaging-store') return store
    if (specifier === './relay-client') return relay
    if (specifier === './storage') return { exportAllMessagesFromStorage: async () => [], migrateLegacyHistory: async () => {} }
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
let alice, bob, charlie
before(async () => {
  async function identity() { const keys = await cryptography.generateEncryptionKeyPair(); return { version: 2, publicKey: await cryptography.exportPublicKeyToHex(keys.publicKey), privateKey: await cryptography.exportKey(keys.privateKey) } }
  ;[alice, bob, charlie] = await Promise.all([identity(), identity(), identity()])
})
beforeEach(() => { stores.clear(); prefs.clear(); cursors.clear(); packets.length = attempts.length = 0; rejectRecipient = undefined; failPersistence = false })
async function engine(identity) {
  const instance = new MessagingEngine(identity)
  instance.key = await cryptography.importKey(identity.privateKey, 'encryption', 'private')
  const synchronize = instance.sync
  instance.sync = async () => {}
  await instance.refresh()
  return { instance, synchronize }
}

test('self messages use the owner address and survive encrypted relay sync without duplicates', async () => {
  const { instance, synchronize } = await engine(alice)
  const id = await instance.sendText(alice.publicKey, 'A note to myself')
  assert.equal(instance.model.messages.length, 1)
  assert.equal(instance.model.messages[0].delivery, 'pending')
  await synchronize()
  assert.equal(instance.model.messages.length, 1)
  assert.equal(instance.model.messages[0].id, id)
  assert.equal(instance.model.messages[0].delivery, 'sent')
  assert.equal(instance.model.conversations.find(c => c.id === alice.publicKey).kind, 'self')
  assert.equal(packets[0].recipientPubKey, alice.publicKey)
  assert.equal(packets[0].encryptedData.includes('A note to myself'), false)
})

test('a storage failure stops the sync cursor until the incoming message can be saved', async () => {
  const sender = await engine(bob)
  await sender.instance.sendText(alice.publicKey, 'Do not lose this message')
  await sender.synchronize()
  const receiver = await engine(alice)
  failPersistence = true
  await receiver.synchronize()
  assert.equal(cursors.get(alice.publicKey) || 0, 0)
  assert.match(receiver.instance.error, /Disk full/)
  failPersistence = false
  await receiver.synchronize()
  assert.equal(receiver.instance.model.messages[0].content, 'Do not lose this message')
  assert.ok(cursors.get(alice.publicKey) > 0)
})

test('failed fanout retains recipient acknowledgements and retries only its missing destinations', async () => {
  const sender = await engine(alice)
  const cid = await sender.instance.createGroup('Team', [bob.publicKey, charlie.publicKey])
  await sender.synchronize()
  const id = await sender.instance.sendText(cid, 'To the group')
  rejectRecipient = charlie.publicKey
  await sender.synchronize()
  const record = [...recordsFor(alice.publicKey).values()].find(r => r.event.id === id)
  assert.deepEqual(record.delivered, [bob.publicKey])
  assert.equal(sender.instance.model.messages.find(m => m.id === id).delivery, 'failed')
  const attempted = attempts.filter(a => a.id === id).length
  await sender.synchronize()
  assert.equal(attempts.filter(a => a.id === id).length, attempted, 'failed sends wait for explicit retry')
  rejectRecipient = undefined
  await sender.instance.retry(id)
  await sender.synchronize()
  assert.equal(attempts.filter(a => a.id === id && a.recipientPubKey === bob.publicKey).length, 1)
  assert.equal(sender.instance.model.messages.find(m => m.id === id).delivery, 'sent')
})

test('failure to queue a new message does not publish it to the relay', async () => {
  const sender = await engine(alice)
  failPersistence = true
  await assert.rejects(sender.instance.sendText(bob.publicKey, 'keep my draft'), /Disk full/)
  assert.equal(attempts.length, 0)
  assert.equal(packets.length, 0)
})
