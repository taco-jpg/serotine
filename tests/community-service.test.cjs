const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test, before } = require('node:test')
const ts = require('typescript')

const root = path.join(__dirname, '..'), modules = new Map(), locks = []
const runtimeNavigator = { locks: { request: async (key, callback) => { locks.push(key); return callback() } } }
function load(filename) {
  if (!path.extname(filename)) filename += '.ts'
  if (modules.has(filename)) return modules.get(filename).exports
  const module = { exports: {} }; modules.set(filename, module)
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const requireSource = specifier => specifier.startsWith('.') ? load(path.resolve(path.dirname(filename), specifier)) : require(specifier)
  new Function('require', 'module', 'exports', 'navigator', 'window', output)(requireSource, module, module.exports, runtimeNavigator, { location: { origin: 'https://example.test' } })
  return module.exports
}
const cryptoHelpers = load(path.join(root, 'lib/crypto.ts'))
const protocol = load(path.join(root, 'lib/community-protocol.ts'))
const { CommunityService } = load(path.join(root, 'lib/community-service.ts'))
let alice, bob, charlie, dave
before(async () => {
  const identity = async () => {
    const pair = await cryptoHelpers.generateEncryptionKeyPair()
    return { version: 2, publicKey: await cryptoHelpers.exportPublicKeyToHex(pair.publicKey), privateKey: await cryptoHelpers.exportKey(pair.privateKey) }
  }
  ;[alice, bob, charlie, dave] = await Promise.all([identity(), identity(), identity(), identity()])
})
function harness() {
  const storage = new Map(), sent = []
  let order = 0
  const rows = address => { if (!storage.has(address)) storage.set(address, []); return storage.get(address) }
  const inject = (event, skip = []) => {
    sent.push(event)
    for (const address of new Set([event.author, ...event.recipients])) if (!skip.includes(address)) rows(address).push({
      key: `${event.author}:${event.conversationId}:${event.id}`, event: structuredClone(event),
      local: event.author === address, delivered: [...event.recipients], receivedAt: ++order,
    })
  }
  function client(identity) {
    const host = { identity, records: () => rows(identity.publicKey),
      preferences: () => ({ accepted: [], blocked: [], notifications: {}, readAt: {}, readReceipts: true, archived: [], deleted: {}, deletedMessages: {} }),
      refresh: async () => {},
      // Envelope cryptography is covered by community-engine.test.cjs. Here the
      // production state and invitation signatures still use Web Crypto.
      sign: async event => ({ ...event, signature: '0'.repeat(128) }),
      queue: async event => { inject(event) },
    }
    return { host, service: new CommunityService(host) }
  }
  return { client, sent, inject }
}
async function established(h, admission = 'direct', identities = [bob, charlie]) {
  const owner = h.client(alice)
  const id = await owner.service.createCommunity({ name: 'Math club', description: 'Practice together', admission })
  const invite = await owner.service.createInvite(id)
  const clients = identities.map(identity => h.client(identity))
  for (const client of clients) await client.service.joinCommunity(invite)
  if (admission === 'direct') await owner.service.reconcile()
  return { owner, id, invite, clients }
}

test('two tabs serialize owner updates without losing either change', async () => {
  const h = harness(), { owner, id } = await established(h, 'direct', [])
  const otherTab = new CommunityService(owner.host)
  const before = locks.length
  await Promise.all([
    owner.service.updateCommunity(id, { name: 'Changed name' }),
    otherTab.updateCommunity(id, { description: 'Changed description' }),
  ])
  const community = owner.service.model.communities[0]
  assert.equal(community.name, 'Changed name')
  assert.equal(community.description, 'Changed description')
  assert.equal(community.epoch, 3)
  assert.equal(locks.length - before, 2)
  assert.equal(locks.at(-1), `serotine:community:${alice.publicKey}:${id}`)
})

