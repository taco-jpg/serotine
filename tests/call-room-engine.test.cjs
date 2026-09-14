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
const iceModule = { exports: {} }
const iceSource = ts.transpileModule(fs.readFileSync(path.join(root, 'lib/call-ice.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
new Function('module', 'exports', iceSource)(iceModule, iceModule.exports)
const roomId = target => target.kind === 'group' ? `${target.group.id}:admin:${target.group.admin}` : `${target.community.id}:channel:${target.channelId}`
const moduleValue = { exports: {} }
new Function('require', 'module', 'exports', source)(name => {
  if (name === './call-transport') return { CallTransportError, createCallTransport() { throw new Error('Inject configuration transport') } }
  if (name === './call-ice') return iceModule.exports
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
    const listeners = new Set()
    const transport = {
      sessionId: crypto.randomUUID(),
      subscribe(listener) { assert.notEqual(this.disposed, true, 'cannot reuse a disposed room transport'); listeners.add(listener); return () => listeners.delete(listener) },
      wake() { for (const listener of listeners) listener() },
      listenerCount() { return listeners.size },
      dispose() { this.disposed = true; listeners.clear() },
      async join(target, mode, policy) { assert.notEqual(this.disposed, true, 'cannot reuse a disposed room transport'); bus.joins.push({ key, target, mode, policy }); bus.members.set(key, { publicKey: key, sessionId: transport.sessionId, mode, policy, joinedAt: Date.now(), expiresAt: Date.now() + 30_000 }); return room() },
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
  const configurationTransport = { async configuration(policy) { configurations.push(policy); return { iceServers: [{ urls: 'stun:stun.example.test:3478' }], expiresAt: Date.now() + 600_000 } }, dispose() { this.disposed = true }, ...options.configurationTransport }
  const engine = new CallRoomEngine({ identity: { version: 2, publicKey: key, privateKey: {} }, getTarget: () => state.target,
    getPeerLabel: pub => ({ [A]: 'Alice', [B]: 'Bob', [C]: 'Carol' })[pub], isBusy: () => state.busy,
    settings: options.settings }, {
    createTransport, configurationTransport, mediaDevices, createMediaStream: tracks => new Stream(tracks),
    createPeerConnection: configuration => { const pc = new PeerConnection(configuration); pcs.push(pc); return pc }, heartbeatIntervalMs: 1_000_000, ...options.dependencies,
  })
  t.after(() => engine.dispose())
  async function poll() { if (engine.pollTimer) clearTimeout(engine.pollTimer); await engine.tick() }
  async function join(mode = 'audio') { await engine.prepare(state.target, mode); assert.equal(engine.getSnapshot().phase, 'preview'); await engine.joinPreview(); await pause(); assert.equal(engine.getSnapshot().phase, 'joined') }
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

test('stored legacy routing settings cannot force relay or block direct calls', async t => {
  const f = fixture(t, { settings: { relayOnly: true }, relayAvailable: false })
  f.addPeer(); await f.join()
  assert.deepEqual(f.configurations, ['all'])
  assert.equal('relayOnly' in f.engine.getSnapshot().settings, false); assert.equal(f.captures.length, 1)
  assert.equal(f.bus.joins[0].policy, 'all')
  assert.equal(f.pcs[0].configuration.iceTransportPolicy, 'all')
  assert.deepEqual(f.pcs[0].configuration.iceServers, [{ urls: ['stun:stun.example.test:3478'] }])
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
  f.transport.poll = () => new Promise(() => {})
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

test('legacy routing updates are discarded without ending an active direct session', async t => {
  const f = fixture(t); f.addPeer(); await f.join(); f.engine.updateSettings({ relayOnly: true }); await pause()
  assert.equal(f.engine.getSnapshot().phase, 'joined'); assert.equal('relayOnly' in f.engine.getSnapshot().settings, false)
  assert.ok(f.tracks.every(track => track.readyState === 'live')); assert.notEqual(f.pcs[0].connectionState, 'closed')
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

test('unmanaged TURN configuration is rejected before capture even alongside a valid STUN server', async t => {
  for (const iceServers of [
    [{ urls: ['stun:stun.example.test', 'turn:relay.example.test'] }],
    [{ urls: 'turns:relay.example.test:443', username: 'user', credential: 'secret' }],
    [{ urls: 'stun:stun.example.test', credential: 'unexpected' }],
  ]) {
    const f = fixture(t, { configurationTransport: { async configuration() { return { iceServers, expiresAt: Date.now() + 600_000 } } } })
    await f.engine.prepare(f.state.target, 'audio')
    assert.equal(f.engine.getSnapshot().phase, 'failed')
    assert.match(f.engine.getSnapshot().error, /direct|STUN|relay|configuration/i)
    assert.equal(f.captures.length, 0); assert.equal(f.pcs.length, 0)
    assert.equal(f.transport.disposed, true)
  }
})

test('relay-only room members cannot start a connection under a direct-call policy', async t => {
  const f = fixture(t); f.addPeer(B, { policy: 'relay' })
  await f.engine.prepare(f.state.target, 'audio'); await f.engine.joinPreview()
  assert.equal(f.engine.getSnapshot().phase, 'failed')
  assert.match(f.engine.getSnapshot().error, /incompatible/)
  assert.equal(f.pcs.length, 0); assert.ok(f.tracks.every(track => track.readyState === 'ended'))
})

test('authenticated room relay candidates are accepted while other participants remain connected', async t => {
  const relayCandidate = 'candidate:relay 1 udp 1 192.0.2.10 12345 typ relay raddr 0.0.0.0 rport 0'
  for (const payload of [
    { kind: 'offer', description: { type: 'offer', sdp: `${SDP}a=${relayCandidate}\r\n` } },
    { kind: 'ice', candidate: { candidate: relayCandidate } },
  ]) {
    const f = fixture(t, { key: C }), peer = f.addPeer(A); f.addPeer(B); await f.join()
    f.signal(peer, payload); await f.poll()
    assert.equal(f.engine.getSnapshot().participants.find(value => value.publicKey === A).phase, 'connecting')
    assert.notEqual(f.pcs[0].connectionState, 'closed')
    if (payload.kind === 'offer') assert.ok(f.pcs[0].remoteDescription.sdp.includes('typ relay'))
    else assert.equal(f.engine.peers.get(A).pendingIce.length, 1)
    assert.notEqual(f.pcs[1].connectionState, 'closed'); assert.equal(f.engine.getSnapshot().phase, 'joined')
  }
})

test('a blocked direct connection times out while other participants stay connected', async t => {
  const f = fixture(t, { dependencies: { connectTimeoutMs: 25 } }); f.addPeer(B); f.addPeer(C); await f.join()
  const failedAudio = new Track('audio'); f.pcs[0].ontrack({ track: failedAudio })
  f.pcs[1].state('connected')
  await new Promise(resolve => setTimeout(resolve, 50))
  const peers = f.engine.getSnapshot().participants
  assert.equal(peers[0].phase, 'failed'); assert.match(peers[0].error, /WebRTC connection/i)
  assert.equal(f.pcs[0].connectionState, 'closed'); assert.equal(failedAudio.readyState, 'ended')
  assert.equal(peers[1].phase, 'connected'); assert.equal(f.engine.getSnapshot().phase, 'joined')
  assert.equal(f.captures.length, 1); assert.ok(f.configurations.every(value => value === 'all'))
  assert.equal(f.tracks[0].readyState, 'live')
  await f.engine.leave(); assert.equal(f.tracks[0].readyState, 'ended')
})

test('WebSocket wake drains a new participant and SDP without waiting for a heartbeat', async t => {
  const f = fixture(t, { key: B }); await f.join()
  const peer = f.addPeer(A)
  f.signal(peer, { kind: 'offer', description: { type: 'offer', sdp: SDP } })
  f.transport.wake(); await pause()
  assert.equal(f.pcs.length, 1); assert.equal(f.pcs[0].remoteDescription.sdp, SDP)
  assert.ok(f.bus.sent.some(signal => signal.payload.kind === 'answer'))
  assert.equal(f.transport.listenerCount(), 1)
  const oldTransport = f.transport
  await f.engine.leave()
  assert.equal(oldTransport.listenerCount(), 0); assert.equal(oldTransport.disposed, true)
  oldTransport.wake(); await pause()
  assert.equal(f.engine.getSnapshot().phase, 'ended'); assert.equal(f.pcs.length, 1)
})

test('pushes during a pending drain are coalesced without concurrent roster requests or lost signals', async t => {
  const pending = deferred(), f = fixture(t, { key: B }); await f.join()
  const peer = f.addPeer(A), originalPoll = f.transport.poll
  let requests = 0, active = 0, maxActive = 0
  f.transport.poll = async (...args) => {
    const index = ++requests; maxActive = Math.max(maxActive, ++active)
    const result = await originalPoll(...args)
    if (index === 1) await pending.promise
    active--
    return result
  }
  f.transport.wake(); await pause()
  f.signal(peer, { kind: 'offer', description: { type: 'offer', sdp: SDP } })
  for (let index = 0; index < 10; index++) f.transport.wake()
  assert.equal(requests, 1)
  pending.resolve(); await pause()
  assert.equal(maxActive, 1); assert.equal(requests, 2)
  assert.equal(f.pcs[0].remoteDescription.sdp, SDP)
  assert.equal(f.bus.sent.filter(signal => signal.payload.kind === 'answer').length, 1)
})

test('idle room signaling refreshes its lease every ten seconds rather than rapidly polling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const f = fixture(t, { dependencies: { heartbeatIntervalMs: undefined } }); await f.join()
  let requests = 0
  const poll = f.transport.poll
  f.transport.poll = async (...args) => { requests++; return poll(...args) }
  t.mock.timers.tick(9_999); await pause(); assert.equal(requests, 0)
  t.mock.timers.tick(1); await pause(); assert.equal(requests, 1)
  await f.engine.leave()
  t.mock.timers.tick(20_000); await pause(); assert.equal(requests, 1)
})

test('leaving then rejoining opens a fresh room socket and keeps reusable STUN configuration available', async t => {
  const f = fixture(t); f.addPeer(B); await f.join()
  const first = f.transport, firstAudio = f.tracks[0]
  await f.engine.leave()
  assert.equal(first.disposed, true); assert.equal(first.listenerCount(), 0)
  assert.equal(firstAudio.readyState, 'ended'); assert.notEqual(f.configurationTransport.disposed, true)
  await f.join()
  assert.notEqual(f.transport, first); assert.notEqual(f.transport.sessionId, first.sessionId)
  assert.notEqual(f.transport.disposed, true); assert.equal(f.transport.listenerCount(), 1)
  assert.equal(f.pcs.length, 2); assert.equal(f.captures.length, 2)
  f.engine.dispose(); await pause()
  assert.equal(f.transport.disposed, true); assert.equal(f.configurationTransport.disposed, true)
  assert.ok(f.tracks.every(track => track.readyState === 'ended'))
})

test('a full wire page drains immediately even if every signal on that page was filtered out', async t => {
  const f = fixture(t, { key: B }); await f.join()
  const peer = f.addPeer(A), originalPoll = f.transport.poll
  const cursors = []
  f.transport.poll = async (target, after) => {
    cursors.push(after)
    if (cursors.length === 1) return { room: f.room(), signals: [], nextCursor: after + 100, hasMore: true }
    return originalPoll(target, after)
  }
  f.signal(peer, { kind: 'offer', description: { type: 'offer', sdp: SDP } })
  f.transport.wake(); await pause()
  assert.deepEqual(cursors, [0, 100])
  assert.equal(f.pcs[0].remoteDescription.sdp, SDP)
  assert.equal(f.bus.sent.filter(signal => signal.payload.kind === 'answer').length, 1)
})
