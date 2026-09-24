/* Native durability boundary with the production esbuild alias and actual idb
 * library over fake-indexeddb's transactional implementation. Native OS crypto
 * and fsync are covered separately by each platform adapter. */
const assert = require('node:assert/strict')
const path = require('node:path')
const { before, test } = require('node:test')
const esbuild = require('esbuild')
const fake = require('fake-indexeddb')

const root = path.join(__dirname, '..')
let bundle
before(async () => {
  bundle = (await esbuild.build({
    stdin: { contents: `export * from './native/shared/persistence'; export * from './native/shared/persistence-idb';
      export * from './lib/native-persistence'; export * from './lib/identity'; export * from './lib/storage';
      export { saveStoredEvent, getStoredEvents, eventStorageKey } from './lib/messaging-store';
      export * from './lib/file-bank'; export * from './lib/verified-attachment-cache'; export { attachmentFileLimit, validateAttachmentFile } from './lib/attachments';`, resolveDir: root },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'Harness',
    plugins: [{ name: 'native-idb', setup(build) {
      build.onResolve({ filter: /^idb$/ }, args => args.importer.endsWith('/persistence-idb.ts')
        ? undefined : { path: path.join(root, 'native/shared/persistence-idb.ts') })
    } }],
  })).outputFiles[0].text
})

function harness(saved = null, seed = {}) {
  class LocalStorage {
    constructor() { this.values = new Map(Object.entries(seed)) }
    get length() { return this.values.size }
    key(index) { return [...this.values.keys()][index] ?? null }
    getItem(key) { return this.values.get(String(key)) ?? null }
    setItem(key, value) { this.values.set(String(key), String(value)) }
    removeItem(key) { this.values.delete(String(key)) }
    clear() { this.values.clear() }
  }
  const localStorage = new LocalStorage(), window = new EventTarget(), errors = [], states = []
  Object.assign(window, { localStorage })
  window.addEventListener('serotine:native-storage', event => states.push(event.detail.state))
  const indexedDB = new fake.IDBFactory()
  const values = { ...fake, indexedDB, Storage: LocalStorage, localStorage, window, BroadcastChannel: undefined, navigator: {} }
  delete values.default
  const api = new Function(...Object.keys(values), bundle + ';return Harness;')(...Object.values(values))
  const disk = { value: saved, writes: 0, fail: false, wait: undefined }
  const bridge = {
    async readSnapshot() { return disk.value },
    async writeSnapshot(value) {
      if (disk.wait) await disk.wait
      if (disk.fail) throw new Error('Native disk full')
      disk.value = value; disk.writes++
    },
  }
  return { ...api, localStorage, indexedDB, disk, errors, states,
    initialize: () => api.initializeNativePersistence(bridge, error => errors.push(error)),
  }
}

const owner = '04' + 'a'.repeat(128), peer = '04' + 'b'.repeat(128)
const tick = () => new Promise(resolve => setImmediate(resolve))
async function waitFor(condition) { for (let at = 0; at < 200 && !condition(); at++) await tick(); assert.ok(condition(), 'condition should settle') }
async function messagesDatabase(h) {
  return h.openDB(`serotine-messages:${owner}`, 1, { upgrade(db) { db.createObjectStore('messages', { keyPath: 'id' }) } })
}

test('snapshot encoding preserves Blob bytes, undefined, dates and literal tag-shaped objects', async () => {
  const h = harness()
  const original = { file: new Blob(['saved bytes'], { type: 'text/plain' }), missing: undefined,
    when: new Date('2026-01-01T00:00:00Z'), list: [null, true, 12], bytes: new Uint8Array([1, 255]), literal: ['blob', 'malicious'] }
  Object.defineProperty(original, '__proto__', { enumerable: true, value: { preserved: true } })
  const decoded = h.decodeNativeValue(await h.encodeNativeValue(original))
  assert.equal(await decoded.file.text(), 'saved bytes')
  assert.equal(decoded.file.type, 'text/plain')
  assert.ok(Object.hasOwn(decoded, 'missing'))
  assert.equal(decoded.when.toISOString(), original.when.toISOString())
  assert.deepEqual(decoded.bytes, original.bytes)
  assert.deepEqual(decoded.literal, original.literal)
  assert.ok(Object.hasOwn(decoded, '__proto__'))
  assert.equal({}.preserved, undefined)
  assert.throws(() => h.decodeNativeValue(['blob', 'text/plain', '!broken']), /damaged/)
})

