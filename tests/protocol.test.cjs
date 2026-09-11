/* Run with Node 22.13+ from the repository: npm test */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { DatabaseSync } = require('node:sqlite')
const { test, before, beforeEach, after } = require('node:test')

const root = [process.env.SEROTINE_TEST_ROOT, process.cwd(), path.join(__dirname, 'serotine'), path.join(__dirname, '..')]
  .filter(Boolean).find(candidate => fs.existsSync(path.join(candidate, 'lib/protocol.ts')))
assert.ok(root, 'Run this test from the Serotine repository or set SEROTINE_TEST_ROOT')
const repoRequire = createRequire(path.join(root, 'package.json'))
const ts = repoRequire('typescript')
let sqlite
let dbUnavailable = false
let dbFailure = null
class RelayConfigurationError extends Error {}
const database = {
  prepare(sql) {
    const statement = sqlite.prepare(sql)
    let parameters = []
    return {
      bind(...values) { parameters = values; return this },
      async run() { return { meta: { changes: Number(statement.run(...parameters).changes) } } },
      async first() { return statement.get(...parameters) ?? null },
      async all() { return { results: statement.all(...parameters) } },
    }
  },
}

// Compile and execute actual source, substituting only the Cloudflare D1 boundary.
// Every SQL query runs against real SQLite, including constraints and migrations.
const modules = new Map()
function loadTs(filename) {
  if (!path.extname(filename)) filename += '.ts'
  if (modules.has(filename)) return modules.get(filename).exports
  const module = { exports: {} }
  modules.set(filename, module)
  const source = fs.readFileSync(filename, 'utf8')
  const output = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  }, fileName: filename }).outputText
  function requireSource(specifier) {
    if (specifier === '@/lib/db') return { RelayConfigurationError, getDB: async () => {
      if (dbFailure) throw dbFailure
      if (dbUnavailable) throw new Error('simulated D1 binding unavailable')
      return database
    } }
    if (specifier.startsWith('@/')) return loadTs(path.join(root, specifier.slice(2)))
    if (specifier.startsWith('.')) return loadTs(path.resolve(path.dirname(filename), specifier))
    return repoRequire(specifier)
  }
  new Function('require', 'module', 'exports', '__filename', '__dirname', output)(
    requireSource, module, module.exports, filename, path.dirname(filename),
  )
  return module.exports
}

const cryptography = loadTs(path.join(root, 'lib/crypto.ts'))
const protocol = loadTs(path.join(root, 'lib/protocol.ts'))
const auth = loadTs(path.join(root, 'lib/request-auth.ts'))
const actions = loadTs(path.join(root, 'app/actions.ts'))
let alice, bob, mallory
async function identity() {
  const pair = await cryptography.generateEncryptionKeyPair()
  const privateJwk = await cryptography.exportKey(pair.privateKey)
  return {
    pair, privateJwk, publicKey: await cryptography.exportPublicKeyToHex(pair.publicKey),
    signingKey: await crypto.subtle.importKey('jwk', { ...privateJwk, key_ops: ['sign'] },
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']),
  }
}
function envelope(sender = alice, recipient = bob, content = 'Hello, 你好 🌮') {
  return { version: 2, id: crypto.randomUUID(), sender: sender.publicKey, recipient: recipient.publicKey, content, timestamp: Date.now() }
}
async function proof(action, payload, signer) {
  return auth.createRequestProof(action, payload, signer.privateJwk, signer.publicKey)
}
async function proofAt(action, payload, signer, timestamp) {
  const fields = { publicKey: signer.publicKey, timestamp, nonce: crypto.randomUUID() }
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signer.signingKey,
    new TextEncoder().encode(protocol.requestText(action, payload, fields)))
  return { ...fields, signature: cryptography.arrayBufferToHex(signature) }
}
async function packet(sender = alice, recipient = bob) {
  const value = envelope(sender, recipient)
  return { id: value.id, recipientPubKey: recipient.publicKey,
    encryptedData: await cryptography.encryptForPeer(JSON.stringify(value), sender.pair.privateKey, recipient.publicKey) }
}
async function send(data, signer = alice) {
  return actions.storeEncryptedMessage(data, await proof('message:send', data, signer))
}
async function inbox(owner = bob, sender = alice) {
  const data = { senderPubKey: sender.publicKey }
  return actions.getMyMessages(data, await proof('message:list', data, owner))
}
function seedMessage(sender, recipient, overrides = {}) {
  const row = { id: crypto.randomUUID(), encryptedData: 'encrypted-test-packet'.repeat(3), createdAt: Date.now(), expiresAt: Date.now() + 600_000, ...overrides }
  sqlite.prepare('INSERT INTO RelayMessage(id,senderPubKey,recipientPubKey,encryptedData,createdAt,expiresAt) VALUES(?,?,?,?,?,?)')
    .run(row.id, sender.publicKey, recipient.publicKey, row.encryptedData, row.createdAt, row.expiresAt)
  return row
}
before(async () => { [alice, bob, mallory] = await Promise.all([identity(), identity(), identity()]) })
beforeEach(() => {
  if (sqlite) sqlite.close()
  sqlite = new DatabaseSync(':memory:')
  dbUnavailable = false
  dbFailure = null
  for (const filename of fs.readdirSync(path.join(root, 'migrations')).filter(file => file.endsWith('.sql')).sort()) {
    sqlite.exec(fs.readFileSync(path.join(root, 'migrations', filename), 'utf8'))
  }
})
after(() => sqlite?.close())

