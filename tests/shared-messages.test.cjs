const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const cache = new Map()
function load(file) {
  if (!path.extname(file)) file += '.ts'
  if (cache.has(file)) return cache.get(file).exports
  const module = { exports: {} }; cache.set(file, module)
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  new Function('require', 'module', 'exports', code)(name => name.startsWith('.') ? load(path.resolve(path.dirname(file), name)) : require(name), module, module.exports)
  return module.exports
}
const sharing = load(path.resolve(__dirname, '../lib/shared-messages.ts'))
const source = { conversationId: 'source-conversation' }
const message = (id, extra = {}) => ({ id, conversationId: source.conversationId, senderPubKey: '04' + 'a'.repeat(128), content: `Text ${id}`, timestamp: 1000, delivery: 'received', pinned: false, deliveredTo: [], readBy: [], ...extra })

test('selection exports only chosen messages in stable chronological order', () => {
  const rows = [message('a'), message('b', { timestamp: 999 }), message('c', { content: 'Not selected' })]
  const bundle = sharing.sharedMessagesFromSelection(rows, source, ['a', 'b'])
  assert.deepEqual(bundle.items.map(row => row.text), ['Text b', 'Text a'])
  assert.equal(JSON.stringify(bundle).includes('Not selected'), false)
  assert.equal(JSON.stringify(bundle).includes(source.conversationId), false)
  assert.equal(bundle.items[0].sender, '04aaaaaaaa…aaaaaaaa')
})

test('private, secret, expired, hidden, pending, failed and nested messages cannot be shared', () => {
  for (const extra of [{ private: true }, { secret: true }, { expiresAt: 1 }, { hidden: true }, { delivery: 'pending' }, { delivery: 'failed' }, { shared: { version: 1, items: [] } }]) {
    assert.throws(() => sharing.sharedMessagesFromSelection([message('a', extra)], source, ['a']), /no longer available/)
  }
})

test('deleted selections and cross-channel selection fail closed', () => {
  assert.throws(() => sharing.sharedMessagesFromSelection([], source, ['gone']), /no longer available/)
  const rows = [message('a', { channelId: 'one' }), message('b', { channelId: 'two' })]
  assert.throws(() => sharing.sharedMessagesFromSelection(rows, { ...source, channelId: 'one' }, ['b']), /no longer available/)
  assert.throws(() => sharing.sharedMessagesFromSelection(rows, source, ['a']), /no longer available/)
})

test('attachment copy never contains capabilities, keys, hashes, chunks or source IDs', () => {
  const bundle = sharing.sharedMessagesFromSelection([message('a', { attachment: {
    id: 'secret-file-id', name: 'notes.pdf', mime: 'application/pdf', size: 50, chunks: 1, sha256: 'secret-hash',
    remote: { capability: 'secret-capability', key: 'secret-key', ivPrefix: 'secret-iv', hashes: ['private-hash'] },
  }, localAlias: 'PRIVATE ALIAS', profile: { bio: 'PRIVATE BIO' } })], source, ['a'])
  assert.deepEqual(bundle.items[0].attachment, { name: 'notes.pdf', mime: 'application/pdf', size: 50 })
  assert.equal(/secret-|private-hash|PRIVATE/.test(JSON.stringify(bundle)), false)
  assert.match(sharing.sharedMessagesFallback(bundle), /File not included/)
})

test('poll snapshot omits voter identities and votes', () => {
  const bundle = sharing.sharedMessagesFromSelection([message('a', { poll: { question: 'When?', options: ['Friday', 'Saturday'], votes: { 'PRIVATE VOTER': 0 } } })], source, ['a'])
  assert.match(bundle.items[0].text, /Friday/)
  assert.equal(JSON.stringify(bundle).includes('PRIVATE VOTER'), false)
})

test('selection has row and fallback text limits with no silent truncation', () => {
  assert.throws(() => sharing.sharedMessagesFromSelection([message('a')], source, []), /Select between/)
  assert.throws(() => sharing.sharedMessagesFromSelection([message('a')], source, ['a', 'a']), /different messages/)
  assert.throws(() => sharing.sharedMessagesFromSelection(Array.from({ length: 21 }, (_, i) => message(String(i))), source, Array.from({ length: 21 }, (_, i) => String(i))), /Select between/)
  assert.throws(() => sharing.sharedMessagesFromSelection([message('a', { content: 'a'.repeat(8000) })], source, ['a']), /too large/)
})

test('untrusted bundles reject extra fields and invalid timestamps or media locators', () => {
  const bundle = sharing.sharedMessagesFromSelection([message('a')], source, ['a'])
  assert.equal(sharing.validSharedMessages(bundle), true)
  for (const update of [{ timestamp: Infinity }, { timestamp: 0 }, { timestamp: 8640000000000001 }, { sender: '<script>' }, { conversationId: 'private' }, { attachment: { name: 'file', mime: 'image/png', size: 1, url: 'https://tracker.test' } }]) {
    assert.equal(sharing.validSharedMessages({ ...bundle, items: [{ ...bundle.items[0], ...update }] }), false)
  }
  assert.equal(sharing.validSharedMessages({ ...bundle, source: 'hidden' }), false)
})
