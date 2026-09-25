const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const http = require('node:http')
const { chromium } = require('playwright')

async function run() {
  const directory = path.resolve(__dirname, '../native/web/dist')
  let snapshot = null, writes = 0
  const errors = []
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      const relative = pathname === '/' || pathname.startsWith('/chat') || pathname === '/login' ? 'index.html' : pathname.slice(1)
      const filename = path.resolve(directory, relative)
      if (!filename.startsWith(directory + path.sep)) { response.writeHead(403).end(); return }
      response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' })[path.extname(filename)] || 'application/octet-stream')
      response.end(await fs.readFile(filename))
    } catch { response.writeHead(404).end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  let browser
  async function open(width = 1280) {
    const context = await browser.newContext({ viewport: { width, height: 800 } })
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    await context.exposeFunction('readNativeSnapshot', () => snapshot)
    await context.exposeFunction('writeNativeSnapshot', value => { snapshot = value; writes++ })
    await context.addInitScript(() => {
      window.serotineNative = {
        platform: 'test', getInfo: async () => ({ platform: 'test', version: '0.1.0', relayOrigin: 'https://relay.example.com', backgroundSync: false }),
        readSnapshot: () => window.readNativeSnapshot(), writeSnapshot: ({ value }) => window.writeNativeSnapshot(value),
        request: async () => ({ status: 503, headers: { 'content-type': 'application/json' }, bodyBase64: btoa(JSON.stringify({ success: false, error: 'Offline test relay.' })) }),
        saveFile: async () => ({ saved: true }), openBackup: async () => null, openExternal: async () => {}, onResume: () => () => {},
      }
    })
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(origin)
    return { context, page }
  }
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })
    let { context, page } = await open()
    await page.getByRole('button', { name: 'Create my identity' }).click()
    await page.getByRole('main').getByRole('link', { name: 'Message yourself', exact: true }).waitFor()
    assert(writes > 1 && snapshot.includes('serotine_identity'), 'Created identity must be in native persisted snapshot')
    const publicKey = await page.evaluate(() => JSON.parse(localStorage.getItem('serotine_identity_v2')).publicKey)
    await page.getByRole('main').getByRole('link', { name: 'Message yourself', exact: true }).click()
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Native durable offline smoke')
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByRole('region', { name: 'Conversation messages', exact: true }).getByText('Native durable offline smoke', { exact: true }).waitFor()
    await page.waitForFunction(async () => (await window.readNativeSnapshot())?.includes('Native durable offline smoke'), undefined, { timeout: 10000 })
    assert(snapshot.includes('Native durable offline smoke'), 'Message must be in native snapshot before next process')
    await context.close()
    // New browser context has NO WebView storage: native envelope is authoritative.
    ;({ context, page } = await open(390))
    await page.getByRole('button', { name: 'Open messages', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('serotine_identity_v2')).publicKey), publicKey)
    await page.getByRole('button', { name: 'Open messages', exact: true }).click()
    await page.getByRole('region', { name: 'Conversation messages', exact: true }).getByText('Native durable offline smoke', { exact: true }).waitFor()
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Native narrow layout must fit viewport')
    await context.close()
    const good = snapshot
    snapshot = '{corrupt'
    ;({ context, page } = await open())
    await page.getByRole('heading', { name: 'Serotine could not open its saved data.' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Create my identity' }).count(), 0)
    assert.equal(snapshot, '{corrupt', 'Corrupt native data must never be silently replaced')
    await context.close()
    snapshot = good
    assert.deepEqual(errors, [])
    process.stdout.write('Native renderer smoke passed: identity durability, message persistence, fresh-WebView restore, narrow layout, and corrupt-data fail-closed startup.\n')
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