test('owners create signed voice channels without changing legacy channel kinds and prevent text sends', async () => {
  const h = harness(), { owner, id, clients: [member] } = await established(h)
  const legacyChannels = structuredClone(owner.service.model.communities[0].channels)
  const voice = { id: crypto.randomUUID(), name: '  lounge  ', posting: 'members', kind: 'voice' }
  await owner.service.updateCommunity(id, { channels: [...legacyChannels, voice] })
  const current = owner.service.model.communities[0]
  assert.deepEqual(current.channels.slice(0, legacyChannels.length), legacyChannels)
  assert.deepEqual(current.channels.at(-1), { ...voice, name: 'lounge' })
  assert.equal(await protocol.validateCommunityState(protocol.communityStateSnapshot(current)), true)
  assert.equal(member.service.model.communities[0].channels.at(-1).kind, 'voice')
  assert.equal(protocol.canJoinCommunityVoiceChannel(current, bob.publicKey, voice.id), true)
  await assert.rejects(member.service.sendMessage(id, voice.id, 'This must stay unsent'), /text channel/)
  assert.equal(h.sent.some(event => event.payload.community.type === 'message'), false)
})

test('co-owner voice channel settings retain kind through command validation and owner reconciliation', async () => {
  const h = harness(), { owner, id, clients: [member] } = await established(h)
  await owner.service.setCoOwner(id, bob.publicKey, true)
  const prior = member.service.model.communities[0]
  const voice = { id: crypto.randomUUID(), name: 'staff-room', posting: 'moderators', kind: 'voice' }
  await member.service.updateCommunity(id, { channels: [...prior.channels, voice] })
  const command = h.sent.findLast(event => event.payload.community.type === 'command')
  assert.equal(command.payload.community.changes.channels.at(-1).kind, 'voice')
  assert.equal(await protocol.validateCommunityEvent(command), true)
  assert.equal(owner.service.model.communities[0].channels.some(channel => channel.id === voice.id), false)
  await owner.service.reconcile()
  const current = owner.service.model.communities[0]
  assert.deepEqual(current.channels.at(-1), voice)
  assert.equal(await protocol.validateCommunityState(protocol.communityStateSnapshot(current)), true)
  assert.equal(protocol.canJoinCommunityVoiceChannel(current, bob.publicKey, voice.id), true)
  assert.equal(protocol.canJoinCommunityVoiceChannel(current, charlie.publicKey, voice.id), false)
  const malformed = structuredClone(command)
  malformed.payload.community.changes.channels.at(-1).kind = 'video'
  assert.equal(await protocol.validateCommunityEvent(malformed), false)
})

test('membership changes arriving during signing cancel the prepared message', async () => {
  const h = harness(), { owner, id, clients: [member] } = await established(h)
  const channel = member.service.model.communities[0].channels[0].id
  const original = member.host.sign
  member.host.sign = async event => {
    if (event.payload.community.type === 'message') await owner.service.moderate(id, 'remove', bob.publicKey)
    return original(event)
  }
  const before = h.sent.filter(event => event.payload.community.type === 'message').length
  await assert.rejects(member.service.sendMessage(id, channel, 'This must stay unsent'), /community changed|no longer a member/i)
  assert.equal(h.sent.filter(event => event.payload.community.type === 'message').length, before)
  assert.equal(member.service.model.communities[0].joined, false)
})

test('a signed leave arriving during signing cancels the old recipients', async () => {
  const h = harness(), { id, clients: [sender, departing] } = await established(h)
  const channel = sender.service.model.communities[0].channels[0].id
  const original = sender.host.sign
  sender.host.sign = async event => {
    if (event.payload.community.type === 'message') await departing.service.leave(id)
    return original(event)
  }
  await assert.rejects(sender.service.sendMessage(id, channel, 'Do not send after departure'), /community changed/i)
  assert.equal(h.sent.some(event => event.payload.community.type === 'message'), false)
})

