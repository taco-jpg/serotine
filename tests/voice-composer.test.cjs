const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
const tick = () => new Promise(resolve => setImmediate(resolve))

function harness(getUserMedia, options = {}) {
  const state = [], pendingEffects = [], instances = [], stops = [], sends = [], intervals = new Map()
  const composerRef = { current: null }
  let cursor = 0, tree, unmounted = false, lateUpdates = 0
  const react = {
    useState(initial) { const index = cursor++; if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial; return [state[index], next => { if (unmounted) lateUpdates++; state[index] = typeof next === 'function' ? next(state[index]) : next }] },
    useRef(initial) { const index = cursor++; if (!(index in state)) state[index] = { current: initial }; return state[index] },
    useCallback(callback, dependencies) {
      const index = cursor++, previous = state[index]
      if (!previous || dependencies.some((dependency, i) => dependency !== previous.dependencies[i])) state[index] = { dependencies, callback }
      return state[index].callback
    },
    useEffect(effect, dependencies) {
      const index = cursor++, previous = state[index]
      if (!previous || dependencies.some((dependency, i) => dependency !== previous.dependencies[i])) {
        previous?.cleanup?.()
        const slot = { dependencies, cleanup: null }; state[index] = slot
        pendingEffects.push(() => { slot.cleanup = effect() })
      }
    },
    useImperativeHandle(ref, create, dependencies) {
      react.useEffect(() => { if (ref) ref.current = create(); return () => { if (ref) ref.current = null } }, dependencies)
    },
  }
  class Recorder {
    static isTypeSupported() { return true }
    constructor(_stream, options) { this.mimeType = options.mimeType; this.state = 'inactive'; instances.push(this) }
    start() { this.state = 'recording' }
    stop() { this.state = 'inactive'; stops.push(() => this.onstop()) }
    data(text = 'audio bytes') { this.ondataavailable({ data: new Blob([text], { type: this.mimeType }) }) }
  }
  const cache = new Map()
  function load(filename) {
    if (!path.extname(filename)) filename += fs.existsSync(filename + '.tsx') ? '.tsx' : '.ts'
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }; cache.set(filename, module)
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText
    new Function('require', 'module', 'exports', 'navigator', 'MediaRecorder', 'setInterval', 'clearInterval', code)(specifier => {
      if (specifier === 'react') return react
      if (specifier === '@/components/ui/button') return { Button: 'button' }
      if (specifier === './use-auto-compact-files') return { useAutoCompactFiles: () => [options.autoCompact ?? false, () => {}], AutoCompactFilesSetting: 'compact-setting' }
      if (specifier === '@/lib/compact-attachment' && options.compact) return { compactAttachment: options.compact }
      if (specifier.startsWith('@/')) return load(path.join(root, specifier.slice(2)))
      if (specifier.startsWith('.')) return load(path.resolve(path.dirname(filename), specifier))
      return require(specifier)
    }, module, module.exports, { mediaDevices: { getUserMedia } }, Recorder,
    callback => { const id = intervals.size + 1; intervals.set(id, callback); return id }, id => intervals.delete(id))
    return module.exports
  }
  const { AttachmentComposer } = load(path.join(root, 'components/chat/attachment-composer.tsx'))
  function view() { cursor = 0; tree = AttachmentComposer({ composerRef, disabled: options.disabled, maxFileBytes: options.maxFileBytes, onSend: options.onSend || (async (...args) => sends.push(args)) }); while (pendingEffects.length) pendingEffects.shift()(); return tree }
  function walk(node, fn) { if (!node) return; if (Array.isArray(node)) return node.forEach(child => walk(child, fn)); if (typeof node === 'object') { fn(node); walk(node.props?.children, fn) } }
  function label(node) { if (Array.isArray(node)) return node.map(label).join(''); if (typeof node === 'string' || typeof node === 'number') return String(node); return node?.props ? label(node.props.children) : '' }
  function click(name) { view(); let found; walk(tree, node => { if (node.type === 'button' && (node.props['aria-label'] || label(node)) === name) found = node }); assert.ok(found, 'button: ' + name); assert.ok(!found.props.disabled); found.props.onClick() }
  function select(files) { view(); let found; walk(tree, node => { if (node.type === 'input' && node.props.type === 'file') found = node }); assert.ok(found); assert.ok(!found.props.disabled); found.props.onChange({ target: { files, value: 'files' } }) }
  return { view, click, select, instances, stops, sends, intervals,
    submit(caption = { content: '' }, onFirstSent = () => {}) { view(); return composerRef.current.sendAll(caption, onFirstSent) },
    getState() { view(); return composerRef.current.getState() },
    get handle() { view(); return composerRef.current },
    text() { return label(view()) }, unmount() { for (const slot of state) slot?.cleanup?.(); unmounted = true }, get lateUpdates() { return lateUpdates } }
}

