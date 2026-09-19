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
const port = process.env.SEROTINE_BROWSER_PORT || '3125'
assert.match(port, /^\d+$/)
const origin = `http://localhost:${port}`
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const PRIVATE = 'serotine.private-chat'
const SUMMARY = 'serotine.ai-summary'

async function identity() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey'])
  return { version: 2, publicKey: Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex'), privateKey: await crypto.subtle.exportKey('jwk', keys.privateKey) }
}

async function main() {
  const bundle = (await esbuild.build({ stdin: { contents: 'export * from "./lib/identity"; export * from "./lib/messaging"; export * from "./lib/messaging-store";', resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'SerotinePlugins', tsconfig: path.join(root, 'tsconfig.json') })).outputFiles[0].text
  const artifacts = process.env.SEROTINE_BROWSER_ARTIFACTS || fs.mkdtempSync('/tmp/serotine-plugins-')
  fs.mkdirSync(artifacts, { recursive: true })
  const logPath = path.join(artifacts, 'server.log'), log = fs.openSync(logPath, 'w')
  const environment = await localBrowserEnvironment(root, artifacts)
  const server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--port', port, '--hostname', '127.0.0.1'], { cwd: root, env: environment, stdio: ['ignore', log, log] })
  let serverError, browser, ui
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
    const errors = [], contexts = [], peers = [], summaryRequests = []
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
    const ordinaryText = 'The project meeting is Friday at noon.'
    const ordinary = await b.evaluate(({ peer, text }) => engine.sendText(peer, text), { peer: alice.publicKey, text: ordinaryText })
    await settle(() => a.evaluate(id => engine.model.messages.some(message => message.id === id), ordinary), 'ordinary encrypted delivery')
    ui = await contexts[0].newPage()
    await ui.route(`${origin}/api/plugins/summary`, async route => {
      const request = route.request()
      summaryRequests.push(JSON.parse(request.postData()))
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, summary: 'The project meeting is scheduled for Friday at noon.' }) })
    })
    await ui.goto(`${origin}/chat/${bob.publicKey}`)
    const message = ui.getByRole('textbox', { name: 'Message', exact: true })
    const send = ui.getByRole('button', { name: 'Send message', exact: true })
    await message.waitFor()
    await ui.getByRole('region', { name: 'Conversation messages' }).getByText(ordinaryText, { exact: true }).waitFor()

    async function openPlugins() {
      await ui.getByRole('button', { name: 'Conversation details, files and settings', exact: true }).click()
      await ui.getByRole('button', { name: 'Manage plugins', exact: true }).click()
      const dialog = ui.getByRole('dialog', { name: 'Plugins', exact: true })
      await dialog.waitFor()
      return dialog
    }
    async function enablePlugin(name) {
      let dialog = await openPlugins()
      await dialog.getByRole('group', { name, exact: true }).getByRole('button', { name: 'Install and enable', exact: true }).click()
      dialog = ui.getByRole('dialog', { name: `Enable ${name}?`, exact: true })
      const confirm = dialog.getByRole('button', { name: 'Allow and enable', exact: true })
      assert.equal(await confirm.isEnabled(), false, 'permission review must be acknowledged')
      await dialog.getByRole('checkbox', { name: 'Allow these permissions for this identity on this browser', exact: true }).check()
      await confirm.click()
      const plugins = ui.getByRole('dialog', { name: 'Plugins', exact: true })
      await plugins.getByRole('group', { name, exact: true }).getByRole('button', { name: 'Disable', exact: true }).waitFor()
      await plugins.getByRole('button', { name: 'Close', exact: true }).click()
    }
    await enablePlugin('Private Chat')
    await a.evaluate(() => engine.refresh())
    await a.evaluate(peer => engine.refreshPeerCapabilities(peer), bob.publicKey)
    await settle(() => a.evaluate(peer => engine.getPluginAvailability('serotine.private-chat', peer).peerStatus === 'unavailable', bob.publicKey), 'one-sided compatibility result')
    assert.equal(await a.evaluate(async peer => { try { await engine.sendSecret(peer, 'Must never leave one-sided setup', 300); return false } catch { return true } }, bob.publicKey), true, 'one-sided private sending fails closed')
    assert.equal(await b.evaluate(() => engine.model.messages.some(item => item.content === 'Must never leave one-sided setup')), false)
    await b.evaluate(id => engine.setPluginEnabled(id, true, true), PRIVATE)
    await Promise.all([a.evaluate(peer => engine.refreshPeerCapabilities(peer), bob.publicKey), b.evaluate(peer => engine.refreshPeerCapabilities(peer), alice.publicKey)])
    await settle(async () => (await Promise.all([
      a.evaluate(peer => engine.getPluginAvailability('serotine.private-chat', peer).available, bob.publicKey),
      b.evaluate(peer => engine.getPluginAvailability('serotine.private-chat', peer).available, alice.publicKey),
    ])).every(Boolean), 'mutual private capability exchange')
    console.log('PASS explicit per-plugin consent, one-sided private rejection and mutual signed compatibility')

    await ui.getByRole('button', { name: 'Private chat settings', exact: true }).click()
    await ui.getByRole('button', { name: 'Check peer support', exact: true }).click()
    await settle(() => ui.locator('#private-chat-duration').isEnabled(), 'UI private compatibility')
    await ui.locator('#private-chat-duration').selectOption('300')
    await ui.getByRole('button', { name: 'Save timer', exact: true }).click()
    await ui.getByRole('dialog').waitFor({ state: 'hidden' })
    const privateText = 'Private material must be excluded from summary requests.'
    await message.fill(privateText)
    await send.click()
    await settle(() => b.evaluate(text => engine.model.messages.some(item => item.private && item.content === text), privateText), 'private message after consent')
    const expiring = await a.evaluate(peer => engine.sendEvent(peer, 'private-message', { content: 'Expires while plugin is disabled', expiresAt: Date.now() + 10000 }), bob.publicKey)
    await settle(() => b.evaluate(id => engine.model.messages.some(item => item.id === id), expiring), 'short private expiry arrival')
    await a.evaluate(id => engine.setPluginEnabled(id, false), PRIVATE)
    assert.equal(await a.evaluate(async peer => { try { await engine.sendText(peer, 'Must never downgrade'); return false } catch { return true } }, bob.publicKey), true, 'disable blocks private sends rather than retaining an ordinary copy')
    assert.equal(await a.evaluate(peer => engine.model.conversations.find(item => item.id === peer)?.privateTtlSeconds, bob.publicKey), 300, 'disable preserves the private timer setting')
    await settle(async () => (await Promise.all(peers.map(page => page.evaluate(id => engine.model.messages.every(item => item.id !== id), expiring)))).every(Boolean), 'expiry continues while plugin disabled', 20000)
    assert.equal(await b.evaluate(() => engine.model.messages.some(item => item.content === 'Must never downgrade')), false)
    await a.evaluate(id => engine.setPluginEnabled(id, true), PRIVATE)
    await Promise.all([a.evaluate(peer => engine.refreshPeerCapabilities(peer), bob.publicKey), b.evaluate(peer => engine.refreshPeerCapabilities(peer), alice.publicKey)])
    await settle(() => a.evaluate(peer => engine.getPluginAvailability('serotine.private-chat', peer).available, bob.publicKey), 're-enabled compatibility')
    await a.evaluate(peer => engine.setPrivateMode(peer, 0), bob.publicKey)
    await settle(() => b.evaluate(peer => engine.model.conversations.find(item => item.id === peer)?.privateTtlSeconds === 0, alice.publicKey), 'explicit private timer off')
    // The UI is another tab, which observes durable changes on its next sync.
    await ui.getByPlaceholder('Write a message…', { exact: true }).waitFor({ timeout: 10000 })
    console.log('PASS encrypted private send, disable without ordinary downgrade and continuing expiry')

    await enablePlugin('AI Summary')
    console.log('PASS AI Summary permission consent')
    async function openSummary() {
      await message.fill('/summarize')
      await send.click()
      const dialog = ui.getByRole('dialog', { name: 'Summarize conversation', exact: true })
      await dialog.waitFor()
      return dialog
    }
    let summary = await openSummary()
    assert.equal(summaryRequests.length, 0, 'preview sends no provider request')
    const preview = summary.getByLabel('Messages to summarize', { exact: true })
    await preview.waitFor()
    const previewText = await preview.textContent()
    assert.ok(previewText.includes(ordinaryText), 'preview contains ordinary selected content')
    assert.equal(previewText.includes(privateText), false, 'preview excludes private messages')
    await summary.getByRole('button', { name: 'Close', exact: true }).click()
    assert.equal(summaryRequests.length, 0, 'cancel never requests a summary')
    await settle(() => b.evaluate(() => engine.model.messages.every(item => !item.content.startsWith('/summarize'))), 'command never sent as a message')
    summary = await openSummary()
    await ui.setViewportSize({ width: 390, height: 844 })
    assert.equal(await ui.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '390px summary preview fits viewport')
    await ui.screenshot({ path: path.join(artifacts, 'summary-preview-phone.png'), fullPage: true, animations: 'disabled', style: 'nextjs-portal { display: none; }' })
    await summary.getByRole('button', { name: 'Send to AI and summarize', exact: true }).click()
    const result = ui.getByRole('dialog', { name: 'Your local summary', exact: true })
    await result.waitFor()
    assert.equal(summaryRequests.length, 1)
    const body = summaryRequests[0]
    assert.deepEqual(Object.keys(body).sort(), ['action', 'data', 'proof', 'version'], 'request contains only the signed endpoint envelope')
    assert.equal(body.action, 'plugin:summary')
    assert.deepEqual(Object.keys(body.data), ['messages'], 'no conversation, contact, timer or attachment metadata is transmitted')
    for (const item of body.data.messages) assert.deepEqual(Object.keys(item).sort(), ['speaker', 'text'], 'AI input contains anonymized text rows only')
    assert.equal(JSON.stringify(body).includes(privateText), false, 'private content never enters provider request')
    assert.equal(JSON.stringify(body).includes('Bob private test alias'), false, 'local aliases never enter provider request')
    assert.equal(JSON.stringify(body).includes(bob.publicKey), false, 'peer addresses never enter provider request')
    assert.ok(body.proof, 'summary requests authenticate the requesting identity')
    assert.equal(await b.evaluate(() => engine.model.messages.some(item => item.content === 'The project meeting is scheduled for Friday at noon.')), false, 'summary remains local before deliberate send')
    assert.equal(await ui.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '390px summary result fits viewport')
    await ui.screenshot({ path: path.join(artifacts, 'summary-result-phone.png'), fullPage: true, animations: 'disabled', style: 'nextjs-portal { display: none; }' })
    await result.getByRole('button', { name: 'Send summary', exact: true }).click()
    await settle(() => b.evaluate(() => engine.model.messages.some(item => item.content.includes('The project meeting is scheduled for Friday at noon.'))), 'explicitly shared summary')
    await ui.setViewportSize({ width: 1280, height: 900 })
    console.log('PASS local command, provider consent/cancellation, private exclusions, local result, explicit sharing and 390px layout')

    // A channel preview must not include other channels or moderator-hidden
    // messages, even though all three live in the same community model.
    const community = await a.evaluate(async () => {
      const id = await engine.communities.createCommunity({ name: 'Plugin isolation fixture', description: '', admission: 'direct' })
      const model = engine.communities.model.communities.find(item => item.id === id)
      return { id, invite: await engine.communities.createInvite(id), general: model.channels.find(item => item.name === 'general').id, help: model.channels.find(item => item.name === 'help').id }
    })
    await b.evaluate(invite => engine.communities.joinCommunity(invite), community.invite)
    await settle(() => b.evaluate(id => engine.communities.model.communities.some(item => item.id === id && item.joined), community.id), 'community fixture membership')
    const channelMessage = await b.evaluate(({ id, general }) => engine.communities.sendMessage(id, general, 'Visible general-channel summary input.'), community)
    await b.evaluate(({ id, help }) => engine.communities.sendMessage(id, help, 'Other channel must stay excluded.'), community)
    const hiddenMessage = await b.evaluate(({ id, general }) => engine.communities.sendMessage(id, general, 'Hidden moderation content must stay excluded.'), community)
    await settle(() => a.evaluate(id => engine.communities.model.messages.some(item => item.id === id), hiddenMessage), 'community history arrived')
    await a.evaluate(({ id, messageId }) => engine.communities.hideMessage(id, messageId), { id: community.id, messageId: hiddenMessage })
    await settle(() => a.evaluate(id => engine.communities.model.messages.find(item => item.id === id)?.hidden, hiddenMessage), 'moderation hide applied')
    await ui.goto(`${origin}/chat/communities#${new URLSearchParams({ id: community.id, channel: community.general })}`)
    await ui.locator(`#community-message-${channelMessage}`).waitFor()
    await ui.getByRole('button', { name: 'Summarize channel', exact: true }).click()
    const channelSummary = ui.getByRole('dialog', { name: 'Summarize conversation', exact: true })
    const channelPreview = await channelSummary.getByRole('region', { name: 'Messages to summarize', exact: true }).textContent()
    assert.ok(channelPreview.includes('Visible general-channel summary input.'))
    assert.equal(channelPreview.includes('Other channel must stay excluded.'), false)
    assert.equal(channelPreview.includes('Hidden moderation content must stay excluded.'), false)
    await channelSummary.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal(summaryRequests.length, 1, 'community cancellation sends nothing to AI')
    console.log('PASS community summary selection isolates channels and excludes moderator-hidden content')
    await ui.goto(`${origin}/chat/${bob.publicKey}`)
    await message.waitFor()

    const plugins = await openPlugins()
    await plugins.getByRole('group', { name: 'AI Summary', exact: true }).getByRole('button', { name: 'Disable', exact: true }).click()
    await plugins.getByRole('button', { name: 'Close', exact: true }).click()
    await message.fill('/summarize')
    await send.click()
    assert.equal(await message.inputValue(), '/summarize', 'disabled command remains local in composer')
    assert.equal(summaryRequests.length, 1, 'disabled plugin cannot issue requests')
    await Promise.all(peers.map(page => page.evaluate(async () => { await engine.refresh(); await engine.sync() })))
    assert.equal(await b.evaluate(() => engine.model.messages.some(item => item.content.startsWith('/summarize'))), false, 'disabled command is never sent')
    assert.equal(await a.evaluate(id => engine.getPluginAvailability(id).available, SUMMARY), false)
    assert.deepEqual(errors, [], 'no browser runtime errors')
    console.log(`PASS plugin smoke; artifacts: ${artifacts}`)
  } catch (error) {
    if (ui) {
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
