const assert = require('node:assert/strict')
const { test } = require('node:test')
const path = require('node:path')
const { harness, root, origin } = require('./support/lifecycle-harness.cjs')

async function setup(t) {
  const h = harness(t)
  const protocol = h.load(path.join(root, 'lib/retention-protocol.ts'))
  const server = h.load(path.join(root, 'lib/retention-server.ts'))
  const route = h.load(path.join(root, 'app/api/retention/route.ts'))
  const actions = h.load(path.join(root, 'app/actions.ts'))
  const alice = await h.identity(), bob = await h.identity(), other = await h.identity()
  async function control(who, action, scope) {
    const body = await h.signed(who, action, { scope })
    return route.POST(new Request(`${origin}/api/retention`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) }))
  }
  async function send(who, recipient, scope, id = crypto.randomUUID()) {
    const data = { id, recipientPubKey: recipient.publicKey, encryptedData: 'opaque-ciphertext-'.repeat(3), retention: scope }
    return actions.storeEncryptedEvent(data, (await h.signed(who, 'event:send', data)).proof)
  }
  async function feed(who) { const data = {}; return actions.getEventFeed(data, (await h.signed(who, 'event:sync', data)).proof) }
  const direct = () => protocol.retentionDescriptor(bob.publicKey, alice.publicKey, h.state.now)
  return { ...h, protocol, server, route, actions, alice, bob, other, control, send, feed, direct }
}

test('either direct participant can close both directions; unrelated identities, unsigned traffic and stale replay cannot purge/reopen', async t => {
  const h = await setup(t), scope = h.direct()
  assert.equal((await h.send(h.alice, h.bob, scope)).success, true)
  assert.equal((await h.send(h.bob, h.alice, scope)).success, true)
  assert.equal((await h.control(h.other, 'retention:close', scope)).status, 403)
  assert.equal((await h.control(h.bob, 'retention:close', scope)).status, 200)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM RelayEvent').get().n, 0)
  assert.deepEqual((await h.feed(h.alice)).messages, [])
  assert.deepEqual((await h.feed(h.bob)).messages, [])
  assert.equal((await h.send(h.alice, h.bob, scope)).success, false)
  assert.equal((await h.control(h.bob, 'retention:close', scope)).status, 200)
  h.state.now += 10
  assert.equal((await (await h.control(h.alice, 'retention:accept', h.direct())).json()).pending, true)
  assert.equal((await h.send(h.alice, h.bob, h.direct())).success, false)
  h.state.now += 10
  assert.equal((await (await h.control(h.bob, 'retention:accept', h.direct())).json()).pending, false)
  assert.equal((await h.send(h.alice, h.bob, scope)).success, false)
  h.state.now += 1
  assert.equal((await h.send(h.alice, h.bob, h.direct())).success, true)
  assert.equal((await h.control(h.bob, 'retention:close', scope)).status, 409)
})

