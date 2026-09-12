const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
const tick = () => new Promise(resolve => setImmediate(resolve))

function harness(getUserMedia) {
  const state = [], pendingEffects = [], instances = [], stops = [], sends = [], intervals = new Map()
  let cursor = 0, tree
  const react = {
    useState(initial) { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next }] },
    useRef(initial) { const index = cursor++; if (!(index in state)) state[index] = { current: initial }; return state[index] },
    useEffect(effect, dependencies) {
      const index = cursor++, previous = state[index]
      if (!previous || dependencies.some((dependency, i) => dependency !== previous.dependencies[i])) {
        previous?.cleanup?.()
        const slot = { dependencies, cleanup: null }; state[index] = slot
        pendingEffects.push(() => { slot.cleanup = effect() })
      }
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
      if (specifier.startsWith('@/')) return load(path.join(root, specifier.slice(2)))
      return require(specifier)
    }, module, module.exports, { mediaDevices: { getUserMedia } }, Recorder,
    callback => { const id = intervals.size + 1; intervals.set(id, callback); return id }, id => intervals.delete(id))
    return module.exports
  }
  const { AttachmentComposer } = load(path.join(root, 'components/chat/attachment-composer.tsx'))
  function view() { cursor = 0; tree = AttachmentComposer({ onSend: async (...args) => sends.push(args) }); while (pendingEffects.length) pendingEffects.shift()(); return tree }
  function walk(node, fn) { if (!node) return; if (Array.isArray(node)) return node.forEach(child => walk(child, fn)); if (typeof node === 'object') { fn(node); walk(node.props?.children, fn) } }
  function label(node) { if (Array.isArray(node)) return node.map(label).join(''); if (typeof node === 'string' || typeof node === 'number') return String(node); return node?.props ? label(node.props.children) : '' }
  function click(text) { view(); let found; walk(tree, node => { if (node.type === 'button' && label(node) === text) found = node }); assert.ok(found, 'button: ' + text); assert.ok(!found.props.disabled); found.props.onClick() }
  return { view, click, instances, stops, sends, intervals, text() { return label(view()) }, unmount() { for (const slot of state) slot?.cleanup?.() } }
}

test('late microphone permission after cancel closes every track and never starts recording', async () => {
  let resolve, stopped = 0
  const h = harness(() => new Promise(done => { resolve = done }))
  h.click('Voice')
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
  h.click('Voice'); await tick(); h.view()
  h.instances[0].data()
  h.click('Stop & preview')
  h.stops.shift()()
  assert.equal(stopped, 1)
  assert.equal(h.sends.length, 0)
  assert.match(h.text(), /Send voice message/)
  h.click('Send voice message'); await tick()
  assert.equal(h.sends.length, 1)
  assert.equal(h.sends[0][1], 'voice')
  assert.equal(await h.sends[0][0].text(), 'audio bytes')
  h.unmount()
})

test('cancelled recording finishing later cannot stop or replace a new recording', async () => {
  const stopped = [0, 0]; let request = 0
  const h = harness(async () => { const id = request++; return { getTracks: () => [{ stop() { stopped[id]++ } }] } })
  h.click('Voice'); await tick(); h.view()
  h.instances[0].data('old recording')
  h.click('Cancel')
  h.click('Voice'); await tick(); h.view()
  h.stops.shift()()
  assert.equal(stopped[1], 0, 'old stop must not close the new microphone')
  assert.match(h.text(), /Recording/)
  h.instances[1].data('new recording')
  h.click('Stop & preview'); h.stops.shift()()
  h.click('Send voice message'); await tick()
  assert.equal(await h.sends[0][0].text(), 'new recording')
  h.unmount()
})

test('unmounting during recording stops hardware tracks and recording timer', async () => {
  let stopped = 0
  const h = harness(async () => ({ getTracks: () => [{ stop() { stopped++ } }] }))
  h.click('Voice'); await tick(); h.view()
  assert.equal(h.intervals.size, 1)
  h.unmount()
  assert.ok(stopped > 0)
  assert.equal(h.instances[0].state, 'inactive')
  assert.equal(h.intervals.size, 0)
  h.stops.shift()()
  assert.equal(h.sends.length, 0)
})
