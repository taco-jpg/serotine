/* eslint-disable no-console */
/* global SerotineProfiles, engine */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')
const esbuild = require('esbuild')
const { localBrowserEnvironment } = require('./local-browser-support.cjs')
const root = path.resolve(__dirname, '..')
const port = process.env.SEROTINE_BROWSER_PORT || '3131'
assert.match(port, /^\d+$/)
const origin = `http://localhost:${port}`
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function identity() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey'])
  return { version: 2, publicKey: Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex'), privateKey: await crypto.subtle.exportKey('jwk', keys.privateKey) }
}

async function main() {
  const bundle = (await esbuild.build({ stdin: { contents: 'export * from "./lib/identity"; export * from "./lib/messaging"; export * from "./lib/messaging-store";', resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'SerotineProfiles', tsconfig: path.join(root, 'tsconfig.json') })).outputFiles[0].text
  const artifacts = process.env.SEROTINE_BROWSER_ARTIFACTS || fs.mkdtempSync('/tmp/serotine-profiles-')
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
    const errors = [], contexts = [], peers = []
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
        SerotineProfiles.saveContacts(owner.publicKey, [{ pub: contact.publicKey, alias: contact.alias }])
      }, { owner, contact })
      await page.evaluate(async () => { window.engine = new SerotineProfiles.MessagingEngine(await SerotineProfiles.loadIdentity()); await engine.start() })
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
      const states = await Promise.all(peers.map(page => page.evaluate(() => ({ status: engine.status, error: engine.error, count: engine.model.messages.length, profile: engine.profiles.state.values.displayName, revision: engine.profiles.state.revision, grants: engine.profiles.state.grants, cache: Object.fromEntries(Object.entries(engine.profiles.cache).map(([key, value]) => [key.slice(0, 8), {name:value.values.displayName,revision:value.revision}])), audiences: [...engine.profiles.audiences].map(([key,value])=>[key.slice(0,8),value]), requests: [...engine.profiles.requests].map(([key,value])=>[key.slice(0,8),value]), events: engine.records.filter(row=>row.event.kind==='profile').slice(-6).map(row=>({type:row.event.payload.profile.type,revision:row.event.payload.profile.revision,token:row.event.payload.profile.token,data:row.event.payload.profile.type==="data" ? row.event.payload.profile.data : undefined,error:row.error,delivered:row.delivered.length})) }))))
      throw new Error(`${label}: ${JSON.stringify(states)}`)
    }
    await a.evaluate(() => engine.profiles.saveProfile({ displayName: "Alice Shared", bio: "Only close friends", status: "Reading", colors: { accent: "#c42dee", background: "#161820" } }))
    await settle(() => b.evaluate(peer => !Object.keys(engine.profiles.getProfile(peer)).length, alice.publicKey), 'private defaults')
    await a.evaluate(peer => engine.profiles.setSharing(peer, ["displayName"]), bob.publicKey)
    await settle(() => b.evaluate(peer => engine.profiles.getProfile(peer).displayName === "Alice Shared", alice.publicKey), 'authorized profile delivery')
    assert.equal(await b.evaluate(peer => engine.profiles.getProfile(peer).bio, alice.publicKey), undefined)
    assert.deepEqual(await a.evaluate(peer => engine.profiles.getProfile(peer), bob.publicKey), {})
    ui = await contexts[0].newPage()
    await ui.goto(`${origin}/chat`)
    await ui.getByRole('button', { name: 'Notification and privacy settings', exact: true }).click()
    await ui.getByRole('button', { name: 'Edit profile', exact: true }).click()
    const editor = ui.getByRole('dialog', { name: 'Edit profile', exact: true })
    await editor.getByRole('textbox', { name: 'Display name', exact: true }).fill('Alice Updated')
    const png = await ui.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 48; const c = canvas.getContext('2d'); c.fillStyle = '#8b5cf6'; c.fillRect(0, 0, 48, 48); return canvas.toDataURL('image/png').split(',')[1] })
    await editor.locator('#profile-avatar').setInputFiles({ name: 'picture.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
    await editor.getByRole('button', { name: 'Remove picture', exact: true }).waitFor()
    await ui.setViewportSize({ width: 390, height: 844 })
    assert.equal(await ui.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile editor has no horizontal overflow')
    await ui.screenshot({ path: path.join(artifacts, 'profile-editor-phone.png'), fullPage: true, style: 'nextjs-portal { display: none; }' })
    await editor.getByRole('button', { name: 'Save profile', exact: true }).click()
    await editor.waitFor({ state: 'hidden' })
    await settle(() => b.evaluate(peer => engine.profiles.getProfile(peer).displayName === 'Alice Updated', alice.publicKey), 'updated field delivery')
    assert.equal(await b.evaluate(peer => engine.profiles.getProfile(peer).avatar, alice.publicKey), undefined, 'avatar remains private while name is shared')
    await ui.setViewportSize({ width: 1280, height: 900 })
    await ui.getByRole('button', { name: 'Add contact', exact: true }).first().click()
    const add = ui.getByRole('dialog', { name: 'Add a contact', exact: true })
    assert.equal(await add.getByRole('checkbox').count(), 6)
    for (const checkbox of await add.getByRole('checkbox').all()) assert.equal(await checkbox.isChecked(), false)
    await add.getByRole('button', { name: 'Cancel', exact: true }).click()
    await a.evaluate(async peer => { await engine.refresh(); await engine.profiles.setSharing(peer, ["avatar", "displayName"]) }, bob.publicKey)
    await settle(() => b.evaluate(peer => !!engine.profiles.getProfile(peer).avatar, alice.publicKey), 'recipient-scoped picture delivery')
    await b.evaluate(peer => engine.sendText(peer, 'Profile test conversation'), alice.publicKey)
    await settle(() => a.evaluate(() => engine.model.messages.some(message => message.content === 'Profile test conversation')), 'conversation setup')
    const bobUi = await contexts[1].newPage()
    await bobUi.goto(`${origin}/chat/${alice.publicKey}`)
    await bobUi.getByRole('img', { name: 'Profile picture', exact: true }).first().waitFor()
    assert.ok((await bobUi.getByRole('img', { name: 'Profile picture', exact: true }).first().getAttribute('src')).startsWith('data:image/'))
    await a.evaluate(peer => engine.profiles.setSharing(peer, []), bob.publicKey)
    await settle(() => b.evaluate(peer => Object.keys(engine.profiles.getProfile(peer)).length === 0, alice.publicKey), 'revocation clears all shared fields')
    await bobUi.waitForFunction(() => document.querySelectorAll('img[alt="Profile picture"]').length === 0)
    await a.evaluate(peer => engine.profiles.setSharing(peer, ["displayName"]), bob.publicKey)
    await settle(() => b.evaluate(peer => !!engine.profiles.getProfile(peer).displayName, alice.publicKey), 'grant restored explicitly')
    await a.evaluate(peer => engine.blockContact(peer), bob.publicKey)
    await settle(() => b.evaluate(peer => Object.keys(engine.profiles.getProfile(peer)).length === 0, alice.publicKey), 'blocking revokes profile')
    assert.deepEqual(errors, [])
    console.log(`PASS profile editor, mobile layout, unchecked Add flow, encrypted directional sharing, media delivery, field edits, revocation and block; artifacts ${artifacts}`)
  } catch (error) { console.error(error); if (ui) await ui.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {}); console.error(`Server log: ${logPath}`); process.exitCode = 1 }
  finally { await browser?.close(); server.kill('SIGTERM'); fs.closeSync(log) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
