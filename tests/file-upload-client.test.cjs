const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const root = path.resolve(__dirname, '..'), cache = new Map()
function source(filename) {
  if (!path.extname(filename)) filename += '.ts'
  if (cache.has(filename)) return cache.get(filename).exports
  const module = { exports: {} }; cache.set(filename, module)
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('require', 'module', 'exports', output)(name => name.startsWith('.') ? source(path.resolve(path.dirname(filename), name)) : require(name), module, module.exports)
  return module.exports
}
const files = source(path.join(root, 'lib/attachments'))
const client = source(path.join(root, 'lib/file-upload-client'))
const auth = source(path.join(root, 'lib/request-auth'))
const crypt = source(path.join(root, 'lib/crypto'))
async function identity() { const pair = await crypt.generateEncryptionKeyPair(); return { version: 2, publicKey: await crypt.exportPublicKeyToHex(pair.publicKey), privateKey: await crypt.exportKey(pair.privateKey) } }
const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
function relay() {
  const requests = [], uploads = new Map()
  return { requests, uploads, available: true, corrupt: false,
    async fetch(_url, options) {
      options.signal?.throwIfAborted()
      if (options.method === 'GET') return json({ success: true, available: this.available, maxFileBytes: files.MAX_FILE_BYTES, chunkBytes: files.REMOTE_ATTACHMENT_CHUNK_BYTES })
      const envelope = JSON.parse(options.method === 'PUT' ? options.headers['X-Serotine-File-Request'] : options.body)
      const { action, data, proof } = envelope
      assert.equal(await auth.verifyRequestProof(action, data, proof), true, 'real P-256 proof verifies')
      requests.push(envelope)
      if (action === 'file:init') uploads.set(data.uploadId, { ...data, parts: [], published: false })
      const upload = uploads.get(data.uploadId)
      if (action === 'file:chunk') { assert.ok(options.body.byteLength <= files.REMOTE_ATTACHMENT_CHUNK_BYTES + 16); assert.equal(await client.fileDigest(options.body), data.digest); upload.parts[data.index] = options.body.slice(0) }
      if (action === 'file:publish') upload.published = true
      if (action === 'file:delete' && !upload?.published) uploads.delete(data.uploadId)
      if (action === 'file:read') {
        if (!upload?.published) return new Response(JSON.stringify({ success: false, error: 'Not published' }), { status: 403 })
        assert.equal(await client.fileDigest(new TextEncoder().encode(data.capability)), upload.accessHash)
        const bytes = upload.parts[data.index].slice(0)
        if (this.corrupt) new Uint8Array(bytes)[0] ^= 1
        return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength) } })
      }
      return json({ success: true, uploadId: data.uploadId, status: upload?.published ? 'published' : action === 'file:init' ? 'staged' : 'ready', expiresAt: Date.now() + 10000 })
    },
  }
}
async function withRelay(callback) { const original = globalThis.fetch, server = relay(); globalThis.fetch = server.fetch.bind(server); try { await callback(server) } finally { globalThis.fetch = original } }
function collector() { const chunks = []; return { chunks, closed: false, aborted: false, async write(bytes) { assert.ok(bytes.length <= files.REMOTE_ATTACHMENT_CHUNK_BYTES); chunks.push(bytes.slice()) }, async close() { this.closed = true }, async abort() { this.aborted = true; chunks.length = 0 } } }

test('1 GiB boundary accepts streamed metadata and never enlarges the legacy event limit', async () => {
  assert.equal(files.MAX_FILE_BYTES, 1073741824)
  assert.equal(files.MAX_ATTACHMENT_CHUNKS, 1707)
  assert.equal(files.attachmentFileLimit({ members: Array(20).fill('member') }), files.MAX_FILE_BYTES)
  const metadata = { id: crypto.randomUUID(), name: 'maximum.bin', mime: 'application/octet-stream', size: files.MAX_FILE_BYTES, kind: 'file', chunks: 256, sha256: 'a'.repeat(64),
    remote: { version: 1, chunkBytes: files.REMOTE_ATTACHMENT_CHUNK_BYTES, capability: 'b'.repeat(64), key: 'c'.repeat(64), ivPrefix: 'd'.repeat(16), hashes: Array(256).fill('e'.repeat(64)) } }
  assert.equal(files.isAttachmentMeta(metadata), true)
  assert.equal(files.isAttachmentMeta({ ...metadata, size: metadata.size + 1 }), false)
  assert.equal(files.isAttachmentMeta({ ...metadata, remote: undefined }), false)
  assert.equal(files.isAttachmentMeta({ ...metadata, remote: { ...metadata.remote, hashes: metadata.remote.hashes.slice(1) } }), false)
  assert.equal(files.formatFileSize(metadata.size), '1.0 GB')
  await assert.rejects(client.stageUpload({ size: files.MAX_FILE_BYTES + 1, name: 'too-big.bin', slice() { assert.fail('must reject before reading') } }, {}), /1 GB/)
})