test('transaction.done and shorthand writes wait for the native atomic commit', async () => {
  const h = harness(); await h.initialize()
  const db = await messagesDatabase(h)
  let release
  h.disk.wait = new Promise(resolve => { release = resolve })
  const tx = db.transaction('messages', 'readwrite')
  let settled = false
  const done = tx.done.then(() => { settled = true })
  await tx.store.put({ id: 'pending', content: 'outbox work' })
  await waitFor(() => h.states.at(-1) === 'saving')
  assert.equal(settled, false, 'IDB request success cannot acknowledge native durability')
  assert.equal(h.disk.value.includes('outbox work'), false)
  release(); await done
  assert.equal(h.disk.value.includes('outbox work'), true)
  h.disk.wait = undefined
  await db.put('messages', { id: 'confirmed', content: 'accepted send' })
  assert.equal(h.disk.value.includes('accepted send'), true)
  db.close()
})

test('process restart with evicted WebView state restores identity, outbox, history, preferences and file bytes', async () => {
  const h = harness(); await h.initialize()
  const identity = await h.createIdentity()
  h.saveContacts(identity.publicKey, [{ pub: peer, alias: 'Friend' }])
  h.localStorage.setItem('serotine:palettes:v1', '{"theme":"dark"}')
  h.localStorage.setItem(`serotine_identity_replacement:${identity.publicKey}`, JSON.stringify(identity))
  await h.saveMessageToStorage(identity.publicKey, { id: 'queued', senderPubKey: identity.publicKey,
    peerPubKey: peer, content: 'retained history', timestamp: 123, delivery: 'pending' })
  const event = { version: 3, id: 'pending-event', author: identity.publicKey, conversationId: peer, recipients: [peer],
    timestamp: 124, kind: 'message', payload: { content: 'native event outbox' }, signature: 'storage-test-fixture' }
  const record = { key: h.eventStorageKey(event), event, local: true, delivered: [], receivedAt: 124 }
  await h.saveStoredEvent(identity.publicKey, record)
  const events = await h.openDB(`serotine-events:${identity.publicKey}`, 2)
  await events.put('metadata', { cursor: 24, pending: ['queued'], blocked: [peer] }, 'preferences')
  events.close()
  await h.saveBankFiles(identity.publicKey, [new File(['private file bytes'], 'notes.txt', { type: 'text/plain', lastModified: 123 })])
  await h.flushNativeStorage()
  const restarted = harness(h.disk.value)
  assert.equal(restarted.localStorage.length, 0, 'WebView starts completely empty')
  await restarted.initialize()
  assert.deepEqual(await restarted.loadIdentity(), identity)
  assert.deepEqual(restarted.loadContacts(identity.publicKey), [{ pub: peer, alias: 'Friend' }])
  assert.equal(restarted.localStorage.getItem('serotine:palettes:v1'), '{"theme":"dark"}')
  assert.ok(restarted.localStorage.getItem(`serotine_identity_replacement:${identity.publicKey}`))
  assert.equal((await restarted.getMessagesFromStorage(identity.publicKey, peer))[0].delivery, 'pending')
  assert.deepEqual(await restarted.getStoredEvents(identity.publicKey), [record])
  const restoredEvents = await restarted.openDB(`serotine-events:${identity.publicKey}`, 2)
  assert.deepEqual(await restoredEvents.get('metadata', 'preferences'), { cursor: 24, pending: ['queued'], blocked: [peer] })
  restoredEvents.close()
  const files = await restarted.listBankFiles(identity.publicKey)
  assert.equal(files.length, 1)
  assert.equal(await (await restarted.getBankFile(identity.publicKey, files[0].id)).text(), 'private file bytes')
})

test('failed native commit rejects the mutation, freezes subsequent work, and reopens the previous durable state', async () => {
  const h = harness(); await h.initialize()
  const db = await messagesDatabase(h)
  await db.put('messages', { id: 'kept', content: 'last durable state' })
  const before = h.disk.value
  h.disk.fail = true
  await assert.rejects(db.put('messages', { id: 'lost', content: 'must not be acknowledged' }), /disk full/)
  assert.equal(h.disk.value, before)
  assert.equal(h.errors.length, 1)
  await assert.rejects(h.flushNativeStorage(), /disk full/)
  assert.throws(() => h.localStorage.setItem('serotine_identity_v2', 'replacement'), /disk full/)
  db.close()
  const restored = harness(h.disk.value); await restored.initialize()
  const restoredDB = await messagesDatabase(restored)
  assert.equal((await restoredDB.getAll('messages')).length, 1)
  assert.equal((await restoredDB.get('messages', 'kept')).content, 'last durable state')
  restoredDB.close()
})

