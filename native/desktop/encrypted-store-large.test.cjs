const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { EncryptedStore } = require('./encrypted-store.cjs')

test('Windows saves and reopens an authenticated snapshot over 100 MiB without changing its format', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'serotine-large-snapshot-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  // Only OS key wrapping is stubbed. The snapshot uses the production AES-GCM
  // encryption, authentication, base64 decoder and atomic disk replacement.
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value),
    decryptString: value => value.toString(),
  }
  const text = JSON.stringify({ history: 'x'.repeat(101 * 1024 * 1024) })
  const store = new EncryptedStore(directory, safeStorage, 'win32')
  await store.write(text)
  assert.ok((await fs.stat(store.file)).size > 100 * 1024 * 1024)
  const restarted = new EncryptedStore(directory, safeStorage, 'win32')
  assert.equal(await restarted.read(), text)
  // Existing non-Windows policy remains unchanged.
  const mac = new EncryptedStore(directory, safeStorage, 'darwin')
  await assert.rejects(mac.read(), /too large/)
  await assert.rejects(mac.write(text), /64 MiB/)
  // The next save must authenticate the previous large snapshot too.
  await restarted.write('{"history":"next saved state"}')
  assert.equal(await new EncryptedStore(directory, safeStorage, 'win32').read(), '{"history":"next saved state"}')
  assert.deepEqual((await fs.readdir(directory)).sort(), ['initialized.v1', 'snapshot.v1.json'])
})
