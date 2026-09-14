/* Real signatures, pairwise encryption and MessagingEngine sync; only storage and transport are replaced. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test, before, beforeEach, afterEach } = require('node:test')
const ts = require('typescript')
const remoteAttachment = require('./fixtures/remote-attachment.cjs')
const root = path.join(__dirname, '..')
const modules = new Map(), stores = new Map(), prefs = new Map(), cursors = new Map()
const packets = [], attempts = [], engines = [], notifications = []
const runtimeWindow = new EventTarget()
runtimeWindow.location = { origin: 'https://serotine.chat' }
let rejectRecipient, historyReads = 0
const defaults = () => ({ accepted: [], blocked: [], notifications: {}, readAt: {}, readReceipts: true, archived: [], deleted: {}, deletedMessages: {} })
const recordsFor = owner => { if (!stores.has(owner)) stores.set(owner, new Map()); return stores.get(owner) }
const store = {
  createStoredEventReader: owner => ({ read: () => store.getStoredEvents(owner), dispose() {} }),
  defaultMessagingPreferences: defaults,
  eventStorageKey: event => `${event.author}:${event.conversationId}:${event.id}`,
  getStoredEvents: async owner => { historyReads++; return structuredClone([...recordsFor(owner).values()]) },
  deleteStoredCommunityMessage: async (owner, cid, channelId, messageId) => {
    const values = recordsFor(owner)
    const record = [...values.values()].find(item => item.event.conversationId === cid && item.event.id === messageId && item.event.payload.community?.channelId === channelId)
    if (!record) throw new Error('Message missing')
    const p = prefs.get(owner) || defaults()
    prefs.set(owner, { ...p, deletedMessages: { ...p.deletedMessages, [cid]: { messageIds: [messageId], eventKeys: [record.key], attachmentIds: [], legacyMessageKeys: [] } } })
    values.delete(record.key)
  },
  saveStoredEvent: async (owner, record) => {
    const prior = recordsFor(owner).get(record.key)
    if (prior && JSON.stringify(prior.event) !== JSON.stringify(record.event)) throw new Error('Conflicting message identifier')
    recordsFor(owner).set(record.key, structuredClone(prior ? {
      ...prior, ...record, local: prior.local || record.local,
      receivedAt: Math.min(prior.receivedAt, record.receivedAt),
      delivered: [...new Set([...prior.delivered, ...record.delivered])],
    } : record))
    return true
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
    if (!packets.some(packet => packet.senderPubKey === proof.publicKey && packet.recipientPubKey === data.recipientPubKey && packet.id === data.id)) {
      packets.push({ ...data, senderPubKey: proof.publicKey, sequence: packets.length + 1, createdAt: Date.now() })
    }
    return { success: true }
  },
  getEventFeed: async (data, proof) => {
    assert.equal(await authentication.verifyRequestProof('event:sync', data, proof), true)
    const messages = packets.filter(packet => packet.sequence > (data.after || 0) && (packet.senderPubKey === proof.publicKey || packet.recipientPubKey === proof.publicKey))
    return { success: true, messages, nextCursor: messages.at(-1)?.sequence || data.after || 0, hasMore: false }
  },
  getLegacyInbox: async () => ({ success: true, messages: [], nextCursor: null }),
  deleteMessage: async () => ({ success: true }),
}
function load(filename) {
  if (!path.extname(filename)) filename += '.ts'
  if (modules.has(filename)) return modules.get(filename).exports
  const module = { exports: {} }; modules.set(filename, module)
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  function sourceRequire(specifier) {
    if (specifier === './messaging-store') return store
    if (specifier === './relay-client') return relay
    if (specifier === './storage') return { exportAllMessagesFromStorage: async () => [], migrateLegacyHistory: async () => {}, deleteConversationHistoryFromStorage: async () => {} }
    if (specifier === './message-notifications') return { notifyIncoming(...args) { notifications.push(args) }, requestMessagingNotifications: async () => 'denied' }
    if (specifier.startsWith('.')) return load(path.resolve(path.dirname(filename), specifier))
    return require(specifier)
  }
  new Function('require', 'module', 'exports', 'navigator', 'window', 'localStorage', output)(sourceRequire, module, module.exports, {}, runtimeWindow, { getItem: () => null })
  return module.exports
}
const cryptography = load(path.join(root, 'lib/crypto.ts'))
const authentication = load(path.join(root, 'lib/request-auth.ts'))
const messaging = load(path.join(root, 'lib/messaging.ts'))
const protocol = load(path.join(root, 'lib/community-protocol.ts'))
let alice, bob, charlie
before(async () => {
  async function identity() {
    const keys = await cryptography.generateEncryptionKeyPair()
    return { version: 2, publicKey: await cryptography.exportPublicKeyToHex(keys.publicKey), privateKey: await cryptography.exportKey(keys.privateKey) }
  }
  ;[alice, bob, charlie] = await Promise.all([identity(), identity(), identity()])
})
beforeEach(() => { stores.clear(); prefs.clear(); cursors.clear(); packets.length = attempts.length = notifications.length = 0; rejectRecipient = undefined; historyReads = 0 })
afterEach(() => { for (const engine of engines.splice(0)) engine.dispose() })
async function engine(identity) {
  const instance = new messaging.MessagingEngine(identity)
  engines.push(instance)
  instance.key = await cryptography.importKey(identity.privateKey, 'encryption', 'private')
  const synchronize = instance.sync
  instance.sync = async () => {}
  await instance.refresh()
  return { instance, synchronize, service: instance.communities }
}
async function sync(...participants) {
  for (const participant of participants) {
    await participant.synchronize()
    assert.equal(participant.instance.error, null)
  }
}
function community(participant, id) { return participant.service.model.communities.find(value => value.id === id) }
function message(participant, id) { return participant.service.model.messages.find(value => value.id === id) }
function outgoing(owner, id) { return [...recordsFor(owner).values()].find(record => record.event.id === id) }

async function create(owner, admission = 'direct') {
  const id = await owner.service.createCommunity({ name: 'Study hall', description: 'A place for homework questions', admission })
  const invite = await owner.service.createInvite(id)
  return { id, invite, channel: community(owner, id).channels.find(channel => channel.name === 'general').id }
}
async function join(owner, guest, invite) {
  const id = await guest.service.joinCommunity(invite)
  await sync(guest, owner, guest)
  assert.equal(community(guest, id)?.joined, true)
  return id
}

test('an invite joins only after owner acknowledgment and delivers encrypted new channel history', async () => {
  const owner = await engine(alice), guest = await engine(bob)
  const { id, invite, channel } = await create(owner)
  const beforeJoin = await owner.service.sendMessage(id, channel, 'History from before the invitation')
  await sync(owner)
  assert.equal(await guest.service.joinCommunity(invite), id)
  assert.equal(community(guest, id)?.joined ?? false, false)
  assert.equal(guest.service.model.requests.find(request => request.communityId === id)?.status, 'pending')
  await assert.rejects(guest.service.sendMessage(id, channel, 'Cannot grant myself access'), /synchroniz|member/i)
  await sync(guest)
  assert.equal(community(guest, id)?.joined ?? false, false, 'the inviter must acknowledge the join')
  await sync(owner, guest)
  assert.equal(community(guest, id).joined, true)
  assert.equal(guest.service.model.requests.find(request => request.communityId === id)?.status, 'approved')
  assert.equal(message(guest, beforeJoin), undefined, 'an invite does not backfill pre-join channel history')

  const sent = await guest.service.sendMessage(id, channel, 'A new encrypted channel message')
  await sync(guest, owner)
  assert.equal(message(owner, sent)?.content, 'A new encrypted channel message')
  assert.equal(message(owner, sent)?.channelId, channel)
  assert.equal(message(guest, sent)?.delivery, 'sent')
  assert.equal(owner.instance.model.messages.some(message => message.id === sent), false, 'community traffic stays out of direct-message history')
  const transmitted = packets.filter(packet => packet.id === sent)
  assert.equal(transmitted.length, 1)
  assert.equal(transmitted[0].recipientPubKey, alice.publicKey)
  assert.equal(transmitted[0].encryptedData.includes('A new encrypted channel message'), false)

  const announcement = community(guest, id).channels.find(channel => channel.name === 'announcements').id
  await assert.rejects(guest.service.sendMessage(id, announcement, 'A member cannot announce'), /moderator/i)
  const announced = await owner.service.sendMessage(id, announcement, 'An owner announcement')
  await sync(owner, guest)
  assert.equal(message(guest, announced)?.content, 'An owner announcement')
})

test('approval requests remain pending across syncs until the owner approves or rejects them', async () => {
  const owner = await engine(alice), guest = await engine(bob), declined = await engine(charlie)
  const { id, invite } = await create(owner, 'approval')
  await guest.service.joinCommunity(invite)
  await declined.service.joinCommunity(invite)
  await sync(guest, declined, owner, guest, declined)
  assert.equal(community(guest, id)?.joined ?? false, false)
  const acceptedRequest = owner.service.model.requests.find(request => request.author === bob.publicKey)
  const declinedRequest = owner.service.model.requests.find(request => request.author === charlie.publicKey)
  assert.equal(acceptedRequest.status, 'pending')
  assert.equal(declinedRequest.status, 'pending')
  await owner.service.approveRequest(id, acceptedRequest.id)
  await owner.service.rejectRequest(id, declinedRequest.id)
  await sync(owner, guest, declined)
  assert.equal(community(guest, id).joined, true)
  assert.equal(community(declined, id)?.joined ?? false, false)
  assert.equal(declined.service.model.requests.find(request => request.id === declinedRequest.id).status, 'rejected')
  const epoch = community(owner, id).epoch
  await sync(owner, guest, owner)
  assert.equal(community(owner, id).epoch, epoch, 'replaying a retained request does not re-admit the same member')
})

test('membership updates cancel stale queued fanout before encryption and removed members receive no future messages', async () => {
  const owner = await engine(alice), sender = await engine(bob), removed = await engine(charlie)
  const { id, invite, channel } = await create(owner)
  await join(owner, sender, invite)
  await join(owner, removed, invite)
  await sync(sender)
  const stale = await sender.service.sendMessage(id, channel, 'Queued before the member was removed')
  assert.ok(outgoing(bob.publicKey, stale).event.recipients.includes(charlie.publicKey))
  await owner.service.moderate(id, 'remove', charlie.publicKey)
  await sync(owner)
  await sync(sender, removed)
  assert.equal(community(removed, id).joined, false)
  assert.equal(attempts.filter(attempt => attempt.id === stale).length, 0, 'the incoming removal must be applied before draining the old outbox')
  assert.equal(outgoing(bob.publicKey, stale).delivered.includes(charlie.publicKey), false)
  await assert.rejects(removed.service.sendMessage(id, channel, 'Still trying to post'), /no longer a member/i)
  const future = await sender.service.sendMessage(id, channel, 'For the remaining members')
  await sync(sender, owner, removed)
  assert.deepEqual(packets.filter(packet => packet.id === future).map(packet => packet.recipientPubKey), [alice.publicKey])
  assert.equal(message(owner, future)?.content, 'For the remaining members')
  assert.equal(message(removed, future), undefined)
})

test('a partially delivered community message retains receipts and retries only its missing recipient', async () => {
  const owner = await engine(alice), first = await engine(bob), second = await engine(charlie)
  const { id, invite, channel } = await create(owner)
  await join(owner, first, invite)
  await join(owner, second, invite)
  const sent = await owner.service.sendMessage(id, channel, 'A community message with one interrupted delivery')
  rejectRecipient = charlie.publicKey
  await sync(owner)
  assert.deepEqual(outgoing(alice.publicKey, sent).delivered, [bob.publicKey])
  assert.equal(message(owner, sent)?.delivery, 'failed')
  rejectRecipient = undefined
  await owner.instance.retry(sent)
  await sync(owner, first, second)
  assert.equal(attempts.filter(attempt => attempt.id === sent && attempt.recipientPubKey === bob.publicKey).length, 1)
  assert.equal(message(second, sent)?.content, 'A community message with one interrupted delivery')
  assert.equal(message(owner, sent)?.delivery, 'sent')
})

test('an applicant can recover when the owner saved admission but the encrypted acknowledgement failed', async () => {
  const owner = await engine(alice), guest = await engine(bob)
  const { id, invite, channel } = await create(owner)
  const beforeJoin = await owner.service.sendMessage(id, channel, 'Private history before admission')
  await sync(owner)
  await guest.service.joinCommunity(invite)
  await sync(guest)
  rejectRecipient = bob.publicKey
  await sync(owner)
  assert.equal(community(owner, id).members.includes(bob.publicKey), true)
  await sync(guest)
  assert.equal(community(guest, id)?.joined ?? false, false)
  const request = guest.service.model.requests.find(request => request.communityId === id)
  assert.equal(request.status, 'pending')
  const epoch = community(owner, id).epoch
  const failedApproval = [...recordsFor(alice.publicKey).values()].find(record => record.event.payload.community.type === 'state' && record.event.payload.community.requestId === request.id)
  assert.ok(failedApproval.error)

  rejectRecipient = undefined
  await guest.service.retryJoinRequest(id, request.id)
  await sync(guest, owner, guest)
  assert.equal(community(guest, id).joined, true)
  assert.equal(community(guest, id).epoch, epoch)
  assert.equal(message(guest, beforeJoin), undefined)
  const retry = guest.service.model.requests.find(request => request.id !== failedApproval.event.payload.community.requestId)
  assert.equal(retry.status, 'approved')
})

test('community history and channel preferences survive backup validation while tampered owner state fails', async () => {
  const owner = await engine(alice), guest = await engine(bob)
  const { id, invite, channel } = await create(owner)
  await join(owner, guest, invite)
  const sent = await guest.service.sendMessage(id, channel, 'Preserve this channel history')
  await sync(guest, owner)
  await owner.instance.markCommunityRead(id, channel)
  await owner.instance.setNotificationMode(id, 'muted')
  const channelKey = protocol.communityChannelKey(id, channel)
  await owner.instance.setNotificationMode(channelKey, 'mentions')
  const snapshot = {
    version: 3, owner: alice.publicKey,
    preferences: structuredClone(prefs.get(alice.publicKey)),
    events: structuredClone([...recordsFor(alice.publicKey).values()]),
  }
  const actualStore = load(path.join(root, 'lib/messaging-store.ts'))
  const validated = await actualStore.validateMessagingSnapshot(structuredClone(snapshot), alice.publicKey)
  assert.equal(validated.preferences.notifications[id], 'muted')
  assert.equal(validated.preferences.notifications[channelKey], 'mentions')
  assert.equal(validated.preferences.readAt[channelKey], message(owner, sent).timestamp)
  const restored = protocol.buildCommunityModel(validated.events, alice.publicKey, validated.preferences)
  assert.equal(restored.messages.find(message => message.id === sent)?.content, 'Preserve this channel history')
  assert.equal(restored.communities.find(community => community.id === id)?.unreadCount, 0)
  const altered = structuredClone(snapshot)
  altered.events.find(record => record.event.payload.community.type === 'state').event.payload.community.state.name = 'Tampered owner metadata'
  await assert.rejects(actualStore.validateMessagingSnapshot(altered, alice.publicKey), /signature|envelope/i)
})

test('a full 20-member community delivers each new text once to all 19 encrypted recipients', async () => {
  const owner = await engine(alice)
  const { id, invite, channel } = await create(owner)
  const identities = [bob, charlie]
  for (let index = 0; index < 17; index++) {
    const keys = await cryptography.generateEncryptionKeyPair()
    identities.push({ version: 2, publicKey: await cryptography.exportPublicKeyToHex(keys.publicKey), privateKey: await cryptography.exportKey(keys.privateKey) })
  }
  const guests = []
  for (const identity of identities) {
    const guest = await engine(identity)
    guests.push(guest)
    await guest.service.joinCommunity(invite)
    await sync(guest)
  }
  await sync(owner, ...guests)
  assert.equal(community(owner, id).members.length, 20)
  for (const guest of guests) assert.equal(community(guest, id).joined, true)
  const sent = await owner.service.sendMessage(id, channel, 'One message for twenty participants')
  await sync(owner, ...guests, owner)
  const delivered = packets.filter(packet => packet.id === sent)
  assert.equal(delivered.length, 19)
  assert.equal(new Set(delivered.map(packet => packet.recipientPubKey)).size, 19)
  assert.equal(message(owner, sent)?.delivery, 'delivered')
  assert.equal(message(owner, sent)?.deliveredTo.length, 19)
  for (const guest of guests) {
    assert.equal(guest.service.model.messages.filter(message => message.id === sent).length, 1)
    assert.equal(message(guest, sent)?.content, 'One message for twenty participants')
  }
})

test('a channel message remains readable when concurrent relay sends deliver its owner state afterward', async t => {
  const owner = await engine(alice), guest = await engine(bob)
  const { id, invite, channel } = await create(owner)
  await join(owner, guest, invite)
  await owner.service.updateCommunity(id, { name: 'Renamed study hall' })
  const stateId = [...recordsFor(alice.publicKey).values()].find(record => record.event.payload.community.type === 'state' && record.event.payload.community.state.epoch === community(owner, id).epoch).event.id
  const sent = await owner.service.sendMessage(id, channel, 'A message immediately after the settings update')
  let releaseState
  const messageSent = new Promise(resolve => { releaseState = resolve })
  const send = relay.storeEncryptedEvent
  t.mock.method(relay, 'storeEncryptedEvent', async (data, proof) => {
    if (data.id === stateId) await messageSent
    const result = await send(data, proof)
    if (data.id === sent) releaseState()
    return result
  })
  await sync(owner, guest)
  assert.equal(message(owner, sent)?.delivery, 'sent')
  assert.equal(message(guest, sent)?.content, 'A message immediately after the settings update')
})

test('blocking a member does not suppress their signed leave or continue sending future community content to them', async () => {
  const owner = await engine(alice), guest = await engine(bob)
  const { id, invite, channel } = await create(owner)
  await join(owner, guest, invite)
  await owner.instance.blockContact(bob.publicKey)
  await guest.service.leave(id)
  await sync(guest, owner)
  assert.equal(community(owner, id).members.includes(bob.publicKey), false)
  const sent = await owner.service.sendMessage(id, channel, 'Only remaining community members should receive this')
  await sync(owner, guest)
  assert.equal(packets.some(packet => packet.id === sent && packet.recipientPubKey === bob.publicKey), false)
})

test('blocking the owner does not disable their authorized moderation of another member message', async () => {
  const owner = await engine(alice), viewer = await engine(bob), poster = await engine(charlie)
  const { id, invite, channel } = await create(owner)
  await join(owner, viewer, invite)
  await join(owner, poster, invite)
  await sync(viewer)
  await viewer.instance.blockContact(alice.publicKey)
  const sent = await poster.service.sendMessage(id, channel, 'A message the owner will moderate')
  await sync(poster, owner, viewer)
  assert.equal(message(viewer, sent)?.hidden, false)
  await owner.service.hideMessage(id, sent)
  await sync(owner, viewer)
  assert.equal(message(viewer, sent)?.hidden, true)
})

test('community text, polls and complete files receive delivery and optional read receipts', async () => {
  const owner = await engine(alice), guest = await engine(bob)
  const { id, invite, channel } = await create(owner)
  await join(owner, guest, invite)
  const text = await owner.service.sendMessage(id, channel, 'Receipts work here too')
  const poll = await owner.service.createPoll(id, channel, 'Which day?', ['Monday', 'Tuesday'])
  const attachmentId = crypto.randomUUID()
  await owner.service.sendEvent(id, channel, 'attachment-chunk', { attachmentId, index: 0, data: 'SGk=' })
  const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from('Hi'))).toString('hex')
  const file = await owner.service.sendEvent(id, channel, 'attachment', { attachment: { id: attachmentId, name: 'note.txt', mime: 'text/plain', size: 2, chunks: 1, sha256, kind: 'file' } })
  await sync(owner, guest, owner)
  for (const messageId of [text, poll, file]) {
    assert.deepEqual(message(owner, messageId).deliveredTo, [bob.publicKey])
    assert.equal(message(owner, messageId).delivery, 'delivered')
  }
  assert.deepEqual(guest.service.getAttachmentChunks(id, channel, file), [{ index: 0, data: 'SGk=' }])
  await guest.instance.markCommunityRead(id, channel)
  await sync(guest, owner)
  for (const messageId of [text, poll, file]) assert.deepEqual(message(owner, messageId).readBy, [bob.publicKey])
  assert.ok(notifications.some(([row]) => row.id === poll), 'polls enter the notification pipeline')
  assert.ok(notifications.some(([row]) => row.id === file), 'files enter the notification pipeline')

  await guest.instance.setReadReceipts(false)
  const silent = await owner.service.sendMessage(id, channel, 'Read locally without a read receipt')
  await sync(owner, guest)
  await guest.instance.markCommunityRead(id, channel)
  await sync(guest, owner)
  assert.equal(community(guest, id).channelUnread[channel], 0)
  assert.deepEqual(message(owner, silent).readBy, [])
})

test('a 1 GB remote community file delivers and acknowledges its encrypted descriptor without channel chunk events', async () => {
  const owner = await engine(alice), guest = await engine(bob)
  const { id, invite, channel } = await create(owner)
  await join(owner, guest, invite)
  const attachment = remoteAttachment()
  const file = await owner.service.sendEvent(id, channel, 'attachment', { attachment, content: 'Large community file' })
  await sync(owner)
  assert.equal(message(owner, file).delivery, 'sent')
  await sync(guest, owner)
  assert.deepEqual(message(guest, file).attachment, attachment)
  assert.equal(message(guest, file).content, 'Large community file')
  assert.deepEqual(message(owner, file).deliveredTo, [bob.publicKey])
  assert.deepEqual(guest.service.getAttachmentChunks(id, channel, file), [])
  await guest.instance.markCommunityRead(id, channel)
  await sync(guest, owner)
  assert.deepEqual(message(owner, file).readBy, [bob.publicKey])
  const readCount = () => guest.instance.records.filter(record => record.event.payload.community?.type === 'receipt'
    && record.event.payload.community.targetId === file && record.event.payload.community.receipt === 'read').length
  await guest.instance.markCommunityRead(id, channel)
  assert.equal(readCount(), 1)
  assert.equal(owner.instance.records.some(record => record.event.payload.community?.type === 'attachment-chunk'), false)
})

test('hidden tabs and moderated messages do not advance community read state', async t => {
  const owner = await engine(alice), guest = await engine(bob)
  const { id, invite, channel } = await create(owner)
  await join(owner, guest, invite)
  const text = await owner.service.sendMessage(id, channel, 'Visible only after focus')
  await sync(owner, guest)
  const originalDocument = globalThis.document
  globalThis.document = { visibilityState: 'hidden', hasFocus: () => false }
  t.after(() => { if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument })
  await guest.instance.markCommunityRead(id, channel)
  assert.equal(guest.instance.preferences.readAt[protocol.communityChannelKey(id, channel)], undefined)
  await owner.service.hideMessage(id, text)
  await sync(owner, guest)
  globalThis.document = { visibilityState: 'visible', hasFocus: () => true }
  await guest.instance.markCommunityRead(id, channel)
  assert.equal(guest.instance.preferences.readAt[protocol.communityChannelKey(id, channel)], undefined)
  const readReceipts = guest.instance.records.filter(row => row.event.payload.community?.type === 'receipt' && row.event.payload.community.receipt === 'read')
  assert.equal(readReceipts.length, 0)
})

test('archive and local message deletion preserve community membership and other channels', async () => {
  const owner = await engine(alice), guest = await engine(bob)
  const { id, invite, channel } = await create(owner)
  await join(owner, guest, invite)
  const text = await owner.service.sendMessage(id, channel, 'Remove this from my view')
  const otherChannel = community(owner, id).channels.find(item => item.name === 'help').id
  const retained = await owner.service.sendMessage(id, otherChannel, 'Keep the other channel')
  await sync(owner, guest)
  await assert.rejects(guest.instance.deleteCommunityMessage(id, otherChannel, text), /no longer available/)
  await guest.instance.deleteCommunityMessage(id, channel, text)
  assert.equal(message(guest, text), undefined)
  assert.equal(message(guest, retained).content, 'Keep the other channel')
  assert.equal(message(owner, text).content, 'Remove this from my view')
  await guest.instance.archiveCommunity(id)
  assert.ok(guest.instance.preferences.archived.includes(id))
  assert.equal(community(guest, id).joined, true)
  const later = await owner.service.sendMessage(id, channel, 'A message while archived')
  await sync(owner, guest)
  assert.equal(notifications.find(([row]) => row.id === later)?.[1].archived, true)
  await guest.instance.archiveCommunity(id, false)
  assert.equal(guest.instance.preferences.archived.includes(id), false)
})

test('routine community sends use one signature and only one extra history read versus a direct send', async t => {
  const owner = await engine(alice), guest = await engine(bob)
  const { id, invite, channel } = await create(owner)
  await join(owner, guest, invite)
  let signatures = 0
  const sign = crypto.subtle.sign.bind(crypto.subtle)
  t.mock.method(crypto.subtle, 'sign', async (...args) => { signatures++; return sign(...args) })
  historyReads = 0
  const startedDirect = performance.now()
  const direct = await owner.instance.sendText(bob.publicKey, 'Comparable text')
  const directMs = performance.now() - startedDirect
  const directReads = historyReads, directSignatures = signatures
  historyReads = signatures = 0
  const startedCommunity = performance.now()
  const server = await owner.service.sendMessage(id, channel, 'Comparable text')
  const communityMs = performance.now() - startedCommunity
  assert.deepEqual(outgoing(alice.publicKey, direct).event.recipients, outgoing(alice.publicKey, server).event.recipients)
  assert.equal(directSignatures, 1)
  assert.equal(signatures, 1)
  assert.equal(directReads, 1)
  assert.equal(historyReads, 2, 'one post-signing membership check plus the durable message view refresh')
  t.diagnostic(`Local preparation with one recipient: direct ${directMs.toFixed(2)} ms / ${directReads} history read / ${directSignatures} signature; community ${communityMs.toFixed(2)} ms / ${historyReads} history reads / ${signatures} signature. Transport is excluded.`)
})

test('an unrelated ordinary message reaches the relay before a slow community membership feed', async t => {
  const owner = await engine(alice)
  await create(owner)
  await sync(owner)
  const id = await owner.instance.sendText(bob.publicKey, 'Ordinary sends remain responsive')
  const read = relay.getEventFeed
  let sawFeed = false
  t.mock.method(relay, 'getEventFeed', async (...args) => {
    sawFeed = true
    assert.equal(attempts.filter(attempt => attempt.id === id).length, 1,
      'the ordinary send must be published before waiting for community synchronization')
    return read(...args)
  })
  await sync(owner)
  assert.equal(sawFeed, true)
  assert.equal(attempts.filter(attempt => attempt.id === id).length, 1)
})

test('a send queued while sync finishes is flushed immediately without waiting for the polling interval', async t => {
  const owner = await engine(alice)
  const { id, channel } = await create(owner)
  await sync(owner)
  let enterLegacy, releaseLegacy, finishFollowup
  const entered = new Promise(resolve => { enterLegacy = resolve })
  const release = new Promise(resolve => { releaseLegacy = resolve })
  const followup = new Promise(resolve => { finishFollowup = resolve })
  let first = true
  const legacy = relay.getLegacyInbox
  t.mock.method(relay, 'getLegacyInbox', async (...args) => {
    if (first) { first = false; enterLegacy(); await release }
    return legacy(...args)
  })
  owner.instance.sync = async () => { await owner.synchronize(); finishFollowup() }
  const initial = owner.synchronize()
  await entered
  const sent = await owner.service.sendMessage(id, channel, 'Queued after this pass drained its outbox')
  assert.equal(attempts.some(item => item.id === sent), false)
  releaseLegacy()
  await initial
  await followup
  assert.equal(attempts.filter(item => item.id === sent).length, 1)
})

test('file pieces avoid history reads until metadata performs its membership check and view refresh', async () => {
  const owner = await engine(alice)
  const { id, channel } = await create(owner)
  const attachmentId = crypto.randomUUID()
  const bytes = Buffer.alloc(30 * 1024 + 2, 65)
  const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex')
  historyReads = 0
  await owner.service.sendEvent(id, channel, 'attachment-chunk', { attachmentId, index: 0, data: bytes.subarray(0, 30 * 1024).toString('base64') })
  await owner.service.sendEvent(id, channel, 'attachment-chunk', { attachmentId, index: 1, data: bytes.subarray(30 * 1024).toString('base64') })
  assert.equal(historyReads, 0)
  const file = await owner.service.sendEvent(id, channel, 'attachment', { attachment: { id: attachmentId, name: 'pieces.txt', mime: 'text/plain', size: bytes.length, chunks: 2, sha256, kind: 'file' } })
  assert.equal(historyReads, 2)
  assert.equal(owner.service.getAttachmentChunks(id, channel, file).length, 2)
})

test('membership changed during encryption cancels the stale community packet before relay publication', async t => {
  const owner = await engine(alice), sender = await engine(bob), removed = await engine(charlie)
  const { id, invite, channel } = await create(owner)
  await join(owner, sender, invite)
  await join(owner, removed, invite)
  await sync(sender)
  const stale = await sender.service.sendMessage(id, channel, 'Must not reach a removed member')
  await owner.service.moderate(id, 'remove', charlie.publicKey)
  const removal = [...recordsFor(alice.publicKey).values()].filter(row => row.event.conversationId === id && row.event.payload.community?.type === 'state').sort((a, b) => b.event.payload.community.state.epoch - a.event.payload.community.state.epoch)[0]
  const encrypt = cryptography.encryptForPeer
  let injected = false
  t.mock.method(cryptography, 'encryptForPeer', async (...args) => {
    const encrypted = await encrypt(...args)
    if (!injected && JSON.parse(args[0]).id === stale) {
      injected = true
      await store.saveStoredEvent(bob.publicKey, { ...structuredClone(removal), local: false, delivered: [] })
    }
    return encrypted
  })
  await sync(sender)
  assert.equal(injected, true)
  assert.equal(attempts.filter(item => item.id === stale).length, 0)
  assert.equal(community(sender, id).members.includes(charlie.publicKey), false)
  assert.equal(outgoing(bob.publicKey, stale).delivered.length, 0)
})

test('overlapping permission refreshes do not finish until the latest membership snapshot is applied', async t => {
  const owner = await engine(alice), guest = await engine(bob)
  const { id, invite } = await create(owner)
  await join(owner, guest, invite)
  const prior = structuredClone([...recordsFor(bob.publicKey).values()])
  await owner.service.moderate(id, 'remove', bob.publicKey)
  const removal = [...recordsFor(alice.publicKey).values()].filter(row => row.event.conversationId === id && row.event.payload.community?.type === 'state').sort((a, b) => b.event.payload.community.state.epoch - a.event.payload.community.state.epoch)[0]
  const current = [...prior, { ...structuredClone(removal), local: false, delivered: [] }]
  let releaseFirst, releaseSecond, reads = 0, firstFinished = false
  const firstReady = new Promise(resolve => { releaseFirst = resolve })
  const secondReady = new Promise(resolve => { releaseSecond = resolve })
  t.mock.method(store, 'getStoredEvents', async () => {
    if (++reads === 1) { await firstReady; return prior }
    await secondReady; return current
  })
  const first = guest.instance.refresh().then(() => { firstFinished = true })
  const second = guest.instance.refresh()
  releaseFirst()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(firstFinished, false, 'an obsolete read cannot release the permission-check caller early')
  releaseSecond()
  await Promise.all([first, second])
  assert.equal(community(guest, id).joined, false)
})

test('files receive one read receipt when late chunks arrive after local unread state was cleared', async () => {
  const owner = await engine(alice), guest = await engine(bob)
  const { id, invite, channel } = await create(owner)
  await join(owner, guest, invite)
  const attachmentId = crypto.randomUUID()
  const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from('Hi'))).toString('hex')
  const chunk = await owner.service.sendEvent(id, channel, 'attachment-chunk', { attachmentId, index: 0, data: 'SGk=' })
  const file = await owner.service.sendEvent(id, channel, 'attachment', { attachment: { id: attachmentId, name: 'late.txt', mime: 'text/plain', size: 2, chunks: 1, sha256, kind: 'file' } })
  await store.saveStoredEvent(bob.publicKey, { ...structuredClone(outgoing(alice.publicKey, file)), local: false, delivered: [] })
  await guest.instance.refresh()
  await guest.instance.markCommunityRead(id, channel)
  const receiptCount = () => guest.instance.records.filter(row => row.event.author === bob.publicKey && row.event.payload.community?.type === 'receipt' && row.event.payload.community.targetId === file && row.event.payload.community.receipt === 'read').length
  assert.equal(community(guest, id).channelUnread[channel], 0, 'metadata clears the local badge')
  assert.equal(receiptCount(), 0, 'missing bytes cannot receive a read acknowledgement')
  await store.saveStoredEvent(bob.publicKey, { ...structuredClone(outgoing(alice.publicKey, chunk)), local: false, delivered: [] })
  await guest.instance.refresh()
  await guest.instance.markCommunityRead(id, channel)
  assert.equal(receiptCount(), 1)
  historyReads = 0
  await guest.instance.markCommunityRead(id, channel)
  assert.equal(receiptCount(), 1, 'the accepted receipt makes later render checks no-ops')
  assert.equal(historyReads, 0)
})

test('retrying a community file leaves failed chunks with the same attachment ID in another channel untouched', async () => {
  const owner = await engine(alice)
  const { id, channel } = await create(owner)
  const otherChannel = community(owner, id).channels.find(item => item.name === 'help').id
  const attachmentId = crypto.randomUUID()
  const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', Buffer.from('Hi'))).toString('hex')
  const meta = { id: attachmentId, name: 'file.txt', mime: 'text/plain', size: 2, chunks: 1, sha256, kind: 'file' }
  const chunk = await owner.service.sendEvent(id, channel, 'attachment-chunk', { attachmentId, index: 0, data: 'SGk=' })
  const file = await owner.service.sendEvent(id, channel, 'attachment', { attachment: meta })
  const otherChunk = await owner.service.sendEvent(id, otherChannel, 'attachment-chunk', { attachmentId, index: 0, data: 'SGk=' })
  await owner.service.sendEvent(id, otherChannel, 'attachment', { attachment: meta })
  for (const messageId of [chunk, otherChunk]) await store.saveStoredEvent(alice.publicKey, { ...outgoing(alice.publicKey, messageId), error: 'Failed file piece', failedRecipients: [alice.publicKey] })
  await owner.instance.refresh()
  await owner.instance.retry(file)
  assert.equal(outgoing(alice.publicKey, chunk).error, undefined)
  assert.equal(outgoing(alice.publicKey, otherChunk).error, 'Failed file piece')
})
