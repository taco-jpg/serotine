const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const root = path.resolve(__dirname, '..')
const cache = new Map()
function source(filename) {
  if (!path.extname(filename)) filename += fs.existsSync(filename + '.tsx') ? '.tsx' : '.ts'
  if (cache.has(filename)) return cache.get(filename).exports
  const module = { exports: {} }
  cache.set(filename, module)
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText
  new Function('require', 'module', 'exports', compiled)(specifier => {
    if (specifier.endsWith('.css')) return {}
    if (specifier.startsWith('@/')) return source(path.join(root, specifier.slice(2)))
    if (specifier.startsWith('.')) return source(path.resolve(path.dirname(filename), specifier))
    return require(specifier)
  }, module, module.exports)
  return module.exports
}
const files = source(path.join(root, 'lib/attachments.ts'))
const { RichMessage } = source(path.join(root, 'components/chat/rich-message.tsx'))

test('maximum-size binary file survives out-of-order encrypted-event chunk transport', async () => {
  const data = Uint8Array.from({ length: files.MAX_FILE_BYTES }, (_, index) => index % 251)
  const file = new File([data], 'homework.zip', { type: 'application/zip' })
  const { metadata, chunks } = await files.prepareAttachment(file)
  assert.equal(files.isAttachmentMeta(metadata), true)
  assert.equal(chunks.length, 69)
  assert.ok(chunks.every(chunk => chunk.data.length <= 40960))
  assert.equal(files.attachmentProgress(metadata, chunks.slice(0, 1)), 1)
  const blob = await files.assembleAttachment(metadata, chunks.toReversed())
  assert.equal(blob.type, 'application/octet-stream')
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), data)
})

test('zero-byte files round-trip and files above the cap are rejected before reading', async () => {
  const { metadata, chunks } = await files.prepareAttachment(new File([], 'empty.txt'))
  assert.equal(chunks.length, 1)
  assert.equal((await files.assembleAttachment(metadata, chunks)).size, 0)
  await assert.rejects(files.prepareAttachment({ size: files.MAX_FILE_BYTES + 1, name: 'large.zip', arrayBuffer() { assert.fail('must not read oversized file') } }), /2 MB/)
})

test('missing, tampered, conflicting and oversized chunks never produce a download', async () => {
  const { metadata, chunks } = await files.prepareAttachment(new File(['safe file'], 'test.txt'))
  await assert.rejects(files.assembleAttachment(metadata, []), /still arriving/)
  await assert.rejects(files.assembleAttachment(metadata, [{ index: 0, data: btoa('evil file') }]), /integrity/)
  await assert.rejects(files.assembleAttachment(metadata, [chunks[0], { index: 0, data: btoa('evil file') }]), /conflicting/)
  await assert.rejects(files.assembleAttachment(metadata, [{ index: 0, data: 'A'.repeat(41000) }]), /invalid piece/)
  await assert.rejects(files.assembleAttachment({ ...metadata, chunks: 100000 }, chunks), /invalid details/)
  await assert.rejects(files.assembleAttachment(metadata, [{ index: 1, data: chunks[0].data }]), /invalid piece/)
})

test('dangerous filenames and active document types stay safe download-only files', async () => {
  assert.equal(files.safeFilename('../../homework.txt'), 'homework.txt')
  assert.equal(files.safeFilename('C:\\Documents\\work.txt'), 'work.txt')
  assert.equal(files.safeFilename('CON.txt'), 'attachment-CON.txt')
  assert.ok(!files.safeFilename('report\u202Egnp.exe').includes('\u202E'))
  for (const mime of ['image/svg+xml', 'text/html', 'application/pdf', 'application/xhtml+xml']) {
    assert.equal(files.attachmentPreviewKind(mime), null)
    const { metadata, chunks } = await files.prepareAttachment(new File(['<script>alert(1)</script>'], 'test', { type: mime }))
    assert.equal((await files.assembleAttachment(metadata, chunks)).type, 'application/octet-stream')
  }
})

test('attachment send queues every piece before publishing metadata and preserves reply target', async () => {
  const events = [], progress = []
  const id = await files.sendAttachment(async (conversation, kind, payload) => {
    events.push({ conversation, kind, payload }); return 'message-id'
  }, 'self', new File(['hello'], 'note.txt'), 'file', percent => progress.push(percent), 'original-message')
  assert.equal(id, 'message-id')
  assert.deepEqual(events.map(event => event.kind), ['attachment-chunk', 'attachment'])
  assert.equal(events[0].payload.attachmentId, events[1].payload.attachment.id)
  assert.equal(events[1].payload.replyTo, 'original-message')
  assert.equal(progress.at(-1), 100)
  const failedKinds = []
  await assert.rejects(files.sendAttachment(async (_conversation, kind) => {
    failedKinds.push(kind); throw new Error('Storage full')
  }, 'self', new File(['hello'], 'note.txt')), /Storage full/)
  assert.deepEqual(failedKinds, ['attachment-chunk'])
})

test('rich messages typeset math, escape raw HTML and code, and preserve search highlighting', () => {
  const html = renderToStaticMarkup(React.createElement(RichMessage, {
    text: 'Hello $x^2$\n<script>alert(1)</script>\n```python\nprint("<img src=x onerror=alert(1)>")\n```', highlight: 'Hello',
  }))
  assert.match(html, /class="katex"/)
  assert.match(html, /<mark[^>]*>Hello<\/mark>/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.doesNotMatch(html, /<script|<img/)
})

test('rich links allow only http(s) and untrusted KaTeX commands cannot emit active links or images', () => {
  const html = renderToStaticMarkup(React.createElement(RichMessage, {
    text: 'https://example.com/a?q=1&b=2. javascript:alert(1) $\\href{javascript:alert(1)}{click}$ $\\includegraphics{https://evil.test/x}$',
  }))
  assert.match(html, /href="https:\/\/example.com\/a\?q=1&amp;b=2"/)
  assert.match(html, /rel="noopener noreferrer"/)
  assert.doesNotMatch(html, /href="javascript:|<img|src="https:\/\/evil/)
})
