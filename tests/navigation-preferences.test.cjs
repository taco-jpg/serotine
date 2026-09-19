const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')
const root = path.join(__dirname, '..')
const owner = `04${'ab'.repeat(64)}`
const cameron = `04${'cd'.repeat(64)}`
const other = `04${'ef'.repeat(64)}`
const server = `community:${owner}:${crypto.randomUUID()}`
const secondServer = `community:${owner}:${crypto.randomUUID()}`
const general = crypto.randomUUID()
const help = crypto.randomUUID()

function setup(saved = new Map(), withWindow = true) {
  const window = new EventTarget()
  window.localStorage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, String(value)) }
  const cache = new Map()
  function load(filename) {
    if (!path.extname(filename)) filename += '.ts'
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }; cache.set(filename, module)
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    new Function('require', 'module', 'exports', 'window', source)(name => name.startsWith('.') ? load(path.resolve(path.dirname(filename), name)) : require(name), module, module.exports, withWindow ? window : undefined)
    return module.exports
  }
  return { api: load(path.join(root, 'lib/navigation-preferences.ts')), window, saved }
}

function community(id, extra = {}) { return { id, name: id === server ? 'Cameron' : 'Other server', joined: true, updatedAt: 10, channels: [{ id: general }, { id: help }], ...extra } }

test('opening Cameron restores its route without promoting it above newer activity', () => {
  const { api, saved } = setup()
  const chats = [{ id: cameron, name: 'Cameron', updatedAt: 10 }, { id: other, name: 'Test chat', updatedAt: 20 }]
  api.rememberNavigation(owner, { kind: 'conversation', id: cameron }, undefined, 30)
  const reloaded = setup(saved).api
  assert.deepEqual(reloaded.sortByRecentActivity(chats, reloaded.loadNavigationPreferences(owner)).map(item => item.id), [other, cameron])
  assert.equal(reloaded.restoredChatHref(reloaded.loadNavigationPreferences(owner), chats, [], owner), `/chat/${cameron}`)
  assert.equal(chats[0].updatedAt, 10, 'a visit must not rewrite message activity')
  assert.equal(reloaded.sortByRecentActivity([{ ...chats[1], updatedAt: 40 }, chats[0]], reloaded.loadNavigationPreferences(owner))[0].id, other, 'new incoming messages can still bring a chat forward')
})

test('last server and its own channel survive reload and switching between servers', () => {
  const { api, saved } = setup()
  api.rememberNavigation(owner, { kind: 'community', id: secondServer }, general, 10)
  api.rememberNavigation(owner, { kind: 'community', id: server }, help, 20)
  const reloaded = setup(saved).api
  const prefs = reloaded.loadNavigationPreferences(owner)
  assert.equal(reloaded.preferredCommunity([community(secondServer), community(server)], prefs).id, server)
  assert.equal(prefs.channels[server], help)
  assert.equal(prefs.channels[secondServer], general)
  assert.equal(reloaded.restoredChatHref(prefs, [], [community(server)], owner), '/chat/communities')
  assert.equal(reloaded.preferredCommunity([community(secondServer), community(server)], prefs, secondServer).id, secondServer, 'an explicit server link wins over saved selection')
  reloaded.rememberNavigation(owner, { kind: 'conversation', id: cameron }, undefined, 30)
  assert.equal(reloaded.preferredCommunity([community(secondServer, { updatedAt: 50 }), community(server)], reloaded.loadNavigationPreferences(owner)).id, server, 'returning from a direct chat restores the server last opened, even if another server has new messages')
})

test('deleted, archived, blocked, unaccepted and departed destinations do not reopen automatically', () => {
  const { api } = setup()
  api.rememberNavigation(owner, { kind: 'conversation', id: cameron })
  const prefs = api.loadNavigationPreferences(owner)
  assert.equal(api.restoredChatHref(prefs, [], [], owner), null)
  for (const extra of [{ archived: true }, { blocked: true }, { request: true }, { kind: 'group', members: [other] }]) {
    assert.equal(api.restoredChatHref(prefs, [{ id: cameron, ...extra }], [], owner), null)
  }
  api.rememberNavigation(owner, { kind: 'community', id: server }, help)
  const communityPrefs = api.loadNavigationPreferences(owner)
  assert.equal(api.restoredChatHref(communityPrefs, [], [community(server)], owner, [server]), null, 'archived communities remain in Archived when the inbox reloads')
  for (const extra of [{ deleted: true }, { joined: false }]) {
    assert.equal(api.restoredChatHref(communityPrefs, [], [community(server, extra)], owner), null)
    assert.equal(api.preferredCommunity([community(server, extra), community(secondServer)], communityPrefs).id, secondServer)
  }
})

