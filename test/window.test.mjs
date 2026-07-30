// Module A tests — the electron-free half of window.mjs: the hover watch that
// makes the pet interactive (contracts.md §Renderer / §Window) and the flags
// `npm run smoke` prints. BrowserWindow is a hand-rolled double, so this runs on
// plain node.

import test from 'node:test';
import assert from 'node:assert/strict';

import { CHAT_CHANNELS, createChat } from '../src/main/chat.mjs';
import {
  CHANNELS,
  HOVER_POLL_MS,
  MENU_ACTIONS,
  SIZE_DRIFT_TOLERANCE,
  SPRITE_SIZE,
  WINDOW_SIZE,
  computeInitialBounds,
  createHoverWatch,
  createPetWindow,
  enforceWindowSize,
  moveWindowPinned,
  pointInBox,
  registerIpc,
  sizeWithinTolerance,
  smokeFlags,
  spriteBox,
  toSpeechDetail,
} from '../src/main/window.mjs';

// ---------------------------------------------------------------- geometry

test('spriteBox is the bottom-centred 192x208 frame of the window', () => {
  const box = spriteBox({ x: 1000, y: 700, width: 256, height: 320 });
  assert.deepEqual(box, { x: 1032, y: 812, width: SPRITE_SIZE.width, height: SPRITE_SIZE.height });
});

test('pointInBox is inclusive of the top-left, exclusive of the far edges', () => {
  const box = { x: 10, y: 20, width: 100, height: 50 };
  assert.equal(pointInBox({ x: 10, y: 20 }, box), true);
  assert.equal(pointInBox({ x: 109, y: 69 }, box), true);
  assert.equal(pointInBox({ x: 110, y: 40 }, box), false);
  assert.equal(pointInBox({ x: 40, y: 70 }, box), false);
  assert.equal(pointInBox(null, box), false);
  assert.equal(pointInBox({ x: NaN, y: 0 }, box), false);
});

// ---------------------------------------------------------------- hover watch

function hoverHarness(bounds = { x: 1000, y: 700, width: WINDOW_SIZE.width, height: WINDOW_SIZE.height }) {
  const applied = [];
  let point = { x: 0, y: 0 };
  const watch = createHoverWatch({
    getBounds: () => bounds,
    getCursorPoint: () => point,
    apply: (interactive) => applied.push(interactive),
  });
  return {
    watch,
    applied,
    moveTo(x, y) {
      point = { x, y };
      return watch.poll();
    },
  };
}

test('cursor entering the sprite box makes the window interactive', () => {
  const h = hoverHarness();
  assert.equal(h.moveTo(0, 0), false);
  assert.equal(h.watch.interactive, false);

  // Centre of the sprite: 1000 + 128, 700 + 320 - 104.
  assert.equal(h.moveTo(1128, 916), true);
  assert.equal(h.watch.interactive, true);
  assert.deepEqual(h.applied, [false, true]);
});

test('interactivity survives the bubble area and drops once the cursor leaves the window', () => {
  const h = hoverHarness();
  h.moveTo(1128, 916); // on the sprite
  assert.equal(h.watch.interactive, true);

  h.moveTo(1128, 720); // still inside the window, above the sprite (bubble/menu)
  assert.equal(h.watch.interactive, true, 'travelling to the menu must not drop the click');

  h.moveTo(400, 400); // off the window entirely
  assert.equal(h.watch.interactive, false);
  assert.deepEqual(h.applied, [false, true, false]);
});

test('the renderer request is OR-ed in, so DOM hover and polling cannot fight', () => {
  const h = hoverHarness();
  h.moveTo(0, 0);
  assert.equal(h.watch.setRendererWants(true), true, 'renderer mouseenter alone makes it interactive');
  h.moveTo(1128, 916);
  assert.equal(h.watch.setRendererWants(false), true, 'cursor still on the sprite: stay interactive');
  h.moveTo(400, 400);
  assert.equal(h.watch.interactive, false);
});

test('a missing window or cursor reading re-arms click-through instead of throwing', () => {
  const applied = [];
  const watch = createHoverWatch({
    getBounds: () => null,
    getCursorPoint: () => null,
    apply: (v) => applied.push(v),
  });
  assert.equal(watch.poll(), false);
  assert.deepEqual(applied, [false]);
  assert.ok(HOVER_POLL_MS > 0 && HOVER_POLL_MS <= 250);
});

// ---------------------------------------------------------------- smoke flags

