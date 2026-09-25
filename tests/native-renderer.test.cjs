const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
function compile(file) { return ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText }

function routerHarness() {
  const window = new EventTarget(), snapshots = [], history = []
  let location = new URL('https://localhost/chat/communities?q=first#id=one')
  Object.defineProperty(window, 'location', { get: () => location })
  window.history = Object.fromEntries(['pushState', 'replaceState'].map(method => [method, (_data, _title, href) => { history.push({ method, href }); location = new URL(href, location) }]))
  class HashChangeEvent extends Event { constructor(name, details) { super(name); Object.assign(this, details) } }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'window', 'HashChangeEvent', compile('native/web/router.tsx'))(name => {
    if (name === 'react') return { forwardRef: fn => fn, useSyncExternalStore: (subscribe, snapshot) => {
      const values = [snapshot()]; snapshots.push(values)
      subscribe(() => { const next = snapshot(); if (next !== values.at(-1)) values.push(next) })
      return snapshot()
    } }
    if (name === 'react/jsx-runtime') return { jsx: (...args) => args }
    return require(name)
  }, module, module.exports, window, HashChangeEvent)
  return { api: module.exports, window, snapshots, history }
}

test('native router observes same-screen search/hash changes and emits the hash event shared views consume', () => {
  const h = routerHarness(), hashes = []
  h.window.addEventListener('hashchange', event => hashes.push([event.oldURL, event.newURL]))
  assert.equal(h.api.usePathname(), '/chat/communities')
  assert.equal(h.api.useSearchParams().get('q'), 'first')
  h.api.useRouter().push('/chat/communities?q=second#id=two&channel=three')
  assert.equal(h.api.usePathname(), '/chat/communities')
  assert.equal(h.api.useSearchParams().get('q'), 'second')
  assert.equal(h.snapshots[0].length, 2, 'pathname consumers still rerender for same-screen navigation')
  assert.equal(h.snapshots[1].length, 2, 'search consumers observe a changed query')
  assert.deepEqual(hashes, [['https://localhost/chat/communities?q=first#id=one', 'https://localhost/chat/communities?q=second#id=two&channel=three']])
  h.api.useRouter().replace('/chat/communities?q=third#id=two&channel=three')
  assert.equal(hashes.length, 1, 'unchanged fragments do not reconsume invites')
  assert.equal(h.history.at(-1).method, 'replaceState')
})

test('native router refuses external, protocol-relative, backslash and control-character destinations', () => {
  const h = routerHarness()
  for (const href of ['https://evil.example/chat', '//evil.example/chat', '/\\evil.example', '/\n/evil.example', '/\0chat', 'javascript:alert(1)']) {
    assert.throws(() => h.api.useRouter().push(href), /Invalid app destination/)
  }
  assert.equal(h.history.length, 0)
})

test('native relay build configuration uses bare public HTTPS names and rejects placeholder release origins', async () => {
  const { validateNativeOrigin } = await import('../scripts/native-config.mjs')
  assert.equal(validateNativeOrigin('https://relay.serotine.org:443'), 'https://relay.serotine.org')
  assert.equal(validateNativeOrigin('https://native-development.invalid'), 'https://native-development.invalid')
  for (const origin of ['http://relay.serotine.org', 'https://relay.serotine.org:8443', 'https://localhost', 'https://dev.localhost', 'https://dev.local',
    'https://internal', 'https://server.internal', 'https://127.0.0.1', 'https://[::1]', 'https://user:pass@relay.serotine.org', 'https://relay.serotine.org/path',
    'https://relay.serotine.org?q=x', 'https://relay.serotine.org#x', 'https://-invalid.example', 'https://relay..example']) {
    assert.throws(() => validateNativeOrigin(origin), /HTTPS|Invalid URL/)
  }
  for (const origin of ['https://native-development.invalid', 'https://relay.example.com', 'https://relay.test', 'https://relay.example']) {
    assert.throws(() => validateNativeOrigin(origin, { development: false }), /release requires/)
  }
  assert.equal(validateNativeOrigin('https://relay.serotine.org', { development: false }), 'https://relay.serotine.org')
})

test('native downloads preserve bytes and cancellation instead of claiming a cancelled export was saved', async () => {
  const calls = [], module = { exports: {} }
  let saved = false
  new Function('require', 'module', 'exports', compile('lib/save-download.ts'))(name => {
    assert.equal(name, '@/native/shared/bridge')
    return { getNativeBridge: () => ({ saveFile: async input => { calls.push(input); return { saved } } }) }
  }, module, module.exports)
  const blob = new Blob([Uint8Array.from([0, 1, 128, 255])], { type: 'application/octet-stream' })
  assert.equal(await module.exports.saveDownload(blob, 'bytes.bin'), false)
  assert.deepEqual(Buffer.from(calls[0].dataBase64, 'base64'), Buffer.from([0, 1, 128, 255]))
  assert.equal(calls[0].name, 'bytes.bin')
  saved = true
  assert.equal(await module.exports.saveDownload(blob, 'bytes.bin'), true)
})

test('installed invitation links require loaded relay info and never use the local WebView origin', () => {
  const window = { serotineNative: {}, location: { origin: 'https://localhost' } }, module = { exports: {} }
  new Function('module', 'exports', 'window', compile('native/shared/bridge.ts'))(module, module.exports, window)
  assert.throws(() => module.exports.appLinkOrigin(), /not ready/)
  module.exports.setNativeInfo({ platform: 'test', version: '0.1.0', relayOrigin: 'https://relay.serotine.org', backgroundSync: false })
  assert.equal(module.exports.appLinkOrigin(), 'https://relay.serotine.org')
})