test('corrupt or missing native backing cannot silently create a new identity or clear surviving cache', async () => {
  const corrupt = harness('{broken', { serotine_identity_v2: 'preserve cache' })
  await assert.rejects(corrupt.initialize(), /damaged/)
  assert.equal(corrupt.localStorage.getItem('serotine_identity_v2'), 'preserve cache')
  assert.equal(corrupt.disk.writes, 0)
  const missing = harness(null, { serotine_identity_v2: 'existing identity' })
  await assert.rejects(missing.initialize(), /missing.*WebView data/i)
  assert.equal(missing.disk.writes, 0)
  const unsupported = harness('{"format":"serotine-native-storage","version":99,"local":[],"databases":[]}')
  await assert.rejects(unsupported.initialize(), /unsupported format/)
})

test('retirement cannot reach the relay until replacement and archived identity are native-durable', async () => {
  const h = harness(); await h.initialize()
  const identity = await h.createIdentity()
  h.disk.fail = true
  let retired = false
  await assert.rejects(h.replaceRetiredIdentity(identity.publicKey, async () => { retired = true }), /no retirement request was sent/i)
  assert.equal(retired, false)
  const revived = harness(h.disk.value); await revived.initialize()
  assert.equal((await revived.loadIdentity()).publicKey, identity.publicKey)
})

test('an aborted IDB transaction never writes a native snapshot', async () => {
  const h = harness(); await h.initialize()
  const db = await messagesDatabase(h), before = h.disk.writes
  const tx = db.transaction('messages', 'readwrite'), completion = tx.done
  const failure = assert.rejects(completion)
  await tx.store.put({ id: 'discarded', content: 'aborted' })
  tx.abort()
  await failure
  await tick()
  assert.equal(h.disk.writes, before)
  assert.equal(h.disk.value.includes('aborted'), false)
  db.close()
})

test('native file limits reject oversized work before creating a working-cache write', async () => {
  const h = harness()
  assert.equal(h.attachmentFileLimit(), 1024 ** 3)
  await h.initialize()
  assert.equal(h.attachmentFileLimit(), 16 * 1024 ** 2)
  assert.equal(h.bankCapacityBytes(), 32 * 1024 ** 2)
  const before = h.disk.writes
  await assert.rejects(h.saveBankFiles(owner, [new File([new Uint8Array(16 * 1024 ** 2 + 1)], 'too-large.bin')]), /installed beta supports files/i)
  assert.equal((await h.indexedDB.databases()).length, 0)
  assert.equal(h.disk.writes, before)
  assert.equal(h.errors.length, 0, 'a normal over-limit selection must remain recoverable')
})

test('readonly and unchanged readwrite transactions do not rewrite the snapshot', async () => {
  const h = harness(); await h.initialize()
  const db = await messagesDatabase(h), before = h.disk.writes
  const tx = db.transaction('messages', 'readwrite')
  await tx.store.getAll(); await tx.done
  assert.equal(h.disk.writes, before)
  db.close()
})

test('overlapping native saves preserve both committed transactions and the newest local settings', async () => {
  const h = harness(); await h.initialize()
  const db = await messagesDatabase(h)
  let release
  h.disk.wait = new Promise(resolve => { release = resolve })
  const first = db.put('messages', { id: 'first', content: 'one' })
  await waitFor(() => h.states.at(-1) === 'saving')
  const second = db.put('messages', { id: 'second', content: 'two' })
  h.localStorage.setItem('serotine:palettes:v1', 'latest preference')
  release()
  await Promise.all([first, second, h.flushNativeStorage()])
  db.close()
  const reopened = harness(h.disk.value); await reopened.initialize()
  const saved = await messagesDatabase(reopened)
  assert.deepEqual((await saved.getAll('messages')).map(row => row.id), ['first', 'second'])
  assert.equal(reopened.localStorage.getItem('serotine:palettes:v1'), 'latest preference')
  saved.close()
})

test('the total snapshot ceiling never replaces the last recoverable native envelope', async () => {
  const h = harness(); await h.initialize()
  const previous = h.disk.value
  h.localStorage.setItem('serotine:oversized-test', 'x'.repeat(h.NATIVE_SNAPSHOT_MAX_BYTES))
  await assert.rejects(h.flushNativeStorage(), /64 MiB local storage limit/)
  assert.equal(h.disk.value, previous)
  assert.equal(h.errors.length, 1)
})