class FakeWindow {
  constructor(options) {
    this.options = options;
    this.alwaysOnTop = Boolean(options.alwaysOnTop);
    this.listeners = new Map();
    // The overlay is built focusable:false so it never steals the caret.
    this.focusable = options.focusable !== false;
    this.focused = false;
    this.focusLog = [];
    // A framed window's outer bounds exceed its content bounds.
    const chrome = options.frame === true ? { w: 16, h: 39 } : { w: 0, h: 0 };
    this.bounds = { x: options.x, y: options.y, width: options.width + chrome.w, height: options.height + chrome.h };
    this.content = { x: options.x, y: options.y, width: options.width, height: options.height };
  }

  isDestroyed() { return false; }
  isAlwaysOnTop() { return this.alwaysOnTop; }
  setAlwaysOnTop(v) { this.alwaysOnTop = Boolean(v); }
  setIgnoreMouseEvents() {}
  getBounds() { return { ...this.bounds }; }
  getContentBounds() { return { ...this.content }; }
  once(event, cb) { this.listeners.set(event, cb); }
  showInactive() {}

  setFocusable(v) { this.focusable = Boolean(v); this.focusLog.push(`focusable:${Boolean(v)}`); }
  focus() { this.focused = true; this.focusLog.push('focus'); }
  blur() { this.focused = false; this.focusLog.push('blur'); }

  /**
   * Reproduces the measured Windows behaviour: a bare setPosition re-rounds the
   * window rect and grows it by 1px per call at a fractional scale factor.
   * Measured on the real thing: 259x323 -> 516x522 over 300 moves.
   */
  setPosition(x, y) {
    this.bounds = { x, y, width: this.bounds.width + 1, height: this.bounds.height + 1 };
    this.content = { ...this.bounds };
  }

  /** Passing width/height is what stops the growth compounding. */
  setBounds({ x, y, width, height }) {
    this.bounds = { x, y, width, height };
    this.content = { ...this.bounds };
  }
}

const makeWindow = (options = {}) => createPetWindow({
  BrowserWindow: FakeWindow,
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  preloadPath: 'preload.cjs',
  options,
});

test('smoke flags report the contract values for the real window', () => {
  const win = makeWindow();
  assert.deepEqual(smokeFlags(win), { transparent: true, alwaysOnTop: true, frame: false });
  const bounds = computeInitialBounds({ x: 0, y: 0, width: 1920, height: 1040 });
  assert.deepEqual(win.getBounds(), bounds);
});

test('smoke flags follow the window actually built, not the WINDOW_FLAGS constant', () => {
  assert.equal(smokeFlags(makeWindow({ transparent: false })).transparent, false);
  assert.equal(smokeFlags(makeWindow({ frame: true })).frame, true);
  assert.equal(smokeFlags(makeWindow({ alwaysOnTop: false })).alwaysOnTop, false);
});

test('smoke flags never claim transparency for a window this module did not build', () => {
  assert.deepEqual(smokeFlags(null), { transparent: false, alwaysOnTop: false, frame: true });
});

// ------------------------------------------------------- window size pinning
//
// The root cause of the owner's "she runs off my screen": on Windows at a
// fractional scale factor every bare setPosition re-rounds the window rect and
// grows it, and at 20 moves/sec during a stroll that compounds — measured
// 259x323 -> 516x522 over 300 moves, and 2643x4257 physical px after minutes of
// walking. The sprite is drawn bottom-centre of the window, so an inflated window
// pushes her below the bottom of the screen, and the constant resizing is the
// flicker. Pinning width/height on every move is the fix.

test('the FakeWindow reproduces the measured setPosition inflation', () => {
  // Guards the guard: if this double stopped inflating, the two tests below would
  // pass for the wrong reason.
  const win = makeWindow();
  assert.deepEqual(win.getBounds(), { x: 1640, y: 720, width: 256, height: 320 });
  for (let i = 0; i < 300; i++) win.setPosition(400 + (i % 7), 690 + (i % 3));
  assert.equal(win.getBounds().width, 556, '300 bare moves inflate the window');
  assert.equal(win.getBounds().height, 620);
});

test('moveWindowPinned holds the canonical size across hundreds of moves', () => {
  const win = makeWindow();
  for (let i = 0; i < 300; i++) {
    const at = moveWindowPinned(win, 400 + (i % 7), 690 + (i % 3));
    assert.deepEqual(at, { x: 400 + (i % 7), y: 690 + (i % 3), width: 256, height: 320 });
  }
  assert.deepEqual(win.getBounds(), { x: 405, y: 692, width: WINDOW_SIZE.width, height: WINDOW_SIZE.height });
  assert.deepEqual(win.getContentBounds(), win.getBounds(), 'and the content with it');
});