test('real multi-part encryption uploads only bounded slices and publishes one descriptor on Send', async () => withRelay(async server => {
  const owner = await identity(), bytes = Uint8Array.from({ length: 2 * files.REMOTE_ATTACHMENT_CHUNK_BYTES + 31 }, (_, i) => i % 251)
  const file = new File([bytes], 'secrets.txt', { type: 'text/plain' }), slices = []
  file.arrayBuffer = () => assert.fail('whole-file read is forbidden')
  const slice = file.slice.bind(file); file.slice = (from, to) => { slices.push(to - from); return slice(from, to) }
  const prepared = await client.stageUpload(file, owner)
  assert.deepEqual(slices, [4194304, 4194304, 31])
  assert.equal(files.isAttachmentMeta(prepared.metadata), true)
  assert.equal(prepared.storage, 'remote')
  assert.equal(server.requests.some(request => request.action === 'file:publish'), false)
  const before = collector(); await assert.rejects(client.streamAttachmentDownload(prepared.metadata, owner, before), /Not published/)
  assert.equal(before.aborted, true)
  const eventKinds = []
  await files.publishAttachment(async (_id, kind, payload) => { eventKinds.push(kind); assert.equal(payload.content, 'My caption'); return 'message-id' }, 'friend', prepared, undefined, { content: 'My caption' })
  assert.deepEqual(eventKinds, ['attachment'])
  assert.ok(Number.isSafeInteger(prepared.metadata.remote.expiresAt))
  const sink = collector(); await client.streamAttachmentDownload(prepared.metadata, owner, sink)
  assert.equal(sink.closed, true); assert.deepEqual(Buffer.concat(sink.chunks), Buffer.from(bytes))
  await prepared.discard()
  assert.equal(server.uploads.has(prepared.metadata.id), true, 'discard must not remove a published attachment')
  const uploadActions = server.requests.filter(request => request.action !== 'file:read')
  for (const request of uploadActions) {
    const text = JSON.stringify(request.data)
    assert.ok(!text.includes(prepared.metadata.remote.key) && !text.includes(prepared.metadata.remote.capability))
    assert.ok(!text.includes('secrets.txt') && !text.includes('My caption'))
  }
}))

test('cancelled streaming upload deletes its unreadable draft without publishing', async () => withRelay(async server => {
  const owner = await identity(), controller = new AbortController()
  const file = new File([new Uint8Array(files.REMOTE_ATTACHMENT_CHUNK_BYTES + 10)], 'draft.bin')
  await assert.rejects(client.stageUpload(file, owner, 'file', percent => { if (percent > 0) controller.abort() }, controller.signal), error => error.name === 'AbortError')
  assert.deepEqual(server.requests.map(request => request.action), ['file:init', 'file:chunk', 'file:delete'])
  assert.equal(server.uploads.size, 0)
}))

