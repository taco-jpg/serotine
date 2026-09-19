const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test, before, beforeEach } = require('node:test')
const ts = require('typescript')

const root = path.join(__dirname, '..'), modules = new Map(), locks = [], retentionRequests = []
const runtimeNavigator = { locks: { request: async (key, callback) => { locks.push(key); return callback() } } }
function load(filename) {
  if (!path.extname(filename)) filename += '.ts'
  if (modules.has(filename)) return modules.get(filename).exports
  const module = { exports: {} }; modules.set(filename, module)
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const requireSource = specifier => specifier.startsWith('.') ? load(path.resolve(path.dirname(filename), specifier)) : require(specifier)
  new Function('require', 'module', 'exports', 'navigator', 'window', 'fetch', output)(requireSource, module, module.exports, runtimeNavigator, { location: { origin: 'https://example.test' } }, async (url, options) => {
    assert.equal(url, '/api/retention')
    assert.equal(options.method, 'POST')
    const { version, action, data, proof } = JSON.parse(options.body)
    assert.equal(version, 1)
    assert.equal(action, 'retention:close')
    assert.equal(await authentication.verifyRequestProof(action, data, proof), true)
    assert.equal(await retention.validRetentionDescriptor(data.scope), true)
    assert.equal(data.scope.kind, 'community')
    assert.equal(data.scope.transfers.at(-1)?.to ?? data.scope.founder, proof.publicKey)
    retentionRequests.push(data.scope)
    return Response.json({ success: true, pending: false })
  })
  return module.exports
}
const cryptoHelpers = load(path.join(root, 'lib/crypto.ts'))
const { CommunityService } = load(path.join(root, 'lib/community-service.ts'))
const authentication = load(path.join(root, 'lib/request-auth.ts'))
const retention = load(path.join(root, 'lib/retention-protocol.ts'))
beforeEach(() => { retentionRequests.length = 0 })
let alice, bob, charlie
before(async () => {
  const identity = async () => {
    const pair = await cryptoHelpers.generateEncryptionKeyPair()
    return { version: 2, publicKey: await cryptoHelpers.exportPublicKeyToHex(pair.publicKey), privateKey: await cryptoHelpers.exportKey(pair.privateKey) }
  }
  ;[alice, bob, charlie] = await Promise.all([identity(), identity(), identity()])
})
function harness() {
  const storage = new Map(), sent = []
  let order = 0
  const rows = address => { if (!storage.has(address)) storage.set(address, []); return storage.get(address) }
  const inject = event => {
    sent.push(event)
    for (const address of new Set([event.author, ...event.recipients])) rows(address).push({
      key: `${event.author}:${event.conversationId}:${event.id}`, event: structuredClone(event),
      local: event.author === address, delivered: [...event.recipients], receivedAt: ++order,
    })
  }
  function client(identity) {
    const host = { identity, records: () => rows(identity.publicKey),
      preferences: () => ({ accepted: [], blocked: [], notifications: {}, readAt: {}, readReceipts: true, archived: [], deleted: {}, deletedMessages: {} }),
      refresh: async () => {},
      // Envelope cryptography is covered by community-engine.test.cjs. Here the
      // production state and invitation signatures still use Web Crypto.
      sign: async event => ({ ...event, signature: '0'.repeat(128) }),
      queue: async event => { inject(event) },
      queueBatch: async events => { events.forEach(inject) },
    }
    return { host, service: new CommunityService(host) }
  }
  return { client, sent, inject }
}
async function established(h, admission = 'direct', identities = [bob, charlie]) {
  const owner = h.client(alice)
  const id = await owner.service.createCommunity({ name: 'Math club', description: 'Practice together', admission })
  const invite = await owner.service.createInvite(id)
  const clients = identities.map(identity => h.client(identity))
  for (const client of clients) await client.service.joinCommunity(invite)
  if (admission === 'direct') await owner.service.reconcile()
  return { owner, id, invite, clients }
}

