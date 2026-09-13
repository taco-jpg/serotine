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
let rejectRecipient, failNextUpgrade = false
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
  saveCommunityUpgrade: async (owner, records) => {
    if (failNextUpgrade) { failNextUpgrade = false; throw new Error('Atomic upgrade storage unavailable') }
    const staged = new Map(recordsFor(owner))
    for (const record of records) {
      const prior = staged.get(record.key)
      if (prior && JSON.stringify(prior.event) !== JSON.stringify(record.event)) throw new Error('Conflicting message identifier')
      staged.set(record.key, structuredClone(record))
    }
    stores.set(owner, staged)
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
beforeEach(() => { stores.clear(); prefs.clear(); cursors.clear(); packets.length = attempts.length = 0; rejectRecipient = undefined; failNextUpgrade = false })
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

function latestStateRecord(participant, id) {
  return [...recordsFor(participant.instance.identity.publicKey).values()]
    .filter(record => record.event.conversationId === id && record.event.payload.community?.type === 'state')
    .sort((a, b) => b.event.payload.community.state.epoch - a.event.payload.community.state.epoch)[0]
}

test('co-owners manage settings, channels and moderator roles through the primary owner', async () => {
  const owner = await engine(alice), coOwner = await engine(bob), member = await engine(charlie)
  const { id, invite } = await create(owner)
  await join(owner, coOwner, invite)
  await join(owner, member, invite)
  await owner.service.setCoOwner(id, bob.publicKey, true)
  await sync(owner, coOwner, member)
  assert.deepEqual(community(coOwner, id).coOwners, [bob.publicKey])

  const channel = { id: crypto.randomUUID(), name: 'calculus', posting: 'members' }
  await coOwner.service.updateCommunity(id, { name: 'Math study hall', channels: [...community(coOwner, id).channels, channel] })
  assert.equal(community(coOwner, id).name, 'Study hall', 'co-owner changes wait for the primary owner to synchronize')
  await sync(coOwner, owner, coOwner, member)
  assert.equal(community(member, id).name, 'Math study hall')
  assert.ok(community(member, id).channels.some(value => value.id === channel.id))
  assert.equal(latestStateRecord(member, id).event.author, alice.publicKey)
  assert.equal(community(member, id).signer, alice.publicKey, 'co-owner commands do not create competing state signers')

  await coOwner.service.moderate(id, 'promote', charlie.publicKey)
  await sync(coOwner, owner, member, coOwner)
  assert.ok(community(member, id).moderators.includes(charlie.publicKey))
  await coOwner.service.moderate(id, 'ban', charlie.publicKey)
  await sync(coOwner, owner, member, coOwner)
  assert.equal(community(member, id).joined, false)
  assert.ok(community(coOwner, id).bans.includes(charlie.publicKey))
  await assert.rejects(coOwner.service.deleteCommunity(id), /primary|owner/i)
  await assert.rejects(coOwner.service.transferOwnership(id, alice.publicKey), /primary|owner/i)
  await assert.rejects(coOwner.service.setCoOwner(id, alice.publicKey, true), /primary|owner/i)
})

test('ownership transfer preserves channels and history and lets the successor invite new members', async () => {
  const owner = await engine(alice), successor = await engine(bob), newcomer = await engine(charlie)
  const { id, invite, channel } = await create(owner)
  await join(owner, successor, invite)
  const sent = await owner.service.sendMessage(id, channel, 'History survives an ownership transfer')
  await sync(owner, successor)
  const channelIds = community(owner, id).channels.map(value => value.id)
  await owner.service.updateCommunity(id, { admission: 'approval' })
  await sync(owner, successor)
  await newcomer.service.joinCommunity(await owner.service.createInvite(id))
  await sync(newcomer, owner, newcomer)
  const pendingRequest = newcomer.service.model.requests.find(request => request.communityId === id)
  assert.equal(pendingRequest.status, 'pending')
  await owner.service.transferOwnership(id, bob.publicKey)
  await sync(owner, successor, newcomer)
  assert.equal(newcomer.service.model.requests.find(request => request.id === pendingRequest.id)?.status, 'rejected',
    'the outgoing owner must deliver its queued rejection after the local handoff')
  assert.match(newcomer.service.model.requests.find(request => request.id === pendingRequest.id)?.reason, /ownership changed/i)

  for (const participant of [owner, successor]) {
    assert.equal(community(participant, id).owner, bob.publicKey)
    assert.equal(community(participant, id).joined, true)
    assert.deepEqual(community(participant, id).channels.map(value => value.id), channelIds)
    assert.equal(message(participant, sent)?.content, 'History survives an ownership transfer')
  }
  await assert.rejects(owner.service.updateCommunity(id, { name: 'Former owner cannot change this' }), /owner/i)
  await assert.rejects(owner.service.deleteCommunity(id), /owner/i)
  await successor.service.updateCommunity(id, { name: 'Successor study hall', admission: 'direct' })
  await sync(successor, owner)
  assert.equal(community(owner, id).name, 'Successor study hall')
  assert.equal(latestStateRecord(owner, id).event.author, bob.publicKey)

  const newInvite = await successor.service.createInvite(id)
  assert.equal((await protocol.parseCommunityInvite(newInvite)).owner, bob.publicKey)
  await join(successor, newcomer, newInvite)
  await sync(owner)
  assert.equal(community(newcomer, id).owner, bob.publicKey)
  assert.equal(message(newcomer, sent), undefined, 'ownership proof does not disclose pre-join channel history')
  const future = await newcomer.service.sendMessage(id, channel, 'Joined through the successor')
  await sync(newcomer, owner, successor)
  assert.equal(message(owner, future)?.content, 'Joined through the successor')
  assert.equal(message(successor, future)?.content, 'Joined through the successor')
})

test('deletion propagates, cancels queued messages, and survives replay and backup restore', async () => {
  const owner = await engine(alice), member = await engine(bob)
  const { id, invite, channel } = await create(owner)
  await join(owner, member, invite)
  const staleState = structuredClone(latestStateRecord(owner, id).event.payload.community.state)
  const staleMessage = await member.service.sendMessage(id, channel, 'This queued message must never be delivered')
  await owner.service.deleteCommunity(id)
  await sync(owner, member)
  for (const participant of [owner, member]) {
    assert.equal(community(participant, id).deleted, true)
    assert.equal(community(participant, id).joined, false)
    await assert.rejects(participant.service.sendMessage(id, channel, 'Cannot post after deletion'), /deleted|member/i)
  }
  assert.equal(attempts.some(attempt => attempt.id === staleMessage), false, 'deletion must apply before the old outbox drains')
  await assert.rejects(owner.service.createInvite(id), /deleted|member/i)

  // An old owner device can still sign a later epoch. Its snapshot cannot undo
  // a terminal deletion, even when backup record ordering changes.
  const deleted = community(member, id)
  const replayState = await protocol.signCommunityState({ ...staleState, name: 'Must not resurrect',
    epoch: deleted.epoch + 1, updatedAt: deleted.updatedAt + 1 }, alice)
  const event = await messaging.signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: alice.publicKey,
    conversationId: id, recipients: [bob.publicKey], timestamp: Date.now(), kind: 'community', payload: { community: { type: 'state', state: replayState } } }, alice)
  await store.saveStoredEvent(bob.publicKey, { key: store.eventStorageKey(event), event,
    local: false, receivedAt: Date.now(), delivered: [] })
  await member.instance.refresh()
  assert.equal(community(member, id).deleted, true)
  assert.notEqual(community(member, id).name, 'Must not resurrect')

  const actualStore = load(path.join(root, 'lib/messaging-store.ts'))
  const snapshot = { version: 3, owner: bob.publicKey, preferences: defaults(), events: [...recordsFor(bob.publicKey).values()].reverse() }
  const validated = await actualStore.validateMessagingSnapshot(structuredClone(snapshot), bob.publicKey)
  const restored = protocol.buildCommunityModel(validated.events, bob.publicKey, validated.preferences)
  assert.equal(restored.communities.find(value => value.id === id)?.deleted, true)
  assert.equal(restored.communities.find(value => value.id === id)?.joined, false)
})

