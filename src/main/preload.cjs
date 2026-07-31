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
  /**
   * Her voice: `{mime, base64}` for a line already on `ganyu:speak`. A separate
   * channel because it arrives a second or so later — synthesis is not allowed
   * to delay the bubble — and main sends it only for lines that passed the same
   * mute and salience gates the bubble did.
   */
  onAudio: (cb) => subscribe('ganyu:audio', cb),
  setInteractive: (interactive) => ipcRenderer.send('ganyu:set-interactive', Boolean(interactive)),
  menuAction: (action) => ipcRenderer.send('ganyu:menu', String(action)),
  /**
   * The left button went down on the sprite ('press') or came up ('release').
   * Only the button — whether it became a drag is main's call, because on this
   * machine a click-through overlay does not reliably see the mousemove that
   * would answer it. The verdict comes back as `dragging` on `ganyu:state`.
   */
  drag: (phase) => ipcRenderer.send('ganyu:drag', String(phase)),
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
