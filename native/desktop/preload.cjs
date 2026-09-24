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
