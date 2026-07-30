// Module A — window construction, IPC registration, sprite resolution.
//
// Deliberately free of any `electron` import: every Electron object this file
// touches is injected by index.mjs. That keeps the pure logic here (bounds,
// sprite path, smoke flags) unit-testable on plain node.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Sprite frame is 192x208; the extra headroom is for the speech bubble. */
export const WINDOW_SIZE = Object.freeze({ width: 256, height: 320 });

/** Flags asserted by `npm run smoke`; kept beside the BrowserWindow options. */
export const WINDOW_FLAGS = Object.freeze({ transparent: true, frame: false });

/** Codex pet id — see contracts.md "Machine facts". */
export const PET_ID = 'ganyu--chenxin-dlut';

/** Channels this module owns. Nothing outside this list is registered. */
export const CHANNELS = Object.freeze({
  state: 'ganyu:state',
  speak: 'ganyu:speak',
  setInteractive: 'ganyu:set-interactive',
  menu: 'ganyu:menu',
  getFlags: 'ganyu:get-flags',
});

export const MENU_ACTIONS = Object.freeze(['toggle-mute', 'toggle-pin', 'quit']);

/**
 * Bottom-right of the primary display work area. Y sits flush on the bottom
 * edge because the wander scheduler only ever changes X.
 */
export function computeInitialBounds(workArea, size = WINDOW_SIZE) {
  const wa = { x: 0, y: 0, width: 1920, height: 1080, ...(workArea || {}) };
  const margin = 24;
  return {
    x: Math.round(wa.x + Math.max(0, wa.width - size.width - margin)),
    y: Math.round(wa.y + Math.max(0, wa.height - size.height)),
    width: size.width,
    height: size.height,
  };
}

/**
 * Resolve the spritesheet on disk. Never copies it into the repo.
 *   1. `$CODEX_HOME/pets/<id>/spritesheet.webp` when CODEX_HOME is set
 *   2. `~/.codex/pets/<id>/spritesheet.webp`
 *   3. `spritesheetPath` from `pet.json` in that directory (relative or absolute)
 * Returns an absolute path, or null when nothing is found.
 */
export function resolveSpritePath({ env = process.env, home = os.homedir(), exists = fs.existsSync, read = fs.readFileSync } = {}) {
  const codexHome = env.CODEX_HOME && String(env.CODEX_HOME).trim()
    ? String(env.CODEX_HOME).trim()
    : path.join(home, '.codex');
  const petDir = path.join(codexHome, 'pets', PET_ID);

  const direct = path.join(petDir, 'spritesheet.webp');
  if (exists(direct)) return direct;

  const metaPath = path.join(petDir, 'pet.json');
  if (exists(metaPath)) {
    try {
      const declared = JSON.parse(read(metaPath, 'utf8'))?.spritesheetPath;
      if (typeof declared === 'string' && declared.trim()) {
        const abs = path.isAbsolute(declared) ? declared : path.join(petDir, declared);
        if (exists(abs)) return abs;
      }
    } catch {
      // Unparsable pet.json is not fatal — fall through to "no sprite".
    }
  }
  return null;
}

/** `file://` URL for the renderer's <img> source, or null. */
export function spriteFileUrl(spritePath) {
  return spritePath ? pathToFileURL(spritePath).href : null;
}

/**
 * Create the overlay window. `BrowserWindow` is injected so this stays mockable.
 * Click-through is ON by default; the renderer flips it on sprite hover.
 */
export function createPetWindow({ BrowserWindow, workArea, preloadPath, size = WINDOW_SIZE, options = {} }) {
  const bounds = computeInitialBounds(workArea, size);
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    title: 'Ganyu',
    frame: WINDOW_FLAGS.frame,
    transparent: WINDOW_FLAGS.transparent,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    acceptFirstMouse: true,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      devTools: process.env.GANYU_DEVTOOLS === '1',
    },
    ...options,
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.showInactive();
  });
  return win;
}

/** The three flags `npm run smoke` prints. Order is part of the contract. */
export function smokeFlags(win) {
  return {
    transparent: WINDOW_FLAGS.transparent,
    alwaysOnTop: win && typeof win.isAlwaysOnTop === 'function' ? win.isAlwaysOnTop() : false,
    frame: WINDOW_FLAGS.frame,
  };
}

/**
 * Register exactly the renderer->main half of the IPC contract.
 * Returns a dispose function.
 */
export function registerIpc({ ipcMain, getWindow, getFlags, onMenuAction }) {
  const handleSetInteractive = (_event, interactive) => {
    const win = getWindow();
    if (!win || win.isDestroyed()) return;
    win.setIgnoreMouseEvents(!interactive, { forward: true });
  };
  const handleMenu = (_event, action) => {
    if (MENU_ACTIONS.includes(action)) onMenuAction(action);
  };
  const handleGetFlags = () => getFlags();

  ipcMain.on(CHANNELS.setInteractive, handleSetInteractive);
  ipcMain.on(CHANNELS.menu, handleMenu);
  ipcMain.handle(CHANNELS.getFlags, handleGetFlags);

  return () => {
    ipcMain.removeListener(CHANNELS.setInteractive, handleSetInteractive);
    ipcMain.removeListener(CHANNELS.menu, handleMenu);
    if (typeof ipcMain.removeHandler === 'function') ipcMain.removeHandler(CHANNELS.getFlags);
  };
}

/** Normalize whatever module E reports into the renderer's `walk` shape. */
export function normalizeWalk(walk) {
  if (!walk) return null;
  const dir = typeof walk === 'string' ? walk : walk.dir;
  return dir === 'left' || dir === 'right' ? { dir } : null;
}

/** Aggregate (module B) + walk (module E) -> the `ganyu:state` payload. */
export function toStatePayload(aggregate, walk) {
  const agg = aggregate || {};
  const mode = ['idle', 'busy', 'waiting', 'failed'].includes(agg.mode) ? agg.mode : 'idle';
  return {
    mode,
    sessionCount: Number.isFinite(agg.sessionCount) ? agg.sessionCount : 0,
    celebrate: Boolean(agg.celebrate),
    walk: normalizeWalk(walk),
  };
}
