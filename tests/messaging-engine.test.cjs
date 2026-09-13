const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test, before, beforeEach } = require('node:test')
const ts = require('typescript')
const root = path.join(__dirname, '..')
const modules = new Map(), stores = new Map(), prefs = new Map(), cursors = new Map()
const packets = [], attempts = []
const runtimeWindow = new EventTarget()
let rejectRecipient, rateLimitRecipient, rejectError, failPersistence = false, historyReads = 0
const retiredRecipient = "This contact's address has been permanently retired. Ask them for their new address."
const retiredIdentity = 'This identity has been permanently retired. Use your new address; old backups and linked devices cannot access this relay.'
const defaults = () => ({ accepted: [], blocked: [], notifications: {}, readAt: {}, readReceipts: true, archived: [], deleted: {} })
const recordsFor = owner => { if (!stores.has(owner)) stores.set(owner, new Map()); return stores.get(owner) }
const store = {
  defaultMessagingPreferences: defaults,
  eventStorageKey: e => `${e.author}:${e.conversationId}:${e.id}`,
  getStoredEvents: async owner => { historyReads++; return structuredClone([...recordsFor(owner).values()]) },
  saveStoredEvent: async (owner, record) => {
    if (failPersistence) throw new Error('Disk full')
    if (history.isDeletedConversationEvent(record, owner, prefs.get(owner) || defaults())) return false
    const prior = recordsFor(owner).get(record.key)
    if (prior && JSON.stringify(prior.event) !== JSON.stringify(record.event)) throw new Error('Conflicting message identifier')
    recordsFor(owner).set(record.key, structuredClone(prior ? { ...prior, ...record, local: prior.local || record.local, receivedAt: Math.min(prior.receivedAt, record.receivedAt), delivered: [...new Set([...prior.delivered, ...record.delivered])] } : record))
    return true
  },
  deleteStoredConversation: async (owner, cid) => {
    const p = prefs.get(owner) || defaults()
    const rows = [...recordsFor(owner).values()]
    const model = messaging.buildMessagingModel(rows, owner, [], p, undefined, true)
    const conversation = model.conversations.find(c => c.id === cid), group = model.groups.find(g => g.id === cid)
    const removed = rows.filter(row => messaging.conversationForEvent(row.event, owner) === cid && !((row.event.kind === 'group' || row.event.kind === 'leave') && row.local && row.event.recipients.some(peer => !row.delivered.includes(peer))))
    const prior = p.deleted[cid]
    const attachmentIds = [...new Set([...(prior?.attachmentIds || []), ...removed.flatMap(row => { const id = row.event.payload.attachmentId || row.event.payload.attachment?.id; return id ? [id] : [] })])]
    const deletion = { deletedAt: Math.max(Date.now(), prior?.deletedAt || 0), eventKeys: [...new Set([...(prior?.eventKeys || []), ...removed.map(row => row.key)])], attachmentIds, ...(group ? { group, leftMembers: group.members.filter(member => !conversation.members.includes(member)) } : {}) }
    for (const row of removed) recordsFor(owner).delete(row.key)
    prefs.set(owner, structuredClone({ ...p, archived: p.archived.filter(id => id !== cid), deleted: { ...p.deleted, [cid]: deletion } }))
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
    if (data.recipientPubKey === rejectRecipient) return { success: false, error: rejectError }
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
    if (specifier === './storage') return { exportAllMessagesFromStorage: async () => [], migrateLegacyHistory: async () => {}, deleteConversationHistoryFromStorage: async () => {} }
    if (specifier === './message-notifications') return { notifyIncoming() {}, requestMessagingNotifications: async () => 'denied' }
    if (specifier.startsWith('.')) return load(path.resolve(path.dirname(filename), specifier))
    return require(specifier)
  }
  new Function('require', 'module', 'exports', 'navigator', 'window', 'localStorage', output)(sourceRequire, module, module.exports, {}, runtimeWindow, { getItem: () => null })
  return module.exports
}
const cryptography = load(path.join(root, 'lib/crypto.ts'))
const authentication = load(path.join(root, 'lib/request-auth.ts'))
const messaging = load(path.join(root, 'lib/messaging.ts'))
const { MessagingEngine } = messaging
const history = load(path.join(root, 'lib/messaging-history.ts'))
let alice, bob, charlie, dave
before(async () => {
  async function identity() { const keys = await cryptography.generateEncryptionKeyPair(); return { version: 2, publicKey: await cryptography.exportPublicKeyToHex(keys.publicKey), privateKey: await cryptography.exportKey(keys.privateKey) } }
  ;[alice, bob, charlie, dave] = await Promise.all([identity(), identity(), identity(), identity()])
})
beforeEach(() => { stores.clear(); prefs.clear(); cursors.clear(); packets.length = attempts.length = 0; rejectRecipient = rateLimitRecipient = undefined; rejectError = 'Recipient relay unavailable'; failPersistence = false; historyReads = 0 })
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

