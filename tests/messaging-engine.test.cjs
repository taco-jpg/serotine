const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test, before, beforeEach } = require('node:test')
const ts = require('typescript')
const root = path.join(__dirname, '..')
const modules = new Map(), stores = new Map(), prefs = new Map(), cursors = new Map()
const packets = [], attempts = []
const runtimeWindow = new EventTarget()
let rejectRecipient, rateLimitRecipient, failPersistence = false, historyReads = 0
const defaults = () => ({ accepted: [], blocked: [], notifications: {}, readAt: {}, readReceipts: true })
const recordsFor = owner => { if (!stores.has(owner)) stores.set(owner, new Map()); return stores.get(owner) }
const store = {
  defaultMessagingPreferences: defaults,
  eventStorageKey: e => `${e.author}:${e.conversationId}:${e.id}`,
  getStoredEvents: async owner => { historyReads++; return structuredClone([...recordsFor(owner).values()]) },
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
    if (data.recipientPubKey === rateLimitRecipient) return { success: false, error: 'Too many requests. Wait a minute and try again.', retryAfterMs: 61000 }
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
  new Function('require', 'module', 'exports', 'navigator', 'window', 'localStorage', output)(sourceRequire, module, module.exports, {}, runtimeWindow, { getItem: () => null })
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
beforeEach(() => { stores.clear(); prefs.clear(); cursors.clear(); packets.length = attempts.length = 0; rejectRecipient = rateLimitRecipient = undefined; failPersistence = false; historyReads = 0 })
async function engine(identity) {
  const instance = new MessagingEngine(identity)
  instance.key = await cryptography.importKey(identity.privateKey, 'encryption', 'private')
  const synchronize = instance.sync
  instance.sync = async () => {}
  await instance.refresh()
  return { instance, synchronize }
}
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('switching identities during message signing never queues the old send and rejects stale actions', async t => {
  const sender = await engine(alice)
  const entered = deferred(), release = deferred()
  const sign = crypto.subtle.sign
  t.mock.method(crypto.subtle, 'sign', async function (...args) { entered.resolve(); await release.promise; return sign.apply(this, args) })
  const send = sender.instance.sendText(bob.publicKey, 'Do not send after switching')
  const rejected = assert.rejects(send, /identity changed.*Reopen/i)
  await entered.promise
  sender.instance.dispose()
  release.resolve()
  await rejected
  await assert.rejects(sender.instance.sendText(bob.publicKey, 'Stale composer'), /identity changed.*Reopen/i)
  await assert.rejects(sender.instance.createGroup('Stale group', [bob.publicKey]), /identity changed.*Reopen/i)
  await assert.rejects(sender.instance.setReadReceipts(false), /identity changed.*Reopen/i)
  await assert.rejects(sender.instance.retry(), /identity changed.*Reopen/i)
  assert.equal(recordsFor(alice.publicKey).size, 0)
  assert.equal(prefs.size, 0)
  assert.equal(attempts.length, 0)
})

for (const phase of ['encryption', 'request proof']) test(`switching identities during outbox ${phase} prevents the prepared relay request`, async t => {
  const sender = await engine(alice)
  const id = await sender.instance.sendText(bob.publicKey, 'Keep this pending')
  const entered = deferred(), release = deferred()
  const target = phase === 'encryption' ? cryptography : authentication
  const method = phase === 'encryption' ? 'encryptForPeer' : 'createRequestProof'
  const prepare = target[method]
  t.mock.method(target, method, async (...args) => { entered.resolve(); await release.promise; return prepare(...args) })
  const synchronize = sender.synchronize()
  await entered.promise
  sender.instance.dispose()
  release.resolve()
  await synchronize
  const record = [...recordsFor(alice.publicKey).values()].find(record => record.event.id === id)
  assert.deepEqual(record.delivered, [])
  assert.equal(record.error, undefined, 'switching identities must not mark a durable send as failed')
  assert.equal(attempts.length, 0)
  assert.equal(packets.length, 0)
  assert.equal(cursors.size, 0)
})

test('disposing during asynchronous startup installs no listeners or timer and releases the imported key', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const sender = new MessagingEngine(alice)
  const entered = deferred(), release = deferred()
  const importKey = cryptography.importKey
  t.mock.method(cryptography, 'importKey', async (...args) => { entered.resolve(); await release.promise; return importKey(...args) })
  const addListener = t.mock.method(runtimeWindow, 'addEventListener')
  const starting = sender.start()
  await entered.promise
  sender.dispose()
  release.resolve()
  await starting
  assert.equal(sender.key, undefined)
  assert.equal(addListener.mock.callCount(), 0)
  assert.equal(historyReads, 0)
  assert.equal(sender.timer, undefined)
})

