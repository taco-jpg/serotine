const assert = require('node:assert/strict')
const { test } = require('node:test')
const path = require('node:path')
const { harness, root } = require('./support/lifecycle-harness.cjs')

test('offline sync learns terminal spaces after encrypted events are purged; direct boundaries are participant-only and survive reaccept', async t => {
  const h = harness(t), actions = h.load(path.join(root, 'app/actions.ts'))
  const protocol = h.load(path.join(root, 'lib/retention-protocol.ts'))
  const server = h.load(path.join(root, 'lib/retention-server.ts'))
  const alice = await h.identity(), bob = await h.identity(), stranger = await h.identity()
  const sync = async (who, retentionScopes) => {
    const data = { retentionScopes }
    return actions.getEventFeed(data, (await h.signed(who, 'event:sync', data)).proof)
  }
  await sync(alice, []) // initialize server schema
  const community = protocol.retentionDescriptor(`community:${alice.publicKey}:${crypto.randomUUID()}`, alice.publicKey, h.state.now)
  const group = { kind: 'group', founder: alice.publicKey, key: crypto.randomUUID(), timestamp: h.state.now }
  const direct = protocol.retentionDescriptor(bob.publicKey, alice.publicKey, h.state.now)
  const hashes = []
  for (const scope of [community, group, direct]) hashes.push(await server.registerRetention(h.db, scope, alice.publicKey, bob.publicKey))
  await server.closeRetentionScope(h.db, hashes[0])
  await server.closeRetentionScope(h.db, hashes[2])
  h.sqlite.prepare('INSERT INTO GroupAuthority(groupId,admin,terminalAt,createdAt) VALUES(?,?,?,?)').run(`group:${group.key}`, alice.publicKey, h.state.now, h.state.now)
  const member = await sync(bob, hashes)
  assert.equal(member.success, true)
  assert.deepEqual(member.messages, [])
  assert.deepEqual(member.closedScopes.sort(), hashes.slice(0, 2).sort())
  assert.deepEqual(member.relationshipBoundaries, [{ scopeId: hashes[2], boundaryAt: h.state.now }])
  assert.deepEqual((await sync(stranger, hashes)).relationshipBoundaries, [])
  assert.deepEqual((await sync(bob, ['f'.repeat(64)])).closedScopes, [])
  h.state.now += 10
  for (const who of [alice, bob]) {
    const data = { scope: { ...direct, timestamp: h.state.now } }
    assert.equal((await server.handleRetention('retention:accept', data, (await h.signed(who, 'retention:accept', data)).proof)).success, true)
  }
  assert.deepEqual((await sync(bob, [hashes[2]])).relationshipBoundaries, [{ scopeId: hashes[2], boundaryAt: h.state.now }])
  assert.equal((await sync(bob, Array(101).fill(hashes[0]))).success, false)
  assert.equal((await sync(bob, [hashes[0], hashes[0]])).success, false)
  const data = { retentionScopes: [hashes[0]] }, proof = (await h.signed(bob, 'event:sync', data)).proof
  assert.equal((await actions.getEventFeed({ retentionScopes: [hashes[1]] }, proof)).success, false)
})
