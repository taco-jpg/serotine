/* A real workerd Durable Object, D1, WebSocket upgrade and self-service binding.
 * Only the generated OpenNext wrapper is replaced; the actual API and proof
 * verification run unchanged, with the fixture supplying request-local env. */
const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')
const esbuild = require('esbuild')
const miniflarePath = require.resolve('miniflare', { paths: [path.dirname(require.resolve('wrangler/package.json'))] })
const { Miniflare } = require(miniflarePath)
const root = path.join(__dirname, '..')

test('workerd authenticates WSS through the self binding, pushes only peers and rejects replay/media', { timeout: 30_000 }, async t => {
  const build = await esbuild.build({ absWorkingDir: root, entryPoints: ['custom-worker.ts'], bundle: true, write: false, platform: 'browser', format: 'esm', target: 'es2022',
    plugins: [{ name: 'opennext-fixture', setup(build) {
      build.onResolve({ filter: /\.open-next\/worker\.js$/ }, () => ({ path: 'handler', namespace: 'fixture' }))
      build.onResolve({ filter: /^@opennextjs\/cloudflare$/ }, () => ({ path: 'context', namespace: 'fixture' }))
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ resolveDir: root, contents: args.path === 'context'
        ? 'export function getCloudflareContext() { return { env: globalThis.__fixtureEnv } }'
        : 'export default {async fetch(request,env){globalThis.__fixtureEnv=env; const {POST}=await import("./app/api/calls/route.ts"); return POST(request)}}' }))
    } }],
  })
  const mf = new Miniflare({ name: 'socket-test', modules: true, script: build.outputFiles[0].text, cf: false,
    compatibilityDate: '2026-05-06', compatibilityFlags: ['nodejs_compat'],
    serviceBindings: { WORKER_SELF_REFERENCE: 'socket-test' },
    bindings: { SEROTINE_STORAGE_VERSION: '2' }, r2Buckets: ['serotine_files'],
    durableObjects: { SEROTINE_REALTIME: { className: 'RelayRealtimeStore', useSQLite: true }, CALL_SIGNALING: { className: 'CallSignalingHub', useSQLite: true } }, d1Databases: ['serotine_db'],
  })
  t.after(() => mf.dispose())
  const clientBuild = esbuild.buildSync({ absWorkingDir: root, stdin: { contents: 'export * from "./lib/request-auth.ts"; export * from "./lib/crypto.ts"', resolveDir: root }, bundle: true, write: false, platform: 'node', format: 'cjs', target: 'es2022' })
  const module = { exports: {} }
  new Function('module', 'exports', 'require', clientBuild.outputFiles[0].text)(module, module.exports, require)
  const client = module.exports
  const identity = async () => {
    const keys = await client.generateEncryptionKeyPair()
    return { privateKey: await client.exportKey(keys.privateKey), publicKey: await client.exportPublicKeyToHex(keys.publicKey), sessionId: crypto.randomUUID() }
  }
  const alice = await identity(); const bob = await identity(); const outsider = await identity()
  let nextId = 0
  async function envelope(person, action, data = {}) {
    const payload = { sessionId: person.sessionId, ...data }
    return { type: action === 'call:socket' ? 'auth' : 'request', id: `req-${nextId++}`,
      body: { version: 1, action, data: payload, proof: await client.createRequestProof(action, payload, person.privateKey, person.publicKey) } }
  }
  async function connect(person) {
    const response = await mf.dispatchFetch('https://serotine.example/api/calls/socket', { headers: { origin: 'https://serotine.example', upgrade: 'websocket' } })
    assert.equal(response.status, 101)
    const socket = response.webSocket
    socket.accept()
    const frames = []
    const pending = new Map()
    socket.addEventListener('message', event => {
      const frame = JSON.parse(event.data); frames.push(frame)
      if (frame.type === 'response') {
        socket.send(JSON.stringify({ type: 'ack', id: frame.id }))
        const waiter = pending.get(frame.id); if (waiter) { pending.delete(frame.id); waiter(frame) }
      }
    })
    const raw = frame => new Promise(resolve => { pending.set(frame.id, resolve); socket.send(JSON.stringify(frame)) })
    const request = async (action, data) => raw(await envelope(person, action, data))
    const authEnvelope = await envelope(person, 'call:socket')
    const auth = await raw(authEnvelope)
    assert.equal(auth.status, 200, JSON.stringify(auth))
    assert.equal(auth.body.publicKey, person.publicKey)
    t.after(() => { try { socket.close() } catch { /* Runtime is already disposed. */ } })
    return { socket, frames, raw, request, authEnvelope }
  }
  const a = await connect(alice); const b = await connect(bob); const c = await connect(outsider)
  assert.equal((await a.request('call:heartbeat', { peers: [bob.publicKey], incomingPeers: [bob.publicKey] })).status, 200)
  assert.equal((await b.request('call:heartbeat', { peers: [alice.publicKey], incomingPeers: [alice.publicKey] })).status, 200)
  const callId = crypto.randomUUID()
  const signal = { id: crypto.randomUUID(), callId, sender: alice.publicKey, recipient: bob.publicKey, senderSession: alice.sessionId,
    targetSession: null, expiresAt: Date.now() + 30_000, encryptedData: 'e'.repeat(64) }
  const invite = await a.request('call:invite', { signal, noHistory: false })
  assert.equal(invite.status, 200, JSON.stringify(invite))
  assert.equal(invite.body._notify, undefined)
  const snapshot = await b.request('call:poll', { after: 0 })
  assert.equal(snapshot.status, 200)
  assert.ok(b.frames.some(frame => frame.type === 'changed'))
  assert.equal(c.frames.some(frame => frame.type === 'changed'), false)
  assert.equal(JSON.stringify(c.frames).includes(callId), false)
  const config = await a.request('call:configuration', { policy: 'all' })
  assert.equal(config.status, 200)
  assert.ok(config.body.iceServers.every(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).every(url => url.startsWith('stun:') || url.startsWith('stuns:'))))
  const replaySocket = await mf.dispatchFetch('https://serotine.example/api/calls/socket', { headers: { origin: 'https://serotine.example', upgrade: 'websocket' } })
  replaySocket.webSocket.accept()
  const rejected = new Promise(resolve => replaySocket.webSocket.addEventListener('message', event => resolve(JSON.parse(event.data)), { once: true }))
  replaySocket.webSocket.send(JSON.stringify(a.authEnvelope))
  assert.equal((await rejected).status, 409, 'Durable Object consumes authentication nonces across sockets')
  const closed = new Promise(resolve => c.socket.addEventListener('close', resolve, { once: true }))
  c.socket.send(new Uint8Array([0, 1, 2]).buffer)
  assert.equal((await closed).code, 1003)
  const crossOrigin = await mf.dispatchFetch('https://serotine.example/api/calls/socket', { headers: { origin: 'https://other.example', upgrade: 'websocket' } })
  assert.equal(crossOrigin.status, 403)
})
