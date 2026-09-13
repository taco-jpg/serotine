/* eslint-disable no-console */
/* global SerotineGifFixture */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const port = process.env.SEROTINE_BROWSER_PORT || '3183'
assert.match(port, /^\d+$/)
const origin = `http://127.0.0.1:${port}`
const fakeKey = 'synthetic-runtime-giphy-key'
const fakeSecret = 'synthetic-private-binding-must-not-be-exposed'
const runtimeMode = process.env.SEROTINE_GIPHY_RUNTIME_MODE || 'worker'
assert.ok(['worker', 'production-context'].includes(runtimeMode))
const artifacts = process.env.SEROTINE_BROWSER_ARTIFACTS || fs.mkdtempSync('/tmp/serotine-giphy-runtime-')
fs.mkdirSync(artifacts, { recursive: true })
const environment = { ...process.env, NEXT_PUBLIC_GIPHY_API_KEY: '', NEXT_TELEMETRY_DISABLED: '1', WRANGLER_SEND_METRICS: 'false' }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

function localConfig() {
  return new Promise((resolve, reject) => {
    const request = http.get(`${origin}/api/giphy/config`, response => {
      let body = ''
      response.on('data', chunk => { body += chunk })
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }))
    })
    request.setTimeout(5000, () => request.destroy(new Error('Local runtime request timed out')))
    request.on('error', reject)
  })
}

async function command(script, args, name, extraEnv = {}) {
  const logPath = path.join(artifacts, `${name}.log`), log = fs.openSync(logPath, 'w')
  const child = spawn(process.execPath, [path.join(root, script), ...args], { cwd: root, env: { ...environment, ...extraEnv }, stdio: ['ignore', log, log] })
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    assert.equal(code, 0, `${name} failed: ${logPath}\n${fs.readFileSync(logPath, 'utf8').slice(-4000)}`)
  } finally { fs.closeSync(log) }
}

async function identity() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey'])
  return { version: 2, publicKey: Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('hex'), privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey) }
}

