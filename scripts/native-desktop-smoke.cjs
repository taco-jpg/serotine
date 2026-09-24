const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { webcrypto } = require('node:crypto')
const { _electron: electron } = require('playwright')

// This is an actual Electron host/preload test, not a browser bridge stub.
// Run on Windows with the desktop dependencies installed and a development web
// bundle built. All identities, data directories and backup passwords are new
// synthetic fixtures. The only stub disables HTTPS so CI never contacts users.
const root = path.resolve(__dirname, '..')
const desktop = path.join(root, 'native/desktop')
const message = 'Synthetic Windows desktop durability check'
const password = 'Synthetic backup smoke password only'
const errorCodes = new Set(['HOST_INFO', 'STORAGE_READ', 'STORAGE_RESTORE', 'STORAGE_WRITE', 'UI_START', 'STORAGE_RUNTIME'])
let phase = 'SETUP', current, currentPage

function check(condition, code) { assert(condition, `DESKTOP_${phase}_${code}`) }
function progress(value) { phase = value; process.stdout.write(`[desktop-smoke] ${value}\n`) }

async function closeApp({ emergency = false } = {}) {
  if (!current) return
  const active = current
  const stopped = new Promise(resolve => active.process().once('exit', resolve))
  if (emergency) {
    // Failed-test cleanup only. Passing tests must exercise the real renderer and
    // host flush handshake and Chromium's graceful OS-key preference shutdown.
    await active.evaluate(({ app }) => app.exit(1)).catch(() => undefined)
  } else {
    await active.evaluate(({ app, dialog }) => {
      globalThis.__serotineSmokeUnexpectedQuitDialog = false
      dialog.showMessageBox = async (_window, options) => {
        if (options?.title === 'Quit Serotine?' && options.message === 'Quit and go offline?'
          && JSON.stringify(options.buttons) === JSON.stringify(['Keep open', 'Quit'])) {
          return { response: 1, checkboxChecked: false }
        }
        // Never silently choose "Quit anyway" if persistence failed.
        globalThis.__serotineSmokeUnexpectedQuitDialog = true
        return { response: 0, checkboxChecked: false }
      }
      app.quit()
    }).catch(() => undefined)
  }
  let timer
  try {
    const completed = await Promise.race([stopped.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 15000) })])
    if (!completed) {
      const unexpected = !emergency && await active.evaluate(() => globalThis.__serotineSmokeUnexpectedQuitDialog).catch(() => false)
      throw new Error(unexpected ? 'DESKTOP_QUIT_SAVE_FAILURE' : 'DESKTOP_PROCESS_EXIT_TIMEOUT')
    }
  }
  finally { clearTimeout(timer) }
  current = undefined; currentPage = undefined
  await active.close().catch(() => undefined)
}
async function startupDiagnostics() {
  if (!currentPage) return 'NO_WINDOW'
  try {
    return await currentPage.evaluate(async () => {
      const allowed = ['HOST_INFO', 'STORAGE_READ', 'STORAGE_RESTORE', 'STORAGE_WRITE', 'UI_START', 'STORAGE_RUNTIME']
      const stage = document.querySelector('[data-native-error-code]')?.getAttribute('data-native-error-code')
      const safeCode = value => {
        const text = value instanceof Error ? value.message : ''
        if (text.includes('Untrusted native request')) return 'IPC_SENDER_REJECTED'
        if (text.includes('OS-protected storage is unavailable')) return 'OS_PROTECTION_UNAVAILABLE'
        if (text.includes('could not unlock its saved data')) return 'SNAPSHOT_UNLOCK_FAILED'
        if (text.includes('local data is missing or interrupted')) return 'SNAPSHOT_MISSING'
        if (text.includes('No handler registered')) return 'IPC_HANDLER_MISSING'
        return 'HOST_OPERATION_FAILED'
      }
      if (!window.serotineNative) return 'BRIDGE_MISSING'
      let info = 'OK', store = 'OK'
      try { await window.serotineNative.getInfo() } catch (error) { info = safeCode(error) }
      try { await window.serotineNative.readSnapshot() } catch (error) { store = safeCode(error) }
      return `${allowed.includes(stage) ? stage : 'NO_STAGE'};INFO=${info};STORE=${store}`
    })
  } catch { return 'DIAGNOSTICS_UNAVAILABLE' }
}
async function waitForStartup() {
  await currentPage.waitForFunction(() => document.querySelector('[data-native-error-code]')
    || [...document.querySelectorAll('button')].some(button => ['Create my identity', 'Open messages'].includes(button.textContent.trim()))
    || document.querySelector('h1')?.textContent.includes('could not open its saved data'), undefined, { timeout: 30000 })
  const code = await currentPage.evaluate(() => document.querySelector('[data-native-error-code]')?.getAttribute('data-native-error-code') ?? null)
  if (code) throw new Error(`DESKTOP_${phase}_${errorCodes.has(code) ? code : 'UNKNOWN_STARTUP_FAILURE'}`)
  check(await currentPage.getByRole('heading', { name: 'Serotine could not open its saved data.' }).count() === 0, 'STARTUP_FAILED')
}
async function launch(dataHome) {
  await fs.mkdir(dataHome, { recursive: true })
  current = await electron.launch({
    executablePath: require(path.join(desktop, 'node_modules/electron')),
    args: [`--user-data-dir=${path.join(dataHome, 'chromium')}`, desktop],
    env: { ...process.env, LOCALAPPDATA: dataHome, APPDATA: path.join(dataHome, 'roaming') },
    timeout: 40000,
  })
  // Keep the real native bridge, IPC sender checks, safeStorage, filesystem and
  // protocol handler. Only disable Node HTTPS to make the fixture wholly local.
  await current.evaluate(() => {
    const https = process.getBuiltinModule('https')
    https.request = () => { throw new Error('Synthetic desktop smoke is offline.') }
  })
  currentPage = await current.firstWindow({ timeout: 30000 })
  currentPage.setDefaultTimeout(30000)
  await currentPage.context().route('https://**/*', route => route.abort())
  await waitForStartup()
  const actual = await current.evaluate(({ BrowserWindow, safeStorage, app }) => {
    const window = BrowserWindow.getAllWindows()[0]
    const preferences = window.webContents.getLastWebPreferences()
    return { sandbox: preferences.sandbox, isolated: preferences.contextIsolation, node: preferences.nodeIntegration,
      persistent: window.webContents.session.isPersistent(), encryption: safeStorage.isEncryptionAvailable(), userData: app.getPath('userData') }
  })
  check(actual.sandbox && actual.isolated && !actual.node && !actual.persistent, 'HOST_SECURITY_SETTINGS')
  check(actual.encryption, 'OS_PROTECTION_UNAVAILABLE')
  check(path.resolve(actual.userData).startsWith(path.resolve(dataHome) + path.sep), 'DATA_DIRECTORY_NOT_ISOLATED')
  const location = new URL(currentPage.url())
  check(location.protocol === 'serotine:' && location.hostname === 'app', 'CUSTOM_ORIGIN_MISSING')
  check(await currentPage.evaluate(() => typeof window.require === 'undefined' && !!window.serotineNative), 'PRELOAD_ISOLATION')
  return { page: currentPage, snapshotFile: path.join(actual.userData, 'native-v1/snapshot.v1.json') }
}
async function waitForDurableContains(text) {
  await currentPage.waitForFunction(async value => {
    const snapshot = await window.serotineNative.readSnapshot()
    return typeof snapshot === 'string' && snapshot.includes(value)
  }, text, { timeout: 15000 })
}
async function legacyBackup(identity) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16)), iv = webcrypto.getRandomValues(new Uint8Array(12))
  const material = await webcrypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey'])
  const key = await webcrypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 600000 }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
  const ciphertext = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(identity)))
  return Buffer.from(JSON.stringify({ format: 'serotine-backup', version: 2,
    salt: Buffer.from(salt).toString('base64'), iv: Buffer.from(iv).toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64') }))
}
async function run() {
  check(process.platform === 'win32', 'REQUIRES_WINDOWS')
  const config = JSON.parse(await fs.readFile(path.join(root, 'native/web/dist/native-config.json'), 'utf8'))
  check(config.development === true, 'REQUIRES_DEVELOPMENT_BUNDLE')
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'serotine-electron-smoke-'))
  try {
    progress('FRESH_START')
    const first = await launch(path.join(temporary, 'created'))
    let page = first.page
    const snapshotFile = first.snapshotFile
    await page.getByRole('button', { name: 'Create my identity', exact: true }).click()
    await page.getByRole('main').getByRole('link', { name: 'Message yourself', exact: true }).waitFor()
    const identity = await page.evaluate(() => JSON.parse(localStorage.getItem('serotine_identity_v2')))
    check(typeof identity?.publicKey === 'string' && typeof identity?.privateKey?.d === 'string', 'SYNTHETIC_IDENTITY_MISSING')
    await waitForDurableContains(identity.publicKey)
    const backup = await legacyBackup(identity)

    progress('MESSAGE_PERSISTENCE')
    await page.getByRole('main').getByRole('link', { name: 'Message yourself', exact: true }).click()
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill(message)
    await page.getByRole('button', { name: 'Send message', exact: true }).click()
    await page.getByRole('region', { name: 'Conversation messages', exact: true }).getByText(message, { exact: true }).waitFor()
    await waitForDurableContains(message)
    const encrypted = await fs.readFile(snapshotFile, 'utf8'), envelope = JSON.parse(encrypted)
    check(envelope.version === 1 && envelope.protectedKey && envelope.ciphertext, 'ENCRYPTED_ENVELOPE_MISSING')
    check(!encrypted.includes(identity.publicKey) && !encrypted.includes(identity.privateKey.d) && !encrypted.includes(message), 'PLAINTEXT_ON_DISK')
    await closeApp()

    progress('RESTART_RESTORE')
    ;({ page } = await launch(path.join(temporary, 'created')))
    const restored = await page.evaluate(() => JSON.parse(localStorage.getItem('serotine_identity_v2'))?.publicKey)
    check(restored === identity.publicKey, 'ADDRESS_CHANGED')
    await page.getByRole('button', { name: 'Open messages', exact: true }).click()
    await page.waitForFunction(() => location.pathname.startsWith('/chat'))
    const self = page.getByRole('main').getByRole('link', { name: 'Message yourself', exact: true })
    const history = page.getByRole('region', { name: 'Conversation messages', exact: true })
    await Promise.race([self.waitFor(), history.waitFor()])
    if (await self.count()) await self.click()
    await page.getByRole('region', { name: 'Conversation messages', exact: true }).getByText(message, { exact: true }).waitFor()
    await closeApp()

    progress('OLD_BACKUP_IMPORT')
    ;({ page } = await launch(path.join(temporary, 'imported')))
    await page.getByRole('button', { name: 'I have a backup', exact: true }).click()
    await page.getByLabel('Serotine backup', { exact: true }).setInputFiles({ name: 'synthetic-legacy-identity.json', mimeType: 'application/json', buffer: backup })
    await page.getByLabel('Backup password', { exact: true }).fill('Deliberately wrong fixture password')
    await page.getByRole('button', { name: 'Restore backup', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'The backup password is incorrect, or the file is damaged.' }).waitFor()
    check(await page.evaluate(() => localStorage.getItem('serotine_identity_v2') === null), 'WRONG_PASSWORD_CHANGED_IDENTITY')
    await page.getByLabel('Backup password', { exact: true }).fill(password)
    await page.getByRole('button', { name: 'Restore backup', exact: true }).click()
    await page.getByRole('main').getByRole('link', { name: 'Message yourself', exact: true }).waitFor()
    check(await page.evaluate(() => JSON.parse(localStorage.getItem('serotine_identity_v2'))?.publicKey) === identity.publicKey, 'BACKUP_ADDRESS_CHANGED')
    await waitForDurableContains(identity.publicKey)
    await closeApp()

    progress('IMPORTED_RESTART')
    ;({ page } = await launch(path.join(temporary, 'imported')))
    check(await page.evaluate(() => JSON.parse(localStorage.getItem('serotine_identity_v2'))?.publicKey) === identity.publicKey, 'IMPORTED_ADDRESS_CHANGED')
    await page.getByRole('button', { name: 'Open messages', exact: true }).waitFor()
    await closeApp()
    progress('PASSED')
    process.stdout.write('Actual Windows Electron startup, native IPC, encrypted persistence, restart and old-backup import passed.\n')
  } catch (error) {
    const assertion = /^DESKTOP_[A-Z_]+$/.test(error?.message ?? '') ? `;${error.message}` : ''
    process.stderr.write(`Desktop smoke failed at ${phase}: ${await startupDiagnostics()}${assertion}\n`)
    process.exitCode = 1
  } finally {
    await closeApp({ emergency: true }).catch(() => undefined)
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })
  }
}
run().catch(() => { process.stderr.write(`Desktop smoke could not run: ${phase}. Requires Windows, installed Electron and a bundled development client.\n`); process.exitCode = 1 })
