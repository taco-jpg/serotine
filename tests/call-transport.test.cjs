/* Real WebCrypto, signed HTTP, encrypted browser transport, and SQLite arbitration. */
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
  const state = { now: Date.now(), failSignal: false }
  class Clock extends Date { static now() { return state.now } }
  const requests = []
  const queries = []
  const db = {
    prepare(sql) {
      queries.push(sql)
      let values = []
      return {
        bind(...args) { values = args; return this },
        execute() {
          if (state.failSignal && sql.startsWith('INSERT INTO CallSignal')) { state.failSignal = false; throw new Error('Injected D1 failure') }
          return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }
        },
        async run() { return this.execute() },
        async first() { return sqlite.prepare(sql).get(...values) ?? null },
        async all() {
          const results = sqlite.prepare(sql).all(...values)
          if (state.afterSessionsRead && sql.startsWith('SELECT callId, caller, recipient')) {
            const run = state.afterSessionsRead; state.afterSessionsRead = null
            await run()
          }
          return { results }
        },
      }
    },
    async batch(statements) {
      sqlite.exec('BEGIN')
      try { const result = statements.map(item => item.execute()); sqlite.exec('COMMIT'); return result }
      catch (error) { sqlite.exec('ROLLBACK'); throw error }
    },
  }
  const env = { serotine_db: db }
  const cache = new Map()
  function load(filename) {
    if (!path.extname(filename)) filename += '.ts'
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }; cache.set(filename, module)
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const sourceRequire = specifier => {
      if (specifier === '@opennextjs/cloudflare') return { getCloudflareContext: async () => ({ env }) }
      if (specifier.startsWith('@/')) return load(path.join(root, specifier.slice(2)))
      if (specifier.startsWith('.')) return load(path.resolve(path.dirname(filename), specifier))
      return require(specifier)
    }
    const localFetch = async (url, init) => {
      requests.push(JSON.parse(init.body))
      assert.equal(url, '/api/calls')
      assert.equal(init.mode, 'same-origin')
      assert.equal(init.redirect, 'error')
      assert.equal(init.cache, 'no-store')
      return POST(new Request(`${origin}${url}`, init))
    }
    new Function('require', 'module', 'exports', 'fetch', 'Date', output)(sourceRequire, module, module.exports, localFetch, Clock)
    return module.exports
  }
  const POST = load(path.join(root, 'app/api/calls/route.ts')).POST
  const cryptography = load(path.join(root, 'lib/crypto.ts'))
  const auth = load(path.join(root, 'lib/request-auth.ts'))
  const client = load(path.join(root, 'lib/call-transport.ts'))
  const post = body => POST(new Request(`${origin}/api/calls`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  async function identity() {
    const pair = await cryptography.generateEncryptionKeyPair()
    const identity = { version: 2, privateKey: await cryptography.exportKey(pair.privateKey), publicKey: await cryptography.exportPublicKeyToHex(pair.publicKey) }
    return { ...identity, pair, transport: client.createCallTransport(identity) }
  }
  return { sqlite, db, env, state, requests, queries, post, POST, load, identity, cryptography, auth,
    linked: identity => client.createCallTransport(identity) }
}
const invite = { kind: 'invite', mode: 'video', policy: 'all', private: false }
async function pair(h) {
  const [alice, bob] = await Promise.all([h.identity(), h.identity()])
  await Promise.all([alice.transport.heartbeat([bob.publicKey]), bob.transport.heartbeat([alice.publicKey])])
  return [alice, bob]
}

test('unsigned, cross-origin, malformed, and oversized call requests cannot initialize the relay', async t => {
  const h = harness(t)
  assert.equal((await h.post({ version: 1, action: 'call:poll', data: { sessionId: crypto.randomUUID(), after: 0 }, proof: {} })).status, 401)
  const response = await h.POST(new Request(`${origin}/api/calls`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://other.example' }, body: '{}' }))
  assert.equal(response.status, 403)
  let cancelled = false
  const body = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(100000)) }, cancel() { cancelled = true } })
  assert.equal((await h.POST(new Request(`${origin}/api/calls`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, duplex: 'half' }))).status, 413)
  assert.equal(cancelled, true)
  assert.equal(h.queries.length, 0)
})

test('capabilities require accepted contact permission; silencing incoming leaves outgoing available', async t => {
  const h = harness(t)
  const [alice, bob] = await pair(h)
  const stranger = await h.identity()
  assert.equal((await stranger.transport.capability(bob.publicKey)).available, false)
  await alice.transport.heartbeat([bob.publicKey], [])
  assert.equal((await bob.transport.capability(alice.publicKey)).available, false)
  assert.equal((await alice.transport.capability(bob.publicKey)).available, true)
  const callId = crypto.randomUUID()
  assert.equal((await alice.transport.invite(bob.publicKey, callId, invite)).status, 'ringing')
  assert.equal((await bob.transport.poll()).signals[0].payload.kind, 'invite')
})