test('a retired contact only fails its own conversation while healthy sends and incoming messages stay online', async () => {
  const peer = await engine(charlie)
  const incoming = await peer.instance.sendText(alice.publicKey, 'You can still receive messages')
  await peer.synchronize()
  const sender = await engine(alice)
  const failed = await sender.instance.sendText(bob.publicKey, 'This old address is retired')
  const healthy = await sender.instance.sendText(charlie.publicKey, 'This conversation works')
  rejectRecipient = bob.publicKey
  rejectError = retiredRecipient
  await sender.synchronize()
  assert.equal(sender.instance.status, 'online')
  assert.equal(sender.instance.error, null)
  assert.equal(sender.instance.model.messages.find(m => m.id === failed).delivery, 'failed')
  assert.equal(sender.instance.model.messages.find(m => m.id === failed).error, retiredRecipient)
  assert.equal(sender.instance.model.conversations.find(c => c.id === bob.publicKey).sendError, retiredRecipient)
  assert.equal(sender.instance.model.conversations.find(c => c.id === charlie.publicKey).sendError, undefined)
  assert.equal(sender.instance.model.conversations.find(c => c.id === alice.publicKey).sendError, undefined)
  assert.equal(sender.instance.model.messages.find(m => m.id === healthy).delivery, 'sent')
  assert.equal(sender.instance.model.messages.find(m => m.id === incoming).content, 'You can still receive messages')
})

test('saved failed sends survive recreation without making a healthy relay offline and recovery clears global errors', async t => {
  const original = await engine(alice)
  const id = await original.instance.sendText(bob.publicKey, 'Preserve the failure for retry')
  rejectRecipient = bob.publicKey
  rejectError = retiredRecipient
  await original.synchronize()
  for (const record of recordsFor(alice.publicKey).values()) delete record.failedRecipients
  original.instance.dispose()
  const attempted = attempts.filter(a => a.id === id).length
  const recreated = await engine(alice)
  await recreated.synchronize()
  assert.equal(recreated.instance.status, 'online')
  assert.equal(recreated.instance.error, null)
  assert.equal(recreated.instance.model.conversations.find(c => c.id === bob.publicKey).sendError, retiredRecipient)
  const feed = t.mock.method(relay, 'getEventFeed', async () => ({ success: false, error: 'The relay is unavailable' }))
  await recreated.synchronize()
  assert.equal(recreated.instance.status, 'offline')
  assert.equal(recreated.instance.error, 'The relay is unavailable')
  feed.mock.restore()
  await recreated.synchronize()
  assert.equal(recreated.instance.status, 'online')
  assert.equal(recreated.instance.error, null)
  assert.equal(recreated.instance.model.messages.find(m => m.id === id).delivery, 'failed')
  assert.equal(attempts.filter(a => a.id === id).length, attempted, 'saved failures require an explicit retry')
})

