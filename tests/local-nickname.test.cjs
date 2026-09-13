const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')

const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../lib/local-nickname.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText

function setup(withWindow = true) {
  const saved = new Map()
  const storage = {
    getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, String(value)),
    removeItem: key => saved.delete(key),
  }
  const window = new EventTarget()
  window.localStorage = storage
  const module = { exports: {} }
  new Function('module', 'exports', 'window', source)(module, module.exports, withWindow ? window : undefined)
  return { api: module.exports, saved, storage, window }
}

function storageEvent(window, key, storageArea) {
  const event = new Event('storage')
  Object.assign(event, { key, storageArea })
  window.dispatchEvent(event)
}

test('private nicknames persist independently per identity, normalize input, and reset by removing the key', () => {
  const { api, saved } = setup()
  assert.equal(api.loadLocalNickname('alice'), '')
  assert.equal(api.saveLocalNickname('alice', '  My\n private\t name  '), 'My private name')
  assert.equal(api.saveLocalNickname('bob', 'B'.repeat(70)), 'B'.repeat(60))
  assert.equal(api.loadLocalNickname('alice'), 'My private name')
  assert.equal(api.loadLocalNickname('bob'), 'B'.repeat(60))
  assert.deepEqual([...saved.keys()], ['serotine_local_nickname:alice', 'serotine_local_nickname:bob'])
  api.saveLocalNickname('alice', '  \t ')
  assert.equal(saved.has('serotine_local_nickname:alice'), false)
  assert.equal(api.loadLocalNickname('alice'), '')
  assert.equal(api.loadLocalNickname('bob'), 'B'.repeat(60))
})

test('same-tab saves and cross-tab storage events only update relevant identity subscribers', () => {
  const { api, window, storage } = setup()
  const aliceValues = [], bobValues = []
  const unsubscribeAlice = api.subscribeLocalNickname('alice', () => aliceValues.push(api.loadLocalNickname('alice')))
  const unsubscribeBob = api.subscribeLocalNickname('bob', () => bobValues.push(api.loadLocalNickname('bob')))
  api.saveLocalNickname('alice', 'Alice')
  assert.deepEqual(aliceValues, ['Alice'])
  assert.deepEqual(bobValues, [])
  storage.setItem('serotine_local_nickname:alice', 'Updated in another tab')
  storageEvent(window, 'unrelated-key', storage)
  storageEvent(window, 'serotine_local_nickname:alice', {})
  assert.deepEqual(aliceValues, ['Alice'])
  storageEvent(window, 'serotine_local_nickname:alice', storage)
  assert.deepEqual(aliceValues, ['Alice', 'Updated in another tab'])
  assert.deepEqual(bobValues, [])
  storage.removeItem('serotine_local_nickname:alice')
  storageEvent(window, null, storage)
  assert.equal(aliceValues.at(-1), '')
  assert.deepEqual(bobValues, [''])
  unsubscribeAlice()
  unsubscribeBob()
  api.saveLocalNickname('alice', 'After unsubscribe')
  assert.equal(aliceValues.length, 3)
})

test('blocked writes or removal report failure without replacing the saved nickname or notifying listeners', () => {
  const { api, storage } = setup()
  api.saveLocalNickname('alice', 'Existing')
  let changes = 0
  api.subscribeLocalNickname('alice', () => { changes++ })
  storage.setItem = () => { throw new Error('Quota exceeded') }
  assert.throws(() => api.saveLocalNickname('alice', 'Not saved'), /Could not save your private nickname/)
  assert.equal(api.loadLocalNickname('alice'), 'Existing')
  storage.removeItem = () => { throw new Error('Storage blocked') }
  assert.throws(() => api.saveLocalNickname('alice', ''), /Could not save your private nickname/)
  assert.equal(api.loadLocalNickname('alice'), 'Existing')
  assert.equal(changes, 0)
})

test('unavailable storage and server rendering read the default without leaking another identity', () => {
  const { api, window, saved } = setup()
  assert.throws(() => api.saveLocalNickname('', 'Orphaned name'), /identity is not ready/)
  assert.equal(saved.size, 0)
  Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage denied') } })
  assert.equal(api.loadLocalNickname('alice'), '')
  assert.throws(() => api.saveLocalNickname('alice', 'Blocked'), /Could not save your private nickname/)
  const server = setup(false).api
  assert.equal(server.loadLocalNickname('alice'), '')
  assert.doesNotThrow(() => server.subscribeLocalNickname('alice', () => {})())
  assert.throws(() => server.saveLocalNickname('alice', 'Server'), /Could not save your private nickname/)
})