test('moveWindowPinned rounds fractional positions and survives a null window', () => {
  const win = makeWindow();
  moveWindowPinned(win, 100.4, 200.6);
  assert.deepEqual(win.getBounds(), { x: 100, y: 201, width: 256, height: 320 });
  assert.equal(moveWindowPinned(null, 1, 2), null);
});

test('enforceWindowSize resets a drifted window and no-ops within tolerance', () => {
  const win = makeWindow();
  for (let i = 0; i < 200; i++) win.setPosition(500, 400); // inflate to 456x520
  const drifted = enforceWindowSize(win);
  assert.deepEqual(drifted, { width: 456, height: 520 }, 'reports the size it corrected');
  assert.deepEqual(win.getBounds(), { x: 500, y: 400, width: 256, height: 320 }, 'reset in place');

  assert.equal(enforceWindowSize(win), null, 'nothing to do the second time');

  // Legitimate jitter is +/-1 DIP at odd coordinates; that must not trigger a reset.
  win.setBounds({ x: 500, y: 400, width: WINDOW_SIZE.width + 1, height: WINDOW_SIZE.height + 1 });
  assert.equal(enforceWindowSize(win), null, `${SIZE_DRIFT_TOLERANCE}px of slack absorbs the rounding jitter`);
  assert.equal(win.getBounds().width, WINDOW_SIZE.width + 1, 'left alone');

  // Just past the tolerance it fires again, in both directions.
  win.setBounds({ x: 500, y: 400, width: WINDOW_SIZE.width + SIZE_DRIFT_TOLERANCE + 1, height: WINDOW_SIZE.height });
  assert.ok(enforceWindowSize(win), 'oversized past the tolerance');
  win.setBounds({ x: 500, y: 400, width: WINDOW_SIZE.width - SIZE_DRIFT_TOLERANCE - 1, height: WINDOW_SIZE.height });
  assert.ok(enforceWindowSize(win), 'undersized past the tolerance is equally wrong');

  assert.equal(enforceWindowSize(null), null);
  assert.equal(enforceWindowSize({ getBounds: () => null }), null, 'an unreadable window is not drift');
});

test('sizeWithinTolerance absorbs the +/-1 DIP parity artifact but not real drift', () => {
  // Measured on the real window: the same pinned 256x320 window reports 256x320 at
  // even coordinates and 257x321 at odd ones. Within the tolerance the canonical
  // size is the truer value, which is why index.mjs snaps to it — otherwise the
  // floor lands on 698 or 699 depending on where she stood when we measured.
  assert.equal(sizeWithinTolerance({ width: 256, height: 320 }), true);
  assert.equal(sizeWithinTolerance({ width: 257, height: 321 }), true, 'odd-coordinate reading');
  assert.equal(sizeWithinTolerance({ width: 259, height: 323 }), true, 'constructor rounding');
  assert.equal(sizeWithinTolerance({ width: 288, height: 346 }), false, 'drifted');
  assert.equal(sizeWithinTolerance({ width: 1762, height: 2838 }), false, 'badly drifted');
  assert.equal(sizeWithinTolerance(null), false);
  assert.equal(sizeWithinTolerance({ width: NaN, height: 320 }), false);

  const edge = WINDOW_SIZE.width + SIZE_DRIFT_TOLERANCE;
  assert.equal(sizeWithinTolerance({ width: edge, height: 320 }), true, 'inclusive at the tolerance');
  assert.equal(sizeWithinTolerance({ width: edge + 1, height: 320 }), false, 'exclusive one past it');
});

test('enforceWindowSize with tolerance 0 normalizes the constructor rounding', () => {
  // The real BrowserWindow rounds a 256x320 request up to a 259x323 outer rect,
  // which hangs 3px past the work area; startup pins it before measuring.
  const win = makeWindow();
  win.setBounds({ x: 1427, y: 699, width: 259, height: 323 });
  const drifted = enforceWindowSize(win, { tolerance: 0 });
  assert.deepEqual(drifted, { width: 259, height: 323 });
  assert.deepEqual(win.getBounds(), { x: 1427, y: 699, width: 256, height: 320 });
});

// ---------------------------------------------------------------- menu actions

test("MENU_ACTIONS carries the recall action alongside the original three", () => {
  assert.deepEqual([...MENU_ACTIONS], ['toggle-mute', 'toggle-pin', 'home', 'quit']);
  assert.ok(Object.isFrozen(MENU_ACTIONS), 'frozen so callers cannot widen it at runtime');
});

