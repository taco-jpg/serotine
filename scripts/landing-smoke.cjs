// npm run dev, then node scripts/landing-smoke.cjs
// Optional: SEROTINE_LANDING_URL, SEROTINE_CHROMIUM_PATH,
// SEROTINE_LANDING_SCREENSHOTS, SEROTINE_LANDING_HTML (self-contained isolated
// fixture, explicitly NOT a Next.js / React hydration or provider test).
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { chromium } = require("playwright")

async function main() {
  const htmlPath = process.env.SEROTINE_LANDING_HTML
  const html = htmlPath ? fs.readFileSync(htmlPath, "utf8") : null
  const url = process.env.SEROTINE_LANDING_URL || "http://localhost:3000"
  const screenshots = process.env.SEROTINE_LANDING_SCREENSHOTS
  if (screenshots) fs.mkdirSync(screenshots, { recursive: true })
  const browser = await chromium.launch({ executablePath: process.env.SEROTINE_CHROMIUM_PATH || undefined })
  const errors = [], results = []
  const load = async (page, enhanced = true) => {
    page.on("pageerror", error => errors.push(error.message))
    if (html !== null) await page.setContent(html, { waitUntil: "load" })
    else await page.goto(url, { waitUntil: "domcontentloaded" })
    await page.locator("#hero-title").waitFor()
    if (enhanced) await page.locator('#serotine-landing[data-enhanced="true"]').waitFor()
  }
  const noOverflow = async page => {
    const sizes = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth }))
    assert.ok(sizes.document <= sizes.viewport + 1, JSON.stringify(sizes))
  }
  try {
    for (const theme of ["light", "dark"]) for (const width of [320, 390, 640, 768, 1024, 1440, 1920]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme })
      const page = await context.newPage()
      await load(page)
      await noOverflow(page)
      assert.equal(await page.locator("h1").count(), 1)
      assert.ok(await page.locator('a[href="/login"]').count() >= 2)
      const background = await page.locator("#serotine-landing").evaluate(node => getComputedStyle(node).backgroundColor)
      assert.equal(background, theme === "dark" ? "rgb(32, 30, 35)" : "rgb(246, 244, 239)")
      await page.locator('[data-room] > summary').click()
      await page.locator('#demo-note').fill("A small thought.")
      await page.getByRole("button", { name: "Send demo note", exact: true }).click()
      assert.equal(await page.locator('[data-demo-message]').count(), 2)
      await noOverflow(page)
      await page.locator('[data-room] > summary').click()
      await page.waitForFunction(() => document.querySelector('[data-demo-log]').childElementCount === 0)
      if (screenshots && [390, 1440].includes(width)) {
        await page.locator('[data-still]').check()
        await page.evaluate(() => window.scrollTo(0, 0))
        await page.screenshot({ path: path.join(screenshots, `landing-${theme}-${width}-still.png`), fullPage: true })
      }
      results.push(`${theme} ${width}px: layout, demo and reset PASS`)
      await context.close()
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "light" })
    const page = await context.newPage()
    await load(page)
    await page.keyboard.press("Tab")
    assert.equal(await page.locator(":focus").innerText(), "Skip to content")
    await page.keyboard.press("Enter")
    assert.equal(await page.locator(":focus").getAttribute("id"), "main")
    const toggle = page.getByRole("button", { name: "Switch to dark theme", exact: true })
    const saved = html === null ? await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key !== "theme"))) : null
    await toggle.click()
    assert.ok(await page.getByRole("button", { name: "Switch to light theme", exact: true }).isVisible())
    if (saved) assert.deepEqual(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key !== "theme"))), saved)
    results.push(html === null ? "Keyboard skip link; theme provider; non-mode stored preferences preserved: PASS" : "Keyboard skip link; isolated theme presentation only: PASS")

    // The same object changes representation as the viewport moves; no timer loop.
    await page.evaluate(() => { const s = document.querySelector('[data-story]'); const top = s.getBoundingClientRect().top + scrollY; scrollTo(0, top + (s.offsetHeight - innerHeight) * .38) })
    await page.waitForFunction(() => Number(document.querySelector('[data-story]').style.getPropertyValue('--sealed')) > .95)
    await page.evaluate(() => { const s = document.querySelector('[data-story]'); const top = s.getBoundingClientRect().top + scrollY; scrollTo(0, top + (s.offsetHeight - innerHeight) * .9) })
    await page.waitForFunction(() => Number(document.querySelector('[data-story]').style.getPropertyValue('--reply')) > .95)
    await page.locator('[data-still]').check()
    assert.equal(await page.locator('[data-story]').getAttribute('data-moving'), "false")
    await page.locator('[data-still]').uncheck()
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.waitForFunction(() => document.querySelector('[data-story]').dataset.moving === "false")
    // Chromium can retain deferred transitions inside a closed <details> even
    // after their computed transition is none; verify painted content and CSS.
    await page.waitForFunction(() => document.getAnimations().filter(animation => animation.effect?.target?.getClientRects().length).length === 0)
    assert.equal(await page.locator('[data-demo-reset]').evaluate(node => getComputedStyle(node).transitionDuration), "0s")
    results.push("Scroll representation, still view and live reduced-motion change: PASS")

    await page.locator('[data-room] > summary').focus()
    await page.keyboard.press("Enter")
    const note = page.locator('#demo-note')
    await note.fill('hello')
    await note.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
    assert.equal(await page.locator('[data-demo-message]').count(), 0)
    await note.press('Shift+Enter')
    assert.ok((await note.inputValue()).includes('\n'))
    await note.fill('   '); await note.press('Enter')
    assert.equal(await page.locator('[data-demo-message]').count(), 0)
    const requests = []
    const capture = request => requests.push(request.url())
    page.on('request', capture)
    for (let i = 0; i < 10; i++) { await note.fill(i === 0 ? '<img src=x onerror="alert(1)">' : `note ${i}`); await note.press('Enter') }
    page.off('request', capture)
    assert.equal(await page.locator('[data-demo-message]').count(), 16)
    assert.equal(await page.locator('[data-demo-log] img, [data-demo-log] script').count(), 0)
    assert.equal(requests.length, 0, `Unexpected demo requests: ${requests.join(', ')}`)
    await page.locator('[data-demo-reset]').click()
    assert.equal(await page.locator('[data-demo-message]').count(), 0)
    assert.equal(await page.locator(':focus').getAttribute('id'), 'demo-note')
    await note.fill('1976'); await note.press('Enter')
    assert.match(await page.locator('[data-demo-log]').innerText(), /New Directions in Cryptography/)
    results.push("IME, multiline, empty input, literal HTML, cap, deterministic easter egg, reset/focus and network silence: PASS")
    await context.close()

    const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 }, colorScheme: "dark" })
    const plain = await noJs.newPage(); await load(plain, false)
    await plain.locator('[data-room] > summary').click()
    await plain.locator('noscript p').waitFor({ state: 'visible' })
    assert.ok(await plain.locator('#demo-note').isDisabled())
    await plain.getByText('A few things to know', { exact: false }).first().click()
    await plain.getByText('Serotine has not undergone an independent security audit.', { exact: false }).waitFor({ state: 'visible' })
    await noOverflow(plain)
    results.push("No JavaScript: native disclosures, disabled demo, complete story and app links: PASS")
    await noJs.close()
    assert.deepEqual(errors, [], "Browser page errors")
    console.log(JSON.stringify({ mode: htmlPath ? "isolated fixture — NOT Next.js integration or React hydration" : `application at ${url}`, results, browserErrors: errors }, null, 2))
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