test('communities and direct conversations share one recent-activity ordering', () => {
  const { api } = setup()
  const chats = [{ id: cameron, name: 'Cameron', updatedAt: 10 }, community(server, { updatedAt: 20 }), community(secondServer, { updatedAt: 30 })]
  api.rememberNavigation(owner, { kind: 'conversation', id: cameron }, undefined, 40)
  assert.deepEqual(api.sortByRecentActivity(chats, api.loadNavigationPreferences(owner)).map(item => item.id), [secondServer, server, cameron])
  api.rememberNavigation(owner, { kind: 'community', id: server }, help, 50)
  assert.deepEqual(api.sortByRecentActivity(chats, api.loadNavigationPreferences(owner)).map(item => item.id), [secondServer, server, cameron])
})

test('preferences and subscription notifications stay scoped to the current identity', () => {
  const { api, window } = setup()
  let ownerChanges = 0, otherChanges = 0
  const stop = api.subscribeNavigation(owner, () => { ownerChanges++ })
  api.subscribeNavigation(other, () => { otherChanges++ })
  api.rememberNavigation(owner, { kind: 'conversation', id: cameron })
  assert.equal(ownerChanges, 1)
  assert.equal(otherChanges, 0)
  assert.equal(api.loadNavigationPreferences(other).lastView, null)
  const event = new Event('storage')
  Object.assign(event, { key: `serotine_navigation:${other}`, storageArea: window.localStorage })
  window.dispatchEvent(event)
  assert.equal(otherChanges, 1)
  assert.equal(ownerChanges, 1)
  stop()
  api.rememberNavigation(owner, { kind: 'conversation', id: other })
  assert.equal(ownerChanges, 1)
})

test('bad stored data cannot inject navigation URLs or invalid ordering values', () => {
  const { api } = setup()
  for (const raw of ['', 'broken json', JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, lastView: { kind: 'conversation', id: 'javascript:alert(1)' }, opened: { [cameron]: -5, '__proto__': 20 }, channels: { [server]: '../../evil' } })]) {
    assert.deepEqual(api.parseNavigationPreferences(raw), { version: 1, lastView: null, opened: {}, channels: {} })
  }
})

test('blocked browser storage keeps navigation usable for the current session and server rendering reads no identity', () => {
  const { api, window, saved } = setup()
  Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage denied') } })
  assert.doesNotThrow(() => api.rememberNavigation(owner, { kind: 'conversation', id: cameron }))
  assert.equal(api.loadNavigationPreferences(owner).lastView.id, cameron)
  assert.equal(api.loadNavigationPreferences(other).lastView, null)
  assert.equal(saved.size, 0)
  assert.equal(setup(saved, false).api.loadNavigationPreferences(owner).lastView, null)
})


test('activity timestamps outrank state changes and stable ID ties ignore rename and input order', () => {
  const { api } = setup()
  const items = [
    { id: cameron, name: 'Zed', updatedAt: 500, activityAt: 10 },
    { id: other, name: 'Alice', updatedAt: 20, activityAt: 20 },
    { id: server, name: 'Group', updatedAt: 800, activityAt: 10 },
  ]
  const expected = [other, ...[cameron, server].sort()]
  assert.deepEqual(api.sortByRecentActivity(items).map(item => item.id), expected)
  assert.deepEqual(api.sortByRecentActivity(items.toReversed().map(item => ({ ...item, name: 'Renamed', unreadCount: 0, archived: true }))).map(item => item.id), expected)
  const filtered = api.sortByRecentActivity(items.filter(item => item.id !== other))
  assert.deepEqual(filtered.map(item => item.id), expected.slice(1))
  assert.deepEqual(api.sortByRecentActivity([...filtered, items[1]]).map(item => item.id), expected, 'unarchive restores actual activity order')
  assert.equal(api.sortByRecentActivity(items.map(item => item.id === cameron ? { ...item, activityAt: 30 } : item))[0].id, cameron, 'only actual new activity promotes')
})
