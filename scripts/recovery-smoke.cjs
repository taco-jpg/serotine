/* eslint-disable no-console */
/* global SerotineRecovery */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const port = process.env.SEROTINE_BROWSER_PORT || '3102'
assert.match(port, /^\d+$/)
const origin = `http://localhost:${port}`
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function identity() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey'])
  return { version: 2, publicKey: Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('hex'), privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey) }
}

async function main() {
  const bundle = (await esbuild.build({ stdin: { contents: 'export * from "./lib/identity"; export * from "./lib/full-backup"; export * from "./lib/messaging"; export * from "./lib/messaging-store"; export * from "./lib/attachments"; export * from "./lib/relay-client"; export * from "./lib/request-auth";', resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'SerotineRecovery', tsconfig: path.join(root, 'tsconfig.json') })).outputFiles[0].text
  const logPath = `/tmp/serotine-recovery-${port}.log`
  const log = fs.openSync(logPath, 'w')
  const server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--port', port, '--hostname', '127.0.0.1'], { cwd: root, stdio: ['ignore', log, log] })
  let browser
  try {
    let ready = false
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(`Server failed: ${fs.readFileSync(logPath, 'utf8').slice(-3000)}`)
      try { if ((await fetch(origin, { signal: AbortSignal.timeout(3000) })).ok) { ready = true; break } } catch { /* Wait for startup. */ }
      await pause(500)
    }
    assert.ok(ready, `Server did not become ready: ${logPath}`)
    browser = await chromium.launch({ executablePath: process.env.SEROTINE_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'], headless: true })
    const errors = []
    const [desktop, phone] = await Promise.all([identity(), identity()])
    const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const desktopContext = await browser.newContext()
    const mobile = await phoneContext.newPage()
    const computer = await desktopContext.newPage()
    async function bootstrap(page, owner) {
      page.on('pageerror', error => errors.push(error.message))
      await page.route(`${origin}/__recovery-peer`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Recovery test</title>' }))
      await page.goto(`${origin}/__recovery-peer`)
      await page.addScriptTag({ content: bundle })
      await page.evaluate(id => localStorage.setItem('serotine_identity_v2', JSON.stringify(id)), owner)
    }
    await Promise.all([bootstrap(mobile, phone), bootstrap(computer, desktop)])
    async function seed(page, label) {
      return page.evaluate(async label => {
        const current = await SerotineRecovery.loadIdentity()
        const engine = new SerotineRecovery.MessagingEngine(current)
        await engine.start()
        await engine.sendText(current.publicKey, `${label} history`)
        await SerotineRecovery.sendAttachment(engine.sendEvent, current.publicKey, new File(['saved attachment'], `${label}.txt`, { type: 'text/plain' }))
        const backup = await SerotineRecovery.exportFullBackup(current, 'synthetic recovery test password')
        engine.dispose()
        return backup
      }, label)
    }
    const [backup] = await Promise.all([seed(computer, 'desktop'), seed(mobile, 'phone')])
    await mobile.goto(`${origin}/chat/${phone.publicKey}`)
    await mobile.getByText('phone history', { exact: true }).waitFor()
    await mobile.getByRole('button', { name: 'Back to conversations', exact: true }).count().then(async count => {
      if (count) await mobile.getByRole('button', { name: 'Back to conversations', exact: true }).click()
      else await mobile.getByRole('link', { name: 'Back to conversations', exact: true }).click()
    })
    await mobile.getByRole('button', { name: 'Backups and linked devices', exact: true }).click()
    const dialog = mobile.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Restore', exact: true }).click()
    await dialog.getByLabel('Serotine backup', { exact: true }).setInputFiles({ name: 'desktop.json', mimeType: 'application/json', buffer: Buffer.from(backup) })
    await dialog.getByLabel('Backup password', { exact: true }).fill('synthetic recovery test password')
    await dialog.getByRole('button', { name: 'Restore backup', exact: true }).click()
    const confirmation = mobile.getByRole('region', { name: 'Confirm identity switch' })
    await confirmation.waitFor()
    assert.equal(await mobile.evaluate(() => JSON.parse(localStorage.getItem('serotine_identity_v2')).publicKey), phone.publicKey)
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.equal(await mobile.evaluate(() => JSON.parse(localStorage.getItem('serotine_identity_v2')).publicKey), phone.publicKey)
    await dialog.getByRole('button', { name: 'Restore backup', exact: true }).click()
    await Promise.all([
      mobile.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      confirmation.getByRole('button', { name: 'Switch identity and restore', exact: true }).click(),
    ])
    await mobile.waitForURL(`${origin}/chat`)
    await mobile.waitForFunction(pub => JSON.parse(localStorage.getItem('serotine_identity_v2')).publicKey === pub, desktop.publicKey)
    await mobile.addScriptTag({ content: bundle })
    assert.equal(await mobile.evaluate(async pub => (await SerotineRecovery.loadArchivedIdentities()).some(value => value.publicKey === pub), phone.publicKey), true)
    assert.equal(await mobile.evaluate(async pub => (await SerotineRecovery.exportMessagingSnapshot(pub)).events.some(value => value.event.payload.content === 'phone history'), phone.publicKey), true)
    console.log('PASS mobile identity conflict, cancel, confirmed switch and separate previous history')

    // Retire while another desktop-sized tab renders an attachment conversation.
    const secondTab = await phoneContext.newPage()
    await secondTab.setViewportSize({ width: 1280, height: 900 })
    secondTab.on('pageerror', error => errors.push(error.message))
    await secondTab.goto(`${origin}/chat/${desktop.publicKey}`)
    await secondTab.getByText('desktop history', { exact: true }).waitFor()
    await mobile.getByRole('button', { name: 'Backups and linked devices', exact: true }).click()
    await dialog.getByRole('button', { name: 'Security', exact: true }).click()
    const retire = dialog.getByRole('button', { name: 'Retire old identity and create new address', exact: true })
    assert.equal(await retire.isDisabled(), true)
    await dialog.getByRole('checkbox', { name: /I understand this permanently disables/ }).check()
    await Promise.all([mobile.waitForNavigation({ waitUntil: 'domcontentloaded' }), retire.click()])
    await mobile.waitForFunction(pub => JSON.parse(localStorage.getItem('serotine_identity_v2')).publicKey !== pub, desktop.publicKey)
    await mobile.waitForURL(`${origin}/chat`)
    await mobile.getByRole('button', { name: 'Backups and linked devices', exact: true }).waitFor()
    await mobile.addScriptTag({ content: bundle })
    const replacement = await mobile.evaluate(() => SerotineRecovery.loadIdentity())
    assert.notEqual(replacement.publicKey, desktop.publicKey)
    assert.equal(await mobile.evaluate(async pub => (await SerotineRecovery.loadArchivedIdentities()).find(value => value.publicKey === pub)?.retired, desktop.publicKey), true)
    const denied = await computer.evaluate(async () => {
      const current = await SerotineRecovery.loadIdentity(), data = {}
      return SerotineRecovery.getEventFeed(data, await SerotineRecovery.createRequestProof('event:sync', data, current.privateKey, current.publicKey))
    })
    assert.equal(denied.success, false)
    assert.match(denied.error, /permanently retired/)
    await secondTab.getByRole('textbox', { name: 'Message', exact: true }).waitFor()
    assert.equal(await secondTab.evaluate(() => JSON.parse(localStorage.getItem('serotine_identity_v2')).publicKey), replacement.publicKey)
    console.log('PASS confirmed retirement, replacement identity, archived history and old-device relay denial')
    assert.deepEqual(errors, [], 'no page errors during switching or retirement')
  } finally {
    await browser?.close()
    server.kill('SIGTERM')
    fs.closeSync(log)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
