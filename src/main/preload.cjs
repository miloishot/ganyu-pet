// Module A — preload. CommonJS because Electron loads contextIsolated
// preloads as CJS. Exposes exactly the five members of the IPC contract.

const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel, cb) => {
  if (typeof cb !== 'function') return () => {};
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('ganyu', {
  onState: (cb) => subscribe('ganyu:state', cb),
  onSpeak: (cb) => subscribe('ganyu:speak', cb),
  setInteractive: (interactive) => ipcRenderer.send('ganyu:set-interactive', Boolean(interactive)),
  menuAction: (action) => ipcRenderer.send('ganyu:menu', String(action)),
  getFlags: () => ipcRenderer.invoke('ganyu:get-flags'),
});
