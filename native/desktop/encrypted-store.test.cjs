const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { EncryptedStore } = require('./encrypted-store.cjs')

// The OS service is mocked; encryption/authentication on the actual snapshot remains real AES-GCM.
function protection() {
  const key = crypto.randomBytes(32)
  return { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptString(value) {
      const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
    },
    decryptString(value) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
    } }
}
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'serotine-storage-test-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const osProtection = protection()
  return { directory, osProtection, store: new EncryptedStore(directory, osProtection) }
}
test('snapshot survives a new store instance and no plaintext reaches disk', async t => {
  const { store, directory, osProtection } = await fixture(t)
  assert.equal(await store.read(), null)
  const text = JSON.stringify({ identity: 'secret-identity-value', history: 'private text' })
  await store.write(text)
  const disk = await fs.readFile(store.file, 'utf8')
  assert.equal(disk.includes('secret-identity-value'), false)
  assert.equal(disk.includes('private text'), false)
  assert.equal(await new EncryptedStore(directory, osProtection).read(), text)
  assert.deepEqual((await fs.readdir(directory)).sort(), ['initialized.v1', 'snapshot.v1.json'])
})
test('concurrent writes commit in order without leaving staging files', async t => {
  const { store, directory } = await fixture(t)
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.write(JSON.stringify({ revision: i }))))
  assert.equal(await store.read(), '{"revision":7}')
  assert.equal((await fs.readdir(directory)).length, 2)
})
test('corruption and wrong OS key fail closed without overwriting saved state', async t => {
  const { store, directory } = await fixture(t)
  await store.write('{"identity":"existing"}')
  const old = await fs.readFile(store.file, 'utf8')
  await assert.rejects(new EncryptedStore(directory, protection()).read(), /could not unlock/)
  const value = JSON.parse(old); value.tag = crypto.randomBytes(16).toString('base64')
  await fs.writeFile(store.file, JSON.stringify(value))
  await assert.rejects(store.read(), /could not unlock/)
  await assert.rejects(store.write('{"identity":"replacement"}'), /could not unlock/)
  assert.equal(await fs.readFile(store.file, 'utf8'), JSON.stringify(value))
})
test('missing committed file and interrupted initial write never create a replacement identity', async t => {
  const { store, directory, osProtection } = await fixture(t)
  await store.write('existing')
  await fs.unlink(store.file)
  await assert.rejects(store.read(), /missing or interrupted/)
  await assert.rejects(store.write('replacement'), /missing or interrupted/)
  await fs.unlink(store.marker)
  await fs.writeFile(path.join(directory, 'snapshot.v1.json.interrupted.tmp'), 'encrypted staging')
  await assert.rejects(new EncryptedStore(directory, osProtection).read(), /missing or interrupted/)
})
test('commit before sentinel is repaired without losing the snapshot', async t => {
  const { store, directory, osProtection } = await fixture(t)
  await store.write('existing')
  await fs.unlink(store.marker)
  assert.equal(await new EncryptedStore(directory, osProtection).read(), 'existing')
  assert.equal(await fs.readFile(store.marker, 'utf8'), '1\n')
})
test('locked OS storage and Linux plaintext fallback are rejected', async t => {
  const { directory, osProtection } = await fixture(t)
  await assert.rejects(new EncryptedStore(directory, { ...osProtection, isEncryptionAvailable: () => false }).read(), /OS-protected/)
  await assert.rejects(new EncryptedStore(directory, { ...osProtection, getSelectedStorageBackend: () => 'basic_text' }, 'linux').write('secret'), /OS-protected/)
  assert.deepEqual(await fs.readdir(directory), [])
})
test('explicit recovery discards a broken envelope so encrypted backup restore can begin', async t => {
  const { store } = await fixture(t)
  await store.write('old identity')
  await fs.writeFile(store.file, 'corrupt encrypted envelope')
  await assert.rejects(store.read(), /could not unlock/)
  await store.reset()
  assert.equal(await store.read(), null)
  await store.write('deliberately restored identity')
  assert.equal(await store.read(), 'deliberately restored identity')
})
test('recovery rejects queued writes, reads and pending flushes instead of racing them', async t => {
  const { store } = await fixture(t)
  const write = store.write('existing identity')
  await assert.rejects(store.reset(), /busy/)
  await write
  const read = store.read()
  await assert.rejects(store.reset(), /busy/)
  await read
  const flush = store.flush()
  await assert.rejects(store.reset(), /busy/)
  await flush
  assert.equal(await store.read(), 'existing identity')
})
