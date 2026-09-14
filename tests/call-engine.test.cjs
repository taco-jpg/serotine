/* Exercise the actual call state machine with controllable browser capture and transport boundaries. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
const engineSource = ts.transpileModule(fs.readFileSync(path.join(root, 'lib/call-engine.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const moduleValue = { exports: {} }
new Function('require', 'module', 'exports', engineSource)(name => {
  if (name === './call-transport') return { createCallTransport() { throw new Error('Test requires explicit transport') } }
  if (name === './identity') return { loadContacts: () => [], shortAddress: value => value.slice(0, 8) }
  throw new Error(`Unexpected runtime import: ${name}`)
}, moduleValue, moduleValue.exports)
const { CallEngine } = moduleValue.exports
const OWNER = '04' + '1'.repeat(128)
const PEER = '04' + '2'.repeat(128)
const fingerprint = Array(32).fill('AB').join(':')
const SDP = `v=0\r\na=fingerprint:sha-256 ${fingerprint}\r\n`
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
class Track {
  constructor(kind, id = `${kind}-${crypto.randomUUID()}`) { this.kind = kind; this.id = id; this.enabled = true; this.readyState = 'live'; this.stops = 0; this.onended = null }
  stop() { this.readyState = 'ended'; this.stops++ }
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
  constructor(configuration) { this.configuration = configuration; this.senders = []; this.connectionState = 'new'; this.offers = []; this.candidates = [] }
  addTransceiver(track) { const sender = { track: typeof track === 'string' ? null : track, async replaceTrack(next) { this.track = next } }; this.senders.push(sender); return { sender } }
  async createOffer(options) { this.offers.push(options); return { type: 'offer', sdp: SDP } }
  async createAnswer() { return { type: 'answer', sdp: SDP } }
  async setLocalDescription(description) { this.localDescription = description }
  async setRemoteDescription(description) { this.remoteDescription = description }
  async addIceCandidate(candidate) { this.candidates.push(candidate) }
  setConfiguration(configuration) { this.configuration = configuration }
  close() { this.connectionState = 'closed' }
  state(state) { this.connectionState = state; this.onconnectionstatechange?.() }
}
function fixture(t, options = {}) {
  const tracks = [], captures = [], pcs = [], sent = [], finished = [], history = [], sessions = new Map(), queued = [], heartbeats = []
  const policy = { accepted: true, label: 'Peer', ...options.policy }
  const transport = {
    sessionId: crypto.randomUUID(),
    async heartbeat(peers, incomingPeers) { heartbeats.push({ peers, incomingPeers }) },
    async capability() { return { available: true, busy: false } },
    async configuration() { return { iceServers: [], relayAvailable: options.relayAvailable ?? true, expiresAt: Date.now() + 600_000 } },
    async invite(peer, callId, payload) {
      const session = { callId, caller: OWNER, recipient: peer, callerSession: transport.sessionId, recipientSession: null, status: 'ringing',
        createdAt: Date.now(), inviteExpiresAt: Date.now() + 40_000, expiresAt: Date.now() + 40_000, reason: null, noHistory: payload.private }
      sessions.set(callId, session); return session
    },
    async claim(callId, noHistory) { const session = sessions.get(callId); Object.assign(session, { recipientSession: transport.sessionId, status: 'active', noHistory: session.noHistory || noHistory }); return session },
    async send(callId, peer, targetSession, payload) { sent.push({ callId, peer, targetSession, payload }) },
    async poll(after) { return { signals: queued.splice(0), sessions: [...sessions.values()], nextCursor: after + 1 } },
    async finish(callId, reason, noHistory) { finished.push({ callId, reason, noHistory }); const session = sessions.get(callId); if (session) Object.assign(session, { status: 'ended', reason, noHistory: session.noHistory || noHistory }); return session },
    ...options.transport,
  }
  const mediaDevices = {
    async getUserMedia(constraints) { captures.push(constraints); const track = new Track(constraints.video ? 'video' : 'audio'); tracks.push(track); return new Stream([track]) },
    async enumerateDevices() { return [{ kind: 'audioinput', deviceId: 'mic', label: 'Microphone' }, { kind: 'videoinput', deviceId: 'camera', label: 'Camera' }] },
    ...options.mediaDevices,
  }
  const engine = new CallEngine({ identity: { version: 2, publicKey: OWNER, privateKey: {} }, getPeerPolicy: () => policy, getPeers: () => [PEER],
    settings: { relayOnly: false, ...options.settings }, onCompleted: record => history.push(record) }, {
    transport, mediaDevices, createMediaStream: tracks => new Stream(tracks), createPeerConnection: configuration => { const pc = new PeerConnection(configuration); pcs.push(pc); return pc },
    pollIntervalMs: 1_000_000, ...options.dependencies,
  })
  t.after(() => engine.dispose())
  async function poll() { if (engine.pollTimer) clearTimeout(engine.pollTimer); engine.running = true; await engine.tick() }
  function incoming(payload = {}) {
    const callId = crypto.randomUUID(), callerSession = crypto.randomUUID()
    const session = { callId, caller: PEER, recipient: OWNER, callerSession, recipientSession: null, status: 'ringing', createdAt: Date.now(), inviteExpiresAt: Date.now() + 40_000, expiresAt: Date.now() + 40_000, reason: null, noHistory: false }
    sessions.set(callId, session)
    queued.push({ id: crypto.randomUUID(), callId, sender: PEER, recipient: OWNER, senderSession: callerSession, targetSession: null,
      expiresAt: session.inviteExpiresAt, payload: { kind: 'invite', mode: 'video', policy: 'all', private: false, ...payload } })
    return session
  }
  async function acceptOutgoing() {
    const session = sessions.get(engine.getSnapshot().callId)
    session.status = 'active'; session.recipientSession = crypto.randomUUID()
    queued.push({ id: crypto.randomUUID(), callId: session.callId, sender: PEER, recipient: OWNER, senderSession: session.recipientSession,
      targetSession: transport.sessionId, expiresAt: Date.now() + 30_000, payload: { kind: 'accept', mode: 'voice', private: false } })
    await poll()
  }
  return { engine, transport, mediaDevices, policy, tracks, captures, pcs, sent, finished, history, sessions, queued, heartbeats, poll, incoming, acceptOutgoing }
}

test('outgoing preview and ringing capture locally but create no senders until the selected contact accepts', async t => {
  const f = fixture(t)
  await f.engine.prepareOutgoing(PEER, 'video')
  assert.equal(f.engine.getSnapshot().phase, 'preview'); assert.equal(f.captures.length, 2); assert.equal(f.pcs.length, 0)
  await f.engine.connectPreview()
  assert.equal(f.engine.getSnapshot().phase, 'ringing'); assert.equal(f.pcs.length, 0); assert.equal(f.sent.length, 0)
  await f.acceptOutgoing()
  assert.equal(f.engine.getSnapshot().phase, 'connecting'); assert.equal(f.pcs.length, 1)
  assert.equal(f.pcs[0].senders.filter(sender => sender.track).length, 2)
  assert.equal(f.sent.at(-1).payload.kind, 'offer')
  await f.engine.end()
  assert.ok(f.tracks.every(track => track.readyState === 'ended')); assert.equal(f.pcs[0].connectionState, 'closed')
})

test('incoming video invitation never captures and can be previewed and accepted with audio only', async t => {
  const f = fixture(t)
  f.incoming(); await f.poll()
  assert.equal(f.engine.getSnapshot().phase, 'incoming'); assert.equal(f.captures.length, 0)
  await f.engine.prepareIncoming('audio')
  assert.equal(f.engine.getSnapshot().phase, 'preview'); assert.equal(f.captures.length, 1); assert.equal(f.captures[0].video, false); assert.equal(f.pcs.length, 0)
  await f.engine.connectPreview()
  assert.equal(f.pcs.length, 1); assert.equal(f.engine.getSnapshot().cameraEnabled, false)
  assert.deepEqual(f.sent.at(-1).payload, { kind: 'accept', mode: 'voice', private: false })
})

test('permission denied leaves a clear terminal state with no peer connection or retained capture', async t => {
  const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
  const f = fixture(t, { mediaDevices: { async getUserMedia() { throw denied } } })
  await f.engine.prepareOutgoing(PEER, 'audio')
  assert.equal(f.engine.getSnapshot().phase, 'failed'); assert.match(f.engine.getSnapshot().error, /access was denied/)
  assert.equal(f.engine.getSnapshot().localStream, null); assert.equal(f.pcs.length, 0)
})

test('late permission grant after ending cannot revive capture or replace a newer call', async t => {
  const pending = deferred(), oldTrack = new Track('audio')
  const f = fixture(t)
  const ordinaryCapture = f.mediaDevices.getUserMedia
  f.mediaDevices.getUserMedia = () => pending.promise
  const preparing = f.engine.prepareOutgoing(PEER, 'audio')
  await new Promise(resolve => setImmediate(resolve))
  await f.engine.end()
  f.mediaDevices.getUserMedia = ordinaryCapture
  await f.engine.prepareOutgoing(PEER, 'audio')
  const newStream = f.engine.getSnapshot().localStream
  pending.resolve(new Stream([oldTrack])); await preparing
  assert.equal(oldTrack.readyState, 'ended'); assert.equal(f.engine.getSnapshot().phase, 'preview')
  assert.equal(f.engine.getSnapshot().localStream, newStream); assert.equal(newStream.getAudioTracks()[0].readyState, 'live')
})

test('late camera permission after disposal stops both existing audio and the late camera', async t => {
  const pending = deferred(), camera = new Track('video')
  const f = fixture(t)
  const capture = f.mediaDevices.getUserMedia
  f.mediaDevices.getUserMedia = constraints => constraints.video ? pending.promise : capture(constraints)
  const preparing = f.engine.prepareOutgoing(PEER, 'video')
  await new Promise(resolve => setImmediate(resolve))
  f.engine.dispose(); pending.resolve(new Stream([camera])); await preparing
  assert.equal(camera.readyState, 'ended'); assert.ok(f.tracks.every(track => track.readyState === 'ended')); assert.equal(f.pcs.length, 0)
})

test('mute survives microphone replacement and ICE recovery, and camera-off actually stops capture', async t => {
  const f = fixture(t)
  await f.engine.prepareOutgoing(PEER, 'video'); await f.engine.connectPreview(); await f.acceptOutgoing()
  const pc = f.pcs[0]; pc.state('connected'); f.engine.toggleMicrophone()
  await f.engine.selectMicrophone('replacement')
  assert.equal(f.engine.getSnapshot().localStream.getAudioTracks()[0].enabled, false)
  const camera = f.engine.getSnapshot().localStream.getVideoTracks()[0]
  await f.engine.toggleCamera()
  assert.equal(camera.readyState, 'ended'); assert.equal(pc.senders[1].track, null); assert.equal(f.engine.getSnapshot().cameraEnabled, false)
  const captures = f.captures.length
  pc.state('disconnected'); await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.engine.getSnapshot().phase, 'reconnecting'); assert.equal(pc.offers.at(-1).iceRestart, true)
  assert.equal(f.engine.getSnapshot().microphoneMuted, true); assert.equal(f.captures.length, captures)
  pc.state('connected'); assert.equal(f.engine.getSnapshot().microphoneMuted, true)
})

test('unaccepted, blocked, archived, muted and silenced invitations cannot ring', async t => {
  for (const restrictions of [{ accepted: false }, { blocked: true }, { archived: true }, { muted: true }, { silence: true }]) {
    const f = fixture(t, { policy: restrictions, settings: { silenceIncoming: !!restrictions.silence } })
    f.incoming(); await f.poll()
    assert.equal(f.engine.getSnapshot().phase, 'idle'); assert.equal(f.captures.length, 0)
    f.engine.dispose()
  }
})

test('silencing incoming invitations still advertises accepted peers for outgoing calls', async t => {
  const f = fixture(t, { settings: { silenceIncoming: true } })
  await f.poll()
  assert.deepEqual(f.heartbeats[0], { peers: [PEER], incomingPeers: [] })
  await f.engine.prepareOutgoing(PEER, 'audio'); await f.engine.connectPreview()
  assert.equal(f.engine.getSnapshot().phase, 'ringing')
})

test('stale invitation or terminal session cannot be resurrected by a delayed signal', async t => {
  const f = fixture(t)
  const session = f.incoming(); session.status = 'ended'; session.reason = 'cancelled'
  await f.poll(); assert.equal(f.engine.getSnapshot().phase, 'idle')
  f.incoming(); f.queued[0].expiresAt = Date.now() - 1
  await f.poll(); assert.equal(f.engine.getSnapshot().phase, 'idle')
})

test('another device winning acceptance stops preflight capture without duplicating its history', async t => {
  const f = fixture(t)
  const session = f.incoming(); await f.poll(); await f.engine.prepareIncoming('audio')
  session.status = 'active'; session.recipientSession = crypto.randomUUID()
  await f.poll()
  assert.equal(f.engine.getSnapshot().phase, 'ended'); assert.match(f.engine.getSnapshot().error, /another device/)
  assert.ok(f.tracks.every(track => track.readyState === 'ended')); assert.equal(f.history.length, 0); assert.equal(f.finished.length, 0)
})

test('cancelling while invite request is in flight releases capture and cancels the eventual published invite', async t => {
  const f = fixture(t), pending = deferred()
  const invite = f.transport.invite
  f.transport.invite = async (...args) => { const session = await invite(...args); await pending.promise; return session }
  await f.engine.prepareOutgoing(PEER, 'audio')
  const connecting = f.engine.connectPreview()
  await new Promise(resolve => setImmediate(resolve)); await f.engine.end()
  pending.resolve(); await connecting
  assert.equal(f.engine.getSnapshot().phase, 'ended'); assert.ok(f.tracks.every(track => track.readyState === 'ended'))
  assert.equal(f.finished.at(-1).reason, 'cancelled'); assert.equal(f.pcs.length, 0)
})

test('relay-only preflight fails without a relay, without obtaining any microphone or camera', async t => {
  const f = fixture(t, { relayAvailable: false, settings: { relayOnly: true } })
  await f.engine.prepareOutgoing(PEER, 'video')
  assert.equal(f.engine.getSnapshot().phase, 'failed'); assert.match(f.engine.getSnapshot().error, /TURN relay/)
  assert.equal(f.captures.length, 0); assert.equal(f.pcs.length, 0)
})

test('upgrading privacy while direct-call preflight is open ends that setup instead of silently using direct routing', async t => {
  const f = fixture(t)
  await f.engine.prepareOutgoing(PEER, 'audio'); f.engine.updateSettings({ relayOnly: true })
  assert.equal(f.engine.getSnapshot().phase, 'ended'); assert.ok(f.tracks.every(track => track.readyState === 'ended'))
  await f.engine.connectPreview(); assert.equal(f.sessions.size, 0)
})

test('a selected-device mismatch cannot negotiate media', async t => {
  const f = fixture(t)
  await f.engine.prepareOutgoing(PEER, 'audio'); await f.engine.connectPreview()
  const session = f.sessions.get(f.engine.getSnapshot().callId)
  session.status = 'active'; session.recipientSession = crypto.randomUUID()
  f.queued.push({ id: crypto.randomUUID(), callId: session.callId, sender: PEER, recipient: OWNER, senderSession: crypto.randomUUID(), targetSession: f.transport.sessionId,
    expiresAt: Date.now() + 10_000, payload: { kind: 'accept', mode: 'voice', private: false } })
  await f.poll(); assert.equal(f.pcs.length, 0); assert.equal(f.engine.getSnapshot().phase, 'ringing')
})

test('initial microphone loss is visible and marks the microphone muted', async t => {
  const f = fixture(t)
  await f.engine.prepareOutgoing(PEER, 'audio')
  f.tracks[0].onended()
  assert.equal(f.engine.getSnapshot().microphoneMuted, true); assert.match(f.engine.getSnapshot().notice, /microphone stopped/)
})

test('permission and connection deadlines release capture instead of waiting indefinitely', async t => {
  const f = fixture(t, { dependencies: { prepareTimeoutMs: 20 } })
  await f.engine.prepareOutgoing(PEER, 'audio')
  await new Promise(resolve => setTimeout(resolve, 35))
  assert.equal(f.engine.getSnapshot().phase, 'failed'); assert.ok(f.tracks.every(track => track.readyState === 'ended'))
})

test('server-awarded incoming call replaces a simultaneous unpublished outgoing setup', async t => {
  const f = fixture(t)
  await f.engine.prepareOutgoing(PEER, 'audio')
  const localAudio = f.tracks[0]
  const winner = f.incoming(); await f.poll()
  assert.equal(f.engine.getSnapshot().phase, 'incoming'); assert.equal(f.engine.getSnapshot().callId, winner.callId)
  assert.equal(localAudio.readyState, 'ended'); assert.equal(f.engine.getSnapshot().localStream, null)
  assert.equal(f.captures.length, 1); assert.equal(f.pcs.length, 0)
})

test('private mode changed in preview is latched before invitation publication', async t => {
  const f = fixture(t)
  await f.engine.prepareOutgoing(PEER, 'audio'); f.policy.private = true
  await f.engine.connectPreview()
  assert.equal(f.sessions.get(f.engine.getSnapshot().callId).noHistory, true)
  await f.engine.end(); assert.equal(f.history[0].private, true)
})

test('atomic terminal noHistory overrides a stale local privacy value before writing history', async t => {
  const f = fixture(t)
  await f.engine.prepareOutgoing(PEER, 'audio'); await f.engine.connectPreview(); await f.acceptOutgoing()
  f.sessions.get(f.engine.getSnapshot().callId).noHistory = true
  await f.engine.end()
  assert.equal(f.history.length, 1); assert.equal(f.history[0].private, true)
})

test('late sticky noHistory tombstones re-emit a privacy correction for an already-finished summary', async t => {
  const f = fixture(t)
  await f.engine.prepareOutgoing(PEER, 'audio'); await f.engine.connectPreview(); await f.acceptOutgoing()
  const callId = f.engine.getSnapshot().callId
  await f.engine.end(); assert.equal(f.history[0].private, false)
  f.sessions.get(callId).noHistory = true
  await f.poll()
  assert.equal(f.history.length, 2); assert.equal(f.history[1].id, callId); assert.equal(f.history[1].private, true)
})

test('microphone replacement and camera-off run independently without killing the active microphone', async t => {
  const f = fixture(t)
  await f.engine.prepareOutgoing(PEER, 'video'); await f.engine.connectPreview(); await f.acceptOutgoing()
  const sender = f.pcs[0].senders[0], pending = deferred()
  sender.replaceTrack = async track => { sender.track = track; await pending.promise }
  const switching = f.engine.selectMicrophone('new-mic')
  await new Promise(resolve => setImmediate(resolve))
  await f.engine.toggleCamera(); pending.resolve(); await switching
  assert.equal(sender.track.kind, 'audio'); assert.equal(sender.track.readyState, 'live')
  assert.equal(f.engine.getSnapshot().localStream.getAudioTracks()[0], sender.track)
  assert.equal(f.engine.getSnapshot().cameraEnabled, false)
})

test('ending while replaceTrack is pending immediately stops the pending captured device', async t => {
  const f = fixture(t)
  await f.engine.prepareOutgoing(PEER, 'audio'); await f.engine.connectPreview(); await f.acceptOutgoing()
  const sender = f.pcs[0].senders[0], pending = deferred()
  sender.replaceTrack = async track => { sender.track = track; await pending.promise }
  const switching = f.engine.selectMicrophone('new-mic')
  await new Promise(resolve => setImmediate(resolve)); await f.engine.end()
  assert.ok(f.tracks.every(track => track.readyState === 'ended'))
  pending.resolve(); await switching
  assert.equal(f.engine.getSnapshot().localStream, null)
})
