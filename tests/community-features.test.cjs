const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test, before } = require('node:test')
const ts = require('typescript')
const remoteAttachment = require('./fixtures/remote-attachment.cjs')

const root = path.join(__dirname, '..'), modules = new Map()
function load(filename) {
  if (!path.extname(filename)) filename += '.ts'
  if (modules.has(filename)) return modules.get(filename).exports
  const module = { exports: {} }; modules.set(filename, module)
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const sourceRequire = name => name.startsWith('.') ? load(path.resolve(path.dirname(filename), name)) : require(name)
  new Function('require', 'module', 'exports', 'navigator', output)(sourceRequire, module, module.exports, {})
  return module.exports
}
const cryptography = load(path.join(root, 'lib/crypto.ts'))
const protocol = load(path.join(root, 'lib/community-protocol.ts'))
const attachments = load(path.join(root, 'lib/attachments.ts'))
const { CommunityService } = load(path.join(root, 'lib/community-service.ts'))
let alice, bob, charlie
const defaults = () => ({ accepted: [], blocked: [], notifications: {}, readAt: {}, readReceipts: true, archived: [], deleted: {}, deletedMessages: {} })
before(async () => {
  const identity = async () => {
    const pair = await cryptography.generateEncryptionKeyPair()
    return { version: 2, publicKey: await cryptography.exportPublicKeyToHex(pair.publicKey), privateKey: await cryptography.exportKey(pair.privateKey) }
  }
  ;[alice, bob, charlie] = await Promise.all([identity(), identity(), identity()])
})
async function fixture(members = [alice, bob, charlie]) {
  let clock = Date.now() - 2000, sequence = 0
  const stores = new Map(), preferences = new Map(), events = []
  let state = await protocol.signCommunityState({ version: 2, id: `community:${alice.publicKey}:${crypto.randomUUID()}`, owner: alice.publicKey,
    name: 'Feature club', description: '', epoch: 1, updatedAt: clock++, members: members.map(member => member.publicKey), moderators: [], coOwners: [], bans: [],
    channels: [{ id: crypto.randomUUID(), name: 'general', posting: 'members' }, { id: crypto.randomUUID(), name: 'files', posting: 'members' }, { id: crypto.randomUUID(), name: 'announcements', posting: 'moderators' }],
    admission: 'direct', joiningPaused: false, inviteGeneration: 1, transfers: [], signer: alice.publicKey, deleted: false }, alice)
  const event = (identity, data, current = state) => ({ version: 3, id: crypto.randomUUID(), author: identity.publicKey, conversationId: current.id,
    recipients: current.members.filter(member => member !== identity.publicKey), timestamp: clock++, kind: 'community', payload: { community: data }, signature: '0'.repeat(128) })
  const inject = value => {
    events.push(value)
    for (const address of new Set([value.author, ...value.recipients])) stores.set(address, [...(stores.get(address) ?? []), {
      key: `${value.author}:${value.conversationId}:${value.id}`, event: structuredClone(value), local: value.author === address,
      delivered: [...value.recipients], receivedAt: ++sequence, sequence,
    }])
  }
  inject(event(alice, { type: 'state', state }))
  const client = identity => {
    let refreshes = 0
    const host = { identity, records: () => stores.get(identity.publicKey) ?? [], preferences: () => preferences.get(identity.publicKey) ?? defaults(),
      refresh: async () => { refreshes++ }, sign: async value => ({ ...value, timestamp: clock++, signature: '0'.repeat(128) }), queue: async value => inject(value) }
    return { service: new CommunityService(host), host, refreshes: () => refreshes }
  }
  const data = (type, channelId, payload = {}, current = state) => ({ type, channelId, epoch: current.epoch, ...protocol.communityStateReference(current), ...payload })
  const update = async changes => {
    const recipients = [...new Set([...state.members, ...(changes.members ?? [])])].filter(address => address !== alice.publicKey)
    const next = { ...state, ...changes, epoch: state.epoch + 1, updatedAt: clock++ }
    delete next.signature
    state = await protocol.signCommunityState(next, alice)
    inject({ ...event(alice, { type: 'state', state }), recipients })
    return state
  }
  return { id: state.id, channel: state.channels[0].id, other: state.channels[1].id, announcements: state.channels[2].id,
    state: () => state, event, data, inject, update, client, events, stores, preferences }
}

