/* Real WebCrypto, encrypted client envelopes, signed handler requests and SQLite arbitration. Socket delivery is tested separately. */
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
    if (filename === path.join(root, 'lib/call-socket.ts')) {
      class CallTransportError extends Error { constructor(message, code) { super(message); this.code = code } }
      return { CallTransportError, createCallSocket(identity, sessionId) {
        return {
          async request(action, data) {
            assert.equal(data.sessionId, sessionId)
            const proof = await auth.createRequestProof(action, data, identity.privateKey, identity.publicKey)
            const body = { version: 1, action, data, proof }
            requests.push(body)
            const response = await POST(new Request(`${origin}/api/calls`, {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
            }))
            const result = await response.json()
            if (!response.ok || result.success !== true) throw new CallTransportError(result.error, result.code)
            return result
          },
          subscribe() { return () => {} },
          dispose() {},
        }
      } }
    }
    const module = { exports: {} }; cache.set(filename, module)
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const sourceRequire = specifier => {
      if (specifier === '@opennextjs/cloudflare') return { getCloudflareContext: async () => ({ env }) }
      if (specifier.startsWith('@/')) return load(path.join(root, specifier.slice(2)))
      if (specifier.startsWith('.')) return load(path.resolve(path.dirname(filename), specifier))
      return require(specifier)
    }
    const localFetch = async (url, init) => {
      if (url.startsWith('https://rtc.live.cloudflare.com/')) {
        if (!state.turnFetch) throw new Error('Unexpected TURN request')
        return state.turnFetch(url, init)
      }
      requests.push(JSON.parse(init.body))
      assert.equal(url, '/api/calls')
      assert.equal(init.mode, 'same-origin')
      assert.equal(init.redirect, 'error')
      assert.equal(init.cache, 'no-store')
      return POST(new Request(`${origin}${url}`, init))
    }
    new Function('require', 'module', 'exports', 'fetch', 'Date', output)(sourceRequire, module, module.exports, localFetch, filename.endsWith("lib/call-transport.ts") ? class extends Clock { static now() { return state.now + (state.clientOffset || 0) } } : Clock)
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

test('missing or invalid managed TURN setup preserves direct calling and ignores self-hosted settings', async t => {
  const h = harness(t), alice = await h.identity()
  Object.assign(h.env, { CALL_TURN_URLS: 'turn:relay.example:3478', CALL_TURN_SECRET: 'obsolete-secret-with-long-test-value',
    CALL_TURN_KEY_ID: 'obsolete-turn-key-id', CALL_TURN_API_TOKEN: 'obsolete-provider-token' })
  let providerRequests = 0
  h.state.turnFetch = async () => { providerRequests++; throw new Error('No provider requests are allowed') }
  const direct = await alice.transport.configuration('all')
  assert.equal(direct.relayAvailable, false)
  assert.equal(direct.expiresAt - h.state.now, 60000)
  assert.deepEqual(direct.iceServers, [{ urls: ['stun:stun.cloudflare.com:3478'] }])
  assert.equal(providerRequests, 0)
  assert.equal(JSON.stringify(direct).includes('obsolete'), false)
  const action = 'call:configuration', data = { sessionId: alice.transport.sessionId, policy: 'relay' }
  const proof = await h.auth.createRequestProof(action, data, alice.privateKey, alice.publicKey)
  const response = await h.post({ version: 1, action, data, proof })
  assert.equal(response.status, 409)
  assert.equal((await response.json()).code, 'direct-only')
  assert.equal(providerRequests, 0)
})

