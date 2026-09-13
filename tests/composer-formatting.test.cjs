const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
function load(name) {
  const source = fs.readFileSync(path.join(__dirname, `../lib/${name}.ts`), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const loaded = { exports: {} }
  new Function('exports', compiled)(loaded.exports)
  return loaded.exports
}
const { insertFormattedContent } = load('composer-formatting')
const { insertMention, updateMentionSpans } = load('composer-mentions')

test('formatting replaces only selected text and leaves the caret after a complete block', () => {
  const result = insertFormattedContent('Before formula after', { start: 7, end: 14 }, '\\[x^2\\]', true, 100)
  assert.deepEqual(result, { content: 'Before \n\\[x^2\\]\n after', caret: 16, start: 7, end: 14 })
  assert.equal(result.content.slice(result.caret), ' after')
  const inline = insertFormattedContent('It is value.', { start: 6, end: 11 }, '\\(x\\)', false, 100)
  assert.equal(inline.content, 'It is \\(x\\).')
})

test('block insertion uses existing newlines without blank-line growth', () => {
  const block = '```js\n1\n```'
  const middle = insertFormattedContent('before\n\nafter', { start: 7, end: 7 }, block, true, 100)
  assert.equal(middle.content, `before\n${block}\nafter`)
  assert.equal(middle.content.slice(middle.caret), 'after')
  const empty = insertFormattedContent('', { start: 0, end: 0 }, block, true, 100)
  assert.equal(empty.content, block + '\n')
  assert.equal(empty.caret, empty.content.length)
})

test('formatting respects the final message budget without silently cutting source or trailing text', () => {
  const exact = insertFormattedContent('replace', { start: 0, end: 7 }, '\\(x\\)', false, 5)
  assert.equal(exact.content, '\\(x\\)')
  assert.throws(() => insertFormattedContent('replace', { start: 0, end: 7 }, '\\[x\\]', true, 5), /not enough room/)
  assert.throws(() => insertFormattedContent('keep', { start: 1, end: 1 }, 'too long', false, 8), /not enough room/)
  for (const range of [{ start: -1, end: 0 }, { start: 2, end: 1 }, { start: 0, end: 5 }, { start: 0.5, end: 1 }]) {
    assert.throws(() => insertFormattedContent('keep', range, 'x', false, 8), /selection changed/)
  }
})

test('formatting keeps distinct mention recipients when another identical label is replaced', () => {
  const first = insertMention('', { start: 0, end: 0 }, 'first-alice', 'Alice')
  const second = insertMention(first.content, { start: first.content.length, end: first.content.length }, 'second-alice', 'Alice')
  const inserted = insertFormattedContent(second.content, { start: 0, end: first.content.length }, '\\[x\\]', true, 100)
  const spans = updateMentionSpans(second.content, inserted.content, [first.span, second.span], inserted)
  assert.equal(spans.length, 1)
  assert.equal(spans[0].publicKey, 'second-alice')
  assert.equal(inserted.content.slice(spans[0].start, spans[0].end), '@Alice')
})
