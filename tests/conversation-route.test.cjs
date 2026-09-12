const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')
const root = path.join(__dirname, '..')
const cache = new Map()
const ChatClient = () => null
const notFound = () => { throw new Error('NEXT_HTTP_ERROR_FALLBACK;404') }

function load(filename) {
  if (!path.extname(filename)) filename += fs.existsSync(filename + '.tsx') ? '.tsx' : '.ts'
  if (cache.has(filename)) return cache.get(filename)
  const module = { exports: {} }
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText
  new Function('require', 'module', 'exports', output)(specifier => {
    if (specifier === './chat-client') return { default: ChatClient, __esModule: true }
    if (specifier === 'next/navigation') return { notFound }
    if (specifier === 'next/link') return { default: 'a', __esModule: true }
    if (specifier === '@/components/ui/identity-icon') return { IdentityIcon: () => null }
    if (specifier.startsWith('@/')) return load(path.join(root, specifier.slice(2)))
    if (specifier.startsWith('.')) return load(path.resolve(path.dirname(filename), specifier))
    return require(specifier)
  }, module, module.exports)
  cache.set(filename, module.exports)
  return module.exports
}

const Page = load(path.join(root, 'app/chat/[pubkey]/page.tsx')).default
const { conversationFromPathname, parseConversationAddress } = load(path.join(root, 'lib/conversation-route.ts'))
const { ConversationRow } = load(path.join(root, 'components/conversation-sidebar.tsx'))
const owner = `04${'ab'.repeat(64)}`

test('group route opens generated UUIDs and encoded links using the canonical conversation ID', async () => {
  const id = `group:${crypto.randomUUID()}`
  for (const pubkey of [id, encodeURIComponent(id), encodeURIComponent(id).toUpperCase()]) {
    const page = await Page({ params: Promise.resolve({ pubkey }) })
    assert.equal(page.type, ChatClient)
    assert.equal(page.key, id)
    assert.equal(page.props.params.pubkey, id)
  }
})

test('direct and self-chat routes preserve public-key validation and case normalization', async () => {
  const page = await Page({ params: Promise.resolve({ pubkey: owner.toUpperCase() }) })
  assert.equal(page.props.params.pubkey, owner)
  assert.equal(conversationFromPathname(`/chat/${owner.toUpperCase()}`), owner)
})

test('invalid conversation addresses still render the 404 boundary', async () => {
  const uuid = crypto.randomUUID()
  for (const pubkey of ['', 'group:', `group:${uuid.slice(0, -1)}`, `group:${uuid}/extra`, 'javascript:alert(1)', 'group%ZZ', `group%253A${uuid}`, `04${'z'.repeat(128)}`]) {
    await assert.rejects(Page({ params: Promise.resolve({ pubkey }) }), /404/)
  }
})

test('sidebar group links round-trip through the route and stay selected after reload', async () => {
  const id = `group:${crypto.randomUUID()}`
  const conversation = { id, kind: 'group', name: 'Study group', members: [owner], unreadCount: 0, notificationMode: 'all' }
  const row = ConversationRow({ conversation, owner, selected: true })
  const link = row.props.children[0]
  assert.equal(link.type, 'a')
  assert.equal(link.props.href, `/chat/group%3A${id.slice(6)}`)
  assert.equal(link.props['aria-current'], 'page')
  assert.equal(conversationFromPathname(link.props.href), id)
  assert.equal(conversationFromPathname(`/chat/${id}`), id, 'existing unencoded bookmarks remain valid')
  const page = await Page({ params: Promise.resolve({ pubkey: link.props.href.slice('/chat/'.length) }) })
  assert.equal(page.props.params.pubkey, id)
})

test('path parsing cannot select a conversation for incomplete or unrelated routes', () => {
  for (const pathname of ['/chat', '/login', '/chat/%', `/chat/${owner}/extra`, '//chat/' + owner]) {
    assert.equal(conversationFromPathname(pathname), null)
  }
  assert.equal(parseConversationAddress(`group:${crypto.randomUUID()}%2Fextra`), null)
})