test('only valid STUN URLs without credentials, query parameters or invalid ports reach the browser', async t => {
  const h = harness(t), alice = await h.identity()
  h.env.CALL_STUN_URLS = ['turn:relay.example:3478', 'stun:user@host:3478', 'stun:host:65536', 'stun:host:0', 'stun:host/path',
    'stun:host?transport=udp', 'stun://host', 'stun:bad..host', 'stun:-bad.example', 'stun:good.example:3478',
    'stuns:secure.example:5349', 'stun:[::1]:3478', 'stun:good.example:3478'].join(',')
  assert.deepEqual((await alice.transport.configuration('all')).iceServers,
    [{ urls: ['stun:good.example:3478', 'stuns:secure.example:5349', 'stun:[::1]:3478'] }])
  h.env.CALL_STUN_URLS = 'turn:relay.example,https://relay.example'
  assert.deepEqual((await alice.transport.configuration('all')).iceServers, [])
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

test('socket authentication binds a fresh signed device and rejects replay, tampering and retired identities', async t => {
  const h = harness(t), alice = await h.identity()
  const action = 'call:socket', data = { sessionId: alice.transport.sessionId }
  const proof = await h.auth.createRequestProof(action, data, alice.privateKey, alice.publicKey)
  const body = { version: 1, action, data, proof }
  const response = await h.post(body)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { success: true, publicKey: alice.publicKey, sessionId: data.sessionId, serverTime: h.state.now })
  assert.equal((await h.post(body)).status, 409)
  assert.equal((await h.post({ ...body, data: { sessionId: crypto.randomUUID() } })).status, 401)
  h.sqlite.prepare('INSERT INTO RetiredIdentity(publicKey, retiredAt) VALUES (?, ?)').run(alice.publicKey, h.state.now)
  const fresh = await h.auth.createRequestProof(action, data, alice.privateKey, alice.publicKey)
  assert.equal((await h.post({ ...body, proof: fresh })).status, 403)
})

test('socket authentication is rate bounded independently of normal signaling', async t => {
  const h = harness(t), alice = await h.identity()
  const action = 'call:socket', data = { sessionId: alice.transport.sessionId }
  for (let i = 0; i < 31; i++) {
    const proof = await h.auth.createRequestProof(action, data, alice.privateKey, alice.publicKey)
    assert.equal((await h.post({ version: 1, action, data, proof })).status, i === 30 ? 429 : 200)
  }
})

test('successful call mutations notify only verified participants and failed mutations expose no targets', async t => {
  const h = harness(t), [alice, bob] = await pair(h), stranger = await h.identity()
  const call = await alice.transport.invite(bob.publicKey, crypto.randomUUID(), invite)
  async function signed(identity, action, data) {
    const proof = await h.auth.createRequestProof(action, data, identity.privateKey, identity.publicKey)
    return h.post({ version: 1, action, data, proof })
  }
  const denied = await signed(stranger, 'call:finish', { sessionId: stranger.transport.sessionId, callId: call.callId, reason: 'ended', noHistory: false })
  assert.equal(denied.status, 409)
  assert.equal((await denied.json())._notify, undefined)
  const claimed = await signed(bob, 'call:claim', { sessionId: bob.transport.sessionId, callId: call.callId, noHistory: false })
  assert.deepEqual((await claimed.json())._notify.sort(), [alice.publicKey, bob.publicKey].sort())
  const ended = await signed(alice, 'call:finish', { sessionId: alice.transport.sessionId, callId: call.callId, reason: 'ended', noHistory: false })
  assert.deepEqual((await ended.json())._notify.sort(), [alice.publicKey, bob.publicKey].sort())
})


test('the reported invalid-request failure is fixed for small caller clock skew without accepting unbounded expiry', async t => {
  const h = harness(t), [alice, bob] = await pair(h)
  h.state.clientOffset = 1500
  const session = await alice.transport.invite(bob.publicKey, crypto.randomUUID(), invite)
  assert.equal(session.status, 'ringing')
  assert.equal((await bob.transport.poll()).signals[0].payload.kind, 'invite')
  const claimed = await bob.transport.claim(session.callId)
  await bob.transport.send(session.callId, alice.publicKey, session.callerSession, { kind: 'accept', mode: 'voice', private: false })
  assert.equal((await alice.transport.poll()).signals[0].payload.kind, 'accept')
  const last = h.requests.at(-2)
  const data = structuredClone(last.data)
  data.signal.id = crypto.randomUUID(); data.signal.expiresAt = h.state.now + 100_000
  const proof = await h.auth.createRequestProof('call:send', data, bob.privateKey, bob.publicKey)
  assert.equal((await h.post({ version: 1, action: 'call:send', data, proof })).status, 400)
  assert.equal(claimed.status, 'active')
})

const managedServers = [
  { urls: ['stun:stun.cloudflare.com:3478'] },
  { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp', 'turn:turn.cloudflare.com:53?transport=udp'], username: 'expiring-test-user', credential: 'expiring-test-password' },
]
function managedTurn(h) { Object.assign(h.env, { CALL_TURN_KEY_ID: 'a'.repeat(32), CALL_TURN_API_TOKEN: 'permanent-server-only-test-key' }) }

test('authenticated configuration mints expiring Cloudflare credentials without disclosing permanent keys', async t => {
  const h = harness(t), alice = await h.identity(); managedTurn(h)
  let requests = 0
  h.state.turnFetch = async (url, init) => {
    requests++
    assert.equal(url, `https://rtc.live.cloudflare.com/v1/turn/keys/${'a'.repeat(32)}/credentials/generate-ice-servers`)
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error')
    assert.equal(init.headers.Authorization, 'Bearer permanent-server-only-test-key')
    assert.deepEqual(JSON.parse(init.body), { ttl: 3600 })
    return Response.json({ iceServers: managedServers }, { status: 201 })
  }
  const result = await alice.transport.configuration('all')
  assert.equal(result.relayAvailable, true); assert.equal(result.turnStatus, 'ready')
  assert.equal(result.expiresAt, h.state.now + 3_570_000)
  const turn = result.iceServers.find(server => server.credential)
  assert.equal(turn.username, 'expiring-test-user'); assert.equal(turn.credential, 'expiring-test-password')
  assert.equal(turn.urls.some(url => url.includes(':53?')), false)
  assert.ok(turn.urls.some(url => url.includes(':443?transport=tcp')))
  assert.equal(JSON.stringify(result).includes('permanent-server-only'), false)
  assert.equal(JSON.stringify(result).includes(h.env.CALL_TURN_KEY_ID), false)
  assert.equal(requests, 1)
  // Identity verification still runs before any credential provider request.
  assert.equal((await h.post({ version: 1, action: 'call:configuration', data: { sessionId: crypto.randomUUID(), policy: 'all' }, proof: {} })).status, 401)
  assert.equal(requests, 1)
})

test('provider denial, invalid ICE servers, and oversized credential responses preserve direct mode without exposing errors', async t => {
  const h = harness(t), alice = await h.identity(); managedTurn(h)
  for (const response of [
    new Response('permanent-server-only-test-key', { status: 403 }),
    Response.json({ iceServers: [{ urls: 'turn:untrusted.example:3478', username: 'user', credential: 'secret' }] }),
    Response.json({ iceServers: managedServers, padding: 'x'.repeat(20_000) }),
  ]) {
    h.state.turnFetch = async () => response
    const result = await alice.transport.configuration('all')
    assert.equal(result.relayAvailable, false); assert.equal(result.turnStatus, 'unavailable')
    assert.ok(result.iceServers.every(server => !server.credential))
    assert.equal(JSON.stringify(result).includes('permanent-server-only'), false)
  }
})
