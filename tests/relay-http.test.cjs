/* Exercise the actual HTTP route, browser client, signatures, actions, and SQLite. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { test } = require('node:test')
const ts = require('typescript')
const root = path.join(__dirname, '..')
const origin = 'https://serotine.example'

function loader({ stubs = {}, globals = {} } = {}) {
  const cache = new Map()
  function load(filename) {
    if (!path.extname(filename)) filename += '.ts'
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }; cache.set(filename, module)
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText
    const requireSource = specifier => {
      if (Object.hasOwn(stubs, specifier)) return stubs[specifier]
      if (specifier.startsWith('@/')) return load(path.join(root, specifier.slice(2)))
      if (specifier.startsWith('.')) return load(path.resolve(path.dirname(filename), specifier))
      return require(specifier)
    }
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
  const load = loader({ stubs: { '@opennextjs/cloudflare': { getCloudflareContext: () => ({ env: { serotine_db: db } }) } } })
  const cryptography = load(path.join(root, 'lib/crypto.ts'))
  const auth = load(path.join(root, 'lib/request-auth.ts'))
  const { POST } = load(path.join(root, 'app/api/relay/route.ts'))
  async function identity() {
    const pair = await cryptography.generateEncryptionKeyPair()
    return { pair, privateJwk: await cryptography.exportKey(pair.privateKey), publicKey: await cryptography.exportPublicKeyToHex(pair.publicKey) }
  }
  async function signed(action, data, signer) {
    return { version: 2, action, data, proof: await auth.createRequestProof(action, data, signer.privateJwk, signer.publicKey) }
  }
  async function post(body, headers = {}) {
    return POST(new Request(`${origin}/api/relay`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin, 'sec-fetch-site': 'same-origin', ...headers },
      body: JSON.stringify(body),
    }))
  }
  return { sqlite, calls, load, cryptography, auth, POST, identity, signed, post }
}

test('all five HTTP operations use real signatures and database actions; signed field order survives', async t => {
  const h = harness(t)
  const [alice, bob] = await Promise.all([h.identity(), h.identity()])
  // This intentionally differs from the action's declared property order.
  const data = { encryptedData: await h.cryptography.encryptForPeer('hello', alice.pair.privateKey, bob.publicKey), recipientPubKey: bob.publicKey, id: crypto.randomUUID() }
  const sent = await h.post(await h.signed('message:send', data, alice))
  assert.equal(sent.status, 200)
  assert.match(sent.headers.get('content-type'), /application\/json/)
  assert.match(sent.headers.get('cache-control'), /no-store/)
  assert.equal(sent.headers.get('x-content-type-options'), 'nosniff')
  assert.deepEqual(await sent.json(), { success: true })
  const listData = { senderPubKey: alice.publicKey }
  const listed = await (await h.post(await h.signed('message:list', listData, bob))).json()
  assert.equal(listed.messages.length, 1)
  assert.equal(listed.messages[0].encryptedData, data.encryptedData)
  assert.equal(listed.nextCursor, null)
  const ackData = { senderPubKey: alice.publicKey, id: data.id }
  assert.deepEqual(await (await h.post(await h.signed('message:ack', ackData, bob))).json(), { success: true })
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM RelayMessage').get().n, 0)
  const signalData = { encryptedData: data.encryptedData, recipientPubKey: bob.publicKey }
  assert.deepEqual(await (await h.post(await h.signed('signal:send', signalData, alice))).json(), { success: true })
  const signal = await (await h.post(await h.signed('signal:read', listData, bob))).json()
  assert.equal(signal.signal.encryptedData, data.encryptedData)
})

test('HTTP transport preserves replay protection, signed payload integrity, and recipient scope', async t => {
  const h = harness(t)
  const [alice, bob, mallory] = await Promise.all([h.identity(), h.identity(), h.identity()])
  const data = { id: crypto.randomUUID(), recipientPubKey: bob.publicKey, encryptedData: 'a'.repeat(100) }
  const request = await h.signed('message:send', data, alice)
  assert.equal((await (await h.post(request)).json()).success, true)
  assert.match((await (await h.post(request)).json()).error, /already used/)
  const forged = await h.signed('message:send', data, alice)
  forged.data = { ...data, encryptedData: 'b'.repeat(100) }
  assert.match((await (await h.post(forged)).json()).error, /verification failed/)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM RelayMessage').get().n, 1)
  const listData = { senderPubKey: alice.publicKey }
  assert.equal((await (await h.post(await h.signed('message:list', listData, mallory))).json()).messages.length, 0)
  const ackData = { id: data.id, senderPubKey: alice.publicKey }
  await h.post(await h.signed('message:ack', ackData, mallory))
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM RelayMessage').get().n, 1)
  const valid = await h.signed('message:list', listData, bob)
  assert.equal((await (await h.post(valid)).json()).messages.length, 1)
})

test('route rejects malformed/version/shape/auth requests before touching the database', async t => {
  const h = harness(t)
  const [alice, bob] = await Promise.all([h.identity(), h.identity()])
  const valid = await h.signed('message:send', { id: crypto.randomUUID(), recipientPubKey: bob.publicKey, encryptedData: 'a'.repeat(100) }, alice)
  for (const body of [null, [], 'text', { ...valid, version: 1 }, { ...valid, version: 3 },
    { ...valid, action: 'getDB' }, { ...valid, data: null }, { ...valid, data: [] },
    { ...valid, proof: null }, { ...valid, proof: {} }, { ...valid, proof: { ...valid.proof, signature: 'wrong' } },
    { ...valid, data: { ...valid.data, encryptedData: 25 } }, { ...valid, data: { ...valid.data, id: null } },
    { ...valid, data: { ...valid.data, extra: 'unexpected' } }, { ...valid, extra: true },
    { ...valid, action: 'message:list', data: { senderPubKey: alice.publicKey, after: { createdAt: -1, id: crypto.randomUUID() } } }]) {
    const result = await h.post(body)
    assert.ok(result.status >= 400, JSON.stringify(body))
    assert.equal((await result.json()).success, false)
  }
  const malformed = await h.POST(new Request(`${origin}/api/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' }))
  assert.equal(malformed.status, 400)
  const form = await h.post(valid, { 'content-type': 'text/plain' })
  assert.equal(form.status, 415)
  const forged = await h.post({ ...valid, proof: { ...valid.proof, signature: '0'.repeat(128) } })
  assert.match((await forged.json()).error, /verification failed/)
  assert.equal(h.calls.length, 0)
})

test('cross-origin and same-site browser calls are refused; nonbrowser signed requests are allowed', async t => {
  const h = harness(t)
  const alice = await h.identity()
  const body = await h.signed('message:list', { senderPubKey: alice.publicKey }, alice)
  for (const headers of [{ origin: 'https://other.example' }, { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
    assert.equal((await h.post(body, headers)).status, 403)
  }
  assert.equal(h.calls.length, 0)
  const response = await h.POST(new Request(`${origin}/api/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  assert.deepEqual(await response.json(), { success: true, messages: [], nextCursor: null })
})

test('body limit counts actual streamed bytes even with missing or false Content-Length; 64k packets fit', async t => {
  const h = harness(t)
  for (const declared of [undefined, '1']) {
    let cancelled = false
    const stream = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(30000)) },
      cancel() { cancelled = true },
    })
    const headers = { 'content-type': 'application/json' }
    if (declared) headers['content-length'] = declared
    const response = await h.POST(new Request(`${origin}/api/relay`, { method: 'POST', headers, body: stream, duplex: 'half' }))
    assert.equal(response.status, 413)
    assert.equal(cancelled, true)
  }
  assert.equal((await h.POST(new Request(`${origin}/api/relay`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '90000' }, body: '{}' }))).status, 413)
  assert.equal(h.calls.length, 0)
  const [alice, bob] = await Promise.all([h.identity(), h.identity()])
  const data = { id: crypto.randomUUID(), recipientPubKey: bob.publicKey, encryptedData: 'a'.repeat(64000) }
  assert.equal((await (await h.post(await h.signed('message:send', data, alice))).json()).success, true)
})

function client(fetch, timers = {}) {
  const load = loader({
    stubs: { '@/app/actions': new Proxy({}, { get() { throw new Error('Browser imported server actions at runtime') } }) },
    globals: { fetch, ...timers },
  })
  return load(path.join(root, 'lib/relay-client.ts'))
}

test('browser client uses one stable same-origin POST per typed operation and passes failures through', async () => {
  const calls = []
  const relay = client(async (url, init) => {
    calls.push({ url, init })
    const { action } = JSON.parse(init.body)
    return Response.json(action === 'message:list' ? { success: true, messages: [], nextCursor: null }
      : action === 'signal:read' ? { success: true, signal: null } : { success: true })
  })
  const data = { arbitrary: 'signed data untouched' }, proof = { arbitrary: 'proof untouched' }
  for (const [method, action] of [['storeEncryptedMessage', 'message:send'], ['getMyMessages', 'message:list'], ['deleteMessage', 'message:ack'], ['storeSignal', 'signal:send'], ['getSignal', 'signal:read']]) {
    assert.equal((await relay[method](data, proof)).success, true)
    const { url, init } = calls.at(-1)
    assert.equal(url, '/api/relay')
    assert.equal(init.method, 'POST')
    assert.equal(init.mode, 'same-origin')
    assert.equal(init.credentials, 'same-origin')
    assert.equal(init.redirect, 'error')
    assert.equal(init.cache, 'no-store')
    assert.equal(init.headers['Content-Type'], 'application/json')
    assert.deepEqual(JSON.parse(init.body), { version: 2, action, data, proof })
    assert.ok(init.signal instanceof AbortSignal)
  }
  assert.equal(calls.length, 5)
  const failure = { success: false, error: 'Identity verification failed. Check your device clock and reopen the app.' }
  assert.deepEqual(await client(async () => Response.json(failure)).getSignal({}, {}), failure)
})

test('browser client handles HTML, malformed success, missing routes, outages, and network failures safely without retries', async () => {
  const cases = [
    [() => new Response('<html>private proxy details</html>', { headers: { 'content-type': 'text/html' } }), /unexpected response/],
    [() => new Response('<private>', { headers: { 'content-type': 'application/json' } }), /unexpected response/],
    [() => Response.json({ success: true }), /unexpected response/],
    [() => Response.json({ success: true, messages: [null], nextCursor: null }), /unexpected response/],
    [() => Response.json({ success: false, error: '<html>private error</html>' }), /unexpected response/],
    [() => new Response('private route diagnostics', { status: 404 }), /missing the messaging relay/],
    [() => Response.json({ success: false, error: 'private server error' }, { status: 503 }), /temporarily unavailable/],
    [() => { throw new Error('private network details') }, /Check your connection/],
  ]
  for (const [response, expected] of cases) {
    let calls = 0, signal
    const relay = client(async (_, init) => { calls++; signal = init.signal; return response() })
    await assert.rejects(relay.getMyMessages({}, {}), error => {
      assert.match(error.message, expected)
      assert.doesNotMatch(error.message, /private|<html>/)
      return true
    })
    assert.equal(calls, 1)
    assert.equal(signal.aborted, true, 'stop unread response bodies after header errors')
  }
  let writes = 0
  const relay = client(async () => { writes++; throw new Error('lost response') })
  await assert.rejects(relay.storeEncryptedMessage({}, {}), /not been confirmed/)
  assert.equal(writes, 1)
})

test('a stalled inbox fetch cannot queue or block an independent message send', { timeout: 1000 }, async t => {
  let releaseInbox, sendCompleted = false
  const actions = []
  const relay = client(async (_, init) => {
    const { action } = JSON.parse(init.body)
    actions.push(action)
    if (action === 'message:list') return new Promise(resolve => { releaseInbox = () => resolve(Response.json({ success: true, messages: [], nextCursor: null })) })
    return Response.json({ success: true })
  })
  const inbox = relay.getMyMessages({}, {})
  t.after(() => releaseInbox?.())
  const sent = await relay.storeEncryptedMessage({}, {}).then(result => { sendCompleted = true; return result })
  assert.deepEqual(sent, { success: true })
  assert.equal(sendCompleted, true)
  assert.deepEqual(actions, ['message:list', 'message:send'])
  releaseInbox()
  assert.equal((await inbox).success, true)
})

test('15-second timeout aborts both a stalled fetch and a stalled response body and clears its timer', async () => {
  for (const stalledBody of [false, true]) {
    let expire, delay, signal, cleared = false, calls = 0, bodyRead = false
    const relay = client(async (_, init) => {
      calls++; signal = init.signal
      if (!stalledBody) return new Promise(() => {})
      return { status: 200, ok: true, headers: new Headers({ 'content-type': 'application/json' }), json() { bodyRead = true; return new Promise(() => {}) } }
    }, { setTimeout(fn, ms) { expire = fn; delay = ms; return 123 }, clearTimeout(id) { cleared = id === 123 } })
    const pending = relay.storeEncryptedMessage({}, {})
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(delay, 15000)
    assert.equal(bodyRead, stalledBody)
    expire()
    await assert.rejects(pending, /took too long.*not been confirmed/)
    assert.equal(signal.aborted, true)
    assert.equal(cleared, true)
    assert.equal(calls, 1)
  }
})

test('actual browser client reaches HTTP route and SQLite without Server Action transport', async t => {
  const h = harness(t)
  const [alice, bob] = await Promise.all([h.identity(), h.identity()])
  const relay = client(async (url, init) => h.POST(new Request(`${origin}${url}`, init)))
  const data = { id: crypto.randomUUID(), recipientPubKey: bob.publicKey, encryptedData: 'a'.repeat(100) }
  const sent = await h.signed('message:send', data, alice)
  assert.deepEqual(await relay.storeEncryptedMessage(sent.data, sent.proof), { success: true })
  const request = await h.signed('message:list', { senderPubKey: alice.publicKey }, bob)
  const inbox = await relay.getMyMessages(request.data, request.proof)
  assert.equal(inbox.messages[0].id, data.id)
})