test('corruption, descriptor tampering and cancellation abort output instead of offering a partial file', async () => withRelay(async server => {
  const owner = await identity(), prepared = await client.stageUpload(new File(['classified notes'], 'notes.txt'), owner)
  await prepared.publish()
  server.corrupt = true
  const corrupt = collector(); await assert.rejects(client.streamAttachmentDownload(prepared.metadata, owner, corrupt), /integrity/); assert.equal(corrupt.aborted, true); assert.equal(corrupt.closed, false)
  server.corrupt = false
  const tampered = structuredClone(prepared.metadata); tampered.remote.hashes[0] = '0'.repeat(64)
  const invalid = collector(); await assert.rejects(client.streamAttachmentDownload(tampered, owner, invalid), /integrity/); assert.equal(invalid.aborted, true)
  const wrongIv = structuredClone(prepared.metadata); wrongIv.remote.ivPrefix = '0'.repeat(16)
  const encrypted = collector(); await assert.rejects(client.streamAttachmentDownload(wrongIv, owner, encrypted), /encryption/); assert.equal(encrypted.aborted, true)
  const controller = new AbortController(); controller.abort()
  const cancelled = collector(); await assert.rejects(client.streamAttachmentDownload(prepared.metadata, owner, cancelled, undefined, controller.signal), error => error.name === 'AbortError'); assert.equal(cancelled.aborted, true)
}))

test('legacy fallback is prepared locally; cancelled drafts never send chunks and 1 GiB requires storage', async () => withRelay(async server => {
  server.available = false
  const owner = await identity(), events = []
  const prepared = await files.stageAttachment(async (...event) => { events.push(event); return 'id' }, 'friend', new File(['draft'], 'draft.txt'), owner)
  assert.equal(prepared.storage, 'local'); assert.equal(events.length, 0)
  await prepared.discard(); assert.equal(events.length, 0)
  await assert.rejects(prepared.publish(), /removed/)
  const ready = await files.stageAttachment(async (...event) => { events.push(event); return 'id' }, 'friend', new File(['ready'], 'ready.txt'), owner)
  await files.publishAttachment(async (...event) => { events.push(event); return 'id' }, 'friend', ready)
  assert.deepEqual(events.map(event => event[1]), ['attachment-chunk', 'attachment'])
  await assert.rejects(files.stageAttachment(() => assert.fail('no event'), 'friend', { name: 'large.bin', size: files.MAX_FILE_BYTES, arrayBuffer() { assert.fail('no whole read') } }, owner), /server needs file storage configured/)
}))

test('safe memory download is verified before becoming a Blob', async () => withRelay(async () => {
  const owner = await identity(), prepared = await client.stageUpload(new File(['<script>bad</script>'], 'active.html', { type: 'text/html' }), owner)
  await prepared.publish()
  const resource = await client.downloadRemoteAttachment(prepared.metadata, owner, { preview: true })
  assert.equal(resource.blob.type, 'application/octet-stream')
  assert.equal(await resource.blob.text(), '<script>bad</script>')
  await resource.dispose()
}))

test('native save picker streams verified pieces and cancellation never constructs a download Blob', async () => withRelay(async () => {
  const owner = await identity(), prepared = await client.stageUpload(new File(['disk-backed download'], 'notes.txt'), owner)
  await prepared.publish()
  const previousWindow = globalThis.window, sink = collector()
  let pickerCalled = false
  globalThis.window = { async showSaveFilePicker(options) { pickerCalled = true; assert.equal(options.suggestedName, 'notes.txt'); return { async createWritable() { return sink } } } }
  try {
    const pending = client.downloadRemoteAttachment(prepared.metadata, owner)
    assert.equal(pickerCalled, true, 'picker opens synchronously within the click gesture')
    const saved = await pending
    assert.equal(saved.blob, undefined); assert.equal(sink.closed, true)
    assert.equal(Buffer.concat(sink.chunks).toString(), 'disk-backed download')
    const controller = new AbortController()
    globalThis.window.showSaveFilePicker = async () => { controller.abort(); return { createWritable() { assert.fail('cancelled selection must not open a writer') } } }
    await assert.rejects(client.downloadRemoteAttachment(prepared.metadata, owner, { signal: controller.signal }), error => error.name === 'AbortError')
  } finally { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow }
}))

test('discard during a legacy Send cannot truncate the published attachment', async () => withRelay(async server => {
  server.available = false
  const owner = await identity(), events = [], first = Promise.withResolvers(), release = Promise.withResolvers()
  const prepared = await files.stageAttachment(async (_id, kind, payload) => { events.push({ kind, payload }); if (events.length === 1) { first.resolve(); await release.promise } return 'id' }, 'friend', new File([new Uint8Array(40000)], 'two-parts.bin'), owner)
  const sending = files.publishAttachment(async (_id, kind, payload) => { events.push({ kind, payload }); return 'id' }, 'friend', prepared)
  await first.promise
  await prepared.discard()
  release.resolve()
  await sending
  assert.deepEqual(events.map(event => event.kind), ['attachment-chunk', 'attachment-chunk', 'attachment'])
}))


