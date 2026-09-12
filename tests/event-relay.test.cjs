/* Real signatures, browser transport, server route and SQLite for event sync. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { test } = require('node:test')
const ts = require('typescript')
const root = path.join(__dirname, '..')
const origin = 'https://serotine.example'

function loader(stubs = {}, globals = {}) {
  const cache = new Map()
  function load(filename) {
    if (!path.extname(filename)) filename += '.ts'
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }; cache.set(filename, module)
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText
    const requireSource = name => Object.hasOwn(stubs, name) ? stubs[name]
      : name.startsWith('@/') ? load(path.join(root, name.slice(2)))
      : name.startsWith('.') ? load(path.resolve(path.dirname(filename), name)) : require(name)
    new Function('require', 'module', 'exports', ...Object.keys(globals), output)(requireSource, module, module.exports, ...Object.values(globals))
    return module.exports
  }
  return load
}

function harness(t) {
  const sqlite = new DatabaseSync(':memory:')
  t.after(() => sqlite.close())
  const calls = []
  const db = {
    prepare(sql) {
      calls.push(sql)
      let args = []
      return {
        bind(...values) { args = values; return this },
        async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } } },
        async first() { return sqlite.prepare(sql).get(...args) ?? null },
        async all() { return { results: sqlite.prepare(sql).all(...args) } },
      }
    },
  }
  const load = loader({ '@opennextjs/cloudflare': { getCloudflareContext: () => ({ env: { serotine_db: db } }) } })
  const cryptography = load(path.join(root, 'lib/crypto.ts'))
  const auth = load(path.join(root, 'lib/request-auth.ts'))
  const { POST } = load(path.join(root, 'app/api/relay/route.ts'))
  const actions = load(path.join(root, 'app/actions.ts'))
  const relay = loader({}, { fetch: (url, init) => POST(new Request(`${origin}${url}`, init)) })(path.join(root, 'lib/relay-client.ts'))
  async function identity() {
    const pair = await cryptography.generateEncryptionKeyPair()
    return { pair, privateJwk: await cryptography.exportKey(pair.privateKey), publicKey: await cryptography.exportPublicKeyToHex(pair.publicKey) }
  }
  async function proof(action, data, signer) {
    return auth.createRequestProof(action, data, signer.privateJwk, signer.publicKey)
  }
  async function call(method, action, data, signer) {
    return relay[method](data, await proof(action, data, signer))
  }
  async function send(signer, recipient, content = 'private event', id = crypto.randomUUID()) {
    const data = { id, recipientPubKey: recipient.publicKey, encryptedData: await cryptography.encryptForPeer(content, signer.pair.privateKey, recipient.publicKey) }
    return { data, result: await call('storeEncryptedEvent', 'event:send', data, signer) }
  }
  async function feed(signer, after) {
    return call('getEventFeed', 'event:sync', after === undefined ? {} : { after }, signer)
  }
  return { sqlite, calls, db, load, relay, actions, POST, auth, cryptography, identity, proof, call, send, feed }
}

test('identity feed includes incoming, outgoing and self events, but never another identity conversation', async t => {
  const h = harness(t)
  const [alice, bob, mallory] = await Promise.all([h.identity(), h.identity(), h.identity()])
  const sent = await h.send(alice, bob, 'hello Bob')
  assert.deepEqual(sent.result, { success: true })
  const self = await h.send(alice, alice, 'note to myself')
  assert.equal(self.result.success, true)
  const a = await h.feed(alice), b = await h.feed(bob), m = await h.feed(mallory)
  assert.deepEqual(a.messages.map(x => x.id), [sent.data.id, self.data.id])
  assert.deepEqual(b.messages.map(x => x.id), [sent.data.id])
  assert.deepEqual(m, { success: true, messages: [], nextCursor: 0, hasMore: false })
  assert.equal(await h.cryptography.decryptFromPeer(a.messages[0].encryptedData, alice.pair.privateKey, bob.publicKey), 'hello Bob')
  assert.equal(await h.cryptography.decryptFromPeer(b.messages[0].encryptedData, bob.pair.privateKey, alice.publicKey), 'hello Bob')
  assert.equal(await h.cryptography.decryptFromPeer(a.messages[1].encryptedData, alice.pair.privateKey, alice.publicKey), 'note to myself')
  assert.deepEqual(await h.feed(alice), a, 'a second device can read the same retained events')
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM RelayEvent').get().n, 2)
})

test('event signatures bind payload and action; replay fails and fresh-proof retry deduplicates', async t => {
  const h = harness(t)
  const [alice, bob, mallory] = await Promise.all([h.identity(), h.identity(), h.identity()])
  const data = { id: crypto.randomUUID(), recipientPubKey: bob.publicKey, encryptedData: 'a'.repeat(100) }
  assert.equal((await h.actions.storeEncryptedEvent(data, undefined)).success, false)
  assert.equal(h.calls.length, 0, 'unsigned calls cannot initialize database tables')
  const proof = await h.proof('event:send', data, alice)
  assert.equal((await h.relay.storeEncryptedEvent(data, proof)).success, true)
  assert.match((await h.relay.storeEncryptedEvent(data, proof)).error, /already used/)
  const fresh = await h.proof('event:send', data, alice)
  assert.match((await h.relay.storeEncryptedEvent({ ...data, encryptedData: 'b'.repeat(100) }, fresh)).error, /verification failed/)
  assert.match((await h.relay.storeEncryptedEvent(data, { ...fresh, publicKey: mallory.publicKey })).error, /verification failed/)
  assert.equal((await h.call('storeEncryptedEvent', 'event:send', data, alice)).success, true)
  assert.equal((await h.call('storeEncryptedEvent', 'event:send', { ...data, encryptedData: 'changed'.repeat(20) }, alice)).success, true)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM RelayEvent').get().n, 1)
  assert.equal(h.sqlite.prepare('SELECT encryptedData FROM RelayEvent').get().encryptedData, data.encryptedData)
  const feedProof = await h.proof('event:sync', {}, alice)
  assert.match((await h.relay.getEventFeed({ after: 1 }, feedProof)).error, /verification failed/)
  assert.match((await h.relay.getEventFeed({}, await h.proof('message:inbox', {}, alice))).error, /verification failed/)
})

test('monotonic cursor has no timestamp ties, stays stable when empty, and survives deleted rows', async t => {
  const h = harness(t)
  const [alice, bob] = await Promise.all([h.identity(), h.identity()])
  assert.equal((await h.feed(alice)).success, true)
  const now = Date.now()
  const insert = h.sqlite.prepare('INSERT INTO RelayEvent(id,senderPubKey,recipientPubKey,encryptedData,payloadBytes,createdAt,expiresAt) VALUES(?,?,?,?,?,?,?)')
  for (let i = 0; i < 75; i++) insert.run(crypto.randomUUID(), alice.publicKey, bob.publicKey, 'a'.repeat(100), 100, now, now + 60000)
  const first = await h.feed(bob)
  assert.equal(first.messages.length, 50)
  assert.equal(first.hasMore, true)
  const second = await h.feed(bob, first.nextCursor)
  assert.equal(second.messages.length, 25)
  assert.equal(second.hasMore, false)
  assert.equal(new Set([...first.messages, ...second.messages].map(x => x.sequence)).size, 75)
  assert.deepEqual(await h.feed(bob, second.nextCursor), { success: true, messages: [], nextCursor: second.nextCursor, hasMore: false })
  h.sqlite.prepare('DELETE FROM RelayEvent').run()
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM RelayEventUsage').get().n, 0)
  const sent = await h.send(alice, bob)
  const later = await h.feed(bob, second.nextCursor)
  assert.equal(later.messages[0].id, sent.data.id)
  assert.ok(later.nextCursor > second.nextCursor)
  for (const after of [-1, 0.5, null, '2', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await h.call('getEventFeed', 'event:sync', { after }, bob)).success, false)
  }
})

test('legacy acknowledgement never removes sync history and the global legacy inbox is recipient scoped', async t => {
  const h = harness(t)
  const [alice, bob, carol, mallory] = await Promise.all([h.identity(), h.identity(), h.identity(), h.identity()])
  const event = await h.send(alice, bob)
  const legacy = { ...event.data }
  assert.equal((await h.call('storeEncryptedMessage', 'message:send', legacy, alice)).success, true)
  assert.equal((await h.call('storeEncryptedMessage', 'message:send', { ...legacy, id: crypto.randomUUID() }, carol)).success, true)
  const inbox = await h.call('getLegacyInbox', 'message:inbox', {}, bob)
  assert.equal(inbox.messages.length, 2)
  assert.deepEqual(new Set(inbox.messages.map(x => x.senderPubKey)), new Set([alice.publicKey, carol.publicKey]))
  assert.equal((await h.call('getLegacyInbox', 'message:inbox', {}, mallory)).messages.length, 0)
  await h.call('deleteMessage', 'message:ack', { id: legacy.id, senderPubKey: alice.publicKey }, bob)
  assert.equal((await h.feed(bob)).messages.length, 1)
  assert.equal((await h.feed(alice)).messages.length, 1)
})

test('legacy global inbox cursor includes sender tie breaker for equal timestamp and id', async t => {
  const h = harness(t)
  const [alice, bob, carol] = await Promise.all([h.identity(), h.identity(), h.identity()])
  await h.feed(bob)
  const [one, two] = [alice.publicKey, carol.publicKey].sort()
  const now = Date.now(), id = crypto.randomUUID()
  const insert = h.sqlite.prepare('INSERT INTO RelayMessage(id,senderPubKey,recipientPubKey,encryptedData,createdAt,expiresAt) VALUES(?,?,?,?,?,?)')
  insert.run(id, one, bob.publicKey, 'a'.repeat(100), now, now + 60000)
  insert.run(id, two, bob.publicKey, 'a'.repeat(100), now, now + 60000)
  const result = await h.call('getLegacyInbox', 'message:inbox', { after: { createdAt: now, id, senderPubKey: one } }, bob)
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].senderPubKey, two)
})

test('event packet allowance supports attachments without expanding any legacy packet or body limits', async t => {
  const h = harness(t)
  const [alice, bob] = await Promise.all([h.identity(), h.identity()])
  const data = { id: crypto.randomUUID(), recipientPubKey: bob.publicKey, encryptedData: 'a'.repeat(128000) }
  assert.equal((await h.call('storeEncryptedEvent', 'event:send', data, alice)).success, true)
  assert.equal((await h.feed(bob)).messages[0].encryptedData.length, 128000)
  assert.equal((await h.call('storeEncryptedEvent', 'event:send', { ...data, id: crypto.randomUUID(), encryptedData: 'a'.repeat(128001) }, alice)).success, false)
  assert.equal((await h.call('storeEncryptedMessage', 'message:send', { ...data, encryptedData: 'a'.repeat(64001) }, alice)).success, false)
  const request = { version: 2, action: 'message:send', data, proof: await h.proof('message:send', data, alice) }
  const response = await h.POST(new Request(`${origin}/api/relay`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-serotine-events': '1' }, body: JSON.stringify(request) }))
  assert.equal(response.status, 400, 'large-body header cannot open legacy actions')
  const huge = await h.POST(new Request(`${origin}/api/relay`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-serotine-events': '1' }, body: 'x'.repeat(148000) }))
  assert.equal(huge.status, 413)
})

test('expiry clears accounted bytes; storage budget is enforced atomically and duplicate retries still succeed', async t => {
  const h = harness(t)
  const [alice, bob] = await Promise.all([h.identity(), h.identity()])
  const one = await h.send(alice, bob)
  let usage = h.sqlite.prepare('SELECT * FROM RelayEventUsage').get()
  assert.equal(usage.eventCount, 1)
  assert.equal(usage.payloadBytes, new TextEncoder().encode(one.data.encryptedData).byteLength)
  h.sqlite.prepare('UPDATE RelayEvent SET expiresAt = ?').run(Date.now() - 1)
  assert.equal((await h.feed(bob)).messages.length, 0)
  const two = await h.send(alice, bob)
  assert.equal(two.result.success, true)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM RelayEvent').get().n, 1)
  usage = h.sqlite.prepare('SELECT * FROM RelayEventUsage').get()
  assert.equal(usage.eventCount, 1)
  h.sqlite.prepare('UPDATE RelayEventUsage SET eventCount = 16000').run()
  assert.match((await h.send(alice, bob)).result.error, /storage is full/)
  assert.equal((await h.call('storeEncryptedEvent', 'event:send', two.data, alice)).success, true)
  h.sqlite.prepare('UPDATE RelayEventUsage SET eventCount = 1, payloadBytes = 134217728').run()
  assert.match((await h.send(alice, bob)).result.error, /storage is full/)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM RelayEvent').get().n, 1)
})

test('event send requests are rate limited independently of legacy messages', async t => {
  const h = harness(t)
  const [alice, bob] = await Promise.all([h.identity(), h.identity()])
  await h.feed(alice)
  const insert = h.sqlite.prepare('INSERT INTO RequestNonce(publicKey,nonce,action,expiresAt) VALUES(?,?,?,?)')
  for (let i = 0; i < 2000; i++) insert.run(alice.publicKey, crypto.randomUUID(), 'event:send', Date.now() + 60000)
  assert.match((await h.send(alice, bob)).result.error, /Too many requests/)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM RelayEvent').get().n, 0)
  const legacy = { id: crypto.randomUUID(), recipientPubKey: bob.publicKey, encryptedData: 'a'.repeat(100) }
  assert.equal((await h.call('storeEncryptedMessage', 'message:send', legacy, alice)).success, true)
})

test('browser refuses corrupt feed cursors, ordering and identities before advancing sync', async t => {
  const h = harness(t)
  const [alice, bob, mallory] = await Promise.all([h.identity(), h.identity(), h.identity()])
  await h.send(alice, bob)
  const valid = await h.feed(bob)
  const variants = [
    { ...valid, nextCursor: valid.nextCursor + 1 },
    { ...valid, hasMore: true },
    { ...valid, messages: [...valid.messages, ...valid.messages] },
    { ...valid, messages: valid.messages.map(x => ({ ...x, recipientPubKey: mallory.publicKey })) },
    { ...valid, messages: valid.messages.map(x => ({ ...x, sequence: 0 })) },
  ]
  for (const variant of variants) {
    const relay = loader({}, { fetch: async () => Response.json(variant) })(path.join(root, 'lib/relay-client.ts'))
    await assert.rejects(relay.getEventFeed({}, { publicKey: bob.publicKey }), /unexpected response/)
  }
})