test('an origin refusal fails self text and contact files; a fresh client reconnects and explicit retries recover both', async t => {
  const refusal = 'Open Serotine directly to reconnect to messaging.'
  const files = load(path.join(root, 'lib/attachments.ts'))
  const original = await engine(alice)
  const selfId = await original.instance.sendText(alice.publicKey, 'Hi')
  const bytes = new Uint8Array(files.ATTACHMENT_CHUNK_BYTES + 19).fill(37)
  const fileId = await files.sendAttachment(original.instance.sendEvent, bob.publicKey, new File([bytes], 'photo.bin'))
  const blocked = ['storeEncryptedEvent', 'getEventFeed', 'getLegacyInbox'].map(method =>
    t.mock.method(relay, method, async () => ({ success: false, error: refusal })))
  await original.synchronize()
  assert.equal(original.instance.status, 'offline')
  assert.equal(original.instance.error, refusal)
  for (const cid of [alice.publicKey, bob.publicKey]) {
    assert.equal(original.instance.model.conversations.find(c => c.id === cid).sendError, refusal)
  }
  for (const id of [selfId, fileId]) assert.equal(original.instance.model.messages.find(m => m.id === id).delivery, 'failed')
  assert.equal(packets.length, 0)

  original.instance.dispose()
  blocked.forEach(mock => mock.mock.restore())
  const updated = await engine(alice)
  t.after(() => updated.instance.dispose())
  await updated.synchronize()
  assert.equal(updated.instance.status, 'online')
  assert.equal(updated.instance.error, null)
  assert.equal(packets.length, 0, 'reconnecting must not silently resend rejected content')
  for (const id of [selfId, fileId]) {
    assert.equal(updated.instance.model.messages.find(m => m.id === id).delivery, 'failed')
    await updated.instance.retry(id)
    await updated.synchronize()
    assert.equal(updated.instance.model.messages.find(m => m.id === id).delivery, 'sent')
  }
  for (const cid of [alice.publicKey, bob.publicKey]) {
    assert.equal(updated.instance.model.conversations.find(c => c.id === cid).sendError, undefined)
  }
  assert.equal(packets.filter(packet => packet.id === selfId).length, 1)
  assert.equal(packets.filter(packet => packet.id === fileId).length, 1)
  const receiver = await engine(bob)
  t.after(() => receiver.instance.dispose())
  await receiver.synchronize()
  const received = receiver.instance.model.messages.find(m => m.id === fileId)
  const restored = await files.assembleAttachment(received.attachment, receiver.instance.getAttachmentChunks(alice.publicKey, fileId))
  assert.deepEqual(new Uint8Array(await restored.arrayBuffer()), bytes)
})

test('a retired first group member does not block later members or later outbox batches', async () => {
  const sender = await engine(alice)
  const cid = await sender.instance.createGroup('Team', [bob.publicKey, charlie.publicKey])
  await sender.synchronize()
  const groupMessage = await sender.instance.sendText(cid, 'Reach the active members')
  const unrelated = []
  for (let i = 0; i < 6; i++) unrelated.push(await sender.instance.sendText(alice.publicKey, `Saved note ${i}`))
  rejectRecipient = bob.publicKey
  rejectError = retiredRecipient
  await sender.synchronize()
  const record = [...recordsFor(alice.publicKey).values()].find(r => r.event.id === groupMessage)
  assert.deepEqual(record.delivered, [charlie.publicKey])
  assert.ok(record.error.endsWith(retiredRecipient), 'a later successful member must not clear the first refusal')
  assert.equal(sender.instance.model.conversations.find(c => c.id === cid).sendError, record.error)
  assert.equal(sender.instance.model.conversations.find(c => c.id === alice.publicKey).sendError, undefined)
  for (const id of unrelated) assert.equal(sender.instance.model.messages.find(m => m.id === id).delivery, 'sent')
  assert.equal(sender.instance.status, 'online')
  assert.equal(sender.instance.error, null)
  rejectRecipient = undefined
  await sender.instance.retry(groupMessage)
  await sender.synchronize()
  assert.equal(sender.instance.model.messages.find(m => m.id === groupMessage).delivery, 'sent')
  assert.equal(sender.instance.model.conversations.find(c => c.id === cid).sendError, undefined)
  assert.equal(attempts.filter(a => a.id === groupMessage && a.recipientPubKey === charlie.publicKey).length, 1, 'confirmed members must never be sent the event again')
  assert.equal(attempts.filter(a => a.id === groupMessage && a.recipientPubKey === bob.publicKey).length, 2)
})