test('a failed atomic legacy upgrade preserves the current membership and can be retried', async () => {
  const owner = await engine(alice), member = await engine(bob)
  const id = `community:${alice.publicKey}:${crypto.randomUUID()}`
  const state = await protocol.signCommunityState({ id, owner: alice.publicKey, name: 'Legacy community', description: '',
    epoch: 1, updatedAt: Date.now(), members: [alice.publicKey, bob.publicKey], moderators: [], bans: [],
    admission: 'direct', joiningPaused: false, inviteGeneration: 1,
    channels: [{ id: crypto.randomUUID(), name: 'general', posting: 'members' }] }, alice)
  const event = await messaging.signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: alice.publicKey,
    conversationId: id, recipients: [bob.publicKey], timestamp: Date.now(), kind: 'community', payload: { community: { type: 'state', state } } }, alice)
  await owner.instance.queue(event)
  await sync(owner, member)
  const before = structuredClone([...recordsFor(alice.publicKey).values()])
  failNextUpgrade = true
  await assert.rejects(owner.service.setCoOwner(id, bob.publicKey, true), /atomic upgrade storage unavailable/i)
  assert.deepEqual([...recordsFor(alice.publicKey).values()], before)
  await owner.instance.refresh()
  assert.equal(community(owner, id).version, undefined)
  assert.deepEqual(community(owner, id).members, [alice.publicKey, bob.publicKey])
  assert.equal(community(member, id).joined, true)

  await owner.service.setCoOwner(id, bob.publicKey, true)
  await sync(owner, member)
  assert.equal(community(member, id).version, 2)
  assert.deepEqual(community(member, id).coOwners, [bob.publicKey])
  assert.equal(community(member, id).joined, true)
})

test('a revoked co-owner cannot apply a command that was sent before revocation', async () => {
  const owner = await engine(alice), coOwner = await engine(bob)
  const { id, invite } = await create(owner)
  await join(owner, coOwner, invite)
  await owner.service.setCoOwner(id, bob.publicKey, true)
  await sync(owner, coOwner)
  await coOwner.service.updateCommunity(id, { name: 'A stale privileged command' })
  await sync(coOwner)
  await owner.service.setCoOwner(id, bob.publicKey, false)
  await sync(owner, coOwner)
  assert.equal(community(owner, id).name, 'Study hall')
  assert.equal(community(coOwner, id).name, 'Study hall')
  assert.deepEqual(community(coOwner, id).coOwners, [])
  await assert.rejects(coOwner.service.updateCommunity(id, { name: 'No permission remains' }), /owner/i)
})
