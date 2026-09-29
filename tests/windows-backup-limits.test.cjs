/* Exercise real encryption and storage with a reduced byte ceiling so routine
 * tests do not allocate several copies of a 100+ MiB backup. Only the two fixed
 * browser/mobile byte constants are scaled; platform decisions and all backup
 * validation, import, export and base64 code are the production implementation. */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { before, test } = require('node:test')
const esbuild = require('esbuild')
const fake = require('fake-indexeddb')
const root = path.join(__dirname, '..')
let bundle
before(async () => {
  bundle = (await esbuild.build({
    stdin: { contents: `export * from './lib/full-backup'; export * from './lib/identity';
      export * from './lib/storage'; export * from './lib/save-download'; export * from './native/shared/bridge';`, resolveDir: root },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'Harness',
    plugins: [{ name: 'scaled-byte-boundaries', setup(build) {
      build.onLoad({ filter: /\/(?:full-backup|save-download)\.ts$/ }, async ({ path: filename }) => {
        const source = await fs.readFile(filename, 'utf8')
        const original = filename.endsWith('/full-backup.ts') ? '100 * 1024 * 1024' : '64 * 1024 ** 2'
        assert(source.includes(original), 'test must scale the actual production byte ceiling')
        return { contents: source.replace(original, filename.endsWith('/full-backup.ts') ? '100 * 1024' : '64 * 1024'), loader: 'ts' }
      })
    } }],
  })).outputFiles[0].text
})
function harness(platform) {
  const saved = new Map(), downloads = []
  const localStorage = { getItem: key => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, String(value)), removeItem: key => saved.delete(key) }
  const window = new EventTarget()
  if (platform) window.serotineNative = { platform: platform === 'win32' || platform === 'darwin' ? 'desktop' : platform,
    saveFile: async value => { downloads.push(value); return { saved: true } } }
  const values = { ...fake, indexedDB: new fake.IDBFactory(), localStorage, window, navigator: {}, BroadcastChannel: undefined }
  delete values.default
  const api = new Function(...Object.keys(values), bundle + ';return Harness;')(...Object.values(values))
  if (platform) api.setNativeInfo({ platform, version: 'test', relayOrigin: 'https://relay.example.com', backgroundSync: false })
  return { ...api, saved, downloads }
}

test('Windows exports and restores a validated full backup beyond the browser/mobile byte ceiling', async () => {
  const source = harness('win32'), identity = await source.createIdentity()
  assert.equal(source.backupFileLimit(), Infinity)
  const rows = [0, 1].map(index => ({ id: `large-${index}`, senderPubKey: identity.publicKey,
    peerPubKey: identity.publicKey, content: String(index).repeat(64000), timestamp: 123 + index, delivery: 'sent' }))
  await source.importMessagesToStorage(identity.publicKey, rows)
  const password = 'synthetic Windows backup password'
  const encrypted = await source.exportFullBackup(identity, password)
  assert(encrypted.length > source.MAX_BACKUP_FILE_BYTES)
  for (const platform of [undefined, 'android', 'ios', 'darwin']) {
    const restricted = harness(platform)
    assert.equal(restricted.backupFileLimit(), restricted.MAX_BACKUP_FILE_BYTES)
    await assert.rejects(restricted.restoreBackup(encrypted, password), /100 MiB/)
    assert.equal(restricted.saved.size, 0)
    await restricted.importMessagesToStorage(identity.publicKey, rows)
    await assert.rejects(restricted.exportFullBackup(identity, password), /too large.*100 MiB/)
  }
  const destination = harness('win32')
  await assert.rejects(destination.restoreBackup(encrypted, 'wrong password'), /password is incorrect/)
  assert.equal(destination.saved.size, 0)
  assert.deepEqual(await destination.restoreBackup(encrypted, password), identity)
  assert.deepEqual(await destination.exportAllMessagesFromStorage(identity.publicKey), rows)
})

test('Windows native download preserves bytes beyond the installed mobile export ceiling', async () => {
  const bytes = new Uint8Array(128 * 1024 + 1)
  for (let at = 0; at < bytes.length; at++) bytes[at] = at % 251
  const file = new Blob([bytes], { type: 'application/json' })
  for (const platform of ['android', 'ios', 'darwin']) {
    const restricted = harness(platform)
    await assert.rejects(restricted.saveDownload(file, 'synthetic.json'), /64 MiB/)
    assert.equal(restricted.downloads.length, 0)
  }
  const windows = harness('win32')
  assert.equal(await windows.saveDownload(file, 'synthetic.json'), true)
  assert.deepEqual(new Uint8Array(Buffer.from(windows.downloads[0].dataBase64, 'base64')), bytes)
})
