const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../lib/retry-messages.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const source = { exports: {} }
new Function('module', 'exports', compiled)(source, source.exports)
const { retryMessageBatch } = source.exports
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const message = (id, timestamp) => ({ id, timestamp, content: `Original ${id}`, delivery: 'failed' })

test('retries only the original snapshot, in chronological order, one at a time with original IDs', async () => {
  const first = message('first', 1), second = message('second', 2), third = message('third', 3)
  const queue = [third, first, second], attempts = [], starts = []
  const pending = [deferred(), deferred(), deferred()]
  const task = retryMessageBatch(queue, async (content, item) => {
    attempts.push({ content, item })
    await pending[attempts.length - 1].promise
  }, () => true, (item, index) => starts.push([item.id, index]))
  queue.push(message('added-later', 4))
  assert.deepEqual(attempts, [{ content: first.content, item: first }])
  assert.strictEqual(attempts[0].item, first)
  pending[0].resolve()
  await new Promise(setImmediate)
  assert.deepEqual(attempts.map(attempt => attempt.item.id), ['first', 'second'])
  pending[1].resolve()
  await new Promise(setImmediate)
  assert.deepEqual(attempts.map(attempt => attempt.item.id), ['first', 'second', 'third'])
  pending[2].resolve()
  assert.deepEqual(await task, { status: 'complete', completed: 3 })
  assert.deepEqual(attempts, [first, second, third].map(item => ({ content: item.content, item })))
  assert.deepEqual(starts, [['first', 0], ['second', 1], ['third', 2]])
  assert.deepEqual(queue.map(item => item.id), ['third', 'first', 'second', 'added-later'])
})

test('stops at the first rejected send and retains the cause and completed count', async () => {
  const failure = new Error('Relay could not confirm delivery'), attempts = []
  const result = await retryMessageBatch([message('a', 1), message('b', 2), message('c', 3)], async (_content, item) => {
    attempts.push(item.id)
    if (item.id === 'b') throw failure
  }, () => true, () => {})
  assert.deepEqual(attempts, ['a', 'b'])
  assert.deepEqual(result, { status: 'failed', completed: 1, error: failure })
})

test('navigation or unmount during a send cancels remaining retries and progress updates', async () => {
  let active = true
  const pending = deferred(), attempts = [], progress = []
  const task = retryMessageBatch([message('a', 1), message('b', 2)], async (_content, item) => {
    attempts.push(item.id)
    await pending.promise
  }, () => active, item => progress.push(item.id))
  active = false
  pending.resolve()
  assert.deepEqual(await task, { status: 'cancelled', completed: 1 })
  assert.deepEqual(attempts, ['a'])
  assert.deepEqual(progress, ['a'])
})

test('a stale conversation starts no retries and does not report a late failure', async () => {
  const mustNotRun = () => assert.fail('The cancelled batch must not start')
  assert.deepEqual(await retryMessageBatch([message('a', 1)], mustNotRun, () => false, mustNotRun), { status: 'cancelled', completed: 0 })
  let active = true
  const pending = deferred()
  const task = retryMessageBatch([message('a', 1)], () => pending.promise, () => active, () => {})
  active = false
  pending.reject(new Error('Late error from the previous conversation'))
  assert.deepEqual(await task, { status: 'cancelled', completed: 0 })
})
