const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { test } = require('node:test')
const ts = require('typescript')
const root = path.join(__dirname, '..')
const origin = 'https://serotine.example'

function harness(t) {
  const sqlite = new DatabaseSync(':memory:')
  t.after(() => sqlite.close())
  const calls = [], queries = []
  const state = { now: Date.now(), fetch: null, timers: new Map(), fakeTimers: false }
  class Clock extends Date { static now() { return state.now } }
  const db = { prepare(sql) {
    let values = []
    const statement = { bind(...items) { values = items; return statement },
      async run() { queries.push({ sql, values }); return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } } },
      async first() { queries.push({ sql, values }); return sqlite.prepare(sql).get(...values) ?? null },
      async all() { queries.push({ sql, values }); return { results: sqlite.prepare(sql).all(...values) } } }
    return statement
  } }
  const env = { SEROTINE_STORAGE_VERSION: '1', serotine_db: db, SUMMARY_AI_ENABLED: 'true',
    AI: { async run(model, input, options) {
      calls.push({ model, input, options })
      if (state.provider) return state.provider(model, input, options)
      return { response: 'The group agreed to meet on Friday.' }
    } } }
  const cache = new Map()
  function load(filename) {
    if (!path.extname(filename)) filename += '.ts'
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }; cache.set(filename, module)
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const sourceRequire = name => {
      if (name === 'server-only') return {}
      if (name === '@opennextjs/cloudflare') return { getCloudflareContext: async () => ({ env }) }
      if (name.startsWith('@/')) return load(path.join(root, name.slice(2)))
      if (name.startsWith('.')) return load(path.resolve(path.dirname(filename), name))
      return require(name)
    }
    new Function('require', 'module', 'exports', 'Date', 'fetch', 'setTimeout', 'clearTimeout', source)(
      sourceRequire, module, module.exports, Clock,
      (...args) => { if (!state.fetch) throw Error('Unexpected fetch'); return state.fetch(...args) },
      (fn, ms) => { if (!state.fakeTimers) return setTimeout(fn, ms); const id = Symbol(); state.timers.set(id, { fn, ms }); return id },
      id => { if (state.timers.has(id)) state.timers.delete(id); else clearTimeout(id) })
    return module.exports
  }
  const summary = load(path.join(root, 'lib/ai-summary.ts'))
  const routes = load(path.join(root, 'app/api/plugins/summary/route.ts'))
  const client = load(path.join(root, 'lib/ai-summary-client.ts'))
  const cryptography = load(path.join(root, 'lib/crypto.ts'))
  const auth = load(path.join(root, 'lib/request-auth.ts'))
  async function identity() {
    const pair = await cryptography.generateEncryptionKeyPair()
    return { version: 2, privateKey: await cryptography.exportKey(pair.privateKey), publicKey: await cryptography.exportPublicKeyToHex(pair.publicKey) }
  }
  const data = () => ({ messages: [{ speaker: 'Participant 1', text: 'Can we meet on Friday?' }] })
  async function signed(who, payload = data(), action = summary.SUMMARY_ACTION) {
    return { version: 1, action, data: payload, proof: await auth.createRequestProof(action, payload, who.privateKey, who.publicKey) }
  }
  function post(envelope, headers = {}) {
    const request = new Request(`${origin}/api/plugins/summary`, { method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(envelope) })
    return routes.POST(request)
  }
  return { sqlite, state, db, env, calls, queries, summary, routes, client, auth, identity, data, signed, post, load }
}

function message(id, content, overrides = {}) {
  return { id, conversationId: 'chat', senderPubKey: 'peer', content, timestamp: 1000 + Number(id), delivery: 'received', pinned: false, deliveredTo: [], readBy: [], ...overrides }
}

test('range starts after the last meaningful sent reply and never falls back after the last reply', t => {
  const h = harness(t)
  const messages = [message('1', 'old'), message('2', 'Last reply', { senderPubKey: 'self', delivery: 'sent' }), message('3', 'new'),
    message('4', '   ', { senderPubKey: 'self' }), message('5', 'unsent', { senderPubKey: 'self', delivery: 'failed' })]
  const copy = JSON.stringify(messages)
  const range = h.summary.selectSummaryRange(messages.reverse(), 'chat', 'self', 2000)
  assert.equal(range.mode, 'since-reply')
  assert.deepEqual(range.messages, [{ speaker: 'Participant 1', text: 'new' }])
  assert.equal(range.excludedCount, 2)
  assert.equal(range.fromTimestamp, 1003)
  assert.equal(JSON.stringify(messages.reverse()), copy)
  assert.deepEqual(h.summary.selectSummaryRange([message('1', 'reply', { senderPubKey: 'self' })], 'chat', 'self', 2000).messages, [])
})

