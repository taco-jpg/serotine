const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test, before, beforeEach } = require('node:test')
const ts = require('typescript')
const root = path.join(__dirname, '..'), modules = new Map(), stores = new Map()
const packets = [], notices = []
const defaults = () => ({ accepted: [], blocked: [], notifications: {}, readAt: {}, readReceipts: true, archived: [], deleted: {}, deletedMessages: {} })
const rows = owner => { if (!stores.has(owner)) stores.set(owner, new Map()); return stores.get(owner) }
const store = {
  defaultMessagingPreferences: defaults,
  eventStorageKey: event => `${event.author}:${event.conversationId}:${event.id}`,
  getMessagingPreferences: async () => defaults(),
  saveMessagingPreferences: async () => {},
  deleteStoredConversation: async () => {},
  getSyncCursor: async () => 0,
  saveSyncCursor: async () => {},
  getStoredEvents: async owner => {
    const records = [...rows(owner).values()], cutoffs = privacy.privateDestroyCutoffs(records, owner)
    for (const record of records) if (privacy.isPrivateEventExpired(record, owner, cutoffs)) rows(owner).delete(record.key)
    return structuredClone([...rows(owner).values()])
  },
  saveStoredEvent: async (owner, record) => {
    const cutoffs = privacy.privateDestroyCutoffs([...rows(owner).values(), record], owner)
    if (privacy.isPrivateEventExpired(record, owner, cutoffs)) return false
    const prior = rows(owner).get(record.key)
    rows(owner).set(record.key, structuredClone(prior ? { ...prior, ...record, delivered: [...new Set([...prior.delivered, ...record.delivered])] } : record))
    await store.getStoredEvents(owner)
    return true
  },
}
const relay = {
  storeEncryptedEvent: async (data, proof) => {
    assert.equal(await authentication.verifyRequestProof('event:send', data, proof), true)
    if (!packets.some(packet => packet.id === data.id)) packets.push({ ...data, senderPubKey: proof.publicKey, sequence: packets.length + 1, createdAt: Date.now() })
    return { success: true }
  },
  getEventFeed: async (data, proof) => ({ success: true, messages: packets.filter(packet => packet.senderPubKey === proof.publicKey || packet.recipientPubKey === proof.publicKey), nextCursor: packets.length, hasMore: false }),
  getLegacyInbox: async () => ({ success: true, messages: [], nextCursor: null }),
}
function load(filename) {
  if (!path.extname(filename)) filename += '.ts'
  if (modules.has(filename)) return modules.get(filename).exports
  const module = { exports: {} }; modules.set(filename, module)
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  function sourceRequire(name) {
    if (name === './messaging-store') return store
    if (name === './relay-client') return relay
    if (name === './storage') return { exportAllMessagesFromStorage: async () => [], migrateLegacyHistory: async () => {}, deleteConversationHistoryFromStorage: async () => {} }
    if (name === './message-notifications') return { notifyIncoming: message => notices.push(message), requestMessagingNotifications: async () => 'denied' }
    return name.startsWith('.') ? load(path.resolve(path.dirname(filename), name)) : require(name)
  }
  new Function('require', 'module', 'exports', 'navigator', 'window', 'localStorage', output)(sourceRequire, module, module.exports, {}, new EventTarget(), { getItem: () => null })
  return module.exports
}
const cryptography = load(path.join(root, 'lib/crypto.ts'))
const authentication = load(path.join(root, 'lib/request-auth.ts'))
const privacy = load(path.join(root, 'lib/private-messaging.ts'))
const messaging = load(path.join(root, 'lib/messaging.ts'))
let alice, bob, charlie
before(async () => {
  async function identity() { const pair = await cryptography.generateEncryptionKeyPair(); return { version: 2, publicKey: await cryptography.exportPublicKeyToHex(pair.publicKey), privateKey: await cryptography.exportKey(pair.privateKey) } }
  ;[alice, bob, charlie] = await Promise.all([identity(), identity(), identity()])
})
beforeEach(() => { stores.clear(); packets.length = 0; notices.length = 0 })
async function event(author, recipient, kind, payload, timestamp = Date.now() - 1000, extra = {}) {
  return messaging.signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: author.publicKey, conversationId: recipient.publicKey, recipients: [recipient.publicKey], timestamp, kind, payload, ...extra }, author)
}
function record(event, owner, index = 0) { return { key: store.eventStorageKey(event), event, local: owner.publicKey === event.author, delivered: [...event.recipients], receivedAt: index } }
function model(events, owner = alice, prefs = defaults()) { return messaging.buildMessagingModel(events.map((event, i) => record(event, owner, i)), owner.publicKey, [], prefs) }
async function engine(identity, t) {
  const instance = new messaging.MessagingEngine(identity)
  instance.key = await cryptography.importKey(identity.privateKey, 'encryption', 'private')
  const sync = instance.sync
  instance.sync = async () => {}
  await instance.refresh()
  t.after(() => instance.dispose())
  return { instance, sync }
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('private envelopes are signature-bound, direct-only, and strictly bounded', async () => {
  const now = Date.now() - 1000
  const valid = [
    await event(alice, bob, 'private-settings', { ttlSeconds: 300 }, now),
    await event(alice, bob, 'private-settings', { ttlSeconds: 0 }, now),
    await event(alice, bob, 'private-message', { content: 'key-value', expiresAt: now + 3600000, secret: true }, now),
    await event(bob, alice, 'private-destroy', { destroyBefore: now }, now),
  ]
  for (const envelope of valid) assert.equal(await messaging.validateMessagingEvent(envelope), true)
  assert.equal(await messaging.validateMessagingEvent({ ...valid[2], payload: { ...valid[2].payload, expiresAt: now + 10000 } }), false)
  for (const [kind, payload] of [
    ['private-settings', { ttlSeconds: 301 }], ['private-settings', { ttlSeconds: 300, content: 'hidden' }],
    ['private-message', { content: 'key', expiresAt: now }], ['private-message', { content: 'key', expiresAt: now + 86400001 }],
    ['private-message', { content: 'key', expiresAt: now + 300000, secret: 'true' }],
    ['private-message', { content: 'key', expiresAt: now + 300000, replyTo: crypto.randomUUID() }],
    ['private-message', { content: ' ', expiresAt: now + 300000 }],
    ['private-destroy', { destroyBefore: now + 1 }], ['private-destroy', { destroyBefore: 0 }],
    ['private-destroy', { destroyBefore: now, targetId: crypto.randomUUID() }],
    ['message', { content: 'Not a private event', secret: true }], ['message', { content: 'Not expiring', expiresAt: now + 300000 }],
  ]) assert.equal(await messaging.validateMessagingEvent(await event(alice, bob, kind, payload, now)), false, `${kind}: ${JSON.stringify(payload)}`)
  for (const envelope of valid) assert.equal(await messaging.validateMessagingEvent(await event(alice, alice, envelope.kind, envelope.payload, now)), false)
  const group = await messaging.signGroup({ id: `group:${crypto.randomUUID()}`, name: 'Group', admin: alice.publicKey, members: [alice.publicKey, bob.publicKey], epoch: 1, updatedAt: now }, alice)
  assert.equal(await messaging.validateMessagingEvent(await event(alice, bob, 'private-message', valid[2].payload, now, { conversationId: group.id, group })), false)
  assert.equal(await messaging.validateMessagingEvent(await event(alice, bob, 'message', { content: 'Ordinary messaging remains valid' }, now)), true)
})

test('settings converge by signed timestamp; an unrelated peer cannot change another conversation', async () => {
  const now = Date.now() - 5000
  const enabled = await event(alice, bob, 'private-settings', { ttlSeconds: 300 }, now)
  const disabled = await event(bob, alice, 'private-settings', { ttlSeconds: 0 }, now + 1)
  const unrelated = await event(charlie, bob, 'private-settings', { ttlSeconds: 86400 }, now + 2)
  for (const ordered of [[disabled, unrelated, enabled], [enabled, disabled, unrelated]]) {
    const state = model(ordered)
    assert.equal(state.conversations.find(c => c.id === bob.publicKey).privateTtlSeconds, 0)
    assert.equal(state.conversations.some(c => c.id === charlie.publicKey), false)
  }
  assert.equal(model([enabled], bob).conversations.find(c => c.id === alice.publicKey).privateTtlSeconds, 300)
})

test('expiry and either participant destruction remove only temporary messages in the matching direct chat', async () => {
  const now = Date.now(), old = now - 5000
  const ordinary = await event(alice, bob, 'message', { content: 'Keep normal history' }, old)
  const destroyed = await event(bob, alice, 'private-message', { content: 'Destroy me', expiresAt: now + 300000 }, old)
  const expired = await event(bob, alice, 'private-message', { content: 'Expired', expiresAt: now - 1 }, old + 1)
  const recent = await event(alice, bob, 'private-message', { content: 'Recent', expiresAt: now + 300000, secret: true }, now - 100)
  const other = await event(charlie, alice, 'private-message', { content: 'Other conversation', expiresAt: now + 300000 }, old)
  const destroy = await event(alice, bob, 'private-destroy', { destroyBefore: now - 1000 }, now)
  const foreign = await event(bob, charlie, 'private-destroy', { destroyBefore: now }, now)
  const state = model([destroy, foreign, ordinary, destroyed, expired, recent, other])
  assert.deepEqual(new Set(state.messages.map(message => message.id)), new Set([ordinary.id, recent.id, other.id]))
  assert.equal(state.conversations.find(c => c.id === bob.publicKey).lastMessage.content, 'Access key')
  assert.equal(state.conversations.find(c => c.id === bob.publicKey).unreadCount, 0)
  const peerDestroy = await event(bob, alice, 'private-destroy', { destroyBefore: now }, now)
  assert.deepEqual(model([ordinary, destroyed, recent, peerDestroy]).messages.map(message => message.id), [ordinary.id])
  assert.deepEqual(model([expired]).messages, [])
  assert.equal(model([expired]).conversations.some(c => c.id === bob.publicKey), false)
})

test('temporary messages cannot be edited, pinned, or retained as reply previews', async () => {
  const now = Date.now() - 1000
  const secret = await event(alice, bob, 'private-message', { content: 'Exact private value', expiresAt: now + 300000 }, now)
  const edit = await event(alice, bob, 'edit', { targetId: secret.id, content: 'Permanent replacement' }, now + 1)
  const pin = await event(bob, alice, 'pin', { targetId: secret.id, pinned: true }, now + 1)
  const reply = await event(bob, alice, 'message', { content: 'Reply', replyTo: secret.id }, now + 2)
  const state = model([edit, pin, reply, secret])
  const message = state.messages.find(m => m.id === secret.id)
  assert.equal(message.content, 'Exact private value')
  assert.equal(message.pinned, false)
  assert.equal(message.editedAt, undefined)
  assert.equal(state.messages.find(m => m.id === reply.id).replyTo, undefined)
})

test('private mode and standalone access keys survive encrypted relay sync without changing ordinary history', async t => {
  const sender = await engine(alice, t), receiver = await engine(bob, t)
  const ordinaryId = await sender.instance.sendText(bob.publicKey, 'Normal history')
  await sender.instance.setPrivateMode(bob.publicKey, 300)
  const privateId = await sender.instance.sendText(bob.publicKey, 'Temporary text')
  const privateRecord = [...rows(alice.publicKey).values()].find(r => r.event.id === privateId)
  assert.equal(privateRecord.event.kind, 'private-message')
  assert.equal(privateRecord.event.payload.expiresAt - privateRecord.event.timestamp, 300000)
  await assert.rejects(sender.instance.sendText(bob.publicKey, 'Reply', privateId), /cannot be replied/)
  await assert.rejects(sender.instance.pinMessage(bob.publicKey, privateId, true), /cannot be replied/)
  await assert.rejects(sender.instance.editMessage(bob.publicKey, privateId, 'Edited'), /ordinary text/)
  await assert.rejects(sender.instance.createPoll(bob.publicKey, 'Poll', ['A', 'B']), /private mode/)
  await assert.rejects(sender.instance.sendEvent(bob.publicKey, 'attachment-chunk', { attachmentId: crypto.randomUUID(), index: 0, data: 'YWJj' }), /private mode/)
  await sender.sync(); await receiver.sync()
  assert.equal(receiver.instance.model.conversations.find(c => c.id === alice.publicKey).privateTtlSeconds, 300)
  assert.equal(receiver.instance.model.messages.find(m => m.id === privateId).content, 'Temporary text')
  assert.ok(packets.every(packet => !packet.encryptedData.includes('Temporary text')))
  await receiver.instance.destroyPrivateHistory(alice.publicKey)
  await receiver.sync(); await sender.sync()
  assert.deepEqual(sender.instance.model.messages.map(m => m.id), [ordinaryId])
  await sender.instance.setPrivateMode(bob.publicKey, 0)
  const secretId = await sender.instance.sendSecret(bob.publicKey, '  Exact-Key-With-Spaces  ', 3600)
  const secret = sender.instance.model.messages.find(m => m.id === secretId)
  assert.equal(secret.content, '  Exact-Key-With-Spaces  ')
  assert.equal(secret.secret, true)
  assert.equal(secret.private, true)
  const normalId = await sender.instance.sendText(bob.publicKey, 'Normal again')
  assert.equal(sender.instance.model.messages.find(m => m.id === normalId).private, undefined)
  await assert.rejects(sender.instance.sendSecret(alice.publicKey, 'Self key'), /only in direct/)
  await assert.rejects(sender.instance.sendSecret(bob.publicKey, 'No expiry', 0), /Choose an expiry/)
})

test('an expiration timer clears plaintext from memory while offline, even before storage finishes', async t => {
  const now = Date.now()
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now })
  const sender = await engine(alice, t)
  const id = await sender.instance.sendSecret(bob.publicKey, 'Expire offline', 300)
  const entered = deferred(), release = deferred(), getStoredEvents = store.getStoredEvents
  t.mock.method(store, 'getStoredEvents', async owner => { entered.resolve(); await release.promise; return getStoredEvents(owner) })
  t.mock.timers.tick(300000)
  await entered.promise
  assert.equal(sender.instance.model.messages.some(message => message.id === id), false)
  assert.equal(JSON.stringify(sender.instance.records).includes('Expire offline'), false)
  release.resolve()
  await sender.instance.refresh()
  assert.equal(rows(alice.publicKey).size, 0)
})