for (const kind of ['receipt', 'group']) test(`failed ${kind} events expose their conversation error even without visible messages`, async () => {
  const sender = await engine(alice)
  const cid = kind === 'group'
    ? await sender.instance.createGroup('Invite', [bob.publicKey])
    : bob.publicKey
  if (kind === 'receipt') await sender.instance.sendEvent(cid, 'receipt', { targetId: crypto.randomUUID(), receipt: 'delivered' })
  rejectRecipient = bob.publicKey
  rejectError = retiredRecipient
  await sender.synchronize()
  assert.equal(sender.instance.model.messages.length, 0)
  const conversation = sender.instance.model.conversations.find(c => c.id === cid)
  assert.ok(conversation, 'the failure must remain discoverable without a message bubble')
  assert.ok(conversation.sendError.endsWith(retiredRecipient))
  assert.equal(sender.instance.model.conversations.find(c => c.id === alice.publicKey).sendError, undefined)
  assert.equal(sender.instance.status, 'online')
  assert.equal(sender.instance.error, null)
})

test('a failed group departure stays visible on its conversation after local membership ends', async () => {
  const sender = await engine(alice)
  const cid = await sender.instance.createGroup('Departing group', [bob.publicKey])
  await sender.synchronize()
  await sender.instance.leaveGroup(cid)
  rejectRecipient = bob.publicKey
  rejectError = retiredRecipient
  await sender.synchronize()
  const departure = [...recordsFor(alice.publicKey).values()].find(r => r.event.kind === 'leave')
  const conversation = sender.instance.model.conversations.find(c => c.id === cid)
  assert.ok(departure.error.endsWith(retiredRecipient))
  assert.equal(conversation.sendError, departure.error)
  assert.equal(conversation.members.includes(alice.publicKey), false)
  assert.equal(sender.instance.model.messages.length, 0)
  assert.equal(sender.instance.status, 'online')
  assert.equal(sender.instance.error, null)
})

