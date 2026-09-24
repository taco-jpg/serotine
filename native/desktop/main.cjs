const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, safeStorage, session, shell, powerMonitor, systemPreferences } = require('electron')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { randomUUID } = require('node:crypto')
const { EncryptedStore } = require('./encrypted-store.cjs')
const { relayRequest } = require('./transport.cjs')
const { APP_URL, RELEASE_URL, MAX_FILE_BYTES, trustedURL, assertSender, validateConfig, decodeBase64, externalURL, safeFilename, validateReset, bundlePath, object } = require('./security.cjs')

protocol.registerSchemesAsPrivileged([{ scheme: 'serotine', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
app.enableSandbox()
const bundleRoot = app.isPackaged ? path.join(__dirname, 'web') : path.resolve(__dirname, '../web/dist')
let config
try { config = validateConfig(JSON.parse(fsSync.readFileSync(path.join(bundleRoot, 'native-config.json'), 'utf8'))) }
catch { app.whenReady().then(() => { dialog.showErrorBox('Serotine could not start', 'Build the bundled native client with an explicit HTTPS relay before launching the desktop app.'); app.quit() }) }

if (config) {
  const product = config.development ? 'Serotine Dev' : 'Serotine'
  app.setName(product)
  app.setAppUserModelId(config.development ? 'app.serotine.client.dev' : 'app.serotine.client')
  // Use LocalAppData on Windows, never the roaming profile. macOS data receives a backup exclusion below.
  const dataRoot = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'), product)
    : path.join(app.getPath('appData'), product)
  app.setPath('userData', dataRoot)
  const store = new EncryptedStore(path.join(dataRoot, 'native-v1'), safeStorage)
  let window, quitting = false, quitDialog = false
  let relayStarted = false, recoveryResetPending = false
  const grants = new Set()
  let pendingQuit
  ipcMain.on('serotine:quit-ready', (event, value) => {
    try { assertSender(event, window) } catch { return }
    if (object(value) && pendingQuit && value.id === pendingQuit.id && typeof value.success === 'boolean') pendingQuit.resolve(value.success)
  })
  async function prepareQuit() {
    const id = randomUUID()
    const saved = await new Promise(resolve => {
      const timeout = setTimeout(() => { pendingQuit = undefined; resolve(false) }, 8000)
      pendingQuit = { id, resolve: value => { clearTimeout(timeout); pendingQuit = undefined; resolve(value) } }
      window.webContents.send('serotine:prepare-quit', id)
    })
    if (!saved) {
      const answer = await dialog.showMessageBox(window, { type: 'warning', title: 'Saving did not finish', message: 'Some recent changes may not be saved.',
        detail: 'Keep the app open to recover or export your data. Quitting now can lose recent changes.', buttons: ['Keep open', 'Quit anyway'], defaultId: 0, cancelId: 0 })
      if (answer.response !== 1) return false
    }
    await store.flush()
    return true
  }

  async function openLink(url, confirm = true) {
    const safe = externalURL(url)
    if (confirm) {
      const answer = await dialog.showMessageBox(window, { type: 'question', title: 'Open in your browser?',
        message: new URL(safe).hostname, detail: 'This link opens outside Serotine.', buttons: ['Cancel', 'Open browser'], defaultId: 0, cancelId: 0 })
      if (answer.response !== 1) return
    }
    await shell.openExternal(safe)
  }
  async function quit() {
    if (quitting || quitDialog) return
    quitDialog = true
    const answer = await dialog.showMessageBox(window, { type: 'question', title: 'Quit Serotine?',
      message: 'Quit and go offline?', detail: 'Calls and transfers stop when Serotine quits. Messages synchronize again when you reopen it.',
      buttons: ['Keep open', 'Quit'], defaultId: 0, cancelId: 0 })
    if (answer.response !== 1) { quitDialog = false; return }
    if (!await prepareQuit()) { quitDialog = false; return }
    quitDialog = false
    quitting = true; app.quit()
  }
  app.on('before-quit', event => { if (!quitting && window && !window.isDestroyed()) { event.preventDefault(); void quit() } })
  app.on('window-all-closed', () => { quitting = true; app.quit() })
  if (!app.requestSingleInstanceLock()) { quitting = true; app.quit() }
  else {
    app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus() } })
    app.on('web-contents-created', (_event, contents) => {
      contents.on('will-attach-webview', event => event.preventDefault())
      contents.setWindowOpenHandler(({ url }) => { void openLink(url).catch(() => undefined); return { action: 'deny' } })
      contents.on('will-navigate', event => {
        if (!trustedURL(event.url)) { event.preventDefault(); void openLink(event.url).catch(() => undefined) }
      })
      contents.on('will-frame-navigate', event => {
        if (!event.isMainFrame || !trustedURL(event.url)) {
          event.preventDefault()
          if (event.isMainFrame) void openLink(event.url).catch(() => undefined)
        }
      })
    })

    app.whenReady().then(async () => {
      await fs.mkdir(store.directory, { recursive: true, mode: 0o700 })
      if (process.platform === 'darwin') {
        // No user-controlled executable, arguments, or paths are accepted by this operation.
        await promisify(execFile)('/usr/bin/tmutil', ['addexclusion', '-p', dataRoot])
      }
      const browser = session.fromPartition('serotine-ephemeral')
      browser.setPermissionCheckHandler((contents, permission, origin, details) => {
        if ((contents !== window?.webContents && !(contents === null && permission === 'notifications'))
          || !trustedURL(origin) || details.isMainFrame === false || (details.requestingUrl && !trustedURL(details.requestingUrl))) return false
        return permission === 'media' ? grants.has(`media:${details.mediaType}`) : grants.has(permission)
      })
      browser.setPermissionRequestHandler((contents, permission, callback, details) => {
        if (contents !== window?.webContents || !trustedURL(contents.getURL()) || details.isMainFrame === false
          || (details.requestingUrl && !trustedURL(details.requestingUrl)) || !['media', 'notifications', 'clipboard-sanitized-write'].includes(permission)) {
          callback(false); return
        }
        void (async () => {
          const mediaTypes = permission === 'media' ? details.mediaTypes : []
          if (permission === 'media' && (!Array.isArray(mediaTypes) || !mediaTypes.length || mediaTypes.some(type => !['audio', 'video'].includes(type)))) {
            callback(false); return
          }
          const names = permission === 'notifications' ? 'notifications' : permission === 'clipboard-sanitized-write'
            ? 'copying text to the clipboard' : mediaTypes.map(type => type === 'video' ? 'camera' : 'microphone').join(' and ')
          const answer = await dialog.showMessageBox(window, { type: 'question', title: 'Serotine permission', message: `Allow ${names}?`,
            detail: 'You can keep chatting if you choose Not now.', buttons: ['Not now', 'Allow'], defaultId: 0, cancelId: 0 })
          if (answer.response !== 1) { callback(false); return }
          if (process.platform === 'darwin' && permission === 'media') {
            for (const type of mediaTypes) {
              if (!await systemPreferences.askForMediaAccess(type === 'video' ? 'camera' : 'microphone')) { callback(false); return }
            }
          }
          if (permission === 'media') for (const type of mediaTypes) grants.add(`media:${type}`)
          else grants.add(permission)
          callback(true)
        })().catch(() => callback(false))
      })
      // Screen sharing is deliberately unavailable until its platform-specific picker is tested.
      browser.setDisplayMediaRequestHandler((_request, callback) => callback({}))
      browser.on('will-download', (event, item, contents) => {
        if (contents !== window?.webContents || !trustedURL(contents.getURL())
          || !(item.getURL().startsWith('blob:serotine://app/') || trustedURL(item.getURL()))) event.preventDefault()
      })
      const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
        '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff' }
      browser.protocol.handle('serotine', async request => {
        if (request.method !== 'GET' || (request.initiatorOrigin && !trustedURL(request.initiatorOrigin))) return new Response('Forbidden', { status: 403 })
        let file = bundlePath(bundleRoot, request.url)
        if (!file) return new Response('Not found', { status: 404 })
        if (!path.extname(file)) file = path.join(bundleRoot, 'index.html')
        // Do not turn the protocol into a filesystem API, even within the bundle.
        if (!mimeTypes[path.extname(file)] || path.basename(file) === 'native-config.json') return new Response('Not found', { status: 404 })
        try {
          const body = await fs.readFile(file)
          return new Response(body, { headers: { 'content-type': mimeTypes[path.extname(file)], 'cache-control': 'no-store',
            'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
            'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.giphy.com; media-src 'self' blob: https://*.giphy.com; font-src 'self' data:; connect-src 'self' blob: data: https://api.giphy.com https://*.giphy.com; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } })
        } catch { return new Response('Not found', { status: 404 }) }
      })
      const handle = (channel, action) => ipcMain.handle(channel, async (event, value) => {
        assertSender(event, window)
        if (quitting) throw new Error('Serotine is closing. Reopen the app to continue.')
        if (recoveryResetPending) throw new Error('Local recovery is in progress.')
        return action(value)
      })
      handle('serotine:info', () => ({ platform: process.platform, version: config.version, relayOrigin: config.relayOrigin, backgroundSync: false }))
      handle('serotine:snapshot:read', () => store.read())
      handle('serotine:snapshot:write', value => { if (!object(value)) throw new Error('Invalid snapshot.'); return store.write(value.value) })
      handle('serotine:storage:reset', async value => {
        validateReset(value)
        if (relayStarted || pendingQuit || quitDialog || store.pendingWrites || store.pendingReads || store.pendingFlushes) {
          throw new Error('Recovery is available before messaging starts. Close and reopen Serotine first.')
        }
        recoveryResetPending = true
        try {
          const answer = await dialog.showMessageBox(window, { type: 'warning', title: 'Reset local data for recovery?',
            message: 'Permanently remove this app’s saved identity, messages and files?',
            detail: 'Only continue if you accept losing this local data. Restore a known password-encrypted backup afterward to recover your existing address and backed-up history. This does not revoke linked devices or delete relay data.',
            buttons: ['Cancel', 'Delete local data'], defaultId: 0, cancelId: 0 })
          if (answer.response !== 1) return { reset: false }
          await store.reset()
          grants.clear()
          // Root clears and reloads the ephemeral WebView working cache only after this acknowledged success.
          return { reset: true }
        } finally { recoveryResetPending = false }
      })
      handle('serotine:request', value => { relayStarted = true; return relayRequest(value, config.relayOrigin) })
      handle('serotine:external', value => { if (!object(value)) throw new Error('Invalid link.'); return openLink(value.url) })
      handle('serotine:file:save', async value => {
        if (!object(value) || typeof value.mimeType !== 'string' || value.mimeType.length > 150) throw new Error('Invalid file.')
        const name = safeFilename(value.name), bytes = decodeBase64(value.dataBase64, MAX_FILE_BYTES)
        const target = await dialog.showSaveDialog(window, { title: 'Save from Serotine', defaultPath: name,
          properties: ['showOverwriteConfirmation', 'createDirectory'] })
        if (target.canceled || !target.filePath) return { saved: false }
        // The user-selected destination is the only write outside app-private storage; no staging copy is made.
        await fs.writeFile(target.filePath, bytes, { mode: 0o600 })
        return { saved: true }
      })
      handle('serotine:backup:open', async () => {
        const result = await dialog.showOpenDialog(window, { title: 'Restore an encrypted Serotine backup', properties: ['openFile'],
          filters: [{ name: 'Serotine backup', extensions: ['json'] }] })
        if (result.canceled || result.filePaths.length !== 1) return null
        const file = result.filePaths[0], handle = await fs.open(file, 'r')
        try {
          const info = await handle.stat()
          if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('Choose a backup no larger than 100 MiB.')
          // Pin the selected descriptor and bound allocation even if another process grows the file.
          const bytes = Buffer.alloc(info.size)
          let offset = 0
          while (offset < bytes.length) {
            const next = await handle.read(bytes, offset, bytes.length - offset, null)
            if (!next.bytesRead) break
            offset += next.bytesRead
          }
          if ((await handle.read(Buffer.alloc(1), 0, 1, null)).bytesRead) throw new Error('The backup changed while reading it. Choose it again.')
          // The shared validator checks schema, password, identity and switching confirmation before import.
          return { name: path.basename(file), dataBase64: bytes.subarray(0, offset).toString('base64') }
        } finally { await handle.close() }
      })
      window = new BrowserWindow({ width: 1200, height: 850, minWidth: 360, minHeight: 480, title: product, show: false,
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: { preload: path.join(__dirname, 'preload.cjs'), session: browser, sandbox: true, contextIsolation: true,
          nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: config.development } })
      window.on('close', event => { if (!quitting) { event.preventDefault(); void quit() } })
      window.on('focus', () => window.webContents.send('serotine:resume'))
      powerMonitor.on('resume', () => { if (!window.isDestroyed()) window.webContents.send('serotine:resume') })
      const menu = [
        { label: product, submenu: [
          { label: `About ${product}`, click: () => dialog.showMessageBox(window, { title: product, message: `${product} ${config.version}`,
            detail: 'Bundled desktop prototype. Close or Quit stops synchronization. No tray service or automatic updates. Export an encrypted backup before uninstalling or removing app data.' }) },
          { label: 'Official downloads and updates', click: () => void openLink(RELEASE_URL, false) },
          { type: 'separator' },
          { label: 'Erase local app data…', click: async () => {
            const answer = await dialog.showMessageBox(window, { type: 'warning', title: 'Erase local data?', message: 'Erase this app’s identity and history?',
              detail: 'First export an encrypted backup from Account → Backups. This removes this app’s data, including files and drafts; it does not revoke other linked devices or delete relay data.',
              buttons: ['Cancel', 'Erase and quit'], defaultId: 0, cancelId: 0 })
            if (answer.response !== 1) return
            quitting = true
            // Finish deletion before destroying the last window; window-all-closed quits immediately.
            window.hide()
            try {
              await store.flush(); await browser.clearStorageData()
              await fs.rm(store.directory, { recursive: true, force: true }); app.quit()
            } catch {
              dialog.showErrorBox('Data removal did not finish', 'Serotine could not finish removing local data. The app will quit; inspect your local app data before reopening it.')
              app.quit()
            }
          } },
          { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => void quit() },
        ] },
        { role: 'editMenu' },
        { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
        { role: 'windowMenu' },
      ]
      Menu.setApplicationMenu(Menu.buildFromTemplate(menu))
      await window.loadURL(APP_URL)
      window.show()
    }).catch(() => { quitting = true; dialog.showErrorBox('Serotine could not start', 'The bundled app or protected local storage could not be initialized. Your saved data has not been replaced.'); app.quit() })
  }
}