test('eight legacy 50 MiB drafts retain file references without reading or encoding their contents', async () => withRelay(async server => {
  server.available = false
  const owner = await identity(), drafts = []
  for (let index = 0; index < 8; index++) {
    const file = { size: files.LEGACY_MAX_FILE_BYTES, name: `draft-${index}.bin`, type: 'application/octet-stream',
      arrayBuffer() { assert.fail('staging must not read a whole legacy file') }, slice() { assert.fail('staging must not read legacy chunks') } }
    drafts.push(await files.stageAttachment(() => assert.fail('staging must not publish'), 'friend', file, owner))
  }
  assert.ok(drafts.every(draft => draft.storage === 'local' && draft.metadata.size === files.LEGACY_MAX_FILE_BYTES))
  for (const draft of drafts) await draft.discard()
}))

test('a mismatched publication receipt cannot publish message metadata or delete an uncertain upload', async () => withRelay(async server => {
  const owner = await identity(), prepared = await client.stageUpload(new File(['receipt check'], 'receipt.txt'), owner)
  const validFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    const response = await validFetch(url, options)
    if (options.method === 'POST' && JSON.parse(options.body).action === 'file:publish') {
      return json({ ...(await response.json()), uploadId: crypto.randomUUID() })
    }
    return response
  }
  await assert.rejects(files.publishAttachment(() => assert.fail('invalid receipts must not become messages'), 'friend', prepared), /invalid upload details/)
  await prepared.discard()
  assert.equal(server.uploads.get(prepared.metadata.id).published, true, 'an uncertain publish keeps the uploaded file intact')
}))

test('completion follows verified durable cache commit; failed or corrupted downloads never acknowledge; reload uses cached bytes', async () => withRelay(async server => {
  const storage = source(path.join(root, 'lib/verified-attachment-cache'))
  const oldWrite = storage.cacheVerifiedAttachment, oldRead = storage.getVerifiedAttachment
  const saved = new Map(), order = []
  let failCache = false
  storage.cacheVerifiedAttachment = async (owner, metadata, blob) => {
    if (failCache) throw new Error('Storage full')
    saved.set(`${owner}:${metadata.id}`, blob); order.push('cache')
  }
  storage.getVerifiedAttachment = async (owner, metadata) => saved.get(`${owner}:${metadata.id}`)
  try {
    const alice = await identity(), bob = await identity(), file = new File(['verified local content'], 'note.txt', { type: 'text/plain' })
    const prepared = await client.stageUpload(file, alice)
    await prepared.publish()
    const messageId = crypto.randomUUID(), peers = [alice.publicKey, bob.publicKey].sort()
    const metadata = await client.registerAttachmentDelivery(alice, prepared.metadata, messageId, [bob.publicKey], { kind: 'direct', first: peers[0], second: peers[1], timestamp: Date.now() })
    assert.equal(metadata.remote.messageId, messageId)
    assert.equal(prepared.metadata.remote.messageId, messageId, 'retry retains the same binding before queueing')
    const base = server.fetch.bind(server)
    globalThis.fetch = async (url, options) => {
      if (options.method === 'POST' && JSON.parse(options.body).action === 'file:received') {
        order.push('ack')
        assert.ok(saved.has(`${bob.publicKey}:${metadata.id}`), 'receipt cannot precede durable local persistence')
      }
      return base(url, options)
    }
    order.length = 0
    server.corrupt = true
    await assert.rejects(client.downloadRemoteAttachment(metadata, bob, { preview: true }), /integrity/)
    assert.deepEqual(order, [])
    server.corrupt = false; failCache = true
    const memoryOnly = await client.downloadRemoteAttachment(metadata, bob, { preview: true })
    assert.equal(await memoryOnly.blob.text(), 'verified local content')
    assert.deepEqual(order, [], 'an in-memory preview with a failed cache commit does not release delivery storage')
    failCache = false
    const result = await client.downloadRemoteAttachment(metadata, bob, { preview: true })
    assert.deepEqual(order, ['cache', 'ack'])
    assert.equal(await result.blob.text(), 'verified local content')
    server.uploads.delete(metadata.id)
    const reads = server.requests.filter(item => item.action === 'file:read').length
    const reopened = await client.downloadRemoteAttachment(metadata, bob, { preview: true })
    assert.equal(await reopened.blob.text(), 'verified local content')
    assert.equal(server.requests.filter(item => item.action === 'file:read').length, reads, 'reopened file does not need the removed server bytes')
  } finally { storage.cacheVerifiedAttachment = oldWrite; storage.getVerifiedAttachment = oldRead }
}))

