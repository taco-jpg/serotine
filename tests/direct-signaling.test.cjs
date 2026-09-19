const { test } = require('node:test')
const assert = require('node:assert/strict')
const { DatabaseSync } = require('node:sqlite')
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript')
const root = path.join(__dirname, '..')
function harness(t) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close())
  sqlite.exec('CREATE TABLE RetiredIdentity(publicKey TEXT PRIMARY KEY)')
  const db = { prepare(sql) { let values = []; const statement = { bind(...items) { values = items; return statement }, async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } } }, async first() { return sqlite.prepare(sql).get(...values) ?? null }, async all() { return { results: sqlite.prepare(sql).all(...values) } } }; return statement } }
  class CallRelayError extends Error { constructor(message, status = 400) { super(message); this.status = status } }
  const nonces = new Set(), cache = new Map()
  function load(file) {
    if (!path.extname(file)) file += '.ts'
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    new Function('require', 'module', 'exports', code)(name => {
      if (name.endsWith('/call-relay') || name === './call-relay') return { CallRelayError, authorize: async (action, data, proof) => {
        if (!await auth.verifyRequestProof(action, data, proof) || nonces.has(proof.nonce)) throw new CallRelayError('Invalid proof', 401)
        nonces.add(proof.nonce); return db
      } }
      if (name.startsWith('@/')) return load(path.join(root, name.slice(2)))
      return name.startsWith('.') ? load(path.resolve(path.dirname(file), name)) : require(name)
    }, module, module.exports)
    return module.exports
  }
  const auth = load(path.join(root, 'lib/request-auth.ts')), protocol = load(path.join(root, 'lib/direct-protocol.ts'))
  const cryptoTools = load(path.join(root, 'lib/crypto.ts')), server = load(path.join(root, 'lib/direct-signaling-server.ts')), route = load(path.join(root, 'app/api/direct/route.ts'))
  const identity = async () => { const pair = await cryptoTools.generateEncryptionKeyPair(); return { publicKey: await cryptoTools.exportPublicKeyToHex(pair.publicKey), privateKey: await cryptoTools.exportKey(pair.privateKey) } }
  const request = async (identity, action, data) => server.handleDirectSignaling(action, data, await auth.createRequestProof(action, data, identity.privateKey, identity.publicKey))
  return { sqlite, auth, protocol, route, identity, request }
}
const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=sctp-port:5000\r\n'
test('transient setup is signed, identity-scoped, expires, and cannot hold chat payload fields', async t => {
  const h = harness(t), [a, b, c] = await Promise.all([h.identity(), h.identity(), h.identity()]), now = Date.now()
  const signal = await h.protocol.signDirectSignal({ version: 1, policy: 'direct-only', sender: a.publicKey, recipient: b.publicKey, session: crypto.randomUUID(), kind: 'offer', timestamp: now, expiresAt: now + 60000, sdp }, a)
  await h.request(a, 'direct:signal', { signal })
  assert.equal((await h.request(b, 'direct:poll', { peers: [a.publicKey] })).signals.length, 1)
  assert.equal((await h.request(c, 'direct:poll', { peers: [a.publicKey] })).signals.length, 0)
  await assert.rejects(h.request(c, 'direct:signal', { signal }), /Invalid/)
  await assert.rejects(h.request(a, 'direct:signal', { signal: { ...signal, content: 'disguised offline mailbox' } }), /Invalid/)
  h.sqlite.prepare('UPDATE DirectSignal SET expiresAt=?').run(now - 1)
  assert.equal((await h.request(b, 'direct:poll', { peers: [a.publicKey] })).signals.length, 0)
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS count FROM DirectSignal').get().count, 0)
})
test('direct setup HTTP rejects cross-origin, unbounded bodies, and invalid proofs', async t => {
  const h = harness(t), a = await h.identity()
  const body = { version: 1, action: 'direct:poll', data: { peers: [] }, proof: await h.auth.createRequestProof('direct:poll', { peers: [] }, a.privateKey, a.publicKey) }
  const req = (body, origin = 'https://serotine.example') => new Request('https://serotine.example/api/direct', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await h.route.POST(req(body, 'https://foreign.example'))).status, 403)
  assert.equal((await h.route.POST(req({ data: 'x'.repeat(40000) }))).status, 413)
  assert.equal((await h.route.POST(req({ ...body, proof: { ...body.proof, signature: '0'.repeat(128) } }))).status, 401)
  assert.equal((await h.route.POST(req(body))).status, 200)
  assert.equal((await h.route.POST(req(body))).status, 401)
})
