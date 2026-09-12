/* Actual identity/backup code with real WebCrypto and an isolated localStorage boundary. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { test, before, beforeEach } = require('node:test')
const root = [process.env.SEROTINE_TEST_ROOT, process.cwd(), path.join(__dirname, 'serotine'), path.join(__dirname, '..')]
  .filter(Boolean).find(candidate => fs.existsSync(path.join(candidate, 'lib/identity.ts')))
assert.ok(root, 'Run from the Serotine repository or set SEROTINE_TEST_ROOT')
const repoRequire = createRequire(path.join(root, 'package.json'))
const ts = repoRequire('typescript')
const saved = new Map()
const localStorage = {
  getItem(key) { return saved.get(key) ?? null },
  setItem(key, value) { saved.set(key, String(value)) },
  removeItem(key) { saved.delete(key) },
}
const cache = new Map()
const localWindow = new EventTarget()
function load(filename) {
  if (!path.extname(filename)) filename += '.ts'
  if (cache.has(filename)) return cache.get(filename).exports
  const module = { exports: {} }
  cache.set(filename, module)
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  function requireSource(specifier) {
    if (specifier.startsWith('.')) return load(path.resolve(path.dirname(filename), specifier))
    if (specifier.startsWith('@/')) return load(path.join(root, specifier.slice(2)))
    return repoRequire(specifier)
  }
  new Function('require', 'module', 'exports', 'localStorage', 'window', output)(
    requireSource, module, module.exports, localStorage, localWindow)
  return module.exports
}
const cryptography = load(path.join(root, 'lib/crypto.ts'))
const identity = load(path.join(root, 'lib/identity.ts'))
let alice, bob, encryptedBackup
const password = 'correct-horse-test-backup-password'
before(async () => {
  async function generate() {
    const pair = await cryptography.generateEncryptionKeyPair()
    return { version: 2, publicKey: await cryptography.exportPublicKeyToHex(pair.publicKey), privateKey: await cryptography.exportKey(pair.privateKey) }
  }
  [alice, bob] = await Promise.all([generate(), generate()])
  encryptedBackup = await identity.exportIdentityBackup(alice, password)
})
beforeEach(() => saved.clear())

test('encrypted backup restores exact identity using real PBKDF2 and AES-GCM', async () => {
  assert.equal(encryptedBackup.includes(alice.privateKey.d), false)
  assert.equal(encryptedBackup.includes(alice.publicKey), false)
  const restored = await identity.restoreIdentityBackup(encryptedBackup, password)
  assert.deepEqual(restored, alice)
  assert.deepEqual(await identity.loadIdentity(), alice)
  const another = JSON.parse(await identity.exportIdentityBackup(alice, password))
  const first = JSON.parse(encryptedBackup)
  assert.notEqual(first.salt, another.salt)
  assert.notEqual(first.iv, another.iv)
  assert.notEqual(first.ciphertext, another.ciphertext)
})

test('incorrect password or modified ciphertext cannot restore or write an identity', async () => {
  await assert.rejects(identity.restoreIdentityBackup(encryptedBackup, 'incorrect-password'), /password.*incorrect|damaged/i)
  assert.equal(saved.size, 0)
  const modified = JSON.parse(encryptedBackup)
  const bytes = Buffer.from(modified.ciphertext, 'base64')
  bytes[0] ^= 1
  modified.ciphertext = bytes.toString('base64')
  await assert.rejects(identity.restoreIdentityBackup(JSON.stringify(modified), password), /password.*incorrect|damaged/i)
  assert.equal(saved.size, 0)
})

test('public/private mismatch is rejected before saving a backup', async () => {
  const mismatch = { ...alice, publicKey: bob.publicKey }
  await assert.rejects(identity.validateIdentity(mismatch), /do not match/i)
  await assert.rejects(identity.restoreIdentityBackup(JSON.stringify(mismatch), ''), /do not match/i)
  assert.equal(saved.size, 0)
})

test('legacy raw private JWK restores its original encryption identity', async () => {
  const restored = await identity.restoreIdentityBackup(JSON.stringify(alice.privateKey), '')
  assert.deepEqual(restored, alice)
  assert.deepEqual(await identity.loadIdentity(), alice)
})

test('restoring a different identity cannot overwrite an existing valid identity', async () => {
  saved.set('serotine_identity_v2', JSON.stringify(bob))
  const original = saved.get('serotine_identity_v2')
  await assert.rejects(identity.restoreIdentityBackup(encryptedBackup, password), /different identity.*already saved/i)
  assert.equal(saved.get('serotine_identity_v2'), original)
  assert.deepEqual(await identity.loadIdentity(), bob)
  await assert.rejects(identity.createIdentity(), /already exists/i)
  assert.equal(saved.get('serotine_identity_v2'), original)
})

test('corrupt contacts fail explicitly without damaging identity or stored data', async () => {
  saved.set('serotine_identity_v2', JSON.stringify(alice))
  const contactKey = `serotine_contacts:${alice.publicKey}`
  saved.set(contactKey, '{broken json')
  assert.throws(() => identity.loadContacts(alice.publicKey), /could not be read/i)
  assert.equal(saved.get(contactKey), '{broken json')
  assert.deepEqual(await identity.loadIdentity(), alice)
  saved.set(contactKey, JSON.stringify({ wrong: 'shape' }))
  assert.throws(() => identity.loadContacts(alice.publicKey), /invalid format/i)
  saved.set(contactKey, JSON.stringify([{ pub: bob.publicKey, alias: 'Bob' }, { pub: bob.publicKey, alias: 'Duplicate' }, { pub: alice.publicKey, alias: 'Self' }, null, { pub: 'garbage' }]))
  assert.deepEqual(identity.loadContacts(alice.publicKey), [{ pub: bob.publicKey, alias: 'Bob' }])
})


test('concurrent creation cannot replace an identity that another call just created', async () => {
  const attempts = await Promise.allSettled([identity.createIdentity(), identity.createIdentity()])
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
  const winner = attempts.find(result => result.status === 'fulfilled').value
  assert.deepEqual(await identity.loadIdentity(), winner)
})

test('concurrent restores cannot overwrite each other with different identities', async () => {
  const attempts = await Promise.allSettled([identity.restoreIdentityBackup(JSON.stringify(alice), ''), identity.restoreIdentityBackup(JSON.stringify(bob), '')])
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
  const winner = attempts.find(result => result.status === 'fulfilled').value
  assert.deepEqual(await identity.loadIdentity(), winner)
})

test('blocked storage is a retryable access error and cannot be treated as corrupt identity', async () => {
  const original = localStorage.getItem
  localStorage.getItem = () => { throw new Error('Storage access denied') }
  try {
    await assert.rejects(identity.loadIdentity(), error => error instanceof identity.IdentityAccessError)
    await assert.rejects(identity.restoreIdentityBackup(JSON.stringify(alice), ''), error => error instanceof identity.IdentityAccessError)
    assert.equal(saved.size, 0)
  } finally { localStorage.getItem = original }
})

test('confirmed identity switch archives the old key and retains separately owned contacts', async () => {
  saved.set('serotine_identity_v2', JSON.stringify(bob))
  identity.saveContacts(bob.publicKey, [{ pub: alice.publicKey, alias: 'Desktop' }])
  await assert.rejects(identity.restoreIdentityBackup(encryptedBackup, password), error => error instanceof identity.IdentityConflictError
    && error.existingPublicKey === bob.publicKey && error.backupPublicKey === alice.publicKey)
  assert.equal(saved.has('serotine_identity_archives_v1'), false)
  await identity.restoreIdentityBackup(encryptedBackup, password, { replaceIdentity: bob.publicKey })
  assert.deepEqual(await identity.loadIdentity(), alice)
  assert.deepEqual((await identity.loadArchivedIdentities()).map(item => item.publicKey), [bob.publicKey])
  assert.deepEqual(identity.loadContacts(bob.publicKey), [{ pub: alice.publicKey, alias: 'Desktop' }])
  assert.deepEqual(identity.loadContacts(alice.publicKey), [])
  await identity.restoreIdentityBackup(JSON.stringify(bob), '', { replaceIdentity: alice.publicKey })
  assert.deepEqual(await identity.loadIdentity(), bob)
})

test('switch consent cannot apply to a different current identity or an empty browser', async () => {
  saved.set('serotine_identity_v2', JSON.stringify(alice))
  await assert.rejects(identity.restoreIdentityBackup(encryptedBackup, password, { replaceIdentity: bob.publicKey }), /changed.*another tab/i)
  assert.equal(saved.has('serotine_identity_archives_v1'), false)
  saved.clear()
  await assert.rejects(identity.restoreIdentityBackup(encryptedBackup, password, { replaceIdentity: bob.publicKey }), /changed.*another tab/i)
  assert.equal(saved.size, 0)
})

test('archive failure does not switch the active identity', async () => {
  saved.set('serotine_identity_v2', JSON.stringify(bob))
  const original = localStorage.setItem
  localStorage.setItem = (key, value) => {
    if (key === 'serotine_identity_archives_v1') throw new Error('Quota exceeded')
    original(key, value)
  }
  try {
    await assert.rejects(identity.restoreIdentityBackup(encryptedBackup, password, { replaceIdentity: bob.publicKey }), /could not be preserved/i)
    assert.deepEqual(await identity.loadIdentity(), bob)
  } finally { localStorage.setItem = original }
})

test('validated import holds the identity lock and activates after data writes', async () => {
  saved.set('serotine_identity_v2', JSON.stringify(bob))
  const lifecycle = []
  const changing = () => lifecycle.push('changing')
  const changed = () => lifecycle.push('changed')
  localWindow.addEventListener('serotine:identity-changing', changing)
  localWindow.addEventListener('serotine:identity-changed', changed)
  try {
    await identity.restoreValidatedIdentity(alice, { replaceIdentity: bob.publicKey }, async () => {
      assert.deepEqual(await identity.loadIdentity(), bob)
      lifecycle.push('import')
    })
    assert.deepEqual(await identity.loadIdentity(), alice)
    assert.deepEqual(lifecycle, ['changing', 'import', 'changed'])
    await assert.rejects(identity.restoreValidatedIdentity(bob, { replaceIdentity: alice.publicKey }, async () => {
      throw new Error('Data import failed')
    }), /Data import failed/)
    assert.deepEqual(await identity.loadIdentity(), alice)
    assert.deepEqual(lifecycle.slice(-2), ['changing', 'changed'])
  } finally {
    localWindow.removeEventListener('serotine:identity-changing', changing)
    localWindow.removeEventListener('serotine:identity-changed', changed)
  }
})

test('retirement saves the replacement and archive first, then copies contacts without changing the old address book', async () => {
  saved.set('serotine_identity_v2', JSON.stringify(alice))
  identity.saveContacts(alice.publicKey, [{ pub: bob.publicKey, alias: 'Bob' }])
  const result = await identity.replaceRetiredIdentity(alice.publicKey, async () => {
    assert.deepEqual(await identity.loadIdentity(), alice)
    const staged = JSON.parse(saved.get(`serotine_identity_replacement:${alice.publicKey}`))
    assert.notEqual(staged.publicKey, alice.publicKey)
    assert.equal((await identity.loadArchivedIdentities())[0].publicKey, alice.publicKey)
    assert.deepEqual(identity.loadContacts(staged.publicKey), [{ pub: bob.publicKey, alias: 'Bob' }])
  })
  assert.deepEqual(await identity.loadIdentity(), result)
  assert.equal((await identity.loadArchivedIdentities())[0].retired, true)
  assert.deepEqual(identity.loadContacts(alice.publicKey), [{ pub: bob.publicKey, alias: 'Bob' }])
})

test('ambiguous retirement failure preserves the current identity and reuses the durable replacement on retry', async () => {
  saved.set('serotine_identity_v2', JSON.stringify(alice))
  await assert.rejects(identity.replaceRetiredIdentity(alice.publicKey, async () => { throw new Error('Response lost') }), /Response lost/)
  const staged = JSON.parse(saved.get(`serotine_identity_replacement:${alice.publicKey}`))
  assert.deepEqual(await identity.loadIdentity(), alice)
  assert.equal((await identity.loadArchivedIdentities())[0].retired, false)
  const result = await identity.replaceRetiredIdentity(alice.publicKey, async () => {})
  assert.deepEqual(result, staged)
  assert.deepEqual(await identity.loadIdentity(), staged)
})

test('retirement cannot reach the relay when recovery material cannot be persisted', async () => {
  saved.set('serotine_identity_v2', JSON.stringify(alice))
  const original = localStorage.setItem
  let requested = false
  localStorage.setItem = (key, value) => {
    if (key === 'serotine_identity_archives_v1') throw new Error('Quota exceeded')
    original(key, value)
  }
  try {
    await assert.rejects(identity.replaceRetiredIdentity(alice.publicKey, async () => { requested = true }), /no retirement request was sent/i)
    assert.equal(requested, false)
    assert.deepEqual(await identity.loadIdentity(), alice)
  } finally { localStorage.setItem = original }
})

test('activation failure after retirement preserves staged recovery and succeeds with the same identity on retry', async () => {
  saved.set('serotine_identity_v2', JSON.stringify(alice))
  const original = localStorage.setItem
  localStorage.setItem = (key, value) => {
    if (key === 'serotine_identity_v2') throw new Error('Quota exceeded')
    original(key, value)
  }
  try {
    await assert.rejects(identity.replaceRetiredIdentity(alice.publicKey, async () => {}), /old address was retired.*retry/i)
    assert.deepEqual(await identity.loadIdentity(), alice)
    assert.equal((await identity.loadArchivedIdentities())[0].retired, true)
  } finally { localStorage.setItem = original }
  const staged = JSON.parse(saved.get(`serotine_identity_replacement:${alice.publicKey}`))
  assert.deepEqual(await identity.replaceRetiredIdentity(alice.publicKey, async () => {}), staged)
})

test('completed retirement never reuses an active or retired replacement after returning to the old identity', async () => {
  saved.set('serotine_identity_v2', JSON.stringify(alice))
  const original = localStorage.removeItem
  localStorage.removeItem = () => { throw new Error('Cleanup unavailable') }
  let first
  try { first = await identity.replaceRetiredIdentity(alice.publicKey, async () => {}) }
  finally { localStorage.removeItem = original }
  identity.saveContacts(first.publicKey, [{ pub: bob.publicKey, alias: 'New alias' }])
  await identity.restoreIdentityBackup(JSON.stringify(alice), '', { replaceIdentity: first.publicKey })
  const second = await identity.replaceRetiredIdentity(alice.publicKey, async () => {})
  assert.notEqual(second.publicKey, first.publicKey)
  assert.deepEqual(identity.loadContacts(first.publicKey), [{ pub: bob.publicKey, alias: 'New alias' }])
  assert.equal(saved.has(`serotine_identity_replacement:${alice.publicKey}`), false)
  await identity.restoreIdentityBackup(JSON.stringify(alice), '', { replaceIdentity: second.publicKey })
  // A stale staging record must not activate a known-retired key even if its
  // archive was removed separately during a prior recovery.
  saved.set(`serotine_identity_replacement:${alice.publicKey}`, JSON.stringify(first))
  saved.set(`serotine_retired_identity:${first.publicKey}`, 'retired')
  saved.set('serotine_identity_archives_v1', JSON.stringify([alice]))
  const third = await identity.replaceRetiredIdentity(alice.publicKey, async () => {})
  assert.notEqual(third.publicKey, first.publicKey)
  assert.notEqual(third.publicKey, second.publicKey)
})

test('retirement retry merges contacts into the staged replacement without overwriting newer aliases', async () => {
  saved.set('serotine_identity_v2', JSON.stringify(alice))
  identity.saveContacts(alice.publicKey, [{ pub: bob.publicKey, alias: 'Old alias' }])
  await assert.rejects(identity.replaceRetiredIdentity(alice.publicKey, async () => { throw new Error('Response lost') }))
  const staged = JSON.parse(saved.get(`serotine_identity_replacement:${alice.publicKey}`))
  identity.saveContacts(staged.publicKey, [{ pub: bob.publicKey, alias: 'Newer alias' }])
  const result = await identity.replaceRetiredIdentity(alice.publicKey, async () => {})
  assert.equal(result.publicKey, staged.publicKey)
  assert.deepEqual(identity.loadContacts(staged.publicKey), [{ pub: bob.publicKey, alias: 'Newer alias' }])
})
