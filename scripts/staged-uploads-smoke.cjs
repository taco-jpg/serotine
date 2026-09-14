/* eslint-disable no-console */
/* global SerotineFiles */
// Two real app identities and local D1/R2. Only the upload timing is intercepted.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const port = process.env.SEROTINE_BROWSER_PORT || '3182'
assert.match(port, /^\d+$/)
const origin = `http://localhost:${port}`
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

async function identity() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey'])
  return { version: 2, publicKey: Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('hex'), privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey) }
}
async function until(check, message, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await pause(100) }
  throw new Error(message)
}

async function main() {
  const bundle = (await esbuild.build({ stdin: { contents: 'export * from "./lib/identity";', resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'SerotineFiles' })).outputFiles[0].text
  const artifacts = process.env.SEROTINE_BROWSER_ARTIFACTS || fs.mkdtempSync('/tmp/serotine-staged-uploads-')
  fs.mkdirSync(artifacts, { recursive: true })
  const logPath = path.join(artifacts, 'server.log'), log = fs.openSync(logPath, 'w')
  const server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--port', port, '--hostname', '127.0.0.1'], { cwd: root, env: process.env, stdio: ['ignore', log, log] })
  let browser, sender, recipient
  try {
    await until(async () => {
      if (server.exitCode !== null) throw new Error(fs.readFileSync(logPath, 'utf8').slice(-3000))
      try { return (await fetch(`${origin}/api/files`, { signal: AbortSignal.timeout(3000) })).ok } catch { return false }
    }, 'Next did not become ready', 120000)
    const configuration = await (await fetch(`${origin}/api/files`)).json()
    assert.equal(configuration.available, true, 'local R2 binding must be enabled for this suite')
    assert.equal(configuration.maxFileBytes, 1024 ** 3)
    browser = await chromium.launch({ executablePath: process.env.SEROTINE_CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    const [alice, bob] = await Promise.all([identity(), identity()])
    const errors = []
    async function fixture(owner, peer) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', acceptDownloads: true })
      await context.addInitScript(() => { Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, configurable: true }) })
      const page = await context.newPage()
      page.setDefaultTimeout(30000)
      page.on('pageerror', error => errors.push(error.message))
      await page.route(`${origin}/__file-fixture`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>File fixture</title>' }))
      await page.goto(`${origin}/__file-fixture`)
      await page.addScriptTag({ content: bundle })
      await page.evaluate(({ owner, peer }) => {
        localStorage.setItem('serotine_identity_v2', JSON.stringify(owner))
        SerotineFiles.saveContacts(owner.publicKey, [{ pub: peer.publicKey, alias: 'File test peer' }])
      }, { owner, peer })
      await page.goto(`${origin}/chat/${peer.publicKey}`)
      await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor()
      await until(() => page.getByRole('textbox', { name: 'Message', exact: true }).isEditable(), 'Conversation did not finish opening')
      await until(() => page.getByLabel('Choose attachments', { exact: true }).isEnabled(), 'Attachment composer is not ready')
      return page
    }
    sender = await fixture(alice, bob)
    recipient = await fixture(bob, alice)
    console.log('Both actual app conversations are ready')
    const transfers = []
    let hold
    function holdNextUpload() {
      let release
      const gate = { promise: new Promise(resolve => { release = resolve }), release: () => release(), cancel: false, captured: false }
      gate.capture = data => { gate.data = data; gate.captured = true }
      hold = gate
      return gate
    }
    await sender.route(`${origin}/api/files`, async route => {
      const request = route.request()
      if (request.method() === 'GET') return route.continue()
      const envelope = JSON.parse(request.method() === 'PUT' ? request.headers()['x-serotine-file-request'] : request.postData())
      transfers.push({ action: envelope.action, uploadId: envelope.data.uploadId })
      const gate = hold
      if (request.method() === 'PUT' && gate && !gate.captured) {
        gate.capture({ uploadId: envelope.data.uploadId, ciphertext: request.postDataBuffer() })
        await gate.promise
        if (gate.cancel) return route.abort('aborted').catch(() => {})
      }
      return route.continue().catch(() => {})
    })
    const message = sender.getByRole('textbox', { name: 'Message', exact: true })
    const incoming = recipient.getByRole('region', { name: 'Conversation messages', exact: true })
    await message.fill('File transfer fixture ready')
    await sender.getByRole('button', { name: 'Send message', exact: true }).click()
    await incoming.getByText('File transfer fixture ready', { exact: true }).waitFor()
    const bytes = Buffer.from(Array.from({ length: 128 * 1024 }, (_, i) => i % 251))
    const name = 'typing-upload.bin', caption = 'I can finish this caption while the file uploads.'
    const gate = holdNextUpload()
    await sender.getByRole('button', { name: 'More message tools', exact: true }).click()
    const chooser = sender.waitForEvent('filechooser')
    await sender.getByRole('button', { name: 'Attach files', exact: true }).click()
    await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer: bytes })
    await until(() => gate.captured, 'Selected file never started its background upload')
    assert.equal(gate.data.ciphertext.length, bytes.length + 16, 'upload is authenticated ciphertext')
    assert.notDeepEqual(gate.data.ciphertext.subarray(0, bytes.length), bytes)
    await message.fill(caption)
    assert.equal(await message.inputValue(), caption)
    assert.equal(await message.isEditable(), true)
    assert.equal(await incoming.getByText(name, { exact: true }).count(), 0)
    assert.equal(transfers.some(item => item.action === 'file:publish'), false)
    await sender.screenshot({ path: path.join(artifacts, 'typing-during-upload.png'), animations: 'disabled', style: 'nextjs-portal { display: none; }' })
    gate.release()
    await sender.getByText('Uploaded · ready to send', { exact: true }).waitFor()
    assert.equal(await incoming.getByText(name, { exact: true }).count(), 0)
    assert.equal(transfers.some(item => item.action === 'file:publish'), false)
    await sender.getByRole('button', { name: 'Send message', exact: true }).click()
    await incoming.getByText(name, { exact: true }).waitFor()
    await incoming.getByText(caption, { exact: true }).waitFor()
    assert.equal(transfers.filter(item => item.action === 'file:publish').length, 1)
    const downloadEvent = recipient.waitForEvent('download')
    await incoming.getByRole('button', { name: `Download ${name}`, exact: true }).click()
    const download = await downloadEvent
    assert.equal(download.suggestedFilename(), name)
    assert.deepEqual(fs.readFileSync(await download.path()), bytes)
    console.log('PASS encrypted upload continues while typing; Send alone publishes descriptor/caption; recipient downloads exact bytes')

    const cancelled = holdNextUpload()
    const cancelledName = 'cancel-this-upload.bin'
    await sender.getByLabel('Choose attachments', { exact: true }).setInputFiles({ name: cancelledName, mimeType: 'application/octet-stream', buffer: bytes })
    await until(() => cancelled.captured, 'Second file never started its background upload')
    cancelled.cancel = true
    await sender.getByRole('button', { name: `Remove ${cancelledName}`, exact: true }).click()
    cancelled.release()
    await until(() => transfers.some(item => item.action === 'file:delete' && item.uploadId === cancelled.data.uploadId), 'Cancelled upload did not request deletion')
    await until(async () => (await sender.getByRole('list', { name: 'Pending attachments', exact: true }).count()) === 0, 'Cancelled attachment remains queued')
    assert.equal(transfers.some(item => item.uploadId === cancelled.data.uploadId && item.action === 'file:publish'), false)
    assert.equal(await incoming.getByText(cancelledName, { exact: true }).count(), 0)
    console.log('PASS removing a pending upload cancels transfer, deletes draft, and publishes no attachment')

    await sender.setViewportSize({ width: 320, height: 760 })
    const openTools = sender.getByRole('button', { name: 'More message tools', exact: true })
    if (await openTools.getAttribute('aria-expanded') !== 'true') await openTools.click()
    await sender.getByRole('button', { name: 'Open Backpack', exact: true }).click()
    const backpack = sender.getByRole('dialog', { name: 'Backpack', exact: true })
    await backpack.getByLabel('Add files to Backpack', { exact: true }).setInputFiles({ name: 'kept.txt', mimeType: 'text/plain', buffer: Buffer.from('Saved in this browser') })
    await backpack.getByRole('button', { name: 'Choose kept.txt', exact: true }).waitFor()
    await backpack.getByText(/5.0 GB.*1.0 GB/).waitFor()
    assert.equal(await backpack.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true)
    await sender.screenshot({ path: path.join(artifacts, 'backpack-mobile.png'), animations: 'disabled', style: 'nextjs-portal { display: none; }' })
    assert.deepEqual(errors, [])
    console.log(`PASS Backpack saves in browser and shows 5 GB / 1 GB limits at 320px; artifacts: ${artifacts}`)
    await new Promise((resolve, reject) => {
      const cleanup = spawn(process.execPath, [path.join(root, 'scripts/file-upload-cleanup.cjs'), origin], { cwd: root, stdio: 'inherit' })
      cleanup.once('error', reject)
      cleanup.once('exit', code => code === 0 ? resolve() : reject(new Error(`File cleanup exited with ${code}`)))
    })
  } catch (error) {
    for (const [name, page] of [['sender', sender], ['recipient', recipient]]) if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(artifacts, `${name}-failure.png`), fullPage: true, animations: 'disabled' }).catch(() => {})
      fs.writeFileSync(path.join(artifacts, `${name}-failure.txt`), await page.locator('body').innerText().catch(() => 'Page unavailable'))
    }
    console.error(`Failure artifacts: ${artifacts}`)
    throw error
  } finally { await browser?.close(); server.kill('SIGTERM'); fs.closeSync(log) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
