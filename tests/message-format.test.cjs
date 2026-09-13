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
const { serializeMath, serializeCode, parseMessageFormatting, hasRichFormatting } = source(path.join(root, 'lib/message-format.ts'))
const { RichMessage, MathPreview } = source(path.join(root, 'components/chat/rich-message.tsx'))
const { formatMentionText } = source(path.join(root, 'lib/mention-display.ts'))
const render = (text, props = {}) => renderToStaticMarkup(React.createElement(RichMessage, { text, ...props }))

test('ordinary prices and single dollars remain literal in received messages and live previews', () => {
  for (const text of ['no it doesnt cost $4 it costs $5', '$4.99 + $5.00', 'Give me $5\nand $6', '$x^2$', 'escaped \\$4 and \\$5']) {
    assert.equal(hasRichFormatting(text), false)
    assert.doesNotMatch(render(text), /class="katex"/)
    assert.ok(render(text, { preview: true }).includes(text))
  }
})

test('math buttons produce explicit inline and display formulas while old double-dollar math remains readable', () => {
  const text = [serializeMath('x^2', false), serializeMath('\\frac{1}{2}'), '$$y^2$$'].join('\n')
  const parts = parseMessageFormatting(text).filter(part => part.kind === 'math')
  assert.deepEqual(parts.map(part => [part.text, part.display]), [['x^2', false], ['\\frac{1}{2}', true], ['y^2', true]])
  assert.equal((render(text).match(/class="katex"/g) || []).length, 3)
  assert.equal(hasRichFormatting(text), true)
  assert.equal(parseMessageFormatting(text).map(part => part.source).join(''), text)
})

test('code button preserves pasted fences, trailing newlines, math, and HTML as literal code', () => {
  for (const code of ['```js\nconst value = "$4"\n```\n\\[x^2\\]\n<script>bad()</script>', '``````', 'line\n', '']) {
    const text = serializeCode(code, 'typescript')
    const parts = parseMessageFormatting(text)
    assert.equal(parts.length, 1)
    assert.equal(parts[0].kind, 'code')
    assert.equal(parts[0].text, code)
    assert.equal(parts[0].language, 'typescript')
    assert.equal(parts[0].source, text)
    assert.doesNotMatch(render(text), /class="katex"|<script>/)
  }
  assert.equal(parseMessageFormatting(serializeCode('x', '"><script>'))[0].language, 'code')
})

test('math preview shows parse errors without executing HTML or untrusted math commands', () => {
  const text = serializeMath('\\frac{x}{')
  assert.match(render(text, { preview: true }), /LaTeX error:/)
  assert.match(render(text, { preview: true }), /role="status"/)
  assert.doesNotMatch(render(text), /LaTeX error:/)
  assert.ok(render(text).includes(text))
  const dangerous = serializeMath('\\href{javascript:alert(1)}{click} \\includegraphics{https://evil.test/x}')
  assert.doesNotMatch(render(dangerous, { preview: true }), /href="javascript:|<img|src="https:\/\/evil/)
  const html = renderToStaticMarkup(React.createElement(MathPreview, { expression: '\\bad{<script>bad()</script>}' }))
  assert.match(html, /LaTeX error:/)
  assert.doesNotMatch(html, /<script>/)
})

test('math input cannot silently close its delimiter and expansion work is bounded per message', () => {
  assert.throws(() => serializeMath('x \\] more'), /without its surrounding/)
  assert.throws(() => serializeMath('x \\) more', false), /without its surrounding/)
  assert.throws(() => serializeMath('x'.repeat(2001)), /2001 characters/)
  assert.throws(() => serializeMath('x'.repeat(1001), false), /1001 characters/)
  assert.equal(parseMessageFormatting(serializeMath('x'.repeat(2000)))[0].kind, 'math')
  const many = Array.from({ length: 70 }, () => `${serializeMath('x', false)}\n${serializeCode('x')}`).join('\n')
  assert.equal((render(many).match(/class="katex"/g) || []).length, 64)
})

test('draft preview leaves GIF URLs as links and makes no media preview component', () => {
  const text = `${serializeMath('x')} https://giphy.com/gifs/3oEjI6SIIHBdRxXI40`
  const html = render(text, { preview: true })
  assert.match(html, /href="https:\/\/giphy.com\/gifs\/3oEjI6SIIHBdRxXI40"/)
  assert.doesNotMatch(html, /<img|<video|Loading GIF|Load GIF/)
})

test('live preview remains visible and flags delimiters damaged while editing inserted content', () => {
  for (const text of ['\\[x^2', 'x^2\\]', '\\(x^2', '```js\nconst value = 4', '```js']) {
    assert.equal(hasRichFormatting(text), true)
    assert.match(render(text, { preview: true }), /role="status"/)
    assert.doesNotMatch(render(text), /role="status"/)
  }
  assert.doesNotMatch(render(serializeCode('\\[x^2'), { preview: true }), /role="status"/)
})

test('mention previews share the formatting grammar including nested code fences and ordinary prices', () => {
  const key = '04' + 'b'.repeat(128)
  const code = serializeCode(`\`\`\`\n@${key}\n\`\`\``)
  const text = `${code}\n$4 for @${key} and $5 for everyone else\n${serializeMath(`\\text{@${key}}`)}`
  assert.equal(formatMentionText(text, [key], () => 'Friend'), `${code}\n$4 for @Friend and $5 for everyone else\n${serializeMath(`\\text{@${key}}`)}`)
})
