/* Actual hook + real WebCrypto; React, browser events, timers and I/O are controlled boundaries. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { test, before } = require('node:test')
const root = [process.env.SEROTINE_TEST_ROOT, process.cwd(), path.join(__dirname, 'serotine'), path.join(__dirname, '..')]
  .filter(Boolean).find(candidate => fs.existsSync(path.join(candidate, 'hooks/use-p2p-chat.ts')))
assert.ok(root, 'Run from the Serotine repository or set SEROTINE_TEST_ROOT')
const repoRequire = createRequire(path.join(root, 'package.json'))
const ts = repoRequire('typescript')
const compiled = new Map()
function loader(substitutions = {}, globals = {}) {
  const cache = new Map()
  function load(filename) {
    if (!path.extname(filename)) filename += '.ts'
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }
    cache.set(filename, module)
    if (!compiled.has(filename)) compiled.set(filename, ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText)
    function requireSource(specifier) {
      if (Object.hasOwn(substitutions, specifier)) return substitutions[specifier]
      if (specifier.startsWith('@/')) return load(path.join(root, specifier.slice(2)))
      if (specifier.startsWith('.')) return load(path.resolve(path.dirname(filename), specifier))
      return repoRequire(specifier)
    }
    new Function('require', 'module', 'exports', ...Object.keys(globals), compiled.get(filename))(
      requireSource, module, module.exports, ...Object.values(globals))
    return module.exports
  }
  return load
}
const load = loader()
const cryptoFunctions = load(path.join(root, 'lib/crypto.ts'))
const protocol = load(path.join(root, 'lib/protocol.ts'))
let alice, bob
async function identity() {
  const pair = await cryptoFunctions.generateEncryptionKeyPair()
  return { pair, version: 2, publicKey: await cryptoFunctions.exportPublicKeyToHex(pair.publicKey), privateKey: await cryptoFunctions.exportKey(pair.privateKey) }
}
before(async () => { [alice, bob] = await Promise.all([identity(), identity()]) })
const tick = () => new Promise(resolve => setImmediate(resolve))
async function until(predicate, message = 'condition did not settle') {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(message)
    await tick()
  }
}
async function inbound(content = 'Incoming message', id = crypto.randomUUID()) {
  const envelope = { version: 2, id, sender: bob.publicKey, recipient: alice.publicKey, content, timestamp: Date.now() }
  return { id, senderPubKey: bob.publicKey, recipientPubKey: alice.publicKey,
    encryptedData: await cryptoFunctions.encryptForPeer(JSON.stringify(envelope), bob.pair.privateKey, alice.publicKey), createdAt: Date.now() }
}
function harness(options = {}) {
  const slots = [], effects = [], timers = new Map(), events = new EventTarget(), documentEvents = new EventTarget()
  Object.defineProperty(documentEvents, 'visibilityState', { get: () => options.hidden ? 'hidden' : 'visible' })
  const navigator = { get onLine() { return options.online !== false } }
  let historyChanged
  const records = new Map((options.history || []).map(item => [`${item.senderPubKey}:${item.id}`, structuredClone(item)]))
  const calls = { sends: [], saves: [], acknowledgments: [], lists: 0, signals: 0, lateUpdates: 0 }
  let cursor = 0, stopped = false, timerId = 0, target = bob.publicKey
  const react = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], update => {
        if (stopped) calls.lateUpdates++
        slots[index] = typeof update === 'function' ? update(slots[index]) : update
      }]
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial } },
    useEffect(effect, deps) {
      const index = cursor++
      const old = slots[index]
      if (!old || deps.some((dep, i) => dep !== old.deps[i])) {
        old?.cleanup?.()
        const next = { deps, cleanup: null }
        slots[index] = next
        effects.push(() => { next.cleanup = effect() })
      }
    },
  }
  const actions = {
    async getMyMessages(data, proof) {
      calls.lists++
      return options.list ? options.list(data, proof) : { success: true, messages: options.incoming || [] }
    },
    async storeEncryptedMessage(data, proof) {
      calls.sends.push(structuredClone(data))
      return options.send ? options.send(data, proof) : { success: true }
    },
    async deleteMessage(data) { calls.acknowledgments.push(data); return options.ack ? options.ack(data) : { success: true } },
    async getSignal() { calls.signals++; return options.signal ? options.signal() : { success: true, signal: null } },
    async storeSignal(data) { return options.publishSignal ? options.publishSignal(data) : { success: true } },
  }
  const storage = {
    async migrateLegacyHistory() {},
    async getMessagesFromStorage() { return options.loadHistory ? options.loadHistory() : [...records.values()].map(item => structuredClone(item)) },
    async saveMessageToStorage(owner, item) {
      if (options.storageFailure) throw new Error('Browser storage full')
      if (options.save) return options.save(owner, item)
      assert.equal(owner, alice.publicKey)
      calls.saves.push(structuredClone(item))
      records.set(`${item.senderPubKey}:${item.id}`, structuredClone(item))
    },
  }
  const hook = loader({ react, '@/lib/relay-client': actions, '@/lib/storage': storage,
    '@/lib/crypto': { ...cryptoFunctions, decryptFromPeer: (...args) => options.decrypt ? options.decrypt(...args) : cryptoFunctions.decryptFromPeer(...args) },
    '@/lib/identity': { loadIdentity: async () => options.loadIdentity ? options.loadIdentity() : alice, validateAddress: async address => address.toLowerCase() },
    '@/config/webrtc': { RTC_CONFIG: {} },
    '@/lib/history-events': { subscribeToHistory(owner, peer, refresh) { historyChanged = refresh; return () => { historyChanged = null } } },
  }, { window: events, document: documentEvents, navigator, RTCPeerConnection: options.RTC, BroadcastChannel: undefined,
    Date: class extends Date { static now() { return options.now ?? Date.now() } },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
  })(path.join(root, 'hooks/use-p2p-chat.ts')).useP2PChat
  function view() {
    cursor = 0
    const result = hook(target)
    while (effects.length) effects.shift()()
    return result
  }
  const api = {
    options, calls, records, timers, view, events, documentEvents,
    refreshHistory() { historyChanged?.() },
    runDelay(delay) { const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay); assert.ok(entry, "timer missing: " + delay); const [id, timer] = entry; timers.delete(id); timer.callback() },
    runTimer() { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.callback() },
    unmount() { for (const item of slots) item?.cleanup?.(); stopped = true },
    switchPeer(peer) { target = peer; return view() },
  }
  view()
  return api
}

test('send is rejected until identity and history finish loading', async t => {
  let release
  const h = harness({ loadIdentity: () => new Promise(resolve => { release = resolve }) })
  t.after(() => h.unmount())
  await assert.rejects(h.view().sendMessage('too early'), /loading/)
  assert.equal(h.calls.sends.length, 0)
  release(alice)
  await until(() => h.view().ready)
})

test('successful send durably records pending then sent, and transmits only an encrypted directional envelope', async t => {
  const h = harness()
  t.after(() => h.unmount())
  await until(() => h.view().ready)
  await h.view().sendMessage('  Real hello  ')
  assert.deepEqual(h.calls.saves.map(row => row.delivery), ['pending', 'sent'])
  assert.equal(h.calls.sends.length, 1)
  const packet = h.calls.sends[0]
  const envelope = JSON.parse(await cryptoFunctions.decryptFromPeer(packet.encryptedData, bob.pair.privateKey, alice.publicKey))
  assert.equal(envelope.content, 'Real hello')
  assert.equal(envelope.id, packet.id)
  assert.equal(protocol.isEnvelope(envelope, alice.publicKey, bob.publicKey), true)
  assert.equal(h.view().messages[0].delivery, 'sent')
})

test('relay failure preserves a failed message and retry retains its original ID and timestamp', async t => {
  const options = { send: async () => ({ success: false, error: 'Relay temporarily unavailable' }) }
  const h = harness(options)
  t.after(() => h.unmount())
  await until(() => h.view().ready)
  await assert.rejects(h.view().sendMessage('Please keep this draft'), error => {
    assert.match(error.message, /unavailable/)
    assert.equal(error.savedLocally, true, 'composer may clear because history owns the retry')
    return true
  })
  const failed = h.view().messages[0]
  assert.equal(failed.delivery, 'failed')
  options.send = async () => ({ success: true })
  await h.view().sendMessage(failed.content, failed)
  assert.equal(h.calls.sends[0].id, h.calls.sends[1].id)
  assert.equal(h.view().messages.length, 1)
  assert.equal(h.view().messages[0].timestamp, failed.timestamp)
  assert.equal(h.view().messages[0].delivery, 'sent')
})

test('local persistence failure prevents network transmission', async t => {
  const h = harness({ storageFailure: true })
  t.after(() => h.unmount())
  await until(() => h.view().ready)
  await assert.rejects(h.view().sendMessage('Do not lose this'), error => {
    assert.match(error.message, /storage full/)
    assert.equal(error.savedLocally, false, 'composer must retain the only copy')
    return true
  })
  assert.equal(h.calls.sends.length, 0)
  assert.equal(h.view().messages.length, 0, 'do not create a second retry path for an unsaved draft')
})

test('received relay message is saved under the sender before acknowledgment', async t => {
  const row = await inbound()
  const h = harness({ incoming: [row] })
  t.after(() => h.unmount())
  await until(() => h.calls.acknowledgments.length === 1)
  const saved = h.records.get(`${bob.publicKey}:${row.id}`)
  assert.equal(saved.peerPubKey, bob.publicKey)
  assert.equal(saved.delivery, 'received')
  assert.equal(saved.content, 'Incoming message')
})

test('storage failure while receiving leaves the message unacknowledged for retry', async t => {
  const options = { storageFailure: true, incoming: [await inbound()] }
  const h = harness(options)
  t.after(() => h.unmount())
  await until(() => h.timers.size > 0)
  assert.equal(h.calls.acknowledgments.length, 0)
  options.storageFailure = false
  h.runTimer()
  await until(() => h.calls.acknowledgments.length === 1)
  assert.equal(h.view().messages.length, 1)
})

test('replayed stored inbound messages are deduplicated and safely acknowledged', async t => {
  const row = await inbound()
  const history = [{ id: row.id, senderPubKey: bob.publicKey, peerPubKey: bob.publicKey, content: 'Incoming message', timestamp: Date.now(), delivery: 'received' }]
  const h = harness({ history, incoming: [row] })
  t.after(() => h.unmount())
  await until(() => h.calls.acknowledgments.length === 1)
  assert.equal(h.view().messages.length, 1)
  assert.equal(h.calls.saves.length, 0)
})

test('relay polling resumes after a thrown network failure', async t => {
  const options = { list: async () => { throw new Error('Network down') } }
  const h = harness(options)
  t.after(() => h.unmount())
  await until(() => h.timers.size > 0)
  assert.equal(h.view().status, 'offline')
  assert.equal([...h.timers.values()][0].delay, 8000)
  options.list = async () => ({ success: true, messages: [] })
  h.runTimer()
  await until(() => h.view().status === 'relay')
  assert.equal(h.calls.lists, 2)
})

test('unmount during history loading prevents polling and stale updates', async () => {
  let release
  const h = harness({ loadHistory: () => new Promise(resolve => { release = resolve }) })
  await until(() => Boolean(release))
  h.unmount()
  release([])
  for (let index = 0; index < 10; index++) await tick()
  assert.equal(h.calls.lists, 0)
  assert.equal(h.calls.lateUpdates, 0)
  assert.equal(h.timers.size, 0)
})

test('outgoing and incoming messages sharing one ID coexist', async t => {
  const row = await inbound('Incoming with shared ID')
  const history = [{ id: row.id, senderPubKey: alice.publicKey, peerPubKey: bob.publicKey, content: 'Outgoing with shared ID', timestamp: Date.now() - 1000, delivery: 'sent' }]
  const h = harness({ history, incoming: [row] })
  t.after(() => h.unmount())
  await until(() => h.calls.acknowledgments.length === 1)
  assert.equal(h.view().messages.length, 2)
  assert.equal(h.records.size, 2)
})

test('failed relay acknowledgment is retried without duplicating saved history', async t => {
  const row = await inbound()
  const options = { incoming: [row], ack: async () => ({ success: false, error: 'Unavailable' }) }
  const h = harness(options)
  t.after(() => h.unmount())
  await until(() => h.timers.size > 0)
  assert.match(h.view().error, /acknowledgment/)
  assert.equal(h.view().messages.length, 1)
  options.ack = async () => ({ success: true })
  h.runTimer()
  await until(() => h.calls.acknowledgments.length === 2)
  assert.equal(h.view().messages.length, 1)
  assert.equal(h.calls.saves.length, 1)
})


test('stalled inbox request times out and polling recovers without reloading', async t => {
  const options = { list: () => new Promise(() => {}) }
  const h = harness(options)
  t.after(() => h.unmount())
  await until(() => [...h.timers.values()].some(timer => timer.delay === 15000))
  h.runDelay(15000)
  await until(() => h.view().status === 'offline')
  assert.match(h.view().error, /too long/)
  options.list = async () => ({ success: true, messages: [] })
  h.runDelay(8000)
  await until(() => h.view().status === 'relay')
})

test('stalled send releases composer, retains a retry, and ignores late completion', async t => {
  let finish
  const options = { send: () => new Promise(resolve => { finish = resolve }) }
  const h = harness(options)
  t.after(() => h.unmount())
  await until(() => h.view().ready)
  const result = h.view().sendMessage('Keep the same message')
  const rejected = assert.rejects(result, cause => cause.savedLocally && /too long/.test(cause.message))
  await until(() => finish && [...h.timers.values()].some(timer => timer.delay === 15000))
  h.runDelay(15000)
  await rejected
  const failed = h.view().messages[0]
  assert.equal(failed.delivery, 'failed')
  options.send = async () => ({ success: true })
  await h.view().sendMessage(failed.content, failed)
  finish({ success: true })
  await tick()
  assert.equal(h.calls.sends[0].id, h.calls.sends[1].id)
  assert.equal(h.view().messages.length, 1)
  assert.equal(h.view().messages[0].delivery, 'sent')
})

test('one stalled acknowledgment does not delay every other received message', async t => {
  const incoming = await Promise.all([inbound('One'), inbound('Two')])
  const h = harness({ incoming, ack: () => new Promise(() => {}) })
  t.after(() => h.unmount())
  await until(() => h.calls.acknowledgments.length === 1 && [...h.timers.values()].some(timer => timer.delay === 15000))
  h.runDelay(15000)
  await until(() => h.view().messages.length === 2 && [...h.timers.values()].some(timer => timer.delay === 3000))
  assert.equal(h.calls.acknowledgments.length, 1)
  assert.match(h.view().error, /acknowledgment/)
})

test('history invalidation and focus recover messages saved by another tab', async t => {
  const h = harness()
  t.after(() => h.unmount())
  await until(() => h.view().ready)
  const row = { id: crypto.randomUUID(), senderPubKey: bob.publicKey, peerPubKey: bob.publicKey, content: 'From another tab', timestamp: Date.now(), delivery: 'received' }
  h.records.set(bob.publicKey + ':' + row.id, row)
  h.refreshHistory()
  await until(() => h.view().messages.length === 1)
  const other = { ...row, id: crypto.randomUUID(), content: 'Focus fallback' }
  h.records.set(bob.publicKey + ':' + other.id, other)
  h.events.dispatchEvent(new Event('focus'))
  await until(() => h.view().messages.length === 2)
  assert.equal(h.calls.acknowledgments.length, 0)
})

test('reconnect can recover a failed conversation initialization', async t => {
  const options = { loadHistory: async () => { throw new Error('Storage unavailable') } }
  const h = harness(options)
  t.after(() => h.unmount())
  await until(() => h.view().status === 'offline')
  assert.equal(h.view().ready, false)
  options.loadHistory = async () => []
  h.view().reconnect()
  await until(() => h.view().ready)
  assert.equal(h.view().error, null)
})

test('pagination collects a valid message behind an unreadable full page', async t => {
  const valid = await inbound('Message 101')
  const cursor = { createdAt: Date.now(), id: crypto.randomUUID() }
  const invalid = Array.from({ length: 100 }, () => ({ id: crypto.randomUUID(), encryptedData: 'invalid ciphertext' }))
  const requests = []
  const h = harness({ list: async data => {
    requests.push(data)
    return data.after ? { success: true, messages: [valid], nextCursor: null } : { success: true, messages: invalid, nextCursor: cursor }
  } })
  t.after(() => h.unmount())
  await until(() => [...h.timers.values()].some(timer => timer.delay === 100))
  assert.equal(h.calls.acknowledgments.length, 0)
  h.runDelay(100)
  await until(() => h.calls.acknowledgments.length === 1)
  assert.deepEqual(requests[1].after, cursor)
  assert.equal(h.view().messages[0].content, 'Message 101')
  assert.match(h.view().error, /decrypted or saved/)
})


test('fresh pending send from another tab stays pending; an abandoned attempt becomes retryable', async t => {
  const h = harness()
  t.after(() => h.unmount())
  await until(() => h.view().ready)
  const row = { id: crypto.randomUUID(), senderPubKey: alice.publicKey, peerPubKey: bob.publicKey, content: 'Other tab is sending', timestamp: Date.now(), updatedAt: Date.now(), delivery: 'pending' }
  h.records.set(alice.publicKey + ':' + row.id, row)
  h.refreshHistory()
  await until(() => h.view().messages.length === 1)
  assert.equal(h.view().messages[0].delivery, 'pending')
  row.updatedAt = Date.now() - 31000
  h.records.set(alice.publicKey + ':' + row.id, row)
  h.refreshHistory()
  await until(() => h.view().messages[0].delivery === 'failed')
  row.delivery = 'sent'
  h.records.set(alice.publicKey + ':' + row.id, row)
  h.refreshHistory()
  await until(() => h.view().messages[0].delivery === 'sent')
})

test('unmount during signal decryption cannot create a leaked peer connection', async () => {
  const originalAlice = alice, originalBob = bob
  if (alice.publicKey < bob.publicKey) [alice, bob] = [bob, alice]
  let h
  try {
    let release, decrypted = false
    const peers = []
    const signal = { version: 2, sender: bob.publicKey, recipient: alice.publicKey, sessionId: crypto.randomUUID(), timestamp: Date.now(), description: { type: 'offer', sdp: 'test' } }
    const encryptedData = await cryptoFunctions.encryptForPeer(JSON.stringify(signal), bob.pair.privateKey, alice.publicKey)
    class RTC {
      constructor() { peers.push(this) }
      close() {}
    }
    h = harness({ RTC, signal: async () => ({ success: true, signal: { encryptedData } }), decrypt: async (...args) => {
      await new Promise(resolve => { release = resolve })
      const result = await cryptoFunctions.decryptFromPeer(...args)
      decrypted = true
      return result
    } })
    await until(() => !!release)
    h.unmount()
    release()
    await until(() => decrypted)
    for (let i = 0; i < 5; i++) await tick()
    assert.equal(peers.length, 0)
    assert.equal(h.calls.lateUpdates, 0)
    assert.equal(h.timers.size, 0)
  } finally { h?.unmount(); alice = originalAlice; bob = originalBob }
})


test('retry skips the relay when another tab already confirmed the same saved message', async t => {
  const sent = { id: crypto.randomUUID(), senderPubKey: alice.publicKey, peerPubKey: bob.publicKey, content: 'Confirmed elsewhere', timestamp: Date.now(), delivery: 'sent' }
  const h = harness({ save: async () => structuredClone(sent) })
  t.after(() => h.unmount())
  await until(() => h.view().ready)
  await h.view().sendMessage(sent.content, { ...sent, delivery: 'failed' })
  assert.equal(h.calls.sends.length, 0)
  assert.equal(h.view().messages[0].delivery, 'sent')
  await assert.rejects(h.view().sendMessage('Altered text', sent), /original message/)
})

test('repeated relay failures back off to one minute and reset after recovery', async t => {
  let peerAttempts = 0
  const options = { list: async () => { throw new Error('Unavailable') }, RTC: class { constructor() { peerAttempts++; throw new Error('Unexpected negotiation') } } }
  const h = harness(options)
  t.after(() => h.unmount())
  for (const delay of [8000, 16000, 32000, 60000, 60000]) {
    await until(() => [...h.timers.values()].some(timer => timer.delay === delay))
    assert.equal(h.view().status, 'offline')
    assert.equal(peerAttempts + h.calls.signals, 0, 'failed polling must not launch signaling')
    h.runDelay(delay)
  }
  await until(() => [...h.timers.values()].some(timer => timer.delay === 60000))
  options.list = async () => ({ success: true, messages: [] })
  h.runDelay(60000)
  await until(() => [...h.timers.values()].some(timer => timer.delay === 3000))
  assert.equal(h.view().status, 'relay')
  options.list = async () => { throw new Error('Second outage') }
  h.runDelay(3000)
  await until(() => [...h.timers.values()].some(timer => timer.delay === 8000))
})

test('hidden tabs slow polling and skip signaling; visibility restores a single immediate poll', async t => {
  let peerAttempts = 0
  const options = { hidden: true, RTC: class { constructor() { peerAttempts++; throw new Error('Optional direct connection') } } }
  const h = harness(options)
  t.after(() => h.unmount())
  await until(() => [...h.timers.values()].some(timer => timer.delay === 30000))
  assert.equal(peerAttempts + h.calls.signals, 0)
  options.hidden = false
  h.documentEvents.dispatchEvent(new Event('visibilitychange'))
  await until(() => h.calls.lists === 2 && [...h.timers.values()].some(timer => timer.delay === 3000))
  await until(() => peerAttempts + h.calls.signals > 0)
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 30000).length, 0)
  options.hidden = true
  h.documentEvents.dispatchEvent(new Event('visibilitychange'))
  assert.equal(h.calls.lists, 2, 'hiding a tab should reschedule without an extra request')
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 3000).length, 0)
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 30000).length, 1)
})

test('offline tabs make no relay requests and going online does not resend failed messages', async t => {
  let peerAttempts = 0
  const failed = { id: crypto.randomUUID(), senderPubKey: alice.publicKey, peerPubKey: bob.publicKey, content: 'Retry deliberately', timestamp: Date.now(), delivery: 'failed' }
  const options = { online: false, history: [failed], RTC: class { constructor() { peerAttempts++; throw new Error('Optional direct connection') } } }
  const h = harness(options)
  t.after(() => h.unmount())
  await until(() => [...h.timers.values()].some(timer => timer.delay === 8000))
  assert.equal(h.calls.lists + peerAttempts + h.calls.signals, 0)
  h.runDelay(8000)
  await until(() => [...h.timers.values()].some(timer => timer.delay === 16000))
  assert.equal(h.calls.lists + peerAttempts + h.calls.signals, 0)
  options.online = true
  h.events.dispatchEvent(new Event('online'))
  await until(() => h.view().status === 'relay')
  assert.equal(h.calls.lists, 1)
  assert.equal(h.calls.sends.length, 0)
  assert.equal(h.view().messages[0].delivery, 'failed')
})

test('empty inbox cadence grows to fifteen seconds and resets for activity', async t => {
  const options = {}
  const h = harness(options)
  t.after(() => h.unmount())
  for (const delay of [3000, 6000, 9000, 12000, 15000]) {
    await until(() => [...h.timers.values()].some(timer => timer.delay === delay))
    h.runDelay(delay)
  }
  await until(() => [...h.timers.values()].some(timer => timer.delay === 15000))
  options.incoming = [await inbound('Back to active chatting')]
  h.runDelay(15000)
  await until(() => h.view().messages.length === 1 && [...h.timers.values()].some(timer => timer.delay === 3000))
  options.incoming = []
  h.events.dispatchEvent(new Event('focus'))
  await until(() => [...h.timers.values()].some(timer => timer.delay === 3000))
  h.runDelay(3000)
  await until(() => [...h.timers.values()].some(timer => timer.delay === 6000))
  await h.view().sendMessage('I am active too')
  await until(() => [...h.timers.values()].some(timer => timer.delay === 3000))
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 6000).length, 0)
})

test('sending remains independent of an unfinished inbox request', async t => {
  const h = harness({ list: () => new Promise(() => {}) })
  t.after(() => h.unmount())
  await until(() => h.view().ready && h.calls.lists === 1)
  await h.view().sendMessage('Send while polling is stalled')
  assert.equal(h.calls.sends.length, 1)
  assert.equal(h.view().messages[0].delivery, 'sent')
  assert.equal(h.calls.lists, 1, 'send activity must not start a second concurrent inbox request')
})

test('signaling checks are throttled separately from active inbox polling', async t => {
  const originalAlice = alice, originalBob = bob
  if (alice.publicKey < bob.publicKey) [alice, bob] = [bob, alice]
  let h
  try {
    const options = { now: Date.now(), RTC: class {} }
    h = harness(options)
    await until(() => h.calls.signals === 1 && [...h.timers.values()].some(timer => timer.delay === 3000))
    options.now += 3000
    h.runDelay(3000)
    await until(() => [...h.timers.values()].some(timer => timer.delay === 6000))
    assert.equal(h.calls.signals, 1)
    options.now += 6000
    h.runDelay(6000)
    await until(() => [...h.timers.values()].some(timer => timer.delay === 9000))
    assert.equal(h.calls.signals, 1)
    options.now += 9000
    h.runDelay(9000)
    await until(() => h.calls.signals === 2)
  } finally { h?.unmount(); alice = originalAlice; bob = originalBob }
})

test('a waiting answer is applied before an expired offer is replaced', async () => {
  const originalAlice = alice, originalBob = bob
  if (alice.publicKey > bob.publicKey) [alice, bob] = [bob, alice]
  let h
  try {
    const peers = []
    let packet
    class RTC {
      constructor() { peers.push(this); this.iceGatheringState = 'complete'; this.signalingState = 'stable' }
      createDataChannel() { return { readyState: 'connecting', close() {} } }
      async createOffer() { return { type: 'offer', sdp: 'test offer' } }
      async setLocalDescription(description) { this.localDescription = { toJSON: () => description }; this.signalingState = 'have-local-offer' }
      async setRemoteDescription(description) { this.remoteDescription = description; this.signalingState = 'stable' }
      close() { this.closed = true }
    }
    const options = { now: Date.now(), RTC, publishSignal: async data => {
      packet = JSON.parse(await cryptoFunctions.decryptFromPeer(data.encryptedData, bob.pair.privateKey, alice.publicKey))
      return { success: true }
    } }
    h = harness(options)
    await until(() => packet && h.calls.signals === 1 && [...h.timers.values()].some(timer => timer.delay === 3000))
    const answer = { ...packet, sender: bob.publicKey, recipient: alice.publicKey, description: { type: 'answer', sdp: 'test answer' } }
    const encryptedData = await cryptoFunctions.encryptForPeer(JSON.stringify(answer), bob.pair.privateKey, alice.publicKey)
    options.signal = async () => ({ success: true, signal: { encryptedData } })
    options.now += 30_000
    h.runDelay(3000)
    await until(() => peers[0].remoteDescription)
    assert.equal(peers.length, 1, 'a valid waiting answer must preserve its matching offer')
    assert.equal(peers[0].closed, undefined)
    assert.equal(peers[0].remoteDescription.type, 'answer')
  } finally { h?.unmount(); alice = originalAlice; bob = originalBob }
})
