/* eslint-disable no-console */
/* global DesignFixture, designEngine */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')
const esbuild = require('esbuild')
const { localBrowserEnvironment } = require('./local-browser-support.cjs')
const root = path.resolve(__dirname, '..')
const port = process.env.SEROTINE_BROWSER_PORT || '3136'
assert.match(port, /^\d+$/)
const origin = `http://localhost:${port}`
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function identity() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey'])
  return { version: 2, publicKey: Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex'), privateKey: await crypto.subtle.exportKey('jwk', keys.privateKey) }
}
async function main() {
  const artifacts = process.env.SEROTINE_BROWSER_ARTIFACTS || fs.mkdtempSync('/tmp/serotine-design-')
  fs.mkdirSync(artifacts, { recursive: true })
  const env = await localBrowserEnvironment(root, artifacts)
  const bundle = (await esbuild.build({ stdin: { contents: 'export * from "./lib/identity";export * from "./lib/messaging";export * from "./lib/messaging-store";export * from "./lib/themes";', resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'DesignFixture', tsconfig: path.join(root, 'tsconfig.json') })).outputFiles[0].text
  const logPath = path.join(artifacts, 'server.log'), log = fs.openSync(logPath, 'w')
  const server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--port', port, '--hostname', '127.0.0.1'], { cwd: root, env, stdio: ['ignore', log, log] })
  let browser, page
  try {
    let ready = false
    for (let end = Date.now() + 120000; Date.now() < end;) {
      if (server.exitCode !== null) throw new Error(fs.readFileSync(logPath, 'utf8').slice(-4000))
      try { if ((await fetch(origin, { signal: AbortSignal.timeout(5000) })).ok) { ready = true; break } } catch { /* local compilation */ }
      await pause(300)
    }
    assert.ok(ready, `Server startup: ${logPath}`)
    browser = await chromium.launch({ executablePath: process.env.SEROTINE_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'], headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' })
    context.setDefaultTimeout(15000)
    const errors = []
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
    await context.route('**/*', route => {
      const url = new URL(route.request().url())
      if (url.origin !== origin) return route.abort('blockedbyclient')
      if (url.pathname === '/api/relay') {
        const { action, data } = route.request().postDataJSON()
        const body = action === 'event:sync' ? { success: true, messages: [], nextCursor: data.after || 0, hasMore: false }
          : ['message:inbox', 'message:list'].includes(action) ? { success: true, messages: [], nextCursor: null } : { success: true }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) })
      }
      return route.continue()
    })
    const fixture = await context.newPage()
    await fixture.route(`${origin}/__design-fixture`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic design fixture</title>' }))
    await fixture.goto(`${origin}/__design-fixture`)
    await fixture.addScriptTag({ content: bundle })
    const [owner, bob, charlie, dana] = await Promise.all([identity(), identity(), identity(), identity()])
    const community = await fixture.evaluate(async ({ owner, peers }) => {
      localStorage.setItem('serotine_identity_v2', JSON.stringify(owner))
      DesignFixture.saveContacts(owner.publicKey, peers.map((peer, index) => ({ pub: peer.publicKey, alias: ['Bob', 'Charlie', 'Dana'][index] })))
      for (let index = 0; index < peers.length; index++) {
        const author = peers[index], timestamp = Date.now() - (3 - index) * 60000
        const event = await DesignFixture.signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: author.publicKey, conversationId: owner.publicKey, recipients: [owner.publicKey], kind: 'message', payload: { content: `Saved note ${index + 1}` }, timestamp }, author)
        await DesignFixture.saveStoredEvent(owner.publicKey, { key: DesignFixture.eventStorageKey(event), event, local: false, delivered: [owner.publicKey], receivedAt: timestamp })
      }
      window.designEngine = new DesignFixture.MessagingEngine(await DesignFixture.loadIdentity())
      await designEngine.start()
      const id = await designEngine.communities.createCommunity({ name: 'Design community', description: '', admission: 'direct' })
      return { id, channels: designEngine.communities.model.communities.find(item => item.id === id).channels }
    }, { owner, peers: [bob, charlie, dana] })
    page = await context.newPage()
    await page.goto(`${origin}/chat/${bob.publicKey}`)
    await page.getByRole('heading', { name: 'Bob', exact: true }).waitFor()
    const rows = page.locator('[data-activity-list]:visible > [data-activity-id]')
    const order = () => rows.evaluateAll(nodes => nodes.map(node => node.dataset.activityId))
    const baseline = await order()
    assert.deepEqual(baseline, [community.id, dana.publicKey, charlie.publicKey, bob.publicKey])
    for (const peer of [charlie, dana, bob]) {
      const row = rows.filter({ has: page.locator(`a[href="/chat/${peer.publicKey}"]`) })
      await row.getByRole('link').click()
      await page.waitForURL(`${origin}/chat/${peer.publicKey}`)
      assert.deepEqual(await order(), baseline, 'opening a row never moves it')
    }
    await page.reload()
    await page.getByRole('heading', { name: 'Bob', exact: true }).waitFor()
    assert.deepEqual(await order(), baseline, 'reload restores the route without promotion')
    console.log('PASS activity-only ordering across click, read, navigation and reload')

    const filter = page.getByRole('textbox', { name: 'Filter conversations', exact: true })
    await filter.fill('Bob')
    assert.deepEqual(await order(), [bob.publicKey])
    await filter.fill('')
    assert.deepEqual(await order(), baseline)
    await fixture.evaluate(async peer => { await designEngine.archiveConversation(peer, true) }, charlie.publicKey)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await rows.filter({ has: page.locator(`a[href="/chat/${charlie.publicKey}"]`) }).waitFor({ state: 'detached' })
    await fixture.evaluate(async peer => { await designEngine.archiveConversation(peer, false) }, charlie.publicKey)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await rows.filter({ has: page.locator(`a[href="/chat/${charlie.publicKey}"]`) }).waitFor()
    assert.deepEqual(await order(), baseline, 'unarchive restores actual activity order')
    const focused = rows.filter({ has: page.locator(`a[href="/chat/${bob.publicKey}"]`) }).getByRole('link')
    await focused.focus()
    // Observe actual WAAPI movement at its start, before a short animation ends.
    await page.evaluate(() => {
      window.designMoves = []
      const original = Element.prototype.animate
      Element.prototype.animate = function (frames, options) {
        if (this.hasAttribute('data-activity-id')) window.designMoves.push({ id: this.dataset.activityId, frames, options })
        return original.call(this, frames, options)
      }
    })
    async function incoming(author, text) {
      await fixture.evaluate(async ({ author, text, owner }) => {
        const event = await DesignFixture.signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: author.publicKey, conversationId: owner, recipients: [owner], kind: 'message', payload: { content: text }, timestamp: Date.now() }, author)
        await DesignFixture.saveStoredEvent(owner, { key: DesignFixture.eventStorageKey(event), event, local: false, delivered: [owner], receivedAt: event.timestamp })
      }, { author, text, owner: owner.publicKey })
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      await page.waitForFunction(id => document.querySelector('[data-activity-list] > [data-activity-id]')?.getAttribute('data-activity-id') === id, author.publicKey)
    }
    await incoming(bob, 'New real activity moves this conversation.')
    assert.deepEqual(await order(), [bob.publicKey, community.id, dana.publicKey, charlie.publicKey])
    assert.equal(await focused.evaluate(node => node === document.activeElement), true, 'focused keyed row survives reorder')
    assert.ok((await page.evaluate(() => window.designMoves)).some(move => move.id === bob.publicKey && move.options.duration === 200), 'real movement uses the shared token')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.evaluate(() => { window.designMoves = [] })
    await incoming(charlie, 'Reduced motion still updates the correct order.')
    assert.equal(await page.evaluate(() => window.designMoves.length), 0, 'reduced motion reorders immediately')
    console.log('PASS filter/archive stability, real message FLIP, keyboard focus and reduced motion')

    const beforeCommunity = await order()
    await page.locator(`a[href*="${encodeURIComponent(community.id)}"]`).filter({ visible: true }).first().click()
    await page.getByRole('heading', { name: 'general', exact: true }).waitFor()
    await page.getByRole('button', { name: 'help', exact: true }).click()
    assert.deepEqual(await order(), beforeCommunity, 'community/channel navigation is not activity')
    await fixture.evaluate(({ id }) => designEngine.communities.updateCommunity(id, { name: 'Renamed community' }), community)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.getByRole('link').filter({ hasText: 'Renamed community' }).first().waitFor()
    assert.deepEqual(await order(), beforeCommunity, 'community settings preserve activity')
    await fixture.evaluate(({ id, channels }) => designEngine.communities.sendMessage(id, channels.find(channel => channel.name === 'help').id, 'A new community message.'), community)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await page.waitForFunction(id => document.querySelector('[data-activity-list] > [data-activity-id]')?.getAttribute('data-activity-id') === id, community.id)
    console.log('PASS community navigation/settings stability and channel message promotion')

    for (const [mode, custom] of [['light', false], ['dark', false], ['light', true]]) {
      await fixture.evaluate(({ mode, custom }) => {
        localStorage.setItem('theme', mode)
        const palette = { ...DesignFixture.PRESET_THEMES[1], id: 'custom-design', name: 'Design fixture' }
        localStorage.setItem(DesignFixture.THEME_STORAGE_KEY, JSON.stringify(custom ? { selectedId: palette.id, customThemes: [palette] } : { selectedId: 'default', customThemes: [] }))
      }, { mode, custom })
      await page.goto(origin)
      await page.waitForFunction(mode => document.documentElement.classList.contains(mode), mode)
      await page.waitForFunction(custom => document.documentElement.dataset.palette === (custom ? 'custom-design' : 'default'), custom)
      const landing = await page.locator('#serotine-landing').evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor, font: getComputedStyle(node).fontFamily }))
      const label = custom ? 'custom' : mode
      await page.screenshot({ path: path.join(artifacts, `landing-${label}.png`), fullPage: true, animations: 'disabled', style: 'nextjs-portal { display: none; }' })
      await page.goto(`${origin}/chat/${bob.publicKey}`)
      await page.getByRole('heading', { name: 'Bob', exact: true }).waitFor()
      const app = await page.locator('body').evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor, font: getComputedStyle(node).fontFamily }))
      assert.deepEqual(landing, app, `${label}: public and authenticated pages share semantic colors and typography`)
      await page.screenshot({ path: path.join(artifacts, `inbox-${label}.png`), fullPage: true, animations: 'disabled', style: 'nextjs-portal { display: none; }' })
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto(origin)
    await page.locator('[data-room] summary').click()
    await page.getByRole('textbox', { name: 'Your note', exact: true }).fill('Hello from the local demo')
    await page.getByRole('button', { name: 'Send demo note', exact: true }).click()
    await page.getByRole('log', { name: 'Demo conversation', exact: true }).getByText('Hello from the local demo', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.screenshot({ path: path.join(artifacts, 'landing-phone.png'), fullPage: true, animations: 'disabled', style: 'nextjs-portal { display: none; }' })
    await page.goto(`${origin}/chat/${bob.publicKey}`)
    await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.getByRole('link', { name: 'Back to conversations', exact: true }).click()
    await page.getByRole('complementary', { name: 'Inbox', exact: true }).waitFor()
    await page.screenshot({ path: path.join(artifacts, 'inbox-phone.png'), fullPage: true, animations: 'disabled', style: 'nextjs-portal { display: none; }' })
    assert.deepEqual(errors, [])
    console.log(`PASS shared light/dark/custom themes, local demo and mobile navigation; artifacts: ${artifacts}`)
  } catch (error) {
    if (page) {
      fs.writeFileSync(path.join(artifacts, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => 'Page unavailable'))
      await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {})
    }
    throw error
  } finally { await browser?.close(); server.kill('SIGTERM'); fs.closeSync(log) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
