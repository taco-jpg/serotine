const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const http = require('node:http')
const { chromium } = require('playwright')

async function run() {
  const directory = path.resolve(__dirname, '../native/web/dist')
  let snapshot = null, writes = 0
  const errors = []
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      const relative = pathname === '/' || pathname.startsWith('/chat') || pathname === '/login' ? 'index.html' : pathname.slice(1)
      const filename = path.resolve(directory, relative)
      if (!filename.startsWith(directory + path.sep)) { response.writeHead(403).end(); return }
      response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' })[path.extname(filename)] || 'application/octet-stream')
      response.end(await fs.readFile(filename))
    } catch { response.writeHead(404).end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  let browser
  async function open(width = 1280) {
    const context = await browser.newContext({ viewport: { width, height: 800 } })
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    await context.exposeFunction('readNativeSnapshot', () => snapshot)
    await context.exposeFunction('writeNativeSnapshot', value => { snapshot = value; writes++ })
    await context.addInitScript(() => {
      window.serotineNative = {
        platform: 'test', getInfo: async () => ({ platform: 'test', version: '0.1.0', relayOrigin: 'https://relay.example.com', backgroundSync: false }),
        readSnapshot: () => window.readNativeSnapshot(), writeSnapshot: ({ value }) => window.writeNativeSnapshot(value),
        request: async () => ({ status: 503, headers: { 'content-type': 'application/json' }, bodyBase64: btoa(JSON.stringify({ success: false, error: 'Offline test relay.' })) }),
        saveFile: async () => ({ saved: true }), openBackup: async () => null, openExternal: async () => {}, onResume: () => () => {},
      }
    })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(origin)
    return { context, page }
  }
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
    let { context, page } = await open()
    await page.getByRole('button', { name: 'Create my identity' }).click()
    await page.getByRole('main').getByRole('link', { name: 'Message yourself', exact: true }).waitFor()
    assert(writes > 1 && snapshot.includes('serotine_identity'), 'Created identity must be in native persisted snapshot')
    const publicKey = await page.evaluate(() => JSON.parse(localStorage.getItem('serotine_identity_v2')).publicKey)
    await page.getByRole('main').getByRole('link', { name: 'Message yourself', exact: true }).click()
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Native durable offline smoke')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByRole('region', { name: 'Conversation messages', exact: true }).getByText('Native durable offline smoke', { exact: true }).waitFor()
    await page.waitForFunction(async () => (await window.readNativeSnapshot())?.includes('Native durable offline smoke'), undefined, { timeout: 10000 })
    assert(snapshot.includes('Native durable offline smoke'), 'Message must be in native snapshot before next process')
    await context.close()
    // New browser context has NO WebView storage: native envelope is authoritative.
    ;({ context, page } = await open(390))
    await page.getByRole('button', { name: 'Open messages', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('serotine_identity_v2')).publicKey), publicKey)
    await page.getByRole('button', { name: 'Open messages', exact: true }).click()
    await page.getByRole('region', { name: 'Conversation messages', exact: true }).getByText('Native durable offline smoke', { exact: true }).waitFor()
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Native narrow layout must fit viewport')
    await context.close()
    // A restored legacy database can upgrade while a settings save enumerates
    // it. Exercise the bundled persistence code with real Chromium IndexedDB.
    ;({ context, page } = await open())
    await page.getByRole('button', { name: 'Open messages', exact: true }).waitFor()
    const migrationName = `serotine-file-bank:04${'c'.repeat(128)}`
    await page.evaluate(async name => {
      const open = version => new Promise((resolve, reject) => {
        const request = indexedDB.open(name, version)
        request.onupgradeneeded = () => {
          const db = request.result
          if (version === 1) db.createObjectStore('files', { keyPath: 'id' })
          else {
            const metadata = db.createObjectStore('metadata', { keyPath: 'id' })
            const blobs = db.createObjectStore('blobs', { keyPath: 'id' })
            const row = request.transaction.objectStore('files').get('migration-fixture')
            row.onsuccess = () => {
              const { blob, ...entry } = row.result
              metadata.add(entry); blobs.add({ id: entry.id, blob })
              db.deleteObjectStore('files')
            }
          }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const legacy = await open(1)
      const tx = legacy.transaction('files', 'readwrite')
      const done = new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) })
      const blob = new Blob(['preserved through upgrade'], { type: 'text/plain' })
      tx.objectStore('files').add({ id: 'migration-fixture', name: 'migration.txt', mime: blob.type,
        size: blob.size, createdAt: 123, lastModified: 123, blob })
      await done; legacy.close()
      const enumerate = indexedDB.databases.bind(indexedDB)
      indexedDB.databases = async () => {
        const stale = await enumerate()
        indexedDB.databases = enumerate
        const upgraded = await open(2)
        upgraded.close()
        return stale
      }
      localStorage.setItem('serotine:migration-smoke', 'capture must survive upgrade')
    }, migrationName)
    await page.waitForFunction(async name => {
      const value = JSON.parse(await window.readNativeSnapshot())
      return value.databases.some(db => db.name === name && db.version === 2)
        && value.local.some(([key]) => key === 'serotine:migration-smoke')
    }, migrationName, { timeout: 10000 })
    assert.equal(await page.locator('[data-native-error-code]').count(), 0, 'A concurrent upgrade must not freeze the app')
    await context.close()
    ;({ context, page } = await open())
    await page.getByRole('button', { name: 'Open messages', exact: true }).waitFor()
    assert.equal(await page.evaluate(name => new Promise((resolve, reject) => {
      const opening = indexedDB.open(name)
      opening.onerror = () => reject(opening.error)
      opening.onsuccess = () => {
        const db = opening.result, tx = db.transaction('blobs', 'readonly')
        const row = tx.objectStore('blobs').get('migration-fixture')
        row.onerror = () => reject(row.error)
        row.onsuccess = () => { db.close(); row.result.blob.text().then(resolve, reject) }
      }
    }), migrationName), 'preserved through upgrade', 'Migrated file bytes must survive fresh-WebView restore')
    await context.close()
    const good = snapshot
    snapshot = '{corrupt'
    ;({ context, page } = await open())
    await page.getByRole('heading', { name: 'Serotine could not open its saved data.' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Create my identity' }).count(), 0)
    assert.equal(snapshot, '{corrupt', 'Corrupt native data must never be silently replaced')
    await context.close()
    snapshot = good
    assert.deepEqual(errors, [])
    process.stdout.write('Native renderer smoke passed: identity durability, message persistence, fresh-WebView restore, concurrent database upgrade with preserved file bytes, narrow layout, and corrupt-data fail-closed startup.\n')
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
