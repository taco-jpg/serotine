/* Real public-key validation and local QR encoder/decoder interoperability. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { test, before } = require('node:test')
const root = path.resolve(__dirname, '..')
const repoRequire = createRequire(path.join(root, 'package.json'))
const ts = repoRequire('typescript')
const QRCode = repoRequire('qrcode')
const jsQR = repoRequire('jsqr')
const cache = new Map()
function load(filename) {
  if (!path.extname(filename)) filename += '.ts'
  if (cache.has(filename)) return cache.get(filename).exports
  const module = { exports: {} }
  cache.set(filename, module)
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  const requireSource = specifier => specifier.startsWith('.') ? load(path.resolve(path.dirname(filename), specifier))
    : specifier.startsWith('@/') ? load(path.join(root, specifier.slice(2))) : repoRequire(specifier)
  new Function('require', 'module', 'exports', output)(requireSource, module, module.exports)
  return module.exports
}
const { parseContactCode } = load(path.join(root, 'lib/contact-code.ts'))
let identity, anotherPublicKey
before(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey'])
  identity = { publicKey: Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('hex'), privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey) }
  const another = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey'])
  anotherPublicKey = Buffer.from(await crypto.subtle.exportKey('raw', another.publicKey)).toString('hex')
})

test('public address scans retain the full key and normalize pasted whitespace/case', async () => {
  assert.equal(await parseContactCode(identity.publicKey), identity.publicKey)
  assert.equal(await parseContactCode(` \n${identity.publicKey.toUpperCase()}\t`), identity.publicKey)
})

test('HTTP(S) invite links extract the public address without requiring their host', async () => {
  for (const base of ['https://serotine.example/chat', 'http://localhost:3000/chat', 'https://a-different-host.example/anything']) {
    assert.equal(await parseContactCode(`${base}#invite=${identity.publicKey}`), identity.publicKey)
  }
  assert.equal(await parseContactCode(`https://serotine.example/chat#invite=${identity.publicKey.toUpperCase()}`), identity.publicKey)
})

test('malformed keys and syntactically valid points outside P-256 are rejected', async () => {
  for (const value of ['04' + '0'.repeat(128), '04' + 'f'.repeat(128), identity.publicKey.slice(2), identity.publicKey.slice(0, -2), '03' + identity.publicKey.slice(2), identity.publicKey + '00']) {
    await assert.rejects(parseContactCode(value), undefined, value.slice(0, 24))
    await assert.rejects(parseContactCode(`https://serotine.example/chat#invite=${value}`))
  }
})

test('QR content cannot be interpreted as executable URLs, JSON backups, or arbitrary text', async () => {
  for (const value of ['', 'a public address', '#invite=' + identity.publicKey,
    'https://serotine.example/chat?invite=' + identity.publicKey,
    'https://serotine.example/chat#other=' + identity.publicKey,
    `https://serotine.example/chat#invite=${identity.publicKey}&invite=${identity.publicKey}`,
    `https://serotine.example/chat#invite=${identity.publicKey}&invite=${anotherPublicKey}`,
    'javascript:alert(1)#invite=' + identity.publicKey,
    'data:text/html,hello#invite=' + identity.publicKey,
    'file:///tmp/chat#invite=' + identity.publicKey,
    JSON.stringify(identity.privateKey), JSON.stringify(identity),
    'x'.repeat(2049), 'https://serotine.example/' + 'x'.repeat(2048) + '#invite=' + identity.publicKey]) {
    await assert.rejects(parseContactCode(value))
  }
})

test('locally encoded QR pixels decode to the exact address and complete invite link', async () => {
  for (const value of [identity.publicKey, `https://serotine.example/chat#invite=${identity.publicKey}`]) {
    const { modules } = QRCode.create(value, { errorCorrectionLevel: 'M' })
    const margin = 4, scale = 6, size = (modules.size + margin * 2) * scale
    const pixels = new Uint8ClampedArray(size * size * 4).fill(255)
    for (let y = 0; y < modules.size; y++) for (let x = 0; x < modules.size; x++) {
      if (!modules.get(y, x)) continue
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const offset = (((y + margin) * scale + dy) * size + (x + margin) * scale + dx) * 4
        pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0
      }
    }
    const decoded = jsQR(pixels, size, size)
    assert.equal(decoded?.data, value, 'the QR contains the complete original string, not a shortened identifier')
    assert.equal(await parseContactCode(decoded.data), identity.publicKey)
  }
})
