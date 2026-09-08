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
    requireSource, module, module.exports, localStorage, new EventTarget())
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