test('a group resumes rate-limited members after recreation while retired recipients still wait for explicit retry', async () => {
  const sender = await engine(alice)
  const cid = await sender.instance.createGroup('Mixed delivery', [bob.publicKey, charlie.publicKey, dave.publicKey])
  await sender.synchronize()
  const id = await sender.instance.sendText(cid, 'Every active member should receive this')
  rejectRecipient = bob.publicKey
  rejectError = retiredRecipient
  rateLimitRecipient = charlie.publicKey
  await sender.synchronize()
  const saved = [...recordsFor(alice.publicKey).values()].find(r => r.event.id === id)
  assert.deepEqual(saved.failedRecipients, [bob.publicKey], 'rate limits must not become permanent recipient failures')
  assert.deepEqual(saved.delivered, [])
  assert.equal(attempts.filter(a => a.id === id && a.recipientPubKey === dave.publicKey).length, 0)
  sender.instance.dispose()
  rateLimitRecipient = undefined
  const recreated = await engine(alice)
  recreated.instance.outboxRetryAt = Date.now() - 1
  await recreated.synchronize()
  const resumed = [...recordsFor(alice.publicKey).values()].find(r => r.event.id === id)
  assert.deepEqual(resumed.delivered, [charlie.publicKey, dave.publicKey])
  assert.deepEqual(resumed.failedRecipients, [bob.publicKey])
  assert.ok(resumed.error.endsWith(retiredRecipient))
  assert.equal(recreated.instance.model.conversations.find(c => c.id === cid).sendError, resumed.error)
  assert.equal(recreated.instance.status, 'online')
  assert.equal(recreated.instance.error, null)
  assert.equal(attempts.filter(a => a.id === id && a.recipientPubKey === bob.publicKey).length, 1)
  assert.equal(attempts.filter(a => a.id === id && a.recipientPubKey === charlie.publicKey).length, 2)
  assert.equal(attempts.filter(a => a.id === id && a.recipientPubKey === dave.publicKey).length, 1)
  rejectRecipient = undefined
  await recreated.instance.retry(id)
  await recreated.synchronize()
  const delivered = [...recordsFor(alice.publicKey).values()].find(r => r.event.id === id)
  assert.equal(delivered.error, undefined)
  assert.equal(delivered.failedRecipients, undefined)
  assert.equal(recreated.instance.model.messages.find(m => m.id === id).delivery, 'sent')
  assert.equal(recreated.instance.model.conversations.find(c => c.id === cid).sendError, undefined)
  assert.equal(attempts.filter(a => a.id === id && a.recipientPubKey === bob.publicKey).length, 2)
  assert.equal(attempts.filter(a => a.id === id && a.recipientPubKey === charlie.publicKey).length, 2)
  assert.equal(attempts.filter(a => a.id === id && a.recipientPubKey === dave.publicKey).length, 1)
})

test('a thrown send request still allows incoming sync to determine connectivity', async t => {
  const peer = await engine(charlie)
  const incoming = await peer.instance.sendText(alice.publicKey, 'Still reachable')
  await peer.synchronize()
  const sender = await engine(alice)
  const failed = await sender.instance.sendText(bob.publicKey, 'The write request fails')
  t.mock.method(relay, 'storeEncryptedEvent', async (data, proof) => {
    assert.equal(await authentication.verifyRequestProof('event:send', data, proof), true)
    throw new Error('Failed to fetch')
  })
  await sender.synchronize()
  assert.equal(sender.instance.model.messages.find(m => m.id === incoming).content, 'Still reachable')
  assert.equal(sender.instance.model.messages.find(m => m.id === failed).delivery, 'failed')
  assert.equal(sender.instance.model.conversations.find(c => c.id === bob.publicKey).sendError, 'Failed to fetch')
  assert.equal(sender.instance.status, 'online')
  assert.equal(sender.instance.error, null)
})

for (const method of ['getEventFeed', 'getLegacyInbox']) {
  for (const failure of ['The relay is unavailable', retiredIdentity]) test(`${method} refusal keeps a global sync error: ${failure}`, async t => {
    const sender = await engine(alice)
    t.mock.method(relay, method, async () => ({ success: false, error: failure }))
    await sender.synchronize()
    assert.equal(sender.instance.status, 'offline')
    assert.equal(sender.instance.error, failure)
    assert.equal(sender.instance.model.conversations.find(c => c.id === alice.publicKey).sendError, undefined)
  })
}

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

test('archiving survives reload and new direct messages without restoring the request list', async () => {
  const receiver = await engine(alice), sender = await engine(bob)
  await sender.instance.sendText(alice.publicKey, 'First request')
  await sender.synchronize(); await receiver.synchronize()
  assert.equal(receiver.instance.model.requests.length, 1)
  await receiver.instance.archiveConversation(bob.publicKey)
  const reloaded = await engine(alice)
  assert.equal(reloaded.instance.model.requests.length, 0)
  assert.equal(reloaded.instance.model.conversations.find(c => c.id === bob.publicKey).archived, true)
  await sender.instance.sendText(alice.publicKey, 'Still archived')
  await sender.synchronize(); await reloaded.synchronize()
  assert.equal(reloaded.instance.model.messages.length, 2)
  assert.equal(reloaded.instance.model.conversations.find(c => c.id === bob.publicKey).archived, true)
  assert.equal(reloaded.instance.model.requests.length, 0)
  await reloaded.instance.archiveConversation(bob.publicKey, false)
  assert.equal(reloaded.instance.model.requests.length, 1)
})

