const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
const owner = '04' + 'a'.repeat(128), peer = '04' + 'b'.repeat(128)
const DAY = 24 * 3600000

function harness(t) {
  const storage = new Map(), modules = new Map(), sent = [], services = []
  let now = Date.now()
  class Clock extends Date { static now() { return now } }
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
  function load(file) {
    if (!path.extname(file)) file += '.ts'
    if (modules.has(file)) return modules.get(file).exports
    const module = { exports: {} }; modules.set(file, module)
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const requireSource = name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name)) : require(name)
    new Function('require', 'module', 'exports', 'localStorage', 'Date', code)(requireSource, module, module.exports, localStorage, Clock)
    return module.exports
  }
  const { ProfileService } = load(path.join(root, 'lib/profile-service.ts'))
  const { profileStorageKey } = load(path.join(root, 'lib/profiles.ts'))
  const key = profileStorageKey(owner)
  const record = (author, profile) => ({ key: crypto.randomUUID(), event: { kind: 'profile', author, conversationId: owner, timestamp: now, payload: { profile } } })
  const create = () => {
    const service = new ProfileService({ owner, trusted: value => value === peer, peers: () => [peer], changed() {}, assertActive() {},
      send: async (recipient, wire) => sent.push({ recipient, wire: structuredClone(wire) }) })
    services.push(service); return service
  }
  t.after(() => services.forEach(service => service.dispose()))
  return { sent, create, record, advance: days => { now += days * DAY },
    snapshot: () => storage.get(key), restore: snapshot => storage.set(key, snapshot),
    request: service => service.observe([record(peer, { version: 1, type: 'request', token: crypto.randomUUID() })]),
    values: () => sent.filter(item => item.recipient === peer && item.wire.type === 'data').map(item => JSON.parse(item.wire.data)),
    now: () => now,
  }
}

test('an eight-day offline owner snapshot cannot resend fields revoked on another device', async t => {
  const h = harness(t), current = h.create()
  await current.saveProfile({ bio: 'Previously shared private text', displayName: 'Owner customization' })
  await current.setSharing(peer, ['bio'])
  const offlineSnapshot = h.snapshot()
  await current.setSharing(peer, [])
  assert.deepEqual(current.getSharing(peer), [])
  // The other device missed the revocation and every retained self-sync copy.
  h.advance(8); h.restore(offlineSnapshot); h.sent.length = 0
  const stale = h.create()
  await h.request(stale); await stale.flush()
  assert.deepEqual(stale.getSharing(peer), [])
  assert.equal(stale.state.values.bio, 'Previously shared private text')
  assert.ok(h.values().every(value => Object.keys(value).length === 0))
  assert.deepEqual(JSON.parse(h.snapshot()).grants[peer], [])
  assert.ok(JSON.parse(h.snapshot()).grantVersions[peer].revision > JSON.parse(offlineSnapshot).grantVersions[peer].revision)
  // Only a fresh, explicit field selection restores delivery.
  h.sent.length = 0
  await stale.setSharing(peer, ['bio']); await h.request(stale); await stale.flush()
  assert.ok(h.values().some(value => value.bio === 'Previously shared private text'))
  assert.ok(h.values().every(value => value.displayName === undefined))
})

test('editing profile values never renews an old per-friend sharing grant', async t => {
  const h = harness(t), service = h.create()
  await service.saveProfile({ bio: 'Original text' }); await service.setSharing(peer, ['bio'])
  const granted = structuredClone(service.state.grantVersions[peer])
  h.advance(5); await service.saveProfile({ bio: 'A recent profile edit' })
  assert.deepEqual(service.state.grantVersions[peer], granted)
  h.advance(2); h.sent.length = 0
  await h.request(service); await service.flush()
  assert.deepEqual(service.getSharing(peer), [])
  assert.ok(h.values().every(value => Object.keys(value).length === 0))
  assert.equal(service.state.values.bio, 'A recent profile edit')
})

test('a fresh self-sync envelope does not renew stale component grant versions', async t => {
  const h = harness(t), original = h.create()
  await original.saveProfile({ bio: 'A stale grant must not authorize this' }); await original.setSharing(peer, ['bio'])
  const snapshot = structuredClone(original.state)
  h.advance(8)
  // An offline device can make a new profile edit while retaining its old grant.
  const version = { revision: h.now() * 1000, device: crypto.randomUUID() }
  const incoming = { ...snapshot, ...version, valuesVersion: version, values: { bio: 'Fresh values, stale permission' } }
  const wire = { version: 1, type: 'sync', token: crypto.randomUUID(), transfer: crypto.randomUUID(), index: 0, total: 1, data: JSON.stringify(incoming), ...version }
  const receiver = h.create(); h.sent.length = 0
  await receiver.observe([h.record(owner, wire)]); await h.request(receiver); await receiver.flush()
  assert.equal(receiver.state.values.bio, 'Fresh values, stale permission')
  assert.deepEqual(receiver.getSharing(peer), [])
  assert.ok(h.values().every(value => Object.keys(value).length === 0))
})

test('profile bytes queued before grant expiry are discarded at the send boundary', async t => {
  const h = harness(t), service = h.create()
  await service.saveProfile({ status: 'Queued while authorized' }); await service.setSharing(peer, ['status'])
  h.advance(5); await h.request(service)
  // Do not flush the authorized response until after the lease expires.
  h.advance(3); h.sent.length = 0
  await service.flush()
  assert.deepEqual(service.getSharing(peer), [])
  assert.ok(h.values().every(value => Object.keys(value).length === 0))
})
