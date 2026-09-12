/* eslint-disable no-console */
/* global SerotinePrivate, engine */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const port = process.env.SEROTINE_BROWSER_PORT || '3123'
assert.match(port, /^\d+$/)
const origin = `http://localhost:${port}`
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

function localStatus() {
  return new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}`, response => { response.resume(); resolve(response.statusCode) })
    request.setTimeout(10000, () => request.destroy(new Error('Local server request timed out')))
    request.on('error', reject)
  })
}
async function identity() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey'])
  return { version: 2, publicKey: Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex'), privateKey: await crypto.subtle.exportKey('jwk', keys.privateKey) }
}

async function main() {
  const bundle = (await esbuild.build({ stdin: { contents: 'export * from "./lib/identity"; export * from "./lib/messaging"; export * from "./lib/messaging-store"; export * from "./lib/full-backup";', resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'SerotinePrivate', tsconfig: path.join(root, 'tsconfig.json') })).outputFiles[0].text
  const artifacts = process.env.SEROTINE_BROWSER_ARTIFACTS || fs.mkdtempSync('/tmp/serotine-private-chat-')
  fs.mkdirSync(artifacts, { recursive: true })
  const logPath = path.join(artifacts, 'server.log'), log = fs.openSync(logPath, 'w')
  const server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--port', port, '--hostname', '127.0.0.1'], { cwd: root, stdio: ['ignore', log, log] })
  let serverError, browser
  server.on('error', error => { serverError = error })
  try {
    let ready = false
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      if (serverError || server.exitCode !== null) throw new Error(`Server failed: ${serverError?.message || fs.readFileSync(logPath, 'utf8').slice(-4000)}`)
      try { if (await localStatus() === 200) { ready = true; break } } catch { /* Wait for startup. */ }
      await pause(500)
    }
    assert.ok(ready, `Server did not start: ${logPath}`)
    browser = await chromium.launch({ executablePath: process.env.SEROTINE_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'], headless: true })
    const errors = [], contexts = [], peers = [], relayBodies = []
    const [alice, bob] = await Promise.all([identity(), identity()])
    async function fixture(owner, contact) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'], colorScheme: 'dark' })
      contexts.push(context)
      context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
      context.on('request', request => { if (request.url().includes('/api/relay')) relayBodies.push(request.postData() || '') })
      const page = await context.newPage()
      await page.route(`${origin}/__private-fixture`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Private chat test peer</title>' }))
      await page.goto(`${origin}/__private-fixture`)
      await page.addScriptTag({ content: bundle })
      if (owner) await page.evaluate(({ owner, contact }) => {
        localStorage.setItem('serotine_identity_v2', JSON.stringify(owner))
        SerotinePrivate.saveContacts(owner.publicKey, [{ pub: contact.publicKey, alias: contact.alias }])
      }, { owner, contact })
      return page
    }
    const a = await fixture(alice, { ...bob, alias: 'Bob (test)' })
    const b = await fixture(bob, { ...alice, alias: 'Alice (test)' })
    peers.push(a, b)
    await Promise.all(peers.map(page => page.evaluate(async () => { window.engine = new SerotinePrivate.MessagingEngine(await SerotinePrivate.loadIdentity()); await engine.start() })))
    async function settle(predicate, label, timeout = 35000) {
      const end = Date.now() + timeout
      while (Date.now() < end) {
        await Promise.all(peers.map(page => page.evaluate(async () => { await engine.refresh(); await engine.sync() })))
        if (await predicate()) return
        await pause(250)
      }
      const states = await Promise.all(peers.map(page => page.evaluate(() => ({ status: engine.status, error: engine.error, count: engine.model.messages.length }))))
      throw new Error(`${label}: ${JSON.stringify(states)}`)
    }
    const ordinary = await a.evaluate(peer => engine.sendText(peer, 'Ordinary history remains'), bob.publicKey)
    await settle(() => b.evaluate(id => engine.model.messages.some(message => message.id === id), ordinary), 'ordinary encrypted delivery')
    const ui = await contexts[0].newPage()
    await ui.goto(`${origin}/chat/${bob.publicKey}`)
    const message = ui.getByRole('textbox', { name: 'Message', exact: true })
    await message.waitFor()
    await ui.getByRole('region', { name: 'Conversation messages' }).getByText('Ordinary history remains', { exact: true }).waitFor()

    await ui.getByRole('button', { name: 'Private chat settings', exact: true }).click()
    await ui.locator('#private-chat-duration').selectOption('300')
    await ui.getByRole('button', { name: 'Save timer', exact: true }).click()
    await ui.getByRole('dialog').waitFor({ state: 'hidden' })
    await settle(() => b.evaluate(peer => engine.model.conversations.find(item => item.id === peer)?.privateTtlSeconds === 300, alice.publicKey), 'shared private setting')
    const privateText = 'Synthetic private note https://example.com/private-test'
    await message.fill(privateText)
    assert.equal(await ui.evaluate(value => Object.values(localStorage).some(text => text.includes(value)), privateText), false, 'private draft never enters localStorage')
    await ui.getByRole('button', { name: 'Send message', exact: true }).click()
    await settle(() => b.evaluate(value => engine.model.messages.some(item => item.private && item.content === value), privateText), 'private UI text encrypted delivery')
    const privateId = await b.evaluate(value => engine.model.messages.find(item => item.content === value).id, privateText)
    assert.equal(await b.evaluate(peer => engine.model.conversations.find(item => item.id === peer).lastMessage.content, alice.publicKey), 'Private message', 'inbox preview omits private text')
    await ui.locator(`#message-${privateId}`).getByRole('button', { name: 'Message actions', exact: true }).click()
    assert.equal(await ui.getByRole('menuitem', { name: /^(Reply|Edit|Pin)$/ }).count(), 0, 'private actions cannot create retained copies')
    await ui.keyboard.press('Escape')
    console.log('PASS shared timer, encrypted private UI send, private draft omission, redacted previews and restricted actions')

    const secret = '  synthetic-key-for-browser-test-123456789  '
    await ui.getByRole('button', { name: 'Share access key', exact: true }).click()
    let keyDialog = ui.getByRole('dialog', { name: 'Share an access key', exact: true })
    await keyDialog.getByLabel('Access key', { exact: true }).fill(secret)
    assert.equal(await ui.evaluate(value => Object.values(localStorage).some(text => text.includes(value)), secret), false)
    await keyDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await ui.getByRole('button', { name: 'Share access key', exact: true }).click()
    keyDialog = ui.getByRole('dialog', { name: 'Share an access key', exact: true })
    assert.equal(await keyDialog.getByLabel('Access key', { exact: true }).inputValue(), '', 'cancel discards the key draft')
    await keyDialog.getByLabel('Access key', { exact: true }).fill(secret)
    await keyDialog.locator('#access-key-duration').selectOption('300')
    await keyDialog.getByRole('button', { name: 'Send access key', exact: true }).click()
    await keyDialog.waitFor({ state: 'hidden' })
    await settle(() => b.evaluate(value => engine.model.messages.some(item => item.private && item.secret && item.content === value), secret), 'exact access key encrypted delivery')
    const secretId = await b.evaluate(value => engine.model.messages.find(item => item.content === value).id, secret)
    const card = ui.locator(`#message-${secretId}`)
    await card.locator('[data-private-message="secret"]').waitFor()
    assert.equal(await ui.locator('body').textContent().then(text => text.includes(secret)), false, 'hidden key is not in DOM text')
    assert.equal(await card.locator('[data-secret-value]').count(), 0)
    await card.getByRole('button', { name: 'Reveal key', exact: true }).click()
    assert.equal(await card.locator('[data-secret-value]').textContent(), secret)
    await ui.evaluate(() => window.dispatchEvent(new Event('blur')))
    await card.getByRole('button', { name: 'Reveal key', exact: true }).waitFor()
    assert.equal(await card.locator('[data-secret-value]').count(), 0, 'blur removes key from rendered DOM')
    await ui.bringToFront()
    await card.getByRole('button', { name: 'Copy key', exact: true }).click()
    await card.getByRole('button', { name: 'Key copied', exact: true }).waitFor()
    assert.equal(await ui.evaluate(() => navigator.clipboard.readText()), secret, 'copy preserves exact key including whitespace')
    assert.equal(await card.locator('[data-secret-value]').count(), 0, 'copy does not reveal key')
    assert.equal(relayBodies.some(body => body.includes(privateText) || body.includes(secret)), false, 'relay requests contain ciphertext, never private plaintext')
    console.log('PASS key draft cancellation, exact encrypted delivery, hidden DOM, reveal/blur and clipboard copy')

    await ui.getByRole('button', { name: 'Search conversation', exact: true }).click()
    await ui.getByRole('textbox', { name: 'Search messages', exact: true }).fill('Synthetic private note')
    await ui.getByRole('search').getByText('No matches', { exact: true }).waitFor()
    await ui.getByRole('button', { name: 'Close search', exact: true }).click()
    await ui.getByRole('button', { name: /Search all messages/ }).click()
    const search = ui.getByRole('dialog', { name: 'Search all messages', exact: true })
    await search.getByRole('textbox', { name: 'Search messages, links, and files', exact: true }).fill('Synthetic private note')
    await search.getByText('No matching messages.', { exact: true }).waitFor()
    await search.getByRole('textbox', { name: 'Search messages, links, and files', exact: true }).fill('synthetic-key-for-browser-test')
    await search.getByText('No matching messages.', { exact: true }).waitFor()
    await search.getByRole('button', { name: 'Close', exact: true }).click()
    const backup = await a.evaluate(() => SerotinePrivate.exportFullBackup(engine.identity, 'synthetic backup test password'))
    const restored = await fixture()
    await restored.evaluate(text => SerotinePrivate.restoreBackup(text, 'synthetic backup test password'), backup)
    const restoredEvents = await restored.evaluate(async () => SerotinePrivate.getStoredEvents((await SerotinePrivate.loadIdentity()).publicKey))
    assert.ok(restoredEvents.some(record => record.event.id === ordinary), 'backup retains ordinary history')
    assert.equal(restoredEvents.some(record => record.event.kind === 'private-message'), false, 'backup restores no private plaintext')
    assert.equal(JSON.stringify(restoredEvents).includes(secret), false)
    console.log('PASS conversation/global search exclusions and encrypted backup restore without private messages')

    async function capture(name) {
      const dimensions = await ui.evaluate(() => ({ width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth, composerOverflow: document.querySelector('footer').scrollWidth > document.querySelector('footer').clientWidth + 1 }))
      assert.equal(dimensions.overflow, false, `${name}: viewport overflow`)
      assert.equal(dimensions.composerOverflow, false, `${name}: composer overflow`)
      await ui.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: true, style: 'nextjs-portal { display: none; }' })
      return dimensions
    }
    const sizes = [await capture('private-desktop')]
    for (const [width, height] of [[390, 844], [320, 568]]) {
      await ui.setViewportSize({ width, height })
      sizes.push(await capture(`private-phone-${width}`))
    }
    fs.writeFileSync(path.join(artifacts, 'viewport-checks.json'), JSON.stringify(sizes, null, 2))
    await ui.setViewportSize({ width: 1280, height: 900 })
    console.log('PASS desktop and 390px/320px private-chat layouts without horizontal overflow')

    const expiring = await a.evaluate(peer => engine.sendEvent(peer, 'private-message', { content: 'Short synthetic expiry', expiresAt: Date.now() + 6000, secret: true }), bob.publicKey)
    await settle(() => b.evaluate(id => engine.model.messages.some(item => item.id === id), expiring), 'short signed message arrival')
    await ui.locator(`#message-${expiring}`).waitFor()
    await ui.locator(`#message-${expiring}`).waitFor({ state: 'detached', timeout: 15000 })
    await settle(async () => (await Promise.all(peers.map(page => page.evaluate(id => engine.model.messages.every(item => item.id !== id), expiring)))).every(Boolean), 'expiry from both live models')
    for (const peer of peers) assert.equal(await peer.evaluate(async id => (await SerotinePrivate.getStoredEvents(engine.identity.publicKey)).some(record => record.event.id === id), expiring), false, 'expiry removes durable plaintext')
    console.log('PASS signed short-lived key expiry from UI, both peers and durable storage')

    await ui.getByRole('button', { name: 'Private chat settings', exact: true }).click()
    await ui.getByRole('button', { name: 'Destroy private history', exact: true }).click()
    const destroy = ui.getByRole('dialog', { name: 'Destroy private history?', exact: true })
    await destroy.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal(await card.count(), 1, 'cancel preserves key')
    await ui.getByRole('button', { name: 'Destroy private history', exact: true }).click()
    await destroy.getByRole('button', { name: 'Destroy private history', exact: true }).click()
    await destroy.waitFor({ state: 'hidden' })
    await settle(async () => (await Promise.all(peers.map(page => page.evaluate(() => engine.model.messages.every(item => !item.private))))).every(Boolean), 'destruction on both peers')
    await card.waitFor({ state: 'detached' })
    await ui.locator(`#message-${ordinary}`).waitFor()
    for (const peer of peers) assert.equal(await peer.evaluate(async () => (await SerotinePrivate.getStoredEvents(engine.identity.publicKey)).some(record => record.event.kind === 'private-message')), false)
    await ui.reload(); await message.waitFor()
    assert.equal(await ui.locator('[data-private-message]').count(), 0, 'reload does not resurrect destroyed content')
    console.log('PASS destroy cancellation, confirmed destruction on both peers, durable cleanup and ordinary history preservation')

    await ui.getByRole('button', { name: 'Backups and linked devices', exact: true }).click()
    const account = ui.getByRole('dialog')
    const password = account.getByLabel('Backup password', { exact: true })
    const confirmation = account.getByLabel('Confirm password', { exact: true })
    const passwordText = 'synthetic password for typing'
    await account.getByRole('checkbox', { name: 'Show password', exact: true }).check()
    await ui.evaluate(value => navigator.clipboard.writeText(value), passwordText)
    await password.focus(); await ui.keyboard.press('Control+V')
    assert.equal(await password.inputValue(), passwordText, 'primary password accepts native paste')
    await password.selectText(); await ui.keyboard.press('Control+C')
    assert.equal(await ui.evaluate(() => navigator.clipboard.readText()), passwordText, 'primary password native copy remains allowed')
    await confirmation.focus(); await ui.keyboard.press('Control+V')
    assert.equal(await confirmation.inputValue(), '', 'confirmation blocks native paste')
    const dropPrevented = await confirmation.evaluate(node => {
      const transfer = new DataTransfer(); transfer.setData('text/plain', 'dropped password')
      const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
      node.dispatchEvent(event); return event.defaultPrevented
    })
    assert.equal(dropPrevented, true, 'confirmation blocks text drop')
    await confirmation.pressSequentially(passwordText)
    assert.equal(await confirmation.inputValue(), passwordText, 'confirmation accepts retyping')
    await confirmation.selectText(); await ui.keyboard.press('Control+C')
    assert.equal(await ui.evaluate(() => navigator.clipboard.readText()), passwordText, 'confirmation native copy remains allowed')
    assert.ok(await confirmation.getAttribute('aria-describedby'), 'confirmation explains retyping accessibly')
    await account.getByRole('button', { name: 'Restore', exact: true }).click()
    await password.focus(); await ui.keyboard.press('Control+V')
    assert.equal(await password.inputValue(), passwordText, 'restore password keeps native paste')
    await account.getByRole('button', { name: 'Close', exact: true }).click()
    console.log('PASS real clipboard paste/copy, confirmation retyping/drop restriction and restore paste')
    assert.deepEqual(errors, [], 'no browser runtime errors')
    console.log(`PASS private-chat smoke; artifacts: ${artifacts}`)
  } finally {
    await browser?.close()
    server.kill('SIGTERM')
    fs.closeSync(log)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
