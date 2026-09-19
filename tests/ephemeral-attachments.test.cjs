const assert = require('node:assert/strict')
const { test } = require('node:test')
const path = require('node:path')
const { harness, root } = require('./support/lifecycle-harness.cjs')

async function setup(t, kind = 'direct') {
  const h = harness(t), alice = await h.identity(), bob = await h.identity(), charlie = await h.identity(), outsider = await h.identity()
  const protocol = h.load(path.join(root, 'lib/retention-protocol.ts'))
  const id = kind === 'direct' ? bob.publicKey : kind === 'group' ? `group:${crypto.randomUUID()}` : `community:${alice.publicKey}:${crypto.randomUUID()}`
  const scope = protocol.retentionDescriptor(id, alice.publicKey, h.state.now, alice.publicKey)
  const upload = await h.init(alice, 3)
  const bytes = new Uint8Array(19)
  assert.equal((await h.chunk(alice, upload, bytes.buffer)).status, 200)
  await h.complete(alice, upload); await h.publish(alice, upload)
  const chunkHash = await h.protocol.fileUploadDigest(bytes.buffer)
  const manifestHash = await h.protocol.fileUploadDigest(new TextEncoder().encode(JSON.stringify([chunkHash])).buffer)
  const messageId = crypto.randomUUID(), recipients = kind === 'group' ? [bob.publicKey, charlie.publicKey] : [bob.publicKey]
  const declaration = { uploadId: upload.uploadId, messageId, manifestHash, recipients, scope }
  const response = await h.request(alice, 'file:delivery', declaration)
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
  const ack = (who, override = {}) => h.request(who, 'file:received', { uploadId: upload.uploadId, messageId, manifestHash, capability: upload.capability, ...override })
  return { ...h, alice, bob, charlie, outsider, scope, upload, messageId, manifestHash, declaration, ack }
}

test('DM bytes remain through metadata/partial reads; only intended authenticated integrity-bound completion reclaims all delivery rows/objects', async t => {
  const h = await setup(t)
  assert.equal(h.objects.size, 1)
  assert.equal((await h.read(h.bob, h.upload)).status, 200)
  assert.equal(h.objects.size, 1)
  assert.equal((await h.ack(h.outsider)).status, 403)
  assert.equal((await h.ack(h.bob, { manifestHash: '0'.repeat(64) })).status, 403)
  assert.equal((await h.ack(h.bob, { messageId: crypto.randomUUID() })).status, 403)
  assert.equal((await h.ack(h.bob, { capability: '1'.repeat(64) })).status, 403)
  assert.equal(h.objects.size, 1)
  assert.equal((await h.ack(h.bob)).status, 200)
  assert.equal(h.objects.size, 0)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM FileDelivery').get().n, 0)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM FileUploadChunk').get().n, 0)
  assert.equal(h.sqlite.prepare('SELECT reservedBytes FROM FileUpload').get().reservedBytes, 0)
  assert.equal((await h.read(h.bob, h.upload)).status, 410)
  const changes = h.sqlite.prepare('SELECT total_changes() AS n').get().n
  assert.equal((await h.ack(h.bob)).status, 200)
  assert.equal(h.sqlite.prepare('SELECT total_changes() AS n').get().n - changes, 1, 'duplicate completion writes only its mandatory request nonce')
})

test('group copy survives until every required recipient verifies it; duplicate completion does not inflate the delivery set', async t => {
  const h = await setup(t, 'group')
  assert.equal((await h.ack(h.bob)).status, 200)
  assert.equal((await h.ack(h.bob)).status, 200)
  assert.equal(h.objects.size, 1)
  assert.deepEqual(JSON.parse(h.sqlite.prepare('SELECT completed FROM FileDelivery').get().completed), [h.bob.publicKey])
  assert.equal((await h.read(h.charlie, h.upload)).status, 200)
  assert.equal((await h.ack(h.charlie)).status, 200)
  assert.equal(h.objects.size, 0)
})

