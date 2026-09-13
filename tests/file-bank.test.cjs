/* Real file-bank logic with a serialized, rollback-capable IndexedDB boundary. */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const owner = '04' + 'a'.repeat(128), otherOwner = '04' + 'b'.repeat(128)

function harness() {
  const databases = new Map(), notifications = []
  const options = { failAddAt: 0, failCommit: false, denyStorage: false }
  const openDB = async name => {
    if (options.denyStorage) throw new DOMException('Denied', 'SecurityError')
    if (!databases.has(name)) databases.set(name, { rows: new Map(), queue: Promise.resolve() })
    const database = databases.get(name)
    return {
      close() {},
      async getAll(store) { assert.equal(store, 'files'); await database.queue; return structuredClone([...database.rows.values()]) },
      async get(store, id) { assert.equal(store, 'files'); await database.queue; return structuredClone(database.rows.get(id)) },
      transaction(store, mode) {
        assert.equal(store, 'files'); assert.equal(mode, 'readwrite')
        const previous = database.queue
        let resolve, reject, staged, timer, aborted = false, adds = 0
        const done = new Promise((yes, no) => { resolve = yes; reject = no })
        database.queue = done.catch(() => {})
        const ready = previous.then(() => {
          staged = structuredClone(database.rows)
          timer = setTimeout(() => {
            if (aborted) return
            if (options.failCommit) reject(new DOMException('Disk quota reached', 'QuotaExceededError'))
            else { database.rows = staged; resolve() }
          }, 0)
        })
        return {
          store: {
            async getAll() { await ready; return structuredClone([...staged.values()]) },
            async get(id) { await ready; return structuredClone(staged.get(id)) },
            async add(row) { await ready; if (++adds === options.failAddAt) throw new Error('Write failed'); staged.set(row.id, structuredClone(row)) },
            async put(row) { await ready; staged.set(row.id, structuredClone(row)) },
            async delete(id) { await ready; staged.delete(id) },
          },
          done,
          abort() { aborted = true; clearTimeout(timer); reject(new DOMException('Transaction aborted', 'AbortError')) },
        }
      },
    }
  }
  function load() {
    const cache = new Map()
    function fromFile(filename) {
      if (cache.has(filename)) return cache.get(filename)
      const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
      const module = { exports: {} }
      new Function('require', 'module', 'exports', 'indexedDB', 'window', 'BroadcastChannel', source)(specifier => {
        if (specifier === 'idb') return { openDB }
        if (specifier.startsWith('./')) return fromFile(path.resolve(path.dirname(filename), specifier + '.ts'))
        return require(specifier)
      }, module, module.exports, {}, { dispatchEvent: event => notifications.push(event.detail) }, undefined)
      cache.set(filename, module.exports)
      return module.exports
    }
    return fromFile(path.join(__dirname, '../lib/file-bank.ts'))
  }
  return { ...load(), reload: load, options, databases, notifications }
}

test('saved files retain actual bytes and metadata after a reload and stay scoped to the identity', async () => {
  const h = harness(), bytes = new Uint8Array([71, 73, 70, 56, 57, 97, 0, 255])
  await h.saveBankFiles(owner, [new File([bytes], 'wave.gif', { type: 'image/gif', lastModified: 12345 })])
  const fresh = h.reload(), rows = await fresh.listBankFiles(owner)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].mime, 'image/gif')
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
  await assert.rejects(h.saveBankFiles(owner, [good, { size: 50 * 1024 * 1024 + 1, name: 'too-big.bin' }]), /50 MB/)
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
  const h = harness(), bytes = new Uint8Array(10 * 1024 * 1024)
  await h.saveBankFiles(owner, Array.from({ length: 5 }, (_, i) => new File([bytes], `${i}.bin`)))
  await assert.rejects(h.saveBankFiles(owner, [new File([], 'empty.txt'), new File(['a'], 'one-byte.txt')]), /50 MB/)
  const rows = await h.listBankFiles(owner)
  assert.equal(rows.length, 5)
  await h.deleteBankFile(owner, rows[0].id)
  await h.saveBankFiles(owner, [new File(['a'], 'one-byte.txt')])
  assert.equal((await h.listBankFiles(owner)).length, 5)
})

test('blocked browser storage returns an actionable error', async () => {
  const h = harness(); h.options.denyStorage = true
  await assert.rejects(h.listBankFiles(owner), /storage permissions/)
})
