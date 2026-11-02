const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('host', {
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } },
  ready: () => ipcRenderer.invoke('renderer-ready'),
  openPdfs: (multi) => ipcRenderer.invoke('open-pdfs', multi),
  openImage: () => ipcRenderer.invoke('open-images'),
  saveDialog: (name, ext) => ipcRenderer.invoke('save-dialog', name, ext),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  writeFile: (p, data) => ipcRenderer.invoke('write-file', p, data),
  unicodeFont: () => ipcRenderer.invoke('unicode-font'),
  joinPath: (...parts) => ipcRenderer.invoke('join-path', ...parts),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  confirm: (message, detail, buttons) => ipcRenderer.invoke('confirm', message, detail, buttons),
  setDirty: (dirty, title) => ipcRenderer.send('set-dirty', dirty, title),
  onCommand: (fn) => ipcRenderer.on('cmd', (_e, cmd, arg) => fn(cmd, arg)),
  onOpenFiles: (fn) => ipcRenderer.on('open-files', (_e, files) => fn(files)),
});
