/* Inspect the real rendered card and object-URL lifecycle at the browser boundary. */
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function harness() {
  const slots = [], effects = [], created = [], revoked = [], cache = new Map()
  let cursor = 0
  const react = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], value => { slots[index] = value }]
    },
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
  const URL = {
    createObjectURL(blob) { const url = `blob:test/${created.length}`; created.push({ url, blob }); return url },
    revokeObjectURL(url) { revoked.push(url) },
  }
  function load(file) {
    if (!path.extname(file)) file += fs.existsSync(file + '.tsx') ? '.tsx' : '.ts'
    if (cache.has(file)) return cache.get(file)
    const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), { fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
    const module = { exports: {} }
    new Function('require', 'module', 'exports', 'URL', output)(specifier => {
      if (specifier === 'react') return react
      if (specifier === 'lucide-react') return { Download: 'download-icon', File: 'file-icon', X: 'remove-icon' }
      if (specifier.startsWith('@/')) return load(path.join(__dirname, '..', specifier.slice(2)))
      return require(specifier)
    }, module, module.exports, URL)
    cache.set(file, module.exports)
    return module.exports
  }
  const { MessageAttachments } = load(path.join(__dirname, '../components/message-attachments.tsx'))
  return {
    created, revoked,
    render(attachment) {
      const element = MessageAttachments({ attachments: [attachment], mine: false, query: '' }).props.children[0]
      cursor = 0
      const result = element.type(element.props)
      while (effects.length) effects.shift()()
      return result
    },
    unmount() { for (const slot of slots) slot?.cleanup?.() },
  }
}

function tags(node, tag) {
  if (!node) return []
  if (Array.isArray(node)) return node.flatMap(child => tags(child, tag))
  return [...(node.type === tag ? [node] : []), ...tags(node.props?.children, tag)]
}
const attachment = (type, name, bytes) => ({ type, name, size: Buffer.byteLength(bytes), data: Buffer.from(bytes).toString('base64') })

test('active formats are downloadable octet streams with no inline document preview', () => {
  const h = harness(), svg = attachment('image/svg+xml', 'diagram.svg', '<svg onload="alert(1)"/>')
  h.render(svg)
  const tree = h.render(svg)
  for (const tag of ['img', 'iframe', 'object', 'embed']) assert.equal(tags(tree, tag).length, 0)
  const link = tags(tree, 'a')[0]
  assert.equal(link.props.download, 'diagram.svg')
  assert.equal(link.props.href, h.created[0].url)
  assert.equal(h.created[0].blob.type, 'application/octet-stream')
  h.unmount()
  assert.deepEqual(h.revoked, [h.created[0].url])
})

test('raster previews recover from decode errors and URLs are revoked on replacement and unmount', () => {
  const h = harness(), png = attachment('image/png', 'image.png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  h.render(png)
  const preview = tags(h.render(png), 'img')[0]
  assert.match(preview.props.alt, /image.png/)
  assert.equal(h.created[0].blob.type, 'image/png')
  preview.props.onError()
  assert.equal(tags(h.render(png), 'img').length, 0)
  assert.equal(tags(h.render(png), 'a').length, 1)
  const text = attachment('text/plain', 'notes.txt', 'some notes')
  h.render(text)
  assert.deepEqual(h.revoked, [h.created[0].url])
  assert.equal(tags(h.render(text), 'a')[0].props.download, 'notes.txt')
  h.unmount()
  assert.deepEqual(h.revoked, h.created.map(resource => resource.url))
})
