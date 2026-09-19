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
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const requireSource = name => name === 'idb' ? {} : name.startsWith('@/') ? load(path.join(root, name.slice(2))) : name.startsWith('.') ? load(path.resolve(path.dirname(filename), name)) : require(name)
  new Function('require', 'module', 'exports', output)(requireSource, module, module.exports)
  return module.exports
}
const cryptoHelpers = load(path.join(root, 'lib/crypto.ts'))
const protocol = load(path.join(root, 'lib/community-protocol.ts'))
const { defaultMessagingPreferences } = load(path.join(root, 'lib/messaging-store.ts'))
async function identity() {
  const pair = await cryptoHelpers.generateEncryptionKeyPair()
  return { version: 2, privateKey: await cryptoHelpers.exportKey(pair.privateKey), publicKey: await cryptoHelpers.exportPublicKeyToHex(pair.publicKey) }
}
async function state(owner, members, extra = {}) {
  return protocol.signCommunityState({ id: `community:${owner.publicKey}:${crypto.randomUUID()}`, owner: owner.publicKey, name: 'Math club', description: 'Study together',
    epoch: 1, updatedAt: Date.now() - 1000, members: members.map(x => x.publicKey), moderators: [], bans: [], admission: 'approval', joiningPaused: false, inviteGeneration: 1,
    channels: [{ id: crypto.randomUUID(), name: 'general', posting: 'members' }, { id: crypto.randomUUID(), name: 'announcements', posting: 'moderators' }], ...extra }, owner)
}
async function next(owner, prior, extra) {
  const unsigned = { ...prior }
  delete unsigned.signature
  return protocol.signCommunityState({ ...unsigned, epoch: prior.epoch + 1, updatedAt: prior.updatedAt + 1, ...extra }, owner)
}
async function invite(owner, s, extra = {}) {
  return protocol.signCommunityInvite({ version: 1, communityId: s.id, owner: owner.publicKey, name: s.name, description: s.description, admission: s.admission, history: 'after-join',
    inviteGeneration: s.inviteGeneration, token: crypto.randomUUID(), expiresAt: Date.now() + 60000, ...extra }, owner)
}
function event(author, s, data, recipients) {
  const peers = s.members.filter(x => x !== author.publicKey)
  return { version: 3, id: crypto.randomUUID(), author: author.publicKey, conversationId: s.id, recipients: recipients ?? (peers.length ? peers : [author.publicKey]), timestamp: Date.now(),
    kind: 'community', payload: { community: data }, signature: '0'.repeat(128) }
}
function stateEvent(author, s, data = {}, recipients) { return event(author, s, { type: 'state', state: s, ...data }, recipients) }
function message(author, s, content, channelId = s.channels[0].id) { return event(author, s, { type: 'message', epoch: s.epoch, channelId, content }) }
function records(events, owner) { return events.map((e, index) => ({ event: e, key: `${e.author}:${e.conversationId}:${e.id}`, local: e.author === owner.publicKey, delivered: [...e.recipients], receivedAt: 1000 + index, sequence: index + 1 })) }
function model(events, owner, prefs = defaultMessagingPreferences()) { return protocol.buildCommunityModel(records(events, owner), owner.publicKey, prefs) }

test('signed state anchors owner, bounds metadata, and rejects tampering and owner substitution', async () => {
  const [alice, bob] = await Promise.all([identity(), identity()])
  const s = await state(alice, [alice, bob])
  assert.equal(protocol.communityOwner(s.id), alice.publicKey)
  assert.equal(protocol.isCommunityId(s.id + ':other'), false)
  assert.equal(await protocol.validateCommunityState(s), true)
  for (const changed of [{ name: 'Hacked' }, { owner: bob.publicKey }, { members: [alice.publicKey] }, { channels: [{ ...s.channels[0], posting: 'moderators' }] }, { privateKey: 'unexpected' }])
    assert.equal(await protocol.validateCommunityState({ ...s, ...changed }), false)
  await assert.rejects(() => state(alice, [alice, bob], { id: `community:${bob.publicKey}:${crypto.randomUUID()}` }))
  assert.equal(await protocol.validateCommunityEvent(stateEvent(bob, s)), false)
})

