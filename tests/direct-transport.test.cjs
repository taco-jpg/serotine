/* Deterministic fake RTC plumbing with real WebCrypto/signatures. This is not
 * evidence that browser ICE succeeds across real devices or networks. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')
const root = path.join(__dirname, '..'), modules = new Map()
function load(filename) {
  if (!path.extname(filename)) filename += '.ts'
  if (modules.has(filename)) return modules.get(filename).exports
  const module = { exports: {} }; modules.set(filename, module)
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const sourceRequire = name => name.startsWith('.') ? load(path.resolve(path.dirname(filename), name)) : require(name)
  new Function('require', 'module', 'exports', output)(sourceRequire, module, module.exports)
  return module.exports
}
const cryptography = load(path.join(root, 'lib/crypto.ts'))
const protocol = load(path.join(root, 'lib/direct-protocol.ts'))
const { DirectTransport } = load(path.join(root, 'lib/direct-transport.ts'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function until(predicate) {
  const deadline = Date.now() + 2000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('The fake RTC operation did not settle'); await pause(2) }
}
async function identity() {
  const keys = await cryptography.generateEncryptionKeyPair()
  return { version: 2, publicKey: await cryptography.exportPublicKeyToHex(keys.publicKey), privateKey: await cryptography.exportKey(keys.privateKey) }
}
function eventText(e) { return JSON.stringify(['serotine:event:v3', e.id, e.author, e.conversationId, e.recipients, e.timestamp, e.kind, e.payload, null, e.route]) }
async function signedEvent(sender, recipient, payload = { content: 'A direct-only test message' }, kind = 'message') {
  const event = { version: 3, id: crypto.randomUUID(), author: sender.publicKey, conversationId: recipient.publicKey, recipients: [recipient.publicKey], timestamp: Date.now(), kind, payload, route: 'direct-only' }
  const key = await crypto.subtle.importKey('jwk', { ...sender.privateKey, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  return { ...event, signature: cryptography.arrayBufferToHex(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(eventText(event)))) }
}
function stats(type = 'host') {
  return new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'selected' }],
    ['selected', { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'local', remoteCandidateId: 'remote' }],
    ['local', { type: 'local-candidate', candidateType: type }],
    ['remote', { type: 'remote-candidate', candidateType: 'srflx' }],
  ])
}
async function harness(t, { maxMessageSize = 16384 } = {}) {
  const [alice, bob] = await Promise.all([identity(), identity()])
  const pcs = [], signals = [], frames = [], accepted = [new Map(), new Map()]
  const allowed = [true, true], eventHooks = [], signalHooks = [], peers = [], held = []
  let holdDirection = -1
  const sdp = id => ['v=0', `o=- ${id} 1 IN IP4 127.0.0.1`, 's=-', 't=0 0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel', 'c=IN IP4 0.0.0.0', 'a=ice-ufrag:test', 'a=ice-pwd:testpassword', 'a=fingerprint:sha-256 AA:BB', 'a=setup:actpass', 'a=mid:0', 'a=sctp-port:5000', 'a=candidate:1 1 udp 1 127.0.0.1 1234 typ host', ''].join('\r\n')
  class Channel {
    constructor(side) { this.side = side; this.label = 'serotine-direct-v1'; this.readyState = 'connecting'; this.bufferedAmount = 0 }
    send(wire) {
      assert.equal(this.readyState, 'open')
      frames.push({ side: this.side, wire })
      const deliver = () => { if (this.other.readyState === 'open') this.other.onmessage?.({ data: wire }) }
      if (holdDirection === this.side) held.push(deliver)
      else queueMicrotask(deliver)
    }
    close() { if (this.readyState === 'closed') return; this.readyState = 'closed'; this.onclose?.() }
  }
  class PC {
    constructor(side, configuration) {
      this.side = side; this.configuration = configuration; this.id = pcs.length + 1; this.connectionState = 'new'; this.signalingState = 'stable'; this.iceGatheringState = 'complete'; this.sctp = { maxMessageSize }; this.stats = stats(); pcs.push(this)
    }
    createDataChannel() { this.channel = new Channel(this.side); return this.channel }
    async createOffer() { return { type: 'offer', sdp: sdp(this.id) } }
    async createAnswer() { return { type: 'answer', sdp: sdp(this.id) } }
    async setLocalDescription(description) { this.localDescription = description; this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable' }
    async setRemoteDescription(description) {
      this.remoteDescription = description
      this.remote = pcs.find(pc => pc.id === Number(description.sdp.match(/o=- (\d+)/)[1]))
      if (description.type !== 'answer') return
      this.signalingState = 'stable'; this.connectionState = this.remote.connectionState = 'connected'
      this.remote.channel = new Channel(this.remote.side)
      this.channel.other = this.remote.channel; this.remote.channel.other = this.channel
      this.remote.ondatachannel({ channel: this.remote.channel })
      this.channel.readyState = this.remote.channel.readyState = 'open'
      queueMicrotask(() => { this.channel.onopen?.(); this.remote.channel.onopen?.() })
    }
    async getStats() { if (this.statsWait) await this.statsWait; return this.stats }
    close() { this.connectionState = 'closed'; this.channel?.close() }
  }
  for (const [index, self, other] of [[0, alice, bob], [1, bob, alice]]) {
    peers[index] = new DirectTransport(self, {
      allowed: peer => allowed[index] && peer === other.publicKey,
      changed() {}, iceServers: [], createPeerConnection: config => new PC(index, config),
      async signal(signal) {
        assert.equal(await protocol.validDirectSignal(signal), true)
        signals.push(signal)
        if (signalHooks[index]) return signalHooks[index](signal)
        await peers[1 - index].receiveSignal(signal)
      },
      async event(event) {
        assert.equal(await cryptography.verifySignature(eventText(event), event.signature, event.author), true)
        if (eventHooks[index]) await eventHooks[index](event)
        accepted[index].set(event.id, event)
      },
    })
  }
  t.after(() => peers.forEach(peer => peer.dispose()))
  return { alice, bob, peers, pcs, signals, frames, allowed, accepted, eventHooks, signalHooks,
    hold(side) { holdDirection = side }, release() { holdDirection = -1; held.splice(0).forEach(deliver => deliver()) },
    async connect() { await peers[0].connect(bob.publicKey); await until(() => peers[0].status(bob.publicKey).state === 'connected' && peers[1].status(alice.publicKey).state === 'connected') },
  }
}

test('signed mutual policy agreement establishes an encrypted channel and recipient acknowledgement', async t => {
  const h = await harness(t); await h.connect()
  assert.deepEqual(h.signals.map(s => s.kind), ['offer', 'answer'])
  assert.ok(h.pcs.every(pc => pc.configuration.iceServers.length === 0))
  const event = await signedEvent(h.alice, h.bob)
  await h.peers[0].send(h.bob.publicKey, event)
  assert.deepEqual(h.accepted[1].get(event.id), event)
  assert.ok(h.frames.some(frame => frame.side === 1), 'Recipient sent an encrypted acknowledgement')
  assert.ok(h.frames.every(frame => !frame.wire.includes(event.payload.content) && !frame.wire.includes(event.signature)))
})

test('a peer without local consent neither answers nor receives conversation content', async t => {
  const h = await harness(t); h.allowed[1] = false
  await h.peers[0].connect(h.bob.publicKey)
  assert.equal(h.signals.length, 1); assert.equal(h.pcs.length, 1)
  await assert.rejects(h.peers[0].send(h.bob.publicKey, await signedEvent(h.alice, h.bob)))
  assert.equal(h.frames.length, 0)
})

test('forged answer does not authenticate a peer or replace the local session', async t => {
  const h = await harness(t)
  h.signalHooks[1] = signal => h.peers[0].receiveSignal({ ...signal, session: crypto.randomUUID() })
  await h.peers[0].connect(h.bob.publicKey)
  assert.equal(h.peers[0].status(h.bob.publicKey).state, 'connecting')
  assert.equal(h.pcs[0].remoteDescription, undefined)
  assert.equal(h.frames.length, 0)
})

test('recipient persistence precedes acknowledgement; duplicate retry keeps the original event ID', async t => {
  const h = await harness(t); await h.connect()
  const wait = deferred(); h.eventHooks[1] = () => wait.promise
  const event = await signedEvent(h.alice, h.bob)
  let resolved = false
  const sent = h.peers[0].send(h.bob.publicKey, event).then(() => { resolved = true })
  await until(() => h.frames.some(frame => frame.side === 0)); await pause(15)
  assert.equal(resolved, false); assert.equal(h.frames.some(frame => frame.side === 1), false)
  wait.resolve(); await sent
  h.eventHooks[1] = undefined
  await h.peers[0].send(h.bob.publicKey, event)
  assert.equal(h.accepted[1].size, 1); assert.equal(h.accepted[1].get(event.id).id, event.id)
})

test('a lost acknowledgement remains unconfirmed and permits same-ID retry after reconnect', async t => {
  const h = await harness(t); await h.connect(); h.hold(1)
  const event = await signedEvent(h.alice, h.bob)
  const sent = h.peers[0].send(h.bob.publicKey, event)
  const failed = assert.rejects(sent, /closed|unconfirmed/i)
  await until(() => h.frames.some(frame => frame.side === 1))
  assert.equal(h.accepted[1].size, 1)
  h.peers[0].disconnect(h.bob.publicKey); await failed; h.release()
  await h.connect(); await h.peers[0].send(h.bob.publicKey, event)
  assert.equal(h.accepted[1].size, 1)
})

test('concurrent sends cannot overwrite the pending acknowledgement', async t => {
  const h = await harness(t); await h.connect()
  const wait = deferred(); h.pcs[0].statsWait = wait.promise
  const first = await signedEvent(h.alice, h.bob), second = await signedEvent(h.alice, h.bob, { content: 'Concurrent second draft' })
  const sent = h.peers[0].send(h.bob.publicKey, first)
  await assert.rejects(h.peers[0].send(h.bob.publicKey, second), /current direct transfer/)
  wait.resolve(); await sent
  assert.deepEqual([...h.accepted[1].keys()], [first.id])
})

test('revoke while candidate verification awaits blocks every content frame', async t => {
  const h = await harness(t); await h.connect()
  const wait = deferred(); h.pcs[0].statsWait = wait.promise
  const sent = h.peers[0].send(h.bob.publicKey, await signedEvent(h.alice, h.bob))
  h.allowed[0] = false; wait.resolve()
  await assert.rejects(sent)
  assert.equal(h.frames.length, 0)
})

test('selected TURN, missing and ambiguous candidate evidence all fail closed before payload', async t => {
  const h = await harness(t); await h.connect()
  const ambiguous = stats(); ambiguous.delete('transport'); ambiguous.set('previous', { ...ambiguous.get('selected') })
  for (const report of [stats('relay'), new Map(), ambiguous, new Map([...stats(), ['transport', { type: 'transport', selectedCandidatePairId: 'missing-current-pair' }]])]) {
    h.pcs[0].stats = report
    await assert.rejects(h.peers[0].send(h.bob.publicKey, await signedEvent(h.alice, h.bob)))
    assert.equal(h.frames.length, 0)
  }
})

test('a route change between encrypted fragments blocks all later fragments', async t => {
  const h = await harness(t, { maxMessageSize: 2048 }); await h.connect()
  const channel = h.pcs[0].channel, original = channel.send.bind(channel)
  channel.send = wire => { original(wire); h.pcs[0].stats = stats('relay') }
  const event = await signedEvent(h.alice, h.bob, { attachmentId: crypto.randomUUID(), index: 0, data: 'A'.repeat(40960) }, 'attachment-chunk')
  await assert.rejects(h.peers[0].send(h.bob.publicKey, event), /candidate pair/)
  assert.equal(h.frames.filter(frame => frame.side === 0).length, 1)
  assert.equal(h.accepted[1].size, 0)
})

test('negotiated frame bounds and buffered-amount backpressure preserve file bytes', async t => {
  const h = await harness(t, { maxMessageSize: 2048 }); await h.connect()
  h.pcs[0].channel.bufferedAmount = 100000
  const event = await signedEvent(h.alice, h.bob, { attachmentId: crypto.randomUUID(), index: 0, data: 'A'.repeat(40960) }, 'attachment-chunk')
  const sent = h.peers[0].send(h.bob.publicKey, event)
  await pause(40); assert.equal(h.frames.length, 0)
  h.pcs[0].channel.bufferedAmount = 0; await sent
  assert.deepEqual(h.accepted[1].get(event.id), event)
  assert.ok(h.frames.filter(frame => frame.side === 0).length > 20)
  assert.ok(h.frames.every(frame => new TextEncoder().encode(frame.wire).length <= 2048))
})

test('an acknowledgement encrypted by a different identity is rejected', async t => {
  const h = await harness(t); await h.connect(); h.hold(1)
  const event = await signedEvent(h.alice, h.bob), outsider = await identity()
  const sent = h.peers[0].send(h.bob.publicKey, event), failed = assert.rejects(sent)
  await until(() => h.frames.some(frame => frame.side === 1))
  const key = await cryptography.importKey(outsider.privateKey, 'encryption', 'private')
  const data = await cryptography.encryptForPeer(JSON.stringify({ session: h.signals[0].session, ack: event.id }), key, h.alice.publicKey)
  h.pcs[0].channel.onmessage({ data: JSON.stringify({ id: crypto.randomUUID(), index: 0, count: 1, data }) })
  await failed
  assert.equal(h.peers[0].status(h.bob.publicKey).state, 'failed')
})

test('a correctly encrypted acknowledgement for a different session is rejected', async t => {
  const h = await harness(t); await h.connect(); h.hold(1)
  const event = await signedEvent(h.alice, h.bob)
  const sent = h.peers[0].send(h.bob.publicKey, event), failed = assert.rejects(sent, /another session/)
  await until(() => h.frames.some(frame => frame.side === 1))
  const key = await cryptography.importKey(h.bob.privateKey, 'encryption', 'private')
  const data = await cryptography.encryptForPeer(JSON.stringify({ session: crypto.randomUUID(), ack: event.id }), key, h.alice.publicKey)
  h.pcs[0].channel.onmessage({ data: JSON.stringify({ id: crypto.randomUUID(), index: 0, count: 1, data }) })
  await failed
})

test('a matching peer and session cannot acknowledge a different event ID', async t => {
  const h = await harness(t); await h.connect(); h.hold(1)
  const event = await signedEvent(h.alice, h.bob)
  let resolved = false
  const sent = h.peers[0].send(h.bob.publicKey, event).then(() => { resolved = true })
  await until(() => h.frames.some(frame => frame.side === 1))
  const key = await cryptography.importKey(h.bob.privateKey, 'encryption', 'private')
  const data = await cryptography.encryptForPeer(JSON.stringify({ session: h.signals[0].session, ack: crypto.randomUUID() }), key, h.alice.publicKey)
  h.pcs[0].channel.onmessage({ data: JSON.stringify({ id: crypto.randomUUID(), index: 0, count: 1, data }) })
  await pause(15); assert.equal(resolved, false)
  h.release(); await sent
})

test('failed signed-event validation never sends a delivery acknowledgement', async t => {
  const h = await harness(t); await h.connect()
  const event = await signedEvent(h.alice, h.bob)
  const sent = h.peers[0].send(h.bob.publicKey, { ...event, payload: { content: 'Changed after signing' } })
  const failed = assert.rejects(sent)
  await until(() => h.peers[1].status(h.alice.publicKey).state === 'failed')
  assert.equal(h.accepted[1].size, 0)
  assert.equal(h.frames.some(frame => frame.side === 1), false)
  h.peers[0].disconnect(h.bob.publicKey); await failed
})

test('oversized or interleaved receive frames are bounded before decoding', async t => {
  for (const badFrames of [
    ['X'.repeat(16385)],
    [JSON.stringify({ id: 'one', index: 0, count: 2, data: 'a' }), JSON.stringify({ id: 'two', index: 1, count: 2, data: 'b' })],
  ]) {
    const h = await harness(t); await h.connect()
    for (const data of badFrames) h.pcs[1].channel.onmessage({ data })
    await until(() => h.peers[1].status(h.alice.publicKey).state === 'failed')
    assert.equal(h.accepted[1].size, 0)
    assert.equal(h.frames.length, 0)
  }
})
