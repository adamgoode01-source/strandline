/* The only surface the page gets. Everything here is a named operation with a
   fixed shape - there is no "read this path" or "run this command", so a bug
   in the page cannot turn into arbitrary file or process access. */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('strandline', {
  platform: 'desktop',
  version: process.versions.electron,

  pickPdf: () => ipcRenderer.invoke('pick-pdf'),
  saveFile: (suggestedName, data, filters) =>
    ipcRenderer.invoke('save-file', { suggestedName, data, filters }),
  reveal: p => ipcRenderer.invoke('reveal', p),

  settings: {
    get: () => ipcRenderer.invoke('settings-get'),
    setKey: key => ipcRenderer.invoke('settings-set-key', key),
    setModels: v => ipcRenderer.invoke('settings-set-models', v)
  },

  readPlans: opts => ipcRenderer.invoke('read-plans', opts),
  onReadProgress: cb => {
    const h = (e, msg) => cb(msg);
    ipcRenderer.on('read-progress', h);
    return () => ipcRenderer.removeListener('read-progress', h);
  },

  // Sync goes through the main process so the token stays out of the page and
  // http can be refused in one place.
  sync: (url, token, path, method, body) =>
    ipcRenderer.invoke('sync-request', { url, token, path, method, body })
});
