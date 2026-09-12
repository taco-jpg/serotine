/* eslint-disable no-console */
/* global SerotineCleanup */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const port = process.env.SEROTINE_BROWSER_PORT || '3107'
assert.match(port, /^\d+$/)
const origin = `http://localhost:${port}`
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function identity() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey'])
  return { version: 2, publicKey: Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex'), privateKey: await crypto.subtle.exportKey('jwk', keys.privateKey) }
}
async function main() {
  const bundle = (await esbuild.build({ stdin: { contents: 'export * from "./lib/identity"; export * from "./lib/messaging"; export * from "./lib/messaging-store"; export * from "./lib/storage";', resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'SerotineCleanup', tsconfig: path.join(root, 'tsconfig.json') })).outputFiles[0].text
  const artifacts = process.env.SEROTINE_BROWSER_ARTIFACTS || fs.mkdtempSync('/tmp/serotine-chat-cleanup-')
  fs.mkdirSync(artifacts, { recursive: true })
  const logPath = path.join(artifacts, 'server.log'), log = fs.openSync(logPath, 'w')
  const server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--port', port, '--hostname', '127.0.0.1'], { cwd: root, stdio: ['ignore', log, log] })
  let browser
  try {
    let ready = false
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(fs.readFileSync(logPath, 'utf8').slice(-4000))
      try { if ((await fetch(origin, { signal: AbortSignal.timeout(3000) })).ok) { ready = true; break } } catch { /* Wait for compilation. */ }
      await pause(500)
    }
    assert.ok(ready, `Server did not start: ${logPath}`)
    browser = await chromium.launch({ executablePath: process.env.SEROTINE_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'], headless: true })
    const [owner, bob, admin] = await Promise.all([identity(), identity(), identity()])
    const errors = []
    for (const mobile of [false, true]) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, isMobile: mobile, hasTouch: mobile })
      const page = await context.newPage()
      page.on('pageerror', error => errors.push(error.message))
      await page.route(`${origin}/__cleanup-fixture`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Chat cleanup fixture</title>' }))
      await page.goto(`${origin}/__cleanup-fixture`)
      await page.addScriptTag({ content: bundle })
      const fixture = await page.evaluate(async ({ owner, bob, admin }) => {
        localStorage.setItem('serotine_identity_v2', JSON.stringify(owner))
        SerotineCleanup.saveContacts(owner.publicKey, [{ pub: bob.publicKey, alias: 'Bob' }])
        const now = Date.now() - 10000, cid = `group:${crypto.randomUUID()}`
        const group = await SerotineCleanup.signGroup({ id: cid, name: 'Left study group', admin: admin.publicKey, members: [admin.publicKey, owner.publicKey], epoch: 1, updatedAt: now }, admin)
        const save = async (author, conversationId, recipients, kind, payload, timestamp, descriptor) => {
          const event = await SerotineCleanup.signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: author.publicKey, conversationId, recipients, kind, payload, timestamp, ...(descriptor ? { group: descriptor } : {}) }, author)
          const record = { key: SerotineCleanup.eventStorageKey(event), event, local: false, delivered: recipients, receivedAt: timestamp }
          await SerotineCleanup.saveStoredEvent(owner.publicKey, record)
          return record
        }
        const message = await save(bob, owner.publicKey, [owner.publicKey], 'message', { content: 'Old history to remove' }, now)
        await save(admin, cid, [owner.publicKey], 'group', {}, now, group)
        await save(admin, cid, [owner.publicKey], 'message', { content: 'Saved group history' }, now + 1, group)
        await save(owner, cid, [admin.publicKey], 'leave', {}, now + 2, group)
        const preferences = await SerotineCleanup.getMessagingPreferences(owner.publicKey)
        await SerotineCleanup.saveMessagingPreferences(owner.publicKey, { ...preferences, accepted: [cid] })
        return { groupId: cid, message, backup: await SerotineCleanup.exportMessagingSnapshot(owner.publicKey) }
      }, { owner, bob, admin })
      await page.goto(`${origin}/chat`)
      const inbox = page.getByRole('complementary', { name: 'Inbox', exact: true })
      const rows = inbox.getByRole('navigation')
      await rows.getByRole('link').filter({ hasText: 'Bob' }).waitFor()
      await inbox.getByRole('button', { name: 'Options for Left study group', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Archive chat', exact: true }).click()
      await rows.getByRole('link').filter({ hasText: 'Left study group' }).waitFor({ state: 'hidden' })
      await page.reload()
      await inbox.getByRole('button', { name: /^Archived/ }).click()
      await rows.getByRole('link').filter({ hasText: 'Left study group' }).waitFor()
      await page.screenshot({ path: path.join(artifacts, `${mobile ? 'mobile' : 'desktop'}-archived.png`), fullPage: true, style: 'nextjs-portal { display: none; }' })
      await inbox.getByRole('button', { name: 'Options for Left study group', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Restore to inbox', exact: true }).click()
      await inbox.getByRole('button', { name: /^Inbox/ }).click()
      await rows.getByRole('link').filter({ hasText: 'Left study group' }).waitFor()
      await rows.getByRole('link').filter({ hasText: 'Bob' }).click()
      const main = page.getByRole('main')
      await main.getByText('Old history to remove', { exact: true }).waitFor()
      await main.getByRole('button', { name: 'Options for Bob', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Delete chat…', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
      await main.getByText('Old history to remove', { exact: true }).waitFor()
      await main.getByRole('button', { name: 'Options for Bob', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Delete chat…', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Delete chat', exact: true }).click()
      await page.waitForURL(`${origin}/chat`)
      await rows.getByRole('link').filter({ hasText: 'Bob' }).waitFor({ state: 'hidden' })
      await page.reload()
      await rows.getByRole('link').filter({ hasText: 'Left study group' }).waitFor()
      assert.equal(await rows.getByRole('link').filter({ hasText: 'Bob' }).count(), 0)
      await page.addScriptTag({ content: bundle })
      const result = await page.evaluate(async ({ owner, bob, fixture }) => {
        await SerotineCleanup.saveStoredEvent(owner.publicKey, fixture.message)
        await SerotineCleanup.importMessagingSnapshot(owner.publicKey, fixture.backup)
        const events = await SerotineCleanup.getStoredEvents(owner.publicKey)
        const preferences = await SerotineCleanup.getMessagingPreferences(owner.publicKey)
        const model = SerotineCleanup.buildMessagingModel(events, owner.publicKey, SerotineCleanup.loadContacts(owner.publicKey), preferences)
        const group = model.conversations.find(c => c.id === fixture.groupId)
        return { hasOldMessage: events.some(r => r.key === fixture.message.key), hasBob: model.conversations.some(c => c.id === bob.publicKey), left: !group.members.includes(owner.publicKey), contactKept: SerotineCleanup.loadContacts(owner.publicKey).some(c => c.pub === bob.publicKey) }
      }, { owner, bob, fixture })
      assert.deepEqual(result, { hasOldMessage: false, hasBob: false, left: true, contactKept: true })
      await inbox.getByRole('button', { name: 'Options for Left study group', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Delete chat…', exact: true }).click()
      await page.getByRole('dialog').getByRole('button', { name: 'Delete chat', exact: true }).click()
      await rows.getByRole('link').filter({ hasText: 'Left study group' }).waitFor({ state: 'hidden' })
      await page.goto(`${origin}/chat/${encodeURIComponent(fixture.groupId)}`)
      await main.getByText('Group history unavailable', { exact: true }).waitFor()
      assert.equal(await main.getByRole('textbox', { name: 'Message', exact: true }).isDisabled(), true)
      assert.equal(await main.getByText('Saved group history', { exact: true }).count(), 0)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
      console.log(`PASS ${mobile ? 'mobile' : 'desktop'} archive, restore, confirmation/cancel, delete, reload, stale replay, old backup and retained group departure`)
      await context.close()
    }
    assert.deepEqual(errors, [])
    console.log(`Screenshots and local server log: ${artifacts}`)
  } finally {
    await browser?.close()
    server.kill('SIGTERM')
    fs.closeSync(log)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