test('community feature envelopes validate bounded data and reject extra/executable payloads', async () => {
  const f = await fixture(), file = await attachments.prepareAttachment(new File(['abc'], 'a.txt', { type: 'text/plain' }))
  const targetId = crypto.randomUUID()
  const valid = [
    ['attachment', { attachment: file.metadata, content: 'Caption', replyTo: targetId, mentions: [bob.publicKey] }],
    ['attachment-chunk', { attachmentId: file.metadata.id, ...file.chunks[0] }], ['edit', { targetId, content: 'Edited' }],
    ['pin', { targetId, pinned: true }], ['poll', { question: 'When?', options: ['Today', 'Tomorrow'] }],
    ['vote', { targetId, option: 1 }], ['receipt', { targetId, receipt: 'read' }],
  ]
  for (const [kind, payload] of valid) {
    assert.equal(await protocol.validateCommunityEvent(f.event(alice, f.data(kind, f.channel, payload))), true, kind)
    assert.equal(await protocol.validateCommunityEvent(f.event(alice, f.data(kind, f.channel, { ...payload, secret: true }))), false, `${kind} extra key`)
  }
  const invalid = [
    ['attachment', { attachment: { ...file.metadata, chunks: 99 } }], ['attachment', { attachment: { ...file.metadata, css: 'url()' } }],
    ['attachment-chunk', { attachmentId: file.metadata.id, index: -1, data: 'YWJj' }], ['attachment-chunk', { attachmentId: file.metadata.id, index: 0, data: '!' }],
    ['poll', { question: 'When?', options: ['Today', ' today '] }], ['vote', { targetId, option: 10 }], ['pin', { targetId, pinned: 'yes' }],
    ['receipt', { targetId, receipt: 'anything' }], ['edit', { targetId, content: ' ' }],
  ]
  for (const [kind, payload] of invalid) assert.equal(await protocol.validateCommunityEvent(f.event(alice, f.data(kind, f.channel, payload))), false, kind)
})

test('community envelopes accept remote file metadata and reject malformed authenticated descriptors', async () => {
  const f = await fixture(), metadata = remoteAttachment()
  assert.equal(await protocol.validateCommunityEvent(f.event(alice, f.data('attachment', f.channel, { attachment: metadata }))), true)
  for (const damage of [meta => { meta.remote.version = 2 }, meta => { meta.remote.capability = '' }, meta => { meta.remote.ivPrefix = '00' }, meta => { meta.remote.hashes.pop() }, meta => { meta.chunks++ }]) {
    const attachment = structuredClone(metadata)
    damage(attachment)
    assert.equal(await protocol.validateCommunityEvent(f.event(alice, f.data('attachment', f.channel, { attachment }))), false)
  }
})