test('legacy v1 and v2 channel signatures remain byte compatible and cannot gain an unsigned kind', async () => {
  const alice = await identity()
  for (const version of [1, 2]) {
    const s = await state(alice, [alice], version === 2 ? { version: 2, coOwners: [], transfers: [], signer: alice.publicKey, deleted: false } : {})
    // This independent representation is the deployed pre-voice wire format.
    const fields = [s.id, s.owner, s.name, s.description, s.epoch, s.updatedAt, s.members, s.moderators, s.bans,
      s.channels.map(c => [c.id, c.name, c.posting]), s.admission, s.joiningPaused, s.inviteGeneration]
    const canonical = JSON.stringify(version === 2
      ? ['serotine:community-state:v2', ...fields, s.coOwners, s.transfers, s.signer, s.deleted]
      : ['serotine:community-state:v1', ...fields])
    assert.equal(await cryptoHelpers.verifySignature(canonical, s.signature, alice.publicKey), true)
    const key = await crypto.subtle.importKey('jwk', { ...alice.privateKey, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    const legacy = { ...s, signature: cryptoHelpers.arrayBufferToHex(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(canonical))) }
    assert.equal(await protocol.validateCommunityState(legacy), true)
    assert.equal(protocol.canPostToCommunityChannel(legacy, alice.publicKey, s.channels[0].id), true)
    assert.equal(protocol.canJoinCommunityVoiceChannel(legacy, alice.publicKey, s.channels[0].id), false)
    for (const kind of ['text', 'voice', null, undefined]) {
      assert.equal(await protocol.validateCommunityState({ ...legacy, channels: legacy.channels.map(c => ({ ...c, kind })) }), false)
    }
    const record = { ...legacy, joined: true, effectiveMembers: legacy.members, unreadCount: 0, channelUnread: {}, notificationMode: 'all' }
    const snapshot = protocol.communityStateSnapshot(record)
    assert.deepEqual(snapshot, legacy)
    assert.equal(Object.hasOwn(snapshot.channels[0], 'kind'), false)
    assert.equal(await protocol.validateCommunityState(snapshot), true)
  }
})

test('explicit channel kind is authenticated in both state versions and rejects tampering or malformed kinds', async () => {
  const alice = await identity()
  for (const version of [1, 2]) {
    const channels = [{ id: crypto.randomUUID(), name: 'lounge', posting: 'members', kind: 'voice' }]
    const s = await state(alice, [alice], { channels, ...(version === 2 ? { version: 2, coOwners: [], transfers: [], signer: alice.publicKey, deleted: false } : {}) })
    assert.equal(await protocol.validateCommunityState(s), true)
    for (const kind of ['text', 'video', '', null, undefined]) {
      assert.equal(await protocol.validateCommunityState({ ...s, channels: [{ ...channels[0], kind }] }), false)
    }
    const stripped = { ...channels[0] }; delete stripped.kind
    assert.equal(await protocol.validateCommunityState({ ...s, channels: [stripped] }), false)
    for (const kind of ['video', null, undefined]) {
      await assert.rejects(state(alice, [alice], { channels: [{ ...channels[0], kind }] }), /settings are invalid/)
    }
    const text = await next(alice, s, { channels: [{ ...channels[0], kind: 'text' }] })
    assert.equal(await protocol.validateCommunityState(text), true)
    assert.equal(protocol.canPostToCommunityChannel(text, alice.publicKey, channels[0].id), true)
  }
})

test('voice eligibility enforces current membership, bans, roles and channel type without accepting chat content', async () => {
  const [alice, bob, carol, outsider] = await Promise.all([identity(), identity(), identity(), identity()])
  const voice = { id: crypto.randomUUID(), name: 'lounge', posting: 'members', kind: 'voice' }
  const staff = { id: crypto.randomUUID(), name: 'staff-room', posting: 'moderators', kind: 'voice' }
  const s = await state(alice, [alice, bob, carol], { moderators: [carol.publicKey], channels: [voice, staff] })
  for (const member of [alice, bob, carol]) assert.equal(protocol.canJoinCommunityVoiceChannel(s, member.publicKey, voice.id), true)
  assert.equal(protocol.canJoinCommunityVoiceChannel(s, outsider.publicKey, voice.id), false)
  assert.equal(protocol.canJoinCommunityVoiceChannel(s, bob.publicKey, staff.id), false)
  assert.equal(protocol.canJoinCommunityVoiceChannel(s, alice.publicKey, staff.id), true)
  assert.equal(protocol.canJoinCommunityVoiceChannel(s, carol.publicKey, staff.id), true)
  assert.equal(protocol.canJoinCommunityVoiceChannel({ ...s, bans: [bob.publicKey] }, bob.publicKey, voice.id), false)
  assert.equal(protocol.canJoinCommunityVoiceChannel({ ...s, deleted: true }, alice.publicKey, voice.id), false)
  assert.equal(protocol.canPostToCommunityChannel(s, alice.publicKey, voice.id), false)
  assert.equal(protocol.canJoinCommunityVoiceChannel(s, alice.publicKey, crypto.randomUUID()), false)
  const result = model([stateEvent(alice, s), message(bob, s, 'Must not become voice history', voice.id)], bob)
  assert.deepEqual(result.messages, [])
})

test('voice channels survive ownership transfer while their kind stays bound to the exact handoff', async () => {
  const [alice, bob] = await Promise.all([identity(), identity()])
  const s = await state(alice, [alice, bob], { version: 2, coOwners: [], transfers: [], signer: alice.publicKey, deleted: false,
    channels: [{ id: crypto.randomUUID(), name: 'lounge', posting: 'members', kind: 'voice' }] })
  const handoff = await protocol.signCommunityTransfer({ ...s, epoch: s.epoch + 1, updatedAt: s.updatedAt + 1 }, bob.publicKey, alice)
  assert.equal(await protocol.validateCommunityState(handoff), true)
  assert.equal(handoff.channels[0].kind, 'voice')
  assert.equal(await protocol.validateCommunityState({ ...handoff, channels: [{ ...handoff.channels[0], kind: 'text' }] }), false)
  const successor = await next(bob, handoff, { name: 'New owner, same voice room' })
  assert.equal(await protocol.validateCommunityState(successor), true)
  assert.equal(protocol.canJoinCommunityVoiceChannel(successor, bob.publicKey, successor.channels[0].id), true)
})

test('invitation URL and QR payload preserve signed Unicode preview; tampering and expiry fail', async () => {
  const alice = await identity(), s = await state(alice, [alice], { name: '数学 club 🦇' })
  const i = await invite(alice, s), url = protocol.buildCommunityInviteUrl(i, 'https://example.test')
  assert.equal(new URL(url).pathname, '/chat/communities')
  assert.equal(new URL(url).search, '')
  assert.deepEqual(await protocol.parseCommunityInvite(url), i)
  assert.deepEqual(await protocol.parseCommunityInvite(new URLSearchParams(new URL(url).hash.slice(1)).get('community')), i)
  assert.equal(await protocol.validateCommunityInvite({ ...i, admission: 'direct' }), false)
  assert.equal(await protocol.validateCommunityInvite(i, i.expiresAt), false)
  assert.equal(await protocol.validateCommunityInvite(i, 0), true)
  await assert.rejects(() => protocol.parseCommunityInvite(url, i.expiresAt))
})

test('join request does not grant membership; owner acknowledgement admits with future history only', async () => {
  const [alice, bob] = await Promise.all([identity(), identity()])
  const initial = await state(alice, [alice]), invitation = await invite(alice, initial)
  const join = event(bob, initial, { type: 'join', invite: invitation }, [alice.publicKey])
  assert.equal(await protocol.validateCommunityEvent(join), true)
  assert.equal(model([join], bob).communities.length, 0)
  assert.equal(model([join], bob).requests[0].status, 'pending')
  const admitted = await next(alice, initial, { members: [alice.publicKey, bob.publicKey] })
  const stale = message(alice, initial, 'before admission')
  stale.recipients = [bob.publicKey]
  const history = [join, stale, stateEvent(alice, admitted, { requestId: join.id }), message(alice, admitted, 'after admission')]
  const result = model(history, bob)
  assert.equal(result.communities[0].joined, true)
  assert.equal(result.requests[0].status, 'approved')
  assert.deepEqual(result.messages.map(m => m.content), ['after admission'])
})

test('member messages cannot bootstrap state; rollback and equal-epoch forks do not replace state', async () => {
  const [alice, bob] = await Promise.all([identity(), identity()])
  const s = await state(alice, [alice, bob]), content = message(bob, s, 'no bootstrap')
  assert.equal(model([content], alice).messages.length, 0)
  const newer = await next(alice, s, { name: 'New name' })
  const fork = await next(alice, s, { name: 'Conflicting name' })
  const result = model([stateEvent(alice, s), stateEvent(alice, newer), stateEvent(alice, fork), stateEvent(alice, s)], bob)
  assert.equal(result.communities[0].name, 'New name')
})

test('announcement permissions and moderator hiding are enforced by reducer', async () => {
  const [alice, bob, carol] = await Promise.all([identity(), identity(), identity()])
  const s = await state(alice, [alice, bob, carol], { moderators: [carol.publicKey] })
  const forbidden = message(bob, s, 'forbidden', s.channels[1].id), permitted = message(carol, s, 'announcement', s.channels[1].id)
  const normal = message(bob, s, 'reported')
  const badHide = event(bob, s, { type: 'hide', epoch: 1, channelId: s.channels[1].id, targetId: permitted.id })
  const hide = event(carol, s, { type: 'hide', epoch: 1, channelId: s.channels[0].id, targetId: normal.id })
  const result = model([stateEvent(alice, s), forbidden, permitted, normal, badHide, hide], alice)
  assert.deepEqual(result.messages.map(m => [m.content, m.hidden]).sort((a, b) => a[0].localeCompare(b[0])), [['announcement', false], ['reported', true]])
})

test('removal and moderator demotion reject stale messages, controls and pending encrypted sends', async () => {
  const [alice, bob, carol] = await Promise.all([identity(), identity(), identity()])
  const s = await state(alice, [alice, bob, carol], { moderators: [bob.publicKey] })
  const original = message(carol, s, 'retained')
  const removed = await next(alice, s, { members: [alice.publicKey, carol.publicKey], moderators: [] })
  const update = stateEvent(alice, removed, {}, [bob.publicKey, carol.publicKey])
  const stale = message(bob, s, 'stale'), hide = event(bob, s, { type: 'hide', epoch: 1, channelId: s.channels[0].id, targetId: original.id })
  const result = model([stateEvent(alice, s), original, update, stale, hide], carol)
  assert.deepEqual(result.messages.map(m => [m.content, m.hidden]), [['retained', false]])
  assert.equal(protocol.canSendCommunityEvent(stale, result, bob.publicKey), false)
  const pending = message(carol, s, 'pending old recipient list')
  assert.equal(protocol.canSendCommunityEvent(pending, result, carol.publicKey), false)
  assert.equal(model([stateEvent(alice, s), update], bob).communities[0].joined, false)
})

test('leave blocks future delivery until owner state update; the leave notice itself remains sendable', async () => {
  const [alice, bob, carol] = await Promise.all([identity(), identity(), identity()])
  const s = await state(alice, [alice, bob, carol])
  const leave = event(bob, s, { type: 'leave', epoch: s.epoch })
  const remaining = model([stateEvent(alice, s), leave], alice)
  assert.deepEqual(remaining.communities[0].effectiveMembers, [alice.publicKey, carol.publicKey])
  assert.equal(protocol.canSendCommunityEvent(message(alice, s, 'must wait'), remaining, alice.publicKey), false)
  const leaver = model([stateEvent(alice, s), leave], bob)
  assert.equal(leaver.communities[0].joined, false)
  assert.equal(protocol.canSendCommunityEvent(leave, leaver, bob.publicKey), true)
  assert.equal(remaining.commands[0].action, 'leave')
})

test('reports go only to current moderators and owner; member commands cannot remove others', async () => {
  const [alice, bob, carol] = await Promise.all([identity(), identity(), identity()])
  const s = await state(alice, [alice, bob, carol], { moderators: [carol.publicKey] })
  const original = message(alice, s, 'target')
  const reportData = { type: 'report', epoch: 1, channelId: s.channels[0].id, targetId: original.id, reason: 'Please review' }
  const report = event(bob, s, reportData, [alice.publicKey, carol.publicKey])
  const wrongAudience = event(bob, s, reportData, [alice.publicKey])
  const command = event(bob, s, { type: 'command', epoch: 1, action: 'ban', target: carol.publicKey }, [alice.publicKey])
  const result = model([stateEvent(alice, s), original, report, wrongAudience, command], alice)
  assert.equal(result.reports.length, 1)
  assert.equal(result.commands.length, 0)
})

test('channel unread counts are independent and hidden messages do not add unread counts', async () => {
  const [alice, bob] = await Promise.all([identity(), identity()])
  const s = await state(alice, [alice, bob]), one = message(alice, s, 'general'), two = message(alice, s, 'notice', s.channels[1].id)
  const prefs = defaultMessagingPreferences()
  prefs.readAt[protocol.communityChannelKey(s.id, s.channels[0].id)] = one.timestamp
  const result = model([stateEvent(alice, s), one, two], bob, prefs)
  assert.equal(result.communities[0].channelUnread[s.channels[0].id], 0)
  assert.equal(result.communities[0].channelUnread[s.channels[1].id], 1)
  assert.equal(protocol.isCommunityChannelKey(protocol.communityChannelKey(s.id, s.channels[0].id)), true)
})

test('owner refusal can arrive before a locally synchronized join without losing resolution', async () => {
  const [alice, bob] = await Promise.all([identity(), identity()])
  const s = await state(alice, [alice]), i = await invite(alice, s)
  const join = event(bob, s, { type: 'join', invite: i }, [alice.publicKey])
  const refusal = event(alice, s, { type: 'decision', requestId: join.id, applicant: bob.publicKey, status: 'rejected', reason: 'Revoked invitation' }, [bob.publicKey])
  assert.equal(await protocol.validateCommunityEvent(refusal), true)
  const result = model([refusal, join], bob)
  assert.equal(result.requests[0].status, 'rejected')
  assert.equal(result.requests[0].reason, 'Revoked invitation')
})

test('removal does not turn a resolved admission back into a pending request, even with reordered local sync', async () => {
  const [alice, bob] = await Promise.all([identity(), identity()])
  const s = await state(alice, [alice]), i = await invite(alice, s)
  const join = event(bob, s, { type: 'join', invite: i }, [alice.publicKey])
  const admitted = await next(alice, s, { members: [alice.publicKey, bob.publicKey] })
  const removed = await next(alice, admitted, { members: [alice.publicKey] })
  const accepted = stateEvent(alice, admitted, { requestId: join.id })
  const removal = stateEvent(alice, removed, {}, [bob.publicKey])
  for (const history of [[join, accepted, removal], [accepted, removal, join], [removal, accepted, join]]) {
    const result = model(history, bob)
    assert.equal(result.requests[0].status, 'approved')
    assert.equal(result.communities[0].joined, false)
    assert.equal(result.requests.some(r => r.status === 'pending'), false, 'a fresh join request can now be created')
  }
})

test('future-epoch content waits for owner state across relay reordering without accepting prejoin history', async () => {
  const [alice, bob] = await Promise.all([identity(), identity()])
  const initial = await state(alice, [alice])
  const admitted = await next(alice, initial, { members: [alice.publicKey, bob.publicKey] })
  const historical = message(alice, initial, 'before joining')
  historical.recipients = [bob.publicKey]
  const after = message(alice, admitted, 'after joining')
  assert.equal(model([historical, after], bob).messages.length, 0, 'owner state is required')
  const result = model([historical, after, stateEvent(alice, admitted)], bob)
  assert.deepEqual(result.messages.map(m => m.content), ['after joining'])
  assert.equal(result.communities[0].joined, true)
})

test('future controls replay with their matching state but obsolete pending epochs never bypass a later removal', async () => {
  const [alice, bob, carol] = await Promise.all([identity(), identity(), identity()])
  const initial = await state(alice, [alice, bob, carol])
  const promoted = await next(alice, initial, { moderators: [bob.publicKey] })
  const target = message(carol, initial, 'moderated')
  const hide = event(bob, promoted, { type: 'hide', epoch: promoted.epoch, channelId: promoted.channels[0].id, targetId: target.id })
  const valid = model([stateEvent(alice, initial), target, hide, stateEvent(alice, promoted)], carol)
  assert.equal(valid.messages[0].hidden, true)
  const removed = await next(alice, promoted, { members: [alice.publicKey, carol.publicKey], moderators: [] })
  const removal = stateEvent(alice, removed, {}, [bob.publicKey, carol.publicKey])
  const invalid = model([stateEvent(alice, initial), target, hide, removal, stateEvent(alice, promoted)], carol)
  assert.equal(invalid.messages[0].hidden, false)
  assert.equal(invalid.communities[0].epoch, removed.epoch)
})

test('blocking a member never suppresses authenticated leave and blocking owner does not suppress refusal', async () => {
  const [alice, bob] = await Promise.all([identity(), identity()])
  const s = await state(alice, [alice, bob])
  const prefs = defaultMessagingPreferences(); prefs.blocked = [bob.publicKey]
  const leave = event(bob, s, { type: 'leave', epoch: s.epoch })
  const result = model([stateEvent(alice, s), message(bob, s, 'blocked content'), leave], alice, prefs)
  assert.equal(result.messages.length, 0)
  assert.deepEqual(result.communities[0].effectiveMembers, [alice.publicKey])
  assert.equal(result.commands[0].action, 'leave')
  const i = await invite(alice, s), join = event(bob, s, { type: 'join', invite: i }, [alice.publicKey])
  const rejection = event(alice, s, { type: 'decision', requestId: join.id, applicant: bob.publicKey, status: 'rejected' }, [bob.publicKey])
  const blockedOwner = defaultMessagingPreferences(); blockedOwner.blocked = [alice.publicKey]
  assert.equal(model([join, rejection], bob, blockedOwner).requests[0].status, 'rejected')
})


test('community inbox activity uses eligible messages or initial state, never settings or channel navigation', async () => {
  const [alice, bob] = await Promise.all([identity(), identity()])
  const initial = await state(alice, [alice, bob], { updatedAt: Date.now() - 30000 })
  const changed = await next(alice, initial, { name: 'Renamed community', updatedAt: Date.now() - 10000 })
  const created = stateEvent(alice, initial), settings = stateEvent(alice, changed)
  const empty = model([created, settings], alice).communities[0]
  assert.equal(empty.activityAt, initial.updatedAt)
  assert.equal(empty.updatedAt, changed.updatedAt, 'signed state timestamp remains untouched')
  const sent = message(bob, changed, 'Latest actual conversation activity')
  sent.timestamp = Date.now() - 5000
  const read = { ...defaultMessagingPreferences(), readAt: { [protocol.communityChannelKey(initial.id, initial.channels[0].id)]: Date.now() }, notifications: { [initial.id]: 'muted' }, archived: [initial.id] }
  assert.equal(model([created, settings, sent], alice, read).communities[0].activityAt, sent.timestamp)
  const rename = await next(alice, changed, { name: 'Another name', updatedAt: Date.now() })
  assert.equal(model([created, settings, sent, stateEvent(alice, rename)], alice, read).communities[0].activityAt, sent.timestamp)
})