test('real P-256/AES-GCM round trip preserves Unicode and uses fresh IVs', async () => {
  const plaintext = JSON.stringify(envelope())
  const first = await cryptography.encryptForPeer(plaintext, alice.pair.privateKey, bob.publicKey)
  const second = await cryptography.encryptForPeer(plaintext, alice.pair.privateKey, bob.publicKey)
  assert.notEqual(JSON.parse(first).iv, JSON.parse(second).iv)
  assert.equal(await cryptography.decryptFromPeer(first, bob.pair.privateKey, alice.publicKey), plaintext)
})

test('ciphertext tampering and unrelated private keys fail authentication', async () => {
  const encrypted = await cryptography.encryptForPeer('private message', alice.pair.privateKey, bob.publicKey)
  await assert.rejects(cryptography.decryptFromPeer(encrypted, mallory.pair.privateKey, alice.publicKey))
  const modified = JSON.parse(encrypted)
  const bytes = Buffer.from(modified.ciphertext, 'base64')
  bytes[0] ^= 1
  modified.ciphertext = bytes.toString('base64')
  await assert.rejects(cryptography.decryptFromPeer(JSON.stringify(modified), bob.pair.privateKey, alice.publicKey))
})

test('malformed hex and invalid curve points are rejected', async () => {
  for (const input of ['', 'abc', 'gg', '0x12']) assert.throws(() => cryptography.hexToArrayBuffer(input))
  await assert.rejects(cryptography.importPublicKeyFromHex('04' + '00'.repeat(64), 'encryption'))
})

test('request signatures prove possession of existing encryption identity and bind every field', async () => {
  const data = { senderPubKey: alice.publicKey }
  const signed = await proof('message:list', data, bob)
  assert.equal(await auth.verifyRequestProof('message:list', data, signed), true)
  assert.equal(await auth.verifyRequestProof('message:ack', data, signed), false)
  assert.equal(await auth.verifyRequestProof('message:list', { senderPubKey: mallory.publicKey }, signed), false)
  assert.equal(await auth.verifyRequestProof('message:list', data, { ...signed, publicKey: mallory.publicKey }), false)
  assert.equal(await auth.verifyRequestProof('message:list', data, { ...signed, nonce: crypto.randomUUID() }), false)
  assert.equal(await auth.verifyRequestProof('message:list', data, { ...signed, timestamp: signed.timestamp + 1 }), false)
})

test('expired, excessive future, and missing proofs are rejected', async () => {
  const data = { senderPubKey: alice.publicKey }
  assert.equal(await auth.verifyRequestProof('message:list', data, await proofAt('message:list', data, bob, Date.now() - 61_000)), false)
  assert.equal(await auth.verifyRequestProof('message:list', data, await proofAt('message:list', data, bob, Date.now() + 61_000)), false)
  assert.equal(await auth.verifyRequestProof('message:list', data, undefined), false)
})

test('encrypted directional envelope rejects reflected sender-to-recipient ciphertext', async () => {
  const value = envelope()
  const encrypted = await cryptography.encryptForPeer(JSON.stringify(value), alice.pair.privateKey, bob.publicKey)
  const delivered = JSON.parse(await cryptography.decryptFromPeer(encrypted, bob.pair.privateKey, alice.publicKey))
  assert.equal(protocol.isEnvelope(delivered, alice.publicKey, bob.publicKey), true)
  const reflected = JSON.parse(await cryptography.decryptFromPeer(encrypted, alice.pair.privateKey, bob.publicKey))
  assert.equal(protocol.isEnvelope(reflected, bob.publicKey, alice.publicKey), false)
})

