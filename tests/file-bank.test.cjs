/* Real file-bank logic with a serialized, rollback-capable IndexedDB boundary. */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const owner = '04' + 'a'.repeat(128), otherOwner = '04' + 'b'.repeat(128)

function harness() {
  const databases = new Map(), notifications = [], reads = [], navigator = { userActivation: { isActive: true } }
  const options = { failAddAt: 0, failCommit: false, denyStorage: false }
  function connection(database) {
    let upgrading
    const db = {
      close() {},
      createObjectStore(name) { assert(upgrading); upgrading.stores.set(name, new Map()); return upgrading.tx.objectStore(name) },
      deleteObjectStore(name) { assert(upgrading); upgrading.stores.delete(name) },
      async getAll(store) { reads.push(['getAll', store]); await database.queue; return structuredClone([...database.stores.get(store).values()]) },
      transaction(stores, mode) {
        assert(['readwrite', 'readonly', 'versionchange'].includes(mode))
        const previous = database.queue
        let resolve, reject, staged, timer, aborted = false, adds = 0
        const done = new Promise((yes, no) => { resolve = yes; reject = no })
        database.queue = done.catch(() => {})
        const schedule = () => {
          clearTimeout(timer)
          timer = setTimeout(() => {
            if (aborted) return
            if (options.failCommit && mode !== 'readonly') reject(new DOMException('Disk quota reached', 'QuotaExceededError'))
            else { database.stores = staged; resolve() }
          }, 0)
        }
        const ready = previous.then(() => {
          staged = structuredClone(database.stores)
          if (mode === 'versionchange') upgrading = { stores: staged, tx }
          schedule()
        })
        const tx = {
          objectStore(store) {
            if (mode !== 'versionchange') assert(stores.includes(store))
            const rows = async () => { await ready; schedule(); assert(staged.has(store)); return staged.get(store) }
            return {
              async getAll() { reads.push(['getAll', store]); return structuredClone([...(await rows()).values()]) },
              async get(id) { reads.push(['get', store]); return structuredClone((await rows()).get(id)) },
              async add(row) {
                const entries = await rows()
                if (++adds === options.failAddAt) throw new Error('Write failed')
                assert(!entries.has(row.id)); entries.set(row.id, structuredClone(row))
              },
              async put(row) { (await rows()).set(row.id, structuredClone(row)) },
              async delete(id) { (await rows()).delete(id) },
              async openCursor() {
                const entries = [...(await rows()).values()]
                const cursor = index => index === entries.length ? null : {
                  value: structuredClone(entries[index]),
                  async continue() { await rows(); return cursor(index + 1) },
                }
                return cursor(0)
              },
            }
          },
          done, ready,
          abort() { aborted = true; clearTimeout(timer); reject(new DOMException('Transaction aborted', 'AbortError')) },
        }
        return tx
      }
    }
    return db
  }
  const openDB = async (name, version, callbacks) => {
    if (options.denyStorage) throw new DOMException('Denied', 'SecurityError')
    if (!databases.has(name)) databases.set(name, { stores: new Map(), version: 0, queue: Promise.resolve() })
    const database = databases.get(name), db = connection(database)
    await database.queue
    if (database.version < version) {
      const tx = db.transaction([...database.stores.keys()], 'versionchange')
      await tx.ready
      callbacks.upgrade(db, database.version, version, tx)
      await tx.done
      database.version = version
    }
    return db
  }
  function load() {
    const cache = new Map()
    function fromFile(filename) {
      if (cache.has(filename)) return cache.get(filename)
      const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
      const module = { exports: {} }
      new Function('require', 'module', 'exports', 'indexedDB', 'window', 'BroadcastChannel', 'navigator', source)(specifier => {
        if (specifier === 'idb') return { openDB }
        if (specifier.startsWith('./')) return fromFile(path.resolve(path.dirname(filename), specifier + '.ts'))
        return require(specifier)
      }, module, module.exports, {}, { dispatchEvent: event => notifications.push(event.detail) }, undefined, navigator)
      cache.set(filename, module.exports)
      return module.exports
    }
    return fromFile(path.join(__dirname, '../lib/file-bank.ts'))
  }
  function seedMetadata(rows) {
    const database = databases.get(`serotine-file-bank:${owner}`)
    for (const row of rows) {
      database.stores.get('metadata').set(row.id, row)
      database.stores.get('blobs').set(row.id, { id: row.id, blob: new Blob(['x']) })
    }
  }
  function seedLegacy(rows) {
    databases.set(`serotine-file-bank:${owner}`, { version: 1, stores: new Map([['files', new Map(rows.map(row => [row.id, row]))]]), queue: Promise.resolve() })
  }
  return { ...load(), reload: load, options, databases, notifications, reads, navigator, seedMetadata, seedLegacy }
}

