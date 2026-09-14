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
  const mod = { exports: {} }; cache.set(filename, mod)
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('require', 'module', 'exports', output)(name => name === 'idb' ? {} : name.startsWith('@/') ? load(path.join(root, name.slice(2))) : name.startsWith('.') ? load(path.resolve(path.dirname(filename), name)) : require(name), mod, mod.exports)
  return mod.exports
}
const access = load(path.join(root, 'lib/call-room-access.ts'))
const protocol = load(path.join(root, 'lib/community-protocol.ts'))
const cryptography = load(path.join(root, 'lib/crypto.ts'))
const self = '04' + '1'.repeat(128), peer = '04' + '2'.repeat(128)
const group = { id: `group:${crypto.randomUUID()}`, admin: self, name: 'Friends', members: [self, peer], epoch: 1, updatedAt: Date.now(), signature: '1'.repeat(128) }
function messaging(changes = {}) {
  return { identity: { publicKey: self }, preferences: { blocked: [] }, conversations: [{ id: group.id, kind: 'group', members: group.members, group }], ...changes }
}
test('group room access requires current effective membership and the original signing authority', () => {
  const target = { kind: 'group', group }
  assert.equal(access.currentCallRoomTarget(target, messaging(), []).group, group)
  for (const changes of [{ members: [peer] }, { request: true }, { blocked: true }, { group: { ...group, admin: peer } }, { members: [self] }]) {
    const current = messaging()
    Object.assign(current.conversations[0], changes)
    assert.equal(access.currentCallRoomTarget(target, current, []), null)
  }
  assert.equal(access.currentCallRoomTarget(target, messaging({ conversations: [] }), []), null)
})
test('voice access stops on local leave, deletion, kind changes, bans, and moderator restrictions', () => {
  const channelId = crypto.randomUUID()
  const community = { id: `community:${self}:${crypto.randomUUID()}`, owner: peer, members: [self, peer], moderators: [], bans: [],
    channels: [{ id: channelId, name: 'Voice', posting: 'members', kind: 'voice' }], joined: true, effectiveMembers: [self, peer] }
  const target = { kind: 'channel', community, channelId }
  assert.ok(access.currentCallRoomTarget(target, messaging(), [community]))
  for (const change of [{ joined: false }, { effectiveMembers: [peer] }, { deleted: true }, { bans: [self] },
    { channels: [{ ...community.channels[0], kind: 'text' }] }, { channels: [{ ...community.channels[0], posting: 'moderators' }] }]) {
    assert.equal(access.currentCallRoomTarget(target, messaging(), [{ ...community, ...change }]), null)
  }
  assert.ok(access.currentCallRoomTarget(target, messaging(), [{ ...community, moderators: [self], channels: [{ ...community.channels[0], posting: 'moderators' }] }]))
})

test('latest room proof publishes channel deletion and restrictions after join eligibility is revoked', () => {
  const channelId = crypto.randomUUID()
  const state = { id: `community:${peer}:${crypto.randomUUID()}`, owner: peer, name: 'Club', description: '', epoch: 1, updatedAt: Date.now(),
    version: 2, signer: peer, coOwners: [], transfers: [], deleted: false,
    members: [self, peer], moderators: [], bans: [], admission: 'direct', joiningPaused: false, inviteGeneration: 1, signature: '1'.repeat(128),
    channels: [{ id: channelId, name: 'Lounge', posting: 'members', kind: 'voice' }], joined: true, effectiveMembers: [self, peer] }
  const target = { kind: 'channel', community: state, channelId }
  for (const change of [{ deleted: true, joined: false }, { channels: [] }, { channels: [{ ...state.channels[0], posting: 'moderators' }] }, { effectiveMembers: [peer] }]) {
    const current = { ...state, ...change, epoch: 2, signature: '2'.repeat(128) }
    assert.equal(access.currentCallRoomTarget(target, messaging(), [current]), null)
    const proof = access.latestCallRoomProof(target, messaging(), [current])
    assert.equal(proof.community.signature, current.signature)
    assert.equal(proof.community.deleted, current.deleted)
    assert.equal(proof.channelId, channelId, 'retain the old room key even after its channel is deleted')
    assert.equal(Object.hasOwn(proof.community, 'joined'), false)
    assert.equal(Object.hasOwn(proof.community, 'effectiveMembers'), false)
  }
  assert.equal(access.latestCallRoomProof(target, messaging(), []), null)
  assert.equal(access.latestCallRoomProof(target, messaging(), [{ ...state, members: [peer] }]), null)
  assert.ok(access.latestCallRoomProof(target, messaging(), [{ ...state, members: [peer], signer: self }]))
  assert.equal(access.latestCallRoomProof(target, messaging({ identity: null }), [state]), null)
})

test('latest group proof follows signed membership while preserving the original group authority', () => {
  const target = { kind: 'group', group }
  const current = messaging()
  current.conversations[0] = { ...current.conversations[0], blocked: true, request: true, members: [], group: { ...group, epoch: 2 } }
  assert.equal(access.currentCallRoomTarget(target, current, []), null)
  assert.equal(access.latestCallRoomProof(target, current, []).group.epoch, 2)
  current.conversations[0].group = { ...group, admin: peer, epoch: 3 }
  assert.equal(access.latestCallRoomProof(target, current, []), null)
  assert.equal(access.latestCallRoomProof(target, messaging({ conversations: [] }), []), null)
  const memberTarget = { kind: 'group', group: { ...group, admin: peer } }
  current.conversations[0].group = { ...memberTarget.group, members: [peer], epoch: 2 }
  assert.equal(access.latestCallRoomProof(memberTarget, current, []), null)
})
test('derived community display metadata never alters or enters its signed room proof', async () => {
  const pair = await cryptography.generateEncryptionKeyPair()
  const owner = { version: 2, publicKey: await cryptography.exportPublicKeyToHex(pair.publicKey), privateKey: await cryptography.exportKey(pair.privateKey) }
  const state = await protocol.signCommunityState({ id: `community:${owner.publicKey}:${crypto.randomUUID()}`, owner: owner.publicKey, name: 'Club', description: '',
    members: [owner.publicKey], moderators: [], bans: [], epoch: 1, updatedAt: Date.now(), channels: [{ id: crypto.randomUUID(), name: 'Lounge', kind: 'voice', posting: 'members' }],
    admission: 'direct', joiningPaused: false, inviteGeneration: 1, version: 2, coOwners: [], transfers: [], signer: owner.publicKey, deleted: false }, owner)
  const record = { ...state, joined: true, effectiveMembers: state.members, unreadCount: 7, channelUnread: {}, notificationMode: 'all', lastMessage: { content: 'private text' } }
  const proof = access.signedCommunityState(record)
  assert.deepEqual(proof, state)
  assert.equal(await protocol.validateCommunityState(proof), true)
  assert.equal(JSON.stringify(proof).includes('private text'), false)
})
