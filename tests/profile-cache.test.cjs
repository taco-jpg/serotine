const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test, beforeEach } = require('node:test')
const ts = require('typescript')
const root = path.resolve(__dirname, '..'), modules = new Map(), storage = new Map()
let writesFail = false
global.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => { if (writesFail) throw new Error('quota exceeded'); storage.set(key, value) },
  removeItem: key => storage.delete(key),
}
function load(file) {
  if (!path.extname(file)) file += '.ts'
  if (modules.has(file)) return modules.get(file).exports
  const module = { exports: {} }; modules.set(file, module)
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'module', 'exports', code)(specifier => specifier.startsWith('.') ? load(path.join(path.dirname(file), specifier)) : require(specifier), module, module.exports)
  return module.exports
}
const { ProfileService } = load('lib/profile-service')
const { emptyProfile, profileStorageKey, profileCacheKey } = load('lib/profiles')
const A = '04' + 'a'.repeat(128), B = '04' + 'b'.repeat(128), C = '04' + 'c'.repeat(128)
const device = '00000000-0000-4000-8000-000000000001'
const version = revision => ({ revision, device })
const cached = (revision, values = {}) => ({ ...version(revision), values, receivedAt: Date.now() })
beforeEach(() => { storage.clear(); writesFail = false })
function service() {
  const sent = []
  const value = new ProfileService({ owner: A, trusted: peer => [B, C].includes(peer), peers: () => [B, C],
    changed() {}, assertActive() {}, send: async (peer, wire) => { sent.push({ peer, wire: structuredClone(wire) }) } })
  return { value, sent }
}
function event(peer, wire) {
  return { key: crypto.randomUUID(), event: { kind: 'profile', author: peer, conversationId: A, timestamp: Date.now(), payload: { profile: wire } } }
}

test('failed cache persistence cannot resurrect a revoked field on the next read', async () => {
  storage.set(profileCacheKey(A), JSON.stringify({ [B]: cached(10, { bio: 'previously shared' }) }))
  const { value } = service()
  assert.equal(value.getProfile(B).bio, 'previously shared')
  writesFail = true
  await value.observe([event(B, { version: 1, type: 'revoke', ...version(20) })])
  assert.deepEqual(value.getProfile(B), {})
  value.reload()
  assert.deepEqual(value.getProfile(B), {})
  storage.set(profileCacheKey(A), JSON.stringify({ [B]: cached(20, { bio: 'same-version stale tab' }) }))
  value.reload()
  assert.deepEqual(value.getProfile(B), {}, 'equal-version storage cannot replace an in-memory tombstone')
})

test('cache merges independent peers without replacing newer versions from another tab', () => {
  storage.set(profileCacheKey(A), JSON.stringify({ [B]: cached(30, { displayName: 'current' }) }))
  const { value } = service()
  storage.set(profileCacheKey(A), JSON.stringify({ [B]: cached(20, { displayName: 'old' }), [C]: cached(10, { status: 'new peer' }) }))
  value.reload()
  assert.deepEqual(value.getProfile(B), { displayName: 'current' })
  assert.deepEqual(value.getProfile(C), { status: 'new peer' })
})

test('missing, corrupt, oversized, and excessive-entry caches preserve known revocations', async () => {
  const { value } = service()
  await value.observe([event(B, { version: 1, type: 'revoke', ...version(40) })])
  for (const text of [null, '{broken', 'x'.repeat(2_000_001), JSON.stringify(Object.fromEntries(Array.from({ length: 201 }, (_, i) => [String(i), cached(1)])))]) {
    if (text === null) storage.delete(profileCacheKey(A)); else storage.set(profileCacheKey(A), text)
    value.reload()
    assert.deepEqual(value.getProfile(B), {})
  }
  storage.set(profileCacheKey(A), JSON.stringify({ [B]: cached(30, { bio: 'stale' }) }))
  value.reload()
  assert.deepEqual(value.getProfile(B), {})
})

test('storage deletion revokes sharing, invalidates queued bytes, and preserves owner customization', async () => {
  const { value, sent } = service()
  await value.saveProfile({ displayName: 'Keep my customization' })
  await value.setSharing(B, ['displayName'])
  await value.observe([event(B, { version: 1, type: 'request', token: crypto.randomUUID() })])
  await value.flush()
  const oldData = sent.find(item => item.peer === B && item.wire.type === 'data').wire
  assert.equal(value.canDeliver(B, oldData), true)
  storage.delete(profileStorageKey(A))
  value.reload()
  assert.deepEqual(value.getSharing(B), [])
  assert.equal(value.state.values.displayName, 'Keep my customization')
  assert.equal(value.canDeliver(B, oldData), false)
  const resetRevision = value.state.revision
  await value.flush()
  assert.equal(sent.some(item => item.peer === B && item.wire.type === 'revoke' && item.wire.revision === resetRevision), true)
  assert.deepEqual(JSON.parse(storage.get(profileStorageKey(A))).grants[B], [])
})

test('corrupt authority with quota failure keeps sharing off in memory and preserves revocation retry', async () => {
  const { value, sent } = service()
  await value.saveProfile({ bio: 'Owner copy' }); await value.setSharing(B, ['bio'])
  storage.set(profileStorageKey(A), '{broken'); writesFail = true
  value.reload()
  const resetRevision = value.state.revision
  value.reload()
  assert.deepEqual(value.getSharing(B), [])
  assert.equal(value.state.revision, resetRevision)
  await value.flush()
  assert.equal(sent.some(item => item.peer === B && item.wire.type === 'revoke' && item.wire.revision === resetRevision), true)
})

test('older storage envelope with newer field revocation merges and invalidates queued authority', async () => {
  const original = { ...emptyProfile(), ...version(100), values: { bio: 'private' }, valuesVersion: version(90),
    grants: { [B]: ['bio'] }, grantVersions: { [B]: version(40) }, grantConfirmedAt: { [B]: Date.now() } }
  storage.set(profileStorageKey(A), JSON.stringify(original))
  const { value, sent } = service()
  await value.observe([event(B, { version: 1, type: 'request', token: crypto.randomUUID() })]); await value.flush()
  const queued = sent.find(item => item.peer === B && item.wire.type === 'data').wire
  storage.set(profileStorageKey(A), JSON.stringify({ ...original, ...version(95), grants: { [B]: [] }, grantVersions: { [B]: version(50) } }))
  value.reload()
  assert.deepEqual(value.getSharing(B), [])
  assert.equal(value.state.values.bio, 'private')
  assert.equal(value.canDeliver(B, queued), false)
})

test('storage reset fence exceeds component versions from an ahead-of-clock linked device', () => {
  const ahead = (Date.now() + 30_000) * 1000
  storage.set(profileStorageKey(A), JSON.stringify({ ...emptyProfile(), ...version(100),
    grants: { [B]: ['bio'] }, grantVersions: { [B]: version(ahead) } }))
  const { value } = service()
  storage.delete(profileStorageKey(A)); value.reload()
  assert.ok(value.state.grantVersions[B].revision > ahead)
  assert.deepEqual(value.getSharing(B), [])
})
