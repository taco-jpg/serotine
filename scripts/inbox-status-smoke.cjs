/* eslint-disable no-console */
/* global SerotineInbox */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const port = process.env.SEROTINE_BROWSER_PORT || '3105'
assert.match(port, /^\d+$/)
const origin = `http://localhost:${port}`
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function identity() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey'])
  return { version: 2, publicKey: Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('hex'), privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey) }
}

async function main() {
  // Next development uses the local Cloudflare D1 emulator. Every key here is
  // newly generated test data; no production origin or identity is accessed.
  const bundle = (await esbuild.build({ stdin: { contents: 'export * from "./lib/identity"; export * from "./lib/messaging"; export * from "./lib/messaging-store"; export * from "./lib/relay-client"; export * from "./lib/request-auth";', resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'SerotineInbox', tsconfig: path.join(root, 'tsconfig.json') })).outputFiles[0].text
  const artifacts = process.env.SEROTINE_BROWSER_ARTIFACTS || fs.mkdtempSync('/tmp/serotine-inbox-status-')
  fs.mkdirSync(artifacts, { recursive: true })
  const logPath = path.join(artifacts, 'server.log')
  const log = fs.openSync(logPath, 'w')
  const server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--port', port, '--hostname', '127.0.0.1'], { cwd: root, stdio: ['ignore', log, log] })
  let browser
  try {
    let ready = false
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`Server failed: ${fs.readFileSync(logPath, 'utf8').slice(-3000)}`)
      try { if ((await fetch(origin, { signal: AbortSignal.timeout(3000) })).ok) { ready = true; break } } catch { /* Wait for compilation. */ }
      await pause(500)
    }
    assert.ok(ready, `Server did not become ready: ${logPath}`)
    browser = await chromium.launch({ executablePath: process.env.SEROTINE_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'], headless: true })
    const errors = []
    const [alice, bob, charlie] = await Promise.all([identity(), identity(), identity()])
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const peers = await Promise.all([browser.newContext(), browser.newContext()])
    const [alicePage, bobPage, charliePage] = await Promise.all([mobile.newPage(), peers[0].newPage(), peers[1].newPage()])
    async function bootstrap(page, owner, contacts) {
      page.on('pageerror', error => errors.push(error.message))
      await page.route(`${origin}/__inbox-status-test`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Inbox status regression</title>' }))
      await page.goto(`${origin}/__inbox-status-test`)
      await page.addScriptTag({ content: bundle })
      await page.evaluate(({ owner, contacts }) => {
        localStorage.setItem('serotine_identity_v2', JSON.stringify(owner))
        SerotineInbox.saveContacts(owner.publicKey, contacts)
      }, { owner, contacts })
    }
    await Promise.all([
      bootstrap(alicePage, alice, [{ pub: bob.publicKey, alias: 'Bob' }, { pub: charlie.publicKey, alias: 'Charlie' }]),
      bootstrap(bobPage, bob, [{ pub: alice.publicKey, alias: 'Alice' }]),
      bootstrap(charliePage, charlie, [{ pub: alice.publicKey, alias: 'Alice' }]),
    ])
    await bobPage.evaluate(async recipient => {
      window.inboxTestEngine = new SerotineInbox.MessagingEngine(await SerotineInbox.loadIdentity())
      await window.inboxTestEngine.start()
      await window.inboxTestEngine.sendText(recipient, 'Bob before retirement')
    }, alice.publicKey)
    await bobPage.waitForFunction(() => window.inboxTestEngine.model.messages.some(message => message.content === 'Bob before retirement' && message.delivery === 'sent'))
    const retirement = await bobPage.evaluate(async () => {
      window.inboxTestEngine.dispose()
      const owner = await SerotineInbox.loadIdentity(), data = {}
      return SerotineInbox.retireIdentity(data, await SerotineInbox.createRequestProof('identity:retire', data, owner.privateKey, owner.publicKey))
    })
    assert.equal(retirement.success, true)
    await alicePage.evaluate(async recipient => {
      window.inboxTestEngine = new SerotineInbox.MessagingEngine(await SerotineInbox.loadIdentity())
      await window.inboxTestEngine.start()
      await window.inboxTestEngine.sendText(recipient, 'Saved message to Bob')
    }, bob.publicKey)
    // Both the visible message and the automatic delivery receipt must really
    // have been refused by the local server, then survive a fresh UI mount.
    await alicePage.waitForFunction(() => ['message', 'receipt'].every(kind => window.inboxTestEngine.records.some(record => record.local && record.event.kind === kind && /contact.*retired/.test(record.error || ''))))
    const state = await alicePage.evaluate(() => {
      const engine = window.inboxTestEngine
      const result = { status: engine.status, error: engine.error }
      engine.dispose()
      return result
    })
    assert.deepEqual(state, { status: 'online', error: null })
    console.log('PASS real local recipient retirement rejects a message and automatic receipt without disconnecting Alice')

    await alicePage.goto(`${origin}/chat`)
    const inbox = alicePage.getByRole('complementary', { name: 'Inbox', exact: true })
    await inbox.getByRole('status').filter({ hasText: 'Inbox connected' }).waitFor()
    assert.equal(await inbox.getByRole('alert').count(), 0, 'old recipient refusals cannot become global inbox errors')
    assert.equal(await inbox.getByText(/permanently retired/).count(), 0)
    assert.equal(await alicePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await alicePage.screenshot({ path: path.join(artifacts, 'mobile-inbox-connected.png'), fullPage: true, style: 'nextjs-portal { display: none; }' })
    await alicePage.getByRole('link').filter({ hasText: 'Bob' }).click()
    const scoped = alicePage.getByRole('alert').filter({ hasText: 'Delivery issue in this conversation' })
    await scoped.waitFor()
    assert.match(await scoped.innerText(), /contact.*retired/)
    await alicePage.getByRole('status').filter({ hasText: 'Inbox connected' }).first().waitFor()
    assert.equal(await alicePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
    await alicePage.screenshot({ path: path.join(artifacts, 'mobile-bob-delivery-issue.png'), fullPage: true, style: 'nextjs-portal { display: none; }' })
    console.log('PASS mobile Inbox stays connected and the retirement warning is scoped to Bob’s chat')

    await alicePage.getByRole('link', { name: 'Back to conversations', exact: true }).click()
    await alicePage.getByRole('link').filter({ hasText: 'Charlie' }).click()
    await alicePage.getByRole('heading', { name: 'Charlie', exact: true, level: 1 }).waitFor()
    assert.equal(await alicePage.getByRole('main').getByRole('alert').count(), 0, 'Charlie cannot inherit Bob’s error')
    await charliePage.goto(`${origin}/chat/${alice.publicKey}`)
    const message = 'Healthy delivery after a retired contact failed'
    const composer = alicePage.getByRole('textbox', { name: 'Message', exact: true })
    await composer.fill(message)
    await composer.press('Enter')
    await charliePage.getByRole('region', { name: 'Conversation messages', exact: true }).getByText(message, { exact: true }).waitFor()
    assert.equal(await alicePage.getByRole('main').getByRole('alert').count(), 0)
    console.log('PASS Charlie receives a new message while Bob’s old sends remain failed')

    await alicePage.getByRole('link', { name: 'Back to conversations', exact: true }).click()
    const unavailable = async route => {
      const request = route.request().postDataJSON()
      if (request.action === 'event:sync' || request.action === 'message:inbox') await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Local test relay unavailable.' }) })
      else await route.continue()
    }
    await alicePage.route(`${origin}/api/relay`, unavailable)
    await alicePage.evaluate(() => window.dispatchEvent(new Event('online')))
    await inbox.getByRole('status').filter({ hasText: 'Inbox sync unavailable' }).waitFor()
    await inbox.getByRole('alert').waitFor()
    assert.doesNotMatch(await inbox.getByRole('alert').innerText(), /retired/)
    await alicePage.screenshot({ path: path.join(artifacts, 'mobile-relay-unavailable.png'), fullPage: true, style: 'nextjs-portal { display: none; }' })
    await alicePage.unroute(`${origin}/api/relay`, unavailable)
    await inbox.getByRole('button', { name: 'Reconnect inbox', exact: true }).click()
    await inbox.getByRole('status').filter({ hasText: 'Inbox connected' }).waitFor()
    assert.equal(await inbox.getByRole('alert').count(), 0)
    console.log('PASS a real sync transport failure shows unavailable; reconnect clears it despite saved recipient failures')
    assert.deepEqual(errors, [], 'no browser runtime errors')
    console.log(`Screenshots and local server log: ${artifacts}`)
  } finally {
    await browser?.close()
    server.kill('SIGTERM')
    fs.closeSync(log)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
