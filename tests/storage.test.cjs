/* Actual storage logic with a controlled IndexedDB transaction boundary. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')
const owner = '04' + 'a'.repeat(128), peer = '04' + 'b'.repeat(128)
function harness() {
  const rows = new Map(), notifications = [], options = { failCommit: false }
  let queue = Promise.resolve()
  const openDB = async name => ({
    close() {},
    transaction(store, mode) {
      assert.equal(store, 'messages'); assert.equal(mode, 'readwrite')
      const previous = queue
      let resolve, reject
      const completion = new Promise((yes, no) => { resolve = yes; reject = no })
      queue = completion.catch(() => {})
      let staged
      const key = parts => name + ':' + JSON.stringify(parts)
      return {
        store: {
          async get(parts) { await previous; return structuredClone(rows.get(key(parts))) },
          async put(row) { await previous; staged = structuredClone(row) },
        },
        get done() {
          if (options.failCommit) reject(new Error('Transaction aborted'))
          else { rows.set(key([staged.peerPubKey, staged.senderPubKey, staged.id]), staged); resolve() }
          return completion
        },
      }
    },
  })
  const filename = path.join(__dirname, '../lib/storage.ts')
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', source)(name => name === 'idb' ? { openDB } : { notifyHistoryChanged: (...args) => notifications.push(args) }, module, module.exports)
  return { ...module.exports, rows, options, notifications }
}
const message = delivery => ({ id: crypto.randomUUID(), senderPubKey: owner, peerPubKey: peer, content: 'Original message', timestamp: Date.now(), delivery })

test('a slower failed retry cannot overwrite a confirmed send in local storage', async () => {
  const h = harness(), sent = message('sent')
  const [first, second] = await Promise.all([
    h.saveMessageToStorage(owner, sent),
    h.saveMessageToStorage(owner, { ...sent, delivery: 'failed' }),
  ])
  assert.equal(first.delivery, 'sent'); assert.equal(second.delivery, 'sent')
  assert.equal([...h.rows.values()][0].delivery, 'sent')
  const stale = await h.saveMessageToStorage(owner, { ...sent, delivery: 'pending', content: 'Changed text' })
  assert.deepEqual(stale, sent)
})

test('stable message IDs retain original contents and timestamps across state updates', async () => {
  const h = harness(), failed = message('failed')
  await h.saveMessageToStorage(owner, failed)
  const retry = await h.saveMessageToStorage(owner, { ...failed, delivery: 'pending', content: 'Different', timestamp: failed.timestamp + 10 })
  assert.equal(retry.content, failed.content); assert.equal(retry.timestamp, failed.timestamp)
  assert.equal(retry.delivery, 'pending')
})

test('commit failure never reports history changes or leaves a partial row', async () => {
  const h = harness(); h.options.failCommit = true
  await assert.rejects(h.saveMessageToStorage(owner, message('pending')), /aborted/)
  assert.equal(h.notifications.length, 0); assert.equal(h.rows.size, 0)
})
