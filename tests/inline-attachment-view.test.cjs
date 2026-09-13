const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

// Run the real component and attachment verifier, controlling only React hooks
// and the browser's object-URL boundary to exercise asynchronous file arrival.
function harness() {
  const slots = [], effects = [], created = [], revoked = [], cache = new Map()
  let cursor = 0
  const react = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = initial
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useMemo(compute, deps) {
      const index = cursor++, old = slots[index]
      if (!old || deps.some((value, i) => value !== old.deps[i])) slots[index] = { deps, value: compute() }
      return slots[index].value
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
  function load(filename) {
    if (!path.extname(filename)) filename += fs.existsSync(filename + '.tsx') ? '.tsx' : '.ts'
    if (cache.has(filename)) return cache.get(filename)
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
    const module = { exports: {} }
    new Function('require', 'module', 'exports', 'URL', output)(specifier => {
      if (specifier === 'react') return react
      if (specifier === 'lucide-react') return { Download: 'download-icon', FileText: 'file-icon', LoaderCircle: 'loader-icon', Maximize2: 'enlarge-icon' }
      if (specifier === '@/components/ui/dialog') return Object.fromEntries(['Dialog', 'DialogTrigger', 'DialogContent', 'DialogHeader', 'DialogTitle', 'DialogDescription'].map(name => [name, name]))
      if (specifier.startsWith('@/')) return load(path.join(__dirname, '..', specifier.slice(2)))
      if (specifier.startsWith('.')) return load(path.resolve(path.dirname(filename), specifier))
      return require(specifier)
    }, module, module.exports, URL)
    cache.set(filename, module.exports)
    return module.exports
  }
  const files = load(path.join(__dirname, '../lib/attachments.ts'))
  const { AttachmentView } = load(path.join(__dirname, '../components/chat/attachment-view.tsx'))
  return {
    files, created, revoked,
    render({ metadata, chunks }) {
      cursor = 0
      const tree = AttachmentView({ metadata, chunks })
      while (effects.length) effects.shift()()
      return tree
    },
    async ready(attachment) {
      this.render(attachment)
      for (let attempt = 0; attempt < 100; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 1))
        const tree = this.render(attachment)
        if (created.length || nodes(tree, node => node.props?.role === 'alert').length) return tree
      }
      assert.fail('file verification did not complete')
    },
    unmount() { for (const slot of slots) slot?.cleanup?.() },
  }
}

function nodes(node, match) {
  if (!node) return []
  if (Array.isArray(node)) return node.flatMap(child => nodes(child, match))
  return [...(match(node) ? [node] : []), ...nodes(node.props?.children, match)]
}
const tags = (tree, tag) => nodes(tree, node => node.type === tag)
const prepare = (h, type, name = 'media', body = 'verified media bytes') => h.files.prepareAttachment(new File([body], name, { type }))

test('images and animated GIFs use the verified original for inline and enlarged viewing', async () => {
  const h = harness()
  const attachment = await prepare(h, 'image/gif', 'reaction.gif')
  const tree = await h.ready(attachment)
  const images = tags(tree, 'img')
  assert.equal(images.length, 2)
  assert.ok(images.every(image => image.props.src === h.created[0].url))
  assert.equal(h.created[0].blob.type, 'image/gif')
  assert.equal(await h.created[0].blob.text(), 'verified media bytes')
  const trigger = tags(tree, 'DialogTrigger')[0]
  assert.equal(trigger.props.asChild, true)
  assert.equal(trigger.props.children.type, 'button')
  assert.equal(trigger.props.children.props['aria-label'], 'Enlarge reaction.gif')
  assert.equal(tags(tree, 'DialogTitle')[0].props.children, 'reaction.gif')
  assert.ok(tags(tree, 'DialogDescription').length)
  const downloads = tags(tree, 'a')
  assert.equal(downloads.length, 2)
  assert.ok(downloads.every(link => link.props.download === 'reaction.gif' && link.props.href === h.created[0].url))
  h.unmount()
  assert.deepEqual(h.revoked, [h.created[0].url])
})