test('one atomic call reserves both identities and exactly one linked device claims the answer', async t => {
  const h = harness(t)
  const [alice, bob] = await pair(h)
  const secondBob = h.linked(bob)
  const secondAlice = h.linked(alice)
  await Promise.all([secondBob.heartbeat([alice.publicKey]), secondAlice.heartbeat([bob.publicKey])])
  const attempted = await Promise.allSettled([
    alice.transport.invite(bob.publicKey, crypto.randomUUID(), invite),
    bob.transport.invite(alice.publicKey, crypto.randomUUID(), invite),
    secondAlice.invite(bob.publicKey, crypto.randomUUID(), invite),
  ])
  assert.equal(attempted.filter(item => item.status === 'fulfilled').length, 1)
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS n FROM CallSession WHERE status != 'ended'").get().n, 1)
  const session = attempted.find(item => item.status === 'fulfilled').value
  const recipients = session.recipient === bob.publicKey ? [bob.transport, secondBob] : [alice.transport, secondAlice]
  const [firstFeed, otherFeed] = await Promise.all(recipients.map(client => client.poll()))
  assert.equal(firstFeed.signals.length, 1)
  assert.equal(otherFeed.signals.length, 1)
  const claims = await Promise.allSettled(recipients.map(client => client.claim(session.callId)))
  assert.equal(claims.filter(item => item.status === 'fulfilled').length, 1)
  const claimed = claims.find(item => item.status === 'fulfilled').value
  for (const client of recipients) {
    const next = await client.poll()
    assert.equal(next.signals.length, 0)
    assert.equal(next.sessions[0].recipientSession, claimed.recipientSession)
  }
  const loser = recipients.find(client => client.sessionId !== claimed.recipientSession)
  await assert.rejects(loser.send(session.callId, session.caller, session.callerSession, { kind: 'accept', mode: 'voice', private: false }), /another device/)
  await assert.rejects(loser.finish(session.callId, 'ended'), /another device/)
})

