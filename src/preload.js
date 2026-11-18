const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('init'),
  togglePause: () => ipcRenderer.invoke('toggle-pause'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  refreshData: () => ipcRenderer.invoke('refresh-data'),
  testImage: () => ipcRenderer.invoke('test-image'),
  openDataFolder: () => ipcRenderer.invoke('open-data-folder'),
  on: (channel, cb) => {
    const allowed = ['status', 'cards', 'champion', 'game'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, payload) => cb(payload));
  },
});
