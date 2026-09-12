/* Exercise real file reading and the draft hook across navigation and remounts. */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function runtime() {
  let active
  const react = Object.fromEntries(['useState', 'useRef', 'useEffect'].map(name => [name, (...args) => active[name](...args)]))
  const events = new EventTarget(), cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file)
    const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const module = { exports: {} }
    new Function('require', 'module', 'exports', 'window', output)(specifier => specifier === 'react' ? react : load(path.join(__dirname, '..', specifier.slice(2) + '.ts')), module, module.exports, events)
    cache.set(file, module.exports)
    return module.exports
  }
  const hook = load(path.join(__dirname, '../components/use-attachment-draft.ts')).useAttachmentDraft
  return {
    events,
    mount(initialOwner = 'alice', initialPeer = 'bob') {
      const slots = [], effects = []
      let cursor = 0, owner = initialOwner, peer = initialPeer, stopped = false, lateUpdates = 0
      const hooks = {
        useState(initial) {
          const index = cursor++
          if (!(index in slots)) slots[index] = initial
          return [slots[index], value => {
            if (stopped) lateUpdates++
            slots[index] = typeof value === 'function' ? value(slots[index]) : value
          }]
        },
        useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index] },
        useEffect(effect, deps) {
          const index = cursor++, old = slots[index]
          if (!old || deps.some((value, i) => value !== old.deps[i])) {
            old?.cleanup?.()
            const next = { deps, cleanup: null }
            slots[index] = next
            effects.push(() => { next.cleanup = effect() })
          }
        },
      }
      function view() {
        active = hooks; cursor = 0
        const result = hook(owner, peer)
        while (effects.length) effects.shift()()
        return result
      }
      view()
      return {
        view,
        switchTo(nextOwner, nextPeer) { owner = nextOwner; peer = nextPeer; return view() },
        unmount() { for (const slot of slots) slot?.cleanup?.(); stopped = true },
        get lateUpdates() { return lateUpdates },
      }
    },
  }
}

const file = (name, text = 'hello') => new File([text], name, { type: 'text/plain' })

test('file drafts survive remounts and stay isolated by identity and recipient', async () => {
  const r = runtime(), h = r.mount()
  await h.view().addFiles([file('bob.txt')])
  h.switchTo('alice', 'carol')
  assert.equal(h.view().files.length, 0)
  await h.view().addFiles([file('carol.txt')])
  h.switchTo('other-owner', 'bob')
  assert.equal(h.view().files.length, 0)
  h.unmount()
  const reopened = r.mount()
  assert.deepEqual(reopened.view().files.map(item => item.attachment.name), ['bob.txt'])
  reopened.unmount()
  assert.equal(h.lateUpdates, 0)
})

test('late file reads cannot enter another conversation or update an unmounted composer', async () => {
  const r = runtime(), h = r.mount()
  let release
  const pending = h.view().addFiles([{ name: 'slow.txt', type: 'text/plain', size: 1, arrayBuffer: () => new Promise(resolve => { release = resolve }) }])
  assert.equal(h.view().preparing, true)
  h.switchTo('alice', 'carol')
  release(new Uint8Array([65]).buffer)
  await pending
  assert.equal(h.view().preparing, false)
  assert.equal(h.view().files.length, 0)
  h.switchTo('alice', 'bob')
  assert.equal(h.view().files.length, 0)
  const second = h.view().addFiles([{ name: 'slow.txt', type: 'text/plain', size: 1, arrayBuffer: () => new Promise(resolve => { release = resolve }) }])
  h.unmount()
  release(new Uint8Array([65]).buffer)
  await second
  assert.equal(h.lateUpdates, 0)
  const reopened = r.mount()
  assert.equal(reopened.view().files.length, 0)
  reopened.unmount()
})

test('persisted completion clears only submitted file IDs after remount, preserving new selections', async () => {
  const r = runtime(), h = r.mount()
  await h.view().addFiles([file('same-name.txt', 'old')])
  const finish = h.view().clearSubmittedAttachments
  h.unmount()
  const reopened = r.mount()
  await reopened.view().addFiles([file('same-name.txt', 'new')])
  finish()
  assert.equal(reopened.view().files.length, 1)
  assert.equal(atob(reopened.view().files[0].attachment.data), 'new')
  assert.equal(h.lateUpdates, 0)
  reopened.view().clearSubmittedAttachments()
  reopened.unmount()
  const empty = r.mount()
  assert.equal(empty.view().files.length, 0)
  empty.unmount()
})

test('count and combined byte limits reject whole batches without discarding existing files', async () => {
  const h = runtime().mount()
  await h.view().addFiles([file('keep.txt')])
  let reads = 0
  const oversized = { name: 'large.bin', type: '', size: 1024 * 1024, arrayBuffer: async () => { reads++; return new ArrayBuffer(1024 * 1024) } }
  await h.view().addFiles([oversized])
  assert.match(h.view().issue, /1 MiB/)
  assert.equal(reads, 0)
  await h.view().addFiles([file('1'), file('2'), file('3'), file('4')])
  assert.match(h.view().issue, /up to 4/)
  assert.deepEqual(h.view().files.map(item => item.attachment.name), ['keep.txt'])
  h.unmount()
})

test('unreadable batches retain pending selections and release the preparation lock', async () => {
  const h = runtime().mount()
  await h.view().addFiles([file('keep.txt')])
  await h.view().addFiles([file('good.txt'), { name: 'bad.txt', type: 'text/plain', size: 1, arrayBuffer: async () => { throw new Error('File access denied') } }])
  assert.match(h.view().issue, /File access denied/)
  assert.equal(h.view().preparing, false)
  assert.equal(h.view().isPreparing(), false)
  assert.deepEqual(h.view().files.map(item => item.attachment.name), ['keep.txt'])
  await h.view().addFiles([file('after.txt')])
  assert.equal(h.view().files.length, 2)
  h.unmount()
})

test('removing the last pending file releases the unload warning and memory selection', async () => {
  const r = runtime(), h = r.mount()
  await h.view().addFiles([file('draft.txt')])
  const before = new Event('beforeunload', { cancelable: true })
  r.events.dispatchEvent(before)
  assert.equal(before.defaultPrevented, true)
  h.view().removeFile(h.view().files[0].id)
  const after = new Event('beforeunload', { cancelable: true })
  r.events.dispatchEvent(after)
  assert.equal(after.defaultPrevented, false)
  h.unmount()
  const reopened = r.mount()
  assert.equal(reopened.view().files.length, 0)
  reopened.unmount()
})