async function main() {
  // Compile without the key, then add it exclusively as a runtime binding.
  // Webpack also supports checkouts whose installed dependencies are symlinked.
  if (process.env.SEROTINE_GIPHY_SKIP_BUILD !== '1') {
    await command('node_modules/next/dist/bin/next', ['build', '--webpack'], 'next-build', { NEXT_PRIVATE_STANDALONE: 'true' })
    if (runtimeMode === 'worker') await command('node_modules/@opennextjs/cloudflare/dist/cli/index.js', ['build', '--skipNextBuild'], 'worker-build')
  }
  const assets = path.join(root, runtimeMode === 'worker' ? '.open-next/assets' : '.next/static')
  for (const filename of fs.readdirSync(assets, { recursive: true })) {
    const fullPath = path.join(assets, filename)
    if (fs.statSync(fullPath).isFile() && /\.(js|html|json)$/.test(filename)) assert.equal(fs.readFileSync(fullPath, 'utf8').includes(fakeKey), false, 'runtime key must not be baked into assets')
  }
  const bundle = (await esbuild.build({ stdin: { contents: 'export * from "./lib/identity"; export * from "./lib/messaging"; export * from "./lib/messaging-store";', resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'SerotineGifFixture', tsconfig: path.join(root, 'tsconfig.json') })).outputFiles[0].text
  const logPath = path.join(artifacts, `${runtimeMode}.log`), log = fs.openSync(logPath, 'w')
  let serverArgs = [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--local', '--ip', '127.0.0.1', '--port', port, '--var', `NEXT_PUBLIC_GIPHY_API_KEY:${fakeKey}`, '--var', `GIPHY_API_KEY:${fakeSecret}`]
  if (runtimeMode === 'production-context') {
    // Portable fallback: exercise the compiled Next route with the same symbol
    // that OpenNext's Worker entrypoint uses, without mocking the route itself.
    const preload = path.join(artifacts, 'runtime-context.cjs')
    fs.writeFileSync(preload, `globalThis[Symbol.for('__cloudflare-context__')] = ${JSON.stringify({ env: { NEXT_PUBLIC_GIPHY_API_KEY: fakeKey, GIPHY_API_KEY: fakeSecret } })}\n`)
    serverArgs = ['--require', preload, path.join(root, 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', port]
  }
  const server = spawn(process.execPath, serverArgs, { cwd: root, env: environment, stdio: ['ignore', log, log] })
  let browser, page, startupError
  server.on('error', error => { startupError = error })
  try {
    let response
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      if (startupError || server.exitCode !== null) throw new Error(`Server failed: ${startupError?.message || fs.readFileSync(logPath, 'utf8').slice(-4000)}`)
      try { response = await localConfig(); if (response.status === 200) break } catch { /* Wait for the local Worker. */ }
      await pause(500)
    }
    assert.equal(response?.status, 200, `Runtime configuration unavailable: ${logPath}`)
    assert.deepEqual(JSON.parse(response.body), { apiKey: fakeKey }, 'the endpoint returns only the public binding')
    assert.match(response.headers['cache-control'], /no-store/)
    assert.equal(response.body.includes(fakeSecret), false)
    console.log(`PASS built without a GIPHY key; ${runtimeMode} returns only runtime public configuration with no-store`)

    browser = await chromium.launch({ executablePath: process.env.SEROTINE_CHROMIUM_PATH, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'], headless: true })
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' })
    const requests = [], unexpected = [], errors = [], configurationRequests = []
    const gif = { id: 'RuntimeFixture1', rating: 'g', title: 'Synthetic runtime GIF', alt_text: 'Synthetic runtime square', username: 'fixture', images: {
      fixed_height: { url: 'https://media.giphy.com/media/RuntimeFixture1/200.gif?fixture=preview', width: '200', height: '200' },
      downsized: { url: 'https://media.giphy.com/media/RuntimeFixture1/giphy.gif?fixture=full', width: '400', height: '400' },
    } }
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url())
      if (url.origin === origin) {
        if (url.pathname === '/api/giphy/config') configurationRequests.push(request.url())
        if (url.pathname === '/__giphy-fixture') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Local GIF fixture</title>' })
        if (url.pathname === '/api/relay') {
          const body = request.postDataJSON() || {}
          let result = { success: true }
          if (body.action === 'event:sync') result = { success: true, messages: [], nextCursor: body.data?.after || 0, hasMore: false }
          if (body.action === 'message:inbox' || body.action === 'message:list') result = { success: true, messages: [], nextCursor: null }
          if (body.action === 'signal:read') result = { success: true, signal: null }
          return route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) })
        }
        return route.continue()
      }
      requests.push({ url: request.url(), headers: request.headers(), body: request.postData() })
      if (url.hostname === 'api.giphy.com') {
        assert.equal(url.searchParams.get('api_key'), fakeKey)
        assert.equal(url.searchParams.get('rating'), 'g')
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: url.pathname.endsWith('/RuntimeFixture1') ? gif : [gif], pagination: { total_count: 1 }, meta: { status: 200 } }) })
      }
      if (url.hostname === 'media.giphy.com') return route.fulfill({ contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAIAAAP8AAP///yH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64') })
      unexpected.push(request.url())
      return route.abort()
    })
    page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    page.setDefaultTimeout(30000)
    const [owner, sender] = await Promise.all([identity(), identity()])
    await page.goto(`${origin}/__giphy-fixture`)
    await page.addScriptTag({ content: bundle })
    await page.evaluate(async ({ owner, sender }) => {
      localStorage.setItem('serotine_identity_v2', JSON.stringify(owner))
      SerotineGifFixture.saveContacts(owner.publicKey, [{ pub: sender.publicKey, alias: 'GIF sender' }])
      const event = await SerotineGifFixture.signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: sender.publicKey, conversationId: owner.publicKey, recipients: [owner.publicKey], timestamp: Date.now() - 1000, kind: 'message', payload: { content: 'https://giphy.com/gifs/RuntimeFixture1' } }, sender)
      await SerotineGifFixture.saveStoredEvent(owner.publicKey, { key: SerotineGifFixture.eventStorageKey(event), event, local: false, delivered: [owner.publicKey], receivedAt: Date.now() })
    }, { owner, sender })
    await page.goto(`${origin}/chat/${sender.publicKey}`)
    const history = page.getByRole('region', { name: 'Conversation messages', exact: true })
    const image = history.getByRole('img', { name: gif.alt_text, exact: true })
    await image.waitFor()
    await image.evaluate(node => node.decode())
    assert.ok(configurationRequests.length > 0, 'the built client gets its key from the real runtime route')
    assert.equal(await history.getByRole('button', { name: 'Load GIF', exact: true }).count(), 0)
    assert.equal(await image.evaluate(node => node.naturalWidth), 1)
    console.log('PASS incoming GIF resolves and renders automatically in the built application')
    await page.getByRole('button', { name: 'More message tools', exact: true }).click()
    await page.getByRole('button', { name: 'Search GIFs', exact: true }).click()
    const picker = page.getByRole('dialog', { name: 'Find a GIF', exact: true })
    await picker.getByRole('textbox', { name: 'Search GIPHY', exact: true }).fill('celebrate')
    await picker.getByRole('button', { name: 'Search', exact: true }).click()
    await picker.getByRole('button', { name: `Choose ${gif.title}`, exact: true }).click()
    assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(), 'https://giphy.com/gifs/RuntimeFixture1')
    assert.equal(await image.count(), 1, 'picker selection stages the GIF without sending it')
    await page.reload()
    await image.waitFor()
    await image.evaluate(node => node.decode())
    await page.screenshot({ path: path.join(artifacts, 'runtime-gif.png'), animations: 'disabled' })
    for (const request of requests) {
      assert.equal(request.headers.referer, undefined)
      assert.equal(request.headers.cookie, undefined)
      assert.equal(request.body, null)
      assert.equal(request.url.includes(owner.publicKey) || request.url.includes(sender.publicKey), false)
    }
    assert.deepEqual(errors, [], 'no browser runtime errors')
    assert.deepEqual(unexpected, [], 'all external traffic is intercepted and restricted to synthetic GIPHY fixtures')
    console.log(`PASS GIF picker, reload and direct-provider request privacy; artifacts: ${artifacts}`)
  } catch (error) {
    if (page && !page.isClosed()) {
      await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {})
      fs.writeFileSync(path.join(artifacts, 'failure.txt'), await page.locator('body').innerText().catch(() => 'Unavailable'))
    }
    throw error
  } finally { await browser?.close(); server.kill('SIGTERM'); fs.closeSync(log) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
