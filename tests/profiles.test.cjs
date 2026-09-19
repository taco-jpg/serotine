const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test, beforeEach } = require('node:test')
const ts = require('typescript')
const root = path.resolve(__dirname, '..'), modules = new Map(), storage = new Map()
global.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
function load(file) {
  if (!path.extname(file)) file += '.ts'
  if (modules.has(file)) return modules.get(file).exports
  const module = { exports: {} }; modules.set(file, module)
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'module', 'exports', code)(specifier => specifier.startsWith('.') ? load(path.join(path.dirname(file), specifier)) : require(specifier), module, module.exports)
  return module.exports
}
const { ProfileService } = load('lib/profile-service')
const model = load('lib/profiles')
const A = '04' + 'a'.repeat(128), B = '04' + 'b'.repeat(128), C = '04' + 'c'.repeat(128)
beforeEach(() => storage.clear())
function network() {
  const peers = new Map(), events = [], queue = []
  function add(owner, friends = [], options = {}) {
    const trusted = new Set(friends)
    const service = new ProfileService({ ...options, owner, trusted: peer => trusted.has(peer), peers: () => [...trusted], changed() {}, assertActive() {}, send: async (peer, wire) => {
      await options.beforeSend?.(peer, wire)
      assert.ok(model.validProfileWire(wire), `wire invalid: ${JSON.stringify(wire)}`)
      const record = { key: crypto.randomUUID(), event: { id: crypto.randomUUID(), kind: 'profile', author: owner, conversationId: peer, timestamp: Date.now(), payload: { profile: structuredClone(wire) } }, local: false, receivedAt: Date.now() }
      events.push(record); queue.push(record)
    } })
    peers.set(owner, service)
    return { service, trusted }
  }
  async function settle() {
    for (let turn = 0; turn < 100; turn++) {
      for (const service of peers.values()) await service.flush()
      const batch = queue.splice(0)
      if (!batch.length) return
      for (const record of batch) await peers.get(record.event.conversationId)?.observe([record])
    }
    throw new Error('profile negotiation must settle')
  }
  return { add, settle, events, queue, peers }
}
test('profile fields default private and handshake is directional per accepted friend', async () => {
  const n = network(), a = n.add(A, [B, C]), b = n.add(B, [A]), c = n.add(C, [A])
  await a.service.saveProfile({ displayName: 'Alice', bio: 'Private bio', status: 'Hello' })
  await a.service.setSharing(B, ['displayName']); await a.service.setSharing(C, ['status'])
  await n.settle()
  assert.deepEqual(b.service.getProfile(A), { displayName: 'Alice' })
  assert.deepEqual(c.service.getProfile(A), { status: 'Hello' })
  assert.deepEqual(a.service.getProfile(B), {})
  assert.equal(n.events.some(row => row.event.conversationId === B && JSON.stringify(row.event.payload).includes('Private bio')), false)
  assert.equal(n.events.some(row => row.event.conversationId === C && JSON.stringify(row.event.payload).includes('Alice')), false)
})
test('pending, unsupported and stranger peers receive no optional profile data', async () => {
  const n = network(), a = n.add(A, [B]), b = n.add(B, [])
  await a.service.saveProfile({ displayName: 'Keep private' }); await a.service.setSharing(B, ['displayName']); await n.settle()
  assert.deepEqual(b.service.getProfile(A), {})
  assert.equal(n.events.some(row => row.event.conversationId === B && row.event.payload.profile.type === 'data'), false)
  b.trusted.add(A); b.service.request(A, true); await n.settle()
  assert.deepEqual(b.service.getProfile(A), { displayName: 'Keep private' })
})
test('revocation clears an authorized view and delayed older data cannot restore it', async () => {
  const n = network(), a = n.add(A, [B]), b = n.add(B, [A])
  await a.service.saveProfile({ displayName: 'Alice', status: 'Secret status' }); await a.service.setSharing(B, ['displayName', 'status']); await n.settle()
  const old = n.events.filter(row => row.event.author === A && row.event.conversationId === B && row.event.payload.profile.type === 'data')
  await a.service.setSharing(B, ['displayName']); await n.settle()
  assert.deepEqual(b.service.getProfile(A), { displayName: 'Alice' })
  await b.service.observe(old.map(row => ({ ...row, key: crypto.randomUUID() })))
  assert.deepEqual(b.service.getProfile(A), { displayName: 'Alice' })
  assert.equal(a.service.canDeliver(B, old.at(-1).event.payload.profile), false)
})
test('unfriend and re-add never reuse an old grant or receiver request token', async () => {
  const n = network(), a = n.add(A, [B]), b = n.add(B, [A])
  await a.service.saveProfile({ displayName: 'Alice' }); await a.service.setSharing(B, ['displayName']); await n.settle()
  a.trusted.delete(B); await a.service.revoke(B); await n.settle()
  assert.deepEqual(b.service.getProfile(A), {})
  assert.deepEqual(a.service.getSharing(B), [])
  a.trusted.add(B); a.service.request(B, true); await n.settle()
  assert.deepEqual(b.service.getProfile(A), {})
})
test('new device accepts encrypted self synchronization while stale snapshots stay rejected', async () => {
  const n = network(), a = n.add(A, [B]); n.add(B, [A])
  await a.service.saveProfile({ bio: 'Synced privately' }); await a.service.setSharing(B, ['bio']); await n.settle()
  const sync = n.events.filter(row => row.event.author === A && row.event.conversationId === A && row.event.payload.profile.type === 'sync')
  storage.delete(model.profileStorageKey(A))
  const restored = n.add(A, [B]).service
  assert.deepEqual(restored.getSharing(B), [])
  await restored.observe(sync)
  assert.deepEqual(restored.state.values, { bio: 'Synced privately' })
  assert.deepEqual(restored.getSharing(B), ['bio'])
  const revision = restored.state.revision
  await restored.observe(sync.map(row => ({ ...row, key: crypto.randomUUID() })))
  assert.equal(restored.state.revision, revision)
})
test('stranger revoke floods and malformed profile fields fail closed', async () => {
  const n = network(), a = n.add(A, [])
  await a.service.observe([{ key: 'stranger', event: { author: C, conversationId: A, kind: 'profile', payload: { profile: { version: 1, type: 'revoke', revision: Date.now() * 1000, device: crypto.randomUUID() } } } }])
  assert.equal(storage.has(model.profileCacheKey(A)), false)
  assert.equal(model.validProfileValues({ colors: { accent: 'url(https://evil.test)', background: '#ffffff' } }), false)
  assert.equal(model.validProfileValues({ bio: 'x'.repeat(501) }), false)
  assert.equal(model.validProfileValues({ futureField: 'unapproved' }), false)
  assert.equal(model.validProfileFields(['displayName', 'displayName']), false)
})

