// Module A tests — the electron-free half of window.mjs: the hover watch that
// makes the pet interactive (contracts.md §Renderer / §Window) and the flags
// `npm run smoke` prints. BrowserWindow is a hand-rolled double, so this runs on
// plain node.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOVER_POLL_MS,
  SPRITE_SIZE,
  WINDOW_SIZE,
  computeInitialBounds,
  createHoverWatch,
  createPetWindow,
  pointInBox,
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

// ---------------------------------------------------------------- speech seam

test('toSpeechDetail keeps the event mode and falls back to the aggregate', () => {
  const event = { source: 'claude', event: 'PostToolUse', mode: 'busy', tool: 'Bash', failed: true };
  assert.equal(toSpeechDetail(event, { mode: 'failed' }).mode, 'busy');
  assert.equal(toSpeechDetail({ source: 'codex', event: 'Odd' }, { mode: 'waiting' }).mode, 'waiting');
  assert.equal(toSpeechDetail({ source: 'codex' }, null).mode, 'idle');
  assert.equal(toSpeechDetail(event, { mode: 'failed' }).tool, 'Bash');
});
