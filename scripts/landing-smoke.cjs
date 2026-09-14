// With the app running: node scripts/landing-smoke.cjs
// Optional SEROTINE_LANDING_URL, SEROTINE_CHROMIUM_PATH,
// SEROTINE_LANDING_SCREENSHOTS, or SEROTINE_LANDING_HTML (self-contained fixture;
// explicitly NOT a Next.js, theme-provider or React hydration test).
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { chromium } = require("playwright")

async function main() {
  const fixture = process.env.SEROTINE_LANDING_HTML
  const html = fixture ? fs.readFileSync(fixture, "utf8") : null
  const url = process.env.SEROTINE_LANDING_URL || "http://localhost:3000"
  const screenshots = process.env.SEROTINE_LANDING_SCREENSHOTS
  if (screenshots) fs.mkdirSync(screenshots, { recursive: true })
  const browser = await chromium.launch({ executablePath: process.env.SEROTINE_CHROMIUM_PATH || undefined })
  const errors = [], results = []
  const load = async (page, enhanced = true) => {
    page.on("pageerror", e => errors.push(e.message))
    if (html !== null) await page.setContent(html, { waitUntil: "load" })
    else await page.goto(url, { waitUntil: "domcontentloaded" })
    await page.locator("#hero-title").waitFor()
    if (enhanced) await page.locator('#serotine-landing[data-enhanced="true"]').waitFor()
  }
  const noOverflow = async page => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Horizontal overflow")
  const settled = async page => page.waitForFunction(() => document.getAnimations().filter(a => a.effect?.target?.getClientRects().length && a.playState === 'running').length === 0)
  const setProgress = async (page, progress) => {
    await page.evaluate(p => { const s = document.querySelector('[data-story]'); const top = s.getBoundingClientRect().top + scrollY; scrollTo(0, top + (s.offsetHeight - innerHeight) * p) }, progress)
  }
  try {
    for (const theme of ["light", "dark"]) for (const [width, height] of [[320, 740], [390, 844], [640, 900], [768, 900], [801, 900], [1024, 768], [1280, 720], [1440, 900], [1920, 1080]]) {
      const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme })
      const page = await context.newPage(); await load(page); await settled(page); await noOverflow(page)
      assert.equal(await page.locator("h1").count(), 1)
      const firstView = await page.evaluate(() => {
        const context = document.querySelector('[data-story] p:nth-child(3)').getBoundingClientRect()
        const message = document.querySelector('[data-travelling-message]').getBoundingClientRect()
        const composer = document.querySelector('[data-room] > summary').getBoundingClientRect()
        return { context: context.bottom, message: message.bottom, composer: composer.bottom, viewport: innerHeight }
      })
      for (const key of ['context', 'message', 'composer']) assert.ok(firstView[key] <= firstView.viewport, `${width}×${height}: ${key} not in first viewport: ${JSON.stringify(firstView)}`)
      const background = await page.locator('#serotine-landing').evaluate(n => getComputedStyle(n).backgroundColor)
      assert.equal(background, theme === 'light' ? 'rgb(246, 244, 239)' : 'rgb(32, 30, 35)')
      if (screenshots && [390, 1440].includes(width)) await page.screenshot({ path: path.join(screenshots, `${theme}-${width}-first.png`) })
      await page.locator('[data-identity] > summary').click()
      await page.getByText('Display-only identity, not a contact you can message.', { exact: true }).waitFor({ state: 'visible' })
      await noOverflow(page)
      await page.locator('[data-identity] > summary').click()
      await page.locator('[data-room] > summary').click()
      await page.locator('#demo-note').fill('Hello from this page.')
      await page.getByRole('button', { name: 'Send demo note', exact: true }).click()
      assert.equal(await page.locator('[data-demo-message]').count(), 2)
      assert.equal(await page.locator('[data-echo]').innerText(), 'Hello from this page.')
      assert.equal(await page.locator('[data-demo-form]').count(), 1)
      await noOverflow(page)
      await page.locator('[data-room] > summary').click()
      await page.waitForFunction(() => document.querySelector('[data-demo-log]').childElementCount === 0)
      assert.match(await page.locator('[data-echo]').innerText(), /I thought you’d like this/)
      results.push(`${theme} ${width}×${height}: first viewport, layout, identity, send, echo, close/reset PASS`)
      await context.close()
    }

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
    const page = await context.newPage(); await load(page); await settled(page)
    await page.keyboard.press('Tab')
    assert.equal(await page.locator(':focus').innerText(), 'Skip to content')
    await page.keyboard.press('Enter')
    assert.equal(await page.locator(':focus').getAttribute('id'), 'main')
    const storageBefore = html === null ? await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key !== 'theme'))) : null
    await page.getByRole('button', { name: 'Switch to dark theme', exact: true }).click()
    await page.getByRole('button', { name: 'Switch to light theme', exact: true }).waitFor()
    if (storageBefore) assert.deepEqual(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key !== 'theme'))), storageBefore)
    results.push(html === null ? 'Keyboard skip; actual theme provider and non-mode storage preserved PASS' : 'Keyboard skip; fixture-only theme presentation PASS')

    await page.evaluate(() => window.__persistentMessage = document.querySelector('[data-travelling-message]'))
    for (const [p, name] of [[.46, 'between'], [.9, 'arrived'], [0, 'returned']]) {
      await setProgress(page, p)
      await page.waitForFunction(value => Math.abs(Number(document.querySelector('[data-story]').style.getPropertyValue('--p')) - value) < .02, p)
      assert.ok(await page.evaluate(() => window.__persistentMessage === document.querySelector('[data-travelling-message]')))
      if (p === .46) assert.ok(await page.evaluate(() => Number(document.querySelector('[data-story]').style.getPropertyValue('--seal')) > .98))
      if (p === .9) assert.ok(await page.evaluate(() => Number(document.querySelector('[data-story]').style.getPropertyValue('--arrive')) > .98))
      if (p === 0) assert.equal(await page.evaluate(() => Number(document.querySelector('[data-story]').style.getPropertyValue('--seal'))), 0)
      if (screenshots) await page.screenshot({ path: path.join(screenshots, `dark-1440-${name}.png`) })
      await noOverflow(page)
    }
    const stage = await page.locator('[data-stage]').boundingBox()
    await page.mouse.move(stage.x + stage.width * .8, stage.y + stage.height * .45)
    await page.waitForFunction(() => Math.abs(parseFloat(document.querySelector('[data-story]').style.getPropertyValue('--px'))) > .1)
    await page.mouse.move(10, 10)
    await page.waitForFunction(() => parseFloat(document.querySelector('[data-story]').style.getPropertyValue('--px')) === 0)
    results.push('Same DOM message: gather → sealed → reply → reversible; bounded pointer response PASS')

    await page.locator('[data-room] > summary').click()
    await page.waitForFunction(() => document.querySelector('[data-story]').dataset.interacting === 'true')
    const before = await page.locator('[data-conversation]').evaluate(n => getComputedStyle(n).transform)
    await setProgress(page, .5)
    await page.waitForFunction(() => Number(document.querySelector('[data-story]').style.getPropertyValue('--seal')) === 0)
    assert.equal(await page.locator('[data-conversation]').evaluate(n => getComputedStyle(n).transform), before)
    const note = page.locator('#demo-note')
    await note.fill('hello'); await note.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
    assert.equal(await page.locator('[data-demo-message]').count(), 0)
    await note.press('Shift+Enter'); assert.ok((await note.inputValue()).includes('\n'))
    await note.fill('   '); await note.press('Enter'); assert.equal(await page.locator('[data-demo-message]').count(), 0)
    const requests = [], capture = request => requests.push(request.url())
    page.on('request', capture)
    for (let i = 0; i < 10; i++) { await note.fill(i === 0 ? '<img src=x onerror="alert(1)">' : `note ${i}`); await note.press('Enter') }
    page.off('request', capture)
    assert.equal(requests.length, 0, `Demo requests: ${requests.join(', ')}`)
    assert.equal(await page.locator('[data-demo-message]').count(), 16)
    assert.equal(await page.locator('[data-demo-log] img, [data-echo] img').count(), 0)
    await page.locator('[data-demo-reset]').click(); assert.equal(await page.locator('[data-demo-message]').count(), 0)
    assert.equal(await page.locator(':focus').getAttribute('id'), 'demo-note')
    await note.fill('1976'); await note.press('Enter'); assert.match(await page.locator('[data-demo-log]').innerText(), /New Directions in Cryptography/)
    if (screenshots) { await settled(page); await page.screenshot({ path: path.join(screenshots, 'dark-1440-demo.png') }) }
    await note.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-room]').open && !document.querySelector('[data-demo-log]').childElementCount)
    results.push('Stationary interaction, IME, multiline, empty input, HTML literal, cap, no demo requests, reset/focus, 1976 and Escape PASS')

    // Remove focus from the story before measuring its own motion controls.
    await page.getByRole('button', { name: 'Switch to light theme', exact: true }).focus()
    await page.locator('[data-still]').check()
    assert.equal(await page.locator('[data-story]').getAttribute('data-moving'), 'false')
    await page.locator('[data-still]').uncheck()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.waitForFunction(() => document.querySelector('[data-story]').dataset.moving === 'false')
    assert.equal(await page.locator('[data-travelling-message]').evaluate(n => getComputedStyle(n).transform), 'none')
    await settled(page)
    await page.locator('[data-room] > summary').click()
    await note.fill('Accessible too.'); await note.press('Enter')
    assert.equal(await page.locator('[data-demo-message]').count(), 2)
    assert.equal(await page.locator('[data-demo-message]').first().evaluate(n => getComputedStyle(n).animationName), 'none')
    results.push('Still view; live reduced motion; static composer remains usable PASS')
    await context.close()

    // Touch/short viewports stay in document flow, including a keyboard-sized viewport.
    const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const phone = await touch.newPage(); await load(phone)
    assert.equal(await phone.locator('[data-story] > div').evaluate(n => getComputedStyle(n).position), 'relative')
    await phone.locator('[data-room] > summary').click()
    await phone.setViewportSize({ width: 390, height: 380 })
    await phone.locator('#demo-note').fill('From a phone.')
    await phone.getByRole('button', { name: 'Send demo note', exact: true }).click()
    assert.equal(await phone.locator('[data-demo-message]').count(), 2); await noOverflow(phone)
    results.push('Touch + keyboard-sized viewport: unpinned composition, usable send, no overflow PASS')
    await touch.close()

    const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 }, colorScheme: 'dark' })
    const plain = await noJs.newPage(); await load(plain, false)
    await plain.locator('[data-room] > summary').click(); await plain.locator('noscript p').waitFor({ state: 'visible' })
    assert.ok(await plain.locator('#demo-note').isDisabled())
    await plain.getByText('A few things to know', { exact: false }).first().click()
    await plain.getByText('Serotine has not undergone an independent security audit.', { exact: false }).waitFor({ state: 'visible' })
    assert.equal(await plain.locator('[data-arriving-message]').evaluate(n => getComputedStyle(n).clipPath), 'inset(0px 0px 0%)')
    await noOverflow(plain); await noJs.close()
    results.push('No JavaScript: readable full conversation, disabled demo, native disclosures and routes PASS')
    assert.deepEqual(errors, [], 'Browser page errors')
    console.log(JSON.stringify({ mode: fixture ? 'isolated markup/CSS/controller fixture — NOT Next.js or React hydration' : `application at ${url}`, results, browserErrors: errors }, null, 2))
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
