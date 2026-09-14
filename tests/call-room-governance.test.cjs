const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { test } = require('node:test')
const ts = require('typescript')
const root = path.join(__dirname, '..'), cache = new Map()
function load(filename) {
  if (!path.extname(filename)) filename += '.ts'
  if (cache.has(filename)) return cache.get(filename).exports
  const mod = { exports: {} }; cache.set(filename, mod)
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('require', 'module', 'exports', output)(name => name === 'idb' ? {} : name.startsWith('.') ? load(path.resolve(path.dirname(filename), name)) : require(name), mod, mod.exports)
  return mod.exports
}
const { CallRoomGovernance } = load(path.join(root, 'lib/call-room-governance.ts'))
const { latestCallRoomProof } = load(path.join(root, 'lib/call-room-access.ts'))
const self = '04' + '1'.repeat(128), peer = '04' + '2'.repeat(128)
const identity = { publicKey: self }
const turn = () => new Promise(resolve => setImmediate(resolve))
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function target(epoch = 1, id = crypto.randomUUID()) {
  return { kind: 'group', group: { id: `group:${id}`, admin: self, members: [self, peer], name: 'Friends',
    epoch, updatedAt: Date.now(), signature: String(epoch).repeat(128) } }
}

test('only previously joined rooms publish changes, with no extra request for known signatures', async t => {
  const first = target(), unrelated = target()
  let current = first
  const sent = []
  const governance = new CallRoomGovernance({ identity, getTarget: prior => prior.group.id === first.group.id ? current : unrelated },
    { transport: { status: async proof => { sent.push(proof) } } })
  t.after(() => governance.dispose())
  governance.refresh()
  assert.equal(sent.length, 0)
  governance.observeJoined(first)
  governance.refresh()
  assert.equal(sent.length, 0, 'joining already checkpointed the initial proof')
  current = { ...first, group: { ...first.group, epoch: 2, signature: '2'.repeat(128), members: [self] } }
  governance.refresh(); governance.refresh(); governance.observeJoined(first)
  await turn()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].group.epoch, 2)
  governance.refresh(); await turn()
  assert.equal(sent.length, 1)
})

test('channel removal is published after local media access ends without joining or ringing', async t => {
  const channelId = crypto.randomUUID()
  const state = { id: `community:${self}:${crypto.randomUUID()}`, owner: self, name: 'Club', description: '', epoch: 1, updatedAt: Date.now(),
    members: [self, peer], moderators: [], bans: [], admission: 'direct', joiningPaused: false, inviteGeneration: 1, signature: '1'.repeat(128),
    channels: [{ id: channelId, name: 'Lounge', posting: 'members', kind: 'voice' }], joined: true, effectiveMembers: [self, peer] }
  const first = { kind: 'channel', community: state, channelId }
  let record = state
  const sent = []
  const governance = new CallRoomGovernance({ identity, getTarget: prior => latestCallRoomProof(prior, { identity, conversations: [], preferences: { blocked: [] } }, [record]) },
    { transport: { status: async proof => { sent.push(proof) } } })
  t.after(() => governance.dispose())
  governance.observeJoined(first)
  record = { ...state, epoch: 2, signature: '2'.repeat(128), channels: [], joined: false }
  governance.refresh(); await turn()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].channelId, channelId)
  assert.deepEqual(sent[0].community.channels, [])
  assert.equal(Object.hasOwn(sent[0].community, 'joined'), false)
})

test('a newer proof supersedes a pending publication and no stale retry follows', async t => {
  const first = target(), wait = deferred(), sent = []
  let current = first
  const governance = new CallRoomGovernance({ identity, getTarget: () => current }, { retryDelayMs: 5,
    transport: { status: async proof => { sent.push(proof.group.epoch); if (proof.group.epoch === 2) await wait.promise } } })
  t.after(() => governance.dispose())
  governance.observeJoined(first)
  current = { ...first, group: { ...first.group, epoch: 2, signature: '2'.repeat(128) } }
  governance.refresh(); governance.refresh()
  current = { ...first, group: { ...first.group, epoch: 3, signature: '3'.repeat(128) } }
  governance.refresh(); governance.refresh()
  assert.deepEqual(sent, [2], 'one request per scope at a time')
  wait.reject(new Error('offline'))
  await turn(); await turn()
  assert.deepEqual(sent, [2, 3])
  await delay(15)
  assert.deepEqual(sent, [2, 3])
})

test('publication retries stop after three retries and restart only for a new signature', async t => {
  const first = target(), sent = []
  let current = first
  const governance = new CallRoomGovernance({ identity, getTarget: () => current }, { retryDelayMs: 5,
    transport: { status: async proof => { sent.push(proof.group.epoch); throw new Error('offline') } } })
  t.after(() => governance.dispose())
  governance.observeJoined(first)
  current = { ...first, group: { ...first.group, epoch: 2, signature: '2'.repeat(128) } }
  governance.refresh()
  for (let count = 0; count < 30 && sent.length < 4; count++) await delay(5)
  assert.deepEqual(sent, [2, 2, 2, 2])
  governance.refresh(); governance.refresh(); await delay(20)
  assert.equal(sent.length, 4)
  current = { ...first, group: { ...first.group, epoch: 3, signature: '3'.repeat(128) } }
  governance.refresh()
  assert.equal(sent.at(-1), 3)
})

test('identity disposal cancels scheduled retries and in-flight completions cannot publish again', async () => {
  for (const pending of [false, true]) {
    const first = target(), wait = deferred(), sent = []
    let current = first
    const governance = new CallRoomGovernance({ identity, getTarget: () => current }, { retryDelayMs: 5,
      transport: { status: async proof => { sent.push(proof); if (pending) await wait.promise; else throw new Error('offline') } } })
    governance.observeJoined(first)
    current = { ...first, group: { ...first.group, epoch: 2, signature: '2'.repeat(128) } }
    governance.refresh(); await turn()
    governance.dispose(); wait.resolve()
    governance.refresh(); governance.observeJoined(target())
    await delay(15)
    assert.equal(sent.length, 1)
  }
})

test('scope memory is bounded and revoked publisher access cancels a pending retry', async t => {
  const first = target(), second = target(), third = target(), current = new Map([first, second, third].map(proof => [proof.group.id, proof]))
  const sent = []
  const governance = new CallRoomGovernance({ identity, getTarget: prior => current.get(prior.group.id) ?? null }, { maxScopes: 2, retryDelayMs: 5,
    transport: { status: async proof => { sent.push(proof.group.id); throw new Error('offline') } } })
  t.after(() => governance.dispose())
  for (const proof of [first, second, third]) governance.observeJoined(proof)
  for (const proof of [first, second, third]) current.set(proof.group.id, { ...proof, group: { ...proof.group, epoch: 2, signature: '2'.repeat(128) } })
  governance.refresh(); await turn()
  assert.deepEqual(sent, [second.group.id, third.group.id], 'oldest visited scope was forgotten')
  current.clear(); governance.refresh()
  await delay(15)
  assert.equal(sent.length, 2, 'no retry after local publisher access is lost')
})