test('channels support replies, mentions, own edits, pins, polls and votes while ignoring historical receipts', async () => {
  const f = await fixture(), owner = f.client(alice).service, peer = f.client(bob).service
  const original = await peer.sendMessage(f.id, f.channel, 'Initial message')
  const reply = await owner.sendMessage(f.id, f.channel, 'Reply', original, [bob.publicKey, charlie.publicKey])
  await peer.editMessage(f.id, f.channel, original, 'Corrected message')
  await owner.pinMessage(f.id, f.channel, original, true)
  const poll = await owner.createPoll(f.id, f.channel, 'Practice day?', ['Monday', 'Tuesday'])
  await peer.vote(f.id, f.channel, poll, 0)
  await peer.vote(f.id, f.channel, poll, 1)
  const receipt = f.event(bob, f.data('receipt', f.channel, { targetId: reply, receipt: 'read' }))
  receipt.timestamp = f.events.find(event => event.id === reply).timestamp - 250
  f.inject(receipt) // Historical receipts parse but do not restore reader tracking.
  const rows = owner.model.messages
  assert.equal(rows.find(message => message.id === original).content, 'Corrected message')
  assert.equal(rows.find(message => message.id === original).pinned, true)
  assert.ok(rows.find(message => message.id === original).editedAt)
  assert.equal(rows.find(message => message.id === reply).replyTo, original)
  assert.deepEqual(rows.find(message => message.id === reply).mentions, [bob.publicKey, charlie.publicKey])
  assert.equal(rows.find(message => message.id === poll).poll.votes[bob.publicKey], 1)
  assert.equal(rows.find(message => message.id === reply).delivery, 'sent')
  assert.deepEqual(rows.find(message => message.id === reply).readBy, [])
  await assert.rejects(owner.editMessage(f.id, f.channel, original, 'Forged'), /your own/)
  await assert.rejects(owner.sendMessage(f.id, f.other, 'Wrong channel', original), /replying/)
  await assert.rejects(peer.vote(f.id, f.other, poll, 0), /channel/)

  // A relay can deliver the valid edit before its target; the target never
  // supplies missing membership permission, only the already-admitted content.
  const records = f.stores.get(alice.publicKey)
  const edited = records.find(record => record.event.payload.community.type === 'edit')
  const target = records.find(record => record.event.id === original)
  const reordered = records.map(record => record === edited ? { ...record, receivedAt: target.receivedAt - 0.5 } : record)
  assert.equal(protocol.buildCommunityModel(reordered, alice.publicKey, defaults()).messages.find(message => message.id === original).content, 'Corrected message')
})

test('attachments preserve captions and replies while pieces stay bound to sender, channel and epoch', async () => {
  const f = await fixture(), sender = f.client(alice), peer = f.client(bob).service
  const replied = await sender.service.sendMessage(f.id, f.channel, 'File incoming')
  const bytes = new File(['Community file'], 'notes.txt', { type: 'text/plain' })
  const messageId = await attachments.sendAttachment((_id, kind, payload) => sender.service.sendEvent(f.id, f.channel, kind, payload), f.id, bytes,
    'file', undefined, replied, undefined, { content: 'Read this', mentions: [bob.publicKey] })
  const message = peer.model.messages.find(message => message.id === messageId)
  assert.equal(message.content, 'Read this')
  assert.equal(message.replyTo, replied)
  assert.deepEqual(message.mentions, [bob.publicKey])
  const chunk = f.events.find(event => event.payload.community.type === 'attachment-chunk').payload.community
  f.inject(f.event(bob, { ...chunk, data: btoa('Counterfeit!!!') }))
  f.inject(f.event(alice, { ...chunk, channelId: f.other, data: btoa('Counterfeit!!!') }))
  const before = peer.getAttachmentChunks(f.id, f.channel, messageId)
  assert.equal(await (await attachments.assembleAttachment(message.attachment, before)).text(), 'Community file')
  assert.deepEqual(peer.getAttachmentChunks(f.id, f.other, messageId), [])
  await f.update({ description: 'New epoch' })
  f.inject(f.event(alice, f.data('attachment-chunk', f.channel, { attachmentId: message.attachment.id, index: 0, data: btoa('Counterfeit!!!') })))
  assert.deepEqual(peer.getAttachmentChunks(f.id, f.channel, messageId), before, 'new epoch pieces cannot replace old transfer bytes')
  await sender.service.hideMessage(f.id, messageId)
  assert.deepEqual(peer.getAttachmentChunks(f.id, f.channel, messageId), [], 'moderator-hidden files stop exposing pieces')
})

