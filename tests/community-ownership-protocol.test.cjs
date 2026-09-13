const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')
const root = path.join(__dirname, '..'), cache = new Map()
function load(filename) {
  if (!path.extname(filename)) filename += '.ts'
  if (cache.has(filename)) return cache.get(filename).exports
  const module = { exports: {} }; cache.set(filename, module)
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const localRequire = name => name === 'idb' ? {} : name.startsWith('.') ? load(path.resolve(path.dirname(filename), name)) : require(name)
  new Function('require', 'module', 'exports', output)(localRequire, module, module.exports)
  return module.exports
}
const cryptoHelpers = load(path.join(root, 'lib/crypto.ts')), p = load(path.join(root, 'lib/community-protocol.ts'))
const { defaultMessagingPreferences } = load(path.join(root, 'lib/messaging-store.ts'))
async function identity() {
  const pair = await cryptoHelpers.generateEncryptionKeyPair()
  return { version: 2, privateKey: await cryptoHelpers.exportKey(pair.privateKey), publicKey: await cryptoHelpers.exportPublicKeyToHex(pair.publicKey) }
}
async function initial(owner, members, extra = {}) {
  return p.signCommunityState({ version: 2, id: `community:${owner.publicKey}:${crypto.randomUUID()}`, owner: owner.publicKey, signer: owner.publicKey,
    coOwners: [], transfers: [], deleted: false, name: '数学 club', description: 'Work together', epoch: 1, updatedAt: Date.now() - 1000,
    members: members.map(x => x.publicKey), moderators: [], bans: [], admission: 'approval', joiningPaused: false, inviteGeneration: 1,
    channels: [{ id: crypto.randomUUID(), name: 'general', posting: 'members' }], ...extra }, owner)
}
const advance = s => ({ ...s, epoch: s.epoch + 1, updatedAt: s.updatedAt + 1 })
function event(author, s, data, recipients) {
  const peers = s.members.filter(x => x !== author.publicKey)
  return { version: 3, id: crypto.randomUUID(), author: author.publicKey, conversationId: s.id, recipients: recipients ?? (peers.length ? peers : [author.publicKey]),
    timestamp: Date.now(), kind: 'community', payload: { community: data }, signature: '0'.repeat(128) }
}
const stateEvent = (author, s) => event(author, s, { type: 'state', state: s })
const content = (author, s) => event(author, s, { type: 'message', epoch: s.epoch, stateRef: s.signature, channelId: s.channels[0].id, content: 'Bound to the correct state' })
function model(events, owner) {
  return p.buildCommunityModel(events.map((e, i) => ({ key: `${e.author}:${e.id}`, event: e, receivedAt: i + 1, local: e.author === owner.publicKey, delivered: e.recipients })), owner.publicKey, defaultMessagingPreferences())
}
async function invitation(owner, state) {
  return p.signCommunityInvite({ version: 2, communityId: state.id, owner: owner.publicKey, transfers: state.transfers,
    name: state.name, description: state.description, admission: state.admission, history: 'after-join', inviteGeneration: state.inviteGeneration,
    token: crypto.randomUUID(), expiresAt: Date.now() + 60000 }, owner)
}
async function maliciousResign(state, identity) {
  const fields = [state.id, state.owner, state.name, state.description, state.epoch, state.updatedAt, state.members, state.moderators, state.bans,
    state.channels.map(c => [c.id, c.name, c.posting]), state.admission, state.joiningPaused, state.inviteGeneration]
  const key = await crypto.subtle.importKey('jwk', { ...identity.privateKey, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const payload = JSON.stringify(['serotine:community-state:v2', ...fields, state.coOwners, state.transfers, state.signer, state.deleted])
  return { ...state, signature: cryptoHelpers.arrayBufferToHex(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(payload))) }
}

test('transfer proof authorizes only its exact handoff; former owners and coowners cannot sign arbitrary successor state', async () => {
  const [alice, bob, carol] = await Promise.all([identity(), identity(), identity()])
  const s = await initial(alice, [alice, bob, carol], { coOwners: [carol.publicKey] })
  const handoff = await p.signCommunityTransfer(advance(s), bob.publicKey, alice)
  assert.equal(handoff.id, s.id)
  assert.equal(await p.validateCommunityEvent(stateEvent(alice, handoff)), true)
  const successor = await p.signCommunityState({ ...advance(handoff), name: 'New primary' }, bob)
  assert.equal(await p.validateCommunityState(successor), true)
  for (const changes of [{ name: 'Former owner overwrite' }, { epoch: handoff.epoch + 1 }, { coOwners: [alice.publicKey] }]) {
    const forged = await maliciousResign({ ...handoff, ...changes }, alice)
    assert.equal(await p.validateCommunityState(forged), false, 'even a real outgoing-primary signature must match the certified handoff')
  }
  const coownerForgery = await maliciousResign({ ...successor, signer: carol.publicKey }, carol)
  assert.equal(await p.validateCommunityState(coownerForgery), false)
  assert.equal(await p.validateCommunityState({ ...successor, transfers: [{ ...handoff.transfers[0], to: carol.publicKey }] }), false)
  await assert.rejects(p.signCommunityTransfer(advance(successor), alice.publicKey, alice), /Only the primary owner/)
})

test('compact invites retain root proof through two transfers and remain encodable as QR', async () => {
  const [alice, bob, carol] = await Promise.all([identity(), identity(), identity()])
  const s = await initial(alice, [alice, bob, carol])
  const first = await p.signCommunityTransfer(advance(s), bob.publicKey, alice)
  const second = await p.signCommunityTransfer(advance(first), carol.publicKey, bob)
  const invite = await invitation(carol, second), url = p.buildCommunityInviteUrl(invite, 'https://example.test')
  assert.deepEqual(await p.parseCommunityInvite(url), invite)
  assert.ok(url.length < 1800, `two-transfer invitation should fit QR capacity: ${url.length} chars`)
  assert.doesNotThrow(() => require('qrcode').create(url, { errorCorrectionLevel: 'M' }))
  assert.equal(Object.hasOwn(invite, 'members'), false)
  const copiedProof = { ...invite, communityId: `community:${bob.publicKey}:${crypto.randomUUID()}` }
  assert.equal(await p.validateCommunityInvite(copiedProof), false)
})

test('authority upgrades supersede stale high epochs and v2 controls need their exact state reference', async () => {
  const [alice, bob, carol] = await Promise.all([identity(), identity(), identity()])
  const s = await initial(alice, [alice, bob, carol], { coOwners: [carol.publicKey] })
  const handoff = await p.signCommunityTransfer(advance(s), bob.publicKey, alice)
  const staleOwner = await p.signCommunityState({ ...s, epoch: 999 }, alice)
  const after = content(carol, handoff)
  const result = model([stateEvent(alice, s), stateEvent(alice, staleOwner), after, stateEvent(alice, handoff), stateEvent(alice, staleOwner)], bob)
  assert.equal(result.communities[0].owner, bob.publicKey)
  assert.equal(result.messages.length, 1, 'future authority messages defer and replay with their certified handoff')
  const stale = content(carol, s), noRef = content(carol, handoff)
  delete noRef.payload.community.stateRef
  const blocked = model([stateEvent(alice, handoff), stale, noRef], bob)
  assert.equal(blocked.messages.length, 0)
  const forbidden = event(carol, handoff, { type: 'command', epoch: handoff.epoch, stateRef: handoff.signature, action: 'update', target: carol.publicKey, changes: { owner: carol.publicKey } }, [bob.publicKey])
  assert.equal(await p.validateCommunityEvent(forbidden), false)
})

test('deleted communities reject later signed resurrections and cancel content while sending the tombstone', async () => {
  const [alice, bob] = await Promise.all([identity(), identity()])
  const s = await initial(alice, [alice, bob]), pending = content(alice, s)
  const deleted = await p.signCommunityState({ ...advance(s), deleted: true, joiningPaused: true }, alice)
  const tombstone = stateEvent(alice, deleted)
  const resurrection = await p.signCommunityState({ ...s, epoch: 999 }, alice)
  const result = model([stateEvent(alice, s), pending, tombstone, stateEvent(alice, resurrection)], alice)
  assert.equal(result.communities[0].deleted, true)
  assert.equal(result.communities[0].joined, false)
  assert.equal(result.messages.length, 0)
  assert.equal(p.canSendCommunityEvent(pending, result, alice.publicKey), false)
  assert.equal(p.canSendCommunityEvent(tombstone, result, alice.publicKey), true)
  assert.equal(p.canSendCommunityEvent(stateEvent(alice, resurrection), result, alice.publicKey), false)
})

test('handoff preserves queued applicant refusals without allowing former primary to reject successor invitations', async () => {
  const [alice, bob, applicant] = await Promise.all([identity(), identity(), identity()])
  const s = await initial(alice, [alice, bob]), oldInvite = await invitation(alice, s)
  const join = event(applicant, s, { type: 'join', invite: oldInvite }, [alice.publicKey])
  const decline = event(alice, s, { type: 'decision', requestId: join.id, applicant: applicant.publicKey, status: 'rejected', reason: 'Ownership changed', stateRef: s.signature, transfers: s.transfers }, [applicant.publicKey])
  const handoff = await p.signCommunityTransfer(advance(s), bob.publicKey, alice)
  const ownerModel = model([stateEvent(alice, s), join, decline, stateEvent(alice, handoff)], alice)
  assert.equal(p.canSendCommunityEvent(decline, ownerModel, alice.publicKey), true)
  assert.equal(model([decline, join], applicant).requests[0].status, 'rejected')
  const newInvite = await invitation(bob, handoff), newJoin = event(applicant, handoff, { type: 'join', invite: newInvite }, [bob.publicKey])
  const forgedDecision = event(alice, s, { ...decline.payload.community, requestId: newJoin.id }, [applicant.publicKey])
  for (const history of [[forgedDecision, newJoin], [newJoin, forgedDecision]]) assert.equal(model(history, applicant).requests[0].status, 'pending')
})