test('supported video containers retain their MIME and expose inline, user-controlled playback', async () => {
  for (const type of ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime']) {
    const h = harness(), attachment = await prepare(h, type, 'clip')
    const tree = await h.ready(attachment)
    const video = tags(tree, 'video')[0]
    assert.equal(h.files.attachmentPreviewKind(type), 'video')
    assert.equal(h.created[0].blob.type, type)
    assert.equal(video.props.src, h.created[0].url)
    assert.equal(video.props.controls, true)
    assert.equal(video.props.playsInline, true)
    assert.equal(video.props.preload, 'metadata')
    assert.equal(video.props.autoPlay, undefined)
    assert.equal(tags(tree, 'a')[0].props.download, 'clip')
    h.unmount()
  }
})

test('decode failures leave the verified original downloadable for images, video and audio', async () => {
  for (const [type, tag] of [['image/png', 'img'], ['video/mp4', 'video'], ['audio/ogg', 'audio']]) {
    const h = harness(), attachment = await prepare(h, type, 'original')
    const tree = await h.ready(attachment)
    tags(tree, tag)[0].props.onError()
    const failed = h.render(attachment)
    assert.equal(tags(failed, tag).length, 0)
    assert.equal(tags(failed, 'Dialog').length, 0)
    assert.equal(nodes(failed, node => node.props?.role === 'status').length, 1)
    assert.equal(tags(failed, 'a')[0].props.href, h.created[0].url)
    assert.equal(h.revoked.length, 0)
    h.unmount()
  }
})

test('incomplete or corrupt media cannot be previewed or downloaded', async () => {
  const h = harness(), attachment = await prepare(h, 'video/mp4', 'clip.mp4')
  const pending = h.render({ ...attachment, chunks: [] })
  assert.equal(tags(pending, 'progress')[0].props.value, 0)
  assert.equal(tags(pending, 'video').length, 0)
  assert.equal(tags(pending, 'a').length, 0)
  assert.equal(h.created.length, 0)
  const corrupt = { ...attachment, metadata: { ...attachment.metadata, sha256: '0'.repeat(64) } }
  const failed = await h.ready(corrupt)
  assert.match(nodes(failed, node => node.props?.role === 'alert')[0].props.children, /integrity/)
  assert.equal(tags(failed, 'a').length, 0)
  assert.equal(h.created.length, 0)
  h.unmount()
})

test('unchanged chunk copies reuse the URL; replacing or removing media revokes it', async () => {
  const h = harness(), attachment = await prepare(h, 'image/png', 'photo.png')
  await h.ready(attachment)
  h.render({ metadata: { ...attachment.metadata }, chunks: attachment.chunks.map(chunk => ({ ...chunk })) })
  assert.equal(h.created.length, 1)
  assert.equal(h.revoked.length, 0)
  const other = await prepare(h, 'video/webm', 'clip.webm')
  const checking = h.render(other)
  assert.equal(tags(checking, 'a').length, 0)
  assert.equal(tags(checking, 'img').length, 0)
  assert.deepEqual(h.revoked, [h.created[0].url])
  for (let attempt = 0; attempt < 100 && h.created.length < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 1))
  assert.equal(tags(h.render(other), 'video')[0].props.src, h.created[1].url)
  h.unmount()
  assert.deepEqual(h.revoked, h.created.map(resource => resource.url))
})

test('unmounting during verification cannot create an orphaned object URL', async () => {
  const h = harness(), attachment = await prepare(h, 'image/png', 'photo.png')
  h.render(attachment)
  h.unmount()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(h.created.length, 0)
})

test('active documents and unlisted media formats remain download-only octet streams', async () => {
  for (const type of ['image/svg+xml', 'text/html', 'application/pdf', 'video/x-msvideo', 'video/not-real']) {
    const h = harness(), attachment = await prepare(h, type, 'file')
    const tree = await h.ready(attachment)
    assert.equal(h.files.attachmentPreviewKind(type), null)
    assert.equal(h.created[0].blob.type, 'application/octet-stream')
    for (const tag of ['img', 'video', 'audio', 'iframe', 'object', 'embed']) assert.equal(tags(tree, tag).length, 0)
    assert.equal(tags(tree, 'a')[0].props.href, h.created[0].url)
    h.unmount()
  }
})
