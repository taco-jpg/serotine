const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
const cache = new Map()
function source(filename) {
  if (!path.extname(filename)) filename += '.ts'
  if (cache.has(filename)) return cache.get(filename).exports
  const module = { exports: {} }
  cache.set(filename, module)
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  new Function('require', 'module', 'exports', compiled)(specifier => {
    if (specifier.startsWith('.')) return source(path.resolve(path.dirname(filename), specifier))
    return require(specifier)
  }, module, module.exports)
  return module.exports
}
const { compactAttachment, MAX_COMPACT_INPUT_BYTES } = source(path.join(root, 'lib/compact-attachment.ts'))
const { MAX_FILE_BYTES, prepareAttachment, assembleAttachment } = source(path.join(root, 'lib/attachments.ts'))

test('lossless compacted file round-trips through the normal attachment protocol and gzip', async () => {
  const bytes = Buffer.from('Calculus notes: ∫ f(x) dx\r\n\0'.repeat(5000))
  const original = new File([bytes], 'notes.txt', { type: 'text/plain', lastModified: 123456 })
  const result = await compactAttachment(original, true)
  assert.equal(result.compacted, true)
  assert.equal(result.originalBytes, original.size)
  assert.equal(result.file.name, 'notes.txt.gz')
  assert.equal(result.file.type, 'application/gzip')
  assert.equal(result.file.lastModified, original.lastModified)
  assert.ok(result.file.size <= original.size * 0.95)
  const { metadata, chunks } = await prepareAttachment(result.file)
  const received = await assembleAttachment(metadata, chunks)
  const decoded = await new Response(received.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
  assert.deepEqual(Buffer.from(decoded), bytes)
})

test('disabled, tiny, incompressible and already compressed files keep their original format', async () => {
  const ordinary = new File(['x'.repeat(100000)], 'notes.txt')
  assert.equal((await compactAttachment(ordinary, false)).file, ordinary)
  for (const file of [
    new File(['hello'], 'small.txt'),
    new File([randomBytes(2 * 1024 * 1024)], 'random.bin'),
    new File(['x'.repeat(100000)], 'photo.PNG'),
    new File(['x'.repeat(100000)], 'archive.zip'),
    new File(['x'.repeat(100000)], 'unknown', { type: 'audio/wav' }),
  ]) {
    const result = await compactAttachment(file, true)
    assert.equal(result.compacted, false)
    assert.equal(result.file, file)
  }
})

test('source size is bounded before reading and files at the send cap may be compacted', async () => {
  const tooBig = { size: MAX_COMPACT_INPUT_BYTES + 1, name: 'huge.txt', stream() { assert.fail('must not read oversized file') } }
  await assert.rejects(compactAttachment(tooBig, true), /50 MB/)
  const large = new File([new Uint8Array(MAX_COMPACT_INPUT_BYTES)], 'large.dat')
  const compacted = await compactAttachment(large, true)
  assert.equal(compacted.compacted, true)
  assert.ok(compacted.file.size <= MAX_FILE_BYTES)
  assert.equal(compacted.originalBytes, MAX_COMPACT_INPUT_BYTES)
  const decoded = await new Response(compacted.file.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
  assert.equal(decoded.byteLength, MAX_COMPACT_INPUT_BYTES)
  assert.equal(new Uint8Array(decoded).every(byte => byte === 0), true)
  assert.equal((await compactAttachment(large, false)).file, large)
  await assert.rejects(compactAttachment({ size: MAX_FILE_BYTES + 1, name: 'random.bin', stream() { assert.fail('must not read oversized file') } }, true), /50 MB/)
  await assert.rejects(compactAttachment({ size: MAX_FILE_BYTES + 1, name: 'photo.png', stream() { assert.fail('must not read oversized file') } }, true), /50 MB/)
  const exactCap = new File([new Uint8Array(MAX_FILE_BYTES)], 'archive.zip')
  assert.equal((await compactAttachment(exactCap, true)).file, exactCap)
})

test('unsupported or failing browser compression falls back only within the ordinary file limit', async () => {
  const available = globalThis.CompressionStream
  const ordinary = new File(['x'.repeat(100000)], 'notes.txt')
  const oversized = { size: MAX_FILE_BYTES + 1, name: 'large.dat', stream() { assert.fail('must not read oversized file') } }
  try {
    for (const unsupported of [undefined, class BrokenCompression { constructor() { throw new Error('Unavailable') } }]) {
      globalThis.CompressionStream = unsupported
      assert.equal((await compactAttachment(ordinary, true)).file, ordinary)
      await assert.rejects(compactAttachment(oversized, true), /50 MB/)
    }
  } finally { globalThis.CompressionStream = available }
})

test('compacted filenames remain safe and keep a visible gzip extension', async () => {
  const result = await compactAttachment(new File(['x'.repeat(100000)], `../../${'a'.repeat(170)}.txt`), true)
  assert.ok(result.file.name.length <= 160)
  assert.match(result.file.name, /\.gz$/)
  assert.doesNotMatch(result.file.name, /[\\/]/)
})