test('announcement restrictions and original audiences also cover new feature events', async () => {
  const f = await fixture([alice, bob]), owner = f.client(alice).service, peer = f.client(bob).service
  const poll = await owner.createPoll(f.id, f.announcements, 'Readiness?', ['Ready', 'Later'])
  const plain = await owner.sendMessage(f.id, f.channel, 'Before the next member joins')
  await peer.vote(f.id, f.announcements, poll, 0)
  await assert.rejects(peer.receipt(f.id, f.announcements, poll, 'read'), /receipts are not sent/)
  await assert.rejects(peer.createPoll(f.id, f.announcements, 'Unauthorized?', ['Yes', 'No']), /moderators/)
  await assert.rejects(peer.pinMessage(f.id, f.announcements, poll, true), /moderators/)
  const forbidden = f.event(bob, f.data('poll', f.announcements, { question: 'Forged announcement', options: ['Yes', 'No'] }))
  f.inject(forbidden)
  assert.equal(owner.model.messages.some(message => message.id === forbidden.id), false)
  assert.match(protocol.communityOutboxError(forbidden, peer.model, bob.publicKey), /post/)
  await f.update({ members: [alice.publicKey, bob.publicKey, charlie.publicKey] })
  const newcomer = f.client(charlie).service
  assert.equal(newcomer.model.messages.some(message => message.id === plain || message.id === poll), false)
  const attacks = [
    f.event(charlie, f.data('vote', f.announcements, { targetId: poll, option: 1 })),
    f.event(charlie, f.data('receipt', f.channel, { targetId: plain, receipt: 'read' })),
    f.event(bob, f.data('pin', f.other, { targetId: plain, pinned: true })),
    f.event(bob, f.data('edit', f.channel, { targetId: plain, content: 'Forged owner text' })),
  ]
  for (const attack of attacks) f.inject(attack)
  assert.equal(owner.model.messages.find(message => message.id === poll).poll.votes[charlie.publicKey], undefined)
  assert.deepEqual(owner.model.messages.find(message => message.id === plain).readBy, [])
  assert.equal(owner.model.messages.find(message => message.id === plain).pinned, false)
  assert.equal(owner.model.messages.find(message => message.id === plain).content, 'Before the next member joins')
  for (const attack of attacks) assert.equal(owner.model.acceptedKeys.includes(`${attack.author}:${attack.conversationId}:${attack.id}`), false)
})

test('local deletion hides feature messages without losing membership, and late signing changes cancel sends', async () => {
  const f = await fixture(), owner = f.client(alice), peer = f.client(bob)
  const poll = await peer.service.createPoll(f.id, f.channel, 'Delete locally?', ['Yes', 'No'])
  const prefs = defaults()
  prefs.deletedMessages[f.id] = { deletedAt: Date.now(), messageIds: [poll], eventKeys: [] }
  f.preferences.set(alice.publicKey, prefs)
  assert.equal(owner.service.model.messages.some(message => message.id === poll), false)
  assert.equal(owner.service.model.communities[0].joined, true)
  assert.equal(peer.service.model.messages.some(message => message.id === poll), true)

  const start = peer.refreshes()
  await peer.service.sendEvent(f.id, f.channel, 'attachment-chunk', { attachmentId: crypto.randomUUID(), index: 0, data: btoa('abc') })
  assert.equal(peer.refreshes(), start, 'queueing a file piece does not reread all stored history')
  const sign = peer.host.sign
  peer.host.sign = async event => {
    if (event.payload.community.type === 'poll') await f.update({ members: [alice.publicKey, charlie.publicKey] })
    return sign(event)
  }
  await assert.rejects(peer.service.createPoll(f.id, f.channel, 'Must not send', ['Yes', 'No']), /community changed|no longer a member/)
  assert.equal(f.events.some(event => event.payload.community.question === 'Must not send'), false)
})