test('saved files retain actual bytes and metadata after a reload and stay scoped to the identity', async () => {
  const h = harness(), bytes = new Uint8Array([71, 73, 70, 56, 57, 97, 0, 255])
  await h.saveBankFiles(owner, [new File([bytes], 'wave.gif', { type: 'image/gif', lastModified: 12345 })])
  const fresh = h.reload(), rows = await fresh.listBankFiles(owner)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].mime, 'image/gif')
  assert.equal('blob' in rows[0], false)
  const file = await fresh.getBankFile(owner, rows[0].id)
  assert.equal(file.name, 'wave.gif'); assert.equal(file.lastModified, 12345)
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), bytes)
  assert.equal((await fresh.listBankFiles(otherOwner)).length, 0)
  await assert.rejects(fresh.getBankFile(otherOwner, rows[0].id), /removed/)
  await assert.rejects(fresh.listBankFiles('invalid-owner'), /identity/)
  assert.equal(h.notifications.length, 1)
  assert.deepEqual(Object.keys(h.notifications[0]).sort(), ['owner', 'source'])
})

test('rename preserves content, normalizes unsafe filenames, and deletion is identity-scoped', async () => {
  const h = harness()
  await h.saveBankFiles(owner, [new File(['hello'], '../first.txt', { type: 'text/plain' })])
  const [row] = await h.listBankFiles(owner)
  assert.equal(row.name, 'first.txt')
  await h.renameBankFile(owner, row.id, '../renamed\u202e.txt')
  const file = await h.getBankFile(owner, row.id)
  assert.equal(file.name, 'renamed_.txt'); assert.equal(await file.text(), 'hello')
  await assert.rejects(h.renameBankFile(owner, row.id, '  '), /Enter a name/)
  await assert.rejects(h.renameBankFile(otherOwner, row.id, 'another.txt'), /removed/)
  await h.deleteBankFile(otherOwner, row.id)
  assert.equal((await h.listBankFiles(owner)).length, 1)
  await h.deleteBankFile(owner, row.id)
  assert.equal((await h.listBankFiles(owner)).length, 0)
})

test('invalid batches and failed writes never leave partial saved files', async () => {
  const h = harness(), good = new File(['keep me'], 'good.txt')
  await assert.rejects(h.saveBankFiles(owner, [good, { size: 1024 ** 3 + 1, name: 'too-big.bin' }]), /1 GB|1.0 GB/)
  assert.equal(h.databases.size, 0)
  h.options.failAddAt = 2
  await assert.rejects(h.saveBankFiles(owner, [good, new File(['other'], 'other.txt')]), /Write failed/)
  assert.equal((await h.listBankFiles(owner)).length, 0)
  assert.equal(h.notifications.length, 0)
  h.options.failAddAt = 0
  h.options.failCommit = true
  await assert.rejects(h.saveBankFiles(owner, [good]), /out of storage/)
  assert.equal((await h.listBankFiles(owner)).length, 0)
  assert.equal(h.notifications.length, 0)
})

test('concurrent writers cannot exceed the per-identity file count', async () => {
  const h = harness()
  await h.saveBankFiles(owner, Array.from({ length: 99 }, (_, i) => new File(['a'], `${i}.txt`)))
  const writes = await Promise.allSettled([
    h.saveBankFiles(owner, [new File(['b'], 'racing-tab-a.txt')]),
    h.saveBankFiles(owner, [new File(['c'], 'racing-tab-b.txt')]),
  ])
  assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1)
  assert.match(writes.find(result => result.status === 'rejected').reason.message, /100 files/)
  assert.equal((await h.listBankFiles(owner)).length, 100)
})

