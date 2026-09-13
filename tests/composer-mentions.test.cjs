const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const source = fs.readFileSync(path.join(__dirname, '../lib/composer-mentions.ts'), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const loaded = { exports: {} }
new Function('exports', compiled)(loaded.exports)
const { findMentionQuery, insertMention, updateMentionSpans, validMentionSpans, serializeMentionDraft } = loaded.exports

test('mention completion follows the caret, supports Unicode names, and leaves emails alone', () => {
  assert.deepEqual(findMentionQuery('Hello @Zoë tail', 10), { start: 6, end: 10, query: 'Zoë' })
  assert.deepEqual(findMentionQuery('@', 1), { start: 0, end: 1, query: '' })
  assert.equal(findMentionQuery('mail@example.com', 16), null)
  assert.equal(findMentionQuery('Hi @Bob', 7, 3), null)
  assert.equal(findMentionQuery('Hi @Bob ', 8), null)
})

test('selection replaces just the query, keeps following text, and targets the selected key', () => {
  const value = insertMention('Hi @Al, how are you?', { start: 3, end: 6 }, 'alice-key', 'Alice Doe')
  assert.equal(value.content, 'Hi @Alice Doe , how are you?')
  assert.equal(value.content.slice(value.span.start, value.span.end), '@Alice Doe')
  assert.equal(value.span.publicKey, 'alice-key')
  const duplicateName = insertMention('', { start: 0, end: 0 }, 'different-key', 'Alice Doe')
  assert.equal(duplicateName.span.publicKey, 'different-key')
})

test('edits before a mention move it; token edits and deletion remove its notification target', () => {
  const { content, span } = insertMention('Hi ', { start: 3, end: 3 }, 'alice', 'Alice')
  const shifted = updateMentionSpans(content, 'Again: ' + content, [span])
  assert.equal(shifted[0].start, span.start + 7)
  assert.deepEqual(updateMentionSpans(content, content.replace('@Alice', '@Alicia'), [span]), [])
  assert.deepEqual(updateMentionSpans(content, 'Hi ', [span]), [])
  assert.deepEqual(updateMentionSpans(content, content.replace('@Alice', '@Alicex'), [span]), [])
  assert.equal(validMentionSpans(content + 'hello', [span]).length, 1)
})

test('inserting immediately before a token preserves it only with a word boundary', () => {
  const { content, span } = insertMention('', { start: 0, end: 0 }, 'alice', 'Alice')
  assert.equal(updateMentionSpans(content, 'Hello ' + content, [span])[0].start, 6)
  assert.deepEqual(updateMentionSpans(content, 'email' + content, [span]), [])
})

test('deleting either duplicate alias keeps only the selected identity when the exact edit is known', () => {
  const first = insertMention('', { start: 0, end: 0 }, 'first-alice', 'Alice')
  const second = insertMention(first.content, { start: first.content.length, end: first.content.length }, 'second-alice', 'Alice')
  const spans = [first.span, second.span]
  assert.deepEqual(updateMentionSpans(second.content, first.content, spans, { start: 0, end: 7 }), [{ ...second.span, start: 0, end: 6 }])
  assert.deepEqual(updateMentionSpans(second.content, first.content, spans, { start: 7, end: 14 }), [first.span])
  assert.deepEqual(updateMentionSpans(second.content, first.content, spans), [])
})

test('ambiguous repeated-text insertion cannot move a recipient to an unselected token', () => {
  const first = insertMention('', { start: 0, end: 0 }, 'first-alice', 'Alice')
  const doubled = first.content + first.content
  assert.deepEqual(updateMentionSpans(first.content, doubled, [first.span]), [])
  assert.deepEqual(updateMentionSpans(first.content, doubled, [first.span], { start: 0, end: 0 }), [{ ...first.span, start: 7, end: 13 }])
  assert.deepEqual(updateMentionSpans(first.content, first.content + ' ', [first.span]), [first.span])
})

test('replacing a selected mention with identical ordinary text removes its target', () => {
  const { content, span } = insertMention('', { start: 0, end: 0 }, 'alice', 'Alice')
  assert.deepEqual(updateMentionSpans(content, content, [span], { start: 0, end: 6 }), [])
  assert.deepEqual(updateMentionSpans(content, 'Hello ' + content, [span], { start: 100, end: 101 }), [{ ...span, start: 6, end: 12 }])
})

test('sending selected mentions replaces local labels with addresses without changing ordinary text', () => {
  const first = insertMention('Hello ', { start: 6, end: 6 }, 'alice-public-key', 'Private Alice')
  const second = insertMention(first.content, { start: first.content.length, end: first.content.length }, 'bob-public-key', 'Private Bob')
  const text = second.content + 'meet at 4; @ordinary remains'
  const wire = serializeMentionDraft(text, [second.span, first.span])
  assert.equal(wire.content, 'Hello @alice-public-key @bob-public-key meet at 4; @ordinary remains')
  assert.deepEqual(wire.mentions, ['alice-public-key', 'bob-public-key'])
  assert.equal(wire.content.includes('Private'), false)
  assert.equal(text.includes('@Private Alice'), true, 'the draft is unchanged')
})

test('serialization leaves edited tokens alone and deduplicates repeated recipients', () => {
  const first = insertMention('', { start: 0, end: 0 }, 'alice-key', 'Alice')
  const second = insertMention(first.content, { start: first.content.length, end: first.content.length }, 'alice-key', 'Alice')
  assert.deepEqual(serializeMentionDraft(second.content, [first.span, second.span]), { content: '@alice-key @alice-key ', mentions: ['alice-key'] })
  assert.deepEqual(serializeMentionDraft('@Alicia ', [first.span]), { content: '@Alicia ', mentions: [] })
})