test('a member message with a command ID cannot acknowledge or suppress moderation', async () => {
  const f = await fixture(), owner = f.client(alice).service
  await f.update({ moderators: [bob.publicKey] })
  const current = f.state()
  const command = f.event(bob, { type: 'command', epoch: current.epoch, ...protocol.communityStateReference(current), action: 'ban', target: charlie.publicKey })
  command.recipients = [alice.publicKey]
  assert.equal(await protocol.validateCommunityEvent(command), true)
  f.inject(command)
  assert.equal(owner.model.commands.some(item => item.id === command.id), true)
  const collision = { ...f.event(charlie, f.data('message', f.channel, { content: 'Ordinary member message' })), id: command.id }
  assert.equal(await protocol.validateCommunityEvent(collision), true)
  f.inject(collision)
  assert.equal(owner.model.commands.some(item => item.id === command.id), true)
  assert.equal(owner.model.processedIds.includes(command.id), false)
  assert.equal(owner.model.acceptedKeys.includes(`${collision.author}:${collision.conversationId}:${collision.id}`), true)
})

test('accepted event IDs cannot authorize a rejected attachment piece from a different author', async () => {
  const f = await fixture(), peer = f.client(bob).service
  const file = await attachments.prepareAttachment(new File(['abc'], 'notes.txt', { type: 'text/plain' }))
  const accepted = f.event(bob, f.data('message', f.channel, { content: 'Accepted content' }))
  f.inject(accepted)
  const rejected = { ...f.event(alice, f.data('attachment-chunk', f.channel, { attachmentId: file.metadata.id, ...file.chunks[0] })),
    id: accepted.id, recipients: [bob.publicKey] }
  assert.equal(await protocol.validateCommunityEvent(rejected), true, 'the envelope is valid but its audience violates membership')
  f.inject(rejected)
  const metadata = f.event(alice, f.data('attachment', f.channel, { attachment: file.metadata }))
  f.inject(metadata)
  assert.equal(peer.model.acceptedKeys.includes(`${rejected.author}:${rejected.conversationId}:${rejected.id}`), false)
  assert.deepEqual(peer.getAttachmentChunks(f.id, f.channel, metadata.id), [])
})

test('a community update midway through a file rejects incomplete metadata and allows a complete retry', async () => {
  const f = await fixture(), sender = f.client(alice).service, peer = f.client(bob).service
  const file = new File([new Uint8Array(attachments.ATTACHMENT_CHUNK_BYTES + 1)], 'two-pieces.bin', { type: 'application/octet-stream' })
  let updated = false
  await assert.rejects(attachments.sendAttachment(async (_id, kind, payload) => {
    const result = await sender.sendEvent(f.id, f.channel, kind, payload)
    if (kind === 'attachment-chunk' && !updated) {
      updated = true
      await f.update({ description: 'Changed while the file was being sent' })
    }
    return result
  }, f.id, file), /community|file|attachment/i)
  assert.equal(f.events.some(event => event.payload.community.type === 'attachment'), false, 'a broken attachment never becomes visible')
  assert.equal(peer.model.messages.some(message => message.attachment), false)
  const messageId = await attachments.sendAttachment((_id, kind, payload) => sender.sendEvent(f.id, f.channel, kind, payload), f.id, file)
  const message = peer.model.messages.find(message => message.id === messageId)
  const chunks = peer.getAttachmentChunks(f.id, f.channel, messageId)
  assert.equal(chunks.length, 2)
  assert.equal((await attachments.assembleAttachment(message.attachment, chunks)).size, file.size)
})