test('current owner settings reject revoked, paused, and banned join requests', async () => {
  for (const reason of ['revoked', 'paused', 'banned']) {
    const h = harness(), { owner, id, invite } = await established(h, 'direct', [])
    const applicant = h.client(bob)
    if (reason === 'revoked') await owner.service.revokeInvites(id)
    if (reason === 'paused') await owner.service.updateCommunity(id, { joiningPaused: true })
    if (reason === 'banned') {
      await applicant.service.joinCommunity(invite)
      await owner.service.reconcile()
      await owner.service.moderate(id, 'ban', bob.publicKey)
    }
    await applicant.service.joinCommunity(invite)
    await owner.service.reconcile()
    const request = applicant.service.model.requests.at(-1)
    assert.equal(request.status, 'rejected', reason)
    assert.equal(owner.service.model.communities[0].members.includes(bob.publicKey), false)
    const decision = h.sent.findLast(event => event.payload.community.type === 'decision')
    assert.deepEqual(decision.recipients, [bob.publicKey])
  }
})

test('owner checks moderator permission again before processing a queued ban', async () => {
  const h = harness(), { owner, id, clients: [moderator] } = await established(h)
  await owner.service.moderate(id, 'promote', bob.publicKey)
  await moderator.service.moderate(id, 'ban', charlie.publicKey)
  const command = h.sent.findLast(event => event.payload.community.type === 'command')
  assert.ok(command)
  await owner.service.moderate(id, 'demote', bob.publicKey)
  await owner.service.reconcile()
  const state = owner.service.model.communities[0]
  assert.ok(state.members.includes(charlie.publicKey))
  assert.equal(state.bans.includes(charlie.publicKey), false)
  assert.ok(owner.service.model.processedIds.includes(command.id))
  const count = h.sent.length
  await owner.service.reconcile()
  assert.equal(h.sent.length, count, 'the obsolete command is consumed only once')
})

test('independent moderator commands from one epoch are serialized by the owner', async () => {
  const h = harness(), { owner, id, clients: [moderator] } = await established(h, 'direct', [bob, charlie, dave])
  await owner.service.moderate(id, 'promote', bob.publicKey)
  await moderator.service.moderate(id, 'ban', charlie.publicKey)
  await moderator.service.moderate(id, 'remove', dave.publicKey)
  await owner.service.reconcile()
  const state = owner.service.model.communities[0]
  assert.deepEqual(state.members, [alice.publicKey, bob.publicKey])
  assert.deepEqual(state.bans, [charlie.publicKey])
  assert.equal(owner.service.model.commands.length, 0)
})

test('persistence failure leaves no optimistic community or invitation to a nonexistent community', async () => {
  const h = harness(), owner = h.client(alice)
  owner.host.queue = async () => { throw new Error('Disk full') }
  await assert.rejects(owner.service.createCommunity({ name: 'Unsaved', description: '', admission: 'direct' }), /Disk full/)
  assert.equal(owner.service.model.communities.length, 0)
  assert.equal(h.sent.length, 0)
})

test('revocation arriving while an invite is signed prevents returning the stale link', async t => {
  const h = harness(), { owner, id } = await established(h, 'direct', [])
  const original = protocol.signCommunityInvite
  t.mock.method(protocol, 'signCommunityInvite', async (...args) => {
    const invite = await original(...args)
    const state = h.sent.findLast(event => event.payload.community.type === 'state').payload.community.state
    const updated = await protocol.signCommunityState({ ...state, epoch: state.epoch + 1, inviteGeneration: state.inviteGeneration + 1 }, alice)
    h.inject({ version: 3, id: crypto.randomUUID(), author: alice.publicKey, conversationId: id, recipients: [alice.publicKey],
      timestamp: Date.now(), kind: 'community', payload: { community: { type: 'state', state: updated } }, signature: '0'.repeat(128) })
    return invite
  })
  await assert.rejects(owner.service.createInvite(id), /community changed/i)
})

