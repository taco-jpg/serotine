/* Real IndexedDB migration, byte quotas, and cross-tab writes without GiB allocations. */
/* eslint-disable no-console -- This command reports smoke-test results. */
/* global Backpack -- Browser bundle exposed by this script's local test page. */
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const esbuild = require('esbuild')
const { chromium } = require('playwright')

const root = path.resolve(__dirname, '..')
const owner = '04' + 'd'.repeat(128)
const migrationOwner = '04' + 'e'.repeat(128)

async function main() {
  const bundle = (await esbuild.build({
    stdin: { contents: 'export * from "./lib/file-bank"', resolveDir: root },
    bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'Backpack',
  })).outputFiles[0].text
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', request.url === '/bank.js' ? 'text/javascript' : 'text/html')
    response.end(request.url === '/bank.js' ? bundle : '<!doctype html><title>Backpack storage checks</title><script src="/bank.js"></script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    const origin = `http://127.0.0.1:${server.address().port}`
    browser = await chromium.launch({ executablePath: process.env.SEROTINE_CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(origin)
    await page.evaluate(async ({ owner, migrationOwner }) => {
      const seed = identity => new Promise((resolve, reject) => {
        const request = indexedDB.open(`serotine-file-bank:${identity}`, 1)
        request.onupgradeneeded = () => {
          const files = request.result.createObjectStore('files', { keyPath: 'id' })
          files.add({ id: 'legacy', name: 'kept.txt', mime: 'text/plain', size: 11, createdAt: 123, lastModified: 456, blob: new Blob(['saved bytes']) })
        }
        request.onsuccess = () => { request.result.close(); resolve() }
        request.onerror = () => reject(request.error)
      })
      await seed(owner)
      await seed(migrationOwner)
      window.bankReads = []
      for (const operation of ['get', 'getAll']) {
        const original = IDBObjectStore.prototype[operation]
        IDBObjectStore.prototype[operation] = function (...args) {
          window.bankReads.push({ operation, store: this.name })
          return original.apply(this, args)
        }
      }
    }, { owner, migrationOwner })

    const migrated = await page.evaluate(async owner => {
      const metadata = await Backpack.listBankFiles(owner)
      await Backpack.renameBankFile(owner, 'legacy', 'renamed.txt')
      const readsBeforeSelection = [...window.bankReads]
      const file = await Backpack.getBankFile(owner, 'legacy')
      return { metadata, readsBeforeSelection, text: await file.text(), name: file.name, lastModified: file.lastModified }
    }, owner)
    assert.deepEqual(migrated.metadata, [{ id: 'legacy', name: 'kept.txt', mime: 'text/plain', size: 11, createdAt: 123, lastModified: 456 }])
    assert.equal(migrated.text, 'saved bytes')
    assert.equal(migrated.name, 'renamed.txt')
    assert.equal(migrated.lastModified, 456)
    assert.equal(migrated.readsBeforeSelection.some(read => read.store === 'blobs'), false)
    console.log('PASS v1 files migrate with original bytes; listing and rename do not read blobs')

    const rollback = await page.evaluate(async identity => {
      const original = IDBObjectStore.prototype.add
      IDBObjectStore.prototype.add = function (...args) {
        if (this.name === 'blobs') throw new DOMException('Disk full during migration', 'QuotaExceededError')
        return original.apply(this, args)
      }
      let error
      try { await Backpack.listBankFiles(identity) } catch (cause) { error = cause.message }
      finally { IDBObjectStore.prototype.add = original }
      const previous = await new Promise((resolve, reject) => {
        const request = indexedDB.open(`serotine-file-bank:${identity}`)
        request.onsuccess = () => {
          const db = request.result, stores = Array.from(db.objectStoreNames)
          const read = db.transaction('files').objectStore('files').get('legacy')
          read.onsuccess = async () => { resolve({ version: db.version, stores, text: await read.result.blob.text() }); db.close() }
          read.onerror = () => reject(read.error)
        }
        request.onerror = () => reject(request.error)
      })
      return { error, previous, retry: await Backpack.listBankFiles(identity) }
    }, migrationOwner)
    assert.match(rollback.error, /browser is out of storage/)
    assert.deepEqual(rollback.previous, { version: 1, stores: ['files'], text: 'saved bytes' })
    assert.equal(rollback.retry.length, 1)
    console.log('PASS interrupted migration rolls back and succeeds on retry without losing the old file')

    await page.evaluate(async owner => {
      await Backpack.deleteBankFile(owner, 'legacy')
      await new Promise((resolve, reject) => {
        const request = indexedDB.open(`serotine-file-bank:${owner}`, 2)
        request.onsuccess = () => {
          const db = request.result, tx = db.transaction(['metadata', 'blobs'], 'readwrite')
          // Only accounting metadata is large; actual bytes remain tiny.
          for (let index = 0; index < 5; index++) {
            const id = `reserved-${index}`
            tx.objectStore('metadata').add({ id, name: `${id}.bin`, mime: 'application/octet-stream', size: 1024 ** 3 - (index === 4 ? 1 : 0), createdAt: index, lastModified: index })
            tx.objectStore('blobs').add({ id, blob: new Blob(['x']) })
          }
          tx.oncomplete = () => { db.close(); resolve() }
          tx.onabort = () => reject(tx.error)
        }
        request.onerror = () => reject(request.error)
      })
    }, owner)
    const second = await context.newPage()
    await second.goto(origin)
    const writes = await Promise.allSettled([page, second].map((tab, index) => tab.evaluate(async ({ owner, index }) => {
      await Backpack.saveBankFiles(owner, [new File(['a'], `${index}.txt`)])
    }, { owner, index })))
    assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1)
    assert.match(writes.find(result => result.status === 'rejected').reason.message, /5 GB/)
    const final = await page.evaluate(async owner => {
      const rows = await Backpack.listBankFiles(owner)
      return { count: rows.length, size: rows.reduce((sum, row) => sum + row.size, 0), hasBlob: rows.some(row => 'blob' in row) }
    }, owner)
    assert.deepEqual(final, { count: 6, size: 5 * 1024 ** 3, hasBlob: false })
    console.log('PASS two actual tabs serialize their writes at exactly 5 GiB; excess batch rolls back')
  } finally {
    await browser?.close()
    await new Promise(resolve => server.close(resolve))
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
