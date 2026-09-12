/* Actual storage logic with a controlled IndexedDB transaction boundary. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')
const owner = '04' + 'a'.repeat(128), peer = '04' + 'b'.repeat(128)
function harness() {
  const rows = new Map(), notifications = [], options = { failCommit: false }, local = new Map(), opened = []
  let queue = Promise.resolve()
  const openDB = async name => { opened.push(name); return {
    close() {},
    objectStoreNames: { contains: store => store === 'messages' },
    transaction(store, mode) {
      assert.equal(store, 'messages'); assert.equal(mode, 'readwrite')
      const previous = queue
      let resolve, reject
      const completion = new Promise((yes, no) => { resolve = yes; reject = no })
      queue = completion.catch(() => {})
      const staged = new Map(), removed = new Set()
      const key = parts => name + ':' + JSON.stringify(parts)
      return {
        store: {
          async get(parts) { await previous; return structuredClone(staged.get(key(parts)) ?? rows.get(key(parts))) },
          async put(row) { await previous; staged.set(key([row.peerPubKey, row.senderPubKey, row.id]), structuredClone(row)) },
          async delete(parts) { await previous; removed.add(key(parts)) },
          async openCursor() {
            await previous
            const entries = [...rows].filter(([key]) => key.startsWith(name + ':'))
            const at = index => index >= entries.length ? null : {
              value: structuredClone(entries[index][1]),
              async delete() { removed.add(entries[index][0]) },
              async continue() { return at(index + 1) },
            }
            return at(0)
          },
          index(index) {
            assert.equal(index, 'by-peer')
            return { async getAll(peerPubKey) {
              await previous
              return structuredClone([...rows].filter(([key, row]) => key.startsWith(name + ':') && row.peerPubKey === peerPubKey).map(([, row]) => row))
            } }
          },
        },
        get done() {
          if (options.failCommit) reject(new Error('Transaction aborted'))
          else {
            for (const key of removed) rows.delete(key)
            for (const [key, row] of staged) rows.set(key, row)
            resolve()
          }
          return completion
        },
      }
    },
  } }
  const filename = path.join(__dirname, '../lib/storage.ts')
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'localStorage', source)(name => name === 'idb' ? { openDB } : { notifyHistoryChanged: (...args) => notifications.push(args) }, module, module.exports, { getItem: key => local.get(key) ?? null })
  return { ...module.exports, rows, options, notifications, local, opened }
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

test('retries retain the original file bytes, names, types and order', async () => {
  const h = harness()
  const original = { ...message('failed'), attachments: [
    { name: 'homework.pdf', type: 'application/pdf', size: 3, data: 'AAEC' },
    { name: 'notes.txt', type: 'text/plain', size: 1, data: 'YQ==' },
  ] }
  await h.saveMessageToStorage(owner, original)
  const pending = await h.saveMessageToStorage(owner, { ...original, content: 'Edited', timestamp: original.timestamp + 1,
    attachments: [{ name: 'replacement.txt', type: 'text/plain', size: 1, data: 'Yg==' }], delivery: 'pending' })
  assert.deepEqual(pending.attachments, original.attachments)
  assert.equal(pending.content, original.content)
  assert.equal(pending.timestamp, original.timestamp)
  const sent = await h.saveMessageToStorage(owner, { ...pending, attachments: undefined, delivery: 'sent' })
  assert.deepEqual(sent.attachments, original.attachments)
  assert.equal(sent.delivery, 'sent')
})

test('a text-only stable ID cannot acquire files from a later retry', async () => {
  const h = harness(), original = message('failed')
  await h.saveMessageToStorage(owner, original)
  const retry = await h.saveMessageToStorage(owner, { ...original, delivery: 'pending',
    attachments: [{ name: 'late.txt', type: 'text/plain', size: 1, data: 'YQ==' }] })
  assert.equal(retry.attachments, undefined)
  assert.equal([...h.rows.values()][0].attachments, undefined)
})

test('duplicate receives racing across tabs cannot replace the first saved attachment', async () => {
  const h = harness(), original = { ...message('received'), senderPubKey: peer,
    attachments: [{ name: 'original.txt', type: 'text/plain', size: 1, data: 'YQ==' }] }
  const [, duplicate] = await Promise.all([
    h.saveMessageToStorage(owner, original),
    h.saveMessageToStorage(owner, { ...original, attachments: [{ name: 'altered.txt', type: 'text/plain', size: 1, data: 'Yg==' }] }),
  ])
  assert.deepEqual(duplicate.attachments, original.attachments)
  assert.equal(h.rows.size, 1)
})

test('deleting a conversation removes both directions and inline files only for that owner and peer', async () => {
  const h = harness(), other = '04' + 'c'.repeat(128)
  const sent = { ...message('sent'), attachments: [{ name: 'private.txt', type: 'text/plain', size: 1, data: 'YQ==' }] }
  const received = { ...message('received'), senderPubKey: peer }
  const unrelated = { ...message('sent'), peerPubKey: other }
  await h.saveMessageToStorage(owner, sent)
  await h.saveMessageToStorage(owner, received)
  await h.saveMessageToStorage(owner, unrelated)
  await h.saveMessageToStorage(other, sent)
  h.notifications.length = 0
  await h.deleteConversationHistoryFromStorage(owner, peer)
  assert.equal(h.rows.size, 2)
  assert.deepEqual([...h.rows.values()], [unrelated, sent])
  assert.deepEqual(h.notifications, [[owner, peer]])
})

test('restoring a deletion removes legacy files through its cutoff while preserving newer messages', async () => {
  const h = harness(), old = { ...message('sent'), timestamp: 100, attachments: [{ name: 'old.txt', type: 'text/plain', size: 1, data: 'YQ==' }] }
  const fresh = { ...message('sent'), timestamp: 101 }
  await h.saveMessageToStorage(owner, old)
  await h.saveMessageToStorage(owner, fresh)
  await h.deleteConversationHistoryFromStorage(owner, peer, 100)
  assert.deepEqual([...h.rows.values()], [fresh])
})

test('a failed deletion commit keeps the history intact and emits no change notification', async () => {
  const h = harness(), original = message('sent')
  await h.saveMessageToStorage(owner, original)
  h.notifications.length = 0; h.options.failCommit = true
  await assert.rejects(h.deleteConversationHistoryFromStorage(owner, peer), /aborted/)
  assert.deepEqual([...h.rows.values()], [original])
  assert.deepEqual(h.notifications, [])
})

test('only the migration owner can remove matching old shared history and attachment bytes', async () => {
  const h = harness(), other = '04' + 'c'.repeat(128)
  const original = { ...message('sent'), timestamp: 100, attachments: [{ name: 'old.txt', type: 'text/plain', size: 1, data: 'YQ==' }] }
  const received = { ...message('received'), senderPubKey: peer, peerPubKey: owner, timestamp: 100 }
  const fresh = { ...message('sent'), timestamp: 101 }
  const unrelated = { ...message('sent'), peerPubKey: other, timestamp: 100 }
  for (const row of [original, received, fresh, unrelated]) h.rows.set('chat-storage:' + JSON.stringify(row.id), row)
  await h.deleteConversationHistoryFromStorage(owner, peer, 100)
  assert.equal(h.opened.includes('chat-storage'), false)
  h.local.set('serotine_legacy_history_owner', other)
  await h.deleteConversationHistoryFromStorage(owner, peer, 100)
  assert.equal(h.opened.includes('chat-storage'), false)
  assert.equal(h.rows.size, 4)
  h.local.set('serotine_legacy_history_owner', owner)
  await h.deleteConversationHistoryFromStorage(owner, peer, 100)
  assert.deepEqual([...h.rows.values()], [fresh, unrelated])
})
