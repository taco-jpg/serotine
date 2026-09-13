// Run against an already-running app: node scripts/landing-smoke.cjs
// Optional: SEROTINE_LANDING_URL, SEROTINE_CHROMIUM_PATH,
// SEROTINE_LANDING_SCREENSHOTS (directory), or SEROTINE_LANDING_HTML
// (an isolated, pre-rendered fixture; explicitly reported as NOT a Next.js test).
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const { chromium } = require("playwright")

async function main() {
  const htmlPath = process.env.SEROTINE_LANDING_HTML
  const html = htmlPath ? fs.readFileSync(htmlPath, "utf8") : null
  const url = process.env.SEROTINE_LANDING_URL || "http://localhost:3000"
  const screenshotDir = process.env.SEROTINE_LANDING_SCREENSHOTS
  if (screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true })
  const browser = await chromium.launch({ executablePath: process.env.SEROTINE_CHROMIUM_PATH || undefined })
  const errors = []
  const results = []
  const load = async page => {
    page.on("pageerror", error => errors.push(error.message))
    if (html !== null) await page.setContent(html, { waitUntil: "load" })
    else await page.goto(url, { waitUntil: "domcontentloaded" })
    await page.locator("#hero-title").waitFor()
  }
  try {
    for (const width of [320, 390, 768, 1024, 1440, 1920]) {
      const context = await browser.newContext({ viewport: { width, height: 900 } })
      const page = await context.newPage()
      await load(page)
      assert.equal(await page.locator("h1").count(), 1)
      assert.equal(await page.locator('a[href="/login"]').count(), 4)
      const overflow = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }))
      assert.ok(overflow.document <= overflow.viewport + 1, `Horizontal overflow at ${width}: ${JSON.stringify(overflow)}`)
      const clippedText = await page.locator("h1, h2, h3, p, summary").evaluateAll(nodes => nodes.filter(node => {
        const r = node.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && (r.left < -1 || r.right > innerWidth + 1)
      }).map(node => node.textContent.slice(0, 70)))
      assert.deepEqual(clippedText, [], `Clipped text at ${width}`)
      if (screenshotDir && [390, 1440].includes(width)) {
        await page.locator('label[for="pause-signal"]').click()
        await page.screenshot({ path: path.join(screenshotDir, `landing-${width}.png`), fullPage: true })
      }
      results.push(`Layout ${width}px: PASS`)
      await context.close()
    }
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    const page = await context.newPage()
    await load(page)
    await page.keyboard.press("Tab")
    assert.equal(await page.locator(":focus").innerText(), "Skip to content")
    await page.locator('summary').filter({ hasText: "Reveal the example" }).click()
    assert.ok(await page.getByText("Hello, friend. Just between us.").isVisible())
    const history = page.locator("details").filter({ has: page.locator("summary").filter({ hasText: "1976" }) })
    await history.locator("summary").focus()
    await page.keyboard.press("Enter")
    assert.ok(await history.getAttribute("open") !== null)
    assert.ok(await page.getByText("Read the original paper").isVisible())
    await page.locator("#pause-signal").focus()
    await page.keyboard.press("Space")
    assert.ok(await page.locator("#pause-signal").isChecked())
    assert.ok(await page.evaluate(() => document.getAnimations().filter(a => a instanceof CSSAnimation).every(a => a.playState === "paused")))
    await page.keyboard.press("Space")
    assert.ok(!(await page.locator("#pause-signal").isChecked()))
    assert.ok(await page.evaluate(() => document.getAnimations().filter(a => a instanceof CSSAnimation).some(a => a.playState === "running")))
    results.push("Keyboard navigation, history/reveal, pause/resume: PASS")
    await page.emulateMedia({ reducedMotion: "reduce" })
    assert.ok(await page.getByText("Reduced motion is enabled").isVisible())
    assert.ok(!(await page.locator("#pause-signal").isVisible()))
    assert.equal(await page.evaluate(() => document.getAnimations().filter(a => a instanceof CSSAnimation).length), 0)
    results.push("Reduced motion: PASS")
    await context.close()
    const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } })
    const plain = await noJs.newPage()
    await load(plain)
    await plain.locator("summary").filter({ hasText: "Reveal the example" }).click()
    assert.ok(await plain.getByText("Hello, friend. Just between us.").isVisible())
    const pgp = plain.locator("details").filter({ has: plain.locator("summary").filter({ hasText: "1991" }) })
    await pgp.locator("summary").click()
    assert.ok(await pgp.getByText("Read Zimmermann’s official biography").isVisible())
    await plain.locator('label[for="pause-signal"]').click()
    assert.ok(await plain.locator("#pause-signal").isChecked())
    results.push("JavaScript disabled: reveal, history, motion control PASS")
    await noJs.close()
    assert.deepEqual(errors, [], "Browser page errors")
    console.log(JSON.stringify({ mode: htmlPath ? "isolated HTML fixture — NOT full Next.js integration" : `application at ${url}`, results, browserErrors: errors }, null, 2))
  } finally { await browser.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