test('large community files keep validated pieces across text and receipt updates without decoding the file again', async t => {
  const f = await fixture([alice, bob]), peer = f.client(bob).service
  const prefs = defaults(); f.preferences.set(bob.publicKey, prefs)
  const file = await attachments.prepareAttachment(new File([new Uint8Array(Math.round(14.6 * 1024 * 1024))], 'history.gif', { type: 'image/gif' }))
  for (const chunk of file.chunks) f.inject(f.event(alice, f.data('attachment-chunk', f.channel, { attachmentId: file.metadata.id, ...chunk })))
  const metadata = f.event(alice, f.data('attachment', f.channel, { attachment: file.metadata }))
  f.inject(metadata)
  const decode = globalThis.atob
  let decodes = 0
  globalThis.atob = value => { decodes++; return decode(value) }
  try {
    const initialStart = performance.now()
    const first = peer.getAttachmentChunks(f.id, f.channel, metadata.id)
    const initialMs = performance.now() - initialStart
    assert.equal(first.length, file.chunks.length)
    assert.equal(decodes, file.chunks.length, 'each new immutable piece receives its canonical-byte validation')
    decodes = 0
    const updateStart = performance.now()
    for (let index = 0; index < 10; index++) {
      f.inject(f.event(alice, f.data('message', f.channel, { content: `Text update ${index}` })))
      f.preferences.set(bob.publicKey, { ...prefs, readAt: { [protocol.communityChannelKey(f.id, f.channel)]: Date.now() } })
      assert.equal(peer.getAttachmentChunks(f.id, f.channel, metadata.id), first, 'unchanged file keeps its piece-array identity after a history refresh')
    }
    assert.equal(decodes, 0, 'typing, ordinary text and read updates must not reprocess 14.6 MB of historical media')
    t.diagnostic(`14.6 MB community file: first validation ${initialMs.toFixed(1)} ms; ten history/preference updates ${(performance.now() - updateStart).toFixed(1)} ms, zero repeated file decodes`)
  } finally { globalThis.atob = decode }
})

test('cached community pieces follow removal, blocking, deletion and conflicts immediately', async () => {
  const f = await fixture([alice, bob]), peer = f.client(bob).service
  const prefs = defaults(); f.preferences.set(bob.publicKey, prefs)
  const file = await attachments.prepareAttachment(new File(['a'], 'a.txt', { type: 'text/plain' }))
  const piece = f.event(alice, f.data('attachment-chunk', f.channel, { attachmentId: file.metadata.id, ...file.chunks[0] }))
  const metadata = f.event(alice, f.data('attachment', f.channel, { attachment: file.metadata }))
  f.inject(piece); f.inject(metadata)
  assert.equal(peer.getAttachmentChunks(f.id, f.channel, metadata.id).length, 1)
  f.preferences.set(bob.publicKey, { ...prefs, blocked: [alice.publicKey] })
  assert.deepEqual(peer.getAttachmentChunks(f.id, f.channel, metadata.id), [])
  f.preferences.set(bob.publicKey, { ...prefs, deletedMessages: { [f.id]: { messageIds: [metadata.id], eventKeys: [], attachmentKeys: [] } } })
  assert.deepEqual(peer.getAttachmentChunks(f.id, f.channel, metadata.id), [])
  f.preferences.set(bob.publicKey, prefs)
  assert.equal(peer.getAttachmentChunks(f.id, f.channel, metadata.id).length, 1)
  const all = f.stores.get(bob.publicKey)
  f.stores.set(bob.publicKey, all.filter(record => record.event.id !== piece.id))
  assert.deepEqual(peer.getAttachmentChunks(f.id, f.channel, metadata.id), [])
  f.stores.set(bob.publicKey, all)
  assert.equal(peer.getAttachmentChunks(f.id, f.channel, metadata.id).length, 1)
  const conflict = f.event(alice, f.data('attachment-chunk', f.channel, { attachmentId: file.metadata.id, index: 0, data: btoa('b') }))
  f.inject(conflict)
  assert.deepEqual(peer.getAttachmentChunks(f.id, f.channel, metadata.id), [], 'a new conflicting piece invalidates a warm result')
  f.stores.set(bob.publicKey, all.filter(record => record.event.id !== piece.id))
  f.inject(f.event(alice, f.data('attachment-chunk', f.channel, { attachmentId: file.metadata.id, index: 0, data: 'YR==' })))
  assert.deepEqual(peer.getAttachmentChunks(f.id, f.channel, metadata.id), [], 'noncanonical base64 cannot populate the cache')
})
