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

function harness(t, hooks = {}) {
  const sqlite = new DatabaseSync(':memory:')
  t.after(() => sqlite.close())
  const calls = []
  const db = {
    prepare(sql) {
      calls.push(sql)
      let args = []
      return {
        bind(...values) { args = values; return this },
        async run() {
          if (hooks.beforeRun) await hooks.beforeRun(sql, args, sqlite)
          return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }
        },
        async first() {
          if (hooks.beforeRead) await hooks.beforeRead(sql, args, sqlite)
          const result = sqlite.prepare(sql).get(...args) ?? null
          if (hooks.afterRead) hooks.afterRead(sql, result)
          return result
        },
        async all() {
          if (hooks.beforeRead) await hooks.beforeRead(sql, args, sqlite)
          const results = sqlite.prepare(sql).all(...args)
          if (hooks.afterRead) hooks.afterRead(sql, results)
          return { results }
        },
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

test('legacy inline files coexist with smaller event and signal packet allowances', async t => {
  const h = harness(t)
  const { MAX_PACKET_LENGTH, MAX_EVENT_PACKET_LENGTH, MAX_SIGNAL_PACKET_LENGTH } = h.load(path.join(root, 'lib/protocol.ts'))
  const [alice, bob] = await Promise.all([h.identity(), h.identity()])
  const data = { id: crypto.randomUUID(), recipientPubKey: bob.publicKey, encryptedData: 'a'.repeat(MAX_EVENT_PACKET_LENGTH) }
  assert.equal((await h.call('storeEncryptedEvent', 'event:send', data, alice)).success, true)
  assert.equal((await h.feed(bob)).messages[0].encryptedData.length, MAX_EVENT_PACKET_LENGTH)
  assert.equal((await h.call('storeEncryptedEvent', 'event:send', { ...data, id: crypto.randomUUID(), encryptedData: 'a'.repeat(MAX_EVENT_PACKET_LENGTH + 1) }, alice)).success, false)
  const legacy = { ...data, encryptedData: 'a'.repeat(MAX_PACKET_LENGTH) }
  assert.equal((await h.call('storeEncryptedMessage', 'message:send', legacy, alice)).success, true)
  assert.equal((await h.call('getLegacyInbox', 'message:inbox', {}, bob)).messages[0].encryptedData.length, MAX_PACKET_LENGTH)
  assert.equal((await h.call('storeSignal', 'signal:send', { recipientPubKey: bob.publicKey, encryptedData: 'a'.repeat(MAX_SIGNAL_PACKET_LENGTH + 1) }, alice)).success, false)
  const request = { version: 2, action: 'message:send', data, proof: await h.proof('message:send', data, alice) }
  const response = await h.POST(new Request(`${origin}/api/relay`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-serotine-events': '1' }, body: JSON.stringify(request) }))
  assert.equal(response.status, 400, 'event transport header cannot open legacy actions')
  const huge = await h.POST(new Request(`${origin}/api/relay`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-serotine-events': '1' }, body: 'x'.repeat(148000) }))
  assert.equal(huge.status, 413)
})

test('global legacy inbox bounds full-size file pages and preserves sender ties at the page boundary', async t => {
  const h = harness(t)
  const { MAX_PACKET_LENGTH, MESSAGE_PAGE_SIZE } = h.load(path.join(root, 'lib/protocol.ts'))
  const bob = await h.identity()
  const senders = (await Promise.all(Array.from({ length: MESSAGE_PAGE_SIZE + 1 }, () => h.identity())))
    .map(identity => identity.publicKey).sort()
  await h.feed(bob)
  const now = Date.now(), id = crypto.randomUUID()
  const insert = h.sqlite.prepare('INSERT INTO RelayMessage(id,senderPubKey,recipientPubKey,encryptedData,createdAt,expiresAt) VALUES(?,?,?,?,?,?)')
  for (const sender of senders) insert.run(id, sender, bob.publicKey, 'a'.repeat(MAX_PACKET_LENGTH), now, now + 60000)
  const first = await h.call('getLegacyInbox', 'message:inbox', {}, bob)
  assert.equal(first.messages.length, MESSAGE_PAGE_SIZE)
  assert.equal(first.messages.reduce((bytes, message) => bytes + Buffer.byteLength(message.encryptedData), 0), MESSAGE_PAGE_SIZE * MAX_PACKET_LENGTH)
  assert.deepEqual(first.nextCursor, { createdAt: now, id, senderPubKey: senders[MESSAGE_PAGE_SIZE - 1] })
  const second = await h.call('getLegacyInbox', 'message:inbox', { after: first.nextCursor }, bob)
  assert.deepEqual(second.messages.map(message => message.senderPubKey), senders.slice(MESSAGE_PAGE_SIZE))
  assert.equal(second.nextCursor, null)
})

test('expiry clears accounted bytes; storage budget is enforced atomically and duplicate retries still succeed', async t => {
  const h = harness(t)
  const { MAX_RETAINED_EVENT_COUNT, MAX_RETAINED_EVENT_BYTES } = h.load(path.join(root, 'lib/protocol.ts'))
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
  h.sqlite.prepare('UPDATE RelayEventUsage SET eventCount = ?').run(MAX_RETAINED_EVENT_COUNT)
  assert.match((await h.send(alice, bob)).result.error, /storage is full/)
  assert.equal((await h.call('storeEncryptedEvent', 'event:send', two.data, alice)).success, true)
  h.sqlite.prepare('UPDATE RelayEventUsage SET eventCount = 1, payloadBytes = ?').run(MAX_RETAINED_EVENT_BYTES)
  assert.match((await h.send(alice, bob)).result.error, /storage is full/)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM RelayEvent').get().n, 1)
})

test('event send requests are rate limited independently of legacy messages', async t => {
  const h = harness(t)
  const { MAX_EVENT_SENDS_PER_MINUTE } = h.load(path.join(root, 'lib/protocol.ts'))
  const [alice, bob] = await Promise.all([h.identity(), h.identity()])
  await h.feed(alice)
  const insert = h.sqlite.prepare('INSERT INTO RequestNonce(publicKey,nonce,action,expiresAt) VALUES(?,?,?,?)')
  for (let i = 0; i < MAX_EVENT_SENDS_PER_MINUTE; i++) insert.run(alice.publicKey, crypto.randomUUID(), 'event:send', Date.now() + 60000)
  const limited = (await h.send(alice, bob)).result
  assert.match(limited.error, /Too many requests/)
  assert.equal(limited.retryAfterMs, 61000)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM RelayEvent').get().n, 0)
  const legacy = { id: crypto.randomUUID(), recipientPubKey: bob.publicKey, encryptedData: 'a'.repeat(100) }
  assert.equal((await h.call('storeEncryptedMessage', 'message:send', legacy, alice)).success, true)
})

test('a 12 MiB file traverses signed group events, encrypted HTTP relay pages and verified assembly', async t => {
  const h = harness(t)
  const participants = await Promise.all(Array.from({ length: 20 }, () => h.identity()))
  const [alice, bob] = participants
  const signer = { version: 2, publicKey: alice.publicKey, privateKey: alice.privateJwk }
  const files = h.load(path.join(root, 'lib/attachments.ts'))
  const messaging = h.load(path.join(root, 'lib/messaging.ts'))
  const { MAX_RETAINED_EVENT_BYTES, MAX_RETAINED_EVENT_COUNT, MAX_EVENT_PACKET_LENGTH } = h.load(path.join(root, 'lib/protocol.ts'))
  const original = Uint8Array.from({ length: 12 * 1024 * 1024 }, (_, i) => i % 251)
  const group = await messaging.signGroup({ id: `group:${crypto.randomUUID()}`, admin: alice.publicKey,
    members: participants.map(p => p.publicKey), name: 'A complete twenty-member group', epoch: 1, updatedAt: Date.now() }, signer)
  let totalCiphertext = 0, count = 0
  await files.sendAttachment(async (conversationId, kind, payload) => {
    const event = await messaging.signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: alice.publicKey,
      conversationId, recipients: participants.slice(1).map(p => p.publicKey), timestamp: Date.now(), kind, payload, group }, signer)
    assert.equal(await messaging.validateMessagingEvent(event), true)
    const sent = await h.send(alice, bob, JSON.stringify(event), event.id)
    assert.equal(sent.result.success, true, sent.result.error)
    assert.ok(sent.data.encryptedData.length <= MAX_EVENT_PACKET_LENGTH)
    totalCiphertext += Buffer.byteLength(sent.data.encryptedData)
    count++
    return event.id
  }, group.id, new File([original], 'large-project.zip', { type: 'application/zip' }), 'file', undefined, undefined, group)
  assert.equal(count, Math.ceil(original.length / files.ATTACHMENT_CHUNK_BYTES) + 1)
  assert.ok(totalCiphertext * 19 < MAX_RETAINED_EVENT_BYTES, 'all nineteen encrypted copies fit the sender budget')
  assert.ok(count * 19 < MAX_RETAINED_EVENT_COUNT)
  let after = 0, metadata, hasMore = true
  const chunks = []
  while (hasMore) {
    const page = await h.feed(bob, after)
    assert.equal(page.success, true)
    for (const packet of page.messages) {
      const event = JSON.parse(await h.cryptography.decryptFromPeer(packet.encryptedData, bob.pair.privateKey, alice.publicKey))
      assert.equal(await messaging.validateMessagingEvent(event, packet), true)
      if (event.kind === 'attachment') metadata = event.payload.attachment
      else chunks.push({ index: event.payload.index, data: event.payload.data })
    }
    after = page.nextCursor
    hasMore = page.hasMore
  }
  assert.equal(metadata.size, 12 * 1024 * 1024)
  assert.deepEqual(new Uint8Array(await (await files.assembleAttachment(metadata, chunks.toReversed())).arrayBuffer()), original)
  const invalid = await messaging.signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: alice.publicKey,
    conversationId: bob.publicKey, recipients: [bob.publicKey], timestamp: Date.now(), kind: 'attachment-chunk',
    payload: { attachmentId: metadata.id, index: files.MAX_ATTACHMENT_CHUNKS, data: '' } }, signer)
  assert.equal(await messaging.validateMessagingEvent(invalid), false, 'a signed chunk beyond the file cap is refused')
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

test('retirement is signed, self-only, permanent and safe to retry after a lost response', async t => {
  const h = harness(t)
  const [alice, bob] = await Promise.all([h.identity(), h.identity()])
  assert.equal((await h.actions.retireIdentity({}, undefined)).success, false)
  assert.equal(h.calls.length, 0, 'unsigned requests cannot initialize retirement tables')
  const forged = await h.proof('identity:retire', {}, alice)
  assert.equal((await h.relay.retireIdentity({}, { ...forged, publicKey: bob.publicKey })).success, false)
  const badData = { publicKey: bob.publicKey }
  const badProof = await h.proof('identity:retire', badData, alice)
  assert.equal((await h.actions.retireIdentity(badData, badProof)).success, false, 'Server Action rejects target identities')
  assert.equal((await h.relay.retireIdentity(badData, badProof)).success, false, 'HTTP route rejects target identities')
  const wrongAction = await h.proof('event:sync', {}, alice)
  assert.equal((await h.relay.retireIdentity({}, wrongAction)).success, false)
  assert.deepEqual(await h.relay.retireIdentity({}, forged), { success: true })
  const first = h.sqlite.prepare('SELECT * FROM RetiredIdentity').get()
  assert.equal(first.publicKey, alice.publicKey)
  assert.ok(first.retiredAt > 0)
  assert.match((await h.relay.retireIdentity({}, forged)).error, /already used/)
  assert.deepEqual(await h.call('retireIdentity', 'identity:retire', {}, alice), { success: true })
  assert.deepEqual(h.sqlite.prepare('SELECT * FROM RetiredIdentity').get(), first, 'retry does not replace the original retirement')
  h.sqlite.prepare('UPDATE RetiredIdentity SET retiredAt = 1').run()
  assert.match((await h.feed(alice)).error, /permanently retired/)
  assert.equal((await h.feed(bob)).success, true, 'other identities are unaffected')
})

test('retired backup keys lose all relay access without deleting history; recipients reject further sends', async t => {
  const h = harness(t)
  const [alice, bob] = await Promise.all([h.identity(), h.identity()])
  const event = await h.send(alice, bob)
  const legacy = { id: crypto.randomUUID(), recipientPubKey: alice.publicKey, encryptedData: 'a'.repeat(100) }
  assert.equal((await h.call('storeEncryptedMessage', 'message:send', legacy, bob)).success, true)
  const signal = { recipientPubKey: alice.publicKey, encryptedData: 'b'.repeat(100) }
  assert.equal((await h.call('storeSignal', 'signal:send', signal, bob)).success, true)
  assert.equal((await h.call('retireIdentity', 'identity:retire', {}, alice)).success, true)
  const toBob = { id: crypto.randomUUID(), recipientPubKey: bob.publicKey, encryptedData: 'c'.repeat(100) }
  const requests = [
    ['storeEncryptedMessage', 'message:send', toBob],
    ['getMyMessages', 'message:list', { senderPubKey: bob.publicKey }],
    ['getLegacyInbox', 'message:inbox', {}],
    ['deleteMessage', 'message:ack', { id: legacy.id, senderPubKey: bob.publicKey }],
    ['storeSignal', 'signal:send', { recipientPubKey: bob.publicKey, encryptedData: 'd'.repeat(100) }],
    ['getSignal', 'signal:read', { senderPubKey: bob.publicKey }],
    ['storeEncryptedEvent', 'event:send', toBob],
    ['getEventFeed', 'event:sync', {}],
  ]
  for (const [method, action, data] of requests) {
    assert.match((await h.call(method, action, data, alice)).error, /permanently retired/, method)
    assert.match((await h.actions[method](data, await h.proof(action, data, alice))).error, /permanently retired/, `${method} direct Server Action`)
  }
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM RelayMessage').get().n, 1)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM RelaySignal').get().n, 1)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM RelayEvent').get().n, 1)
  assert.deepEqual((await h.feed(bob)).messages.map(message => message.id), [event.data.id], 'other participants retain their history')
  for (const [method, action, data] of [
    ['storeEncryptedMessage', 'message:send', { ...legacy, id: crypto.randomUUID() }],
    ['storeEncryptedEvent', 'event:send', { ...legacy, id: crypto.randomUUID() }],
    ['storeSignal', 'signal:send', signal],
  ]) assert.match((await h.call(method, action, data, bob)).error, /contact's address has been permanently retired/, method)
})

test('retirement racing a send prevents writes atomically for old senders and recipients', async t => {
  for (const [method, action, table] of [
    ['storeEncryptedMessage', 'message:send', 'RelayMessage'],
    ['storeEncryptedEvent', 'event:send', 'RelayEvent'],
    ['storeSignal', 'signal:send', 'RelaySignal'],
  ]) {
    for (const target of ['sender', 'recipient']) {
      const hooks = {}
      const h = harness(t, hooks)
      const [alice, bob] = await Promise.all([h.identity(), h.identity()])
      const retirePublicKey = target === 'sender' ? alice.publicKey : bob.publicKey
      hooks.beforeRun = (sql, args, db) => {
        if (sql.startsWith(`INSERT INTO ${table} `)) {
          db.prepare('INSERT INTO RetiredIdentity VALUES(?, ?)').run(retirePublicKey, Date.now())
          delete hooks.beforeRun
        }
      }
      const data = { recipientPubKey: bob.publicKey, encryptedData: 'x'.repeat(100), ...(action !== 'signal:send' ? { id: crypto.randomUUID() } : {}) }
      assert.match((await h.call(method, action, data, alice)).error, /permanently retired/, `${method} ${target}`)
      assert.equal(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0)
    }
  }
})

test('retirement bootstrap matches its migration and preserves preexisting revocations', async t => {
  const h = harness(t)
  const expected = new DatabaseSync(':memory:'); t.after(() => expected.close())
  expected.exec(fs.readFileSync(path.join(root, 'migrations/0003_retired_identities.sql'), 'utf8'))
  const { ensureIdentityRetirementSchema } = h.load(path.join(root, 'lib/identity-retirement-schema.ts'))
  await ensureIdentityRetirementSchema(h.db)
  const query = "SELECT sql FROM sqlite_master WHERE name = 'RetiredIdentity'"
  assert.equal(h.sqlite.prepare(query).get().sql, expected.prepare(query).get().sql)
  h.sqlite.prepare('INSERT INTO RetiredIdentity VALUES(?, 1)').run('old-address')
  await ensureIdentityRetirementSchema(h.db)
  assert.equal(h.sqlite.prepare('SELECT publicKey FROM RetiredIdentity').get().publicKey, 'old-address')
})

test('retirement racing inbox, feed, or signal reads prevents ciphertext from leaving SQLite', async t => {
  for (const [method, action, table] of [
    ['getMyMessages', 'message:list', 'RelayMessage'],
    ['getLegacyInbox', 'message:inbox', 'RelayMessage'],
    ['getEventFeed', 'event:sync', 'RelayEvent'],
    ['getSignal', 'signal:read', 'RelaySignal'],
  ]) {
    const hooks = {}, h = harness(t, hooks)
    const [alice, bob] = await Promise.all([h.identity(), h.identity()])
    const message = { id: crypto.randomUUID(), recipientPubKey: alice.publicKey, encryptedData: 'a'.repeat(100) }
    assert.equal((await h.call('storeEncryptedMessage', 'message:send', message, bob)).success, true)
    assert.equal((await h.send(bob, alice)).result.success, true)
    assert.equal((await h.call('storeSignal', 'signal:send', { recipientPubKey: alice.publicKey, encryptedData: 'b'.repeat(100) }, bob)).success, true)
    let raced = false, databaseResult
    const matches = sql => sql.startsWith('SELECT ') && sql.includes(` FROM ${table}\n`) && sql.includes('encryptedData')
      || (table === 'RelaySignal' && sql.startsWith('SELECT encryptedData FROM RelaySignal WHERE'))
    hooks.beforeRead = (sql, args, db) => {
      if (matches(sql)) {
        db.prepare('INSERT INTO RetiredIdentity VALUES(?, ?)').run(alice.publicKey, Date.now())
        delete hooks.beforeRead
        raced = true
      }
    }
    hooks.afterRead = (sql, result) => { if (matches(sql)) databaseResult = result }
    const data = action === 'message:list' || action === 'signal:read' ? { senderPubKey: bob.publicKey } : {}
    assert.match((await h.call(method, action, data, alice)).error, /permanently retired/, method)
    assert.equal(raced, true, `${method} raced immediately before the actual read`)
    assert.deepEqual(databaseResult, action === 'signal:read' ? null : [], `${method} SQL itself refuses access`)
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 1, 'history remains intact')
  }
})

test('retirement racing legacy acknowledgement leaves the queued message untouched', async t => {
  const hooks = {}, h = harness(t, hooks)
  const [alice, bob] = await Promise.all([h.identity(), h.identity()])
  const message = { id: crypto.randomUUID(), recipientPubKey: alice.publicKey, encryptedData: 'a'.repeat(100) }
  assert.equal((await h.call('storeEncryptedMessage', 'message:send', message, bob)).success, true)
  let raced = false
  hooks.beforeRun = (sql, args, db) => {
    if (sql.startsWith('DELETE FROM RelayMessage WHERE id =')) {
      db.prepare('INSERT INTO RetiredIdentity VALUES(?, ?)').run(alice.publicKey, Date.now())
      delete hooks.beforeRun
      raced = true
    }
  }
  assert.match((await h.call('deleteMessage', 'message:ack', { id: message.id, senderPubKey: bob.publicKey }, alice)).error, /permanently retired/)
  assert.equal(raced, true)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM RelayMessage').get().n, 1)
})
