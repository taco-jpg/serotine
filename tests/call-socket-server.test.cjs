/* The adapter is exercised with hibernation attachments and a bounded self binding.
 * Backend proof/nonce/access validation is covered by call-transport tests. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')
const root = path.join(__dirname, '..')
const alice = '04' + 'a'.repeat(128)
const bob = '04' + 'b'.repeat(128)
const stranger = '04' + 'c'.repeat(128)
const device = '12345678-1234-4234-8234-123456789abc'
const otherDevice = '12345678-1234-4234-8234-123456789abd'
const origin = 'https://serotine.example'
function harness() {
  const state = { now: 1_800_000_000_000, alarm: null, sockets: [], forwarded: [], reply: null }
  class Clock extends Date { static now() { return state.now } }
  class Socket {
    readyState = 1
    sent = []
    closed = null
    attachment = null
    serializeAttachment(value) { this.attachment = structuredClone(value) }
    deserializeAttachment() { return structuredClone(this.attachment) }
    send(value) { this.sent.push(JSON.parse(value)) }
    close(code, reason) { this.readyState = 3; this.closed = { code, reason } }
  }
  class Pair { constructor() { this[0] = new Socket(); this[1] = new Socket() } }
  class EdgeResponse extends Response {
    constructor(body, options) {
      super(body, options?.status === 101 ? { ...options, status: 200 } : options)
      if (options?.webSocket) this.webSocket = options.webSocket
    }
  }
  const cache = new Map()
  function load(filename) {
    if (!path.extname(filename)) filename += '.ts'
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }; cache.set(filename, module)
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const sourceRequire = specifier => specifier.startsWith('.') ? load(path.resolve(path.dirname(filename), specifier)) : require(specifier)
    new Function('require', 'module', 'exports', 'Date', 'Response', 'WebSocketPair', output)(sourceRequire, module, module.exports, Clock, EdgeResponse, Pair)
    return module.exports
  }
  const { CallSignalingHub } = load(path.join(root, 'lib/call-socket-server.ts'))
  const protocol = load(path.join(root, 'lib/call-socket-protocol.ts'))
  const ctx = {
    acceptWebSocket(socket) { state.sockets.push(socket) },
    getWebSockets() { return state.sockets.filter(socket => socket.readyState === 1) },
    storage: { async getAlarm() { return state.alarm }, async setAlarm(value) { state.alarm = value } },
  }
  const env = { WORKER_SELF_REFERENCE: { async fetch(request) {
    assert.equal(request.url, origin + '/api/calls')
    assert.equal(request.headers.get('origin'), origin)
    assert.equal(request.headers.get('host'), new URL(origin).host)
    assert.equal(request.headers.get('x-forwarded-host'), new URL(origin).host)
    assert.equal(request.headers.get('x-forwarded-proto'), 'https')
    assert.equal(request.headers.get('content-type'), 'application/json')
    const body = await request.json()
    state.forwarded.push(body)
    if (state.reply) return state.reply(body)
    return Response.json(body.action === 'call:socket' ? { success: true, publicKey: body.proof.publicKey, sessionId: body.data.sessionId } : { success: true })
  } } }
  let hub = new CallSignalingHub(ctx, env)
  let nextId = 0
  function frame(publicKey = alice, action = 'call:poll', sessionId = device, extra = {}) {
    return { type: action === 'call:socket' ? 'auth' : 'request', id: `request-${nextId++}`, body: { version: 1, action, data: { sessionId, ...extra }, proof: { publicKey, nonce: 'proof-nonce', signature: 'opaque-signature' } } }
  }
  async function open(publicKey) {
    await hub.fetch(new Request(origin + '/api/calls/socket', { headers: { origin, upgrade: 'websocket' } }))
    const socket = state.sockets.at(-1)
    if (publicKey) { const auth = frame(publicKey, 'call:socket'); await hub.webSocketMessage(socket, JSON.stringify(auth)); await hub.webSocketMessage(socket, JSON.stringify({ type: 'ack', id: auth.id })) }
    return socket
  }
  return { state, protocol, frame, open, get hub() { return hub }, restart() { hub = new CallSignalingHub(ctx, env) } }
}

test('WSS upgrade rejects cross-origin, plaintext remote hosts, query credentials and non-upgrades', () => {
  const { protocol: p } = harness()
  const request = (url, headers = {}, method = 'GET') => new Request(url, { method, headers: { origin, upgrade: 'websocket', ...headers } })
  assert.equal(p.callSocketUpgradeError(request(origin + p.CALL_SOCKET_PATH)), null)
  assert.equal(p.callSocketUpgradeError(request(origin + p.CALL_SOCKET_PATH, { origin: 'https://evil.example' })), 403)
  assert.equal(p.callSocketUpgradeError(request(origin + p.CALL_SOCKET_PATH + '?proof=secret')), 400)
  assert.equal(p.callSocketUpgradeError(request(origin + p.CALL_SOCKET_PATH, { upgrade: '' })), 426)
  assert.equal(p.callSocketUpgradeError(request(origin + p.CALL_SOCKET_PATH, { 'sec-fetch-site': 'cross-site' })), 403)
  assert.equal(p.callSocketUpgradeError(request('http://serotine.example/api/calls/socket', { origin: 'http://serotine.example' })), 403)
  assert.equal(p.callSocketUpgradeError(request('http://localhost:8787/api/calls/socket', { origin: 'http://localhost:8787' })), null)
})

test('signal frames have an exact bounded envelope and no arbitrary media action', () => {
  const h = harness(); const p = h.protocol
  assert.ok(p.parseCallSocketFrame(JSON.stringify(h.frame())))
  assert.equal(p.parseCallSocketFrame(JSON.stringify(h.frame(alice, 'media:stream'))), null)
  assert.equal(p.parseCallSocketFrame(JSON.stringify({ ...h.frame(), media: 'x' })), null)
  assert.equal(p.parseCallSocketFrame(JSON.stringify({ ...h.frame(), body: { ...h.frame().body, data: { sessionId: device, text: 'é'.repeat(100_000) } } })), null)
  assert.equal(p.parseCallSocketFrame(JSON.stringify({ type: 'ack', id: 'a', payload: 'x' })), null)
})

test('socket must authenticate first and every request stays bound to that device and identity', async () => {
  const h = harness(); const unauth = await h.open()
  await h.hub.webSocketMessage(unauth, JSON.stringify(h.frame()))
  assert.equal(unauth.closed.code, 1008); assert.equal(h.state.forwarded.length, 0)
  const a = await h.open(alice)
  const original = h.frame(); await h.hub.webSocketMessage(a, JSON.stringify(original))
  assert.deepEqual(h.state.forwarded.at(-1), original.body)
  await h.hub.webSocketMessage(a, JSON.stringify(h.frame(bob)))
  assert.equal(a.closed.code, 1008)
  const b = await h.open(alice)
  await h.hub.webSocketMessage(b, JSON.stringify(h.frame(alice, 'call:poll', otherDevice)))
  assert.equal(b.closed.code, 1008)
  const binary = await h.open(alice)
  await h.hub.webSocketMessage(binary, new Uint8Array([1, 2]).buffer)
  assert.equal(binary.closed.code, 1003)
})

test('only successful authorized mutations wake participants; no payload or identity is broadcast', async () => {
  const h = harness(); const a = await h.open(alice); const b = await h.open(bob); const c = await h.open(stranger)
  h.state.reply = () => Response.json({ success: true, _notify: [alice, bob], encryptedData: 'only-the-requester-result' })
  await h.hub.webSocketMessage(a, JSON.stringify(h.frame(alice, 'call:send')))
  assert.deepEqual(b.sent.at(-1), { type: 'changed' }); assert.equal(c.sent.length, 1)
  assert.equal(a.sent.find(item => item.body?.encryptedData).body._notify, undefined)
  assert.equal(b.sent.some(item => item.body?.encryptedData), false)
  const before = b.sent.length
  await h.hub.webSocketMessage(a, JSON.stringify(h.frame(alice, 'call:send')))
  assert.equal(b.sent.length, before, 'unconsumed hints coalesce')
  await h.hub.webSocketMessage(b, JSON.stringify(h.frame(bob, 'call:poll')))
  h.state.reply = () => Response.json({ success: false, _notify: [bob] }, { status: 403 })
  await h.hub.webSocketMessage(a, JSON.stringify(h.frame(alice, 'call:send')))
  assert.equal(b.sent.filter(item => item.type === 'changed').length, 1)
})

test('hibernation preserves authentication, acknowledgements and rate bounds', async () => {
  const h = harness(); const a = await h.open(alice)
  const first = h.frame(); await h.hub.webSocketMessage(a, JSON.stringify(first))
  assert.equal(a.attachment.unacked.length, 1)
  h.restart()
  await h.hub.webSocketMessage(a, JSON.stringify({ type: 'ack', id: first.id }))
  assert.equal(a.attachment.unacked.length, 0)
  await h.hub.webSocketMessage(a, JSON.stringify(h.frame()))
  assert.equal(a.closed, null)
  const before = h.state.forwarded.length
  a.attachment.requests = 600
  await h.hub.webSocketMessage(a, JSON.stringify(h.frame()))
  assert.equal(a.closed.code, 4008); assert.equal(h.state.forwarded.length, before)
})

test('unread responses close bounded clients and ACKs allow normal subsequent requests', async () => {
  const h = harness(); const a = await h.open(alice)
  for (let i = 0; i < 33; i++) await h.hub.webSocketMessage(a, JSON.stringify(h.frame()))
  assert.equal(a.closed.code, 4008)
  assert.equal(a.attachment.unacked.length, 32)
  const b = await h.open(bob)
  for (let i = 0; i < 40; i++) {
    const request = h.frame(bob)
    await h.hub.webSocketMessage(b, JSON.stringify(request))
    await h.hub.webSocketMessage(b, JSON.stringify({ type: 'ack', id: request.id }))
  }
  assert.equal(b.closed, null); assert.equal(b.attachment.unacked.length, 0)
})

test('alarms close unauthenticated, idle and stale unacknowledged connections after hibernation', async () => {
  const h = harness(); const unauth = await h.open(); const active = await h.open(alice)
  h.state.now += 10_001; h.restart(); await h.hub.alarm()
  assert.equal(unauth.closed.code, 4001); assert.equal(active.closed, null)
  await h.hub.webSocketMessage(active, JSON.stringify(h.frame()))
  h.state.now += 30_001; await h.hub.alarm()
  assert.equal(active.closed.code, 4001)
  const idle = await h.open(bob)
  h.state.now += 90_001; await h.hub.alarm()
  assert.equal(idle.closed.code, 4001)
})

test('failed upstream authentication closes without binding identity or leaking errors', async () => {
  const h = harness(); h.state.reply = () => { throw new Error('private-provider-detail') }
  const a = await h.open(); await h.hub.webSocketMessage(a, JSON.stringify(h.frame(alice, 'call:socket')))
  assert.equal(a.closed.code, 4003); assert.equal(a.attachment.publicKey, null)
  assert.equal(a.sent.at(-1).status, 503)
  assert.equal(JSON.stringify(a.sent).includes('private-provider-detail'), false)
})
