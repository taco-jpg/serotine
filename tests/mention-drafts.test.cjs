const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const keyA = '04' + 'a'.repeat(128)
const keyB = '04' + 'b'.repeat(128)
const text = '@Alice hello'
const span = { publicKey: keyA, start: 0, end: 6, text: '@Alice' }

function harness(storage = new Map(), options = {}) {
  const slots = [], effects = []
  let cursor = 0, owner = 'owner', peer = 'group:test', content = '', ready = false
  const react = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useEffect(effect, deps) {
      const index = cursor++, old = slots[index]
      if (!old || deps.some((value, i) => value !== old.deps[i])) {
        old?.cleanup?.()
        const next = { deps, cleanup: null }; slots[index] = next
        effects.push(() => { next.cleanup = effect() })
      }
    },
  }
  const localStorage = {
    getItem(key) { if (options.failReads) throw new Error('Blocked'); return storage.get(key) ?? null },
    setItem(key, value) { if (options.failWrites) throw new Error('Full'); storage.set(key, value) },
    removeItem(key) { if (options.failWrites) throw new Error('Full'); storage.delete(key) },
  }
  const cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file)
    const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const module = { exports: {} }
    new Function('require', 'module', 'exports', 'localStorage', compiled)(specifier => {
      if (specifier === 'react') return react
      return load(specifier.startsWith('@/') ? path.join(__dirname, '..', specifier.slice(2) + '.ts') : path.resolve(path.dirname(file), specifier + '.ts'))
    }, module, module.exports, localStorage)
    cache.set(file, module.exports)
    return module.exports
  }
  const hook = load(path.join(__dirname, '../hooks/use-mention-draft.ts')).useMentionDraft
  function view() {
    cursor = 0
    const result = hook(owner, peer, content, ready)
    while (effects.length) effects.shift()()
    return result
  }
  return {
    view,
    show(nextContent, nextReady = true) { content = nextContent; ready = nextReady; view(); return view() },
    navigate(nextOwner, nextPeer, nextContent) { owner = nextOwner; peer = nextPeer; return this.show(nextContent) },
    save(nextText, spans, revision = crypto.randomUUID()) {
      // The component updates the text hook before binding its mention metadata.
      const current = view()
      if (!options.failWrites) storage.set(`serotine_draft:${owner}:${peer}`, JSON.stringify({ content: nextText, revision }))
      content = nextText; current.saveMentionDraft(nextText, spans)
      view(); return view()
    },
  }
}

test('selected mention restores only after text hydration and survives navigation and reload', () => {
  const storage = new Map(), h = harness(storage)
  h.show('')
  assert.deepEqual(h.save(text, [span]).mentionSpans, [span])
  h.navigate('owner', 'another-chat', '')
  assert.deepEqual(h.view().mentionSpans, [])
  assert.deepEqual(h.navigate('owner', 'group:test', text).mentionSpans, [span])
  const reloaded = harness(storage)
  assert.deepEqual(reloaded.show('', false).mentionSpans, [])
  assert.ok(storage.has('serotine_mention_draft:owner:group:test'))
  assert.deepEqual(reloaded.show(text).mentionSpans, [span])
  assert.deepEqual(reloaded.navigate('different-owner', 'group:test', text).mentionSpans, [])
})

test('a stale mention sidecar cannot reattach recipients to a same-text new draft revision', () => {
  const storage = new Map(), h = harness(storage)
  h.show(''); h.save(text, [span], 'old-revision')
  storage.set('serotine_draft:owner:group:test', JSON.stringify({ content: text, revision: 'new-revision' }))
  assert.deepEqual(h.view().mentionSpans, [])
  assert.deepEqual(h.view().mentionSpans, [])
  assert.deepEqual(harness(storage).show(text).mentionSpans, [])
})

test('cleared or edited text does not retain mention targets and a new selected identity replaces them', () => {
  const storage = new Map(), h = harness(storage)
  h.show(''); h.save(text, [span])
  assert.deepEqual(h.save(text, [{ ...span, publicKey: keyB }]).mentionSpans, [{ ...span, publicKey: keyB }])
  assert.deepEqual(h.save(text.replace('@Alice', '@Alicia'), []).mentionSpans, [])
  assert.equal(storage.has('serotine_mention_draft:owner:group:test'), false)
  h.save(text, [span]); storage.delete('serotine_draft:owner:group:test')
  assert.deepEqual(h.show('').mentionSpans, [])
  assert.equal(storage.has('serotine_mention_draft:owner:group:test'), false)
})

test('blocked storage keeps current-tab mentions usable and malformed records never add recipients', () => {
  const options = { failReads: true, failWrites: true }, h = harness(new Map(), options)
  h.show('')
  assert.deepEqual(h.save(text, [span]).mentionSpans, [span])
  h.navigate('owner', 'other-chat', '')
  assert.deepEqual(h.navigate('owner', 'group:test', text).mentionSpans, [span])
  const storage = new Map([
    ['serotine_draft:owner:group:test', JSON.stringify({ content: text, revision: 'revision' })],
    ['serotine_mention_draft:owner:group:test', JSON.stringify({ content: text, revision: 'revision', spans: [
      { ...span, publicKey: 'invalid-key' }, { ...span, start: -1 }, { ...span, end: 999 }, { ...span, text: '@Bob' },
    ] })],
  ])
  assert.deepEqual(harness(storage).show(text).mentionSpans, [])
})
