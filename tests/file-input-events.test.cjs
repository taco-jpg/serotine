const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const ts = require('typescript')

const compiled = ts.transpileModule(fs.readFileSync(require.resolve('../components/chat/file-input-events.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const loaded = { exports: {} }
new Function('exports', compiled)(loaded.exports)
const { bindFileInputEvents, filesFromTransfer } = loaded.exports

const file = name => new File(['test'], name)
const transfer = files => ({ files, types: ['Files'], dropEffect: '' })
function dispatch(target, type, data) {
  const event = new Event(type, { cancelable: true })
  Object.assign(event, data)
  target.dispatchEvent(event)
  return event
}
function harness() {
  const chat = new EventTarget(), composer = new EventTarget(), accepted = [], dragging = []
  let enabled = true, unavailable = 0
  const cleanup = bindFileInputEvents(chat, composer, {
    canAccept: () => enabled,
    onFiles: files => accepted.push(files),
    onDragging: active => dragging.push(active),
    onUnavailable: () => unavailable++,
  })
  return { chat, composer, accepted, dragging, cleanup, disable: () => { enabled = false }, get unavailable() { return unavailable } }
}

test('chat-wide drop stages every file and nested drag leaves keep feedback active', () => {
  const h = harness(), files = [file('one.txt'), file('two.txt')], dataTransfer = transfer(files)
  dispatch(h.chat, 'dragenter', { dataTransfer })
  dispatch(h.chat, 'dragenter', { dataTransfer })
  dispatch(h.chat, 'dragleave', { dataTransfer })
  assert.equal(h.dragging.at(-1), true)
  assert.equal(dispatch(h.chat, 'dragover', { dataTransfer }).defaultPrevented, true)
  assert.equal(dataTransfer.dropEffect, 'copy')
  assert.deepEqual(h.accepted, [])
  assert.equal(dispatch(h.chat, 'drop', { dataTransfer }).defaultPrevented, true)
  assert.deepEqual(h.accepted, [files])
  assert.equal(h.dragging.at(-1), false)
  h.cleanup()
})

test('clipboard files are scoped to the message box and ordinary text remains editable', () => {
  const h = harness(), files = [file('clipboard.png')]
  assert.equal(dispatch(h.composer, 'paste', { clipboardData: { files: [], items: [{ kind: 'string' }] } }).defaultPrevented, false)
  dispatch(h.chat, 'paste', { clipboardData: transfer(files) })
  assert.deepEqual(h.accepted, [])
  const clipboardData = { files: [], items: [{ kind: 'string' }, { kind: 'file', getAsFile: () => files[0] }, { kind: 'file', getAsFile: () => null }] }
  assert.equal(dispatch(h.composer, 'paste', { clipboardData }).defaultPrevented, true)
  assert.deepEqual(h.accepted, [files])
  assert.deepEqual(filesFromTransfer(transfer(files)), files)
  h.cleanup()
})

test('unavailable drop and paste never navigate away or overwrite pending files', () => {
  const h = harness(), dataTransfer = transfer([file('blocked.txt')])
  h.disable()
  dispatch(h.chat, 'dragenter', { dataTransfer })
  dispatch(h.chat, 'dragover', { dataTransfer })
  assert.equal(dataTransfer.dropEffect, 'none')
  assert.equal(h.dragging.at(-1), false)
  assert.equal(dispatch(h.chat, 'drop', { dataTransfer }).defaultPrevented, true)
  assert.equal(dispatch(h.composer, 'paste', { clipboardData: dataTransfer }).defaultPrevented, true)
  assert.deepEqual(h.accepted, [])
  assert.equal(h.unavailable, 2)
  h.cleanup()
})

test('text dragging stays native and conversation cleanup removes all handlers', () => {
  const h = harness(), dataTransfer = { files: [], types: ['text/plain'] }
  assert.equal(dispatch(h.chat, 'dragover', { dataTransfer }).defaultPrevented, false)
  assert.equal(dispatch(h.chat, 'drop', { dataTransfer }).defaultPrevented, false)
  h.cleanup()
  const files = transfer([file('gone.txt')])
  assert.equal(dispatch(h.chat, 'drop', { dataTransfer: files }).defaultPrevented, false)
  assert.equal(dispatch(h.composer, 'paste', { clipboardData: files }).defaultPrevented, false)
  assert.deepEqual(h.accepted, [])
})