test('bounded purge followed by immediate mutual reaccept hides and reclaims remaining old rows without deleting new traffic', async t => {
  const h = await setup(t), scope = h.direct()
  await h.send(h.alice, h.bob, scope)
  const scopeId = await h.protocol.retentionScopeId(scope)
  for (let index = 0; index < 600; index++) h.sqlite.prepare(`INSERT INTO RelayEvent(id,senderPubKey,recipientPubKey,encryptedData,payloadBytes,createdAt,expiresAt,retentionScope,retentionTimestamp)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(), h.alice.publicKey, h.bob.publicKey, 'old ciphertext', 14, h.state.now, h.state.now + 86400_000, scopeId, h.state.now)
  const closed = await (await h.control(h.alice, 'retention:close', scope)).json()
  assert.equal(closed.removed, 256)
  assert.equal(closed.pending, true)
  assert.deepEqual((await h.feed(h.bob)).messages, [])
  h.state.now += 20
  await h.control(h.alice, 'retention:accept', h.direct())
  await h.control(h.bob, 'retention:accept', h.direct())
  h.state.now += 1
  const newId = crypto.randomUUID()
  await h.send(h.alice, h.bob, h.direct(), newId)
  assert.deepEqual((await h.feed(h.bob)).messages.map(row => row.id), [newId])
  await h.server.maintainRetentionStorage(h.db, h.bucket, h.state.now)
  await h.server.maintainRetentionStorage(h.db, h.bucket, h.state.now)
  assert.deepEqual(h.sqlite.prepare('SELECT id FROM RelayEvent').all().map(row => row.id), [newId])
})

test('group owner terminal authority closes retention; member departure and unrelated owner scopes cannot purge it', async t => {
  const h = await setup(t), key = crypto.randomUUID()
  const scope = { kind: 'group', founder: h.alice.publicKey, key, timestamp: h.state.now }
  await h.send(h.alice, h.bob, scope)
  assert.equal((await h.control(h.bob, 'retention:close', scope)).status, 403)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM RelayEvent').get().n, 1)
  h.sqlite.prepare('INSERT INTO GroupAuthority(groupId,admin,terminalAt,createdAt) VALUES(?,?,?,?)')
    .run(`group:${key}`, h.alice.publicKey, h.state.now, h.state.now - 100)
  assert.equal((await h.send(h.bob, h.alice, scope)).success, false)
  await h.server.maintainRetentionStorage(h.db, h.bucket, h.state.now)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM RelayEvent').get().n, 0)
  assert.equal((await h.control(h.alice, 'retention:accept', scope)).status, 400)
})

test('community transfer checkpoint prevents previous owners and unrelated participants deleting the successor space', async t => {
  const h = await setup(t), c = h.load(path.join(root, 'lib/community-protocol.ts'))
  const id = `community:${h.alice.publicKey}:${crypto.randomUUID()}`
  const state = { id, owner: h.alice.publicKey, name: 'Local private title', description: '', epoch: 2, updatedAt: h.state.now,
    members: [h.alice.publicKey, h.bob.publicKey], moderators: [], bans: [], channels: [{ id: crypto.randomUUID(), name: 'chat', posting: 'members' }],
    admission: 'direct', joiningPaused: false, inviteGeneration: 1, version: 2, coOwners: [], transfers: [], signer: h.alice.publicKey, deleted: false }
  const next = await c.signCommunityTransfer(state, h.bob.publicKey, h.alice)
  const fresh = h.protocol.retentionDescriptor(id, h.bob.publicKey, h.state.now, undefined, next.transfers)
  await h.send(h.bob, h.alice, fresh)
  assert.equal((await h.control(h.alice, 'retention:close', h.protocol.retentionDescriptor(id, h.alice.publicKey, h.state.now))).status, 409)
  assert.equal((await h.control(h.other, 'retention:close', fresh)).status, 403)
  assert.equal((await h.control(h.bob, 'retention:close', fresh)).status, 200)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM RelayEvent').get().n, 0)
  assert.doesNotMatch(JSON.stringify(h.sqlite.prepare('SELECT * FROM RetentionScope').all()), /Local private title|description|chat/)
})

test('scoped objects survive unrelated purges; cleanup failure stays terminal and retry reclaims bytes', async t => {
  const h = await setup(t), scope = h.direct()
  // Exercise the production R2 payload path with the same routed database
  // surface. The separate workerd test below covers real DO routing.
  h.env.SEROTINE_STORAGE_VERSION = '2'
  h.env.SEROTINE_REALTIME = { idFromName: value => value, get: () => ({ async fetch(request) {
    const queries = await request.json(), results = []
    for (const query of queries) {
      const statement = h.db.prepare(query.sql).bind(...query.values)
      if (/^(INSERT|UPDATE|DELETE|CREATE)/.test(query.sql.trim())) results.push({ ...(await statement.run()), results: [] })
      else results.push({ ...(await statement.all()), meta: { changes: 0 } })
    }
    return Response.json(results)
  } }) }
  assert.equal((await h.send(h.alice, h.bob, scope)).success, true)
  const otherScope = h.protocol.retentionDescriptor(h.other.publicKey, h.alice.publicKey, h.state.now)
  await h.send(h.alice, h.other, otherScope)
  assert.equal(h.objects.size, 2)
  h.state.failDelete = true
  assert.equal((await h.control(h.bob, 'retention:close', scope)).status, 503)
  assert.deepEqual((await h.feed(h.bob)).messages, [])
  assert.equal((await h.send(h.alice, h.bob, scope)).success, false)
  h.state.failDelete = false
  assert.equal((await h.control(h.bob, 'retention:close', scope)).status, 200)
  assert.equal(h.objects.size, 1)
  assert.equal((await h.feed(h.other)).messages.length, 1)
  h.state.now += 9 * 86400_000
  await h.server.maintainRetentionStorage(h.db, h.bucket, h.state.now)
  assert.equal(h.objects.size, 0)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM RetentionObject').get().n, 0)
})

test('a payload put completing after terminal purge cannot repopulate ciphertext or a relay row', async t => {
  const h = await setup(t), scope = h.direct(), key = await h.protocol.retentionScopeId(scope)
  await h.send(h.alice, h.bob, scope)
  h.env.SEROTINE_STORAGE_VERSION = '2'
  const payloads = h.load(path.join(root, 'lib/relay-payloads.ts'))
  h.state.afterPut = async () => { h.state.afterPut = null; await h.server.closeRetentionScope(h.db, key); await h.server.purgeRetentionScope(h.db, key) }
  await assert.rejects(payloads.storeRelayPayload('late ciphertext', { id: key, timestamp: h.state.now, db: h.db }), /retention has ended/)
  assert.equal(h.objects.size, 0)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM RelayEvent').get().n, 0)
})

test('an in-flight old purge never deletes rows or identical ciphertext written after mutual reopen', async t => {
  const h = await setup(t), scope = h.direct()
  await h.send(h.alice, h.bob, scope)
  h.env.SEROTINE_STORAGE_VERSION = '2'
  const payloads = h.load(path.join(root, 'lib/relay-payloads.ts'))
  const scopeId = await h.protocol.retentionScopeId(scope)
  await payloads.storeRelayPayload('same ciphertext', { id: scopeId, timestamp: h.state.now, db: h.db })
  await h.server.closeRetentionScope(h.db, scopeId)
  let liveId, newObject
  h.state.afterScopeRead = async () => {
    h.env.SEROTINE_STORAGE_VERSION = '1'
    h.state.now += 20
    await h.control(h.alice, 'retention:accept', h.direct())
    assert.equal((await h.control(h.bob, 'retention:accept', h.direct())).status, 200)
    h.env.SEROTINE_STORAGE_VERSION = '2'
    h.state.now++
    const ref = await payloads.storeRelayPayload('same ciphertext', { id: scopeId, timestamp: h.state.now, db: h.db })
    newObject = JSON.parse(ref.slice(payloads.PAYLOAD_PREFIX.length)).key
    liveId = crypto.randomUUID()
    h.sqlite.prepare(`INSERT INTO RelayEvent(id,senderPubKey,recipientPubKey,encryptedData,payloadBytes,createdAt,expiresAt,retentionScope,retentionTimestamp)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(liveId, h.alice.publicKey, h.bob.publicKey, ref, 15, h.state.now, h.state.now + 86400_000, scopeId, h.state.now)
  }
  const result = await h.server.purgeRetentionScope(h.db, scopeId)
  assert.equal(result.removed, 1)
  assert.equal(result.pending, false)
  assert.deepEqual(h.sqlite.prepare('SELECT id FROM RelayEvent').all().map(row => row.id), [liveId])
  assert.deepEqual([...h.objects.keys()], [newObject])
  await h.server.purgeRetentionScope(h.db, scopeId)
  assert.equal(h.objects.has(newObject), true)
})