test('delete removes history and files, cancels pending sends, and relay replay cannot restore them', async () => {
  const files = load(path.join(root, 'lib/attachments.ts'))
  const sender = await engine(alice)
  await sender.instance.sendText(bob.publicKey, 'Previously delivered')
  await sender.synchronize()
  const id = await files.sendAttachment(sender.instance.sendEvent, bob.publicKey, new File(['Delete these bytes'], 'delete.txt'))
  const count = attempts.length
  await sender.instance.archiveConversation(bob.publicKey)
  await sender.instance.deleteConversation(bob.publicKey)
  assert.deepEqual(sender.instance.getAttachmentChunks(bob.publicKey, id), [])
  assert.equal(recordsFor(alice.publicKey).size, 0)
  assert.equal(sender.instance.model.conversations.some(c => c.id === bob.publicKey), false)
  cursors.set(alice.publicKey, 0)
  await sender.instance.retry(); await sender.synchronize()
  assert.equal(attempts.length, count)
  assert.equal(sender.instance.model.messages.length, 0)
  assert.equal(sender.instance.model.conversations.some(c => c.id === bob.publicKey), false)
  const fresh = await sender.instance.sendText(bob.publicKey, 'Reopen with a new message')
  assert.deepEqual(sender.instance.model.messages.map(m => m.id), [fresh])
  assert.equal(sender.instance.model.conversations.find(c => c.id === bob.publicKey).archived, false)
  assert.ok(prefs.get(alice.publicKey).deleted[bob.publicKey], 'reopening retains the deletion boundary')
})

test('deletion during signing cancels the old send before it can recreate the chat', async t => {
  const sender = await engine(alice)
  await sender.instance.sendText(bob.publicKey, 'Delete this chat')
  const entered = deferred(), release = deferred(), sign = crypto.subtle.sign
  t.mock.method(crypto.subtle, 'sign', async function (...args) { entered.resolve(); await release.promise; return sign.apply(this, args) })
  const send = sender.instance.sendText(bob.publicKey, 'Started before deletion')
  const rejected = assert.rejects(send, /chat was deleted/i)
  await entered.promise
  await sender.instance.deleteConversation(bob.publicKey)
  release.resolve(); await rejected
  assert.equal(recordsFor(alice.publicKey).size, 0)
  assert.equal(sender.instance.model.conversations.some(c => c.id === bob.publicKey), false)
})

test('deletion during encryption prevents the prepared request from reaching the relay', async t => {
  const sender = await engine(alice)
  await sender.instance.sendText(bob.publicKey, 'Pending send')
  const entered = deferred(), release = deferred(), encrypt = cryptography.encryptForPeer
  t.mock.method(cryptography, 'encryptForPeer', async (...args) => { entered.resolve(); await release.promise; return encrypt(...args) })
  const sync = sender.synchronize()
  await entered.promise
  await sender.instance.deleteConversation(bob.publicKey)
  release.resolve(); await sync
  assert.equal(attempts.length, 0)
  assert.equal(recordsFor(alice.publicKey).size, 0)
})