test('late microphone permission after cancel closes every track and never starts recording', async () => {
  let resolve, stopped = 0
  const h = harness(() => new Promise(done => { resolve = done }))
  h.click('Record voice message')
  assert.match(h.text(), /Waiting for microphone/)
  h.click('Cancel')
  resolve({ getTracks: () => [{ stop() { stopped++ } }] })
  await tick()
  assert.equal(stopped, 1)
  assert.equal(h.instances.length, 0)
  assert.doesNotMatch(h.text(), /Recording/)
  h.unmount()
})

test('voice recording stops microphone, previews audio, and sends only after explicit send', async () => {
  let stopped = 0
  const h = harness(async () => ({ getTracks: () => [{ stop() { stopped++ } }] }))
  h.click('Record voice message'); await tick(); h.view()
  h.instances[0].data()
  h.click('Stop & preview')
  h.stops.shift()()
  assert.equal(stopped, 1)
  assert.equal(h.sends.length, 0)
  assert.match(h.text(), /Voice message/)
  await h.submit()
  assert.equal(h.sends.length, 1)
  assert.equal(h.sends[0][1], 'voice')
  assert.equal(await h.sends[0][0].text(), 'audio bytes')
  h.unmount()
})

test('cancelled recording finishing later cannot stop or replace a new recording', async () => {
  const stopped = [0, 0]; let request = 0
  const h = harness(async () => { const id = request++; return { getTracks: () => [{ stop() { stopped[id]++ } }] } })
  h.click('Record voice message'); await tick(); h.view()
  h.instances[0].data('old recording')
  h.click('Cancel')
  h.click('Record voice message'); await tick(); h.view()
  h.stops.shift()()
  assert.equal(stopped[1], 0, 'old stop must not close the new microphone')
  assert.match(h.text(), /Recording/)
  h.instances[1].data('new recording')
  h.click('Stop & preview'); h.stops.shift()()
  await h.submit()
  assert.equal(await h.sends[0][0].text(), 'new recording')
  h.unmount()
})

test('unmounting during recording stops hardware tracks and recording timer', async () => {
  let stopped = 0
  const h = harness(async () => ({ getTracks: () => [{ stop() { stopped++ } }] }))
  h.click('Record voice message'); await tick(); h.view()
  assert.equal(h.intervals.size, 1)
  h.unmount()
  assert.ok(stopped > 0)
  assert.equal(h.instances[0].state, 'inactive')
  assert.equal(h.intervals.size, 0)
  h.stops.shift()()
  assert.equal(h.sends.length, 0)
})

test('adding batches preserves earlier files and one submit sends every file with the caption once', async () => {
  const h = harness(async () => { throw new Error('Microphone should not be requested') })
  h.select([new File(['first'], 'first.txt'), new File(['second'], 'second.txt')]); await tick()
  h.select([new File(['third'], 'third.txt')]); await tick()
  assert.equal(h.getState().count, 3)
  assert.equal(h.sends.length, 0)
  assert.throws(() => h.click('Record voice message'), 'a recording must not overwrite queued files')
  assert.throws(() => h.click('Send file'), 'attachments share the main composer submit')
  const caption = { content: 'Here are the notes, @friend', mentions: ['friend-key'] }
  let firstSent = 0
  await h.submit(caption, () => { firstSent++; assert.equal(h.getState().count, 2) })
  assert.deepEqual(h.sends.map(args => args[0].name), ['first.txt', 'second.txt', 'third.txt'])
  assert.deepEqual(h.sends[0][3], caption)
  assert.equal(h.sends[1][3], undefined)
  assert.equal(h.sends[2][3], undefined)
  assert.equal(firstSent, 1)
  assert.equal(h.getState().count, 0)
  assert.doesNotMatch(h.text(), /first\.txt/)
  h.unmount()
})

test('invalid and excessive batches leave every previously selected file available', async () => {
  const h = harness()
  h.select([new File(['keep'], 'keep.txt')]); await tick()
  h.select([new File(['valid'], 'valid.txt'), { size: 100 * 1024 * 1024, name: 'too-big.bin' }]); await tick()
  assert.match(h.text(), /keep\.txt/)
  assert.doesNotMatch(h.text(), /valid\.txt/)
  h.select(Array.from({ length: 8 }, (_, i) => new File(['test'], `file${i}.txt`))); await tick()
  assert.match(h.text(), /queue up to 8/)
  await h.submit()
  assert.equal(h.sends[0][0].name, 'keep.txt')
  assert.doesNotMatch(h.text(), /Send file/)
  h.unmount()
})

