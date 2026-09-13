const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
const tick = () => new Promise(resolve => setImmediate(resolve))

// Exercise ChatWindow's real form and keyboard handlers without browser storage,
// networking, or unrelated dialogs. Attachment queue behavior has its own suite.
function harness(options = {}) {
  const state = [], effects = [], textSends = [], attachmentSends = [], batches = []
  let cursor = 0, dirty = false, tree, attachmentProps, cleared = 0
  let content = options.content || '', spans = options.spans || []
  let pending = { count: 0, unavailable: false }
  const changed = (before, after) => !before || !after || after.some((value, index) => value !== before[index])
  const react = {
    useState(initial) {
      const index = cursor++
      if (!(index in state)) state[index] = { value: typeof initial === 'function' ? initial() : initial,
        set(next) { const value = typeof next === 'function' ? next(state[index].value) : next; if (!Object.is(value, state[index].value)) { state[index].value = value; dirty = true } } }
      return [state[index].value, state[index].set]
    },
    useRef(initial) { const index = cursor++; if (!(index in state)) state[index] = { current: initial }; return state[index] },
    useMemo(create, dependencies) { const index = cursor++; if (changed(state[index]?.dependencies, dependencies)) state[index] = { dependencies, value: create() }; return state[index].value },
    useCallback(callback, dependencies) { return react.useMemo(() => callback, dependencies) },
    useEffect(effect, dependencies) {
      const index = cursor++, previous = state[index]
      if (changed(previous?.dependencies, dependencies)) {
        const slot = { dependencies, cleanup: null }; state[index] = slot
        effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect() })
      }
    },
  }
  const messaging = {
    identity: { publicKey: 'self-key' }, ready: true, error: '', status: 'online',
    contacts: [{ pub: 'friend-key', alias: 'Friend' }], conversations: [], groups: [], messages: [],
    preferences: { blocked: [], notifications: {}, readAt: {} },
    getPrivateMode: () => 0, markRead: async () => {},
    sendText: async (...args) => { textSends.push(args); await options.sendText?.(...args) },
    sendEvent: async () => {},
  }
  const dom = { addEventListener() {}, removeEventListener() {}, getElementById() { return null }, hasFocus: () => true, visibilityState: 'visible' }
  const browser = { ...dom, location: { hash: '' } }
  const ui = new Proxy({}, { get: (_target, name) => String(name) })
  const cache = new Map()
  function load(relative) {
    const filename = path.join(root, relative)
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }; cache.set(filename, module)
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText
    new Function('require', 'module', 'exports', 'document', 'window', 'requestAnimationFrame', code)(specifier => {
      if (specifier === 'react') return react
      if (specifier === 'next/link') return 'a'
      if (specifier === 'lucide-react') return ui
      if (specifier === '@/components/messaging-provider') return { useMessaging: () => messaging }
      if (specifier === '@/hooks/use-chat-draft') return { useChatDraft: () => ({
        content, setContent(value) { content = value; dirty = true },
        clearSubmittedDraft() { content = ''; spans = []; cleared++; dirty = true },
        retryDraftSave() {}, draftReady: true, draftSaved: true, draftIssue: null,
      }) }
      if (specifier === '@/hooks/use-local-nickname') return { useLocalNickname: () => '' }
      if (specifier === '@/hooks/use-mention-draft') return { useMentionDraft: () => ({ mentionSpans: spans, saveMentionDraft(_value, next) { spans = next } }) }
      if (specifier === '@/lib/composer-mentions') return load('lib/composer-mentions.ts')
      if (specifier === '@/lib/identity') return { shortAddress: pub => pub }
      if (specifier === '@/lib/protocol') return { MAX_MESSAGE_LENGTH: 8000 }
      if (specifier === '@/lib/mention-display') return { formatMentionText: text => text }
      if (specifier === '@/components/message-text') return { literalSearch: () => null }
      if (specifier === '@/lib/attachments') return { attachmentFileLimit: () => 50 * 1024 * 1024, sendAttachment: async (...args) => { attachmentSends.push(args); return 'attachment-id' } }
      if (specifier.startsWith('@/components/')) return ui
      if (specifier === '@/lib/contact-code') return { parseContactCode: async value => value }
      return require(specifier)
    }, module, module.exports, dom, browser, callback => callback())
    return module.exports
  }
  const ChatWindow = load('app/chat/[pubkey]/chat-client.tsx').default
  function walk(node, fn) { if (Array.isArray(node)) return node.forEach(child => walk(child, fn)); if (node && typeof node === 'object') { fn(node); walk(node.props?.children, fn) } }
  function find(predicate) { let found; walk(tree, node => { if (predicate(node)) found = node }); assert.ok(found, 'expected rendered element'); return found }
  function view() {
    let renders = 0
    do {
      assert.ok(renders++ < 10, 'render must settle')
      cursor = 0; dirty = false; tree = ChatWindow({ params: { pubkey: 'friend-key' } })
      attachmentProps = find(node => node.type === 'AttachmentComposer').props
      attachmentProps.composerRef.current = handle
      while (effects.length) effects.shift()()
    } while (dirty)
    return tree
  }
  function queue(count, unavailable = false) { pending = { count, unavailable }; attachmentProps.onStateChange(pending); view() }
  const handle = {
    getState: () => pending,
    async sendAll(caption, onFirstSent) {
      batches.push(caption)
      if (options.sendAll) return options.sendAll(caption, onFirstSent, { queue })
      await attachmentProps.onSend(new File(['file'], 'notes.txt'), 'file', undefined, caption)
      queue(0); onFirstSent()
    },
  }
  view()
  return {
    view, queue, textSends, attachmentSends, batches,
    get content() { return content }, get cleared() { return cleared },
    input() { view(); return find(node => node.type === 'Textarea') },
    sendButton() { view(); return find(node => node.type === 'Button' && node.props['aria-label'] === 'Send message') },
    type(value) { this.input().props.onChange({ target: { value, selectionStart: value.length, selectionEnd: value.length } }); view() },
    key(properties = {}) { let prevented = false; this.input().props.onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false }, preventDefault() { prevented = true }, ...properties }); return prevented },
    form(nested = false) { view(); const form = find(node => node.type === 'form' && node.props['aria-label'] === 'Message composer'); let prevented = false; form.props.onSubmit({ target: nested ? {} : form, currentTarget: form, preventDefault() { prevented = true } }); return prevented },
    text() { view(); const strings = []; walk(tree, node => { if (typeof node.props?.children === 'string') strings.push(node.props.children) }); return strings.join(' ') },
    unmount() { for (const slot of state) slot?.cleanup?.() },
  }
}