for (const removal of ['expires', 'is destroyed']) test(`a prepared private send cannot reach the relay after it ${removal}`, async t => {
  const now = Date.now()
  t.mock.timers.enable({ apis: ['Date'], now })
  const sender = await engine(alice, t)
  const id = await sender.instance.sendSecret(bob.publicKey, 'Cancel the pending key', 300)
  const entered = deferred(), release = deferred(), encrypt = cryptography.encryptForPeer
  t.mock.method(cryptography, 'encryptForPeer', async (...args) => { entered.resolve(); await release.promise; return encrypt(...args) })
  const sync = sender.sync()
  await entered.promise
  if (removal === 'expires') t.mock.timers.tick(300000)
  else await sender.instance.destroyPrivateHistory(bob.publicKey)
  release.resolve(); await sync
  assert.equal(packets.some(packet => packet.id === id), false)
  assert.equal(sender.instance.model.messages.some(message => message.id === id), false)
})

test('expired inbound private content is not displayed or notified after relay sync', async t => {
  const now = Date.now()
  t.mock.timers.enable({ apis: ['Date'], now })
  const sender = await engine(alice, t), receiver = await engine(bob, t)
  await sender.instance.sendSecret(bob.publicKey, 'Already expired', 300)
  await sender.sync()
  t.mock.timers.tick(300000)
  await receiver.sync()
  assert.deepEqual(receiver.instance.model.messages, [])
  assert.deepEqual(notices, [])
})

