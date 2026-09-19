const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript')
const cache = new Map(), root = path.join(__dirname, '..')
function load(file) {
  if (!path.extname(file)) file += '.ts'
  if (cache.has(file)) return cache.get(file).exports
  const module = { exports: {} }; cache.set(file, module)
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('require', 'module', 'exports', code)(name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name)) : require(name), module, module.exports)
  return module.exports
}
const protocol = load(path.join(root, 'lib/direct-protocol.ts')), cryptoTools = load(path.join(root, 'lib/crypto.ts'))
const sdp = 'v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\na=ice-ufrag:abcd\r\na=ice-pwd:abcdefghijk\r\na=fingerprint:sha-256 AA:BB\r\na=setup:actpass\r\na=mid:0\r\na=sctp-port:5000\r\na=max-message-size:65536\r\na=candidate:1 1 udp 123 127.0.0.1 3000 typ host generation 0\r\n'
test('Force P2P accepts STUN only and rejects TURN anywhere in configuration or SDP', () => {
  assert.deepEqual(protocol.directIceConfiguration([]).iceServers, [])
  for (const servers of [[{ urls: 'turn:example.org' }], [{ urls: ['stun:example.org', 'turns:example.org'] }], [{ urls: 'stun:example.org', credential: 'secret' }]]) assert.throws(() => protocol.directIceConfiguration(servers), /TURN/)
  assert.equal(protocol.validDirectSdp(sdp), true)
  assert.equal(protocol.validDirectSdp(sdp.replace('typ host', 'typ relay')), false)
  assert.equal(protocol.validDirectSdp(sdp + 'a=chat:disguised-payload\r\n'), false)
  assert.equal(protocol.validDirectSdp(sdp.replace('m=application', 'm=audio')), false)
})
test('selected candidate evidence must identify direct local and remote candidates', () => {
  const stats = new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['pair', { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'local', remoteCandidateId: 'remote' }],
    ['local', { type: 'local-candidate', candidateType: 'host' }], ['remote', { type: 'remote-candidate', candidateType: 'srflx' }],
  ])
  assert.equal(protocol.verifiedDirectPair(stats), true)
  stats.get('remote').candidateType = 'relay'; assert.equal(protocol.verifiedDirectPair(stats), false)
  stats.delete('remote'); assert.equal(protocol.verifiedDirectPair(stats), false)
  assert.equal(protocol.verifiedDirectPair(new Map()), false)
})
test('setup authentication binds identity, session, SDP, expiration and direct-only agreement', async () => {
  const identity = async () => { const keys = await cryptoTools.generateEncryptionKeyPair(); return { publicKey: await cryptoTools.exportPublicKeyToHex(keys.publicKey), privateKey: await cryptoTools.exportKey(keys.privateKey) } }
  const [alice, bob] = await Promise.all([identity(), identity()]), now = Date.now()
  const signal = await protocol.signDirectSignal({ version: 1, policy: 'direct-only', session: crypto.randomUUID(), sender: alice.publicKey, recipient: bob.publicKey, kind: 'offer', timestamp: now, expiresAt: now + 60000, sdp }, alice)
  assert.equal(await protocol.validDirectSignal(signal), true)
  for (const changed of [{ recipient: alice.publicKey }, { session: crypto.randomUUID() }, { policy: 'relay' }, { sdp: sdp.replace('3000', '3001') }, { expiresAt: now + 120000 }, { content: 'offline message' }]) assert.equal(await protocol.validDirectSignal({ ...signal, ...changed }), false)
  assert.equal(await protocol.validDirectSignal(signal, now + 60001), false)
})
