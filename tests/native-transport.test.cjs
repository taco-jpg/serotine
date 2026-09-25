const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')

function harness(native = true) {
  const cache = new Map(), state = { calls: [], resumes: new Set(), fetch: () => { throw Error('Browser network must not be used') } }
  const bridge = { platform: 'test',
    request: async input => { state.calls.push(input); return state.reply ? state.reply(input) : wire({ success: true }) },
    onResume(callback) { state.resumes.add(callback); return () => state.resumes.delete(callback) },
  }
  const window = native ? { serotineNative: bridge } : {}
  function load(file) {
    if (!path.extname(file)) file += '.ts'
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    new Function('require', 'module', 'exports', 'window', 'fetch', output)(name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name)) : require(name), module, module.exports, window, (...args) => state.fetch(...args))
    return module.exports
  }
  return { state, bridge, load, transport: load(path.join(root, 'native/shared/transport.ts')),
    storage: load(path.join(root, 'lib/native-persistence.ts')) }
}
const wire = (value, status = 200, headers = { 'content-type': 'application/json' }) => ({ status, headers, bodyBase64: Buffer.from(JSON.stringify(value)).toString('base64') })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check) { for (let i = 0; i < 200; i++) { if (check()) return; await pause(2) }; assert.fail('Expected request did not arrive') }

test('browser fetch receives the original path and options unchanged', async () => {
  const h = harness(false), options = { method: 'POST', mode: 'same-origin', credentials: 'same-origin', redirect: 'error', body: 'original' }
  const response = new Response('browser')
  h.state.fetch = async (url, init) => { assert.equal(url, '/api/relay'); assert.equal(init, options); return response }
  assert.equal(await h.transport.apiFetch('/api/relay', options), response)
  assert.equal(h.state.calls.length, 0)
})