test('registerIpc dispatches every MENU_ACTIONS entry and nothing else', () => {
  const seen = [];
  const handlers = new Map();
  const ipcMain = {
    on: (channel, fn) => handlers.set(channel, fn),
    handle: (channel, fn) => handlers.set(channel, fn),
    removeListener: (channel) => handlers.delete(channel),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const dispose = registerIpc({
    ipcMain,
    getWindow: () => null,
    getFlags: () => ({ muted: false, pinned: false, spritePath: null }),
    onMenuAction: (action) => seen.push(action),
  });

  const menu = handlers.get(CHANNELS.menu);
  for (const action of MENU_ACTIONS) menu(null, action);
  // 'home' has to survive the allow-list filter, or the recall path is dead.
  assert.deepEqual(seen, ['toggle-mute', 'toggle-pin', 'home', 'quit']);

  for (const bogus of ['go-home', 'HOME', '', null, undefined, 'eval']) menu(null, bogus);
  assert.deepEqual(seen, ['toggle-mute', 'toggle-pin', 'home', 'quit'], 'unknown actions are dropped');

  dispose();
  assert.equal(handlers.size, 0, 'dispose removes every listener it added');
});

// ---------------------------------------------------------------- chat channels
//
// registerIpc owns the chat pair too. `ganyu:set-focus` is purely a window
// operation, and `ganyu:chat` is registered here — at window creation — rather
// than later, when composeRuntime builds the chat module: `invoke` on an
// unregistered channel *rejects*, and the renderer raises its pending bubble the
// instant it calls, so a message typed during startup has to come back as a
// plain null it already knows how to draw.

function ipcHarness({ getChat = null, getWindow = () => null } = {}) {
  const handlers = new Map();
  const ipcMain = {
    on: (channel, fn) => handlers.set(channel, fn),
    handle: (channel, fn) => handlers.set(channel, fn),
    removeListener: (channel) => handlers.delete(channel),
    removeHandler: (channel) => handlers.delete(channel),
  };
  const dispose = registerIpc({
    ipcMain,
    getWindow,
    getFlags: () => ({ muted: false, pinned: false, spritePath: null }),
    onMenuAction: () => {},
    getChat,
  });
  return { handlers, dispose, call: (channel, ...args) => handlers.get(channel)(null, ...args) };
}

test('registerIpc registers the chat pair alongside the original three, and disposes both', () => {
  const h = ipcHarness();
  assert.ok(h.handlers.has(CHAT_CHANNELS.chat), 'ganyu:chat');
  assert.ok(h.handlers.has(CHAT_CHANNELS.setFocus), 'ganyu:set-focus');
  assert.equal(h.handlers.size, 5, 'the three renderer->main channels plus the chat pair');

  // chat.mjs is the single home of these two strings; CHANNELS must not grow a
  // second copy of either, which is the only way the two tables could drift.
  for (const channel of Object.values(CHAT_CHANNELS)) {
    assert.ok(!Object.values(CHANNELS).includes(channel), `${channel} is defined in both tables`);
  }

  h.dispose();
  assert.equal(h.handlers.size, 0, 'dispose removes every listener it added');
});

test('ganyu:chat answers null before the chat module exists, then relays the reply', async () => {
  let chat = null;
  const h = ipcHarness({ getChat: () => chat });
  const send = (text) => h.call(CHAT_CHANNELS.chat, text);

  assert.equal(await send('hello?'), null, 'composeRuntime has not run yet');

  chat = createChat({ brain: { requestChat: ({ text }) => Promise.resolve(`re: ${text}`) } });
  assert.equal(await send('are you there?'), 're: are you there?');

  // No brain is not a broken chat — it is one whose every send resolves null,
  // which is exactly what the renderer's in-character fallback is for.
  chat = createChat({ brain: null });
  assert.equal(await send('and now?'), null);
});

test('ganyu:chat never rejects and never hands back a blank line', async () => {
  const cases = {
    'a chat that throws': { send: () => { throw new Error('boom'); } },
    'a chat that rejects': { send: () => Promise.reject(new Error('boom')) },
    'a blank reply': { send: () => Promise.resolve('   ') },
    'a non-string reply': { send: () => Promise.resolve({ text: 'nope' }) },
    'not a chat at all': {},
  };
  for (const [label, chat] of Object.entries(cases)) {
    assert.equal(await ipcHarness({ getChat: () => chat }).call(CHAT_CHANNELS.chat, 'hi'), null, label);
  }

  const broken = ipcHarness({ getChat: () => { throw new Error('composition failed'); } });
  assert.equal(await broken.call(CHAT_CHANNELS.chat, 'hi'), null, 'a getter that throws is survivable too');
});

test('ganyu:chat coerces whatever the renderer sent into a string', async () => {
  const seen = [];
  const h = ipcHarness({ getChat: () => ({ send: (text) => { seen.push(text); return Promise.resolve(null); } }) });
  for (const raw of ['hi', null, undefined, 42]) await h.call(CHAT_CHANNELS.chat, raw);
  assert.deepEqual(seen, ['hi', '', '', '42'], 'chat.mjs then does the trimming and the cap');
});

test('the window really is built unfocusable, which is what set-focus exists to lift', () => {
  const win = makeWindow();
  assert.equal(win.options.focusable, false, 'an overlay must never steal focus from the editor');
  assert.equal(win.focusable, false, 'so its own text input cannot take a keystroke until main lifts it');
});

test('ganyu:set-focus lifts focusability on open and restores it on close', () => {
  const win = makeWindow();
  const h = ipcHarness({ getWindow: () => win });

  h.call(CHAT_CHANNELS.setFocus, true);
  assert.equal(win.focusable, true);
  assert.equal(win.focused, true);
  assert.deepEqual(win.focusLog, ['focusable:true', 'focus'], 'the flag first — focusing an unfocusable window is a no-op');

  h.call(CHAT_CHANNELS.setFocus, false);
  assert.equal(win.focusable, false);
  assert.equal(win.focused, false);
  assert.deepEqual(
    win.focusLog.slice(2),
    ['focusable:false', 'blur'],
    'blurring is what hands the caret back — dropping the flag alone leaves the window holding it',
  );
});

test('ganyu:set-focus coerces its argument and never takes the pet down', () => {
  const win = makeWindow();
  const h = ipcHarness({ getWindow: () => win });
  h.call(CHAT_CHANNELS.setFocus, 'open');
  assert.equal(win.focusable, true);
  h.call(CHAT_CHANNELS.setFocus, 0);
  assert.equal(win.focusable, false);

  for (const getWindow of [
    () => null,
    () => ({ isDestroyed: () => true }),
    () => ({ isDestroyed: () => false, setFocusable() { throw new Error('no such window'); } }),
  ]) {
    assert.doesNotThrow(() => ipcHarness({ getWindow }).call(CHAT_CHANNELS.setFocus, true));
  }
});

test('computeInitialBounds is the recall target, and honours a measured size', () => {
  // The owner's real machine. Once the size is pinned the window really is
  // 256x320, so 'home' lands flush in the corner with nothing hanging over.
  const area = { x: 0, y: 0, width: 1707, height: 1019 };
  const home = computeInitialBounds(area);
  assert.deepEqual(home, { x: 1427, y: 699, width: 256, height: 320 });
  assert.equal(home.x + home.width, 1683, 'inside the right edge, less the 24px margin');
  assert.equal(home.y + home.height, area.height, 'flush on the bottom edge');

  // Unpinned, the constructor's 259x323 rect would hang 3px past the bottom and
  // right — which is why startup pins the size before measuring anything.
  assert.equal(home.y + 323, 1022, 'the constructor rounding really does overflow');

  // A genuinely different size (a future DPI or layout change) is still honoured.
  const bigger = computeInitialBounds(area, { width: 300, height: 400 });
  assert.deepEqual(bigger, { x: 1383, y: 619, width: 300, height: 400 });
  assert.ok(bigger.x + 300 <= area.width && bigger.y + 400 <= area.height, 'fully inside');
  assert.equal(WINDOW_SIZE.height, 320, 'the canonical height the pinning enforces');
});

// ---------------------------------------------------------------- speech seam

test('toSpeechDetail keeps the event mode and falls back to the aggregate', () => {
  const event = { source: 'claude', event: 'PostToolUse', mode: 'busy', tool: 'Bash', failed: true };
  assert.equal(toSpeechDetail(event, { mode: 'failed' }).mode, 'busy');
  assert.equal(toSpeechDetail({ source: 'codex', event: 'Odd' }, { mode: 'waiting' }).mode, 'waiting');
  assert.equal(toSpeechDetail({ source: 'codex' }, null).mode, 'idle');
  assert.equal(toSpeechDetail(event, { mode: 'failed' }).tool, 'Bash');
});
