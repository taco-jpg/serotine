const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')
const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../lib/call-ringer.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const value = { exports: {} }
new Function('module', 'exports', source)(value, value.exports)
const { CallRinger } = value.exports

class AudioContext {
  constructor(state = 'running') { this.state = state; this.currentTime = 0; this.destination = {}; this.tones = []; this.closed = false }
  createOscillator() {
    const tone = { frequency: {}, stops: [], disconnected: false, connect(gain) { this.gain = gain }, start(time) { this.started = time }, stop(time) { this.stops.push(time) }, disconnect() { this.disconnected = true } }
    this.tones.push(tone)
    return tone
  }
  createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} } }
  async resume() { this.state = 'running'; this.onstatechange?.() }
  async close() { this.closed = true; this.state = 'closed' }
}
function fixture(t, state = 'running', options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 })
  const context = new AudioContext(state), statuses = []
  const ringer = new CallRinger({ createContext: () => context, onStatusChange: status => statuses.push(status), ...options })
  t.after(() => ringer.dispose())
  return { context, statuses, ringer }
}
const incoming = (callId = 'incoming') => ({ callId, phase: 'incoming', direction: 'incoming', settings: { silenceIncoming: false, relayOnly: true } })

test('incoming call repeats an actual audio graph and repeated snapshots do not restart it', t => {
  const { ringer, context } = fixture(t)
  ringer.setCall(incoming())
  assert.equal(ringer.getStatus(), 'ready')
  assert.deepEqual(context.tones.map(tone => tone.frequency.value), [660, 880])
  ringer.setCall(incoming())
  assert.equal(context.tones.length, 2)
  t.mock.timers.tick(2_600)
  assert.equal(context.tones.length, 4)
  ringer.stop()
  assert.ok(context.tones.every(tone => tone.disconnected && tone.stops.includes(undefined)))
  t.mock.timers.tick(4_000)
  assert.equal(context.tones.length, 4)
})

test('outgoing waiting tone is different and stops before connected media', t => {
  const { ringer, context } = fixture(t)
  const outgoing = { ...incoming('outgoing'), phase: 'ringing', direction: 'outgoing' }
  ringer.setCall(outgoing)
  assert.deepEqual(context.tones.map(tone => tone.frequency.value), [440, 480])
  ringer.setCall({ ...outgoing, phase: 'connecting' })
  assert.ok(context.tones.every(tone => tone.disconnected))
  t.mock.timers.tick(8_000)
  assert.equal(context.tones.length, 2)
})

test('accept preparation, decline, cancellation, timeout and other-device completion all silence the alert', t => {
  const { ringer, context } = fixture(t)
  for (const phase of ['preparing', 'routing', 'preview', 'declined', 'ended', 'unanswered', 'busy', 'failed', 'idle']) {
    ringer.setCall(incoming(phase))
    const tones = context.tones.slice(-2)
    ringer.setCall({ ...incoming(phase), phase })
    assert.ok(tones.every(tone => tone.disconnected), phase)
  }
})

test('silence preference stops an active incoming ringtone and never starts a suppressed invitation', t => {
  const { ringer, context } = fixture(t)
  ringer.setCall(incoming())
  ringer.setCall({ ...incoming(), settings: { silenceIncoming: true, relayOnly: true } })
  assert.ok(context.tones.every(tone => tone.disconnected))
  ringer.setCall({ ...incoming('another'), settings: { silenceIncoming: true, relayOnly: true } })
  assert.equal(context.tones.length, 2)
})

test('suspended browser audio stays visibly blocked until a gesture resumes it', async t => {
  const { ringer, context, statuses } = fixture(t, 'suspended')
  ringer.setCall(incoming())
  assert.equal(ringer.getStatus(), 'blocked'); assert.equal(context.tones.length, 0)
  ringer.unlock()
  await Promise.resolve()
  assert.equal(ringer.getStatus(), 'ready'); assert.equal(context.tones.length, 2)
  assert.deepEqual(statuses, ['ready'])
  context.state = 'suspended'; context.onstatechange()
  assert.equal(ringer.getStatus(), 'blocked')
  assert.ok(context.tones.every(tone => tone.disconnected))
})

test('late audio unlock after cancellation or disposal cannot revive ringing', async t => {
  const { ringer, context } = fixture(t, 'suspended')
  let resume
  context.resume = () => new Promise(resolve => { resume = () => { context.state = 'running'; resolve() } })
  ringer.setCall(incoming()); ringer.unlock(); ringer.stop()
  resume(); await Promise.resolve()
  assert.equal(context.tones.length, 0)
  context.state = 'suspended'; ringer.setCall(incoming('second')); ringer.unlock(); ringer.dispose()
  resume(); await Promise.resolve()
  assert.equal(context.tones.length, 0); assert.equal(context.closed, true)
})

test('ring duration stays bounded even if a hidden page wakes after a long timer delay', t => {
  const { ringer, context } = fixture(t, 'running', { maxDurationMs: 4_000 })
  ringer.setCall(incoming())
  t.mock.timers.tick(60_000)
  assert.equal(context.tones.length, 2)
  assert.ok(context.tones.every(tone => tone.disconnected))
  ringer.setCall(incoming())
  ringer.unlock()
  assert.equal(context.tones.length, 2)
})

test('browser sound failure is reported without breaking the calling state subscriber', t => {
  const { ringer, context } = fixture(t)
  context.createOscillator = () => { throw new Error('Audio output unavailable') }
  assert.doesNotThrow(() => ringer.setCall(incoming()))
  assert.equal(ringer.getStatus(), 'unavailable')
  ringer.dispose()
  ringer.unlock(); ringer.setCall(incoming('after-dispose'))
  assert.equal(context.closed, true)
})
