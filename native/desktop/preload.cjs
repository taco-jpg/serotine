const { contextBridge, ipcRenderer } = require('electron')

// Sandboxed preload: never expose ipcRenderer, filesystem paths, arbitrary channels, or Node objects.
if (process.isMainFrame && window.location.protocol === 'serotine:' && window.location.host === 'app') {
  contextBridge.exposeInMainWorld('serotineNative', Object.freeze({
    platform: 'desktop',
    getInfo: () => ipcRenderer.invoke('serotine:info'),
    readSnapshot: () => ipcRenderer.invoke('serotine:snapshot:read'),
    writeSnapshot: value => ipcRenderer.invoke('serotine:snapshot:write', value),
    resetStorage: value => ipcRenderer.invoke('serotine:storage:reset', value),
    request: value => ipcRenderer.invoke('serotine:request', value),
    saveFile: value => ipcRenderer.invoke('serotine:file:save', value),
    openBackup: () => ipcRenderer.invoke('serotine:backup:open'),
    openExternal: value => ipcRenderer.invoke('serotine:external', value),
    getUpdateState: () => ipcRenderer.invoke('serotine:update:get'),
    checkForUpdates: () => ipcRenderer.invoke('serotine:update:check'),
    downloadUpdate: () => ipcRenderer.invoke('serotine:update:download'),
    installUpdate: restart => ipcRenderer.invoke('serotine:update:install', restart),
    onUpdateState: callback => {
      if (typeof callback !== 'function') throw new TypeError('Expected an update listener.')
      const listener = (_event, state) => callback(state)
      ipcRenderer.on('serotine:update-state', listener)
      return () => ipcRenderer.removeListener('serotine:update-state', listener)
    },
    onShowAbout: callback => {
      if (typeof callback !== 'function') throw new TypeError('Expected an About listener.')
      const listener = () => callback()
      ipcRenderer.on('serotine:show-about', listener)
      return () => ipcRenderer.removeListener('serotine:show-about', listener)
    },
    onCheckUpdates: callback => {
      if (typeof callback !== 'function') throw new TypeError('Expected an update check listener.')
      const listener = () => callback()
      ipcRenderer.on('serotine:check-updates', listener)
      return () => ipcRenderer.removeListener('serotine:check-updates', listener)
    },
    onBeforeQuit: callback => {
      if (typeof callback !== 'function') throw new TypeError('Expected a shutdown listener.')
      const listener = (_event, id) => {
        if (typeof id !== 'string') return
        Promise.resolve().then(callback).then(
          () => ipcRenderer.send('serotine:quit-ready', { id, success: true }),
          () => ipcRenderer.send('serotine:quit-ready', { id, success: false }),
        )
      }
      ipcRenderer.on('serotine:prepare-quit', listener)
      return () => ipcRenderer.removeListener('serotine:prepare-quit', listener)
    },
    onResume: callback => {
      if (typeof callback !== 'function') throw new TypeError('Expected a resume listener.')
      const listener = () => callback()
      ipcRenderer.on('serotine:resume', listener)
      return () => ipcRenderer.removeListener('serotine:resume', listener)
    },
  }))
}