test('destroy includes received private messages from a slightly faster peer clock and fresh messages remain sendable', async t => {
  const now = Date.now()
  t.mock.timers.enable({ apis: ['Date'], now })
  const sender = await engine(alice, t)
  const future = await event(bob, alice, 'private-message', { content: 'Received already', expiresAt: now + 3600000 }, now + 30000)
  assert.equal(await messaging.validateMessagingEvent(future), true)
  await store.saveStoredEvent(alice.publicKey, record(future, alice))
  await sender.instance.refresh()
  await sender.instance.destroyPrivateHistory(bob.publicKey)
  assert.deepEqual(sender.instance.model.messages, [])
  const destroy = [...rows(alice.publicKey).values()].find(record => record.event.kind === 'private-destroy')
  assert.equal(destroy.event.payload.destroyBefore, future.timestamp)
  assert.equal(await messaging.validateMessagingEvent(destroy.event), true)
  const fresh = await sender.instance.sendSecret(bob.publicKey, 'Fresh key')
  assert.equal(sender.instance.model.messages.find(message => message.id === fresh).content, 'Fresh key')
})

test('a submitted private draft cannot become persistent when the mode changes during asynchronous preparation', async t => {
  const sender = await engine(alice, t)
  await sender.instance.setPrivateMode(bob.publicKey, 300)
  const entered = deferred(), release = deferred()
  let paused = false
  t.mock.method(store, 'getMessagingPreferences', async () => {
    if (!paused) { paused = true; entered.resolve(); await release.promise }
    return defaults()
  })
  const pending = sender.instance.sendText(bob.publicKey, 'Captured private draft')
  await entered.promise
  await sender.instance.setPrivateMode(bob.publicKey, 0)
  release.resolve()
  const id = await pending
  assert.equal(sender.instance.model.messages.find(message => message.id === id).private, true)
  const staleComposer = await sender.instance.sendText(bob.publicKey, 'Private draft from previous render', undefined, undefined, 300)
  assert.equal(sender.instance.model.messages.find(message => message.id === staleComposer).private, true)
})