test('native JSON and binary requests preserve signed bytes after the durable storage barrier', async () => {
  const h = harness(), body = '{"proof":"already-signed-✓"}', order = []
  h.storage.registerNativeStorageBarrier(async () => { order.push('durable') })
  h.state.reply = input => { order.push('request'); return { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Set-Cookie': 'never=expose' }, bodyBase64: input.bodyBase64 } }
  const result = await h.transport.apiFetch('/api/relay', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Serotine-Events': '1' }, body })
  assert.equal(await result.text(), body)
  assert.equal(result.headers.get('set-cookie'), null)
  assert.deepEqual(order, ['durable', 'request'])
  assert.deepEqual(h.state.calls[0].headers, { 'content-type': 'application/json', 'x-serotine-events': '1' })
  const binary = Uint8Array.from([0, 255, 128, 1])
  const file = await h.transport.apiFetch('/api/files', { method: 'PUT', headers: { 'X-Serotine-File-Request': 'signed-file-proof' }, body: binary })
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), binary)
  assert.equal(h.state.calls[1].headers['x-serotine-file-request'], 'signed-file-proof')
})

test('native host, path, method, header and body restrictions reject before any I/O', async () => {
  const h = harness()
  for (const endpoint of ['https://evil.example/api/relay', '//evil.example', '/api/relay?x=1', '/api/relay/../files', '/api/relay#fragment', 'toString']) {
    await assert.rejects(h.transport.apiFetch(endpoint, { method: 'POST' }), /not allowed/)
  }
  await assert.rejects(h.transport.apiFetch('/api/relay', { method: 'DELETE' }), /not allowed/)
  for (const name of ['Cookie', 'Origin', 'Authorization', 'Referer', 'Host', 'Sec-Fetch-Site']) {
    await assert.rejects(h.transport.apiFetch('/api/relay', { method: 'POST', headers: { [name]: 'unsafe' } }), /not allowed/)
  }
  await assert.rejects(h.transport.apiFetch('/api/files', { method: 'GET', body: 'bad' }), /cannot have a body/)
  await assert.rejects(h.transport.apiFetch('/api/relay', { method: 'POST', body: new FormData() }), /not supported/)
  await assert.rejects(h.transport.apiFetch('/api/files', { method: 'PUT', body: new Uint8Array(h.transport.NATIVE_REQUEST_BYTES + 1) }), /too large/)
  assert.equal(h.state.calls.length, 0)
})

test('storage failure and preflight cancellation never send; in-flight cancellation discards a late reply without replay', async () => {
  const h = harness()
  h.storage.registerNativeStorageBarrier(async () => { throw Error('Disk full') })
  await assert.rejects(h.transport.apiFetch('/api/relay', { method: 'POST' }), /Disk full/)
  assert.equal(h.state.calls.length, 0)
  h.storage.registerNativeStorageBarrier(async () => {})
  const early = new AbortController(); early.abort()
  await assert.rejects(h.transport.apiFetch('/api/relay', { method: 'POST', signal: early.signal }), { name: 'AbortError' })
  assert.equal(h.state.calls.length, 0)
  let durable
  h.storage.registerNativeStorageBarrier(() => new Promise(resolve => { durable = resolve }))
  const storageAbort = new AbortController(), waiting = h.transport.apiFetch('/api/relay', { method: 'POST', signal: storageAbort.signal })
  await until(() => !!durable)
  const storageRejected = assert.rejects(waiting, { name: 'AbortError' })
  storageAbort.abort(); await storageRejected
  durable(); await pause(0)
  assert.equal(h.state.calls.length, 0, 'cancelled storage wait cannot later release a signed write')
  h.storage.registerNativeStorageBarrier(async () => {})
  let complete
  h.state.reply = () => new Promise(resolve => { complete = resolve })
  const controller = new AbortController(), pending = h.transport.apiFetch('/api/relay', { method: 'POST', signal: controller.signal })
  await until(() => !!complete)
  const rejected = assert.rejects(pending, { name: 'AbortError' })
  controller.abort(); await rejected
  complete(wire({ success: true })); await pause(0)
  assert.equal(h.state.calls.length, 1)
})

test('native redirects, malformed base64 and response limits fail closed; transport errors are never retried', async () => {
  const h = harness()
  for (const result of [wire({}, 302), wire({}, 199), { ...wire({}), bodyBase64: 'invalid?' }, { ...wire({}), bodyBase64: 'AA=A' },
    { ...wire({}), bodyBase64: 'A'.repeat(Math.ceil(h.transport.NATIVE_RESPONSE_BYTES / 3) * 4 + 4) }]) {
    h.state.reply = () => result
    await assert.rejects(h.transport.apiFetch('/api/relay', { method: 'POST' }), /invalid|oversized|redirect/)
  }
  const before = h.state.calls.length
  h.state.reply = () => { throw Error('Connection lost after relay accepted write') }
  await assert.rejects(h.transport.apiFetch('/api/relay', { method: 'POST' }), /Connection lost/)
  assert.equal(h.state.calls.length, before + 1)
})

test('native wait rechecks live export consent immediately before bridge dispatch', async () => {
  const h = harness()
  let durable, allowed = true
  h.storage.registerNativeStorageBarrier(() => new Promise(resolve => { durable = resolve }))
  const pending = h.transport.apiFetch('/api/plugins/summary', { method: 'POST', body: 'confirmed preview' }, () => {
    if (!allowed) throw Error('Consent revoked')
  })
  await until(() => !!durable)
  allowed = false; durable()
  await assert.rejects(pending, /Consent revoked/)
  assert.equal(h.state.calls.length, 0)
})

test('native calling retains real ownership proofs, device binding, server clock and error codes', async t => {
  const h = harness(), crypt = h.load(path.join(root, 'lib/crypto.ts'))
  const auth = h.load(path.join(root, 'lib/request-auth.ts'))
  const pair = await crypt.generateEncryptionKeyPair()
  const identity = { version: 2, privateKey: await crypt.exportKey(pair.privateKey), publicKey: await crypt.exportPublicKeyToHex(pair.publicKey) }
  const { createCallSocket, CallTransportError } = h.load(path.join(root, 'lib/call-socket.ts'))
  const sessionId = crypto.randomUUID(), socket = createCallSocket(identity, sessionId)
  t.after(() => socket.dispose())
  const serverTime = Date.now() + 2000
  h.state.reply = async input => {
    assert.equal(input.path, '/api/calls'); assert.equal(input.method, 'POST')
    const body = JSON.parse(Buffer.from(input.bodyBase64, 'base64').toString())
    assert.equal(body.version, 1); assert.equal(body.data.sessionId, sessionId)
    assert.equal(await auth.verifyRequestProof(body.action, body.data, body.proof), true)
    return wire({ success: true, serverTime })
  }
  await socket.request('call:heartbeat', { sessionId, peers: [] })
  assert.ok(Math.abs(socket.now() - serverTime) < 100)
  await assert.rejects(socket.request('call:heartbeat', { sessionId: crypto.randomUUID() }), /unexpected/)
  await assert.rejects(socket.request('call:socket', { sessionId }), /unexpected/)
  let wake = 0
  const unsubscribe = socket.subscribe(() => wake++)
  for (const listener of h.state.resumes) listener()
  assert.equal(wake, 1)
  unsubscribe(); assert.equal(h.state.resumes.size, 0)
  h.state.reply = () => wire({ success: false, error: 'Direct calling only.', code: 'direct-only' }, 409)
  await assert.rejects(socket.request('call:configuration', { sessionId, policy: 'relay' }), error => error instanceof CallTransportError && error.code === 'direct-only')
  socket.dispose()
  await assert.rejects(socket.request('call:heartbeat', { sessionId }), /signaling server/)
})

test('disposing native calling rejects an in-flight request without sending it a second time', async () => {
  const h = harness(), crypt = h.load(path.join(root, 'lib/crypto.ts'))
  const pair = await crypt.generateEncryptionKeyPair()
  const identity = { version: 2, privateKey: await crypt.exportKey(pair.privateKey), publicKey: await crypt.exportPublicKeyToHex(pair.publicKey) }
  const { createCallSocket } = h.load(path.join(root, 'lib/call-socket.ts'))
  const sessionId = crypto.randomUUID(), socket = createCallSocket(identity, sessionId)
  let complete
  h.state.reply = () => new Promise(resolve => { complete = resolve })
  const pending = socket.request('call:claim', { sessionId, callId: crypto.randomUUID() })
  await until(() => !!complete)
  const rejected = assert.rejects(pending, /signaling server/)
  socket.dispose(); await rejected
  complete(wire({ success: true })); await pause(0)
  assert.equal(h.state.calls.length, 1)
})
