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
  const slots = [], effects = [], timers = new Map(), events = new EventTarget()
  const records = new Map((options.history || []).map(item => [`${item.senderPubKey}:${item.id}`, structuredClone(item)]))
  const calls = { sends: [], saves: [], acknowledgments: [], lists: 0, lateUpdates: 0 }
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
    async getSignal() { return { success: true, signal: null } },
    async storeSignal() { return { success: true } },
  }
  const storage = {
    async migrateLegacyHistory() {},
    async getMessagesFromStorage() { return options.loadHistory ? options.loadHistory() : [...records.values()].map(item => structuredClone(item)) },
    async saveMessageToStorage(owner, item) {
      if (options.storageFailure) throw new Error('Browser storage full')
      assert.equal(owner, alice.publicKey)
      calls.saves.push(structuredClone(item))
      records.set(`${item.senderPubKey}:${item.id}`, structuredClone(item))
    },
  }
  const hook = loader({ react, '@/app/actions': actions, '@/lib/storage': storage,
    '@/lib/identity': { loadIdentity: async () => options.loadIdentity ? options.loadIdentity() : alice, validateAddress: async address => address.toLowerCase() },
    '@/config/webrtc': { RTC_CONFIG: {} },
  }, { window: events, navigator: { onLine: true }, RTCPeerConnection: undefined,
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
    options, calls, records, timers, view,
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
