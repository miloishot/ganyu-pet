// Module A — preload. CommonJS because Electron loads contextIsolated
// preloads as CJS. Exposes exactly the members of the IPC contract: the
// original five, plus the two that carry the chat path (see chat.mjs
// CHAT_CHANNELS — the strings are duplicated here because this file is CJS and
// cannot import an ESM module, exactly as the other five already are).

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
  /** Owner -> Ganyu. Resolves to her reply, or null when there isn't one. */
  sendChat: (text) => ipcRenderer.invoke('ganyu:chat', String(text ?? '')),
  /**
   * The window is created focusable:false so it never steals focus from the
   * editor. The text input cannot receive a keystroke until main lifts that,
   * so the renderer asks for it while the chat strip is open and gives it back
   * on close.
   */
  setFocused: (focused) => ipcRenderer.send('ganyu:set-focus', Boolean(focused)),
});