test('an older refresh completing after destroy cannot restore plaintext to the live model', async t => {
  const sender = await engine(alice, t)
  await sender.instance.sendSecret(bob.publicKey, 'Must stay destroyed')
  const entered = deferred(), release = deferred()
  let paused = false
  t.mock.method(store, 'getMessagingPreferences', async () => {
    if (!paused) { paused = true; entered.resolve(); await release.promise }
    return defaults()
  })
  const staleRefresh = sender.instance.refresh()
  await entered.promise
  await sender.instance.destroyPrivateHistory(bob.publicKey)
  assert.deepEqual(sender.instance.model.messages, [])
  release.resolve(); await staleRefresh
  assert.deepEqual(sender.instance.model.messages, [])
  assert.equal(JSON.stringify(sender.instance.records).includes('Must stay destroyed'), false)
})

test('deleting local history hides the row but reopening retains the shared private timer', async t => {
  const sender = await engine(alice, t)
  const preferences = defaults()
  t.mock.method(store, 'getMessagingPreferences', async () => structuredClone(preferences))
  t.mock.method(store, 'deleteStoredConversation', async (owner, cid) => {
    const removed = [...rows(owner).values()].filter(record => messaging.conversationForEvent(record.event, owner) === cid && !['private-settings', 'private-destroy'].includes(record.event.kind))
    for (const record of removed) rows(owner).delete(record.key)
    preferences.deleted[cid] = { deletedAt: Date.now(), eventKeys: removed.map(record => record.key) }
  })
  await sender.instance.setPrivateMode(bob.publicKey, 300)
  await sender.instance.sendText(bob.publicKey, 'Earlier temporary text')
  await sender.instance.deleteConversation(bob.publicKey)
  assert.equal(sender.instance.model.conversations.some(conversation => conversation.id === bob.publicKey), false)
  assert.equal(sender.instance.getPrivateMode(bob.publicKey), 300)
  const id = await sender.instance.sendText(bob.publicKey, 'Reopened private conversation')
  assert.equal(sender.instance.model.messages.find(message => message.id === id).private, true)
  assert.equal(sender.instance.model.conversations.find(conversation => conversation.id === bob.publicKey).privateTtlSeconds, 300)
})
