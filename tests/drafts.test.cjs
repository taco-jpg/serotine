/* Exercise the real draft hook with controlled React and browser storage boundaries. */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function harness(storage = new Map(), options = {}) {
  const slots = [], effects = []
  let cursor = 0, owner = 'alice', peer = 'bob', stopped = false, lateUpdates = 0
  const react = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], value => {
        if (stopped) lateUpdates++
        slots[index] = typeof value === 'function' ? value(slots[index]) : value
      }]
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial } },
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
  const localStorage = {
    getItem(key) { if (options.failReads) throw new Error('Storage blocked'); return storage.get(key) ?? null },
    setItem(key, value) { if (options.failWrites) throw new Error('Storage full'); storage.set(key, value) },
    removeItem(key) { if (options.failWrites) throw new Error('Storage full'); storage.delete(key) },
  }
  const cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file)
    const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const module = { exports: {} }
    new Function('require', 'module', 'exports', 'localStorage', output)(specifier => {
      if (specifier === 'react') return react
      return load(specifier.startsWith('@/')
        ? path.join(__dirname, '..', specifier.slice(2) + '.ts')
        : path.resolve(path.dirname(file), specifier + '.ts'))
    }, module, module.exports, localStorage)
    cache.set(file, module.exports)
    return module.exports
  }
  const hook = load(path.join(__dirname, '../hooks/use-chat-draft.ts')).useChatDraft
  function view() {
    cursor = 0
    const result = hook(owner, peer)
    while (effects.length) effects.shift()()
    return result
  }
  view()
  return {
    view, storage,
    switchTo(nextOwner, nextPeer) { owner = nextOwner; peer = nextPeer; return view() },
    unmount() { for (const slot of slots) slot?.cleanup?.(); stopped = true },
    get lateUpdates() { return lateUpdates },
  }
}

test('draft survives reload and remains isolated by identity and recipient', () => {
  const storage = new Map(), h = harness(storage)
  h.view().setContent('Hello Bob\nSecond line')
  h.switchTo('alice', 'carol')
  assert.equal(h.view().content, '')
  h.view().setContent('Hello Carol')
  h.switchTo('someone-else', 'bob')
  assert.equal(h.view().content, '')
  h.switchTo('alice', 'bob')
  assert.equal(h.view().content, 'Hello Bob\nSecond line')
  h.unmount()
  assert.equal(harness(storage).view().content, 'Hello Bob\nSecond line')
})

test('an old send cannot clear a newer draft after navigating away and back', () => {
  const storage = new Map(), old = harness(storage)
  old.view().setContent('Sending slowly')
  const finishOldSend = old.view().clearSubmittedDraft
  old.unmount()
  const reopened = harness(storage)
  reopened.view().setContent('A newer unsent message')
  finishOldSend()
  assert.equal(reopened.view().content, 'A newer unsent message')
  assert.equal(harness(storage).view().content, 'A newer unsent message')
  assert.equal(old.lateUpdates, 0)
})

test('same-text edits also have a new revision and survive stale send completion', () => {
  const storage = new Map(), h = harness(storage)
  h.view().setContent('Hello')
  const finishOldSend = h.view().clearSubmittedDraft
  h.view().setContent('Changed')
  h.view().setContent('Hello')
  finishOldSend()
  assert.equal(h.view().content, 'Hello')
  assert.equal(harness(storage).view().content, 'Hello')
})

test('successful send clears only its submitted conversation', () => {
  const storage = new Map(), h = harness(storage)
  h.view().setContent('Bob message')
  const finish = h.view().clearSubmittedDraft
  h.switchTo('alice', 'carol')
  h.view().setContent('Carol draft')
  finish()
  assert.equal(h.view().content, 'Carol draft')
  h.switchTo('alice', 'bob')
  assert.equal(h.view().content, '')
})

test('storage failures retain editable text and expose unsaved status', () => {
  const options = { failWrites: true }, h = harness(new Map(), options)
  h.view().setContent('The only copy')
  assert.equal(h.view().content, 'The only copy')
  assert.equal(h.view().draftSaved, false)
  options.failWrites = false
  h.view().setContent('The only copy, now saved')
  assert.equal(h.view().draftSaved, true)
  assert.equal(harness(h.storage).view().content, 'The only copy, now saved')
})

test('blocked or malformed draft storage does not disable the composer', () => {
  const blocked = harness(new Map(), { failReads: true })
  assert.equal(blocked.view().draftReady, true)
  assert.equal(blocked.view().draftSaved, false)
  const damaged = harness(new Map([['serotine_draft:alice:bob', '{invalid']]))
  assert.equal(damaged.view().draftReady, true)
  assert.equal(damaged.view().draftSaved, false)
  damaged.view().setContent('Recovered draft')
  assert.equal(harness(damaged.storage).view().content, 'Recovered draft')
})


test('unsaved drafts survive switching contacts and identities in the same tab', () => {
  const options = { failWrites: true }, h = harness(new Map(), options)
  h.view().setContent('Do not lose Bob draft')
  h.switchTo('alice', 'carol')
  h.view().setContent('Do not lose Carol draft')
  h.switchTo('other-owner', 'bob')
  assert.equal(h.view().content, '')
  h.switchTo('alice', 'bob')
  assert.equal(h.view().content, 'Do not lose Bob draft')
  assert.equal(h.view().draftSaved, false)
  options.failWrites = false
  h.view().retryDraftSave()
  assert.equal(h.view().draftSaved, true)
  assert.equal(harness(h.storage).view().content, 'Do not lose Bob draft')
  h.switchTo('alice', 'carol')
  assert.equal(h.view().content, 'Do not lose Carol draft')
})


test('retrying an unread draft loads the original instead of deleting it', () => {
  const key = 'serotine_draft:alice:bob'
  const saved = JSON.stringify({ content: 'Original draft', revision: 'original' })
  const storage = new Map([[key, saved]])
  const options = { failReads: true }, h = harness(storage, options)
  assert.equal(h.view().draftIssue, 'read')
  options.failReads = false
  h.view().retryDraftSave()
  assert.equal(h.view().content, 'Original draft')
  assert.equal(storage.get(key), saved)
})

test('failed cleanup keeps sent text cleared across navigation and retries only its revision', () => {
  const options = {}, h = harness(new Map(), options)
  h.view().setContent('Already sent')
  options.failWrites = true
  h.view().clearSubmittedDraft()
  h.switchTo('alice', 'carol')
  h.switchTo('alice', 'bob')
  assert.equal(h.view().content, '')
  assert.equal(h.view().draftIssue, 'clear')
  const newer = JSON.stringify({ content: 'A newer draft from another tab', revision: 'new-revision' })
  h.storage.set('serotine_draft:alice:bob', newer)
  options.failWrites = false
  h.view().retryDraftSave()
  assert.equal(h.view().content, 'A newer draft from another tab')
  assert.equal(h.storage.get('serotine_draft:alice:bob'), newer)
})