test('no-reply range uses only 24 hours of recent ordinary text and excludes sensitive records and metadata', t => {
  const h = harness(t), now = h.state.now
  const secretKey = '04' + 'a'.repeat(128)
  const messages = [message('1', 'old', { timestamp: now - 86_400_001 }), message('2', 'ordinary', { timestamp: now - 100 }),
    message('3', 'private secret', { timestamp: now - 90, private: true }),
    message('4', 'secret text', { timestamp: now - 80, secret: true }),
    message('5', 'expiry', { timestamp: now - 70, expiresAt: now + 300_000 }),
    message('6', 'attachment caption', { timestamp: now - 60, attachment: { name: 'private.pdf', key: 'secret' } }),
    message('7', 'poll title', { timestamp: now - 50, poll: { question: 'Secret poll', votes: { key: 1 } } }),
    message('8', 'unrelated', { timestamp: now - 40, conversationId: 'different' }),
    message('9', `Ask @${secretKey}`, { timestamp: now - 30, senderPubKey: 'second-peer', mentions: [secretKey], deliveredTo: ['key'] }),
    message('10', 'future', { timestamp: now + 1 }), message('11', 'pending', { timestamp: now - 20, delivery: 'pending' })]
  const range = h.summary.selectSummaryRange(messages, 'chat', 'self', now)
  assert.equal(range.mode, 'recent')
  assert.equal(range.excludedCount, 6)
  assert.deepEqual(range.messages, [{ speaker: 'Participant 1', text: 'ordinary' }, { speaker: 'Participant 2', text: 'Ask [address]' }])
  assert.doesNotMatch(JSON.stringify(range), /secret|second-peer|private\.pdf|deliveredTo|mentions|04aaaa/)
})

test('range keeps newest bounded messages and clips oversized text exactly as previewed', t => {
  const h = harness(t), { selectSummaryRange, isSummaryMessages, SUMMARY_MAX_MESSAGES, SUMMARY_MAX_TEXT, SUMMARY_MAX_MESSAGE_TEXT } = h.summary
  const many = Array.from({ length: 100 }, (_, index) => message(String(index), `message ${index}`))
  const range = selectSummaryRange(many, 'chat', 'self', 2000)
  assert.equal(range.messages.length, SUMMARY_MAX_MESSAGES)
  assert.equal(range.messages[0].text, 'message 20')
  assert.equal(range.messages.at(-1).text, 'message 99')
  assert.equal(range.truncated, true)
  assert.equal(isSummaryMessages(range.messages), true)
  const clipped = selectSummaryRange(Array.from({ length: 8 }, (_, index) => message(String(index), 'x'.repeat(3000))), 'chat', 'self', 2000)
  assert.equal(clipped.messages.reduce((sum, item) => sum + item.text.length, 0), SUMMARY_MAX_TEXT)
  assert.equal(clipped.messages.every(item => item.text.length <= SUMMARY_MAX_MESSAGE_TEXT), true)
  assert.equal(clipped.truncated, true)
  assert.equal(isSummaryMessages(clipped.messages), true)
})

test('message validation rejects extra data, identities, counts and text-budget bypasses', t => {
  const h = harness(t), valid = h.data().messages[0]
  const invalid = [[], [{ ...valid, senderPubKey: 'leak' }], [{ ...valid, speaker: 'Alice' }], [{ ...valid, speaker: 'Participant 81' }],
    [{ ...valid, text: '   ' }], [{ ...valid, text: 'x'.repeat(2001) }], Array.from({ length: 81 }, () => valid),
    Array.from({ length: 7 }, () => ({ ...valid, text: 'x'.repeat(2000) }))]
  for (const messages of invalid) assert.equal(h.summary.isSummaryMessages(messages), false)
})

