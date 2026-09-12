const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')

const modules = new Map()
function load(relative) {
  const filename = path.resolve(__dirname, '..', relative.endsWith('.ts') ? relative : `${relative}.ts`)
  if (modules.has(filename)) return modules.get(filename).exports
  const module = { exports: {} }
  modules.set(filename, module)
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  new Function('require', 'module', 'exports', code)(
    specifier => specifier.startsWith('.') ? load(path.resolve(path.dirname(filename), specifier)) : require(specifier),
    module, module.exports,
  )
  return module.exports
}
const files = load('lib/attachments')
const protocol = load('lib/protocol')
const cryptoFunctions = load('lib/crypto')
function attachment(data = Buffer.from('notes\n你好')) {
  return { name: 'notes.txt', type: 'text/plain', size: data.length, data: data.toString('base64') }
}
function envelope(attachments) {
  return { version: attachments ? 3 : 2, id: crypto.randomUUID(), sender: 'alice', recipient: 'bob',
    timestamp: Date.now(), content: attachments ? '' : 'hello', ...(attachments ? { attachments } : {}) }
}

test('file selection and download preserve every byte including binary and empty files', async () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from([0]), Buffer.from([0, 255]), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]) {
    const result = await files.fileToAttachment(new File([bytes], 'test.bin'))
    assert.equal(files.validateAttachments([result]), true)
    assert.deepEqual(Buffer.from(await files.attachmentToBlob(result).arrayBuffer()), bytes)
  }
})

test('attachment envelopes support captionless files and preserve text v2 compatibility', () => {
  const file = envelope([attachment()])
  assert.equal(protocol.isEnvelope(file, 'alice', 'bob'), true)
  assert.equal(protocol.isEnvelope(envelope(), 'alice', 'bob'), true)
  assert.equal(protocol.isEnvelope({ ...file, content: 'A caption' }, 'alice', 'bob'), true)
  for (const bad of [{ ...file, version: 2 }, { ...file, attachments: [] }, { ...file, attachments: null },
    { ...file, version: 4 }, { ...envelope(), content: '  ' }, { ...file, recipient: 'elsewhere' },
    { ...file, timestamp: Date.now() + 120000 }]) {
    assert.equal(protocol.isEnvelope(bad, 'alice', 'bob'), false)
  }
})

test('reject malformed metadata, misleading sizes, noncanonical base64, and aggregate overflow', () => {
  const one = attachment(Buffer.from('a'))
  for (const bad of [null, {}, 'file', { ...one, size: -1 }, { ...one, size: 1.5 },
    { ...one, size: 2 }, { ...one, data: 'YQ=' }, { ...one, data: 'YR==' },
    { ...one, data: 'YQ=\n' }, { ...one, name: '../file' }, { ...one, name: 'bad\u202etxt.exe' },
    { ...one, type: 'text/html\r\n' }, { ...one, extra: 'unbounded metadata' }]) {
    assert.equal(files.validateAttachments([bad]), false, JSON.stringify(bad))
  }
  assert.equal(files.validateAttachments([attachment(Buffer.alloc(2))]), true)
  assert.equal(files.validateAttachments([{ ...attachment(Buffer.alloc(2)), data: 'AAB=' }]), false)
  assert.equal(files.validateAttachments(Array(5).fill(one)), false)
  const half = attachment(Buffer.alloc(files.MAX_ATTACHMENT_BYTES / 2))
  assert.equal(files.validateAttachments([half, half]), true)
  assert.equal(files.validateAttachments([half, half, one]), false)
})

test('file input sanitizes path/control names and oversized files fail before reading', async () => {
  const result = await files.fileToAttachment(new File(['a'], '../bad\u0000\u202e.txt', { type: 'text/plain' }))
  assert.equal(files.validateAttachments([result]), true)
  for (const character of ['/', '\u0000', '\u202e']) assert.equal(result.name.includes(character), false)
  let read = false
  await assert.rejects(files.fileToAttachment({ size: files.MAX_ATTACHMENT_BYTES + 1, async arrayBuffer() { read = true } }), /1 MiB/)
  assert.equal(read, false)
})

test('HTML and SVG remain download-only even when mislabeled as a raster image', async () => {
  const svg = attachment(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'))
  for (const type of ['image/svg+xml', 'image/png', 'text/html']) {
    assert.equal(files.isPreviewableImage({ ...svg, type }), false)
    assert.equal(files.attachmentToBlob({ ...svg, type }).type, 'application/octet-stream')
  }
  const png = { ...attachment(Buffer.from('89504e470d0a1a0a00000000', 'hex')), type: 'image/png' }
  assert.equal(files.isPreviewableImage(png), true)
  assert.equal(files.attachmentToBlob(png).type, 'image/png')
})

test('largest permitted files and a worst-case caption fit inside the encrypted packet budget', async () => {
  const alice = await cryptoFunctions.generateEncryptionKeyPair()
  const bob = await cryptoFunctions.generateEncryptionKeyPair()
  const sender = await cryptoFunctions.exportPublicKeyToHex(alice.publicKey)
  const recipient = await cryptoFunctions.exportPublicKeyToHex(bob.publicKey)
  const attachments = Array.from({ length: 4 }, (_, i) => ({
    ...attachment(Buffer.alloc(files.MAX_ATTACHMENT_BYTES / 4, i)), name: '界'.repeat(180),
  }))
  const message = { ...envelope(attachments), sender, recipient, content: '\u0000'.repeat(protocol.MAX_MESSAGE_LENGTH) }
  assert.equal(protocol.isEnvelope(message, sender, recipient), true)
  const encrypted = await cryptoFunctions.encryptForPeer(JSON.stringify(message), alice.privateKey, recipient)
  assert.ok(Buffer.byteLength(encrypted) <= protocol.MAX_PACKET_LENGTH)
  const decrypted = JSON.parse(await cryptoFunctions.decryptFromPeer(encrypted, bob.privateKey, sender))
  assert.deepEqual(decrypted, message)
  assert.equal(protocol.isEnvelope(decrypted, sender, recipient), true)
})