test('Enter and the composer form both send text through the normal message path', async () => {
  const h = harness()
  h.type('First message')
  assert.equal(h.sendButton().props.disabled, false)
  assert.equal(h.key(), true)
  await tick()
  assert.equal(h.content, '')
  h.type('Second message')
  assert.equal(h.form(), true)
  await tick()
  assert.deepEqual(h.textSends.map(args => args.slice(0, 2)), [['friend-key', 'First message'], ['friend-key', 'Second message']])
  assert.equal(h.cleared, 2)
  assert.equal(h.batches.length, 0)
  h.unmount()
})

test('file-only drafts enable Send and Enter forwards the attachment without a separate text message', async () => {
  const h = harness()
  assert.equal(h.sendButton().props.disabled, true)
  h.queue(1, true)
  assert.equal(h.sendButton().props.disabled, true)
  h.key(); await tick()
  assert.equal(h.batches.length, 0)
  h.queue(1)
  assert.equal(h.sendButton().props.disabled, false)
  h.key(); await tick()
  assert.deepEqual(h.batches, [{ content: '', mentions: [] }])
  assert.equal(h.textSends.length, 0)
  assert.equal(h.attachmentSends.length, 1)
  assert.equal(h.attachmentSends[0][1], 'friend-key')
  assert.equal(h.attachmentSends[0][2].name, 'notes.txt')
  assert.deepEqual(h.attachmentSends[0][7], { content: '', mentions: [] })
  assert.equal(h.sendButton().props.disabled, true)
  h.unmount()
})

test('attachment caption includes serialized mentions, preserves failed drafts, and clears after first success', async () => {
  let outcome = 'first-fails'
  const h = harness({ content: 'For @Friend', spans: [{ publicKey: 'friend-key', start: 4, end: 11, text: '@Friend' }],
    async sendAll(_caption, onFirstSent, { queue }) {
      if (outcome === 'first-fails') throw new Error('No file sent')
      onFirstSent()
      if (outcome === 'partial') { queue(1); throw new Error('Second file failed') }
      queue(0)
    } })
  h.queue(2)
  h.form(); await tick()
  assert.equal(h.content, 'For @Friend')
  assert.equal(h.cleared, 0)
  assert.match(h.text(), /No file sent/)
  outcome = 'partial'
  h.form(); await tick()
  assert.equal(h.content, '')
  assert.equal(h.cleared, 1)
  assert.match(h.text(), /Second file failed/)
  assert.equal(h.sendButton().props.disabled, false, 'remaining file can be sent with an empty draft')
  outcome = 'success'
  h.key(); await tick()
  assert.deepEqual(h.batches, [
    { content: 'For @friend-key', mentions: ['friend-key'] },
    { content: 'For @friend-key', mentions: ['friend-key'] },
    { content: '', mentions: [] },
  ])
  assert.equal(h.textSends.length, 0)
  h.unmount()
})

test('Shift+Enter, IME composition, and empty drafts do not send', async () => {
  const h = harness()
  h.type('Composing')
  assert.equal(h.key({ shiftKey: true }), false)
  assert.equal(h.key({ nativeEvent: { isComposing: true } }), false)
  await tick()
  assert.equal(h.textSends.length, 0)
  assert.equal(h.content, 'Composing')
  h.type('   ')
  assert.equal(h.sendButton().props.disabled, true)
  h.key(); h.form(); await tick()
  assert.equal(h.textSends.length, 0)
  assert.equal(h.batches.length, 0)
  assert.equal(h.cleared, 0)
  h.unmount()
})

test('nested form submits are ignored and simultaneous Enter/form submits share a send lock', async () => {
  let finish
  const h = harness({ content: 'Send once', sendText: () => new Promise(resolve => { finish = resolve }) })
  assert.equal(h.form(true), true)
  await tick()
  assert.equal(h.textSends.length, 0, 'a dialog portal form must not send the chat draft')
  h.key(); h.form()
  assert.equal(h.textSends.length, 1)
  assert.equal(h.sendButton().props.disabled, true)
  assert.equal(h.content, 'Send once')
  finish(); await tick()
  assert.equal(h.textSends.length, 1)
  assert.equal(h.content, '')
  h.unmount()
})