test('signed same-origin request sends only preview labels/text to provider and stores no content', async t => {
  const h = harness(t), who = await h.identity(), payload = h.data()
  const response = await h.post(await h.signed(who, payload))
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { success: true, summary: 'The group agreed to meet on Friday.' })
  assert.match(response.headers.get('cache-control'), /no-store/)
  assert.equal(h.calls.length, 1)
  const { model, input, options } = h.calls[0]
  assert.equal(model, '@cf/meta/llama-3.1-8b-instruct')
  assert.deepEqual(JSON.parse(input.messages[1].content), payload.messages)
  assert.equal(input.max_tokens, 512)
  assert.equal(input.stream, false)
  assert.match(input.messages[0].content, /untrusted conversation data/)
  assert.equal(options.signal.aborted, false)
  assert.doesNotMatch(JSON.stringify(input), /publicKey|privateKey|nonce|conversationId/)
  assert.equal(h.queries.some(query => JSON.stringify(query.values).includes(payload.messages[0].text)), false)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS count FROM RequestNonce').get().count, 1)
})

test('wrong or missing origin, extra envelope data and malformed body never invoke provider', async t => {
  const h = harness(t), who = await h.identity(), body = await h.signed(who)
  assert.equal((await h.post(body, { origin: 'https://attacker.example' })).status, 403)
  assert.equal((await h.post(body, { 'sec-fetch-site': 'cross-site' })).status, 403)
  assert.equal((await h.routes.POST(new Request(`${origin}/api/plugins/summary`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))).status, 403)
  assert.equal((await h.post({ ...body, extras: 'leak' })).status, 400)
  assert.equal((await h.post(body, { 'content-type': 'text/plain' })).status, 415)
  assert.equal((await h.post(body, { 'content-length': '80001' })).status, 413)
  assert.equal((await h.routes.POST(new Request(`${origin}/api/plugins/summary`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{broken' }))).status, 400)
  assert.equal((await h.routes.POST(new Request(`${origin}/api/plugins/summary`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: 'x'.repeat(80001) }))).status, 413)
  assert.equal(h.calls.length, 0)
})

test('signature binds exact payload and action; stale, invalid and replayed proofs fail', async t => {
  const h = harness(t), who = await h.identity(), body = await h.signed(who)
  const tampered = { ...body, data: { messages: [{ speaker: 'Participant 1', text: 'Tampered' }] } }
  assert.equal((await h.post(tampered)).status, 401)
  assert.equal((await h.post({ ...body, proof: undefined })).status, 400)
  const wrongAction = await h.signed(who, body.data, 'event:send')
  assert.equal((await h.post({ ...wrongAction, action: 'plugin:summary' })).status, 401)
  const stale = { ...body, proof: await h.auth.createRequestProof('plugin:summary', body.data, who.privateKey, who.publicKey, h.state.now - 61_000) }
  assert.equal((await h.post(stale)).status, 401)
  assert.equal((await h.post(body)).status, 200)
  assert.equal((await h.post(body)).status, 409)
  assert.equal(h.calls.length, 1)
})

test('retired identities are denied before provider access', async t => {
  const h = harness(t), who = await h.identity()
  const { ensureIdentityRetirementSchema } = h.load(path.join(root, 'lib/identity-retirement-schema.ts'))
  await ensureIdentityRetirementSchema(h.db)
  h.sqlite.prepare('INSERT INTO RetiredIdentity(publicKey, retiredAt) VALUES (?, ?)').run(who.publicKey, h.state.now)
  assert.equal((await h.post(await h.signed(who))).status, 403)
  assert.equal(h.calls.length, 0)
})

test('concurrent cost limits cap an identity; global guard bounds fresh-identity abuse', async t => {
  const h = harness(t), who = await h.identity()
  const bodies = await Promise.all(Array.from({ length: 8 }, () => h.signed(who)))
  const responses = await Promise.all(bodies.map(body => h.post(body)))
  assert.equal(responses.filter(response => response.status === 200).length, 4)
  assert.equal(responses.filter(response => response.status === 429).length, 4)
  assert.equal(h.calls.length, 4)
  for (let index = 0; index < 56; index++) h.sqlite.prepare('INSERT INTO RequestNonce(publicKey, nonce, action, expiresAt) VALUES (?, ?, ?, ?)')
    .run(`other-${index}`, crypto.randomUUID(), 'plugin:summary', h.state.now + 60_000)
  const second = await h.identity()
  assert.equal((await h.post(await h.signed(second))).status, 429)
  assert.equal(h.calls.length, 4)
  h.state.now += 61_000
  assert.equal((await h.post(await h.signed(second))).status, 200)
})

test('unconfigured and provider failures return useful errors without reflecting provider secrets', async t => {
  const h = harness(t), who = await h.identity()
  h.env.SUMMARY_AI_ENABLED = 'false'
  let response = await h.post(await h.signed(who))
  assert.equal(response.status, 503)
  assert.match((await response.json()).error, /not configured/)
  assert.equal(h.calls.length, 0)
  h.env.SUMMARY_AI_ENABLED = 'true'
  const ai = h.env.AI
  delete h.env.AI
  assert.equal((await h.post(await h.signed(who))).status, 503)
  h.env.AI = ai
  h.state.provider = () => { throw Error('secret provider credential and private transcript') }
  response = await h.post(await h.signed(who))
  assert.equal(response.status, 502)
  assert.doesNotMatch(JSON.stringify(await response.json()), /credential|transcript/)
  h.state.provider = () => ({ response: '' })
  assert.equal((await h.post(await h.signed(who))).status, 502)
  h.state.provider = () => ({ response: 'x'.repeat(9000) })
  const output = await (await h.post(await h.signed(who))).json()
  assert.equal(output.summary.length, 4000)
})

test('deployment model selection is server-only and clients cannot override prompt/model', async t => {
  const h = harness(t), who = await h.identity()
  h.env.SUMMARY_AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8'
  assert.equal((await h.post(await h.signed(who))).status, 200)
  assert.equal(h.calls[0].model, h.env.SUMMARY_AI_MODEL)
  assert.equal((await h.post(await h.signed(who, { ...h.data(), model: '@cf/other/model' }))).status, 400)
  assert.equal((await h.post(await h.signed(who, { ...h.data(), prompt: 'override' }))).status, 400)
  h.env.SUMMARY_AI_MODEL = 'https://attacker.example'
  assert.equal((await h.post(await h.signed(who))).status, 503)
  assert.equal(h.calls.length, 1)
})

test('provider timeout aborts the binding and settles even if provider ignores cancellation', async t => {
  const h = harness(t), who = await h.identity()
  h.state.fakeTimers = true
  h.state.provider = () => new Promise(() => {})
  const pending = h.post(await h.signed(who))
  while (!h.calls.length) await new Promise(resolve => setImmediate(resolve))
  const timer = [...h.state.timers.values()].find(item => item.ms === 25_000)
  assert.ok(timer)
  timer.fn()
  const response = await pending
  assert.equal(response.status, 504)
  assert.equal(h.calls[0].options.signal.aborted, true)
  assert.equal(h.state.timers.size, 0)
})

test('client sends one proof-bound snapshot and does not include preview metadata or private keys', async t => {
  const h = harness(t), who = await h.identity(), messages = h.data().messages
  let count = 0
  h.state.fetch = async (url, options) => {
    count++
    assert.equal(url, '/api/plugins/summary')
    assert.equal(options.cache, 'no-store')
    assert.equal(options.redirect, 'error')
    const body = JSON.parse(options.body)
    assert.deepEqual(body.data, { messages })
    assert.equal(await h.auth.verifyRequestProof(body.action, body.data, body.proof), true)
    assert.doesNotMatch(options.body, /privateKey|conversationId|fromTimestamp|toTimestamp/)
    return Response.json({ success: true, summary: 'Local summary' })
  }
  assert.equal(await h.client.requestAiSummary(who, messages), 'Local summary')
  assert.equal(count, 1)
})

test('client abort before confirmation request sends nothing; cancellation and failure never retry', async t => {
  const h = harness(t), who = await h.identity(), cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(h.client.requestAiSummary(who, h.data().messages, cancelled.signal), { name: 'AbortError' })
  let count = 0
  h.state.fetch = async () => { count++; return Response.json({ success: false, error: 'AI summaries are not configured.' }, { status: 503 }) }
  await assert.rejects(h.client.requestAiSummary(who, h.data().messages), /not configured/)
  assert.equal(count, 1)
  h.state.fetch = (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))
  const controller = new AbortController(), pending = h.client.requestAiSummary(who, h.data().messages, controller.signal)
  await new Promise(resolve => setImmediate(resolve)); controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
})

test('client rechecks live scope after asynchronous signing and blocks revoked export', async t => {
  const h = harness(t), who = await h.identity()
  let checks = 0
  await assert.rejects(h.client.requestAiSummary(who, h.data().messages, undefined, () => ++checks === 1), /access changed/)
  assert.equal(checks, 2)
  // The harness throws on any fetch, so this also verifies no content escaped.
  await assert.rejects(h.client.requestAiSummary(who, h.data().messages, undefined, () => false), /access changed/)
})
