/* eslint-disable no-console */
/* global SerotineNickname */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const http = require('node:http')
const { chromium } = require('playwright')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const port = process.env.SEROTINE_BROWSER_PORT || '3121'
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
  const bundle = (await esbuild.build({ stdin: { contents: 'export * from "./lib/identity"; export * from "./lib/messaging"; export * from "./lib/messaging-store"; export * from "./lib/full-backup";', resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'SerotineNickname', tsconfig: path.join(root, 'tsconfig.json') })).outputFiles[0].text
  const artifacts = process.env.SEROTINE_BROWSER_ARTIFACTS || fs.mkdtempSync('/tmp/serotine-nickname-')
  fs.mkdirSync(artifacts, { recursive: true })
  const logPath = path.join(artifacts, 'server.log'), log = fs.openSync(logPath, 'w')
  const server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), ...(process.env.SEROTINE_SERVER_MODE === 'production' ? ['start'] : ['dev', '--webpack']), '--port', port, '--hostname', '127.0.0.1'], { cwd: root, stdio: ['ignore', log, log] })
  let browser
  try {
    let ready = false, startupError
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(fs.readFileSync(logPath, 'utf8').slice(-4000))
      try { const status = await localStatus(); if (status === 200) { ready = true; break } startupError = `HTTP ${status}` } catch (error) { startupError = error.message }
      await pause(500)
    }
    assert.ok(ready, `Server did not start: ${logPath}; ${startupError}`)
    browser = await chromium.launch({ executablePath: process.env.SEROTINE_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'], headless: true })
    const [owner, bob] = await Promise.all([identity(), identity()])
    const relayRequests = [], errors = []
    async function context() {
      const value = await browser.newContext({ viewport: { width: 1280, height: 900 } })
      value.on('page', page => page.on('pageerror', error => errors.push(error.message)))
      await value.route('**/*', route => {
        const request = route.request(), url = new URL(request.url())
        if (url.origin !== origin) return route.abort()
        if (url.pathname === '/api/relay') {
          const body = request.postDataJSON() || {}
          relayRequests.push(body)
          let result = { success: true }
          if (body.action === 'event:sync') result = { success: true, messages: [], nextCursor: body.data?.after || 0, hasMore: false }
          if (body.action === 'message:inbox' || body.action === 'message:list') result = { success: true, messages: [], nextCursor: null }
          if (body.action === 'signal:read') result = { success: true, signal: null }
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
        }
        if (url.pathname === '/__nickname-fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Private nickname fixture</title>' })
        return route.continue()
      })
      return value
    }
    const ownerContext = await context(), bobContext = await context()
    const page = await ownerContext.newPage()
    await page.goto(`${origin}/__nickname-fixture`)
    await page.addScriptTag({ content: bundle })
    const records = await page.evaluate(async ({ owner, bob }) => {
      const contents = [`@${owner.publicKey} canonical mention`, `@${SerotineNickname.shortAddress(owner.publicKey)} legacy mention`]
      return Promise.all(contents.map(async (content, index) => {
        const timestamp = Date.now() - 60000 + index * 1000
        const event = await SerotineNickname.signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: bob.publicKey, conversationId: owner.publicKey, recipients: [owner.publicKey], kind: 'message', payload: { content, mentions: [owner.publicKey] }, timestamp }, bob)
        return { key: SerotineNickname.eventStorageKey(event), event, delivered: [owner.publicKey], receivedAt: timestamp }
      }))
    }, { owner, bob })
    async function seed(target, localIdentity, peer, alias) {
      await target.goto(`${origin}/__nickname-fixture`)
      await target.addScriptTag({ content: bundle })
      await target.evaluate(async ({ localIdentity, peer, alias, records }) => {
        localStorage.setItem('serotine_identity_v2', JSON.stringify(localIdentity))
        SerotineNickname.saveContacts(localIdentity.publicKey, [{ pub: peer.publicKey, alias }])
        for (const record of records) await SerotineNickname.saveStoredEvent(localIdentity.publicKey, { ...record, local: record.event.author === localIdentity.publicKey })
      }, { localIdentity, peer, alias, records })
      await target.goto(`${origin}/chat/${peer.publicKey}`)
      await target.getByRole('textbox', { name: 'Message', exact: true }).waitFor()
    }
    await seed(page, owner, bob, 'Study partner')
    const peerPage = await bobContext.newPage()
    await seed(peerPage, bob, owner, 'Colleague')
    const canonicalId = records[0].event.id, legacyId = records[1].event.id
    async function expectMention(target, id, label, suffix) {
      await target.locator(`#message-${id}`).getByText(`@${label} ${suffix}`, { exact: true }).waitFor()
      assert.equal((await target.locator(`#message-${id}`).innerText()).includes(`Mentioned: ${label}`), true)
    }
    await expectMention(page, canonicalId, 'You', 'canonical mention')
    await expectMention(page, legacyId, 'You', 'legacy mention')
    await expectMention(peerPage, canonicalId, 'Colleague', 'canonical mention')
    const secondTab = await ownerContext.newPage()
    await secondTab.goto(`${origin}/chat/${bob.publicKey}`)
    await expectMention(secondTab, canonicalId, 'You', 'canonical mention')

    const settings = target => target.getByRole('dialog', { name: 'Notifications and privacy', exact: true })
    async function openSettings(target) {
      await target.getByRole('button', { name: 'Notification and privacy settings', exact: true }).click()
      await settings(target).waitFor()
    }
    const nickname = 'Private test nickname'
    await openSettings(page)
    await settings(page).getByRole('textbox', { name: 'Private nickname', exact: true }).fill(nickname)
    await settings(page).getByRole('button', { name: 'Save', exact: true }).click()
    await settings(page).getByText('Private nickname saved.', { exact: true }).waitFor()
    await settings(page).getByRole('button', { name: 'Close', exact: true }).click()
    await expectMention(page, canonicalId, nickname, 'canonical mention')
    await expectMention(page, legacyId, nickname, 'legacy mention')
    await expectMention(secondTab, canonicalId, nickname, 'canonical mention')
    await page.reload()
    await expectMention(page, legacyId, nickname, 'legacy mention')
    await expectMention(peerPage, canonicalId, 'Colleague', 'canonical mention')
    assert.equal((await peerPage.locator('body').innerText()).includes(nickname), false, 'another person must not see the private nickname')
    await page.screenshot({ path: path.join(artifacts, 'desktop-nickname.png'), fullPage: true, animations: 'disabled', style: 'nextjs-portal { display: none; }' })
    console.log('PASS canonical and legacy mentions, save, same-tab and cross-tab update, reload, and separate viewer labels')

    // UI selection retains a convenient local label, while signed message content uses the public address.
    await page.getByRole('button', { name: 'More message tools', exact: true }).click()
    await page.getByRole('button', { name: 'Mention', exact: true }).click()
    await page.getByRole('listbox', { name: 'Mention suggestions', exact: true }).getByRole('option').first().click()
    const composer = page.getByRole('textbox', { name: 'Message', exact: true })
    assert.equal(await composer.inputValue(), '@Study partner ')
    await composer.press('End')
    await composer.pressSequentially('privacy check')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByRole('main').getByText('@Study partner privacy check', { exact: true }).waitFor()
    await page.addScriptTag({ content: bundle })
    const outgoing = await page.evaluate(async owner => (await SerotineNickname.getStoredEvents(owner)).find(record => record.event.author === owner && record.event.kind === 'message' && record.event.payload.content.endsWith('privacy check')), owner.publicKey)
    assert.ok(outgoing, 'selected mention creates a stored signed message')
    assert.equal(outgoing.event.payload.content, `@${bob.publicKey} privacy check`)
    assert.deepEqual(outgoing.event.payload.mentions, [bob.publicKey])
    await peerPage.addScriptTag({ content: bundle })
    await peerPage.evaluate(async ({ owner, outgoing }) => SerotineNickname.saveStoredEvent(owner, { ...outgoing, local: false, receivedAt: Date.now() }), { owner: bob.publicKey, outgoing })
    await peerPage.reload()
    await expectMention(peerPage, outgoing.event.id, 'You', 'privacy check')
    console.log('PASS sent mention is stored as a public address and independently displayed for its recipient')

    // Inspect the decrypted export, since absence in encrypted JSON alone proves nothing.
    const backupPlaintext = await page.evaluate(async owner => {
      const password = 'synthetic-backup-password'
      const envelope = JSON.parse(await SerotineNickname.exportFullBackup(owner, password))
      const bytes = value => Uint8Array.from(atob(value), character => character.charCodeAt(0))
      const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
      const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: bytes(envelope.salt), iterations: 600000 }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(envelope.iv), additionalData: new TextEncoder().encode('serotine-full-backup:v1:PBKDF2-SHA256-600000:AES-256-GCM') }, key, bytes(envelope.ciphertext))
      return new TextDecoder().decode(plain)
    }, owner)
    assert.equal(backupPlaintext.includes(nickname), false, 'private nickname is absent from decrypted full backup')
    assert.equal(backupPlaintext.includes('serotine_local_nickname'), false)
    assert.equal(JSON.stringify(relayRequests).includes(nickname), false, 'private nickname is absent from relay requests')
    assert.equal(JSON.stringify(relayRequests).includes('Study partner'), false, 'local selected alias is absent from relay requests')
    console.log('PASS private nickname omitted from decrypted backup and relay requests')

    await page.setViewportSize({ width: 320, height: 740 })
    await page.getByRole('link', { name: 'Back to conversations', exact: true }).click()
    await openSettings(page)
    const dialog = settings(page)
    const measurements = await dialog.evaluate(node => ({ width: node.getBoundingClientRect().width, left: node.getBoundingClientRect().left, overflow: node.scrollWidth > node.clientWidth + 1, pageOverflow: document.documentElement.scrollWidth > innerWidth }))
    assert.equal(measurements.overflow, false, '320px settings content fits')
    assert.equal(measurements.pageOverflow, false, '320px page fits')
    assert.ok(measurements.left >= 0 && measurements.left + measurements.width <= 321)
    await page.screenshot({ path: path.join(artifacts, 'mobile-nickname-settings.png'), fullPage: true, animations: 'disabled', style: 'nextjs-portal { display: none; }' })
    await dialog.getByRole('button', { name: 'Reset', exact: true }).click()
    await dialog.getByText('Private nickname reset to You.', { exact: true }).waitFor()
    await expectMention(secondTab, canonicalId, 'You', 'canonical mention')
    assert.equal(await page.evaluate(owner => localStorage.getItem(`serotine_local_nickname:${owner}`), owner.publicKey), null)
    console.log('PASS 320px nickname settings and reset propagated to another tab')
    assert.deepEqual(errors, [], 'browser runtime errors')
    fs.writeFileSync(path.join(artifacts, 'measurements.json'), JSON.stringify(measurements, null, 2))
    console.log(`Screenshots and local server log: ${artifacts}`)
    await ownerContext.close()
    await bobContext.close()
  } finally {
    await browser?.close()
    server.kill('SIGTERM')
    fs.closeSync(log)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
