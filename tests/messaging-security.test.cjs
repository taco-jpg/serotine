/* Security invariants for signed rich events and the conversation reducer. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')
const root = path.join(__dirname, '..')
const cache = new Map()
function load(filename) {
  if (!path.extname(filename)) filename += '.ts'
  if (cache.has(filename)) return cache.get(filename).exports
  const module = { exports: {} }; cache.set(filename, module)
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const requireSource = name => name === 'idb' ? {} : name.startsWith('@/') ? load(path.join(root, name.slice(2)))
    : name.startsWith('.') ? load(path.resolve(path.dirname(filename), name)) : require(name)
  new Function('require', 'module', 'exports', output)(requireSource, module, module.exports)
  return module.exports
}
const cryptography = load(path.join(root, 'lib/crypto.ts'))
const messaging = load(path.join(root, 'lib/messaging.ts'))
const { defaultMessagingPreferences, eventStorageKey } = load(path.join(root, 'lib/messaging-store.ts'))
async function identity() {
  const pair = await cryptography.generateEncryptionKeyPair()
  return { version: 2, privateKey: await cryptography.exportKey(pair.privateKey), publicKey: await cryptography.exportPublicKeyToHex(pair.publicKey) }
}
async function event(author, conversation, kind = 'message', payload = { content: 'hello' }, extra = {}) {
  const group = typeof conversation === 'object' ? conversation : undefined
  const cid = group?.id ?? conversation
  const recipients = group ? group.members.filter(x => x !== author.publicKey) : [cid]
  return messaging.signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: author.publicKey, conversationId: cid,
    recipients: recipients.length ? recipients : [author.publicKey], timestamp: Date.now() - 1000,
    kind, payload, ...(group ? { group } : {}), ...extra }, author)
}
async function group(admin, members, extra = {}) {
  return messaging.signGroup({ id: `group:${crypto.randomUUID()}`, admin: admin.publicKey, members: members.map(x => x.publicKey),
    name: 'Study group', epoch: 1, updatedAt: Date.now() - 2000, ...extra }, admin)
}
function record(e, owner, index = 0, extra = {}) {
  return { key: eventStorageKey(e), event: e, local: e.author === owner.publicKey, delivered: [...e.recipients], receivedAt: Date.now() - 1000 + index, ...extra }
}
function model(events, owner, preferences = defaultMessagingPreferences()) {
  return messaging.buildMessagingModel(events.map((e, i) => record(e, owner, i)), owner.publicKey, [], preferences)
}

test('self send is one ordinary self conversation; incoming and outgoing direct events share the correct peer route', async () => {
  const [alice, bob] = await Promise.all([identity(), identity()])
  const sent = await event(alice, bob.publicKey), received = await event(bob, alice.publicKey), self = await event(alice, alice.publicKey)
  for (const e of [sent, received, self]) assert.equal(await messaging.validateMessagingEvent(e), true)
  const state = model([sent, received, self], alice)
  assert.deepEqual(state.messages.filter(x => x.conversationId === bob.publicKey).map(x => x.senderPubKey), [sent, received].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id)).map(x => x.author))
  const own = state.conversations.find(x => x.id === alice.publicKey)
  assert.equal(own.kind, 'self')
  assert.deepEqual(own.members, [alice.publicKey])
  assert.equal(own.unreadCount, 0)
  assert.equal(own.request, false)
  assert.equal(state.messages.filter(x => x.conversationId === alice.publicKey).length, 1)
})

test('event signatures bind author, route, recipients, payload and transport id', async () => {
  const [alice, bob, mallory] = await Promise.all([identity(), identity(), identity()])
  const e = await event(alice, bob.publicKey)
  assert.equal(await messaging.validateMessagingEvent(e, { senderPubKey: alice.publicKey, recipientPubKey: bob.publicKey, id: e.id }), true)
  for (const bad of [{ ...e, author: mallory.publicKey }, { ...e, conversationId: mallory.publicKey },
    { ...e, recipients: [mallory.publicKey] }, { ...e, payload: { content: 'forged' } }, { ...e, id: crypto.randomUUID() }]) {
    assert.equal(await messaging.validateMessagingEvent(bad), false)
  }
  for (const transport of [{ senderPubKey: mallory.publicKey, recipientPubKey: bob.publicKey, id: e.id },
    { senderPubKey: alice.publicKey, recipientPubKey: mallory.publicKey, id: e.id },
    { senderPubKey: alice.publicKey, recipientPubKey: bob.publicKey, id: crypto.randomUUID() }]) {
    assert.equal(await messaging.validateMessagingEvent(e, transport), false)
  }
})

test('malformed rich events are rejected without throwing or hiding later valid messages', async () => {
  const [alice, bob] = await Promise.all([identity(), identity()])
  const e = await event(alice, bob.publicKey)
  const malformed = [undefined, null, [], 123, 'text', { ...e, payload: null }, { ...e, recipients: [] },
    { ...e, recipients: [bob.publicKey, bob.publicKey] }, { ...e, timestamp: Date.now() + 120000 },
    { ...e, timestamp: NaN }, { ...e, kind: 'execute' }, { ...e, signature: 'bad' },
    await event(alice, bob.publicKey, 'message', { content: 'x'.repeat(8001) }),
    await event(alice, bob.publicKey, 'poll', { question: 'Pick', options: ['One', ' one '] }),
    await event(alice, bob.publicKey, 'vote', { targetId: crypto.randomUUID(), option: -1 }),
    await event(alice, bob.publicKey, 'attachment-chunk', { attachmentId: crypto.randomUUID(), index: 0, data: '<script>' })]
  const accepted = []
  for (const item of [...malformed, e]) if (await messaging.validateMessagingEvent(item)) accepted.push(item)
  assert.deepEqual(accepted, [e])
  assert.equal(model(accepted, bob).messages.length, 1)
})

test('signed group membership is authoritative; outsiders and substituted membership lists are refused', async () => {
  const [alice, bob, carol, mallory] = await Promise.all([identity(), identity(), identity(), identity()])
  const g = await group(alice, [alice, bob, carol])
  assert.equal(await messaging.validateMessagingEvent(await event(bob, g)), true)
  assert.equal(await messaging.validateMessagingEvent(await event(mallory, g)), false)
  assert.equal(await messaging.validateMessagingEvent(await event(bob, g, 'message', { content: 'private' }, { recipients: [alice.publicKey] })), false)
  const forged = { ...g, members: [...g.members, mallory.publicKey] }
  assert.equal(await messaging.validateMessagingEvent(await event(mallory, forged)), false)
  assert.equal(await messaging.validateMessagingEvent(await event(bob, g, 'group', {})), false)
  assert.equal(await messaging.validateMessagingEvent(await event(alice, g, 'group', {})), true)
})

test('removed members cannot send or control after a newer membership epoch; stale descriptors cannot roll back membership', async () => {
  const [alice, bob, carol] = await Promise.all([identity(), identity(), identity()])
  const g1 = await group(alice, [alice, bob, carol])
  const g2 = await group(alice, [alice, carol], { id: g1.id, epoch: 2 })
  const target = await event(alice, g1)
  const update = await event(alice, g2, 'group', {}, { recipients: [bob.publicKey, carol.publicKey] })
  const staleMessage = await event(bob, g1)
  const stalePin = await event(bob, g1, 'pin', { targetId: target.id, pinned: true })
  const events = [target, update, staleMessage, stalePin]
  for (const e of events) assert.equal(await messaging.validateMessagingEvent(e), true)
  const state = model(events, carol)
  assert.deepEqual(state.messages.map(x => x.id), [target.id])
  assert.equal(state.messages[0].pinned, false)
  assert.equal(state.groups[0].epoch, 2)
  assert.equal(state.conversations.find(x => x.id === g1.id).members.includes(bob.publicKey), false)
})

test('a different administrator cannot replace an established group even with a valid independent signature', async () => {
  const [alice, bob, mallory] = await Promise.all([identity(), identity(), identity()])
  const original = await group(alice, [alice, bob])
  const hijack = await group(mallory, [mallory, bob], { id: original.id, epoch: 99, name: 'Hijacked' })
  const before = await event(alice, original), after = await event(mallory, hijack)
  assert.equal(await messaging.validateMessagingEvent(after), true, 'independent envelope valid, but existing group authority must win')
  const state = model([before, after], bob)
  assert.equal(state.groups[0].admin, alice.publicKey)
  assert.deepEqual(state.messages.map(x => x.id), [before.id])
})

test('same-epoch conflicting group descriptors and post-leave messages are ignored', async () => {
  const [alice, bob, carol] = await Promise.all([identity(), identity(), identity()])
  const g = await group(alice, [alice, bob, carol])
  const conflict = await group(alice, [alice, bob], { id: g.id, epoch: 1, name: 'Conflicting' })
  const initial = await event(alice, g), changed = await event(alice, conflict), leave = await event(bob, g, 'leave', {}), later = await event(bob, g)
  for (const e of [initial, changed, leave, later]) assert.equal(await messaging.validateMessagingEvent(e), true)
  const state = model([initial, changed, leave, later], carol)
  assert.deepEqual(state.messages.map(x => x.id), [initial.id])
  assert.equal(state.groups[0].name, g.name)
  assert.equal(state.conversations.find(x => x.id === g.id).members.includes(bob.publicKey), false)
})

test('only the original author can edit text; direct controls never cross conversation boundaries', async () => {
  const [alice, bob, mallory] = await Promise.all([identity(), identity(), identity()])
  const target = await event(alice, bob.publicKey)
  const impostor = await event(bob, alice.publicKey, 'edit', { targetId: target.id, content: 'wrong author' })
  const otherChat = await event(mallory, alice.publicKey, 'pin', { targetId: target.id, pinned: true })
  const correct = await event(alice, bob.publicKey, 'edit', { targetId: target.id, content: 'corrected' })
  const state = model([target, impostor, otherChat, correct], alice)
  assert.equal(state.messages.length, 1)
  assert.equal(state.messages[0].content, 'corrected')
  assert.equal(state.messages[0].pinned, false)
})

test('poll votes are attributed to authenticated authors and limited to the actual options', async () => {
  const [alice, bob] = await Promise.all([identity(), identity()])
  const poll = await event(alice, bob.publicKey, 'poll', { question: 'When?', options: ['Now', 'Later'] })
  const vote = await event(bob, alice.publicKey, 'vote', { targetId: poll.id, option: 1 })
  const impossible = await event(bob, alice.publicKey, 'vote', { targetId: poll.id, option: 9 })
  const ownReceipt = await event(alice, bob.publicKey, 'receipt', { targetId: poll.id, receipt: 'read' })
  const state = model([poll, vote, impossible, ownReceipt], alice)
  assert.deepEqual(state.messages[0].poll.votes, { [bob.publicKey]: 1 })
  assert.deepEqual(state.messages[0].readBy, [])
})

test('blocking removes incoming content and pending requests without affecting self messages', async () => {
  const [alice, bob] = await Promise.all([identity(), identity()])
  const incoming = await event(bob, alice.publicKey), own = await event(alice, alice.publicKey)
  const before = model([incoming, own], alice)
  assert.equal(before.requests.some(x => x.id === bob.publicKey), true)
  const prefs = defaultMessagingPreferences(); prefs.blocked = [bob.publicKey]
  const after = model([incoming, own], alice, prefs)
  assert.deepEqual(after.messages.map(x => x.id), [own.id])
  assert.equal(after.requests.some(x => x.id === bob.publicKey), false)
})

test('authorized controls remain effective when persisted before their target at the same timestamp', async () => {
  const [alice, bob] = await Promise.all([identity(), identity()])
  const time = Date.now() - 1000
  const target = await event(alice, bob.publicKey, 'message', { content: 'original' }, { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', timestamp: time })
  const edit = await event(alice, bob.publicKey, 'edit', { targetId: target.id, content: 'edited' }, { id: '00000000-0000-4000-8000-000000000000', timestamp: time })
  const state = messaging.buildMessagingModel([record(target, bob, 0, { receivedAt: time }), record(edit, bob, 0, { receivedAt: time })], bob.publicKey, [], defaultMessagingPreferences())
  assert.equal(state.messages[0].content, 'edited')
})

test('relay sequence resolves equal timestamps before group membership changes', async () => {
  const [alice, bob, carol] = await Promise.all([identity(), identity(), identity()])
  const g1 = await group(alice, [alice, bob, carol])
  const g2 = await group(alice, [alice, carol], { id: g1.id, epoch: 2 })
  const time = Date.now() - 1000
  const before = await event(alice, g1, 'message', { content: 'before removal' }, { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', timestamp: time })
  const update = await event(alice, g2, 'group', {}, { id: '00000000-0000-4000-8000-000000000000', timestamp: time, recipients: [bob.publicKey, carol.publicKey] })
  const stale = await event(bob, g1, 'message', { content: 'after removal' }, { timestamp: time })
  const records = [before, update, stale].map((e, i) => record(e, carol, i, { receivedAt: time, sequence: i + 1 })).reverse()
  const state = messaging.buildMessagingModel(records, carol.publicKey, [], defaultMessagingPreferences())
  assert.deepEqual(state.messages.map(x => x.id), [before.id])
  assert.equal(state.groups[0].epoch, 2)
})

test('the administrator can leave, closing membership and rejecting subsequent stale group messages', async () => {
  const [alice, bob] = await Promise.all([identity(), identity()])
  const g = await group(alice, [alice, bob])
  const initial = await event(alice, g), leave = await event(alice, g, 'leave', {}), late = await event(bob, g)
  assert.equal(await messaging.validateMessagingEvent(leave), true)
  const state = model([initial, leave, late], bob)
  assert.deepEqual(state.conversations.find(x => x.id === g.id).members, [])
  assert.deepEqual(state.messages.map(x => x.id), [initial.id])
})

test('departed members cannot replace historical attachment chunks with old-epoch packets', async () => {
  const [alice, bob] = await Promise.all([identity(), identity()])
  const g = await group(alice, [alice, bob])
  const attachment = { id: crypto.randomUUID(), name: 'note.txt', mime: 'text/plain', size: 1, chunks: 1,
    sha256: cryptography.arrayBufferToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('A'))), kind: 'file' }
  const meta = await event(bob, g, 'attachment', { attachment })
  const original = await event(bob, g, 'attachment-chunk', { attachmentId: attachment.id, index: 0, data: 'QQ==' })
  const leave = await event(bob, g, 'leave', {})
  const replacement = await event(bob, g, 'attachment-chunk', { attachmentId: attachment.id, index: 0, data: 'Qg==' })
  for (const e of [meta, original, leave, replacement]) assert.equal(await messaging.validateMessagingEvent(e), true)
  const engine = new messaging.MessagingEngine(alice)
  engine.records = [meta, original, leave, replacement].map((e, i) => record(e, alice, i))
  engine.model = messaging.buildMessagingModel(engine.records, alice.publicKey, [], defaultMessagingPreferences(), engine.authorizedKeys)
  assert.equal(engine.authorizedKeys.has(eventStorageKey(original)), true)
  assert.equal(engine.authorizedKeys.has(eventStorageKey(replacement)), false)
  assert.deepEqual(engine.getAttachmentChunks(g.id, meta.id), [{ index: 0, data: 'QQ==' }])
})

test('old preferences remain readable and archived unknown groups stay out of requests', async () => {
  const [alice, bob] = await Promise.all([identity(), identity()])
  const g = await group(bob, [bob, alice]), incoming = await event(bob, g)
  const old = { accepted: [], blocked: [], notifications: {}, readAt: {}, readReceipts: true }
  const initial = model([incoming], alice, old)
  assert.equal(initial.conversations.find(c => c.id === g.id).archived, false)
  assert.equal(initial.requests.length, 1)
  const archived = model([incoming], alice, { ...old, archived: [g.id] })
  assert.equal(archived.conversations.find(c => c.id === g.id).archived, true)
  assert.equal(archived.requests.length, 0)
  assert.equal(archived.messages[0].id, incoming.id)
})

test('deletion hides retained contact shells, rejects old history, and reopens only for fresh content', async () => {
  const [alice, bob] = await Promise.all([identity(), identity()])
  const old = await event(bob, alice.publicKey), deletedAt = Date.now()
  const p = { ...defaultMessagingPreferences(), accepted: [bob.publicKey], deleted: { [bob.publicKey]: { deletedAt, eventKeys: [eventStorageKey(old)] } } }
  const contacts = [{ pub: bob.publicKey, alias: 'Bob' }]
  const controls = await event(bob, alice.publicKey, 'receipt', { targetId: old.id, receipt: 'read' }, { timestamp: deletedAt + 1 })
  const hidden = messaging.buildMessagingModel([record(old, alice), record(controls, alice)], alice.publicKey, contacts, p)
  assert.equal(hidden.conversations.some(c => c.id === bob.publicKey), false)
  assert.deepEqual(hidden.messages, [])
  const fresh = await event(bob, alice.publicKey, 'message', { content: 'Fresh conversation' }, { timestamp: deletedAt + 2 })
  const reopened = messaging.buildMessagingModel([record(old, alice), record(controls, alice), record(fresh, alice)], alice.publicKey, contacts, p)
  assert.deepEqual(reopened.messages.map(m => m.id), [fresh.id])
  assert.equal(reopened.conversations.find(c => c.id === bob.publicKey).name, 'Bob')
  assert.deepEqual(contacts, [{ pub: bob.publicKey, alias: 'Bob' }])
})

test('deleted group checkpoints preserve departures and prevent administrator substitution', async () => {
  const [alice, bob, mallory] = await Promise.all([identity(), identity(), identity()])
  const g = await group(alice, [alice, bob]), deletedAt = Date.now()
  const p = { ...defaultMessagingPreferences(), deleted: { [g.id]: { deletedAt, eventKeys: [], group: g, leftMembers: [bob.publicKey] } } }
  const after = await event(alice, g, 'message', { content: 'After Bob left' }, { timestamp: deletedAt + 1 })
  const hijack = await group(mallory, [mallory, bob], { id: g.id, epoch: 99 })
  const forged = await event(mallory, hijack, 'message', { content: 'Wrong administrator' }, { timestamp: deletedAt + 2 })
  const state = model([after, forged], bob, p)
  assert.deepEqual(state.messages, [])
  assert.equal(state.conversations.some(c => c.id === g.id), false)
  assert.equal(state.groups.find(group => group.id === g.id).admin, alice.publicKey)
  const rejoined = await group(alice, [alice, bob], { id: g.id, epoch: 2, updatedAt: deletedAt + 3 })
  const welcome = await event(alice, rejoined, 'message', { content: 'Welcome back' }, { timestamp: deletedAt + 4 })
  const restored = model([after, forged, welcome], bob, p)
  assert.deepEqual(restored.messages.map(m => m.id), [welcome.id])
  assert.ok(restored.conversations.find(c => c.id === g.id).members.includes(bob.publicKey))
})