test('failed physical cleanup stays unavailable, holds quota, and low-frequency cleanup retries deletion', async t => {
  const h = await setup(t)
  h.state.failDelete = true
  assert.equal((await h.ack(h.bob)).status, 503)
  assert.equal(h.sqlite.prepare('SELECT status FROM FileUpload').get().status, 'deleted')
  assert.equal(h.sqlite.prepare('SELECT reservedBytes FROM FileUpload').get().reservedBytes, 3)
  assert.equal((await h.read(h.bob, h.upload)).status, 410)
  h.state.failDelete = false
  assert.equal((await h.request(h.alice, 'file:cleanup', {})).status, 200)
  assert.equal(h.objects.size, 0)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM FileDelivery').get().n, 0)
})

test('DM/group expiry is seven days; community copies remain bounded to thirty days even after completion', async t => {
  const dm = await setup(t)
  assert.equal(dm.sqlite.prepare('SELECT expiresAt FROM FileUpload').get().expiresAt, dm.state.now + 7 * 86400_000)
  dm.state.now += 7 * 86400_000 + 1
  assert.equal((await dm.read(dm.bob, dm.upload)).status, 410)
  await dm.request(dm.alice, 'file:cleanup', {})
  assert.equal(dm.objects.size, 0)
  const community = await setup(t, 'community')
  await community.ack(community.bob)
  assert.equal(community.objects.size, 1)
  assert.equal(community.sqlite.prepare('SELECT expiresAt FROM FileUpload').get().expiresAt, community.state.now + 30 * 86400_000)
  community.state.now += 30 * 86400_000 + 1
  await community.request(community.alice, 'file:cleanup', {})
  assert.equal(community.objects.size, 0)
})

test('a terminal scope makes pending files unreadable and purges them while preserving unrelated files', async t => {
  const h = await setup(t), server = h.load(path.join(root, 'lib/retention-server.ts')), protocol = h.load(path.join(root, 'lib/retention-protocol.ts'))
  const unrelated = await h.init(h.alice, 3)
  await h.chunk(h.alice, unrelated, new Uint8Array(19).buffer)
  assert.equal(h.objects.size, 2)
  const scopeId = await protocol.retentionScopeId(h.scope)
  await server.closeRetentionScope(h.db, scopeId)
  assert.equal((await h.read(h.bob, h.upload)).status, 410)
  await server.purgeRetentionScope(h.db, scopeId)
  assert.equal(h.objects.size, 1)
  assert.ok([...h.objects.keys()][0].includes(unrelated.uploadId))
})

test('retired upload IDs cannot be recreated from old backups after compact delivery metadata expires', async t => {
  const h = await setup(t)
  await h.ack(h.bob)
  h.state.now += 34 * 86400_000
  await h.request(h.alice, 'file:cleanup', {})
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM FileUpload').get().n, 0)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM FileUploadTombstone').get().n, 1)
  assert.equal((await h.read(h.bob, h.upload)).status, 410)
  const retry = await h.request(h.alice, 'file:init', h.upload.data)
  assert.notEqual(retry.status, 200)
  assert.equal(h.objects.size, 0)
})

test('terminal group authority denies file reads before an interrupted lifecycle callback is retried', async t => {
  const h = await setup(t, 'group')
  h.sqlite.prepare('INSERT INTO GroupAuthority(groupId,admin,terminalAt,createdAt) VALUES(?,?,?,?)')
    .run(`group:${h.scope.key}`, h.alice.publicKey, h.state.now, h.state.now - 100)
  assert.equal(h.sqlite.prepare('SELECT closedAt FROM RetentionScope').get().closedAt, 0)
  assert.equal((await h.read(h.bob, h.upload)).status, 410)
  assert.equal((await h.ack(h.bob)).status, 410)
  const server = h.load(path.join(root, 'lib/retention-server.ts'))
  await server.maintainRetentionStorage(h.db, h.bucket, h.state.now)
  assert.equal(h.objects.size, 0)
})

test('completed attachment cleanup backs off after its first late-writer sweep', async t => {
  const h = await setup(t)
  await h.ack(h.bob)
  assert.equal(h.sqlite.prepare('SELECT cleanupAt FROM FileUpload').get().cleanupAt, h.state.now + 3600_000)
  h.state.now += 3600_001
  await h.request(h.alice, 'file:cleanup', {})
  assert.equal(h.sqlite.prepare('SELECT cleanupAt FROM FileUpload').get().cleanupAt, h.state.now + 86400_000)
})
