const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const exported = {}
new Function('exports', ts.transpileModule(fs.readFileSync(path.join(__dirname, '../lib/call-ice.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(exported)
const { callConnectionDiagnostics, callIceConfiguration, observeCallConnection } = exported
function report(localType, remoteType) {
  return new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'selected' }],
    ['unused', { type: 'candidate-pair', state: 'succeeded', nominated: true, localCandidateId: 'unused-relay', remoteCandidateId: 'remote' }],
    ['unused-relay', { type: 'local-candidate', candidateType: 'relay' }],
    ['selected', { type: 'candidate-pair', state: 'succeeded', localCandidateId: 'local', remoteCandidateId: 'remote', currentRoundTripTime: 0.042, bytesSent: 4000, bytesReceived: 5000 }],
    ['local', { type: 'local-candidate', candidateType: localType, protocol: 'udp', address: '192.0.2.1', port: 4567, username: 'private-user', credential: 'private-secret', url: 'turn:private.example' }],
    ['remote', { type: 'remote-candidate', candidateType: remoteType, address: '192.0.2.2', port: 9999 }],
  ])
}
test('selected pair diagnoses direct, reflexive, and local or remote TURN without sensitive stats', () => {
  for (const [local, remote, route] of [['host', 'host', 'direct'], ['srflx', 'host', 'stun'], ['host', 'prflx', 'stun'], ['relay', 'host', 'turn'], ['host', 'relay', 'turn']]) {
    const result = callConnectionDiagnostics(report(local, remote))
    assert.equal(result.route, route)
    assert.deepEqual(Object.keys(result).sort(), ['route', 'localType', 'remoteType', 'protocol', 'roundTripMs', 'bytesSent', 'bytesReceived'].sort())
    assert.equal(result.roundTripMs, 42); assert.equal(result.bytesReceived, 5000)
    assert.doesNotMatch(JSON.stringify(result), /192\.0\.2|private|4567|9999|selected/)
  }
  assert.equal(callConnectionDiagnostics(new Map()).route, 'unknown')
  const waiting = report('host', 'host'); waiting.get('transport').selectedCandidatePairId = 'missing'
  assert.equal(callConnectionDiagnostics(waiting).route, 'unknown', 'gathered or unselected relays do not prove relay use')
})
test('native ICE is allowed to prefer direct routes while gathering Cloudflare TURN candidates', () => {
  const configuration = callIceConfiguration([
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'short-user', credential: 'short-password' },
  ])
  assert.equal(configuration.iceTransportPolicy, 'all')
  assert.equal(configuration.bundlePolicy, 'max-bundle')
  assert.equal(configuration.iceServers.length, 2)
})
test('diagnostic observer detaches even when a stats request resolves after hangup', async () => {
  let resolve, updates = 0
  const pc = { connectionState: 'connected', getStats: () => new Promise(done => { resolve = done }) }
  const stop = observeCallConnection(pc, () => updates++)
  stop(); resolve(report('relay', 'host')); await new Promise(done => setImmediate(done))
  assert.equal(updates, 0)
})