test('a failed first send preserves the complete queue and draft for retry', async () => {
  let fail = true, draft = 'Please read these', cleared = 0
  const attempts = []
  const h = harness(undefined, { onSend: async (...args) => { attempts.push(args); if (fail) throw new Error('Connection interrupted') } })
  h.select([new File(['one'], 'one.txt'), new File(['two'], 'two.txt')]); await tick()
  const clearDraft = () => { draft = ''; cleared++ }
  await assert.rejects(h.submit({ content: draft }, clearDraft), /Connection interrupted/)
  assert.match(h.text(), /Connection interrupted/)
  assert.equal(h.getState().count, 2)
  assert.equal(draft, 'Please read these')
  assert.equal(cleared, 0)
  fail = false
  await h.submit({ content: draft }, clearDraft)
  assert.deepEqual(attempts.map(args => args[0].name), ['one.txt', 'one.txt', 'two.txt'])
  assert.equal(attempts[1][3].content, 'Please read these')
  assert.equal(attempts[2][3], undefined)
  assert.equal(h.getState().count, 0)
  assert.equal(cleared, 1)
  h.unmount()
})

test('partial failure keeps only unsent files and retry does not repeat the caption', async () => {
  let fail = true, draft = 'Attached documents', cleared = 0
  const delivered = []
  const h = harness(undefined, { onSend: async (file, kind, progress, caption) => {
    if (file.name === 'two.txt' && fail) throw new Error('Upload failed')
    delivered.push({ name: file.name, caption })
  } })
  h.select([new File(['one'], 'one.txt'), new File(['two'], 'two.txt'), new File(['three'], 'three.txt')]); await tick()
  const clearDraft = () => { draft = ''; cleared++ }
  await assert.rejects(h.submit({ content: draft }, clearDraft), /Upload failed/)
  assert.equal(h.getState().count, 2)
  assert.doesNotMatch(h.text(), /one\.txt/)
  assert.equal(draft, '')
  assert.equal(cleared, 1)
  fail = false
  await h.submit({ content: draft }, clearDraft)
  assert.deepEqual(delivered.map(item => item.name), ['one.txt', 'two.txt', 'three.txt'])
  assert.deepEqual(delivered.filter(item => item.caption?.content).map(item => item.caption.content), ['Attached documents'])
  assert.equal(h.getState().count, 0)
  h.unmount()
})

test('file-only submit works and a second submit cannot send the same pending files twice', async () => {
  let finish, firstSent = 0
  const delivered = []
  const h = harness(undefined, { onSend: async file => {
    delivered.push(file.name)
    if (file.name === 'image.png') await new Promise(resolve => { finish = resolve })
  } })
  h.select([new File(['image'], 'image.png', { type: 'image/png' }), new File(['document'], 'document.pdf', { type: 'application/pdf' })]); await tick()
  const handle = h.handle
  const pending = handle.sendAll({ content: '' }, () => { firstSent++ })
  assert.equal(handle.getState().unavailable, true, 'busy state is immediate before React renders')
  await handle.sendAll({ content: '' }, () => { assert.fail('second submission must be ignored') })
  assert.deepEqual(delivered, ['image.png'])
  finish()
  await pending
  assert.deepEqual(delivered, ['image.png', 'document.pdf'])
  assert.equal(firstSent, 1)
  assert.deepEqual(h.getState(), { count: 0, unavailable: false })
  h.unmount()
})

test('submit waits for attachment preparation and sends nothing until the file is ready', async () => {
  let finish
  const file = new File(['prepared'], 'notes.txt')
  const h = harness(undefined, { compact: () => new Promise(resolve => { finish = resolve }) })
  const handle = h.handle
  h.select([file])
  assert.equal(handle.getState().unavailable, true)
  await handle.sendAll({ content: 'Notes' }, () => { assert.fail('draft must remain during preparation') })
  assert.equal(h.sends.length, 0)
  finish({ file, compacted: false, originalBytes: file.size })
  await tick()
  assert.deepEqual(h.getState(), { count: 1, unavailable: false })
  await h.submit({ content: 'Notes' })
  assert.equal(h.sends.length, 1)
  assert.equal(h.sends[0][3].content, 'Notes')
  h.unmount()
})

