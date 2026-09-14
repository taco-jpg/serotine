/* The real room engine, with controllable capture, peer connections and room leases. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
const source = ts.transpileModule(fs.readFileSync(path.join(root, 'lib/call-room-engine.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
class CallTransportError extends Error { constructor(message, code) { super(message); this.code = code } }
const roomId = target => target.kind === 'group' ? `${target.group.id}:admin:${target.group.admin}` : `${target.community.id}:channel:${target.channelId}`
const moduleValue = { exports: {} }
new Function('require', 'module', 'exports', source)(name => {
  if (name === './call-transport') return { CallTransportError, createCallTransport() { throw new Error('Inject configuration transport') } }
  if (name === './call-room-transport') return { callRoomId: roomId, createCallRoomTransport() { throw new Error('Inject room transport') } }
  if (name === './community-protocol') return { canJoinCommunityVoiceChannel(state, pub, id) {
    const channel = state.channels.find(item => item.id === id)
    return !state.deleted && state.members.includes(pub) && !state.bans.includes(pub) && channel?.kind === 'voice'
      && (channel.posting !== 'moderators' || state.owner === pub || state.moderators.includes(pub))
  } }
  throw new Error(`Unexpected runtime import ${name}`)
}, moduleValue, moduleValue.exports)
const { CallRoomEngine } = moduleValue.exports
const A = '04' + '1'.repeat(128), B = '04' + '2'.repeat(128), C = '04' + '3'.repeat(128)
const SDP = `v=0\r\na=fingerprint:sha-256 ${Array(32).fill('AB').join(':')}\r\n`
const changedSDP = SDP.replaceAll('AB', 'CD')
const pause = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
class Track {
  constructor(kind) { this.kind = kind; this.id = crypto.randomUUID(); this.enabled = true; this.readyState = 'live' }
  stop() { this.readyState = 'ended' }
  getSettings() { return { deviceId: this.id } }
}
class Stream {
  constructor(tracks = []) { this.tracks = [...tracks] }
  getTracks() { return [...this.tracks] }
  getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio') }
  getVideoTracks() { return this.tracks.filter(track => track.kind === 'video') }
  addTrack(track) { this.tracks.push(track) }
  removeTrack(track) { this.tracks = this.tracks.filter(item => item !== track) }
}
class PeerConnection {
  constructor(configuration) { this.configuration = configuration; this.senders = []; this.offers = []; this.candidates = []; this.events = []; this.connectionState = 'new'; this.signalingState = 'stable' }
  addTransceiver(track) { const sender = { track: typeof track === 'string' ? null : track, async replaceTrack(value) { this.track = value } }; this.senders.push(sender); return { sender } }
  async createOffer(options) { assert.equal(this.signalingState, 'stable', 'there must be no offer glare'); this.offers.push(options); return { type: 'offer', sdp: SDP } }
  async createAnswer() { assert.equal(this.signalingState, 'have-remote-offer'); return { type: 'answer', sdp: SDP } }
  async setLocalDescription(description) { this.localDescription = description; this.signalingState = description.type === 'offer' ? 'have-local-offer' : 'stable'; this.events.push(`local:${description.type}`) }
  async setRemoteDescription(description) { this.remoteDescription = description; this.signalingState = description.type === 'offer' ? 'have-remote-offer' : 'stable'; this.events.push(`remote:${description.type}`) }
  async addIceCandidate(candidate) { assert.ok(this.remoteDescription, 'ICE must wait for authenticated SDP'); this.candidates.push(candidate); this.events.push('ice') }
  setConfiguration(configuration) { this.configuration = configuration }
  close() { this.connectionState = 'closed' }
  state(state) { this.connectionState = state; this.onconnectionstatechange?.() }
}
function makeBus() { return { members: new Map(), signals: [], sent: [], joins: [], leaves: [] } }
function fixture(t, options = {}) {
  const key = options.key ?? A, bus = options.bus ?? makeBus(), pcs = [], captures = [], tracks = [], configurations = [], transports = []
  const state = { target: { kind: 'group', group: { id: 'group:' + crypto.randomUUID(), admin: A, name: 'Study group', members: [A, B, C], epoch: 1, signature: 'signed' } }, busy: false }
  if (options.target) state.target = options.target
  const room = () => ({ roomId: roomId(state.target), participants: [...bus.members.values()].map(value => ({ ...value })), limit: 8 })
  const createTransport = () => {
    const transport = {
      sessionId: crypto.randomUUID(),
      async join(target, mode, policy) { bus.joins.push({ key, target, mode, policy }); bus.members.set(key, { publicKey: key, sessionId: transport.sessionId, mode, policy, joinedAt: Date.now(), expiresAt: Date.now() + 30_000 }); return room() },
      async poll(_target, after) {
        const self = bus.members.get(key)
        if (self?.sessionId === transport.sessionId) self.expiresAt = Date.now() + 30_000
        const signals = bus.signals.filter(signal => signal.recipient === key && signal.targetSession === transport.sessionId)
        bus.signals = bus.signals.filter(signal => !signals.includes(signal))
        return { room: room(), signals, nextCursor: after + signals.length }
      },
      async send(id, peer, targetSession, payload) {
        const signal = { id: crypto.randomUUID(), roomId: id, sender: key, senderSession: transport.sessionId, recipient: peer, targetSession, expiresAt: Date.now() + 30_000, payload }
        bus.sent.push(signal); bus.signals.push(signal)
      },
      async leave(id) { bus.leaves.push({ key, sessionId: transport.sessionId, roomId: id }); if (bus.members.get(key)?.sessionId === transport.sessionId) bus.members.delete(key) },
      ...options.transport,
    }
    transports.push(transport)
    return transport
  }
  const mediaDevices = {
    async getUserMedia(constraints) { captures.push(constraints); const track = new Track(constraints.video ? 'video' : 'audio'); tracks.push(track); return new Stream([track]) },
    async enumerateDevices() { return [{ kind: 'audioinput', deviceId: 'mic', label: 'Microphone' }, { kind: 'videoinput', deviceId: 'cam', label: 'Camera' }] },
    ...options.mediaDevices,
  }
  const configurationTransport = { async configuration(policy) { configurations.push(policy); return { relayAvailable: options.relayAvailable ?? true, iceServers: [], expiresAt: Date.now() + 600_000 } }, ...options.configurationTransport }
  const engine = new CallRoomEngine({ identity: { version: 2, publicKey: key, privateKey: {} }, getTarget: () => state.target,
    getPeerLabel: pub => ({ [A]: 'Alice', [B]: 'Bob', [C]: 'Carol' })[pub], isBusy: () => state.busy,
    settings: { relayOnly: false, ...options.settings } }, {
    createTransport, configurationTransport, mediaDevices, createMediaStream: tracks => new Stream(tracks),
    createPeerConnection: configuration => { const pc = new PeerConnection(configuration); pcs.push(pc); return pc }, pollIntervalMs: 1_000_000, ...options.dependencies,
  })
  t.after(() => engine.dispose())
  async function poll() { if (engine.pollTimer) clearTimeout(engine.pollTimer); await engine.tick() }
  async function join(mode = 'audio') { await engine.prepare(state.target, mode); assert.equal(engine.getSnapshot().phase, 'preview'); await engine.joinPreview(); assert.equal(engine.getSnapshot().phase, 'joined') }
  function addPeer(pub = B, overrides = {}) { const peer = { publicKey: pub, sessionId: crypto.randomUUID(), mode: 'voice', policy: 'all', joinedAt: Date.now(), expiresAt: Date.now() + 30_000, ...overrides }; bus.members.set(pub, peer); return peer }
  function signal(peer, payload, overrides = {}) { bus.signals.push({ id: crypto.randomUUID(), roomId: roomId(state.target), sender: peer.publicKey, senderSession: peer.sessionId, recipient: key,
    targetSession: transports.at(-1).sessionId, expiresAt: Date.now() + 30_000, payload, ...overrides }) }
  return { engine, key, bus, state, pcs, tracks, captures, configurations, configurationTransport, mediaDevices, transports, get transport() { return transports.at(-1) }, poll, join, addPeer, signal, room }
}

test('preview requires local consent and never joins or creates senders before confirmation', async t => {
  const f = fixture(t)
  await f.engine.prepare(f.state.target, 'video')
  assert.equal(f.engine.getSnapshot().phase, 'preview'); assert.equal(f.captures.length, 2)
  assert.equal(f.bus.joins.length, 0); assert.equal(f.pcs.length, 0)
  await f.engine.leave()
  assert.ok(f.tracks.every(track => track.readyState === 'ended')); assert.equal(f.bus.joins.length, 0)
})

test('unconfigured relay waits without capture; direct routing starts only after explicit consent', async t => {
  const f = fixture(t, { settings: { relayOnly: true }, relayAvailable: false })
  await f.engine.prepare(f.state.target, 'audio')
  assert.equal(f.engine.getSnapshot().phase, 'routing'); assert.equal(f.captures.length, 0)
  assert.deepEqual(f.configurations, ['relay'])
  await f.engine.retryPreparation(true)
  assert.equal(f.engine.getSnapshot().phase, 'preview'); assert.deepEqual(f.configurations, ['relay', 'all'])
  assert.equal(f.engine.getSnapshot().settings.relayOnly, false); assert.equal(f.captures.length, 1)
})

test('three participants negotiate exactly three peer pairs with deterministic offerers', async t => {
  const bus = makeBus(), a = fixture(t, { bus }), b = fixture(t, { bus, key: B, target: a.state.target }), c = fixture(t, { bus, key: C, target: a.state.target })
  await a.join('video'); await b.join(); await c.join()
  for (let cycle = 0; cycle < 3; cycle++) for (const f of [a, b, c]) await f.poll()
  for (const f of [a, b, c]) {
    assert.equal(f.engine.getSnapshot().participants.length, 2); assert.equal(f.pcs.length, 2)
    assert.ok(f.pcs.every(pc => pc.localDescription && pc.remoteDescription && pc.signalingState === 'stable'))
    f.pcs.forEach(pc => pc.state('connected'))
    assert.ok(f.engine.getSnapshot().participants.every(peer => peer.phase === 'connected'))
    const audio = f.engine.getSnapshot().localStream.getAudioTracks()[0]
    assert.ok(f.pcs.every(pc => pc.senders[0].track === audio), 'each sender uses the single captured microphone')
  }
  const offers = bus.sent.filter(signal => signal.payload.kind === 'offer')
  assert.equal(offers.length, 3); assert.ok(offers.every(signal => signal.sender < signal.recipient))
  assert.equal(bus.sent.filter(signal => signal.payload.kind === 'answer').length, 3)
  assert.equal(a.captures.length, 2); assert.equal(b.captures.length, 1); assert.equal(c.captures.length, 1)
})

test('mute and device replacement fan out to all peers, and camera off releases capture', async t => {
  const f = fixture(t); f.addPeer(B); f.addPeer(C); await f.join('video')
  f.engine.toggleMicrophone(); await f.engine.selectMicrophone('another-microphone')
  const local = f.engine.getSnapshot().localStream, microphone = local.getAudioTracks()[0], camera = local.getVideoTracks()[0]
  assert.equal(microphone.enabled, false); assert.ok(f.pcs.every(pc => pc.senders[0].track === microphone))
  await f.engine.toggleCamera()
  assert.equal(camera.readyState, 'ended'); assert.equal(f.engine.getSnapshot().cameraEnabled, false)
  assert.ok(f.pcs.every(pc => pc.senders[1].track === null))
  await f.engine.leave(); assert.ok(f.pcs.every(pc => pc.connectionState === 'closed')); assert.ok(f.tracks.every(track => track.readyState === 'ended'))
})

test('late permission after leave cannot revive capture or replace a new room session', async t => {
  const pending = deferred(), oldTrack = new Track('audio'), f = fixture(t)
  const capture = f.mediaDevices.getUserMedia; f.mediaDevices.getUserMedia = () => pending.promise
  const preparing = f.engine.prepare(f.state.target, 'audio'); await pause(); await f.engine.leave()
  f.mediaDevices.getUserMedia = capture; await f.engine.prepare(f.state.target, 'audio')
  const current = f.engine.getSnapshot().localStream
  pending.resolve(new Stream([oldTrack])); await preparing
  assert.equal(oldTrack.readyState, 'ended'); assert.equal(f.engine.getSnapshot().localStream, current)
  assert.equal(f.engine.getSnapshot().phase, 'preview'); assert.notEqual(f.transports[0].sessionId, f.transports[1].sessionId)
})

test('a late join response after leave releases its old reservation without creating peer connections', async t => {
  const pending = deferred(), f = fixture(t); f.addPeer()
  await f.engine.prepare(f.state.target, 'audio')
  const join = f.transport.join; f.transport.join = async (...args) => { const result = await join(...args); await pending.promise; return result }
  const joining = f.engine.joinPreview(); await pause(); await f.engine.leave(); pending.resolve(); await joining
  assert.equal(f.engine.getSnapshot().phase, 'ended'); assert.equal(f.pcs.length, 0)
  assert.ok(f.tracks.every(track => track.readyState === 'ended')); assert.equal(f.bus.members.has(A), false)
})

test('ICE arriving before signed SDP is buffered and fingerprint changes close only the affected peer', async t => {
  const f = fixture(t, { key: C }), a = f.addPeer(A), b = f.addPeer(B); await f.join()
  f.signal(a, { kind: 'ice', candidate: { candidate: 'candidate:first', sdpMid: '0' } })
  f.signal(a, { kind: 'offer', description: { type: 'offer', sdp: SDP } })
  f.signal(b, { kind: 'offer', description: { type: 'offer', sdp: SDP } })
  await f.poll(); assert.deepEqual(f.pcs[0].events, ['remote:offer', 'ice', 'local:answer'])
  f.signal(a, { kind: 'offer', description: { type: 'offer', sdp: changedSDP } }); await f.poll()
  assert.equal(f.pcs[0].connectionState, 'closed'); assert.notEqual(f.pcs[1].connectionState, 'closed')
  assert.match(f.engine.getSnapshot().participants.find(peer => peer.publicKey === A).error, /media identity changed/)
  assert.equal(f.engine.getSnapshot().phase, 'joined'); assert.equal(f.tracks[0].readyState, 'live')
})

test('peer signals serialize remote SDP before ICE even when the browser awaits asynchronously', async t => {
  const pending = deferred(), f = fixture(t, { key: B }), peer = f.addPeer(A); await f.join()
  const pc = f.pcs[0], setRemote = pc.setRemoteDescription.bind(pc)
  pc.setRemoteDescription = async description => { await pending.promise; await setRemote(description) }
  f.signal(peer, { kind: 'offer', description: { type: 'offer', sdp: SDP } }); f.signal(peer, { kind: 'ice', candidate: { candidate: 'candidate:second' } })
  const polling = f.poll(); await pause(); assert.equal(pc.candidates.length, 0)
  pending.resolve(); await polling; assert.deepEqual(pc.events, ['remote:offer', 'local:answer', 'ice'])
})

test('peer departure stops remote tracks and rejoin requires a fresh session; old signals cannot attach', async t => {
  const f = fixture(t, { key: B }), old = f.addPeer(A); await f.join()
  const remote = new Track('audio'); f.pcs[0].ontrack({ track: remote })
  f.bus.members.delete(A); await f.poll()
  assert.equal(remote.readyState, 'ended'); assert.equal(f.pcs[0].connectionState, 'closed'); assert.equal(f.engine.getSnapshot().participants.length, 0)
  const next = f.addPeer(A); f.signal(old, { kind: 'offer', description: { type: 'offer', sdp: SDP } }); await f.poll()
  assert.equal(f.pcs.length, 2); assert.equal(f.pcs[1].remoteDescription, undefined)
  f.signal(next, { kind: 'offer', description: { type: 'offer', sdp: changedSDP } }); await f.poll()
  assert.equal(f.pcs[1].remoteDescription.sdp, changedSDP)
})

test('poll failure releases all media immediately even if sending leave is still pending', async t => {
  const pending = deferred(), f = fixture(t); f.addPeer(); await f.join('video')
  f.transport.poll = async () => { throw new Error('Network offline') }; f.transport.leave = () => pending.promise
  const polling = f.poll(); await pause()
  assert.equal(f.engine.getSnapshot().phase, 'failed'); assert.equal(f.engine.getSnapshot().localStream, null)
  assert.ok(f.tracks.every(track => track.readyState === 'ended')); assert.equal(f.pcs[0].connectionState, 'closed')
  pending.resolve(); await polling
})

test('membership revocation during preview stops capture and prevents any room join', async t => {
  const f = fixture(t); await f.engine.prepare(f.state.target, 'video'); f.state.target = null; await f.poll()
  assert.equal(f.engine.getSnapshot().phase, 'failed'); assert.ok(f.tracks.every(track => track.readyState === 'ended')); assert.equal(f.bus.joins.length, 0)
})

test('lease expiry stops media independently of an unresponsive poll', async t => {
  const f = fixture(t)
  await f.engine.prepare(f.state.target, 'audio')
  const join = f.transport.join; f.transport.join = async (...args) => { const result = await join(...args); result.participants[0].expiresAt = Date.now() + 20; return result }
  await f.engine.joinPreview(); await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(f.engine.getSnapshot().phase, 'failed'); assert.match(f.engine.getSnapshot().error, /expired/)
  assert.equal(f.tracks[0].readyState, 'ended')
})

test('a receiver can request bounded ICE recovery from the deterministic offerer without new capture', async t => {
  const bus = makeBus(), a = fixture(t, { bus }), b = fixture(t, { bus, key: B, target: a.state.target })
  await a.join(); await b.join(); for (let cycle = 0; cycle < 3; cycle++) { await a.poll(); await b.poll() }
  a.pcs[0].state('connected'); b.pcs[0].state('connected'); b.engine.toggleMicrophone()
  b.pcs[0].state('disconnected'); await pause()
  assert.ok(bus.sent.some(signal => signal.sender === B && signal.payload.kind === 'restart'))
  await a.poll(); await pause(); await b.poll(); await a.poll()
  assert.equal(a.pcs[0].offers.at(-1).iceRestart, true); assert.equal(b.pcs[0].offers.length, 0)
  assert.equal(a.captures.length, 1); assert.equal(b.captures.length, 1); assert.equal(b.engine.getSnapshot().microphoneMuted, true)
  assert.equal(b.engine.getSnapshot().localStream.getAudioTracks()[0].enabled, false)
})

test('voice channels refuse camera capture and stop a regular peer after a moderator-only change', async t => {
  const target = { kind: 'channel', channelId: 'voice', community: { id: 'community', name: 'Friends', owner: A, members: [A, B], moderators: [], bans: [], channels: [{ id: 'voice', name: 'Lounge', kind: 'voice', posting: 'members' }] } }
  const f = fixture(t, { target }); f.addPeer(B); await f.join('video')
  assert.equal(f.captures.length, 1); assert.equal(f.engine.getSnapshot().mode, 'audio')
  await f.engine.toggleCamera(); assert.equal(f.captures.length, 1)
  const remoteVideo = new Track('video'); f.pcs[0].ontrack({ track: remoteVideo }); assert.equal(remoteVideo.readyState, 'ended')
  target.community.channels[0].posting = 'moderators'; await f.poll()
  assert.equal(f.engine.getSnapshot().participants.length, 0); assert.equal(f.pcs[0].connectionState, 'closed')
  target.community.channels[0].kind = 'text'; await f.poll()
  assert.equal(f.engine.getSnapshot().phase, 'failed'); assert.equal(f.tracks[0].readyState, 'ended')
})

test('invalid oversized roster and another-device membership never create peer senders', async t => {
  for (const change of [room => { room.participants.push(...Array.from({ length: 8 }, (_, index) => ({ ...room.participants[0], publicKey: `peer-${index}` }))) }, room => { room.participants[0].sessionId = crypto.randomUUID() }]) {
    const f = fixture(t); await f.engine.prepare(f.state.target, 'audio')
    const join = f.transport.join; f.transport.join = async (...args) => { const room = await join(...args); change(room); return room }
    await f.engine.joinPreview(); assert.equal(f.engine.getSnapshot().phase, 'failed'); assert.equal(f.pcs.length, 0)
    assert.ok(f.tracks.every(track => track.readyState === 'ended'))
  }
})

test('changing to relay-only while joined releases the direct session instead of silently mixing policies', async t => {
  const f = fixture(t); f.addPeer(); await f.join(); f.engine.updateSettings({ relayOnly: true }); await pause()
  assert.equal(f.engine.getSnapshot().phase, 'ended'); assert.match(f.engine.getSnapshot().error, /relay-only/)
  assert.ok(f.tracks.every(track => track.readyState === 'ended')); assert.equal(f.pcs[0].connectionState, 'closed')
})

test('a peer arriving during microphone replacement receives the same replacement as existing peers', async t => {
  const pending = deferred(), f = fixture(t); f.addPeer(B); await f.join()
  const old = f.engine.getSnapshot().localStream.getAudioTracks()[0]
  const sender = f.pcs[0].senders[0], replace = sender.replaceTrack.bind(sender)
  sender.replaceTrack = async track => { await pending.promise; await replace(track) }
  f.engine.toggleMicrophone()
  const replacing = f.engine.selectMicrophone('new-microphone'); await pause()
  f.addPeer(C); await f.poll(); assert.equal(f.pcs[1].senders[0].track, old)
  pending.resolve(); await replacing
  const current = f.engine.getSnapshot().localStream.getAudioTracks()[0]
  assert.notEqual(current, old); assert.equal(current.enabled, false); assert.equal(old.readyState, 'ended')
  assert.ok(f.pcs.every(pc => pc.senders[0].track === current))
})

test('camera off during a pending sender replacement stops both camera tracks and wins the race', async t => {
  const pending = deferred(), f = fixture(t); f.addPeer(B); await f.join('video')
  const sender = f.pcs[0].senders[1], replace = sender.replaceTrack.bind(sender)
  let first = true
  sender.replaceTrack = async track => { if (first) { first = false; await pending.promise } await replace(track) }
  const replacing = f.engine.selectCamera('new-camera'); await pause()
  const stopping = f.engine.toggleCamera(); pending.resolve(); await Promise.all([replacing, stopping])
  assert.equal(f.engine.getSnapshot().cameraEnabled, false); assert.equal(f.engine.getSnapshot().localStream.getVideoTracks().length, 0)
  assert.ok(f.tracks.filter(track => track.kind === 'video').every(track => track.readyState === 'ended'))
  assert.equal(sender.track, null)
})
