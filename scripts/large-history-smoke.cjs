/* Real browser check for text sends with large retained attachments. */
/* global Fixture */
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'))
const { chromium } = require(path.join(root, 'node_modules/playwright'))
const esbuild = require(path.join(root, 'node_modules/esbuild'))
const output = process.env.PERF_OUTPUT || '/tmp/serotine-large-history'
const port = Number(process.env.PERF_PORT || 3147)
const origin = `http://127.0.0.1:${port}`
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
fs.mkdirSync(output, { recursive: true })

async function run() {
  const log = fs.openSync(path.join(output, 'server.log'), 'w')
  // Use the shipping React runtime: development debug stacks otherwise dominate
  // the timing and obscure the retained-file work this regression checks.
  const mode = process.env.PERF_PRODUCTION === '0' ? ['dev', '--webpack'] : ['start']
  const server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), ...mode, '--hostname', '127.0.0.1', '--port', String(port)], { cwd: root, stdio: ['ignore', log, log] })
  let browser
  try {
    let ready = false
    for (let i = 0; i < 180; i++) {
      if (server.exitCode !== null) throw new Error(fs.readFileSync(path.join(output, 'server.log'), 'utf8'))
      try { if ((await fetch(origin)).ok) { ready = true; break } } catch { /* Server compiling. */ }
      await pause(500)
    }
    assert(ready, 'browser test server starts')
    const bundle = (await esbuild.build({ stdin: { contents: 'export * from "./lib/messaging"; export * from "./lib/messaging-store"; export * from "./lib/identity"; export * from "./lib/community-protocol"; export * from "./lib/attachments";', resolveDir: root }, bundle: true, write: false, platform: 'browser', format: 'iife', globalName: 'Fixture', tsconfig: path.join(root, 'tsconfig.json') })).outputFiles[0].text
    const executablePath = process.env.CHROMIUM_PATH || (fs.existsSync('/tmp/serotine-visual-browser/chromium') ? '/tmp/serotine-visual-browser/chromium' : undefined)
    browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const errors = []
    await context.route('**/api/relay**', async route => {
      const request = route.request(), data = request.postDataJSON() || {}
      if (data.action === 'event:send') await pause(150)
      const body = data.action === 'event:sync' ? { success: true, messages: [], nextCursor: data.data?.after || 0, hasMore: false }
        : ['message:inbox', 'message:list'].includes(data.action) ? { success: true, messages: [], nextCursor: null }
        : data.action === 'signal:read' ? { success: true, signal: null } : { success: true }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    })
    await context.addInitScript(() => {
      window.__perf = { eventGetAll: 0, eventGet: 0, blobs: 0 }
      const all = IDBObjectStore.prototype.getAll, get = IDBObjectStore.prototype.get
      IDBObjectStore.prototype.getAll = function (...args) { if (this.name === 'events') window.__perf.eventGetAll++; return all.apply(this, args) }
      IDBObjectStore.prototype.get = function (...args) { if (this.name === 'events') window.__perf.eventGet++; return get.apply(this, args) }
      const blob = URL.createObjectURL
      URL.createObjectURL = function (...args) { window.__perf.blobs++; return blob.apply(this, args) }
    })
    const page = await context.newPage()
    page.setDefaultTimeout(45000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(origin + '/login')
    await page.addScriptTag({ content: bundle })
    const fixture = await page.evaluate(async () => {
      async function identity() {
        const keys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey'])
        return { version: 2, publicKey: Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)), n => n.toString(16).padStart(2, '0')).join(''), privateKey: await crypto.subtle.exportKey('jwk', keys.privateKey) }
      }
      const owner = await identity(), peer = await identity()
      const records = [], now = Date.now() - 120000
      let sequence = 0
      async function save(cid, kind, payload, group) {
        const timestamp = now + sequence++
        const event = await Fixture.signMessagingEvent({ version: 3, id: crypto.randomUUID(), author: owner.publicKey, conversationId: cid, recipients: [peer.publicKey], kind, payload, timestamp, ...(group ? { group } : {}) }, owner)
        records.push({ key: Fixture.eventStorageKey(event), event, local: true, delivered: [peer.publicKey], receivedAt: timestamp })
        return event.id
      }
      const group = await Fixture.signGroup({ id: 'group:' + crypto.randomUUID(), name: 'Large group', admin: owner.publicKey, members: [owner.publicKey, peer.publicKey], epoch: 1, updatedAt: now }, owner)
      const background = await Fixture.signGroup({ ...group, id: 'group:' + crypto.randomUUID(), name: 'Background history' }, owner)
      await save(group.id, 'group', {}, group); await save(background.id, 'group', {}, background)
      const cid = 'community:' + owner.publicKey + ':' + crypto.randomUUID(), channel = crypto.randomUUID()
      const state = await Fixture.signCommunityState({ version: 2, id: cid, owner: owner.publicKey, signer: owner.publicKey, name: 'Large community', description: '', epoch: 1, updatedAt: now, members: [owner.publicKey, peer.publicKey], moderators: [], coOwners: [], transfers: [], deleted: false, bans: [], admission: 'direct', joiningPaused: false, inviteGeneration: 1, channels: [{ id: channel, name: 'general', posting: 'members' }] }, owner)
      await save(cid, 'community', { community: { type: 'state', state } })
      const ref = Fixture.communityStateReference(state)
      for (let i = 0; i < 50; i++) {
        await save(group.id, 'message', { content: 'Retained group note ' + i }, group)
        await save(cid, 'community', { community: { type: 'message', epoch: 1, channelId: channel, content: 'Retained community note ' + i, ...ref } })
      }
      // A valid small GIF with trailing bytes gives realistic stored-file size
      // without measuring the complexity of an unrelated animation decoder.
      const bytes = new Uint8Array(Math.round(14.6 * 1024 * 1024))
      for (let offset = 0; offset < bytes.length; offset += 65536) crypto.getRandomValues(bytes.subarray(offset, Math.min(bytes.length, offset + 65536)))
      bytes.set(Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), value => value.charCodeAt(0)))
      const { metadata, chunks } = await Fixture.prepareAttachment(new File([bytes], 'large-history.gif', { type: 'image/gif' }))
      for (const target of [group, null, background]) {
        const attachment = { ...metadata, id: crypto.randomUUID() }
        for (const chunk of chunks) {
          if (target) await save(target.id, 'attachment-chunk', { attachmentId: attachment.id, ...chunk }, target)
          else await save(cid, 'community', { community: { type: 'attachment-chunk', epoch: 1, channelId: channel, attachmentId: attachment.id, ...chunk, ...ref } })
        }
        if (target) await save(target.id, 'attachment', { attachment, content: 'Large retained attachment' }, target)
        else await save(cid, 'community', { community: { type: 'attachment', epoch: 1, channelId: channel, attachment, content: 'Large retained attachment', ...ref } })
      }
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('serotine-events:' + owner.publicKey, 1)
        request.onupgradeneeded = () => { request.result.createObjectStore('events', { keyPath: 'key' }); request.result.createObjectStore('metadata') }
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      const tx = db.transaction(['events', 'metadata'], 'readwrite')
      for (const record of records) tx.objectStore('events').put(record)
      tx.objectStore('metadata').put(Fixture.defaultMessagingPreferences(), 'preferences')
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onabort = () => reject(tx.error) }); db.close()
      localStorage.setItem('serotine_identity_v2', JSON.stringify(owner))
      Fixture.saveContacts(owner.publicKey, [{ pub: peer.publicKey, alias: 'Cameron' }])
      return { owner: owner.publicKey, group: group.id, community: cid, channel, records: records.length, retainedMiB: bytes.length * 3 / 1024 / 1024 }
    })
    console.warn('Prepared retained history', JSON.stringify({ records: fixture.records, retainedMiB: fixture.retainedMiB }))
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.PERF_CPU_RATE || 4) })
    const samples = []
    for (const kind of process.env.PERF_KIND ? [process.env.PERF_KIND] : ['group', 'community']) {
      const href = kind === 'group' ? '/chat/' + encodeURIComponent(fixture.group) : '/chat/communities#' + new URLSearchParams({ id: fixture.community, channel: fixture.channel })
      await page.goto(origin + href)
      const input = kind === 'group' ? page.getByRole('textbox', { name: 'Message', exact: true }) : page.getByRole('textbox', { name: 'Message general', exact: true })
      await input.waitFor()
      await page.getByRole('img', { name: 'large-history.gif', exact: true }).first().waitFor()
      console.warn('Opened', kind)
      for (let i = 0; i < Number(process.env.PERF_SAMPLES || 3); i++) {
        const text = `${kind} performance message ${i}`
        await input.fill(text)
        const before = await page.evaluate(() => ({ ...window.__perf }))
        if (process.env.PERF_PROFILE === '1') { await cdp.send('Profiler.enable'); await cdp.send('Profiler.start') }
        const start = performance.now()
        await input.press('Enter')
        await page.waitForFunction(() => { const node = document.querySelector('textarea'); return node && node.value === '' && !node.readOnly })
        await page.getByText(text, { exact: true }).last().waitFor()
        const ms = performance.now() - start
        if (process.env.PERF_PROFILE === '1') fs.writeFileSync(path.join(output, `${kind}-${i}.cpuprofile`), JSON.stringify((await cdp.send('Profiler.stop')).profile))
        const after = await page.evaluate(() => ({ ...window.__perf }))
        samples.push({ kind, ms: Math.round(ms), eventGetAll: after.eventGetAll - before.eventGetAll, eventGet: after.eventGet - before.eventGet, blobs: after.blobs - before.blobs })
        console.warn('Measured', JSON.stringify(samples.at(-1)))
      }
      await page.screenshot({ path: path.join(output, kind + '.png') })
      if (process.env.FORMAT_CHECK === '1') {
        const history = kind === 'community' ? page.getByRole('region', { name: 'Channel messages', exact: true }) : page.getByRole('region', { name: 'Conversation messages', exact: true })
        const price = "No, it doesn't cost $4; it costs $5."
        await input.fill(price); await input.press('Enter')
        await page.waitForFunction(() => document.querySelector('textarea')?.value === '')
        await history.getByText(price, { exact: true }).waitFor()
        assert.equal(await history.locator('.katex').count(), 0, 'currency does not become math')
        await page.getByRole('button', { name: 'More message tools', exact: true }).click()
        await page.getByRole('button', { name: 'Math', exact: true }).click()
        const dialog = page.getByRole('dialog'), preview = dialog.getByRole('region', { name: 'Formatting preview', exact: true })
        await dialog.getByRole('textbox', { name: 'LaTeX formula', exact: true }).fill('\\frac{x^2}{2}')
        await preview.locator('.katex').waitFor()
        await dialog.getByRole('textbox', { name: 'LaTeX formula', exact: true }).fill('\\frac{')
        await preview.getByRole('status').filter({ hasText: 'LaTeX error:' }).waitFor()
        await dialog.getByRole('textbox', { name: 'LaTeX formula', exact: true }).fill('\\frac{x^2}{2}')
        await preview.locator('.katex').waitFor()
        await dialog.getByRole('button', { name: 'Insert math', exact: true }).click()
        await page.getByRole('region', { name: 'Message preview', exact: true }).locator('.katex').waitFor()
        assert.notEqual(await input.inputValue(), '', 'inserting math does not send it')
        await input.press('Enter'); await history.locator('.katex').waitFor()
        await page.waitForFunction(() => document.querySelector('textarea')?.value === '')
        await page.getByRole('button', { name: 'Code', exact: true }).click()
        const source = 'const price = "$4";\nconsole.log("<script>");\n```'
        await dialog.getByRole('textbox', { name: 'Code', exact: true }).fill(source)
        await dialog.getByRole('textbox', { name: 'Language (optional)', exact: true }).fill('javascript')
        assert.equal(await preview.locator('pre code').innerText(), source)
        assert.equal(await preview.locator('script').count(), 0)
        await dialog.getByRole('button', { name: 'Insert code', exact: true }).click()
        await input.press('Enter'); await history.locator('pre code').filter({ hasText: 'const price' }).waitFor()
        await page.waitForFunction(() => document.querySelector('textarea')?.value === '')
        assert.equal(await history.locator('pre code').filter({ hasText: 'const price' }).innerText(), source)
        if (kind === 'community') {
          await page.setViewportSize({ width: 390, height: 844 })
          await page.getByRole('button', { name: 'Math', exact: true }).click()
          await dialog.getByRole('textbox', { name: 'LaTeX formula', exact: true }).fill('x^2+y^2=z^2')
          await preview.locator('.katex').waitFor()
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
          await page.screenshot({ path: path.join(output, 'math-mobile.png') })
          await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
          await page.setViewportSize({ width: 1440, height: 900 })
        }
        console.warn('Verified formatting controls', kind)
      }
    }
    assert.deepEqual(errors, [], 'no uncaught browser errors')
    fs.writeFileSync(path.join(output, 'metrics.json'), JSON.stringify({ fixture, cpuRate: Number(process.env.PERF_CPU_RATE || 4), samples, errors }, null, 2))
    console.warn(JSON.stringify({ fixture, samples }, null, 2))
    if (process.env.PERF_ASSERT !== '0') {
      assert(samples.every(sample => sample.ms < 1500), 'text send becomes editable within 1.5s under fourfold CPU throttling')
      assert(samples.every(sample => sample.eventGetAll === 0), 'text sends do not reload the full retained event history')
      assert(samples.every(sample => sample.blobs === 0), 'text sends do not recreate unchanged attachment object URLs')
    }
  } finally { if (browser) await browser.close(); server.kill('SIGTERM'); fs.closeSync(log) }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
