/* eslint-disable no-console */
/* global SerotineMedia */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const port = process.env.SEROTINE_BROWSER_PORT || '3167'
assert.match(port, /^\d+$/)
const origin = `http://localhost:${port}`
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const gifBytes = Buffer.from('R0lGODlhAQABAIAAAP8AAP///yH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64')
const fakeKey = 'serotine-browser-smoke-not-a-real-key'

async function identity() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey'])
  return { version: 2, publicKey: Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('hex'), privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey) }
}

async function main() {
  const bundle = (await esbuild.build({ stdin: { contents: 'export * from "./lib/identity"; export * from "./lib/messaging"; export * from "./lib/messaging-store"; export * from "./lib/attachments"; export * from "./lib/file-bank";', resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'SerotineMedia', tsconfig: path.join(root, 'tsconfig.json') })).outputFiles[0].text
  const artifacts = process.env.SEROTINE_BROWSER_ARTIFACTS || fs.mkdtempSync('/tmp/serotine-media-')
  fs.mkdirSync(artifacts, { recursive: true })
  const logPath = path.join(artifacts, 'server.log')
  const log = fs.openSync(logPath, 'w')
  // Next substitutes this synthetic public key while compiling the client. All
  // provider traffic below is intercepted; no real API credential is needed.
  const server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--port', port, '--hostname', '127.0.0.1'], { cwd: root, env: { ...process.env, NEXT_PUBLIC_GIPHY_API_KEY: fakeKey }, stdio: ['ignore', log, log] })
  let browser, page, serverError
  server.on('error', error => { serverError = error })
  try {
    let ready = false
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      if (serverError || server.exitCode !== null) throw new Error(`Server failed: ${serverError?.message || fs.readFileSync(logPath, 'utf8').slice(-3000)}`)
      try { if ((await fetch(origin, { signal: AbortSignal.timeout(3000) })).ok) { ready = true; break } } catch { /* Wait for local compilation. */ }
      await pause(500)
    }
    assert.ok(ready, `Server did not become ready: ${logPath}`)
    browser = await chromium.launch({ executablePath: process.env.SEROTINE_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'], headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: true, serviceWorkers: 'block' })
    page = await context.newPage()
    page.setDefaultTimeout(30000)
    const errors = [], providerRequests = [], unexpectedRequests = []
    page.on('pageerror', error => errors.push(error.message))
    const providerGif = {
      id: 'SerotineFixture1', rating: 'g', title: 'Synthetic red square GIF', alt_text: 'Synthetic red square', username: 'smoke-test',
      images: {
        fixed_height: { url: 'https://media.giphy.com/media/SerotineFixture1/200.gif?fixture=preview', width: '200', height: '200' },
        downsized: { url: 'https://media.giphy.com/media/SerotineFixture1/giphy.gif?fixture=full', width: '400', height: '400' },
      },
    }
    let failNextSearch = false
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin === origin) return route.continue()
      if (url.hostname === 'api.giphy.com') {
        providerRequests.push({ url: request.url(), headers: request.headers(), body: request.postData() })
        assert.equal(url.searchParams.get('api_key'), fakeKey)
        assert.equal(url.searchParams.get('rating'), 'g')
        if (failNextSearch && url.pathname.endsWith('/search')) {
          failNextSearch = false
          return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
        }
        const data = url.pathname.endsWith('/SerotineFixture1') ? providerGif : [providerGif]
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data, pagination: { total_count: 1 }, meta: { status: 200 } }) })
      }
      if (url.hostname === 'media.giphy.com') {
        providerRequests.push({ url: request.url(), headers: request.headers(), body: request.postData() })
        return route.fulfill({ contentType: 'image/gif', body: gifBytes })
      }
      unexpectedRequests.push(request.url())
      return route.abort()
    })
    await page.route(`${origin}/__media-smoke`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Media smoke fixture</title>' }))
    await page.goto(`${origin}/__media-smoke`)
    await page.addScriptTag({ content: bundle })
    const [owner, otherOwner] = await Promise.all([identity(), identity()])
    // Both files are generated locally and sent only to the synthetic identity's
    // self-chat through the real attachment and MessagingEngine paths.
    await page.evaluate(async owner => {
      localStorage.setItem('serotine_identity_v2', JSON.stringify(owner))
      const engine = new SerotineMedia.MessagingEngine(await SerotineMedia.loadIdentity())
      await engine.start()
      const canvas = document.createElement('canvas')
      canvas.width = 960; canvas.height = 540
      const drawing = canvas.getContext('2d')
      drawing.fillStyle = '#182032'; drawing.fillRect(0, 0, canvas.width, canvas.height)
      drawing.fillStyle = '#8fa7ff'; drawing.fillRect(100, 100, 760, 340)
      const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      await SerotineMedia.sendAttachment(engine.sendEvent, owner.publicKey, new File([png], 'inline-landscape.png', { type: 'image/png' }))
      canvas.width = 320; canvas.height = 180
      const stream = canvas.captureStream(15)
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' })
      const parts = []
      recorder.ondataavailable = event => { if (event.data.size) parts.push(event.data) }
      const recorded = new Promise(resolve => { recorder.onstop = () => resolve(new Blob(parts, { type: 'video/webm' })) })
      recorder.start()
      let frame = 0
      const animation = setInterval(() => { drawing.fillStyle = ++frame % 2 ? '#8fa7ff' : '#182032'; drawing.fillRect(0, 0, canvas.width, canvas.height) }, 70)
      await new Promise(resolve => setTimeout(resolve, 1200))
      clearInterval(animation); recorder.stop()
      const video = await recorded
      stream.getTracks().forEach(track => track.stop())
      await SerotineMedia.sendAttachment(engine.sendEvent, owner.publicKey, new File([video], 'inline-motion.webm', { type: 'video/webm' }))
      engine.dispose()
    }, owner)
    const selfChat = `${origin}/chat/${owner.publicKey}`
    await page.goto(selfChat)
    const messageBox = page.getByRole('textbox', { name: 'Message', exact: true })
    const history = page.getByRole('region', { name: 'Conversation messages', exact: true })
    await messageBox.waitFor()
    const image = history.getByRole('img', { name: 'inline-landscape.png', exact: true })
    await image.waitFor()
    await image.evaluate(img => img.decode())
    const inlineBounds = await image.boundingBox()
    assert.ok(inlineBounds.width >= 400, `desktop image is useful inline: ${JSON.stringify(inlineBounds)}`)
    assert.equal(await image.evaluate(img => img.naturalWidth), 960)
    await page.getByRole('button', { name: 'Enlarge inline-landscape.png', exact: true }).tap()
    const imageDialog = page.getByRole('dialog', { name: 'inline-landscape.png', exact: true })
    await imageDialog.waitFor()
    await imageDialog.getByRole('img', { name: 'inline-landscape.png', exact: true }).evaluate(img => img.decode())
    assert.ok((await imageDialog.getByRole('img', { name: 'inline-landscape.png', exact: true }).boundingBox()).width > inlineBounds.width, 'tapping shows a larger image')
    await imageDialog.getByRole('link', { name: 'Download original', exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await imageDialog.waitFor({ state: 'hidden' })
    const video = history.locator('video[aria-label="Play inline-motion.webm"]')
    await video.waitFor()
    assert.deepEqual(await video.evaluate(node => ({ controls: node.controls, inline: node.playsInline, autoplay: node.autoplay })), { controls: true, inline: true, autoplay: false })
    await video.evaluate(async node => { node.muted = true; await node.play() })
    await page.waitForFunction(() => document.querySelector('video[aria-label="Play inline-motion.webm"]')?.currentTime > 0.15)
    await video.evaluate(node => node.pause())
    await page.screenshot({ path: path.join(artifacts, 'desktop-inline-media.png'), animations: 'disabled', style: 'nextjs-portal { display: none; }' })
    console.log('PASS useful inline image size, touch enlargement, original download and native WebM playback')

    const openBank = async () => {
      await page.getByRole('button', { name: 'Open file bank', exact: true }).click()
      const bank = page.getByRole('dialog', { name: 'File bank', exact: true })
      await bank.waitFor()
      return bank
    }
    let bank = await openBank()
    await bank.getByLabel('Add files to your bank', { exact: true }).setInputFiles([
      { name: 'repeat.gif', mimeType: 'image/gif', buffer: gifBytes },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic reusable file') },
    ])
    await bank.getByRole('button', { name: 'Choose repeat.gif', exact: true }).waitFor()
    await bank.getByRole('searchbox', { name: 'Search saved files', exact: true }).fill('missing')
    await bank.getByText('No saved files match your search.', { exact: true }).waitFor()
    await bank.getByRole('searchbox', { name: 'Search saved files', exact: true }).fill('repeat')
    assert.equal(await bank.getByRole('button', { name: 'Choose notes.txt', exact: true }).count(), 0)
    await bank.getByRole('button', { name: 'Rename repeat.gif', exact: true }).click()
    await bank.getByRole('textbox', { name: 'Rename repeat.gif', exact: true }).fill('favorite.gif')
    await bank.getByRole('button', { name: 'Save name', exact: true }).click()
    await bank.getByRole('searchbox', { name: 'Search saved files', exact: true }).fill('favorite')
    await bank.getByRole('button', { name: 'Choose favorite.gif', exact: true }).waitFor()
    await bank.getByRole('button', { name: 'Close', exact: true }).click()
    await page.reload()
    await messageBox.waitFor()
    bank = await openBank()
    await bank.getByRole('button', { name: 'Choose favorite.gif', exact: true }).click()
    await bank.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'Send file', exact: true }).waitFor()
    assert.equal(await history.getByRole('img', { name: 'favorite.gif', exact: true }).count(), 0, 'bank selection queues without sending')
    await page.getByRole('button', { name: 'Send file', exact: true }).click()
    const sentGif = history.getByRole('img', { name: 'favorite.gif', exact: true })
    await sentGif.waitFor()
    await sentGif.evaluate(img => img.decode())
    await page.addScriptTag({ content: bundle })
    assert.equal(await page.evaluate(async owner => {
      const record = (await SerotineMedia.getStoredEvents(owner)).find(row => row.event.payload.attachment?.name === 'favorite.gif')
      const rows = await SerotineMedia.getStoredEvents(owner)
      const chunks = rows.filter(row => row.event.kind === 'attachment-chunk' && row.event.payload.attachmentId === record.event.payload.attachment.id).map(row => ({ index: row.event.payload.index, data: row.event.payload.data }))
      const file = await SerotineMedia.assembleAttachment(record.event.payload.attachment, chunks)
      return btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())))
    }, owner.publicKey), gifBytes.toString('base64'), 'saved GIF retains exact bytes through attachment delivery')
    bank = await openBank()
    await bank.getByRole('button', { name: 'Remove favorite.gif from bank', exact: true }).click()
    await bank.getByText('Removed from your bank. Sent messages are unchanged.', { exact: true }).waitFor()
    assert.equal(await bank.getByRole('button', { name: 'Choose favorite.gif', exact: true }).count(), 0)
    await bank.getByRole('button', { name: 'Close', exact: true }).click()
    await bank.waitFor({ state: 'hidden' })
    await sentGif.waitFor()
    assert.equal(await sentGif.count(), 1, 'deleting bank entry preserves sent message')
    bank = await openBank()
    await bank.getByRole('button', { name: 'Choose notes.txt', exact: true }).click()
    await page.getByRole('button', { name: 'Send file', exact: true }).waitFor()
    await page.evaluate(other => {
      window.dispatchEvent(new Event('serotine:identity-changing'))
      localStorage.setItem('serotine_identity_v2', JSON.stringify(other))
      window.dispatchEvent(new Event('serotine:identity-changed'))
    }, otherOwner)
    await page.getByRole('button', { name: 'Send file', exact: true }).waitFor({ state: 'hidden' })
    await page.goto(`${origin}/chat/${otherOwner.publicKey}`)
    assert.equal(await page.getByRole('button', { name: 'Send file', exact: true }).count(), 0, 'identity switch clears queued bank files')
    bank = await openBank()
    await bank.getByText('Your bank is empty. Add a GIF, image, video, or file to get started.', { exact: true }).waitFor()
    assert.equal(await bank.getByRole('button', { name: 'Choose notes.txt', exact: true }).count(), 0, 'different identity cannot see first bank')
    await bank.getByRole('button', { name: 'Close', exact: true }).click()
    await page.evaluate(owner => localStorage.setItem('serotine_identity_v2', JSON.stringify(owner)), owner)
    await page.goto(selfChat)
    bank = await openBank()
    await bank.getByRole('button', { name: 'Choose notes.txt', exact: true }).waitFor()
    assert.equal(await bank.getByRole('button', { name: 'Choose favorite.gif', exact: true }).count(), 0, 'deletion persists across identity switches')
    await bank.getByRole('button', { name: 'Close', exact: true }).click()
    console.log('PASS file bank upload, search, rename, reload, explicit queue/send, byte integrity, deletion and identity isolation')

    assert.equal(providerRequests.length, 0, 'ordinary images, videos and file bank never contact GIPHY')
    await page.getByRole('button', { name: 'Search GIFs', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Find a GIF', exact: true })
    await picker.waitFor()
    assert.equal(providerRequests.length, 0, 'opening the picker waits for search or trending consent')
    failNextSearch = true
    await picker.getByRole('textbox', { name: 'Search GIPHY', exact: true }).fill('celebrate')
    await picker.getByRole('button', { name: 'Search', exact: true }).click()
    await picker.getByRole('alert').waitFor()
    await picker.getByRole('button', { name: 'Try again', exact: true }).click()
    await picker.getByRole('button', { name: 'Choose Synthetic red square GIF', exact: true }).click()
    await picker.waitFor({ state: 'hidden' })
    assert.equal(await messageBox.inputValue(), 'https://giphy.com/gifs/SerotineFixture1')
    const inlineGif = history.getByRole('img', { name: 'Synthetic red square', exact: true })
    assert.equal(await inlineGif.count(), 0, 'choosing a GIF must not send it')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await inlineGif.waitFor()
    await inlineGif.evaluate(img => img.decode())
    const beforeReload = providerRequests.filter(request => new URL(request.url).pathname.endsWith('/SerotineFixture1')).length
    await page.reload()
    await inlineGif.waitFor()
    await inlineGif.evaluate(img => img.decode())
    assert.ok(providerRequests.filter(request => new URL(request.url).pathname.endsWith('/SerotineFixture1')).length > beforeReload, 'visible history GIFs load automatically after reload')
    assert.ok(providerRequests.some(request => new URL(request.url).pathname.endsWith('/SerotineFixture1')))
    assert.ok(providerRequests.some(request => new URL(request.url).searchParams.get('fixture') === 'full'), 'full rendition parameters are preserved')
    await history.getByRole('button', { name: 'Hide GIF', exact: true }).click()
    await inlineGif.waitFor({ state: 'hidden' })
    await history.getByRole('button', { name: 'Show GIF', exact: true }).click()
    await inlineGif.waitFor()
    await inlineGif.evaluate(img => img.decode())
    for (const request of providerRequests) {
      assert.equal(request.headers.referer, undefined, 'provider receives no conversation URL')
      assert.equal(request.headers.cookie, undefined, 'provider receives no cookies')
      assert.equal(request.body, null, 'provider receives no message/file payload')
      assert.ok(!request.url.includes(owner.publicKey) && !request.url.includes(otherOwner.publicKey))
    }
    console.log('PASS mocked GIF search failure/retry, explicit staging/send, automatic inline rendering/reload, hide/show and provider request privacy')

    await page.setViewportSize({ width: 320, height: 700 })
    await page.getByRole('button', { name: 'Enlarge inline-landscape.png', exact: true }).scrollIntoViewIfNeeded()
    await page.getByRole('button', { name: 'Enlarge inline-landscape.png', exact: true }).tap()
    await imageDialog.waitFor()
    await imageDialog.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)))
    const mobileBounds = await imageDialog.boundingBox()
    assert.ok(mobileBounds.x >= 0 && mobileBounds.x + mobileBounds.width <= 321, 'enlarged image fits narrow phone')
    await imageDialog.getByRole('button', { name: 'Close', exact: true }).tap()
    bank = await openBank()
    assert.equal(await bank.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'bank fits narrow phone')
    await page.screenshot({ path: path.join(artifacts, 'mobile-file-bank.png'), animations: 'disabled', style: 'nextjs-portal { display: none; }' })
    await bank.getByRole('button', { name: 'Close', exact: true }).click()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'conversation fits narrow phone')
    assert.deepEqual(errors, [], 'no browser runtime errors')
    assert.deepEqual(unexpectedRequests, [], 'no unexpected external traffic')
    console.log(`ALL MEDIA BROWSER CHECKS PASSED; screenshots and local server log: ${artifacts}`)
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true, animations: 'disabled' }).catch(() => {})
      fs.writeFileSync(path.join(artifacts, 'failure.txt'), await page.locator('body').innerText().catch(() => 'Page unavailable'))
    }
    console.error(`Failure artifacts: ${artifacts}`)
    throw error
  } finally {
    await browser?.close()
    server.kill('SIGTERM')
    fs.closeSync(log)
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
