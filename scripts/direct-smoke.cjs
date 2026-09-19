/* global Fixture, identity, engine */
/* Synthetic localhost browser verification; not evidence across real networks. */
const assert = require('node:assert/strict')
const http = require('node:http')
const path = require('node:path')
const esbuild = require('esbuild')
const { chromium } = require('playwright')
const root = path.join(__dirname, '..')
// Explicitly test fail-closed behavior on runners that cannot gather ICE candidates.
// This does not replace the normal successful-connection smoke on capable runners.
const expectUnavailable = process.env.SEROTINE_DIRECT_EXPECT_UNAVAILABLE === '1'

;(async () => {
  const source = 'export {MessagingEngine, validateMessagingEvent, signMessagingEvent} from "./lib/messaging"; export {loadIdentity,saveContacts} from "./lib/identity"; export * from "./lib/crypto"; export {exportMessagingSnapshot,importMessagingSnapshot,saveStoredEvent,eventStorageKey} from "./lib/messaging-store"; export {assembleAttachment} from "./lib/attachments";'
  const build = await esbuild.build({ stdin: { contents: source, resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'Fixture', logLevel: 'silent' })
  const checker = await esbuild.build({ stdin: { contents: 'export {validDirectSignal} from "./lib/direct-protocol"; export {verifyRequestProof} from "./lib/request-auth";', resolveDir: root }, bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' })
  const module = { exports: {} }; new Function('module', 'exports', 'require', checker.outputFiles[0].text)(module, module.exports, require)
  const signals = [], relayWrites = [], fileRequests = []
  const server = http.createServer(async (req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Synthetic Force P2P test</title>'); return }
    // Count every storage request, including binary PUTs and empty-body probes.
    if (req.url.startsWith('/api/files')) { fileRequests.push({ method: req.method }); res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'File storage must not be used' })); return }
    let raw = ''; for await (const piece of req) raw += piece
    try {
      const body = JSON.parse(raw); res.setHeader('content-type', 'application/json')
      if (req.url === '/api/direct') {
        assert.equal(await module.exports.verifyRequestProof(body.action, body.data, body.proof), true)
        if (body.action === 'direct:signal') {
          assert.equal(await module.exports.validDirectSignal(body.data.signal), true)
          assert.equal(body.data.signal.sender, body.proof.publicKey)
          signals.push(body.data.signal); res.end(JSON.stringify({ success: true })); return
        }
        res.end(JSON.stringify({ success: true, signals: signals.filter(signal => signal.recipient === body.proof.publicKey && signal.expiresAt > Date.now() && body.data.peers.includes(signal.sender)) })); return
      }
      if (body.action === 'event:send' || body.action === 'message:send') { relayWrites.push(body); throw new Error('Message relay must not be used') }
      res.end(JSON.stringify(body.action === 'event:sync' ? { success: true, messages: [], nextCursor: body.data.after || 0, hasMore: false } : { success: true, messages: [], nextCursor: null }))
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ success: false, error: error.message })) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch({ executablePath: process.env.SEROTINE_CHROMIUM_PATH || '/tmp/chromium', args: ['--no-sandbox', '--disable-dev-shm-usage'], headless: true })
  const pages = []
  try {
    for (let i = 0; i < 2; i++) {
      const context = await browser.newContext()
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
      const page = await context.newPage(); await page.goto(origin); await page.addScriptTag({ content: build.outputFiles[0].text }); pages.push(page)
      await page.evaluate(async () => { const pair = await Fixture.generateEncryptionKeyPair(); window.identity = { version: 2, publicKey: await Fixture.exportPublicKeyToHex(pair.publicKey), privateKey: await Fixture.exportKey(pair.privateKey) }; localStorage.setItem('serotine_identity_v2', JSON.stringify(identity)) })
    }
    const [a, b] = pages, [alice, bob] = await Promise.all(pages.map(page => page.evaluate(() => identity.publicKey)))
    for (const [page, peer] of [[a, bob], [b, alice]]) await page.evaluate(async peer => {
      Fixture.saveContacts(identity.publicKey, [{ pub: peer, alias: 'Synthetic test peer' }])
      // The fixture starts with explicit consent, including the synchronous policy
      // fence, before background optional-profile requests can be initialized.
      localStorage.setItem(`serotine.direct.v1:${identity.publicKey}:${peer}`, '1')
      window.engine = new Fixture.MessagingEngine(identity); engine.direct.dependencies.iceServers = []; await engine.start(); await engine.setDeliveryMode(peer, 'direct-only')
    }, peer)
    if (expectUnavailable) {
      // Use actual RTCPeerConnection and gathering deadlines. No route, stats,
      // send, or connection-state method is stubbed in this browser assertion.
      const attempts = await Promise.all([[a, bob], [b, alice]].map(async ([page, peer]) => {
        const result = await page.evaluate(async peer => {
          try { await engine.connectDirect(peer); return { setupError: null } }
          catch (error) { return { setupError: error.message } }
        }, peer)
        await page.waitForFunction(peer => ['failed', 'unavailable'].includes(engine.getDirectStatus(peer).state), peer, { timeout: 30000 })
        return { ...result, status: await page.evaluate(peer => engine.getDirectStatus(peer), peer) }
      }))
      assert.ok(attempts.every(attempt => ['failed', 'unavailable'].includes(attempt.status.state)))
      assert.ok(attempts.every(attempt => attempt.status.reason.length > 0))
      for (const [page, peer] of [[a, bob], [b, alice]]) {
        const blocked = await page.evaluate(async peer => {
          const results = []
          for (const action of [() => engine.sendText(peer, 'Unsent direct draft'), () => engine.sendDirectFile(peer, new File(['Unsent file bytes'], 'unsent.txt'))]) {
            try { await action(); results.push(false) } catch { results.push(true) }
          }
          await engine.sync()
          return { results, messages: engine.model.messages.length, mode: engine.getDeliveryMode(peer) }
        }, peer)
        assert.deepEqual(blocked, { results: [true, true], messages: 0, mode: 'direct-only' })
      }
      // A valid previously queued direct event represents an interrupted older
      // session. The signature-bound policy must survive backup and page reload.
      const pendingId = await a.evaluate(async peer => {
        const event = await Fixture.signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: identity.publicKey, conversationId: peer,
          recipients: [peer], timestamp: Date.now(), kind: 'message', route: 'direct-only', payload: { content: 'Previously queued direct content' } }, identity)
        if (!await Fixture.validateMessagingEvent(event)) throw new Error('Invalid pending fixture')
        await Fixture.saveStoredEvent(identity.publicKey, { key: Fixture.eventStorageKey(event), event, local: true, delivered: [], receivedAt: Date.now() })
        await engine.refresh()
        const backup = await Fixture.exportMessagingSnapshot(identity.publicKey)
        await engine.setDeliveryMode(peer, 'relay')
        await Fixture.importMessagingSnapshot(identity.publicKey, backup)
        await engine.refresh(); await engine.sync()
        if (engine.getDeliveryMode(peer) !== 'direct-only') throw new Error('Backup lost direct-only conversation policy')
        return event.id
      }, bob)
      await a.evaluate(() => engine.dispose()); await a.reload(); await a.addScriptTag({ content: build.outputFiles[0].text })
      const restored = await a.evaluate(async ({ peer, id }) => {
        window.identity = await Fixture.loadIdentity(); window.engine = new Fixture.MessagingEngine(identity)
        engine.direct.dependencies.iceServers = []; await engine.start()
        let retryRejected = false
        try { await engine.retry(id) } catch { retryRejected = true }
        await engine.sync()
        const record = engine.records.find(row => row.event.id === id)
        return { retryRejected, route: record?.event.route, delivered: record?.delivered, mode: engine.getDeliveryMode(peer), content: record?.event.payload.content }
      }, { peer: bob, id: pendingId })
      assert.deepEqual(restored, { retryRejected: true, route: 'direct-only', delivered: [], mode: 'direct-only', content: 'Previously queued direct content' })
      assert.equal(await b.evaluate(id => engine.model.messages.some(message => message.id === id), pendingId), false)
      assert.equal(relayWrites.length, 0); assert.equal(fileRequests.length, 0)
      assert.ok(signals.every(signal => !/Unsent direct draft|Unsent file bytes|Previously queued direct content/.test(JSON.stringify(signal))))
      process.stdout.write(`PASS actual browser unavailable route: both connection attempts fail closed; text/file sends rejected; queued direct policy survives backup, reload and retry; relay writes=${relayWrites.length}, file requests=${fileRequests.length}\n`)
      process.stdout.write('LIMIT: this verifies blocked-route behavior only. Successful direct delivery across separate real devices/networks remains an acceptance check.\n')
      return
    }
    const connect = async () => {
      await a.evaluate(peer => engine.connectDirect(peer), bob)
      await Promise.all([[a, bob], [b, alice]].map(async ([page, peer]) => {
        try { await page.waitForFunction(peer => engine.getDirectStatus(peer).state === 'connected', peer, { timeout: 20000 }) }
        catch (error) { throw new Error(`${error.message}: ${JSON.stringify(await page.evaluate(peer => engine.getDirectStatus(peer), peer))}`, { cause: error }) }
      }))
    }
    await connect()
    const id = await a.evaluate(peer => engine.sendText(peer, 'Synthetic direct text'), bob)
    assert.equal(await b.evaluate(id => engine.model.messages.find(message => message.id === id)?.content, id), 'Synthetic direct text')
    assert.equal(await a.evaluate(id => engine.model.messages.find(message => message.id === id)?.delivery, id), 'delivered')
    await a.evaluate(id => engine.retry(id), id)
    assert.equal(await b.evaluate(id => engine.model.messages.filter(message => message.id === id).length, id), 1)
    process.stdout.write('PASS signed direct handshake, encrypted text, authenticated acknowledgement and duplicate retry\n')
    const fileId = await a.evaluate(peer => engine.sendDirectFile(peer, new File([new Uint8Array(2 * 1024 * 1024).map((_, index) => index % 251)], 'two-mib.bin')), bob)
    const received = await b.evaluate(async id => { const message = engine.model.messages.find(message => message.id === id); const blob = await Fixture.assembleAttachment(message.attachment, engine.getAttachmentChunks(message.conversationId, id)); return { size: blob.size, last: new Uint8Array(await blob.arrayBuffer()).at(-1) } }, fileId)
    assert.deepEqual(received, { size: 2 * 1024 * 1024, last: (2 * 1024 * 1024 - 1) % 251 })
    const oversized = await a.evaluate(async peer => { try { await engine.sendDirectFile(peer, new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'too-large.bin')); return false } catch { return true } }, bob)
    assert.equal(oversized, true)
    process.stdout.write('PASS 2 MiB chunked direct file integrity, backpressure and size cap\n')
    await a.evaluate(async peer => { const controller = new AbortController(); try { await engine.sendDirectFile(peer, new File([new Uint8Array(160000)], 'cancel.bin'), controller.signal, percent => { if (percent > 25) controller.abort() }) } catch { /* Expected cancellation. */ } }, bob)
    const cancelled = await a.evaluate(() => engine.model.messages.find(message => message.attachment?.name === 'cancel.bin')?.id)
    assert.ok(cancelled); assert.equal(await b.evaluate(() => engine.model.messages.some(message => message.attachment?.name === 'cancel.bin')), false)
    await a.evaluate(id => engine.retry(id), cancelled)
    assert.equal(await b.evaluate(id => engine.model.messages.some(message => message.id === id), cancelled), true)
    process.stdout.write('PASS interrupted file remains incomplete and retries directly using the same signed IDs\n')
    await a.evaluate(async ({ peer, id }) => { const snapshot = await Fixture.exportMessagingSnapshot(identity.publicKey); await engine.setDeliveryMode(peer, 'relay'); await Fixture.importMessagingSnapshot(identity.publicKey, snapshot); await engine.refresh(); await engine.sync(); if (engine.getDeliveryMode(peer) !== 'direct-only') throw new Error('Restore lost routing policy'); if (!engine.records.find(record => record.event.id === id)?.event.route) throw new Error('Restore lost signed route') }, { peer: bob, id })
    await b.evaluate(peer => engine.direct.disconnect(peer), alice)
    await a.waitForFunction(peer => engine.getDirectStatus(peer).state !== 'connected', bob)
    const offline = await a.evaluate(async peer => { try { await engine.sendText(peer, 'Keep this offline draft'); return false } catch { return true } }, bob)
    assert.equal(offline, true)
    assert.equal(relayWrites.length, 0); assert.equal(fileRequests.length, 0)
    assert.ok(signals.length > 0)
    assert.ok(signals.every(signal => !JSON.stringify(signal).includes('Synthetic direct text')))
    process.stdout.write(`PASS offline/restore/mode changes never fall back; relay payload requests=${relayWrites.length}, file requests=${fileRequests.length}, setup signals=${signals.length}\n`)
    process.stdout.write('LIMIT: synthetic localhost Chromium only; real separate-network/device acceptance is still required.\n')
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)) }
})().catch(error => { console.error(error); process.exitCode = 1 })