test('stale linked-device profile edits and another friend grant never restore a revoked grant', async () => {
  const n = network(), a = n.add(A, [B, C]); n.add(B, [A]); n.add(C, [A])
  await a.service.saveProfile({ displayName: 'Alice' }); await a.service.setSharing(B, ['displayName']); await n.settle()
  const stale = structuredClone(a.service.state)
  await a.service.setSharing(B, []); await n.settle()
  const version = { revision: a.service.state.revision + 100, device: crypto.randomUUID() }
  const edited = { ...stale, ...version, values: { displayName: 'Alice on another device' }, valuesVersion: version, grants: { ...stale.grants, [C]: ['displayName'] }, grantVersions: { ...stale.grantVersions, [C]: version }, grantConfirmedAt: { ...stale.grantConfirmedAt, [C]: Date.now() } }
  const wire = { version: 1, type: 'sync', token: crypto.randomUUID(), transfer: crypto.randomUUID(), index: 0, total: 1, data: JSON.stringify(edited), ...version }
  await a.service.observe([{ key: crypto.randomUUID(), event: { author: A, conversationId: A, kind: 'profile', payload: { profile: wire } } }])
  assert.equal(a.service.state.values.displayName, 'Alice on another device')
  assert.deepEqual(a.service.getSharing(B), [])
  assert.deepEqual(a.service.getSharing(C), ['displayName'])
})


