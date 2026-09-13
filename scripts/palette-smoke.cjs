/* eslint-disable no-console */
/* global SerotinePalette */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const http = require('node:http')
const { chromium } = require('playwright')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const port = process.env.SEROTINE_BROWSER_PORT || '3122'
assert.match(port, /^\d+$/)
const origin = `http://localhost:${port}`
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const paletteKey = 'serotine:palettes:v1'
const compactKey = 'serotine:auto-compact-files'

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
  const bundle = (await esbuild.build({ stdin: { contents: 'export * from "./lib/messaging"; export * from "./lib/messaging-store";', resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'SerotinePalette', tsconfig: path.join(root, 'tsconfig.json') })).outputFiles[0].text
  const artifacts = process.env.SEROTINE_BROWSER_ARTIFACTS || fs.mkdtempSync('/tmp/serotine-palettes-')
  fs.mkdirSync(artifacts, { recursive: true })
  const logPath = path.join(artifacts, 'server.log'), log = fs.openSync(logPath, 'w')
  const server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--port', port, '--hostname', '127.0.0.1'], { cwd: root, stdio: ['ignore', log, log] })
  let browser
  let page
  try {
    let ready = false
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error(fs.readFileSync(logPath, 'utf8').slice(-4000))
      try { if (await localStatus() === 200) { ready = true; break } } catch { /* Wait for the owned development server. */ }
      await pause(500)
    }
    assert.ok(ready, `Server did not start: ${logPath}`)
    browser = await chromium.launch({ executablePath: process.env.SEROTINE_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'], headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' })
    context.setDefaultTimeout(15000)
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin !== origin) return route.abort()
      if (url.pathname === '/api/relay') {
        const body = request.postDataJSON() || {}
        let result = { success: true }
        if (body.action === 'event:sync') result = { success: true, messages: [], nextCursor: body.data?.after || 0, hasMore: false }
        if (body.action === 'message:inbox' || body.action === 'message:list') result = { success: true, messages: [], nextCursor: null }
        if (body.action === 'signal:read') result = { success: true, signal: null }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
      }
      return route.continue()
    })
    const errors = []
    context.on('page', target => target.on('pageerror', error => errors.push(error.message)))
    page = await context.newPage()
    await page.route(`${origin}/__palette-fixture`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Palette fixture</title>' }))
    await page.goto(`${origin}/__palette-fixture`)
    await page.addScriptTag({ content: bundle })
    const owner = await identity()
    const messageId = await page.evaluate(async ({ owner, compactKey }) => {
      localStorage.setItem('serotine_identity_v2', JSON.stringify(owner))
      localStorage.setItem(compactKey, 'true')
      const event = await SerotinePalette.signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: owner.publicKey, conversationId: owner.publicKey, recipients: [], kind: 'message', payload: { content: 'Palette changes keep this message compact.' }, timestamp: Date.now() }, owner)
      await SerotinePalette.saveStoredEvent(owner.publicKey, { key: SerotinePalette.eventStorageKey(event), event, local: true, delivered: [], receivedAt: event.timestamp })
      return event.id
    }, { owner, compactKey })
    const chatUrl = `${origin}/chat/${owner.publicKey}`
    await page.goto(chatUrl)
    const message = page.getByRole('textbox', { name: 'Message', exact: true })
    await message.waitFor()
    await page.locator(`#message-${messageId}`).waitFor()

    const preferences = target => target.evaluate(key => JSON.parse(localStorage.getItem(key)), paletteKey)
    async function applied(target, id, mode, background) {
      await target.waitForFunction(({ id, mode, background }) => {
        const root = document.documentElement
        return root.dataset.palette === id && root.classList.contains(mode) && root.style.colorScheme === mode
          && (!background || getComputedStyle(root).getPropertyValue('--background').trim().toLowerCase() === background)
      }, { id, mode, background })
      const chrome = await target.evaluate(() => ({ expected: getComputedStyle(document.documentElement).getPropertyValue('--theme-chrome').trim().toLowerCase(), actual: [...document.querySelectorAll('meta[name="theme-color"]')].map(node => node.content.toLowerCase()) }))
      assert.ok(chrome.actual.length && chrome.actual.every(color => color === chrome.expected), 'browser chrome follows the applied palette')
    }
    async function chooseMode(target, mode) {
      await target.getByRole('button', { name: /^Theme: / }).click()
      await target.getByRole('menuitemradio', { name: mode, exact: true }).click()
      assert.equal(await target.evaluate(() => localStorage.getItem('theme')), mode.toLowerCase())
    }
    async function openPalettes(target = page) {
      await target.getByRole('button', { name: /^Theme: / }).click()
      await target.getByRole('menuitem', { name: 'Palettes & custom themes', exact: true }).click()
      await target.getByRole('dialog').waitFor()
      return target.getByRole('dialog')
    }
    async function dimensions() {
      return page.evaluate(id => {
        const measure = selector => {
          const box = document.querySelector(selector).getBoundingClientRect()
          return [Math.round(box.width), Math.round(box.height)]
        }
        return { composer: measure('footer'), message: measure(`#message-${id}`), textbox: measure('textarea[aria-label="Message"]'), sidebar: measure('aside[aria-label="Inbox"]') }
      }, messageId)
    }
    async function noOverflow(label) {
      const layout = await page.getByRole('dialog').evaluate(node => {
        const box = node.getBoundingClientRect()
        return { width: innerWidth, left: box.left, right: box.right, pageOverflow: document.documentElement.scrollWidth > innerWidth, dialogOverflow: node.scrollWidth > node.clientWidth + 1 }
      })
      assert.equal(layout.pageOverflow, false, `${label}: page fits`)
      assert.equal(layout.dialogOverflow, false, `${label}: dialog fits`)
      assert.ok(layout.left >= 0 && layout.right <= layout.width + 1, `${label}: dialog stays within the viewport`)
      await page.screenshot({ path: path.join(artifacts, `${label}.png`), fullPage: true, style: 'nextjs-portal { display: none; }' })
    }

    const originalDimensions = await dimensions()
    await applied(page, 'default', 'light')
    let dialog = await openPalettes()
    await dialog.getByRole('button', { name: 'Forest', exact: true }).click()
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await applied(page, 'forest', 'light', '#f4faf6')
    await chooseMode(page, 'Dark')
    await applied(page, 'forest', 'dark', '#121e18')
    await page.reload(); await message.waitFor()
    await applied(page, 'forest', 'dark', '#121e18')
    await chooseMode(page, 'System')
    await applied(page, 'forest', 'light', '#f4faf6')
    await page.emulateMedia({ colorScheme: 'dark' })
    await applied(page, 'forest', 'dark', '#121e18')
    await chooseMode(page, 'Dark')
    const second = await context.newPage()
    await second.goto(chatUrl)
    await second.getByRole('textbox', { name: 'Message', exact: true }).waitFor()
    dialog = await openPalettes()
    for (const [name, id, background] of [['Lavender', 'lavender', '#1c1725'], ['Rose', 'rose', '#25171d'], ['Monochrome', 'monochrome', '#191919'], ['Ocean', 'ocean', '#111d26']]) {
      await dialog.getByRole('button', { name, exact: true }).click()
      await applied(page, id, 'dark', background)
      await applied(second, id, 'dark', background)
    }
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    assert.deepEqual(await dimensions(), originalDimensions, 'palettes preserve chat, composer, textbox and sidebar dimensions')
    assert.equal(await page.evaluate(key => localStorage.getItem(key), compactKey), 'true', 'palettes preserve the auto compact preference')
    console.log('PASS presets, light/dark/system, reload, cross-tab synchronization and layout independence')

    const setColor = async (label, color) => {
      await page.getByLabel(`${label} color`, { exact: true }).evaluate((node, color) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, color)
        node.dispatchEvent(new Event('input', { bubbles: true }))
        node.dispatchEvent(new Event('change', { bubbles: true }))
      }, color)
    }
    const customize = async () => {
      await page.getByLabel('Theme name', { exact: true }).fill('Notebook colors')
      await page.getByText('Light variant', { exact: true }).click()
      await setColor('Main background', '#fdf0e0')
      await page.getByText('Dark variant', { exact: true }).click()
      await setColor('Main background', '#241522')
      assert.equal(await page.getByLabel('Theme conversation preview').evaluate(node => getComputedStyle(node).getPropertyValue('--background').trim()), '#241522', 'draft updates the preview')
    }
    dialog = await openPalettes()
    const beforeDraft = await preferences(page)
    await dialog.getByRole('button', { name: 'New theme', exact: true }).click()
    await customize()
    await noOverflow('editor-desktop')
    await applied(page, 'ocean', 'dark', '#111d26')
    assert.deepEqual(await preferences(page), beforeDraft, 'draft changes do not persist before saving')
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    assert.deepEqual(await preferences(page), beforeDraft, 'cancel discards the draft')
    await dialog.getByRole('button', { name: 'New theme', exact: true }).click()
    await customize()
    await dialog.getByRole('button', { name: 'Save & apply', exact: true }).click()
    await page.getByRole('dialog', { name: 'Palettes & custom themes', exact: true }).waitFor()
    const saved = await preferences(page)
    const custom = saved.customThemes.find(theme => theme.id === saved.selectedId)
    assert.equal(custom.name, 'Notebook colors')
    assert.equal(custom.light.background, '#fdf0e0')
    assert.equal(custom.dark.background, '#241522')
    await applied(page, custom.id, 'dark', '#241522')
    await applied(second, custom.id, 'dark', '#241522')
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await page.reload(); await message.waitFor()
    await applied(page, custom.id, 'dark', '#241522')
    await chooseMode(page, 'Light')
    await applied(page, custom.id, 'light', '#fdf0e0')
    await applied(second, custom.id, 'light', '#fdf0e0')
    await chooseMode(page, 'Dark')
    dialog = await openPalettes()
    await dialog.getByRole('button', { name: 'Edit Notebook colors', exact: true }).click()
    await page.getByLabel('Theme name', { exact: true }).fill('Low contrast trial')
    await setColor('Main background', '#222222')
    await setColor('Main text', '#222222')
    await dialog.getByText(/readability warnings?/).waitFor()
    await dialog.getByRole('button', { name: 'Save & apply', exact: true }).click()
    await applied(page, custom.id, 'dark', '#222222')
    assert.equal((await preferences(page)).customThemes.length, 1, 'editing replaces the existing custom theme')
    console.log('PASS preview isolation, cancel, both custom variants, save, edit and reload')

    // Recovery remains readable even when the chosen colors hide ordinary text.
    async function readableControl(control) {
      const ratio = await control.evaluate(node => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
        const drawing = canvas.getContext('2d', { willReadFrequently: true })
        const rgba = color => { drawing.clearRect(0, 0, 1, 1); drawing.fillStyle = color; drawing.fillRect(0, 0, 1, 1); return [...drawing.getImageData(0, 0, 1, 1).data] }
        const blend = (top, base) => top.slice(0, 3).map((value, i) => value * top[3] / 255 + base[i] * (1 - top[3] / 255))
        const luminance = rgb => rgb.map(value => { const x = value / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }).reduce((total, value, i) => total + value * [0.2126, 0.7152, 0.0722][i], 0)
        const ancestors = []; for (let current = node; current; current = current.parentElement) ancestors.unshift(current)
        let background = [255, 255, 255]
        for (const ancestor of ancestors) background = blend(rgba(getComputedStyle(ancestor).backgroundColor), background)
        const foreground = blend(rgba(getComputedStyle(node).color), background)
        const levels = [luminance(foreground), luminance(background)].sort((a, b) => a - b)
        return (levels[1] + 0.05) / (levels[0] + 0.05)
      })
      assert.ok(ratio >= 4.5, `recovery control remains readable (${ratio.toFixed(2)}:1)`)
    }
    await readableControl(dialog.getByRole('button', { name: 'Restore default palette', exact: true }))
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      await noOverflow(`picker-${width}`)
      await dialog.getByRole('button', { name: 'Edit Low contrast trial', exact: true }).click()
      await noOverflow(`editor-${width}`)
      await readableControl(dialog.getByRole('button', { name: 'Save & apply', exact: true }))
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    }
    await page.setViewportSize({ width: 1280, height: 900 })
    await dialog.getByRole('button', { name: 'Restore default palette', exact: true }).click()
    await applied(page, 'default', 'dark')
    assert.equal((await preferences(page)).customThemes.length, 1, 'reset preserves saved custom themes')

    const beforeImport = await preferences(page)
    await dialog.getByLabel('Import theme file', { exact: true }).setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"version":1,"css":"url(https://example.com)"}') })
    await dialog.getByRole('alert').waitFor()
    assert.deepEqual(await preferences(page), beforeImport, 'invalid import leaves preferences untouched')
    const importData = { version: 1, name: 'Imported colors', baseId: 'forest', light: { background: '#effff1' }, dark: { background: '#112219' } }
    await dialog.getByLabel('Import theme file', { exact: true }).setInputFiles({ name: 'colors.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(importData)) })
    await page.getByRole('dialog', { name: 'Edit custom theme', exact: true }).waitFor()
    assert.equal(await page.getByLabel('Theme name', { exact: true }).inputValue(), 'Imported colors')
    await applied(page, 'default', 'dark')
    assert.deepEqual(await preferences(page), beforeImport, 'valid import opens a draft without saving or applying it')
    await page.keyboard.press('Escape')
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    dialog = await openPalettes()
    await dialog.getByRole('button', { name: 'Delete Low contrast trial', exact: true }).click()
    await dialog.getByRole('button', { name: 'Keep', exact: true }).click()
    assert.equal((await preferences(page)).customThemes.length, 1, 'canceling deletion keeps the theme')
    await dialog.getByRole('button', { name: 'Low contrast trial', exact: false }).first().click()
    await applied(page, custom.id, 'dark', '#222222')
    await dialog.getByRole('button', { name: 'Delete Low contrast trial', exact: true }).click()
    await dialog.getByRole('button', { name: 'Delete theme', exact: true }).click()
    await applied(page, 'default', 'dark')
    await applied(second, 'default', 'dark')
    assert.equal((await preferences(page)).customThemes.length, 0, 'deleting the selected custom theme restores default')
    console.log('PASS readable recovery, 390px/320px picker/editor, reset, invalid/valid imports and deletion')

    await dialog.getByRole('button', { name: 'Forest', exact: true }).click()
    await applied(page, 'forest', 'dark', '#121e18')
    await page.evaluate(key => {
      const original = Storage.prototype.setItem
      window.restorePaletteStorage = () => { Storage.prototype.setItem = original }
      Storage.prototype.setItem = function (name, value) {
        if (name === key) throw new DOMException('Fixture storage quota exceeded', 'QuotaExceededError')
        return original.call(this, name, value)
      }
    }, paletteKey)
    await dialog.getByRole('button', { name: 'Ocean', exact: true }).click()
    await dialog.getByRole('alert').waitFor()
    await applied(page, 'forest', 'dark', '#121e18')
    await dialog.getByRole('button', { name: 'Restore default palette', exact: true }).click()
    await applied(page, 'default', 'dark')
    assert.equal((await preferences(page)).selectedId, 'forest', 'failed storage writes preserve the saved preference')
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    await page.getByRole('button', { name: /^Theme: / }).click()
    await page.getByRole('menuitem', { name: 'Restore default palette', exact: true }).click()
    dialog = page.getByRole('dialog', { name: 'Palettes & custom themes', exact: true })
    await dialog.getByRole('alert').waitFor()
    assert.match(await dialog.getByRole('alert').textContent(), /restored for this session/)
    await applied(page, 'default', 'dark')
    await page.evaluate(() => { window.restorePaletteStorage(); delete window.restorePaletteStorage })
    await dialog.getByRole('button', { name: 'Restore default palette', exact: true }).click()
    await dialog.getByRole('button', { name: 'Done', exact: true }).click()
    assert.deepEqual(await dimensions(), originalDimensions, 'custom themes and reset preserve layout density')
    assert.equal(await page.evaluate(key => localStorage.getItem(key), compactKey), 'true')
    await second.close()
    console.log('PASS failed persistence preserves the current palette and recovery works for the session')

    assert.deepEqual(errors, [], 'browser runtime errors')
    console.log(`Palette screenshots and server log: ${artifacts}`)
    await context.close()
  } catch (error) {
    await page?.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {})
    console.error(`Palette failure artifacts: ${artifacts}`)
    throw error
  } finally {
    await browser?.close()
    server.kill('SIGTERM')
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), pause(5000)])
    if (server.exitCode === null) server.kill('SIGKILL')
    fs.closeSync(log)
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
