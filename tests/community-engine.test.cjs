/* Real signatures, pairwise encryption and MessagingEngine sync; only storage and transport are replaced. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test, before, beforeEach, afterEach } = require('node:test')
const ts = require('typescript')
const root = path.join(__dirname, '..')
const modules = new Map(), stores = new Map(), prefs = new Map(), cursors = new Map()
const packets = [], attempts = [], engines = []
const runtimeWindow = new EventTarget()
runtimeWindow.location = { origin: 'https://serotine.chat' }
let rejectRecipient
const defaults = () => ({ accepted: [], blocked: [], notifications: {}, readAt: {}, readReceipts: true, archived: [], deleted: {}, deletedMessages: {} })
const recordsFor = owner => { if (!stores.has(owner)) stores.set(owner, new Map()); return stores.get(owner) }
const store = {
  defaultMessagingPreferences: defaults,
  eventStorageKey: event => `${event.author}:${event.conversationId}:${event.id}`,
  getStoredEvents: async owner => structuredClone([...recordsFor(owner).values()]),
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
const protocol = load(path.join(root, 'lib/community-protocol.ts'))
let alice, bob, charlie
before(async () => {
  async function identity() {
    const keys = await cryptography.generateEncryptionKeyPair()
    return { version: 2, publicKey: await cryptography.exportPublicKeyToHex(keys.publicKey), privateKey: await cryptography.exportKey(keys.privateKey) }
  }
  ;[alice, bob, charlie] = await Promise.all([identity(), identity(), identity()])
})
beforeEach(() => { stores.clear(); prefs.clear(); cursors.clear(); packets.length = attempts.length = 0; rejectRecipient = undefined })
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
  assert.equal(message(owner, sent)?.delivery, 'sent')
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