test('deleting a departed group retains membership authority across reload and relay replay', async () => {
  const admin = await engine(alice), member = await engine(bob)
  const cid = await admin.instance.createGroup('Leave then delete', [bob.publicKey, charlie.publicKey])
  await admin.instance.sendText(cid, 'Old group history')
  await admin.synchronize(); await member.synchronize()
  await member.instance.leaveGroup(cid); await member.synchronize()
  const count = attempts.length
  await member.instance.archiveConversation(cid)
  assert.equal(member.instance.model.conversations.find(c => c.id === cid).archived, true)
  await member.instance.deleteConversation(cid)
  const reloaded = await engine(bob)
  cursors.set(bob.publicKey, 0)
  await reloaded.synchronize()
  assert.equal(attempts.length, count, 'local deletion sends no leave or delete command')
  assert.equal(reloaded.instance.model.conversations.some(c => c.id === cid), false)
  assert.equal(reloaded.instance.model.messages.length, 0)
  assert.equal(reloaded.instance.model.groups.find(g => g.id === cid).admin, alice.publicKey)
  assert.ok(prefs.get(bob.publicKey).deleted[cid].leftMembers.includes(bob.publicKey))
  await assert.rejects(reloaded.instance.sendText(cid, 'Cannot rejoin by deleting'), /no longer a member/i)
})

test('a hidden administrator chat still reconciles departures so remaining members can send', async () => {
  const admin = await engine(alice), departing = await engine(bob), remaining = await engine(charlie)
  const cid = await admin.instance.createGroup('Deleted by admin', [bob.publicKey, charlie.publicKey])
  await admin.instance.sendText(cid, 'Prior history')
  await admin.synchronize(); await departing.synchronize(); await remaining.synchronize()
  await admin.instance.deleteConversation(cid)
  await departing.instance.leaveGroup(cid); await departing.synchronize()
  await admin.synchronize(); await admin.synchronize(); await remaining.synchronize()
  assert.equal(admin.instance.model.conversations.some(c => c.id === cid), false)
  assert.ok(!remaining.instance.model.conversations.find(c => c.id === cid).members.includes(bob.publicKey))
  const fresh = await remaining.instance.sendText(cid, 'The remaining group works')
  await remaining.synchronize(); await admin.synchronize()
  assert.deepEqual(admin.instance.model.messages.map(m => m.id), [fresh])
})

test('offline leave followed by delete still delivers the pending departure after reconnecting', async () => {
  const admin = await engine(alice), member = await engine(bob)
  const cid = await admin.instance.createGroup('Offline departure', [bob.publicKey, charlie.publicKey])
  await admin.synchronize(); await member.synchronize()
  await member.instance.leaveGroup(cid)
  await member.instance.deleteConversation(cid)
  assert.ok([...recordsFor(bob.publicKey).values()].some(record => record.event.kind === 'leave' && record.local))
  await member.synchronize(); await admin.synchronize()
  assert.ok(!admin.instance.model.conversations.find(c => c.id === cid).members.includes(bob.publicKey))
  assert.equal(member.instance.model.conversations.some(c => c.id === cid), false)
})

test('deleting a chat during file preparation cancels later chunks and metadata for that transfer', async () => {
  const files = load(path.join(root, 'lib/attachments.ts'))
  const sender = await engine(alice)
  let deleted = false
  const send = async (cid, kind, payload) => {
    const id = await sender.instance.sendEvent(cid, kind, payload)
    if (!deleted && kind === 'attachment-chunk') { deleted = true; await sender.instance.deleteConversation(cid) }
    return id
  }
  await assert.rejects(files.sendAttachment(send, bob.publicKey, new File([new Uint8Array(files.ATTACHMENT_CHUNK_BYTES * 3)], 'cancel.bin')), /chat was deleted/i)
  assert.equal(recordsFor(alice.publicKey).size, 0)
  assert.equal(sender.instance.model.conversations.some(c => c.id === bob.publicKey), false)
  assert.equal(prefs.get(alice.publicKey).deleted[bob.publicKey].attachmentIds.length, 1)
  const fresh = await files.sendAttachment(sender.instance.sendEvent, bob.publicKey, new File(['Fresh transfer'], 'new.txt'))
  assert.equal(sender.instance.model.messages[0].id, fresh)
})