test('the byte quota rejects the whole batch and deleting a file frees capacity', async () => {
  const h = harness()
  assert.equal(h.BANK_MAX_BYTES, 5 * 1024 ** 3)
  await h.listBankFiles(owner)
  // Exercise exact 5 GiB accounting without allocating multi-gigabyte test data.
  h.seedMetadata(Array.from({ length: 5 }, (_, i) => ({ id: `big-${i}`, name: `${i}.bin`, mime: 'application/octet-stream', size: 1024 ** 3, createdAt: i, lastModified: i })))
  await assert.rejects(h.saveBankFiles(owner, [new File([], 'empty.txt'), new File(['a'], 'one-byte.txt')]), /5 GB/)
  const rows = await h.listBankFiles(owner)
  assert.equal(rows.length, 5)
  await h.deleteBankFile(owner, rows[0].id)
  await h.saveBankFiles(owner, [new File(['a'], 'one-byte.txt')])
  assert.equal((await h.listBankFiles(owner)).length, 5)
  assert.equal(h.databases.get(`serotine-file-bank:${owner}`).stores.get('blobs').size, 5)
})

test('concurrent tabs cannot exceed the exact byte quota, and listing or renaming never loads blobs', async () => {
  const h = harness()
  await h.listBankFiles(owner)
  h.seedMetadata([{ id: 'almost-full', name: 'reserved.bin', mime: 'application/octet-stream', size: h.BANK_MAX_BYTES - 1, createdAt: 1, lastModified: 1 }])
  const writes = await Promise.allSettled([
    h.saveBankFiles(owner, [new File(['a'], 'one.txt')]),
    h.reload().saveBankFiles(owner, [new File(['b'], 'two.txt')]),
  ])
  assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1)
  assert.match(writes.find(result => result.status === 'rejected').reason.message, /5 GB/)
  const rows = await h.listBankFiles(owner)
  assert.equal(rows.reduce((sum, row) => sum + row.size, 0), h.BANK_MAX_BYTES)
  await h.renameBankFile(owner, rows[0].id, 'renamed.txt')
  assert.equal(h.reads.some(([, store]) => store === 'blobs'), false)
})

test('v1 migration preserves every file and failed migrations leave the original store intact', async () => {
  const h = harness(), row = { id: 'legacy', name: 'old.txt', mime: 'text/plain', size: 5, createdAt: 100, lastModified: 200, blob: new Blob(['hello']) }
  h.seedLegacy([row])
  h.options.failAddAt = 2
  await assert.rejects(h.listBankFiles(owner), /Write failed/)
  let database = h.databases.get(`serotine-file-bank:${owner}`)
  assert.equal(database.version, 1)
  assert.deepEqual([...database.stores.keys()], ['files'])
  assert.equal(await database.stores.get('files').get('legacy').blob.text(), 'hello')
  h.options.failAddAt = 0
  assert.deepEqual(await h.listBankFiles(owner), [{ id: 'legacy', name: 'old.txt', mime: 'text/plain', size: 5, createdAt: 100, lastModified: 200 }])
  assert.equal(await (await h.getBankFile(owner, 'legacy')).text(), 'hello')
  database = h.databases.get(`serotine-file-bank:${owner}`)
  assert.equal(database.version, 2)
  assert.deepEqual([...database.stores.keys()].sort(), ['blobs', 'metadata'])
})

test('storage estimates are advisory and persistence is requested only on a save gesture', async () => {
  const h = harness()
  let persistenceCalls = 0
  h.navigator.storage = {
    async estimate() { return { quota: 4000, usage: 3000 } },
    async persist() { persistenceCalls++; throw new Error('Not granted') },
  }
  assert.equal(await h.estimateBankStorage(), 1000)
  await h.listBankFiles(owner)
  assert.equal(persistenceCalls, 0)
  await h.saveBankFiles(owner, [new File(['a'], 'first.txt')])
  await h.saveBankFiles(owner, [new File(['b'], 'second.txt')])
  assert.equal(persistenceCalls, 1)
  assert.equal((await h.listBankFiles(owner)).length, 2)
  h.navigator.storage.estimate = async () => { throw new Error('Unsupported') }
  assert.equal(await h.estimateBankStorage(), undefined)
  h.navigator.userActivation.isActive = false
  await h.reload().saveBankFiles(owner, [new File(['c'], 'background.txt')])
  assert.equal(persistenceCalls, 1)
})

test('blocked browser storage returns an actionable error', async () => {
  const h = harness(); h.options.denyStorage = true
  await assert.rejects(h.listBankFiles(owner), /storage permissions/)
})
