/* eslint-disable no-console */
/* global SerotineTheme */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const http = require('node:http')
const { chromium } = require('playwright')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const port = process.env.SEROTINE_BROWSER_PORT || '3111'
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
  const bundle = (await esbuild.build({ stdin: { contents: 'export * from "./lib/identity"; export * from "./lib/messaging"; export * from "./lib/messaging-store"; export * from "./lib/storage"; export * from "./lib/attachments";', resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'SerotineTheme', tsconfig: path.join(root, 'tsconfig.json') })).outputFiles[0].text
  const baseline = process.argv.includes('--baseline')
  const artifacts = process.env.SEROTINE_BROWSER_ARTIFACTS || fs.mkdtempSync('/tmp/serotine-theme-layout-')
  fs.mkdirSync(artifacts, { recursive: true })
  const logPath = path.join(artifacts, 'server.log'), log = fs.openSync(logPath, 'w')
  const server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--port', port, '--hostname', '127.0.0.1'], { cwd: root, stdio: ['ignore', log, log] })
  let browser
  try {
    let ready = false
    const deadline = Date.now() + 120000
    let startupError
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(fs.readFileSync(logPath, 'utf8').slice(-4000))
      try { const status = await localStatus(); if (status === 200) { ready = true; break } startupError = `HTTP ${status}` } catch (error) { startupError = `${error.message}: ${error.cause?.message || ''}` }
      await pause(500)
    }
    assert.ok(ready, `Server did not start: ${logPath}; ${startupError}`)
    browser = await chromium.launch({ executablePath: process.env.SEROTINE_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage'], headless: true })
    const [owner, bob] = await Promise.all([identity(), identity()])
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route(`${origin}/__theme-fixture`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Theme and layout fixture</title>' }))
    await page.goto(`${origin}/__theme-fixture`)
    await page.addScriptTag({ content: bundle })
    const fixture = await page.evaluate(async ({ owner, bob }) => {
      localStorage.setItem('serotine_identity_v2', JSON.stringify(owner))
      SerotineTheme.saveContacts(owner.publicKey, [{ pub: bob.publicKey, alias: 'Study partner' }])
      const now = Date.now() - 120000
      let sequence = 0
      const save = async (author, conversationId, recipients, kind, payload) => {
        const timestamp = now + sequence++ * 1000
        const event = await SerotineTheme.signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: author.publicKey, conversationId, recipients, kind, payload, timestamp }, author)
        await SerotineTheme.saveStoredEvent(owner.publicKey, { key: SerotineTheme.eventStorageKey(event), event, local: author.publicKey === owner.publicKey, delivered: recipients, receivedAt: timestamp })
        return event.id
      }
      await save(bob, owner.publicKey, [owner.publicKey], 'message', { content: 'Ready to review our notes?' })
      await save(owner, bob.publicKey, [bob.publicKey], 'message', { content: 'Yes, I have the examples open.' })
      await save(bob, owner.publicKey, [owner.publicKey], 'message', { content: 'The new layout should leave more room for the conversation.' })
      const simple = await save(owner, owner.publicKey, [], 'message', { content: 'A compact message with room to breathe.' })
      const rich = await save(owner, owner.publicKey, [], 'message', { content: 'Review https://example.com/notes and this snippet:\n```python\nprint("Hello, world")\n```\nThe derivative is $2x$.' })
      const poll = await save(owner, owner.publicKey, [], 'poll', { question: 'Which topic next?', options: ['Limits', 'Derivatives'] })
      const canvas = document.createElement('canvas'); canvas.width = 720; canvas.height = 360
      const drawing = canvas.getContext('2d'); drawing.fillStyle = '#29354c'; drawing.fillRect(0, 0, 720, 360); drawing.fillStyle = '#8ec5c0'; drawing.beginPath(); drawing.arc(180, 180, 105, 0, Math.PI * 2); drawing.fill(); drawing.fillStyle = '#f5d9ab'; drawing.fillRect(370, 80, 230, 200)
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
      const prepared = await SerotineTheme.prepareAttachment(new File([blob], 'study-shapes.png', { type: 'image/png' }))
      for (const chunk of prepared.chunks) await save(owner, owner.publicKey, [], 'attachment-chunk', { attachmentId: prepared.metadata.id, ...chunk })
      const image = await save(owner, owner.publicKey, [], 'attachment', { attachment: prepared.metadata })
      for (let index = 1; index <= 5; index++) await save(owner, owner.publicKey, [], 'message', { content: `Quick note ${index}: keep the details easy to scan.` })
      return { simple, rich, poll, image }
    }, { owner, bob })
    await page.goto(`${origin}/chat/${owner.publicKey}`)
    const message = page.getByRole('textbox', { name: 'Message', exact: true })
    await message.waitFor()
    await page.locator(`#message-${fixture.simple}`).waitFor()
    const measurements = []
    async function capture(target, name) {
      const result = await target.evaluate(() => {
        const footer = document.querySelector('footer'), history = document.querySelector('[aria-label="Conversation messages"]'), sidebar = document.querySelector('aside[aria-label="Inbox"]'), textbox = document.querySelector('textarea[aria-label="Message"]')
        return { viewport: { width: innerWidth, height: innerHeight }, composer: Math.round(footer.getBoundingClientRect().height), history: Math.round(history.getBoundingClientRect().height), sidebar: Math.round(sidebar.getBoundingClientRect().width), textbox: Math.round(textbox.getBoundingClientRect().height), horizontalOverflow: document.documentElement.scrollWidth > innerWidth, composerOverflow: footer.scrollWidth > footer.clientWidth + 1, theme: document.documentElement.className }
      })
      measurements.push({ name, ...result })
      assert.equal(result.horizontalOverflow, false, `${name}: page must fit viewport`)
      assert.equal(result.composerOverflow, false, `${name}: composer must fit viewport`)
      await target.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: true, style: 'nextjs-portal { display: none; }' })
      console.log(name, JSON.stringify(result))
      return result
    }
    if (baseline) {
      await capture(page, 'baseline-desktop')
      await page.setViewportSize({ width: 390, height: 844 })
      await capture(page, 'baseline-mobile')
    } else {
      async function resolvedTheme(target, expected) {
        await target.waitForFunction(value => document.documentElement.classList.contains(value) && document.documentElement.style.colorScheme === value, expected)
        const chrome = await target.locator('meta[name="theme-color"]').evaluateAll(nodes => nodes.map(node => node.content))
        assert.ok(chrome.length && chrome.every(color => color.toLowerCase() === (expected === 'dark' ? '#151922' : '#f8fafc')), `Browser chrome follows ${expected}: ${chrome}`)
      }
      async function chooseTheme(target, label) {
        await target.getByRole('button', { name: /^Theme: / }).click()
        await target.getByRole('menuitemradio', { name: label, exact: true }).click()
        assert.equal(await target.evaluate(() => localStorage.getItem('theme')), label.toLowerCase())
      }
      async function contrastSamples(theme) {
        const samples = await page.evaluate(({ simple, rich, poll }) => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
          const drawing = canvas.getContext('2d', { willReadFrequently: true })
          const rgba = color => { drawing.clearRect(0, 0, 1, 1); drawing.fillStyle = color; drawing.fillRect(0, 0, 1, 1); return Array.from(drawing.getImageData(0, 0, 1, 1).data) }
          const blend = (top, base) => top.slice(0, 3).map((value, index) => value * top[3] / 255 + base[index] * (1 - top[3] / 255))
          const luminance = rgb => rgb.map(value => { const channel = value / 255; return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4 }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
          return Object.entries({ message: `#message-${simple} .whitespace-pre-wrap`, link: `#message-${rich} a`, code: `#message-${rich} pre code`, poll: `#message-${poll} button span.relative` }).map(([label, selector]) => {
            const node = document.querySelector(selector)
            if (!node) return { label, missing: selector }
            let background = [255, 255, 255]
            const ancestors = []; for (let current = node; current; current = current.parentElement) ancestors.unshift(current)
            for (const ancestor of ancestors) background = blend(rgba(getComputedStyle(ancestor).backgroundColor), background)
            const foreground = blend(rgba(getComputedStyle(node).color), background)
            const levels = [luminance(foreground), luminance(background)].sort((a, b) => a - b)
            return { label, ratio: Number(((levels[1] + 0.05) / (levels[0] + 0.05)).toFixed(2)), color: getComputedStyle(node).color, background, font: getComputedStyle(node).fontFamily }
          })
        }, fixture)
        fs.writeFileSync(path.join(artifacts, `${theme}-contrast.json`), JSON.stringify(samples, null, 2))
        for (const sample of samples) assert.ok(sample.ratio >= 4.5, `${theme} ${sample.label} should have readable text contrast: ${JSON.stringify(sample)}`)
        console.log(`PASS ${theme} message/link/code/poll contrast`, samples.map(sample => `${sample.label} ${sample.ratio}:1`).join(', '))
      }
      await resolvedTheme(page, 'dark')
      await chooseTheme(page, 'Light')
      await resolvedTheme(page, 'light')
      await contrastSamples('light')
      await page.getByRole('region', { name: 'Conversation messages' }).evaluate(node => { node.scrollTop = 0 })
      await capture(page, 'desktop-light')
      await page.reload(); await message.waitFor(); await resolvedTheme(page, 'light')
      await page.emulateMedia({ colorScheme: 'light' })
      await chooseTheme(page, 'Dark'); await resolvedTheme(page, 'dark')
      await contrastSamples('dark')
      await capture(page, 'desktop-dark')
      await page.getByRole('button', { name: 'Enlarge study-shapes.png', exact: true }).click()
      await page.getByRole('dialog').getByRole('img', { name: 'study-shapes.png', exact: true }).waitFor()
      await page.screenshot({ path: path.join(artifacts, 'desktop-image-viewer-dark.png'), fullPage: true, style: 'nextjs-portal { display: none; }' })
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
      await page.reload(); await message.waitFor(); await resolvedTheme(page, 'dark')
      await chooseTheme(page, 'System'); await resolvedTheme(page, 'light')
      await page.emulateMedia({ colorScheme: 'dark' }); await resolvedTheme(page, 'dark')
      await page.emulateMedia({ colorScheme: 'light' }); await resolvedTheme(page, 'light')
      await page.reload(); await message.waitFor(); await resolvedTheme(page, 'light')
      console.log('PASS light/dark persistence, explicit override, system selection and live OS theme changes')

      const inbox = page.getByRole('complementary', { name: 'Inbox', exact: true })
      await inbox.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('#serotine-sidebar').getBoundingClientRect().width === 64)
      assert.equal(await page.evaluate(() => localStorage.getItem('serotine_sidebar_collapsed')), 'true')
      await capture(page, 'desktop-collapsed')
      await inbox.getByRole('button', { name: 'Start a chat', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Add contact', exact: true }).waitFor()
      await page.keyboard.press('Escape')
      await page.reload(); await message.waitFor()
      await inbox.getByRole('button', { name: 'Expand sidebar', exact: true }).waitFor()
      await inbox.locator(`a[href="/chat/${bob.publicKey}"]:visible`).click()
      await page.getByRole('main').getByText('Ready to review our notes?', { exact: true }).waitFor()
      await inbox.locator(`a[href="/chat/${owner.publicKey}"]:visible`).click()
      await message.waitFor()
      await inbox.getByRole('button', { name: 'Expand sidebar', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('#serotine-sidebar').getBoundingClientRect().width === 280)
      console.log('PASS sidebar collapse, rail actions/navigation, persisted preference and expansion')

      await message.fill('Browser sent theme check')
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      const sent = page.getByRole('region', { name: 'Conversation messages' }).getByText('Browser sent theme check', { exact: true })
      await sent.waitFor()
      const sentId = await sent.evaluate(node => node.closest('[id^="message-"]').id)
      const actions = page.locator(`#${sentId}`).getByRole('button', { name: 'Message actions', exact: true })
      await actions.click(); await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
      await page.getByRole('textbox', { name: 'Edited message', exact: true }).fill('Edited browser check')
      await page.getByRole('button', { name: 'Save changes', exact: true }).click()
      await page.locator(`#${sentId}`).getByText('Edited browser check', { exact: true }).waitFor()
      await actions.click(); await page.getByRole('menuitem', { name: 'Reply', exact: true }).click()
      await page.getByRole('button', { name: 'Cancel reply', exact: true }).waitFor()
      await message.fill('Reply preserved through the compact composer')
      await page.getByRole('button', { name: 'Send message', exact: true }).click()
      await page.getByRole('button', { name: 'Jump to replied message', exact: true }).waitFor()
      await actions.click(); await page.getByRole('menuitem', { name: 'Delete for me…', exact: true }).click()
      const deletion = page.getByRole('dialog', { name: 'Delete this message for you?', exact: true })
      await deletion.getByRole('button', { name: 'Cancel', exact: true }).click()
      await page.locator(`#${sentId}`).waitFor()
      await actions.click(); await page.getByRole('menuitem', { name: 'Delete for me…', exact: true }).click()
      await deletion.getByRole('button', { name: 'Delete for me', exact: true }).click()
      await page.locator(`#${sentId}`).waitFor({ state: 'detached' })
      await page.getByRole('button', { name: 'Original message is unavailable', exact: true }).waitFor()
      await page.reload(); await message.waitFor()
      assert.equal(await page.locator(`#${sentId}`).count(), 0)
      await inbox.getByRole('button', { name: /Search all messages/ }).click()
      await page.getByRole('textbox', { name: 'Search messages, links, and files', exact: true }).fill('Edited browser check')
      await page.getByRole('dialog').getByText('No matching messages.', { exact: true }).waitFor()
      await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()
      await page.locator(`#message-${fixture.poll}`).getByRole('button', { name: /^Limits/ }).click()
      await page.waitForFunction(id => document.querySelector(`#message-${id} button[aria-pressed="true"]`)?.textContent.includes('Limits'), fixture.poll)
      console.log('PASS actual text send, edit, reply, deletion cancel/confirm, reload, deleted search exclusion and voting')

      await inbox.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
      const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, colorScheme: 'dark', storageState: await context.storageState({ indexedDB: true }) })
      const phone = await phoneContext.newPage()
      phone.on('pageerror', error => errors.push(error.message))
      await phone.goto(`${origin}/chat`)
      const phoneInbox = phone.getByRole('complementary', { name: 'Inbox', exact: true })
      await phoneInbox.waitFor()
      assert.equal(Math.round((await phoneInbox.boundingBox()).width), 390, 'collapsed desktop preference still gives a full phone inbox')
      assert.equal(await phone.getByRole('button', { name: 'Expand sidebar', exact: true }).isVisible(), false)
      await chooseTheme(phone, 'Light'); await resolvedTheme(phone, 'light')
      await phone.screenshot({ path: path.join(artifacts, 'phone-inbox-light.png'), fullPage: true, style: 'nextjs-portal { display: none; }' })
      await phoneInbox.locator(`a[href="/chat/${owner.publicKey}"]:visible`).tap()
      const phoneMessage = phone.getByRole('textbox', { name: 'Message', exact: true })
      await phoneMessage.waitFor()
      await phoneMessage.fill('Sent from a touch screen')
      await phone.getByRole('button', { name: 'Send message', exact: true }).tap()
      await phone.getByRole('region', { name: 'Conversation messages' }).getByText('Sent from a touch screen', { exact: true }).waitFor()
      for (const [width, height] of [[390, 844], [320, 568]]) {
        await phone.setViewportSize({ width, height })
        await phone.waitForFunction(() => Math.abs(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-height')) - window.visualViewport.height) < 1)
        await capture(phone, `phone-${width}-light`)
        const send = await phone.getByRole('button', { name: 'Send message', exact: true }).boundingBox()
        assert.ok(send.width >= 44 && send.height >= 44, 'phone send control stays touch-sized')
        assert.ok(send.x >= 0 && send.x + send.width <= width + 1 && send.y + send.height <= height + 1, 'phone send control stays in viewport')
      }
      await phone.evaluate(() => { Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 340 }); Object.defineProperty(window.visualViewport, 'offsetTop', { configurable: true, value: 24 }); window.visualViewport.dispatchEvent(new Event('resize')) })
      await phone.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--app-height') === '340px')
      const keyboardSend = await phone.getByRole('button', { name: 'Send message', exact: true }).boundingBox()
      assert.ok(keyboardSend.y >= 24 && keyboardSend.y + keyboardSend.height <= 364, 'send stays above a visual viewport keyboard')
      await phone.evaluate(() => { delete window.visualViewport.height; delete window.visualViewport.offsetTop; window.visualViewport.dispatchEvent(new Event('resize')) })
      await phone.getByRole('link', { name: 'Back to conversations', exact: true }).tap()
      assert.equal(await phoneInbox.evaluate(node => node.scrollWidth > node.clientWidth + 1), false, '320px inbox content fits')
      await chooseTheme(phone, 'Dark'); await resolvedTheme(phone, 'dark')
      await phoneInbox.locator(`a[href="/chat/${owner.publicKey}"]:visible`).tap()
      await phoneMessage.waitFor()
      await capture(phone, 'phone-320-dark')
      await phone.getByRole('button', { name: 'More message tools', exact: true }).tap()
      await phone.getByRole('menuitem', { name: 'Create poll', exact: true }).tap()
      const phonePoll = phone.getByRole('dialog', { name: 'Create a poll', exact: true })
      await phonePoll.waitFor()
      assert.equal(await phonePoll.evaluate(node => node.scrollWidth > node.clientWidth + 1), false, 'mobile poll dialog fits the viewport')
      await phonePoll.getByRole('button', { name: 'Cancel', exact: true }).tap()
      await phone.getByRole('link', { name: 'Back to conversations', exact: true }).tap()
      await phoneInbox.locator(`a[href="/chat/${bob.publicKey}"]:visible`).tap()
      await phoneMessage.waitFor()
      await phone.getByRole('button', { name: 'More message tools', exact: true }).tap()
      await phone.getByRole('menuitem', { name: 'Mention someone', exact: true }).tap()
      await phone.getByRole('listbox', { name: 'Mention suggestions', exact: true }).getByRole('option').first().tap()
      assert.match(await phoneMessage.inputValue(), /^@Study partner /, 'mobile mention menu inserts the selected contact')
      await phoneContext.close()
      console.log('PASS touch send, phone theme access, 390px/320px layouts, desktop-collapse isolation, visual keyboard resize and compact poll/mention tools')
    }
    fs.writeFileSync(path.join(artifacts, 'measurements.json'), JSON.stringify(measurements, null, 2))
    assert.deepEqual(errors, [], 'browser runtime errors')
    console.log(`Screenshots and local server log: ${artifacts}`)
    await context.close()
  } finally {
    await browser?.close()
    server.kill('SIGTERM')
    fs.closeSync(log)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
