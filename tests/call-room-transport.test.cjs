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
    new Function('require', 'module', 'exports', 'fetch', 'Date', output)(sourceRequire, module, module.exports, localFetch, Clock)
    return module.exports
  }
  const POST = load(path.join(root, 'app/api/calls/route.ts')).POST
  const cryptography = load(path.join(root, 'lib/crypto.ts'))
  const auth = load(path.join(root, 'lib/request-auth.ts'))
  const client = load(path.join(root, 'lib/call-transport.ts'))
  const rooms = load(path.join(root, 'lib/call-room-transport.ts'))
  const messaging = load(path.join(root, 'lib/messaging.ts'))
  const community = load(path.join(root, 'lib/community-protocol.ts'))
  const post = body => POST(new Request(`${origin}/api/calls`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  async function identity() {
    const pair = await cryptography.generateEncryptionKeyPair()
    const identity = { version: 2, privateKey: await cryptography.exportKey(pair.privateKey), publicKey: await cryptography.exportPublicKeyToHex(pair.publicKey) }
    return { ...identity, pair, transport: client.createCallTransport(identity), room: rooms.createCallRoomTransport(identity) }
  }
  return { sqlite, db, env, state, requests, queries, post, POST, load, identity, cryptography, auth,
    rooms, messaging, community, linked: identity => rooms.createCallRoomTransport(identity) }
}

async function group(h, people, changes = {}) {
  return { kind: 'group', group: await h.messaging.signGroup({ id: `group:${crypto.randomUUID()}`, name: 'Calling group', admin: people[0].publicKey,
    members: people.map(p => p.publicKey), epoch: 1, updatedAt: h.state.now, ...changes }, people[0]) }
}
async function community(h, people, changes = {}) {
  const state = await h.community.signCommunityState({ version: 2, id: `community:${people[0].publicKey}:${crypto.randomUUID()}`, owner: people[0].publicKey,
    name: 'Calling community', description: '', epoch: 1, updatedAt: h.state.now, members: people.map(p => p.publicKey), moderators: [], bans: [],
    channels: [{ id: crypto.randomUUID(), name: 'General', posting: 'members' }, { id: crypto.randomUUID(), name: 'Voice', posting: 'members', kind: 'voice' }],
    admission: 'direct', joiningPaused: false, inviteGeneration: 1, coOwners: [], transfers: [], signer: people[0].publicKey, deleted: false, ...changes }, people[0])
  return { kind: 'channel', community: state, channelId: state.channels[1].id }
}
const offer = { kind: 'offer', description: { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 authenticated-room-peer\r\n' } }

test('room joins authenticate signed membership, reject outsiders and scope group authority by admin', async t => {
  const h = harness(t), people = await Promise.all([h.identity(), h.identity(), h.identity()])
  const target = await group(h, people.slice(0, 2)), [alice, bob, stranger] = people
  const tampered = structuredClone(target); tampered.group.members.push(stranger.publicKey)
  await assert.rejects(stranger.room.join(tampered, 'voice', 'all'), /could not be verified/)
  await assert.rejects(stranger.room.join(target, 'voice', 'all'), /no longer a member/)
  assert.equal((await alice.room.status(target)).participants.length, 0, 'status never joins or starts capture')
  const first = await alice.room.join(target, 'video', 'all')
  assert.equal(first.participants[0].publicKey, alice.publicKey)
  assert.equal((await bob.room.join(target, 'voice', 'all')).participants.length, 2)
  const other = await group(h, [stranger], { id: target.group.id })
  const unrelated = await stranger.room.join(other, 'voice', 'all')
  assert.notEqual(unrelated.roomId, first.roomId, 'an attacker can sign the random group ID only under a different admin namespace')
  assert.equal((await alice.room.status(target)).participants.length, 2)
  const used = h.requests.at(-1)
  assert.equal((await h.post(used)).status, 409)
  const altered = structuredClone(used); altered.data.target.group.epoch++
  assert.equal((await h.post(altered)).status, 401)
})

test('room capacity and one identity/device are enforced atomically under concurrent joins', async t => {
  const h = harness(t), people = await Promise.all(Array.from({ length: 10 }, () => h.identity()))
  const target = await group(h, people)
  const attempts = await Promise.allSettled(people.map(p => p.room.join(target, 'voice', 'all')))
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 8)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM CallRoomMember').get().n, 8)
  const active = people.filter((_, i) => attempts[i].status === 'fulfilled')
  await assert.rejects(h.linked(active[0]).join(target, 'voice', 'all'), /already in a call/)
  assert.equal((await active[0].room.join(target, 'voice', 'all')).participants.length, 8, 'same-device join retry does not consume capacity')
  const second = await group(h, [active[0]])
  await assert.rejects(active[0].room.join(second, 'voice', 'all'), /already in a call/)
  await active[0].room.leave(h.rooms.callRoomId(target))
  assert.equal((await active[0].room.join(second, 'voice', 'all')).participants.length, 1)
})

test('direct calls and room calls reserve both identities without crossing each other', async t => {
  const h = harness(t), [alice, bob, carol] = await Promise.all([h.identity(), h.identity(), h.identity()])
  const target = await group(h, [alice, bob, carol])
  await Promise.all([alice.transport.heartbeat([bob.publicKey, carol.publicKey]), bob.transport.heartbeat([alice.publicKey]), carol.transport.heartbeat([alice.publicKey])])
  const invitation = { kind: 'invite', mode: 'voice', policy: 'all', private: false }
  const attempts = await Promise.allSettled([alice.room.join(target, 'voice', 'all'), carol.transport.invite(alice.publicKey, crypto.randomUUID(), invitation)])
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1)
  if (attempts[0].status === 'fulfilled') {
    assert.equal((await bob.transport.capability(alice.publicKey)).busy, true)
    await assert.rejects(alice.transport.invite(bob.publicKey, crypto.randomUUID(), invitation), /already in a call/)
  } else {
    await assert.rejects(alice.room.join(target, 'voice', 'all'), /already in a call/)
    await assert.rejects(carol.room.join(target, 'voice', 'all'), /already in a call/)
  }
})

test('room SDP is encrypted and bound to room, peer, fresh signatures and both selected devices', async t => {
  const h = harness(t), [alice, bob, carol] = await Promise.all([h.identity(), h.identity(), h.identity()])
  const target = await group(h, [alice, bob, carol]), roomId = h.rooms.callRoomId(target)
  await Promise.all([alice.room.join(target, 'video', 'all'), bob.room.join(target, 'voice', 'all')])
  await alice.room.send(roomId, bob.publicKey, bob.room.sessionId, offer)
  const stored = h.sqlite.prepare('SELECT * FROM CallRoomSignal').get()
  assert.equal(stored.encryptedData.includes('fingerprint'), false)
  assert.deepEqual((await bob.room.poll(target)).signals[0].payload, offer)
  assert.equal((await bob.room.poll(target)).signals.length, 0)
  await assert.rejects(alice.room.send(roomId, bob.publicKey, crypto.randomUUID(), offer), /another device/)
  await assert.rejects(carol.room.send(roomId, bob.publicKey, bob.room.sessionId, offer), /another device/)
  const decoded = JSON.parse(await h.cryptography.decryptFromPeer(stored.encryptedData, bob.pair.privateKey, alice.publicKey))
  decoded.envelope.id = crypto.randomUUID(); decoded.envelope.payload.description.sdp = 'forged SDP'
  const forged = await h.cryptography.encryptForPeer(JSON.stringify(decoded), bob.pair.privateKey, alice.publicKey)
  h.sqlite.prepare('UPDATE CallRoomSignal SET id = ?, encryptedData = ? WHERE sequence = ?').run(decoded.envelope.id, forged, stored.sequence)
  assert.equal((await bob.room.poll(target)).signals.length, 0, 'shared AES secret does not allow recipient to forge sender signature')
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'RelayEvent'").get().n, 0)
})

test('new group epochs evict removed participants, destroy pending signaling and survive expiry to prevent rollback', async t => {
  const h = harness(t), [alice, bob, carol] = await Promise.all([h.identity(), h.identity(), h.identity()])
  const target = await group(h, [alice, bob, carol]), roomId = h.rooms.callRoomId(target)
  await Promise.all([alice.room.join(target, 'voice', 'all'), bob.room.join(target, 'voice', 'all')])
  await alice.room.send(roomId, bob.publicKey, bob.room.sessionId, offer)
  const newer = await group(h, [alice, carol], { id: target.group.id, epoch: 2 })
  assert.equal((await alice.room.status(newer)).participants.length, 1)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM CallRoomSignal').get().n, 0)
  await assert.rejects(bob.room.poll(target), /out of date/)
  await assert.rejects(bob.room.join(target, 'voice', 'all'), /out of date/)
  await assert.rejects(bob.room.send(roomId, alice.publicKey, alice.room.sessionId, offer), /membership/)
  h.state.now += 31000
  assert.equal((await alice.room.status(newer)).participants.length, 0)
  await assert.rejects(bob.room.join(target, 'voice', 'all'), /out of date/)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM CallRoomAuthority').get().n, 1)
  const authority = h.sqlite.prepare('SELECT * FROM CallRoomAuthority').get()
  assert.equal(authority.stateJson, null, 'idle authorization roster is erased')
  assert.equal(JSON.stringify(authority).includes(bob.publicKey), false, 'removed identity is not retained in a checkpoint')
  assert.deepEqual(JSON.parse(authority.checkpointJson), { epoch: 2, admin: alice.publicKey })
  assert.equal((await alice.room.join(newer, 'voice', 'all')).participants.length, 1, 'fresh signed proof rehydrates authorization atomically')
  assert.deepEqual(JSON.parse(h.sqlite.prepare('SELECT stateJson FROM CallRoomAuthority').get().stateJson), { members: [alice.publicKey, carol.publicKey] })
  await alice.room.leave(roomId)
  assert.equal(h.sqlite.prepare('SELECT stateJson FROM CallRoomAuthority').get().stateJson, null)
})

test('authority compare-and-swap preserves the highest epoch under concurrent signed updates', async t => {
  const h = harness(t), [alice, bob] = await Promise.all([h.identity(), h.identity()])
  const first = await group(h, [alice, bob]); await alice.room.status(first)
  const second = await group(h, [alice, bob], { id: first.group.id, epoch: 2 })
  const third = await group(h, [alice], { id: first.group.id, epoch: 3 })
  await Promise.allSettled([alice.room.status(third), bob.room.status(second)])
  assert.equal(JSON.parse(h.sqlite.prepare('SELECT checkpointJson FROM CallRoomAuthority').get().checkpointJson).epoch, 3)
  await assert.rejects(bob.room.join(second, 'voice', 'all'), /out of date/)
})

test('room heartbeat is device-bound and expired sessions cannot be revived or reused for old signals', async t => {
  const h = harness(t), [alice, bob] = await Promise.all([h.identity(), h.identity()])
  const target = await group(h, [alice, bob]), roomId = h.rooms.callRoomId(target)
  await Promise.all([alice.room.join(target, 'voice', 'all'), bob.room.join(target, 'voice', 'all')])
  const linked = h.linked(alice)
  await assert.rejects(linked.poll(target), /another device/)
  await linked.leave(roomId)
  assert.equal((await bob.room.status(target)).participants.length, 2)
  h.state.now += 20000; await bob.room.poll(target)
  h.state.now += 11000
  assert.equal((await bob.room.poll(target)).room.participants.length, 1)
  await assert.rejects(alice.room.poll(target), /expired/)
  const replacement = h.linked(alice); await replacement.join(target, 'voice', 'all')
  await assert.rejects(alice.room.send(roomId, bob.publicKey, bob.room.sessionId, offer), /another device/)
  await replacement.leave(roomId)
  assert.equal((await bob.room.status(target)).participants.length, 1)
})

test('room admission rejects legacy forced relay policy and permits automatic ICE participants', async t => {
  const h = harness(t), [alice, bob] = await Promise.all([h.identity(), h.identity()])
  const target = await group(h, [alice, bob])
  await assert.rejects(alice.room.join(target, 'voice', 'relay'), /chooses direct or managed TURN routes automatically/)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM CallRoomMember').get().n, 0)
  await alice.room.join(target, 'voice', 'all')
  assert.equal((await bob.room.join(target, 'voice', 'all')).participants.length, 2)
})

test('voice channels enforce membership, channel kind and role restrictions', async t => {
  const h = harness(t), [alice, bob, carol] = await Promise.all([h.identity(), h.identity(), h.identity()])
  const target = await community(h, [alice, bob, carol])
  await assert.rejects(bob.room.join(target, 'video', 'all'), /microphone audio/)
  await assert.rejects(bob.room.join({ ...target, channelId: target.community.channels[0].id }, 'voice', 'all'), /no longer available/)
  await bob.room.join(target, 'voice', 'all')
  const restricted = { ...target, community: await h.community.signCommunityState({ ...target.community, epoch: 2,
    channels: target.community.channels.map(c => c.id === target.channelId ? { ...c, posting: 'moderators' } : c) }, alice) }
  assert.equal((await alice.room.status(restricted)).participants.length, 0, 'restriction evicts ordinary member')
  await assert.rejects(bob.room.join(restricted, 'voice', 'all'), /no longer available/)
  assert.equal((await alice.room.join(restricted, 'voice', 'all')).participants.length, 1)
  assert.equal((await bob.room.status(restricted)).participants.length, 0, 'restricted roster is hidden')
  const removed = { ...restricted, community: await h.community.signCommunityState({ ...restricted.community, epoch: 3, channels: [target.community.channels[0]] }, alice) }
  assert.equal((await carol.room.status(removed)).participants.length, 0, 'a member can publish signed channel removal')
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM CallRoomMember').get().n, 0)
})

test('community-wide authority blocks banned members replaying old states into unvisited voice channels', async t => {
  const h = harness(t), [alice, bob, carol] = await Promise.all([h.identity(), h.identity(), h.identity()])
  const target = await community(h, [alice, bob, carol])
  const otherId = crypto.randomUUID()
  const two = { ...target, community: await h.community.signCommunityState({ ...target.community, epoch: 2,
    channels: [...target.community.channels, { id: otherId, name: 'Other voice', posting: 'members', kind: 'voice' }] }, alice) }
  await bob.room.join(two, 'voice', 'all')
  const banned = { ...two, community: await h.community.signCommunityState({ ...two.community, epoch: 3, members: [alice.publicKey, carol.publicKey], bans: [bob.publicKey] }, alice) }
  await carol.room.status(banned)
  await assert.rejects(bob.room.join({ ...two, channelId: otherId }, 'voice', 'all'), /out of date/)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM CallRoomMember').get().n, 0)
})

test('community transfer proofs fence departed owners and deleted communities permanently', async t => {
  const h = harness(t), [alice, bob] = await Promise.all([h.identity(), h.identity()])
  const target = await community(h, [alice, bob]); await alice.room.status(target)
  const handed = { ...target, community: await h.community.signCommunityTransfer({ ...target.community, epoch: 2 }, bob.publicKey, alice) }
  await bob.room.status(handed)
  const forgedFuture = { ...target, community: await h.community.signCommunityState({ ...target.community, epoch: 99 }, alice) }
  await assert.rejects(alice.room.join(forgedFuture, 'voice', 'all'), /out of date/)
  const deleted = { ...handed, community: await h.community.signCommunityState({ ...handed.community, epoch: 3, deleted: true, joiningPaused: true }, bob) }
  assert.equal((await bob.room.status(deleted)).participants.length, 0)
  await assert.rejects(bob.room.join(handed, 'voice', 'all'), /out of date/)
  await assert.rejects(bob.room.join(deleted, 'voice', 'all'), /no longer available/)
})

test('only a removed room participant can notify the remaining authorized room members', async t => {
  const h = harness(t), [alice, bob, stranger] = await Promise.all([h.identity(), h.identity(), h.identity()])
  const target = await group(h, [alice, bob]), roomId = h.rooms.callRoomId(target)
  await Promise.all([alice.room.join(target, 'voice', 'all'), bob.room.join(target, 'voice', 'all')])
  async function leave(identity, sessionId) {
    const action = 'room:leave', data = { sessionId, roomId }
    const proof = await h.auth.createRequestProof(action, data, identity.privateKey, identity.publicKey)
    return (await h.post({ version: 1, action, data, proof })).json()
  }
  assert.deepEqual((await leave(stranger, stranger.room.sessionId))._notify, [])
  assert.deepEqual((await leave(alice, crypto.randomUUID()))._notify, [])
  assert.deepEqual((await leave(alice, alice.room.sessionId))._notify.sort(), [alice.publicKey, bob.publicKey].sort())
  assert.deepEqual((await leave(alice, alice.room.sessionId))._notify, [])
})