test('microphone permission and active recording keep unified submit unavailable', async () => {
  let allowMicrophone
  const h = harness(() => new Promise(resolve => { allowMicrophone = resolve }))
  const handle = h.handle
  h.click('Record voice message')
  assert.equal(handle.getState().unavailable, true, 'permission request is synchronous')
  await handle.sendAll({ content: 'Voice note' }, () => { assert.fail('do not clear an unsent draft') })
  allowMicrophone({ getTracks: () => [{ stop() {} }] })
  await tick()
  assert.equal(h.getState().unavailable, true)
  await h.submit({ content: 'Voice note' }, () => { assert.fail('recording must finish first') })
  assert.equal(h.sends.length, 0)
  h.instances[0].data()
  h.click('Stop & preview')
  assert.equal(h.getState().unavailable, true, 'recording stays unavailable while its final data is pending')
  h.stops.shift()()
  assert.equal(h.getState().unavailable, false)
  await h.submit({ content: 'Voice note' })
  assert.equal(h.sends[0][1], 'voice')
  assert.equal(h.sends[0][3].content, 'Voice note')
  h.unmount()
})

test('disabled composer preserves pending attachments and does not send or clear its draft', async () => {
  const options = { disabled: false }
  const h = harness(undefined, options)
  h.select([new File(['pending'], 'pending.txt')]); await tick()
  options.disabled = true
  assert.equal(h.getState().unavailable, true)
  await h.submit({ content: 'Later' }, () => { assert.fail('disabled submit must preserve the draft') })
  assert.equal(h.sends.length, 0)
  assert.equal(h.getState().count, 1)
  options.disabled = false
  await h.submit({ content: 'Later' })
  assert.equal(h.sends.length, 1)
  h.unmount()
})

test('unmount during send stops the remainder of a batch without late state updates', async () => {
  let finish, cleared = 0
  const attempted = []
  const h = harness(undefined, { onSend: async file => {
    attempted.push(file.name)
    await new Promise(resolve => { finish = resolve })
  } })
  h.select([new File(['one'], 'one.txt'), new File(['two'], 'two.txt')]); await tick()
  const pending = h.submit({ content: 'Two files' }, () => { cleared++ })
  assert.deepEqual(attempted, ['one.txt'])
  h.unmount()
  finish()
  await pending
  assert.deepEqual(attempted, ['one.txt'])
  assert.equal(cleared, 1, 'completed first send must clear the original thread draft even after navigation')
  assert.equal(h.lateUpdates, 0)
})

test('late attachment preparation cannot update an unmounted composer', async () => {
  let finish
  const file = new File(['later'], 'later.txt')
  const h = harness(undefined, { compact: () => new Promise(resolve => { finish = resolve }) })
  h.select([file])
  assert.match(h.text(), /Preparing attachments/)
  h.unmount()
  finish({ file, compacted: false, originalBytes: file.size })
  await tick()
  assert.equal(h.lateUpdates, 0)
  assert.equal(h.sends.length, 0)
})

test('group size limit is visible and rejects file selection and stale queued files before sending', async () => {
  const options = { maxFileBytes: 12 * 1024 * 1024 }
  const h = harness(undefined, options)
  assert.match(h.text(), /Files up to 12.0 MB each in this group/)
  h.select([{ name: 'too-large.bin', size: options.maxFileBytes + 1, arrayBuffer() { assert.fail('must not read') } }]); await tick()
  assert.match(h.text(), /This group supports files up to 12.0 MB/)
  assert.doesNotMatch(h.text(), /Send file/)
  h.select([new File(['data'], 'fits.bin')]); await tick()
  options.maxFileBytes = 3
  await assert.rejects(h.submit(), /This group supports files up to 3 B/)
  assert.equal(h.sends.length, 0, 'membership change is checked again when sending')
  assert.match(h.text(), /This group supports files up to 3 B/)
  h.unmount()
})

test('auto compact can shrink a source above the group cap before queueing', async () => {
  const result = new File(['small'], 'large.txt.gz')
  let attempts = 0
  const h = harness(undefined, { maxFileBytes: 12 * 1024 * 1024, autoCompact: true,
    compact: async original => { attempts++; return { file: result, compacted: true, originalBytes: original.size } } })
  h.select([{ name: 'large.txt', size: 13 * 1024 * 1024 }]); await tick()
  assert.equal(attempts, 1)
  assert.equal(h.getState().count, 1)
  await h.submit()
  assert.equal(h.sends[0][0], result)
  h.unmount()
})
