/* Real signing over the WebSocket event boundary. No HTTP transport is available. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')
const root = path.join(__dirname, '..')
const cache = new Map()
function load(filename) {
  if (!path.extname(filename)) filename += '.ts'
  if (cache.has(filename)) return cache.get(filename).exports
  const module = { exports: {} }; cache.set(filename, module)
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const localRequire = specifier => specifier.startsWith('.') ? load(path.resolve(path.dirname(filename), specifier)) : require(specifier)
  new Function('require', 'module', 'exports', 'fetch', source)(localRequire, module, module.exports, () => { throw new Error('HTTP fallback is forbidden') })
  return module.exports
}
const { createCallSocket } = load(path.join(root, 'lib/call-socket.ts'))
const cryptography = load(path.join(root, 'lib/crypto.ts'))
const { verifyRequestProof } = load(path.join(root, 'lib/request-auth.ts'))
const { CALL_SOCKET_REQUEST_BYTES, CALL_SOCKET_RESPONSE_BYTES, CALL_SOCKET_PENDING_LIMIT } = load(path.join(root, 'lib/call-socket-protocol.ts'))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await pause(2) } assert.fail('Expected socket event did not arrive') }

class FakeSocket extends EventTarget {
  readyState = 0
  bufferedAmount = 0
  sent = []
  closeCalls = 0
  constructor(url, dispatchClose = true) { super(); this.url = url; this.dispatchClose = dispatchClose }
  send(text) { assert.equal(this.readyState, 1); this.sent.push(JSON.parse(text)); this.onSend?.(this.sent.at(-1)) }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  message(value) { this.dispatchEvent(new MessageEvent('message', { data: typeof value === 'string' || value instanceof ArrayBuffer ? value : JSON.stringify(value) })) }
  close() { this.closeCalls++; if (this.readyState === 3) return; this.readyState = 3; if (this.dispatchClose) this.dispatchEvent(new Event('close')) }
  response(frame, body = { success: true }, status = 200) { this.message({ type: 'response', id: frame.id, status, body }) }
}
async function harness(t, options = {}) {
  const pair = await cryptography.generateEncryptionKeyPair()
  const identity = { version: 2, privateKey: await cryptography.exportKey(pair.privateKey), publicKey: await cryptography.exportPublicKeyToHex(pair.publicKey) }
  const sessionId = crypto.randomUUID(), sockets = []
  const client = createCallSocket(identity, sessionId, { origin: 'https://serotine.example', timeoutMs: 500, reconnectDelayMs: 1,
    createWebSocket(url) { const ws = new FakeSocket(url, options.dispatchClose !== false); sockets.push(ws); return ws }, ...options })
  t.after(() => client.dispose())
  async function authenticate(index = sockets.length - 1) {
    const ws = sockets[index]; ws.open()
    await until(() => ws.sent.some(frame => frame.type === 'auth'))
    const auth = ws.sent.find(frame => frame.type === 'auth')
    assert.equal(auth.body.action, 'call:socket')
    assert.deepEqual(auth.body.data, { sessionId })
    assert.equal(await verifyRequestProof(auth.body.action, auth.body.data, auth.body.proof), true)
    ws.response(auth, { success: true, publicKey: identity.publicKey, sessionId })
    await pause(0)
    return ws
  }
  function request(action = 'call:poll', data = {}) { return client.request(action, { sessionId, ...data }) }
  async function connected() {
    const result = request(); await until(() => sockets.length > 0); const ws = await authenticate()
    await until(() => ws.sent.some(frame => frame.type === 'request'))
    ws.response(ws.sent.find(frame => frame.type === 'request')); await result
    return ws
  }
  return { client, identity, sessionId, sockets, authenticate, request, connected }
}

test('WSS authenticates the exact identity/device, signs requests, ACKs responses and wakes on changes', async t => {
  const h = await harness(t), wakes = []
  h.client.subscribe(() => wakes.push('changed'))
  const promise = h.request('call:heartbeat', { peers: [], incomingPeers: [] })
  assert.equal(h.sockets[0].url, 'wss://serotine.example/api/calls/socket')
  h.sockets[0].message({ type: 'changed' }); assert.equal(wakes.length, 0, 'no unauthenticated change events')
  const ws = await h.authenticate()
  await until(() => ws.sent.some(frame => frame.type === 'request'))
  const frame = ws.sent.find(frame => frame.type === 'request')
  assert.equal(await verifyRequestProof(frame.body.action, frame.body.data, frame.body.proof), true)
  ws.response(frame, { success: true, available: true })
  assert.equal((await promise).available, true)
  assert.ok(ws.sent.some(f => f.type === 'ack' && f.id === frame.id))
  const before = wakes.length; ws.message({ type: 'changed' }); assert.equal(wakes.length, before + 1)
  await assert.rejects(h.client.request('call:poll', { sessionId: crypto.randomUUID() }), /unexpected/)
  await assert.rejects(h.request('call:socket'), /unexpected/)
})

test('insecure remote origins fail without HTTP fallback while local development uses WS', async t => {
  const insecure = await harness(t, { origin: 'http://serotine.example' })
  await assert.rejects(insecure.request(), /signaling server/)
  assert.equal(insecure.sockets.length, 0)
  const local = await harness(t, { origin: 'http://localhost:3000' })
  await local.connected(); assert.equal(local.sockets[0].url, 'ws://localhost:3000/api/calls/socket')
})

test('auth response must bind both the expected key and session before sending a mutation', async t => {
  for (const wrong of ['publicKey', 'sessionId']) {
    const h = await harness(t), result = h.request('call:invite'), rejected = assert.rejects(result, /unexpected/)
    const ws = h.sockets[0]; ws.open(); await until(() => ws.sent.length > 0)
    ws.response(ws.sent[0], { success: true, publicKey: h.identity.publicKey, sessionId: h.sessionId, [wrong]: 'wrong' })
    await rejected
    assert.equal(ws.sent.filter(f => f.type === 'request').length, 0)
  }
})

test('disconnect rejects an ambiguous mutation once; reconnect authenticates with a fresh nonce and never replays it', async t => {
  const h = await harness(t), ws = await h.connected()
  h.client.subscribe(() => {})
  const mutation = h.request('call:finish', { callId: crypto.randomUUID(), reason: 'ended', noHistory: false })
  const rejected = assert.rejects(mutation, /signaling server/)
  await until(() => ws.sent.some(f => f.body?.action === 'call:finish')); ws.close(); await rejected
  await until(() => h.sockets.length === 2)
  const next = await h.authenticate(1)
  assert.notEqual(ws.sent.find(f => f.type === 'auth').body.proof.nonce, next.sent.find(f => f.type === 'auth').body.proof.nonce)
  assert.equal(next.sent.filter(f => f.type === 'request').length, 0)
  assert.ok(ws.closeCalls < 4, 'close dispatch cannot recurse indefinitely')
})

test('malformed, binary, oversized and invalid response frames close the socket and reject pending work', async t => {
  for (const frame of ['{', new ArrayBuffer(4), 'x'.repeat(CALL_SOCKET_RESPONSE_BYTES + 1),
    { type: 'changed', extra: true }, { type: 'response', id: 'bad id', status: 200, body: { success: true } }]) {
    const h = await harness(t), ws = await h.connected(), result = h.request()
    const rejected = assert.rejects(result, /unexpected|signaling server/)
    await until(() => ws.sent.filter(f => f.type === 'request').length === 2)
    ws.message(frame); await rejected; assert.equal(ws.readyState, 3)
  }
})

test('server errors remain plain bounded messages and preserve direct-only error codes', async t => {
  const h = await harness(t), ws = await h.connected()
  for (const [body, expected] of [
    [{ success: false, error: 'Only direct calling is supported.', code: 'direct-only' }, /Only direct/],
    [{ success: false, error: '<script>bad</script>' }, /unexpected/],
    [{ success: false, error: 'bad\nmessage' }, /unexpected/],
  ]) {
    const count = ws.sent.length, result = h.request(), rejected = assert.rejects(result, expected)
    await until(() => ws.sent.slice(count).some(f => f.type === 'request'))
    ws.response(ws.sent.slice(count).find(f => f.type === 'request'), body, 409); await rejected
  }
})

test('outbound size, buffered bytes and pending requests are bounded', async t => {
  const h = await harness(t), ws = await h.connected()
  await assert.rejects(h.request('call:send', { padding: 'x'.repeat(CALL_SOCKET_REQUEST_BYTES) }), /too large/)
  ws.bufferedAmount = CALL_SOCKET_REQUEST_BYTES * 2 + 1
  await assert.rejects(h.request(), /busy/)
  ws.bufferedAmount = 0
  const requests = Array.from({ length: CALL_SOCKET_PENDING_LIMIT + 3 }, () => h.request())
  const settlements = Promise.allSettled(requests)
  await until(() => ws.sent.filter(f => f.type === 'request').length === CALL_SOCKET_PENDING_LIMIT + 1)
  h.client.dispose()
  const results = await settlements
  assert.equal(results.filter(r => r.status === 'rejected').length, requests.length)
  assert.equal(ws.sent.filter(f => f.type === 'request').length, CALL_SOCKET_PENDING_LIMIT + 1)
})

test('timeout rejects work, closes its socket and never silently resends a mutation', async t => {
  const h = await harness(t, { timeoutMs: 25 }), ws = await h.connected()
  await assert.rejects(h.request('call:finish', { callId: crypto.randomUUID() }), /too long/)
  assert.equal(ws.readyState, 3)
  assert.equal(h.sockets.length, 1)
})

test('disposal immediately cancels connecting work even when close emits no event', async t => {
  const h = await harness(t, { timeoutMs: 5000, dispatchClose: false })
  const result = h.request(), rejected = assert.rejects(result, /signaling server/)
  h.client.dispose()
  await Promise.race([rejected, pause(100).then(() => assert.fail('Disposal left connect pending'))])
  await assert.rejects(h.request(), /signaling server/)
  assert.equal(h.sockets.length, 1)
})


test('server time calibrates call expiry and subsequent proofs without changing the device clock', async t => {
  const h = await harness(t), ws = await h.connected()
  const response = h.request('call:poll', { after: 0 })
  await until(() => ws.sent.filter(frame => frame.type === 'request').length === 2)
  const serverTime = Date.now() - 45_000
  ws.response(ws.sent.filter(frame => frame.type === 'request').at(-1), { success: true, serverTime })
  await response
  assert.ok(Math.abs(h.client.now() - serverTime) < 100)
  const next = h.request('call:poll', { after: 0 })
  await until(() => ws.sent.filter(frame => frame.type === 'request').length === 3)
  const frame = ws.sent.filter(frame => frame.type === 'request').at(-1)
  assert.ok(Math.abs(frame.body.proof.timestamp - serverTime) < 200)
  assert.equal(await verifyRequestProof(frame.body.action, frame.body.data, frame.body.proof), true)
  ws.response(frame); await next
})
