/* eslint-disable no-console */
/* global RelayFixed, RelayBefore, relaySmoke */
// Real browser headers, application signatures/actions, and isolated SQLite.
// No fetch mocks, request interception, production origin, or saved identities.
// Run Safari's engine with SEROTINE_BROWSER=webkit node scripts/relay-origin-smoke.cjs
// after installing its browser/dependencies with npx playwright install --with-deps webkit.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const ts = require('typescript')
const esbuild = require('esbuild')
const { chromium, webkit } = require('playwright')
const root = path.resolve(__dirname, '..')
const originError = 'Open Serotine directly to reconnect to messaging.'
const browserName = process.env.SEROTINE_BROWSER || 'chromium'
assert.ok(['chromium', 'webkit'].includes(browserName), 'SEROTINE_BROWSER must be chromium or webkit')

function loadRoute(db) {
  const cache = new Map()
  function load(filename) {
    if (!path.extname(filename)) filename += '.ts'
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }
    cache.set(filename, module)
    const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText
    const requireSource = specifier => {
      if (specifier === '@opennextjs/cloudflare') return { getCloudflareContext: () => ({ env: { serotine_db: db } }) }
      if (specifier.startsWith('@/')) return load(path.join(root, specifier.slice(2)))
      if (specifier.startsWith('.')) return load(path.resolve(path.dirname(filename), specifier))
      return require(specifier)
    }
    new Function('require', 'module', 'exports', source)(requireSource, module, module.exports)
    return module.exports
  }
  return load(path.join(root, 'app/api/relay/route.ts')).POST
}