test('cached attachment chunks remain readable while a disposed conversation is still visible', async () => {
  const files = load(path.join(root, 'lib/attachments.ts'))
  const sender = await engine(alice)
  const id = await files.sendAttachment(sender.instance.sendEvent, bob.publicKey, new File(['Cached file'], 'cached.txt'))
  const chunks = sender.instance.getAttachmentChunks(bob.publicKey, id)
  assert.equal(chunks.length, 1)
  sender.instance.dispose()
  assert.deepEqual(sender.instance.getAttachmentChunks(bob.publicKey, id), chunks)
  assert.deepEqual(sender.instance.getAttachmentChunks(bob.publicKey, 'missing'), [])
  await assert.rejects(sender.instance.sendText(bob.publicKey, 'Stale composer'), /identity changed.*Reopen/i)
})

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

test('attachment pieces persist without reloading history for each piece and a storage failure keeps metadata unpublished', async () => {
  const files = load(path.join(root, 'lib/attachments.ts'))
  const sender = await engine(alice)
  historyReads = 0
  const file = new File([new Uint8Array(100 * files.ATTACHMENT_CHUNK_BYTES)], 'many-pieces.bin')
  const id = await files.sendAttachment(sender.instance.sendEvent, bob.publicKey, file)
  assert.equal(historyReads, 1, 'only the final metadata needs a full view refresh')
  assert.equal(recordsFor(alice.publicKey).size, 101)
  assert.equal(sender.instance.model.messages.find(m => m.id === id).attachment.chunks, 100)
  assert.equal(sender.instance.model.messages.find(m => m.id === id).delivery, 'pending')
  let queued = 0
  await assert.rejects(files.sendAttachment(async (...args) => {
    if (++queued === 3) failPersistence = true
    return sender.instance.sendEvent(...args)
  }, bob.publicKey, file), /Disk full/)
  assert.equal(recordsFor(alice.publicKey).size, 103, 'only the successful pieces were saved')
  assert.equal(sender.instance.model.messages.length, 1, 'no truncated attachment was published')
  failPersistence = false
  await sender.instance.sendText(bob.publicKey, 'The chat still works')
  assert.equal(sender.instance.model.messages.at(-1).content, 'The chat still works')
})

test('rate-limited group sends resume automatically without resending confirmed recipients', async () => {
  const sender = await engine(alice)
  const cid = await sender.instance.createGroup('Team', [bob.publicKey, charlie.publicKey])
  await sender.synchronize()
  const id = await sender.instance.sendText(cid, 'Continue the transfer')
  rateLimitRecipient = charlie.publicKey
  await sender.synchronize()
  const record = [...recordsFor(alice.publicKey).values()].find(r => r.event.id === id)
  assert.deepEqual(record.delivered, [bob.publicKey])
  assert.equal(record.error, undefined)
  assert.equal(sender.instance.model.messages.find(m => m.id === id).delivery, 'pending')
  const attempted = attempts.length
  await sender.synchronize()
  assert.equal(attempts.length, attempted, 'sync can receive messages while outgoing writes wait')
  rateLimitRecipient = undefined
  sender.instance.outboxRetryAt = Date.now() - 1
  await sender.synchronize()
  assert.equal(attempts.filter(a => a.id === id && a.recipientPubKey === bob.publicKey).length, 1)
  assert.equal(sender.instance.model.messages.find(m => m.id === id).delivery, 'sent')
})

test('the regular sync timer resumes a rate-limited transfer once the retry window expires', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() })
  const sender = await engine(alice)
  await sender.instance.start()
  t.after(() => sender.instance.dispose())
  const id = await sender.instance.sendText(bob.publicKey, 'Send after the rate window')
  const scheduled = []
  sender.instance.sync = () => { const run = sender.synchronize(); scheduled.push(run); return run }
  rateLimitRecipient = bob.publicKey
  t.mock.timers.tick(5000)
  await Promise.all(scheduled)
  assert.equal(sender.instance.model.messages.find(m => m.id === id).delivery, 'pending')
  assert.equal(attempts.length, 1)
  rateLimitRecipient = undefined
  t.mock.timers.tick(65000)
  await Promise.all(scheduled)
  assert.equal(sender.instance.model.messages.find(m => m.id === id).delivery, 'sent')
  assert.equal(packets.filter(p => p.id === id).length, 1)
})

test('retrying an attachment retries failed chunks and retains successful pieces', async () => {
  const files = load(path.join(root, 'lib/attachments.ts'))
  const sender = await engine(alice)
  const id = await files.sendAttachment(sender.instance.sendEvent, bob.publicKey, new File([new Uint8Array(files.ATTACHMENT_CHUNK_BYTES * 5)], 'retry.bin'))
  rejectRecipient = bob.publicKey
  await sender.synchronize()
  assert.equal(sender.instance.model.messages.find(m => m.id === id).delivery, 'failed')
  assert.match(sender.instance.model.messages.find(m => m.id === id).error, /relay unavailable/)
  rejectRecipient = undefined
  await sender.instance.retry(id)
  await sender.synchronize()
  assert.equal(sender.instance.model.messages.find(m => m.id === id).delivery, 'sent')
  const receiver = await engine(bob)
  await receiver.synchronize()
  const message = receiver.instance.model.messages.find(m => m.id === id)
  assert.equal((await files.assembleAttachment(message.attachment, receiver.instance.getAttachmentChunks(alice.publicKey, id))).size, files.ATTACHMENT_CHUNK_BYTES * 5)
})