test('envelope rejects malformed, empty, oversized, and future-dated messages', () => {
  const valid = envelope()
  for (const value of [null, {}, { ...valid, version: 1 }, { ...valid, id: 'anything' },
    { ...valid, content: '   ' }, { ...valid, content: {} },
    { ...valid, content: 'a'.repeat(protocol.MAX_MESSAGE_LENGTH + 1) },
    { ...valid, timestamp: Date.now() + 61_000 }, { ...valid, timestamp: -1 }]) {
    assert.equal(protocol.isEnvelope(value, alice.publicKey, bob.publicKey), false)
  }
})

test('relay stores ciphertext and exposes a message only to its recipient', async () => {
  const data = await packet()
  assert.deepEqual(await send(data), { success: true })
  const authorized = await inbox()
  assert.equal(authorized.success, true)
  assert.equal(authorized.messages.length, 1)
  assert.equal(authorized.messages[0].encryptedData, data.encryptedData)
  assert.equal(authorized.messages[0].senderPubKey, alice.publicKey)
  assert.equal((await inbox(mallory, alice)).messages.length, 0)
  assert.equal((await inbox(alice, alice)).messages.length, 0)
})

test('sender and unrelated user cannot acknowledge another recipient inbox', async () => {
  const data = await packet()
  await send(data)
  const ack = { id: data.id, senderPubKey: alice.publicKey }
  await actions.deleteMessage(ack, await proof('message:ack', ack, mallory))
  await actions.deleteMessage(ack, await proof('message:ack', ack, alice))
  assert.equal((await inbox()).messages.length, 1)
  assert.deepEqual(await actions.deleteMessage(ack, await proof('message:ack', ack, bob)), { success: true })
  assert.equal((await inbox()).messages.length, 0)
})

test('unsigned and forged relay requests make no database writes', async () => {
  const data = await packet()
  const signed = await proof('message:send', data, mallory)
  assert.equal((await actions.storeEncryptedMessage(data, { ...signed, publicKey: alice.publicKey })).success, false)
  const warn = console.error
  console.error = () => {}
  try { assert.equal((await actions.storeEncryptedMessage(data, undefined)).success, false) }
  finally { console.error = warn }
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM RelayMessage').get().count, 0)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM RequestNonce').get().count, 0)
})

test('nonce replay is rejected while fresh-proof retry stores one stable message', async () => {
  const data = await packet()
  const signed = await proof('message:send', data, alice)
  assert.deepEqual(await actions.storeEncryptedMessage(data, signed), { success: true })
  assert.equal((await actions.storeEncryptedMessage(data, signed)).success, false)
  assert.deepEqual(await send(data), { success: true })
  assert.equal((await inbox()).messages.length, 1)
})

test('idempotent retry remains successful at the pending message cap', async () => {
  const data = await packet()
  await send(data)
  for (let index = 0; index < 499; index++) seedMessage(alice, bob)
  assert.deepEqual(await send(data), { success: true })
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM RelayMessage').get().count, 500)
  assert.equal((await send(await packet())).success, false)
})

test('messages from other contacts cannot starve a conversation behind the 100-row limit', async () => {
  for (let index = 0; index < 101; index++) seedMessage(mallory, bob, { createdAt: Date.now() - 10_000 })
  const data = await packet()
  await send(data)
  const result = await inbox()
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].id, data.id)
})

test('expired rows are hidden and cleaned; unsigned legacy rows are never surfaced as v2', async () => {
  seedMessage(alice, bob, { expiresAt: Date.now() - 1 })
  sqlite.prepare("INSERT INTO Message(id,receiverPubKeyHash,encryptedData,expiresAt,createdAt) VALUES(?,?,?,datetime('now','+1 day'),datetime('now'))")
    .run('legacy-id', bob.publicKey, 'legacy-ciphertext')
  assert.equal((await inbox()).messages.length, 0)
  await send(await packet())
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM RelayMessage').get().count, 1)
})

