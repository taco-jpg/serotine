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
    if (specifier === '@/components/messaging-provider') return { useCommunities: () => { throw new Error('Community actions are not mounted in row tests') } }
    if (specifier.startsWith('@/')) return load(path.join(root, specifier.slice(2)))
    if (specifier.startsWith('.')) return load(path.resolve(path.dirname(filename), specifier))
    return require(specifier)
  }, module, module.exports)
  cache.set(filename, module.exports)
  return module.exports
}

const Page = load(path.join(root, 'app/chat/[pubkey]/page.tsx')).default
const { communityHref, conversationFromPathname, parseConversationAddress } = load(path.join(root, 'lib/conversation-route.ts'))
const { CommunityRow, ConversationRow } = load(path.join(root, 'components/conversation-sidebar.tsx'))
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

test('community inbox rows have ordinary chat sizing and retain channel, unread, archive and deep-link details', () => {
  const id = `community:${owner}:${crypto.randomUUID()}`
  const channelId = crypto.randomUUID(), messageId = crypto.randomUUID()
  const community = { id, name: 'Cameron community', effectiveMembers: [owner], channels: [{ id: channelId, name: 'general' }], unreadCount: 4, notificationMode: 'muted', updatedAt: Date.now(), lastMessage: { id: messageId, channelId, content: 'Community message preview', timestamp: Date.now(), senderPubKey: owner, delivery: 'sent' } }
  const sharedRow = CommunityRow({ community, owner, selected: true, archived: true })
  const row = sharedRow.type(sharedRow.props)
  const link = row.props.children[0]
  assert.match(link.props.className, /min-h-12/)
  assert.equal(link.props['aria-current'], 'page')
  assert.equal(new URLSearchParams(link.props.href.split('#')[1]).get('id'), id)
  const html = require('react-dom/server').renderToStaticMarkup(row)
  for (const text of ['Cameron community', '#general', 'Community message preview', '4 unread messages', 'Archived', 'Muted']) assert.ok(html.includes(text), text)
  const collapsed = CommunityRow({ community, owner, selected: true, collapsed: true, archived: true })
  assert.match(collapsed.type(collapsed.props).props['aria-label'], /archived.*4 unread/)
  const target = new URL(communityHref(id, channelId, messageId), 'https://example.com')
  const params = new URLSearchParams(target.hash.slice(1))
  assert.equal(target.pathname, '/chat/communities')
  assert.deepEqual([...params.entries()], [['id', id], ['channel', channelId], ['message', messageId]])
})

test('a moderated community message never exposes its original content or attachment in inbox previews', () => {
  const community = { id: `community:${owner}:${crypto.randomUUID()}`, name: 'Community', effectiveMembers: [owner], channels: [], unreadCount: 0, notificationMode: 'all', updatedAt: Date.now(), lastMessage: { content: 'Hidden original text', hidden: true, attachment: { name: 'Hidden filename.txt' }, timestamp: Date.now(), senderPubKey: owner, delivery: 'sent' } }
  const sharedRow = CommunityRow({ community, owner, selected: false })
  const html = require('react-dom/server').renderToStaticMarkup(sharedRow.type(sharedRow.props))
  assert.ok(html.includes('Message hidden by a moderator.'))
  assert.ok(!html.includes('Hidden original text'))
  assert.ok(!html.includes('Hidden filename'))
})
