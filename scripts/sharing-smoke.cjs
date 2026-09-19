/* eslint-disable no-console */
/* global SerotinePlugins, engine */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')
const esbuild = require('esbuild')
const { localBrowserEnvironment } = require('./local-browser-support.cjs')
const root = path.resolve(__dirname, '..')
const port = process.env.SEROTINE_BROWSER_PORT || '3127'
assert.match(port, /^\d+$/)
const origin = `http://localhost:${port}`
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function identity() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey'])
  return { version: 2, publicKey: Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex'), privateKey: await crypto.subtle.exportKey('jwk', keys.privateKey) }
}

async function main() {
  const bundle = (await esbuild.build({ stdin: { contents: 'export * from "./lib/identity"; export * from "./lib/messaging"; export * from "./lib/messaging-store";', resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'SerotinePlugins', tsconfig: path.join(root, 'tsconfig.json') })).outputFiles[0].text
  const artifacts = process.env.SEROTINE_BROWSER_ARTIFACTS || fs.mkdtempSync('/tmp/serotine-sharing-')
  fs.mkdirSync(artifacts, { recursive: true })
  const logPath = path.join(artifacts, 'server.log'), log = fs.openSync(logPath, 'w')
  const environment = await localBrowserEnvironment(root, artifacts)
  const server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--port', port, '--hostname', '127.0.0.1'], { cwd: root, env: environment, stdio: ['ignore', log, log] })
  let serverError, browser, ui
  const errors = []
  server.on('error', error => { serverError = error })
  try {
    let ready = false
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      if (serverError || server.exitCode !== null) throw new Error(`Server failed: ${serverError?.message || fs.readFileSync(logPath, 'utf8').slice(-4000)}`)
      try { if ((await fetch(origin, { signal: AbortSignal.timeout(10000) })).ok) { ready = true; break } } catch { /* Wait for startup. */ }
      await pause(500)
    }
    assert.ok(ready, `Server did not start: ${logPath}`)
    browser = await chromium.launch({ executablePath: process.env.SEROTINE_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'], headless: true })
    const contexts = [], peers = []
    const [alice, bob] = await Promise.all([identity(), identity()])
    async function fixture(owner, contact) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' })
      context.setDefaultTimeout(15000)
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'))
      contexts.push(context)
      context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
      const page = await context.newPage()
      await page.route(`${origin}/__plugin-fixture`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Plugin integration peer</title>' }))
      await page.goto(`${origin}/__plugin-fixture`)
      await page.addScriptTag({ content: bundle })
      await page.evaluate(({ owner, contact }) => {
        localStorage.setItem('serotine_identity_v2', JSON.stringify(owner))
        SerotinePlugins.saveContacts(owner.publicKey, [{ pub: contact.publicKey, alias: contact.alias }])
      }, { owner, contact })
      await page.evaluate(async () => { window.engine = new SerotinePlugins.MessagingEngine(await SerotinePlugins.loadIdentity()); await engine.start() })
      peers.push(page)
      return page
    }
    const a = await fixture(alice, { ...bob, alias: 'Bob private test alias' })
    const b = await fixture(bob, { ...alice, alias: 'Alice private test alias' })
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
    const ordinaryText = 'Share this selected message.'
    const first = await b.evaluate(({ peer, text }) => engine.sendText(peer, text), { peer: alice.publicKey, text: ordinaryText })
    const excluded = await b.evaluate(peer => engine.sendText(peer, 'Unselected text stays here.'), alice.publicKey)
    await settle(() => a.evaluate(id => engine.model.messages.some(message => message.id === id), excluded), 'ordinary source messages')
    ui = await contexts[0].newPage()
    await ui.goto(`${origin}/chat/${bob.publicKey}`)
    await ui.locator(`#message-${first}`).waitFor()
    await ui.getByRole('button', { name: 'Select messages', exact: true }).click()
    await ui.getByRole('checkbox', { name: `Select message ${first}`, exact: true }).check()
    await ui.getByRole('button', { name: 'Share selected', exact: true }).click()
    let dialog = ui.getByRole('dialog', { name: 'Share selected messages', exact: true })
    await dialog.waitFor()
    await dialog.locator('summary').click()
    assert.ok((await dialog.innerText()).includes(ordinaryText))
    assert.equal((await dialog.innerText()).includes('Unselected text stays here.'), false)
    assert.equal((await dialog.locator('details').innerText()).includes('Bob private test alias'), false)
    assert.equal(await dialog.getByRole('button', { name: 'Send shared copy', exact: true }).isEnabled(), false)
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal(await b.evaluate(() => engine.model.messages.some(message => message.shared)), false)
    await ui.getByRole('button', { name: 'Share selected', exact: true }).click()
    dialog = ui.getByRole('dialog', { name: 'Share selected messages', exact: true })
    await dialog.getByLabel('Share destination', { exact: true }).selectOption(bob.publicKey)
    await ui.setViewportSize({ width: 390, height: 844 })
    await ui.waitForTimeout(250)
    assert.equal(await ui.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile share preview fits')
    await ui.screenshot({ path: path.join(artifacts, 'share-preview-phone.png'), animations: 'disabled', fullPage: true })
    await dialog.getByRole('button', { name: 'Send shared copy', exact: true }).click()
    await settle(() => b.evaluate(() => engine.model.messages.some(message => message.shared)), 'shared bundle delivered')
    const shared = await b.evaluate(() => engine.model.messages.find(message => message.shared))
    assert.equal(shared.shared.items.length, 1)
    assert.equal(shared.shared.items[0].text, ordinaryText)
    assert.equal(JSON.stringify(shared.shared).includes('Unselected'), false)
    assert.equal(JSON.stringify(shared.shared).includes(bob.publicKey), false, 'full sender address is not copied')
    assert.equal(await ui.getByRole('region', { name: 'Message selection', exact: true }).count(), 0, 'successful share exits selection')
    console.log('PASS explicit selection, exact preview, cancellation, destination confirmation, encrypted copy and mobile layout')

    const community = await a.evaluate(async () => {
      const id = await engine.communities.createCommunity({ name: 'Sharing test', description: 'Synthetic', admission: 'direct' })
      const state = engine.communities.model.communities.find(item => item.id === id)
      const general = state.channels[0].id, second = crypto.randomUUID()
      await engine.communities.updateCommunity(id, { channels: [...state.channels, { id: second, name: 'second', posting: 'members' }] })
      const visible = await engine.communities.sendMessage(id, general, 'Selected channel text.')
      await engine.communities.sendMessage(id, second, 'Other channel private context.')
      const hidden = await engine.communities.sendMessage(id, general, 'Hidden channel text.')
      await engine.communities.hideMessage(id, hidden)
      return { id, general, visible, hidden }
    })
    await settle(() => a.evaluate(({ id, visible }) => engine.communities.model.messages.find(message => message.id === visible && message.conversationId === id)?.delivery === 'sent', community), 'channel messages sent')
    await ui.goto(`${origin}/chat/communities#${new URLSearchParams({ id: community.id, channel: community.general })}`)
    await ui.locator(`#community-message-${community.visible}`).waitFor()
    await ui.getByRole('button', { name: 'Select messages', exact: true }).click()
    assert.equal(await ui.getByRole('checkbox', { name: `Select message ${community.hidden}`, exact: true }).count(), 0)
    await ui.getByRole('checkbox', { name: `Select message ${community.visible}`, exact: true }).check()
    await ui.getByRole('button', { name: 'Share selected', exact: true }).click()
    dialog = ui.getByRole('dialog', { name: 'Share selected messages', exact: true })
    await dialog.locator('summary').click()
    const preview = await dialog.innerText()
    assert.ok(preview.includes('Selected channel text.'))
    assert.equal(preview.includes('Other channel private context.'), false)
    assert.equal(preview.includes('Hidden channel text.'), false)
    await dialog.getByLabel('Share destination', { exact: true }).selectOption(bob.publicKey)
    await dialog.getByRole('button', { name: 'Send shared copy', exact: true }).click()
    await settle(() => b.evaluate(() => engine.model.messages.some(message => message.shared?.items[0].text === 'Selected channel text.')), 'channel copy delivered to direct conversation')
    assert.deepEqual(errors, [], 'no browser runtime errors')
    console.log(`PASS community selection boundary and hidden exclusions; artifacts: ${artifacts}`)
  } catch (error) {
    if (ui) {
      fs.writeFileSync(path.join(artifacts, 'failure-errors.json'), JSON.stringify(errors, null, 2))
      fs.writeFileSync(path.join(artifacts, 'failure-dom.txt'), await ui.locator('body').innerText().catch(() => 'Page unavailable'))
      await ui.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {})
    }
    throw error
  } finally {
    await browser?.close()
    server.kill('SIGTERM')
    fs.closeSync(log)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