test('encrypted signals can be read only by their recipient and sender cannot impersonate another peer', async () => {
  const data = { recipientPubKey: bob.publicKey, encryptedData: (await packet()).encryptedData }
  assert.deepEqual(await actions.storeSignal(data, await proof('signal:send', data, alice)), { success: true })
  const request = { senderPubKey: alice.publicKey }
  const authorized = await actions.getSignal(request, await proof('signal:read', request, bob))
  assert.equal(authorized.signal.encryptedData, data.encryptedData)
  assert.equal((await actions.getSignal(request, await proof('signal:read', request, mallory))).signal, null)
  const forged = { ...await proof('signal:send', data, mallory), publicKey: alice.publicKey }
  assert.equal((await actions.storeSignal(data, forged)).success, false)
})

test('backdated valid proofs cannot shorten the per-minute write rate window', async () => {
  const realNow = Date.now
  let clock = realNow()
  Date.now = () => clock
  try {
    const data = await packet()
    for (let index = 0; index < 60; index++) {
      const signed = await proofAt('message:send', data, alice, clock - 59_999)
      assert.equal((await actions.storeEncryptedMessage(data, signed)).success, true)
      clock += 2
    }
    const excess = await actions.storeEncryptedMessage(data, await proofAt('message:send', data, alice, clock - 59_999))
    assert.equal(excess.success, false, '61 signed sends inside 120ms must exceed the minute rate limit')
    assert.match(excess.error, /too many/i)
  } finally { Date.now = realNow }
})

test('future-dated proof nonce remains consumed throughout its acceptance window', async () => {
  const realNow = Date.now
  let clock = realNow()
  Date.now = () => clock
  try {
    const data = { senderPubKey: alice.publicKey }
    const signed = await proofAt('message:list', data, bob, clock + 59_000)
    assert.equal((await actions.getMyMessages(data, signed)).success, true)
    clock += 70_000
    assert.equal(await auth.verifyRequestProof('message:list', data, signed), true)
    assert.equal((await actions.getMyMessages(data, signed)).success, false)
  } finally { Date.now = realNow }
})

test('D1 failures return a recoverable result; fresh-proof retry can succeed', async () => {
  const data = await packet()
  dbUnavailable = true
  const warn = console.error
  console.error = () => {}
  try { assert.equal((await send(data)).success, false) }
  finally { console.error = warn; dbUnavailable = false }
  assert.deepEqual(await send(data), { success: true })
})


test('signed cursor reaches rows after an unacknowledged full page, including equal timestamps', async () => {
  const createdAt = Date.now() - 1000
  for (let index = 0; index < 105; index++) seedMessage(alice, bob, { createdAt })
  seedMessage(mallory, bob, { createdAt })
  seedMessage(alice, mallory, { createdAt })
  const first = await inbox()
  assert.equal(first.messages.length, 100)
  assert.ok(first.nextCursor)
  const data = { senderPubKey: alice.publicKey, after: first.nextCursor }
  const second = await actions.getMyMessages(data, await proof('message:list', data, bob))
  assert.equal(second.messages.length, 5)
  assert.equal(second.nextCursor, null)
  assert.equal(new Set([...first.messages, ...second.messages].map(row => row.id)).size, 105)
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM RelayMessage').get().count, 107, 'pagination never acknowledges or deletes')
})

test('cursor tampering and malformed cursor fields are rejected', async () => {
  const data = { senderPubKey: alice.publicKey, after: { createdAt: Date.now(), id: crypto.randomUUID() } }
  const signed = await proof('message:list', data, bob)
  assert.equal((await actions.getMyMessages({ ...data, after: { ...data.after, createdAt: 1 } }, signed)).success, false)
  for (const after of [null, {}, { createdAt: -1, id: crypto.randomUUID() }, { createdAt: 1.5, id: crypto.randomUUID() }, { createdAt: 1, id: 'bad' }]) {
    const bad = { senderPubKey: alice.publicKey, after }
    assert.equal((await actions.getMyMessages(bad, await proof('message:list', bad, bob))).success, false)
  }
})

test('missing relay tables and bindings report actionable setup errors without exposing SQL', async () => {
  const old = console.error
  console.error = () => {}
  try {
    dbFailure = new RelayConfigurationError('missing binding')
    const missingBinding = await inbox()
    assert.equal(missingBinding.success, false)
    assert.match(missingBinding.error, /site owner.*connect/)
    dbFailure = null
    sqlite.exec('DROP TABLE RequestNonce')
    const missingTable = await inbox()
    assert.equal(missingTable.success, false)
    assert.match(missingTable.error, /database could not finish automatic setup/)
    assert.doesNotMatch(missingTable.error, /RequestNonce|SELECT|DELETE/)
  } finally { console.error = old }
})