test('retry recovers a lost acknowledgement without changing membership or bypassing approval', async () => {
  const h = harness(), { owner, id, invite } = await established(h, 'direct', [])
  const applicant = h.client(bob)
  owner.host.queue = async event => h.inject(event, [bob.publicKey])
  await applicant.service.joinCommunity(invite)
  await owner.service.reconcile()
  await owner.service.updateCommunity(id, { admission: 'approval', joiningPaused: true })
  await owner.service.revokeInvites(id)
  const prior = owner.service.model.communities[0]
  assert.equal(prior.joined, true)
  assert.ok(prior.members.includes(bob.publicKey))
  assert.equal(applicant.service.model.communities.length, 0)
  const request = applicant.service.model.requests[0]
  assert.equal(request.status, 'pending')

  owner.host.queue = async event => h.inject(event)
  assert.equal(await applicant.service.retryJoinRequest(id, request.id), id)
  const retry = applicant.service.model.requests.at(-1)
  assert.notEqual(retry.id, request.id)
  await owner.service.reconcile()
  const restored = applicant.service.model.communities[0]
  assert.equal(restored.joined, true)
  assert.equal(restored.epoch, prior.epoch)
  assert.equal(restored.signature, prior.signature)
  assert.equal(applicant.service.model.requests.find(item => item.id === retry.id).status, 'approved')
  const count = h.sent.length
  await owner.service.reconcile()
  assert.equal(h.sent.length, count, 'a processed retry does not publish more acknowledgements')
})

test('retrying an unapproved request cannot grant membership and approving it resolves duplicate requests', async () => {
  const h = harness(), { owner, id, clients: [applicant] } = await established(h, 'approval', [bob])
  const request = applicant.service.model.requests[0]
  await applicant.service.retryJoinRequest(id, request.id)
  await owner.service.reconcile()
  assert.deepEqual(owner.service.model.communities[0].members, [alice.publicKey])
  assert.equal(applicant.service.model.communities.length, 0)
  const retry = applicant.service.model.requests.at(-1)
  await owner.service.approveRequest(id, retry.id)
  await owner.service.reconcile()
  assert.equal(applicant.service.model.communities[0].joined, true)
  assert.equal(applicant.service.model.communities[0].epoch, 2)
  assert.ok(applicant.service.model.requests.every(item => item.status === 'approved'))
})

test('a lost acknowledgement cannot let a subsequently banned applicant recover membership', async () => {
  const h = harness(), { owner, id, invite } = await established(h, 'direct', [])
  const applicant = h.client(bob)
  owner.host.queue = async event => h.inject(event, [bob.publicKey])
  await applicant.service.joinCommunity(invite)
  await owner.service.reconcile()
  await owner.service.moderate(id, 'ban', bob.publicKey)
  owner.host.queue = async event => h.inject(event)
  await applicant.service.retryJoinRequest(id, applicant.service.model.requests[0].id)
  await owner.service.reconcile()
  assert.equal(applicant.service.model.requests.at(-1).status, 'rejected')
  assert.equal(applicant.service.model.communities.length, 0)
  assert.equal(owner.service.model.communities[0].members.includes(bob.publicKey), false)
  await assert.rejects(applicant.service.retryJoinRequest(id, applicant.service.model.requests.at(-1).id), /no longer pending/i)
})

test('rejecting a retried applicant resolves older pending requests too', async () => {
  const h = harness(), { owner, id, clients: [applicant] } = await established(h, 'approval', [bob])
  await applicant.service.retryJoinRequest(id, applicant.service.model.requests[0].id)
  await owner.service.rejectRequest(id, applicant.service.model.requests.at(-1).id)
  assert.ok(applicant.service.model.requests.every(item => item.status === 'rejected'))
  assert.ok(owner.service.model.requests.every(item => item.status === 'rejected'))
  await owner.service.updateCommunity(id, { admission: 'direct' })
  await owner.service.reconcile()
  assert.deepEqual(owner.service.model.communities[0].members, [alice.publicKey])
})

test('the community model is reused only while its input snapshots are unchanged', async () => {
  const h = harness(), { owner, id } = await established(h, 'direct', [])
  const preferences = owner.host.preferences()
  owner.host.preferences = () => preferences
  let records = [...owner.host.records()]
  owner.host.records = () => records
  const model = owner.service.model
  assert.equal(owner.service.model, model)
  records = [...records]
  assert.notEqual(owner.service.model, model)
  const next = owner.service.model
  owner.host.preferences = () => ({ ...preferences, notifications: { [id]: 'muted' } })
  assert.notEqual(owner.service.model, next)
  assert.equal(owner.service.model.communities[0].notificationMode, 'muted')
})
