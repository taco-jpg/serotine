/* eslint-disable no-console */
/* global SerotineQR */
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')
const esbuild = require('esbuild')
const QRCode = require('qrcode')
const root = path.resolve(__dirname, '..')
const port = process.env.SEROTINE_BROWSER_PORT || '3136'
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
  const decoder = (await esbuild.build({ stdin: { contents: 'export { default as decode } from "jsqr";', resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'SerotineQR' })).outputFiles[0].text
  const artifacts = process.env.SEROTINE_BROWSER_ARTIFACTS || fs.mkdtempSync('/tmp/serotine-qr-')
  fs.mkdirSync(artifacts, { recursive: true })
  const logPath = path.join(artifacts, 'server.log'), log = fs.openSync(logPath, 'w')
  const mode = process.env.SEROTINE_QR_PRODUCTION === '1' ? ['start'] : ['dev', '--webpack']
  const server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), ...mode, '--port', port, '--hostname', '127.0.0.1'], { cwd: root, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', log, log] })
  let browser, page, serverError
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
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' })
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.fallback() : route.abort())
    const [owner, friend, another] = await Promise.all([identity(), identity(), identity()])
    await context.addInitScript(owner => {
      if (!localStorage.getItem('serotine_identity_v2')) localStorage.setItem('serotine_identity_v2', JSON.stringify(owner))
      // A real canvas MediaStream exercises play(), frame decoding and track cleanup.
      window.__qrCamera = { mode: 'blank', tracks: [], pending: [], data: null }
      Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
        const state = window.__qrCamera
        if (state.mode === 'denied') throw new DOMException('Synthetic denial', 'NotAllowedError')
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 600
        const drawing = canvas.getContext('2d'); drawing.fillStyle = 'white'; drawing.fillRect(0, 0, 600, 600)
        if (state.data) { const image = new Image(); image.src = state.data; await image.decode(); drawing.drawImage(image, 0, 0, 600, 600) }
        const stream = canvas.captureStream(10)
        state.tracks.push(...stream.getTracks())
        if (state.mode === 'pending') return new Promise(resolve => state.pending.push(() => resolve(stream)))
        return stream
      } })
    }, owner)
    await context.route(`${origin}/api/relay`, async route => {
      const request = route.request().postDataJSON()
      const value = request.action === 'event:sync' ? { success: true, messages: [], nextCursor: request.data.after || 0, hasMore: false }
        : request.action === 'message:inbox' || request.action === 'message:list' ? { success: true, messages: [], nextCursor: null }
          : request.action === 'signal:read' ? { success: true, signal: null } : { success: true }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) })
    })
    page = await context.newPage()
    const errors = [], requests = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => requests.push(request.url()))
    const initial = await page.goto(`${origin}/chat`)
    assert.match(initial.headers()['permissions-policy'], /(?:^|,\s*)camera=\(self\)(?:,|$)/, 'the site permits its own camera scanner')
    await page.getByRole('button', { name: 'Invite a friend', exact: true }).waitFor()
    async function decodeImage(url) {
      await page.addScriptTag({ content: decoder })
      return page.evaluate(async url => {
        const image = new Image(); image.src = url; await image.decode()
        const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight
        const drawing = canvas.getContext('2d'); drawing.drawImage(image, 0, 0)
        return SerotineQR.decode(drawing.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data
      }, url)
    }
    async function capture(dialog, name) {
      await page.waitForFunction(() => Math.abs(parseFloat(document.documentElement.style.getPropertyValue('--app-height')) - innerHeight) < 1)
      const dimensions = await dialog.evaluate(node => {
        const rect = node.getBoundingClientRect()
        return { width: innerWidth, height: innerHeight, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, overflow: node.scrollWidth > node.clientWidth + 1 }
      })
      assert.ok(dimensions.left >= 0 && dimensions.right <= dimensions.width + 1, `${name}: dialog fits viewport`)
      assert.ok(dimensions.top >= 0 && dimensions.bottom <= dimensions.height + 1, `${name}: dialog height fits viewport ${JSON.stringify(dimensions)}`)
      assert.equal(dimensions.overflow, false, `${name}: no horizontal content overflow`)
      await page.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: true, style: 'nextjs-portal { display: none; }' })
    }
    await page.getByRole('button', { name: 'Invite a friend', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: 'Invite a friend', exact: true })
    const qr = dialog.getByRole('img', { name: 'Your address QR code', exact: true })
    await qr.waitFor()
    const url = await qr.getAttribute('src')
    assert.match(url, /^data:image\/png;base64,/)
    assert.equal(await decodeImage(url), owner.publicKey, 'displayed code is the complete original public address')
    const downloadPromise = page.waitForEvent('download')
    await dialog.getByRole('link', { name: 'Save QR image', exact: true }).click()
    const download = await downloadPromise
    assert.equal(download.suggestedFilename(), 'serotine-contact-qr.png')
    const downloadPath = path.join(artifacts, download.suggestedFilename())
    await download.saveAs(downloadPath)
    assert.equal(await decodeImage('data:image/png;base64,' + fs.readFileSync(downloadPath).toString('base64')), owner.publicKey)
    for (const [width, height] of [[1280, 900], [390, 844], [320, 568]]) { await page.setViewportSize({ width, height }); await capture(dialog, `invite-${width}`) }
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await page.setViewportSize({ width: 1280, height: 900 })
    console.log('PASS locally rendered QR and PNG download decode to the full address; desktop/390px/320px layouts')

    async function openContact() {
      await page.getByRole('button', { name: 'Add contact', exact: true }).first().click()
      return page.getByRole('dialog', { name: 'Add a contact', exact: true })
    }
    async function upload(dialog, buffer, name = 'contact.png', mimeType = 'image/png') {
      if (await dialog.getByRole('button', { name: 'Scan QR code', exact: true }).count()) await dialog.getByRole('button', { name: 'Scan QR code', exact: true }).click()
      await dialog.getByLabel('QR image', { exact: true }).setInputFiles({ name, mimeType, buffer })
    }
    const friendPng = await QRCode.toBuffer(friend.publicKey, { margin: 4, width: 600, errorCorrectionLevel: 'M' })
    dialog = await openContact()
    await upload(dialog, friendPng)
    await page.waitForFunction(value => document.getElementById('contact-address').value === value, friend.publicKey)
    assert.equal(await page.evaluate(key => (JSON.parse(localStorage.getItem(`serotine_contacts:${key}`) || '[]')).length, owner.publicKey), 0, 'scanning does not save the contact')
    for (const [width, height] of [[390, 844], [320, 568]]) {
      await page.setViewportSize({ width, height })
      await dialog.getByRole('button', { name: 'Scan QR code', exact: true }).click()
      await capture(dialog, `scanner-${width}`)
      await dialog.getByRole('button', { name: 'Cancel scan', exact: true }).click()
    }
    await page.setViewportSize({ width: 1280, height: 900 })
    await dialog.locator('#contact-name').fill('QR test friend')
    await dialog.getByRole('button', { name: 'Add contact', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await page.waitForURL(`${origin}/chat/${friend.publicKey}`)
    const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(`serotine_contacts:${key}`) || '[]'), owner.publicKey)
    assert.deepEqual(stored, [{ pub: friend.publicKey, alias: 'QR test friend' }])
    await page.getByRole('button', { name: 'Conversation details, files and settings', exact: true }).click()
    dialog = page.getByRole('dialog')
    const contactQr = dialog.getByRole('img', { name: 'Contact address QR code', exact: true })
    await contactQr.waitFor()
    assert.equal(await decodeImage(await contactQr.getAttribute('src')), friend.publicKey)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    console.log('PASS image scan, review before explicit contact save, and contact details QR')

    dialog = await openContact()
    const foreignInvite = `https://unvisited.example/contact#invite=${another.publicKey}`
    await upload(dialog, await QRCode.toBuffer(foreignInvite, { width: 600, margin: 4 }))
    await page.waitForFunction(value => document.getElementById('contact-address').value === value, another.publicKey)
    assert.equal(requests.some(url => url.includes('unvisited.example')), false, 'scanned invite links are never visited')
    assert.equal(page.url(), `${origin}/chat/${friend.publicKey}`)
    const blankImage = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 200
      const drawing = canvas.getContext('2d'); drawing.fillStyle = 'white'; drawing.fillRect(0, 0, 200, 200)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    for (const fixture of [
      { buffer: Buffer.from('not an image'), name: 'broken.png', mimeType: 'image/png' },
      { buffer: Buffer.from('not an image'), name: 'text.txt', mimeType: 'text/plain' },
      { buffer: Buffer.from(blankImage, 'base64'), name: 'blank.png', mimeType: 'image/png' },
      { buffer: Buffer.alloc(10 * 1024 * 1024 + 1), name: 'too-large.png', mimeType: 'image/png' },
      { buffer: await QRCode.toBuffer('javascript:alert(1)'), name: 'unsafe.png', mimeType: 'image/png' },
      { buffer: await QRCode.toBuffer(JSON.stringify(another.privateKey)), name: 'private.png', mimeType: 'image/png' },
    ]) {
      await upload(dialog, fixture.buffer, fixture.name, fixture.mimeType)
      await dialog.getByRole('alert').waitFor()
      assert.equal(await dialog.locator('#contact-address').inputValue(), another.publicKey, 'invalid input never replaces the reviewed address')
    }
    await dialog.getByRole('button', { name: 'Cancel scan', exact: true }).click()
    console.log('PASS invite import without navigation and invalid image/private data rejection')

    await dialog.getByRole('button', { name: 'Scan QR code', exact: true }).click()
    await page.evaluate(() => { window.__qrCamera.mode = 'denied' })
    await dialog.getByRole('button', { name: 'Use camera', exact: true }).click()
    await dialog.getByRole('alert').filter({ hasText: 'Camera access was blocked' }).waitFor()
    await page.evaluate(() => { window.__qrCamera.mode = 'blank' })
    await dialog.getByRole('button', { name: 'Use camera', exact: true }).click()
    await page.waitForFunction(() => window.__qrCamera.tracks.some(track => track.readyState === 'live'))
    await dialog.getByRole('button', { name: 'Stop camera', exact: true }).click()
    await page.waitForFunction(() => window.__qrCamera.tracks.every(track => track.readyState === 'ended'))
    await dialog.getByRole('button', { name: 'Use camera', exact: true }).click()
    await page.waitForFunction(() => window.__qrCamera.tracks.some(track => track.readyState === 'live'))
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await page.waitForFunction(() => window.__qrCamera.tracks.every(track => track.readyState === 'ended'))
    dialog = await openContact()
    await dialog.getByRole('button', { name: 'Scan QR code', exact: true }).click()
    await page.evaluate(() => { window.__qrCamera.mode = 'pending' })
    await dialog.getByRole('button', { name: 'Use camera', exact: true }).click()
    await page.waitForFunction(() => window.__qrCamera.pending.length > 0)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await page.evaluate(() => { window.__qrCamera.pending.splice(0).forEach(resolve => resolve()) })
    await page.waitForFunction(() => window.__qrCamera.tracks.every(track => track.readyState === 'ended'))
    console.log('PASS camera denial, stop, dialog close, and late permission resolution all release camera tracks')

    dialog = await openContact()
    await dialog.getByRole('button', { name: 'Scan QR code', exact: true }).click()
    await page.evaluate(data => { window.__qrCamera.mode = 'code'; window.__qrCamera.data = data }, 'data:image/png;base64,' + friendPng.toString('base64'))
    await dialog.getByRole('button', { name: 'Use camera', exact: true }).click()
    await page.waitForFunction(value => document.getElementById('contact-address').value === value, friend.publicKey)
    await page.waitForFunction(() => window.__qrCamera.tracks.every(track => track.readyState === 'ended'))
    await dialog.getByRole('button', { name: 'Scan QR code', exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    console.log('PASS live camera frame decoding')

    await page.getByRole('button', { name: 'Create group chat', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Create a group chat', exact: true })
    await dialog.getByLabel('Group name', { exact: true }).fill('QR test group')
    await dialog.getByRole('checkbox', { name: /QR test friend/ }).check()
    await dialog.getByRole('button', { name: 'Create group', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'Conversation details, files and settings', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'QR test group', exact: true })
    await dialog.getByRole('heading', { name: 'Members · 2', exact: true }).waitFor()
    await upload(dialog, await QRCode.toBuffer(another.publicKey, { width: 600, margin: 4 }))
    await page.waitForFunction(value => document.getElementById('group-add-member').value === value, another.publicKey)
    await dialog.getByRole('heading', { name: 'Members · 2', exact: true }).waitFor()
    await dialog.getByRole('button', { name: 'Add to group', exact: true }).click()
    await dialog.getByRole('heading', { name: 'Members · 3', exact: true }).waitFor()
    await upload(dialog, friendPng)
    await dialog.getByRole('alert').filter({ hasText: 'already in the group' }).waitFor()
    assert.deepEqual(errors, [], 'no browser runtime errors')
    console.log(`PASS group QR scan requires Add to group and rejects existing members; artifacts: ${artifacts}`)
  } catch (error) {
    await page?.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {})
    console.error(`QR smoke artifacts: ${artifacts}`)
    throw error
  } finally {
    await browser?.close()
    server.kill('SIGTERM')
    fs.closeSync(log)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