test('direct-only peers pause profiles without blocking other friends and resume with current fields', async () => {
  const paused = new Set([B]), attempted = []
  const n = network(), a = n.add(A, [B, C], { canSend: peer => !paused.has(peer), beforeSend: peer => attempted.push(peer) }), b = n.add(B, [A]), c = n.add(C, [A])
  await a.service.saveProfile({ bio: 'Only authorized friends' })
  await a.service.setSharing(B, ['bio']); await a.service.setSharing(C, ['bio']); await n.settle()
  assert.equal(attempted.includes(B), false)
  assert.deepEqual(b.service.getProfile(A), {})
  assert.deepEqual(c.service.getProfile(A), { bio: 'Only authorized friends' })
  paused.delete(B); await n.settle()
  assert.deepEqual(b.service.getProfile(A), { bio: 'Only authorized friends' })
})

test('an optional profile send failure retries that friend without blocking others or rejecting sync', async () => {
  let unavailable = true
  const n = network(), a = n.add(A, [B, C], { beforeSend: peer => { if (peer === B && unavailable) throw new Error('Peer unavailable') } }), b = n.add(B, [A]), c = n.add(C, [A])
  await a.service.saveProfile({ status: 'Share selectively' })
  await a.service.setSharing(B, ['status']); await a.service.setSharing(C, ['status']); await n.settle()
  assert.deepEqual(b.service.getProfile(A), {})
  assert.deepEqual(c.service.getProfile(A), { status: 'Share selectively' })
  unavailable = false; await n.settle()
  assert.deepEqual(b.service.getProfile(A), { status: 'Share selectively' })
})

test('missing or future consent never derives renewed permission from a monotonic version', async () => {
  const n = network(), a = n.add(A, [B]); n.add(B, [A])
  await a.service.saveProfile({ bio: 'Private' }); await a.service.setSharing(B, ['bio'])
  const saved = structuredClone(a.service.state)
  const missing = { ...saved, grantConfirmedAt: {} }
  storage.set(model.profileStorageKey(A), JSON.stringify(missing))
  const restoreMissing = n.add(A, [B]).service
  assert.deepEqual(restoreMissing.getSharing(B), [])
  assert.deepEqual(restoreMissing.state.values, { bio: 'Private' })
  storage.set(model.profileStorageKey(A), JSON.stringify({ ...saved, grantConfirmedAt: { [B]: Date.now() + 365 * 24 * 3600000 } }))
  const restoreFuture = n.add(A, [B]).service
  assert.deepEqual(restoreFuture.getSharing(B), [])
  assert.deepEqual(restoreFuture.state.values, { bio: 'Private' })
})

test('a relationship closure boundary invalidates grants, cached fields and receiver tokens', async () => {
  let boundary = 0
  const n = network(), a = n.add(A, [B], { relationshipBoundary: () => boundary }), b = n.add(B, [A], { relationshipBoundary: () => boundary })
  await a.service.saveProfile({ bio: 'Before closure' }); await a.service.setSharing(B, ['bio']); await n.settle()
  assert.deepEqual(b.service.getProfile(A), { bio: 'Before closure' })
  const oldData = n.events.find(row => row.event.author === A && row.event.conversationId === B && row.event.payload.profile.type === 'data')
  boundary = Date.now() + 1
  a.service.reload(); b.service.reload()
  assert.deepEqual(a.service.getSharing(B), [])
  assert.deepEqual(b.service.getProfile(A), {})
  assert.equal(a.service.canDeliver(B, oldData.event.payload.profile), false)
  await b.service.observe([{ ...oldData, key: crypto.randomUUID() }])
  assert.deepEqual(b.service.getProfile(A), {})
  assert.deepEqual(a.service.state.values, { bio: 'Before closure' })
})
