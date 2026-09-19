/* eslint-disable no-console */
/* global SerotineGroups, engine */
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
  const bundle = (await esbuild.build({ stdin: { contents: 'export * from "./lib/identity"; export * from "./lib/messaging"; export * from "./lib/messaging-store";', resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'SerotineGroups', tsconfig: path.join(root, 'tsconfig.json') })).outputFiles[0].text
  const artifacts = process.env.SEROTINE_BROWSER_ARTIFACTS || fs.mkdtempSync('/tmp/serotine-groups-')
  fs.mkdirSync(artifacts, { recursive: true })
  const logPath = path.join(artifacts, 'server.log'), log = fs.openSync(logPath, 'w')
  const env = await localBrowserEnvironment(root, artifacts)
  const server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--port', port, '--hostname', '127.0.0.1'], { cwd: root, env, stdio: ['ignore', log, log] })
  let browser
  try {
    const deadline = Date.now() + 120000
    let ready = false
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(fs.readFileSync(logPath, 'utf8').slice(-4000))
      try { if ((await fetch(origin, { signal: AbortSignal.timeout(5000) })).ok) { ready = true; break } } catch { /* Wait for compilation. */ }
      await pause(300)
    }
    assert.ok(ready, `Server did not start: ${logPath}`)
    browser = await chromium.launch({ executablePath: process.env.SEROTINE_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'], headless: true })
    const errors = [], peers = []
    const [alice, bob] = await Promise.all([identity(), identity()])
    async function fixture(owner, contact) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
      context.setDefaultTimeout(20000)
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
      context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
      const page = await context.newPage()
      await page.route(`${origin}/__group-fixture`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Group integration peer</title>' }))
      await page.goto(`${origin}/__group-fixture`)
      await page.addScriptTag({ content: bundle })
      await page.evaluate(async ({ owner, contact }) => {
        localStorage.setItem('serotine_identity_v2', JSON.stringify(owner))
        SerotineGroups.saveContacts(owner.publicKey, [{ pub: contact.publicKey, alias: contact.alias }])
        window.engine = new SerotineGroups.MessagingEngine(await SerotineGroups.loadIdentity())
        await engine.start()
      }, { owner, contact })
      peers.push(page)
      return { context, page }
    }
    const a = await fixture(alice, { ...bob, alias: 'Bob' }), b = await fixture(bob, { ...alice, alias: 'Alice' })
    async function settle(predicate, label) {
      const deadline = Date.now() + 40000
      while (Date.now() < deadline) {
        await Promise.all(peers.map(page => page.evaluate(async () => { await engine.refresh(); await engine.sync() })))
        if (await predicate()) return
        await pause(300)
      }
      throw new Error(`Timed out: ${label}`)
    }
    const cid = await a.page.evaluate(pub => engine.createGroup('Consent test', [pub]), bob.publicKey)
    await settle(() => b.page.evaluate(cid => engine.model.requests.some(row => row.id === cid && row.invitationStatus === 'pending'), cid), 'pending invitation')
    const before = await a.page.evaluate(cid => engine.sendText(cid, 'Before consent'), cid)
    await settle(() => a.page.evaluate(id => engine.model.messages.some(row => row.id === id), before), 'sender-only pre-consent message')
    assert.equal(await b.page.evaluate(id => engine.model.messages.some(row => row.id === id), before), false)
    const guestUi = await b.context.newPage()
    await guestUi.goto(`${origin}/chat/${encodeURIComponent(cid)}`)
    await guestUi.getByText(/You receive no group messages until you accept/).waitFor()
    assert.equal(await guestUi.getByRole('textbox', { name: 'Message', exact: true }).isDisabled(), true)
    await guestUi.screenshot({ path: path.join(artifacts, 'pending-invitation.png'), fullPage: true })
    await guestUi.getByRole('button', { name: 'Accept', exact: true }).click()
    await settle(() => a.page.evaluate(({ cid, pub }) => engine.model.groups.find(row => row.id === cid)?.members.includes(pub), { cid, pub: bob.publicKey }), 'explicit admission')
    const after = await a.page.evaluate(cid => engine.sendText(cid, 'After consent'), cid)
    await settle(() => b.page.evaluate(id => engine.model.messages.some(row => row.id === id), after), 'post-consent message')
    await guestUi.reload()
    await guestUi.getByRole('region', { name: 'Conversation messages' }).getByText('After consent', { exact: true }).waitFor()
    assert.equal(await guestUi.getByText('Before consent', { exact: true }).count(), 0)
    assert.equal(await guestUi.getByRole('textbox', { name: 'Message', exact: true }).isDisabled(), false)
    const ownerUi = await a.context.newPage()
    await ownerUi.goto(`${origin}/chat/${encodeURIComponent(cid)}`)
    await ownerUi.getByRole('button', { name: 'Conversation details, files and settings', exact: true }).click()
    await ownerUi.getByRole('button', { name: 'Dissolve group', exact: true }).click()
    await ownerUi.getByText(/Permanently dissolve this group/).waitFor()
    await ownerUi.getByRole('button', { name: 'Dissolve group', exact: true }).click()
    await settle(() => b.page.evaluate(cid => engine.preferences.terminatedGroups?.includes(cid), cid), 'terminal status reaches member')
    await guestUi.reload()
    await guestUi.getByText('Closed group · Encrypted', { exact: true }).waitFor()
    await guestUi.getByRole('region', { name: 'Conversation messages' }).getByText('After consent', { exact: true }).waitFor()
    assert.equal(await guestUi.getByRole('textbox', { name: 'Message', exact: true }).isDisabled(), true)
    await guestUi.screenshot({ path: path.join(artifacts, 'dissolved-group.png'), fullPage: true })
    assert.deepEqual(errors, [])
    console.log(`PASS signed explicit invitation, friend consent boundary, no pre-accept history, post-accept messaging, UI dissolution, peer terminal state. Artifacts: ${artifacts}`)
  } finally {
    await browser?.close()
    server.kill('SIGTERM')
    fs.closeSync(log)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
