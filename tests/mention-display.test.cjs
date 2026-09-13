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
const { partitionMentionText, formatMentionText } = source(path.join(root, 'lib/mention-display.ts'))
const { RichMessage } = source(path.join(root, 'components/chat/rich-message.tsx'))
const { shortAddress } = source(path.join(root, 'lib/identity.ts'))
const alice = '0419b40a' + 'a'.repeat(116) + 'ca5883'
const bob = '04' + 'b'.repeat(128)
const sameShort = '0419b40a' + 'c'.repeat(116) + 'ca5883'
const displayName = key => key === alice ? 'Private Me' : 'Bob'

test('full and legacy shortened mentions use the viewer label with punctuation, newlines, and repetition', () => {
  const text = `(@${alice}),\n@${shortAddress(alice)}! @${shortAddress(alice).replace('…', '...')}? @${bob}; @${alice.toUpperCase()}`
  assert.equal(formatMentionText(text, [alice, bob], displayName), '(@Private Me),\n@Private Me! @Private Me? @Bob; @Private Me')
  assert.deepEqual(partitionMentionText(`Hi @${alice}!`, [alice], displayName), [
    { text: 'Hi ' }, { text: '@Private Me', publicKey: alice }, { text: '!' },
  ])
})

test('missing recipient metadata, unknown addresses, empty labels, and name tokens stay literal', () => {
  const text = `@${alice} @${shortAddress(alice)} @Someone`
  assert.equal(formatMentionText(text, undefined, displayName), text)
  assert.equal(formatMentionText(text, [bob], displayName), text)
  assert.equal(formatMentionText(text, [alice]), text)
  assert.equal(formatMentionText(text, [alice], () => ''), text)
  assert.equal(formatMentionText('@not-a-key', ['not-a-key'], displayName), '@not-a-key')
})

test('email-like text, extended address tokens, and URL paths cannot be misidentified as mentions', () => {
  const text = `mail@${alice} @@${alice} @${alice}a @${alice}_suffix @${alice}-suffix @${shortAddress(alice)}f https://example.com/path/@${alice}`
  assert.equal(formatMentionText(text, [alice], displayName), text)
})

test('colliding legacy short addresses stay literal while full addresses remain distinct', () => {
  const text = `@${shortAddress(alice)} @${shortAddress(alice).replace('…', '...')} @${alice} @${sameShort}`
  assert.equal(formatMentionText(text, [alice, sameShort, alice], displayName), `@${shortAddress(alice)} @${shortAddress(alice).replace('…', '...')} @Private Me @Bob`)
  assert.equal(formatMentionText(`@${shortAddress(alice)}`, [alice, alice], displayName), '@Private Me')
})

test('plain-text previews preserve code, all math delimiters, and URLs', () => {
  const token = `@${alice}`
  const protectedText = `\`${token}\`\n\`\`\`txt\n${token}\n\`\`\`\n$${token}$ $$${token}$$ \\(${token}\\) \\[${token}\\]\nhttps://example.com/?q=${token}`
  assert.equal(formatMentionText(`${protectedText}\n${token}`, [alice], displayName), `${protectedText}\n@Private Me`)
})

test('local names render as literal React text, including HTML, URL, math, and mention-shaped names', () => {
  const name = `<img src=x onerror=alert(1)> https://private.invalid $x^2$ @${bob}`
  const html = renderToStaticMarkup(React.createElement(RichMessage, { text: `@${alice}`, mentions: [alice, bob], displayName: () => name }))
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.ok(html.includes(`https://private.invalid $x^2$ @${bob}`))
  assert.doesNotMatch(html, /<img|<a |class="katex"/)
  assert.equal((html.match(/bg-primary\/10/g) || []).length, 1)
})

test('rich rendering replaces ordinary text only, preserving code, math, URL targets, and search highlighting', () => {
  const token = `@${alice}`
  const html = renderToStaticMarkup(React.createElement(RichMessage, {
    text: `${token}\n\`${token}\`\n\`\`\`text\n${token}\n\`\`\`\n$\\text{${token}}$ https://example.com/${token}`,
    mentions: [alice], displayName, highlight: 'Private',
  }))
  assert.match(html, /<mark[^>]*>Private<\/mark>/)
  assert.equal((html.match(/bg-primary\/10/g) || []).length, 1)
  assert.ok(html.includes(`href="https://example.com/${token}"`))
  assert.ok(html.includes(`<code>${token}</code>`))
  assert.match(html, /class="katex"/)
  assert.ok(html.includes(`\\text{${token}}`))
})