test('handoff resolves pending applicants before transfer and keeps optional co-owner permissions', async () => {
  const h = harness(), { owner, id, clients: [successor] } = await established(h, 'direct', [bob])
  await owner.service.updateCommunity(id, { admission: 'approval' })
  const invite = await owner.service.createInvite(id), applicant = h.client(charlie)
  await applicant.service.joinCommunity(invite)
  const channel = owner.service.model.communities[0].channels[0].id
  await owner.service.sendMessage(id, channel, 'Preserve this history')
  await owner.service.transferOwnership(id, bob.publicKey, true)
  const transferred = successor.service.model.communities[0]
  assert.equal(transferred.owner, bob.publicKey)
  assert.deepEqual(transferred.coOwners, [alice.publicKey])
  assert.equal(transferred.id, id)
  assert.equal(transferred.channels[0].id, channel)
  assert.equal(successor.service.model.messages[0].content, 'Preserve this history')
  assert.equal(applicant.service.model.requests[0].status, 'rejected')
  assert.match(applicant.service.model.requests[0].reason, /Ownership changed/)
  await owner.service.updateCommunity(id, { name: 'Former owner request' })
  assert.notEqual(successor.service.model.communities[0].name, 'Former owner request')
  await successor.service.reconcile()
  assert.equal(successor.service.model.communities[0].name, 'Former owner request')
  await owner.service.leave(id)
  await successor.service.reconcile()
  assert.deepEqual(successor.service.model.communities[0].coOwners, [])
  assert.equal(owner.service.model.communities[0].joined, false)
})

test('a new join request arriving during transfer signing cancels the handoff until rejected', async () => {
  const h = harness(), { owner, id, clients: [successor] } = await established(h, 'direct', [bob])
  await owner.service.updateCommunity(id, { admission: 'approval' })
  const invite = await owner.service.createInvite(id), applicant = h.client(charlie)
  const original = owner.host.sign
  let injected = false
  owner.host.sign = async event => {
    if (!injected && event.payload.community.type === 'state' && event.payload.community.state.owner === bob.publicKey) {
      injected = true
      await applicant.service.joinCommunity(invite)
    }
    return original(event)
  }
  await assert.rejects(owner.service.transferOwnership(id, bob.publicKey), /new join request/i)
  assert.equal(successor.service.model.communities[0].owner, alice.publicKey)
  await owner.service.transferOwnership(id, bob.publicKey)
  assert.equal(applicant.service.model.requests[0].status, 'rejected')
  assert.equal(successor.service.model.communities[0].owner, bob.publicKey)
})

test('a departure arriving during handoff or deletion signing cancels stale membership fanout', async () => {
  for (const action of ['transfer', 'delete']) {
    const h = harness(), { owner, id, clients: [member] } = await established(h)
    const original = owner.host.sign
    owner.host.sign = async event => {
      if (event.payload.community.type === 'state') await member.service.leave(id)
      return original(event)
    }
    await assert.rejects(action === 'transfer' ? owner.service.transferOwnership(id, bob.publicKey) : owner.service.deleteCommunity(id), /community changed/i)
    assert.equal(owner.service.model.communities[0].deleted, false)
    assert.equal(owner.service.model.communities[0].owner, alice.publicKey)
  }
})

test('co-owner settings cannot alter authority and queued commands lose permission when revoked', async () => {
  const h = harness(), { owner, id, clients: [coowner] } = await established(h)
  await owner.service.setCoOwner(id, bob.publicKey, true)
  await coowner.service.updateCommunity(id, { name: 'Permitted name', owner: bob.publicKey, coOwners: [charlie.publicKey], deleted: true })
  await owner.service.reconcile()
  assert.equal(owner.service.model.communities[0].name, 'Permitted name')
  assert.equal(owner.service.model.communities[0].owner, alice.publicKey)
  assert.deepEqual(owner.service.model.communities[0].coOwners, [bob.publicKey])
  assert.equal(owner.service.model.communities[0].deleted, false)
  await coowner.service.updateCommunity(id, { name: 'Must not apply' })
  await owner.service.setCoOwner(id, bob.publicKey, false)
  await owner.service.reconcile()
  assert.equal(owner.service.model.communities[0].name, 'Permitted name')
  await assert.rejects(coowner.service.deleteCommunity(id), /only the owner/i)
  await assert.rejects(coowner.service.transferOwnership(id, bob.publicKey), /only the owner/i)
})

test('deletion rejects outstanding applicants and future users of still-signed old invites', async () => {
  const h = harness(), { owner, id } = await established(h, 'direct', [])
  await owner.service.updateCommunity(id, { admission: 'approval' })
  const invite = await owner.service.createInvite(id), applicant = h.client(bob), later = h.client(charlie)
  await applicant.service.joinCommunity(invite)
  await owner.service.deleteCommunity(id)
  assert.equal(retentionRequests.length, 1)
  assert.equal(retentionRequests[0].key, id.slice(141))
  assert.equal(applicant.service.model.requests[0].status, 'rejected')
  assert.match(applicant.service.model.requests[0].reason, /deleted/)
  await later.service.joinCommunity(invite)
  await owner.service.reconcile()
  assert.equal(later.service.model.requests[0].status, 'rejected')
  assert.match(later.service.model.requests[0].reason, /deleted/)
})