async function bundle(beforeFix) {
  return (await esbuild.build({
    stdin: { contents: 'export * from "./lib/relay-client"; export * from "./lib/crypto"; export * from "./lib/request-auth";', resolveDir: root },
    bundle: true, write: false, platform: 'browser', format: 'iife',
    globalName: beforeFix ? 'RelayBefore' : 'RelayFixed', tsconfig: path.join(root, 'tsconfig.json'),
    plugins: beforeFix ? [{ name: 'remove-request-referrer-fix', setup(build) {
      build.onLoad({ filter: /[/\\]relay-client\.ts$/ }, args => {
        const current = fs.readFileSync(args.path, 'utf8')
        const contents = current.replace(/referrerPolicy:\s*["']strict-origin["']\s*,?/g, '')
        assert.notEqual(contents, current, 'the regression control must remove the request override')
        return { contents, loader: 'ts', resolveDir: path.dirname(args.path) }
      })
    } }] : [],
  })).outputFiles[0].text
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${server.address().port}`
}

async function main() {
  const sqlite = new DatabaseSync(':memory:')
  let databaseCalls = 0
  const db = { prepare(sql) {
    databaseCalls++
    let values = []
    return {
      bind(...args) { values = args; return this },
      async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } } },
      async first() { return sqlite.prepare(sql).get(...values) ?? null },
      async all() { return { results: sqlite.prepare(sql).all(...values) } },
    }
  } }
  const POST = loadRoute(db)
  const wire = [], serverErrors = []
  let origin, browser, fixedBundle, beforeBundle
  const document = (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Referrer-Policy': 'no-referrer' })
    response.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Relay origin regression</title><script src="/fixed.js"></script><script src="/before.js"></script>')
  }
  const server = http.createServer(async (request, response) => {
    if (request.url === '/fixed.js' || request.url === '/before.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript', 'Referrer-Policy': 'no-referrer' })
      response.end(request.url === '/fixed.js' ? fixedBundle : beforeBundle)
      return
    }
    if (request.url !== '/api/relay' || request.method !== 'POST') return document(request, response)
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = Buffer.concat(chunks)
      const headers = new Headers()
      for (const [name, value] of Object.entries(request.headers)) {
        for (const entry of Array.isArray(value) ? value : [value]) if (entry !== undefined) headers.append(name, entry)
      }
      const result = await POST(new Request(`${origin}/api/relay`, { method: 'POST', headers, body }))
      const text = await result.text()
      wire.push({ action: JSON.parse(body).action, origin: headers.get('origin'), referer: headers.get('referer'),
        fetchSite: headers.get('sec-fetch-site'), status: result.status, result: JSON.parse(text) })
      response.writeHead(result.status, Object.fromEntries(result.headers))
      response.end(text)
    } catch (error) {
      serverErrors.push(error.message)
      response.writeHead(500)
      response.end('Local test server failed')
    }
  })
  const foreignServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html', 'Referrer-Policy': 'no-referrer' })
    response.end('<!doctype html><title>Foreign origin</title>')
  })
  try {
    origin = await listen(server)
    const foreignOrigin = await listen(foreignServer)
    ;[fixedBundle, beforeBundle] = await Promise.all([bundle(false), bundle(true)])
    browser = browserName === 'webkit'
      ? await webkit.launch({ headless: true })
      : await chromium.launch({ executablePath: process.env.SEROTINE_CHROMIUM_PATH,
        args: ['--no-sandbox', '--disable-dev-shm-usage'], headless: true })
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const page = await context.newPage()
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error.message))
    const response = await page.goto(`${origin}/chat/synthetic-private-contact?private-query=never-leak`)
    assert.equal(response.headers()['referrer-policy'], 'no-referrer')
    const oldResult = await page.evaluate(async () => {
      async function identity() {
        const pair = await RelayFixed.generateEncryptionKeyPair()
        return { pair, privateJwk: await RelayFixed.exportKey(pair.privateKey), publicKey: await RelayFixed.exportPublicKeyToHex(pair.publicKey) }
      }
      const [alice, bob] = await Promise.all([identity(), identity()])
      const data = { id: crypto.randomUUID(), recipientPubKey: bob.publicKey,
        encryptedData: await RelayFixed.encryptForPeer('Private origin regression', alice.pair.privateKey, bob.publicKey) }
      const proof = await RelayFixed.createRequestProof('message:send', data, alice.privateJwk, alice.publicKey)
      window.relaySmoke = { alice, bob, data, proof }
      return RelayBefore.getLegacyInbox({}, await RelayFixed.createRequestProof('message:inbox', {}, bob.privateJwk, bob.publicKey))
    })
    assert.equal(wire.length, 1)
    assert.equal(wire[0].fetchSite, 'same-origin')
    assert.equal(wire[0].referer, null)
    if (browserName === 'webkit') {
      assert.equal(wire[0].origin, 'null', 'WebKit must reproduce the pre-fix Origin: null failure')
    }
    // Engines differ here. Record the real pre-fix behavior without inventing
    // an opaque Origin through a header override or request interception.
    if (wire[0].origin === 'null') {
      assert.equal(wire[0].status, 403)
      assert.deepEqual(oldResult, { success: false, error: originError })
      assert.equal(databaseCalls, 0)
      console.log('PASS original client reproduces the screenshot: inherited no-referrer sends Origin: null and returns the exact 403')
    } else {
      assert.equal(wire[0].origin, origin)
      assert.equal(wire[0].status, 200)
      assert.deepEqual(oldResult, { success: true, messages: [], nextCursor: null })
      console.log(`INFO this ${browserName} preserves Origin with inherited no-referrer; the original iPhone failure is not reproduced here`)
    }

    const fixed = await page.evaluate(async () => {
      const { alice, bob, data, proof } = relaySmoke
      const sign = (action, payload, signer) => RelayFixed.createRequestProof(action, payload, signer.privateJwk, signer.publicKey)
      const sent = await RelayFixed.storeEncryptedMessage(data, proof)
      const listData = { senderPubKey: alice.publicKey }
      const listed = await RelayFixed.getMyMessages(listData, await sign('message:list', listData, bob))
      const plaintext = await RelayFixed.decryptFromPeer(listed.messages[0].encryptedData, bob.pair.privateKey, alice.publicKey)
      const inbox = await RelayFixed.getLegacyInbox({}, await sign('message:inbox', {}, bob))
      const eventData = { ...data, id: crypto.randomUUID(),
        encryptedData: await RelayFixed.encryptForPeer('Modern chat origin regression', alice.pair.privateKey, bob.publicKey) }
      const eventSent = await RelayFixed.storeEncryptedEvent(eventData, await sign('event:send', eventData, alice))
      const synced = await RelayFixed.getEventFeed({}, await sign('event:sync', {}, bob))
      const eventPlaintext = await RelayFixed.decryptFromPeer(synced.messages[0].encryptedData, bob.pair.privateKey, alice.publicKey)
      const replay = await RelayFixed.storeEncryptedMessage(data, proof)
      return { sent, count: listed.messages.length, plaintext, inboxCount: inbox.messages.length,
        eventSent, eventCount: synced.messages.length, eventPlaintext, replay }
    })
    assert.deepEqual(fixed.sent, { success: true })
    assert.equal(fixed.count, 1)
    assert.equal(fixed.inboxCount, 1)
    assert.equal(fixed.plaintext, 'Private origin regression')
    assert.deepEqual(fixed.eventSent, { success: true })
    assert.equal(fixed.eventCount, 1)
    assert.equal(fixed.eventPlaintext, 'Modern chat origin regression')
    assert.equal(fixed.replay.success, false)
    assert.match(fixed.replay.error, /already used/)
    assert.deepEqual(wire.slice(1).map(entry => entry.action), [
      'message:send', 'message:list', 'message:inbox', 'event:send', 'event:sync', 'message:send',
    ])
    for (const entry of wire.slice(1)) {
      assert.equal(entry.origin, origin)
      assert.equal(entry.fetchSite, 'same-origin')
      assert.equal(entry.referer, `${origin}/`, 'only the site origin is allowed; the private chat path and query must remain absent')
      assert.equal(entry.status, 200)
    }
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM RelayMessage').get().count, 1)
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM RelayEvent').get().count, 1)
    console.log('PASS fixed browser client sends, lists, syncs and decrypts with same-origin Origin and origin-only Referer; private path/query stay absent and replay stays rejected')

    const attemptedBody = await page.evaluate(() => JSON.stringify({ version: 2, action: 'message:send', data: relaySmoke.data, proof: relaySmoke.proof }))
    const beforeRejections = databaseCalls
    const foreign = await context.newPage()
    await foreign.goto(foreignOrigin)
    await foreign.evaluate(async ({ origin, body }) => {
      await fetch(`${origin}/api/relay`, { method: 'POST', mode: 'no-cors', referrerPolicy: 'strict-origin-when-cross-origin', body })
    }, { origin, body: attemptedBody })
    assert.equal(wire.at(-1).origin, foreignOrigin)
    assert.equal(wire.at(-1).status, 403)
    assert.deepEqual(wire.at(-1).result, { success: false, error: originError })
    await page.evaluate(() => new Promise(resolve => {
      const iframe = document.createElement('iframe')
      iframe.sandbox = 'allow-scripts'
      iframe.srcdoc = '<!doctype html><title>Opaque origin</title>'
      iframe.onload = resolve
      document.body.append(iframe)
    }))
    const opaque = page.frames().find(frame => frame.url() === 'about:srcdoc')
    assert.ok(opaque)
    await opaque.evaluate(async ({ origin, body }) => {
      await fetch(`${origin}/api/relay`, { method: 'POST', mode: 'no-cors', referrerPolicy: 'strict-origin-when-cross-origin', body })
    }, { origin, body: attemptedBody })
    assert.equal(wire.at(-1).origin, 'null')
    assert.equal(wire.at(-1).status, 403)
    assert.deepEqual(wire.at(-1).result, { success: false, error: originError })
    assert.equal(databaseCalls, beforeRejections)
    assert.deepEqual(serverErrors, [])
    assert.deepEqual(pageErrors, [])
    console.log('PASS real foreign-page and opaque sandbox requests remain rejected before database access')
    console.log(`Verified in ${browserName} ${browser.version()} with a mobile viewport; physical iPhone/Safari was not available.`)
  } finally {
    await browser?.close()
    await Promise.all([server, foreignServer].map(active => new Promise(resolve => {
      active.closeAllConnections()
      active.close(resolve)
    })))
    sqlite.close()
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