test('known expiry and authenticated removal stop repeated remote reads while verified local copies still open', async () => withRelay(async server => {
  const storage = source(path.join(root, 'lib/verified-attachment-cache'))
  const prior = { ...storage }, saved = new Map(), unavailable = new Set()
  const key = (owner, metadata) => `${owner}:${metadata.id}:${metadata.sha256}`
  storage.cacheVerifiedAttachment = async (owner, metadata, blob) => { saved.set(key(owner, metadata), blob) }
  storage.getVerifiedAttachment = async (owner, metadata) => saved.get(key(owner, metadata))
  storage.markAttachmentUnavailable = async (owner, metadata) => { unavailable.add(key(owner, metadata)) }
  storage.isAttachmentUnavailable = async (owner, metadata) => unavailable.has(key(owner, metadata))
  try {
    const owner = await identity(), recipient = await identity()
    const prepared = await client.stageUpload(new File(['local content'], 'note.txt'), owner)
    await prepared.publish()
    const expired = structuredClone(prepared.metadata)
    expired.remote.expiresAt = Date.now() - 1
    const before = server.requests.length
    await assert.rejects(client.downloadRemoteAttachment(expired, recipient, { preview: true }), /no longer available/)
    assert.equal(server.requests.length, before)
    assert.equal(await (await client.downloadRemoteAttachment(expired, owner, { preview: true })).blob.text(), 'local content')
    const realFetch = server.fetch.bind(server)
    let reads = 0
    globalThis.fetch = async (url, options) => {
      const { action, data, proof } = JSON.parse(options.body)
      if (action === 'file:read') {
        assert.equal(await auth.verifyRequestProof(action, data, proof), true)
        reads++
        return new Response(JSON.stringify({ success: false, error: 'File expired', code: 'file-expired' }), { status: 410 })
      }
      return realFetch(url, options)
    }
    await assert.rejects(client.downloadRemoteAttachment(prepared.metadata, recipient, { preview: true }), /no longer available/)
    assert.equal(reads, 1)
    await assert.rejects(client.downloadRemoteAttachment(prepared.metadata, recipient, { preview: true }), /no longer available/)
    assert.equal(reads, 1, 'the stored unavailable marker prevents another remote read on revisit')
    saved.set(key(recipient.publicKey, prepared.metadata), new Blob(['local content']))
    assert.equal(await (await client.downloadRemoteAttachment(prepared.metadata, recipient, { preview: true })).blob.text(), 'local content')
    assert.equal(reads, 1)
  } finally { Object.assign(storage, prior) }
}))


test('Force P2P activation during delivery signing prevents server metadata publication', async t => withRelay(async server => {
  const owner = await identity(), recipient = await identity()
  const prepared = await client.stageUpload(new File(['previous relay draft'], 'draft.txt'), owner)
  await prepared.publish()
  const peers = [owner.publicKey, recipient.publicKey].sort()
  const original = auth.createRequestProof
  let directOnly = false
  t.mock.method(auth, 'createRequestProof', async (...args) => {
    const proof = await original(...args)
    if (args[0] === 'file:delivery') directOnly = true
    return proof
  })
  const before = server.requests.length
  await assert.rejects(client.registerAttachmentDelivery(owner, prepared.metadata, crypto.randomUUID(), [recipient.publicKey],
    { kind: 'direct', first: peers[0], second: peers[1], timestamp: Date.now() },
    () => { if (directOnly) throw new Error('Force P2P is active') }), /Force P2P/)
  assert.equal(server.requests.length, before, 'final route check runs after asynchronous proof creation and before fetch')
}))
