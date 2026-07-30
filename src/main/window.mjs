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

/** Sprite frame, drawn bottom-centre of the window (renderer #pet is 192x208). */
export const SPRITE_SIZE = Object.freeze({ width: 192, height: 208 });

/** Cursor poll interval for the hover watch below. */
export const HOVER_POLL_MS = 120;

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
 * The sprite's bounding box in screen coordinates: the renderer stacks the
 * bubble above a bottom-centred 192x208 canvas, so only this part of the window
 * is ever hoverable.
 */
export function spriteBox(bounds, sprite = SPRITE_SIZE) {
  const b = { x: 0, y: 0, width: WINDOW_SIZE.width, height: WINDOW_SIZE.height, ...(bounds || {}) };
  const width = Math.min(sprite.width, b.width);
  const height = Math.min(sprite.height, b.height);
  return {
    x: Math.round(b.x + (b.width - width) / 2),
    y: Math.round(b.y + b.height - height),
    width,
    height,
  };
}

export function pointInBox(point, box) {
  if (!point || !box) return false;
  const { x, y } = point;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
}

/**
 * Hover watch (contracts.md §Renderer: hover makes the pet interactive, which is
 * what makes the right-click menu reachable).
 *
 * The renderer's `mouseenter` cannot carry that alone: on Electron 43.2.0 /
 * Windows 11 22000, mouse-move forwarding from setIgnoreMouseEvents(true,
 * {forward: true}) does not reach a transparent always-on-top window (1 of 9
 * trials delivered a mousemove; identical with focusable true/false and with
 * transparent:false). Main therefore polls the real cursor: interactive while it
 * is inside the sprite box, click-through re-armed once it leaves the window
 * (hysteresis, so travelling from the sprite to the menu does not drop a click).
 *
 * The renderer's `ganyu:set-interactive` requests are OR-ed in rather than
 * applied directly, so the two paths cannot fight each other.
 */
export function createHoverWatch({ getBounds, getCursorPoint, apply, sprite = SPRITE_SIZE }) {
  let hoverWants = false;
  let rendererWants = false;
  let applied = null;

  function sync() {
    const want = hoverWants || rendererWants;
    if (want === applied) return applied;
    applied = want;
    apply(want);
    return want;
  }

  return {
    poll() {
      const bounds = getBounds();
      const point = bounds ? getCursorPoint() : null;
      if (!bounds || !point) {
        hoverWants = false;
      } else if (pointInBox(point, spriteBox(bounds, sprite))) {
        hoverWants = true;
      } else if (!pointInBox(point, bounds)) {
        hoverWants = false;
      }
      return sync();
    },
    /** Last `ganyu:set-interactive` from the renderer. */
    setRendererWants(value) {
      rendererWants = Boolean(value);
      return sync();
    },
    sync,
    get interactive() {
      return applied === true;
    },
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
 * Constructor options actually handed to each BrowserWindow. `smokeFlags` reads
 * them so `npm run smoke` checks this window rather than the WINDOW_FLAGS
 * constant — Electron exposes no getter for `transparent`/`frame`, and asserting
 * the constant made the check pass even for a window built with transparent:false.
 */
const EFFECTIVE_OPTIONS = new WeakMap();

/**
 * Create the overlay window. `BrowserWindow` is injected so this stays mockable.
 * Click-through is ON by default; the hover watch and the renderer flip it on
 * sprite hover.
 */
export function createPetWindow({ BrowserWindow, workArea, preloadPath, size = WINDOW_SIZE, options = {} }) {
  const bounds = computeInitialBounds(workArea, size);
  const winOptions = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    title: 'Ganyu',
    frame: WINDOW_FLAGS.frame,
    transparent: WINDOW_FLAGS.transparent,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    // An overlay must never steal focus from the editor.
    // NOT the cause of the dead-hover problem: measured on Electron 43.2.0 /
    // Windows 11 22000 by moving the real cursor onto the sprite, mouse-move
    // forwarding from setIgnoreMouseEvents(true, {forward: true}) fails the same way
    // with focusable:true, with focusable:false, and with transparent:false (1 of 9
    // trials delivered a mousemove). The fix is `createHoverWatch` below, polled
    // from index.mjs — without it the pet never becomes interactive and the
    // right-click menu is unreachable.
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
  };
  const win = new BrowserWindow(winOptions);
  EFFECTIVE_OPTIONS.set(win, {
    transparent: winOptions.transparent === true,
    frame: winOptions.frame === true,
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.showInactive();
  });
  return win;
}

/**
 * True when the window is drawn with an OS frame: a framed window's outer bounds
 * are larger than its content bounds. Falls back to the recorded constructor
 * option when the geometry cannot be read.
 */
function framed(win, fallback) {
  if (win && typeof win.getBounds === 'function' && typeof win.getContentBounds === 'function') {
    try {
      const outer = win.getBounds();
      const content = win.getContentBounds();
      if (outer && content) return outer.width !== content.width || outer.height !== content.height;
    } catch {
      /* fall through to the recorded option */
    }
  }
  return fallback;
}

/**
 * The three flags `npm run smoke` prints. Order is part of the contract.
 * All three describe THIS window: `alwaysOnTop` and `frame` are observed live,
 * and `transparent` comes from the options this window was actually constructed
 * with (Electron has no getter). A window this module did not build reports
 * transparent:false rather than claiming a flag it cannot verify.
 */
export function smokeFlags(win) {
  const effective = EFFECTIVE_OPTIONS.get(win) ?? { transparent: false, frame: true };
  return {
    transparent: effective.transparent,
    alwaysOnTop: win && typeof win.isAlwaysOnTop === 'function' ? win.isAlwaysOnTop() : false,
    frame: framed(win, effective.frame),
  };
}

/**
 * Register exactly the renderer->main half of the IPC contract.
 * Returns a dispose function.
 *
 * `onInteractive` (optional) hands the renderer's request to the hover watch
 * instead of applying it straight to the window, so polling and DOM hover agree.
 */
export function registerIpc({ ipcMain, getWindow, getFlags, onMenuAction, onInteractive = null }) {
  const handleSetInteractive = (_event, interactive) => {
    if (onInteractive) {
      onInteractive(Boolean(interactive));
      return;
    }
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

/**
 * Module B's normalized event -> the detail object module D's `onEvent` receives.
 * Lives here (not inline in index.mjs) so test/speech.test.mjs can drive the real
 * production seam instead of a hand-written copy of it.
 * The event's own mode wins over the aggregate: a `failed` line belongs to the
 * session that failed, even when a second session is still busy.
 */
export function toSpeechDetail(event, aggregate) {
  const agg = aggregate || null;
  return { ...event, mode: event?.mode ?? agg?.mode ?? 'idle', aggregate: agg };
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