test('encrypted SDP is bound to peer, call, chosen sessions, expiry, and a fresh signed envelope', async t => {
  const h = harness(t)
  const [alice, bob] = await pair(h)
  const callId = crypto.randomUUID()
  await alice.transport.invite(bob.publicKey, callId, invite)
  const usedInvite = h.requests.at(-1)
  assert.equal((await h.post(usedInvite)).status, 409, 'outer proof replay is rejected')
  const tampered = structuredClone(usedInvite)
  tampered.data.signal.callId = crypto.randomUUID()
  assert.equal((await h.post(tampered)).status, 401, 'proof authenticates the complete encrypted routing object')
  await bob.transport.claim(callId)
  const description = { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 authenticated-test-fingerprint\r\n' }
  await alice.transport.send(callId, bob.publicKey, bob.transport.sessionId, { kind: 'offer', description })
  const stored = h.sqlite.prepare('SELECT * FROM CallSignal WHERE targetSession IS NOT NULL').get()
  assert.equal(stored.encryptedData.includes('fingerprint'), false)
  const first = await bob.transport.poll()
  assert.deepEqual(first.signals[0].payload.description, description)
  assert.equal((await bob.transport.poll()).signals.length, 0, 'same encrypted event cannot be delivered twice in one session')
  await assert.rejects(alice.transport.send(callId, bob.publicKey, crypto.randomUUID(), { kind: 'offer', description }), /another device/)
  const decoded = JSON.parse(await h.cryptography.decryptFromPeer(stored.encryptedData, bob.pair.privateKey, alice.publicKey))
  decoded.envelope.id = crypto.randomUUID()
  decoded.envelope.payload.description.sdp = 'v=0\r\na=fingerprint:sha-256 FORGED\r\n'
  // The recipient knows the AES shared secret, but cannot forge the sender's ECDSA proof.
  const forged = await h.cryptography.encryptForPeer(JSON.stringify(decoded), bob.pair.privateKey, alice.publicKey)
  h.sqlite.prepare('UPDATE CallSignal SET id = ?, encryptedData = ? WHERE sequence = ?').run(decoded.envelope.id, forged, stored.sequence)
  assert.equal((await bob.transport.poll()).signals.length, 0)
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'RelayEvent'").get().n, 0)
})

test('expired invites never ring or revive, and cancellation leaves a terminal tombstone for other tabs', async t => {
  const h = harness(t)
  const [alice, bob] = await pair(h)
  const id = crypto.randomUUID()
  const session = await alice.transport.invite(bob.publicKey, id, invite)
  assert.equal(session.inviteExpiresAt - h.state.now, 40000)
  h.state.now += 40001
  const feed = await bob.transport.poll()
  assert.equal(feed.signals.length, 0)
  assert.equal(feed.sessions[0].reason, 'unanswered')
  await assert.rejects(bob.transport.claim(id), /expired/)
  await Promise.all([alice.transport.heartbeat([bob.publicKey]), bob.transport.heartbeat([alice.publicKey])])
  const second = await alice.transport.invite(bob.publicKey, crypto.randomUUID(), invite)
  await alice.transport.finish(second.callId, 'cancelled')
  const cancelled = await bob.transport.poll()
  assert.equal(cancelled.sessions.find(item => item.callId === second.callId).reason, 'cancelled')
  assert.equal(cancelled.signals.length, 0)
  h.state.now += 120001
  await bob.transport.poll()
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM CallSession').get().n, 0)
})

test('an acceptance arriving between feed reads is delivered on the next poll rather than skipped by its cursor', async t => {
  const h = harness(t)
  const [alice, bob] = await pair(h)
  const call = await alice.transport.invite(bob.publicKey, crypto.randomUUID(), invite)
  h.state.afterSessionsRead = async () => {
    await bob.transport.claim(call.callId)
    await bob.transport.send(call.callId, alice.publicKey, alice.transport.sessionId, { kind: 'accept', mode: 'voice', private: false })
  }
  const first = await alice.transport.poll()
  const next = await alice.transport.poll(first.nextCursor)
  assert.equal([...first.signals, ...next.signals].filter(signal => signal.payload.kind === 'accept').length, 1)
})

test('active call leases require both selected devices, and an unrelated linked tab cannot keep one alive', async t => {
  const h = harness(t)
  const [alice, bob] = await pair(h)
  const linkedBob = h.linked(bob)
  await linkedBob.heartbeat([alice.publicKey])
  const session = await alice.transport.invite(bob.publicKey, crypto.randomUUID(), invite)
  await bob.transport.claim(session.callId)
  h.state.now += 15000
  await alice.transport.poll()
  await linkedBob.poll()
  h.state.now += 15001
  const ended = await alice.transport.poll()
  assert.equal(ended.sessions[0].status, 'ended')
  assert.equal(ended.sessions[0].reason, 'failed')
})

test('private history suppression is sticky through terminal races and returned before local history completion', async t => {
  const h = harness(t)
  const [alice, bob] = await pair(h)
  const session = await alice.transport.invite(bob.publicKey, crypto.randomUUID(), invite)
  assert.equal((await bob.transport.claim(session.callId, true)).noHistory, true)
  assert.equal((await alice.transport.finish(session.callId, 'ended', false)).noHistory, true)
  assert.equal((await bob.transport.finish(session.callId, 'ended', false)).noHistory, true)
  const another = await alice.transport.invite(bob.publicKey, crypto.randomUUID(), invite)
  await bob.transport.claim(another.callId)
  await alice.transport.finish(another.callId, 'ended')
  assert.equal((await bob.transport.finish(another.callId, 'ended', true)).noHistory, true, 'late private completion can only suppress history')
})

test('TURN uses short-lived operator credentials and relay-only fails closed without TURN', async t => {
  const h = harness(t)
  const alice = await h.identity()
  await assert.rejects(alice.transport.configuration('relay'), /not configured/)
  const direct = await alice.transport.configuration('all')
  assert.equal(direct.relayAvailable, false)
  assert.ok(direct.iceServers.every(server => server.urls.every(url => url.startsWith('stun:'))))
  h.env.CALL_TURN_URLS = 'turn:relay.example:3478,turns:relay.example:5349'
  h.env.CALL_TURN_SECRET = 'a-test-operator-shared-secret-at-least-24-characters'
  const relay = await alice.transport.configuration('relay')
  assert.equal(relay.relayAvailable, true)
  assert.equal(relay.expiresAt - h.state.now, 600000)
  assert.equal(relay.iceServers.length, 1)
  const server = relay.iceServers[0]
  assert.equal(server.username.split(':')[0], String(Math.floor(relay.expiresAt / 1000)))
  assert.equal(server.username.includes(alice.publicKey), false)
  const expected = require('node:crypto').createHmac('sha1', h.env.CALL_TURN_SECRET).update(server.username).digest('base64')
  assert.equal(server.credential, expected)
  assert.equal(JSON.stringify(relay).includes(h.env.CALL_TURN_SECRET), false)
})

test('failed invitation signal releases both reservations and repeated invites are rate limited', async t => {
  const h = harness(t)
  const [alice, bob] = await pair(h)
  h.state.failSignal = true
  await assert.rejects(alice.transport.invite(bob.publicKey, crypto.randomUUID(), invite), /temporarily unavailable/)
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS n FROM CallSession WHERE status != 'ended'").get().n, 0)
  for (let index = 0; index < 5; index++) {
    const session = await alice.transport.invite(bob.publicKey, crypto.randomUUID(), invite)
    await alice.transport.finish(session.callId, 'cancelled')
  }
  await assert.rejects(alice.transport.invite(bob.publicKey, crypto.randomUUID(), invite), /Too many/)
})
