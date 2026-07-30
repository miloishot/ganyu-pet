// Module C tests. No DOM, no Electron: the renderer's side effects are all
// injected, so a hand-rolled fake DOM is enough to drive boot() end to end.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROW,
  MODE_ROW,
  WALK_ROW,
  CELEBRATE_PULSE,
  FRAME_W,
  FRAME_H,
  FRAMES_PER_ROW,
  ROW_COUNT,
  SHEET_W,
  SHEET_H,
  DEFAULT_FPS,
  WALK_FPS,
  fpsForRow,
  baseRowFor,
  createAnimator,
  createSpriteRenderer,
  createInteractivity,
  clampMenu,
  menuLabels,
  boot,
} from '../src/renderer/pet.mjs';
import { createBubbles, BUBBLE_TTL_MS, BUBBLE_FADE_MS } from '../src/renderer/bubbles.mjs';

// ---------------------------------------------------------------------------
// fake DOM
// ---------------------------------------------------------------------------

function makeEl(id, extra = {}) {
  const listeners = new Map();
  const classes = new Set();
  const el = {
    id,
    hidden: false,
    textContent: '',
    dataset: {},
    style: {},
    children: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const arr = listeners.get(type);
      if (!arr) return;
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    },
    dispatch(type, init = {}) {
      const event = { type, target: el, defaultPrevented: false, ...init };
      event.preventDefault = () => {
        event.defaultPrevented = true;
      };
      for (const fn of [...(listeners.get(type) || [])]) fn(event);
      return event;
    },
    contains(node) {
      return node === el || el.children.includes(node);
    },
    querySelectorAll() {
      return el.children.filter((c) => c.dataset && c.dataset.action);
    },
    getBoundingClientRect() {
      return { width: 104, height: 66, left: 0, top: 0, right: 104, bottom: 66 };
    },
    ...extra,
  };
  return el;
}

function makeButton(action) {
  const btn = makeEl(`menu-${action}`);
  btn.dataset.action = action;
  btn.closest = (sel) => (sel === '[data-action]' ? btn : null);
  return btn;
}

function makeCtx() {
  const calls = [];
  return {
    calls,
    imageSmoothingEnabled: true,
    clearRect: (...a) => calls.push(['clearRect', ...a]),
    drawImage: (...a) => calls.push(['drawImage', ...a]),
  };
}

function makeCanvas() {
  const ctx = makeCtx();
  return makeEl('pet', { width: FRAME_W, height: FRAME_H, ctx, getContext: () => ctx });
}

function makeDom() {
  const canvas = makeCanvas();
  const bubble = makeEl('bubble');
  bubble.hidden = true;
  const menu = makeEl('menu');
  menu.hidden = true;
  menu.children = [makeButton('toggle-mute'), makeButton('toggle-pin'), makeButton('quit')];
  const documentElement = makeEl('html', { clientWidth: 256, clientHeight: 320 });
  const byId = { pet: canvas, bubble, menu };
  const doc = makeEl('#document', {
    documentElement,
    readyState: 'complete',
    getElementById: (id) => byId[id] || null,
  });
  const win = makeEl('#window', { devicePixelRatio: 1 });
  return { canvas, bubble, menu, documentElement, doc, win };
}

function makeGanyu(flagsPromise) {
  const calls = { setInteractive: [], menuAction: [], getFlags: 0 };
  let stateCb = null;
  let speakCb = null;
  return {
    calls,
    get stateCb() {
      return stateCb;
    },
    get speakCb() {
      return speakCb;
    },
    api: {
      onState(cb) {
        stateCb = cb;
        return () => {
          stateCb = null;
        };
      },
      onSpeak(cb) {
        speakCb = cb;
        return () => {
          speakCb = null;
        };
      },
      setInteractive(v) {
        calls.setInteractive.push(v);
      },
      menuAction(a) {
        calls.menuAction.push(a);
      },
      getFlags() {
        calls.getFlags += 1;
        return flagsPromise();
      },
    },
  };
}

class FakeImage {
  constructor() {
    this.onload = null;
    this.onerror = null;
    this._src = '';
  }
  set src(v) {
    this._src = v;
    queueMicrotask(() => {
      if (String(v).includes('broken')) this.onerror && this.onerror();
      else this.onload && this.onload();
    });
  }
  get src() {
    return this._src;
  }
}

const flush = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// grid + row map
// ---------------------------------------------------------------------------

test('grid constants match the installed spritesheet (1536x1872)', () => {
  assert.equal(FRAME_W, 192);
  assert.equal(FRAME_H, 208);
  assert.equal(FRAMES_PER_ROW, 8);
  assert.equal(ROW_COUNT, 9);
  assert.equal(SHEET_W, 1536);
  assert.equal(SHEET_H, 1872);
});

test('mode -> row map follows contracts.md', () => {
  assert.deepEqual(MODE_ROW, { idle: 0, busy: 7, waiting: 6, failed: 5 });
  assert.deepEqual(WALK_ROW, { right: 1, left: 2 });
  assert.deepEqual(CELEBRATE_PULSE, [4, 3]);
});

test('baseRowFor maps every mode and falls back to idle', () => {
  assert.equal(baseRowFor({ mode: 'idle' }), ROW.IDLE);
  assert.equal(baseRowFor({ mode: 'busy' }), ROW.BUSY);
  assert.equal(baseRowFor({ mode: 'waiting' }), ROW.WAITING);
  assert.equal(baseRowFor({ mode: 'failed' }), ROW.FAILED);
  assert.equal(baseRowFor({ mode: 'nonsense' }), ROW.IDLE);
  assert.equal(baseRowFor(null), ROW.IDLE);
  assert.equal(baseRowFor({}), ROW.IDLE);
});

test('walk direction wins over mode', () => {
  assert.equal(baseRowFor({ mode: 'idle', walk: { dir: 'right' } }), ROW.RUN_RIGHT);
  assert.equal(baseRowFor({ mode: 'idle', walk: { dir: 'left' } }), ROW.RUN_LEFT);
  assert.equal(baseRowFor({ mode: 'busy', walk: { dir: 'sideways' } }), ROW.BUSY);
  assert.equal(baseRowFor({ mode: 'busy', walk: null }), ROW.BUSY);
});

test('walk rows animate at 6 fps, everything else at 8', () => {
  assert.equal(fpsForRow(ROW.RUN_LEFT), WALK_FPS);
  assert.equal(fpsForRow(ROW.RUN_RIGHT), WALK_FPS);
  for (const row of [ROW.IDLE, ROW.WAVE, ROW.JUMP, ROW.FAILED, ROW.WAITING, ROW.BUSY]) {
    assert.equal(fpsForRow(row), DEFAULT_FPS);
  }
});

// ---------------------------------------------------------------------------
// animator
// ---------------------------------------------------------------------------

test('animator loops all 8 frames of a row at the row fps', () => {
  let t = 0;
  const a = createAnimator({ now: () => t });
  a.setState({ mode: 'busy' }, 0);
  assert.equal(a.row, ROW.BUSY);
  const step = 1000 / DEFAULT_FPS;
  for (let i = 1; i < FRAMES_PER_ROW; i += 1) {
    t = i * step;
    assert.equal(a.tick(t).frame, i, `frame ${i}`);
  }
  t = FRAMES_PER_ROW * step;
  assert.equal(a.tick(t).frame, 0, 'wraps to 0');
  assert.equal(a.row, ROW.BUSY, 'stays on the same row');
});

test('animator advances walk rows slower than default rows', () => {
  let t = 0;
  const a = createAnimator({ now: () => t });
  a.setState({ mode: 'idle', walk: { dir: 'left' } }, 0);
  assert.equal(a.row, ROW.RUN_LEFT);
  t = 1000 / DEFAULT_FPS; // 125ms — enough for 8fps, not for 6fps
  assert.equal(a.tick(t).frame, 0);
  t = 1000 / WALK_FPS; // ~167ms
  assert.equal(a.tick(t).frame, 1);
});

test('mode change restarts the row at frame 0', () => {
  let t = 0;
  const a = createAnimator({ now: () => t });
  a.setState({ mode: 'busy' }, 0);
  t = 3 * (1000 / DEFAULT_FPS);
  assert.equal(a.tick(t).frame, 3);
  a.setState({ mode: 'failed' }, t);
  assert.equal(a.row, ROW.FAILED);
  assert.equal(a.frame, 0);
});

test('celebrate pulses jump then wave exactly once, then returns to the base row', () => {
  let t = 0;
  const a = createAnimator({ now: () => t });
  const step = 1000 / DEFAULT_FPS;
  a.setState({ mode: 'idle' }, 0);

  a.setState({ mode: 'idle', celebrate: true }, 0);
  assert.equal(a.row, ROW.JUMP, 'jump first');
  assert.equal(a.pulsing, true);

  t = FRAMES_PER_ROW * step;
  assert.equal(a.tick(t).row, ROW.WAVE, 'then wave');
  assert.equal(a.pulsing, true);

  t = 2 * FRAMES_PER_ROW * step;
  assert.equal(a.tick(t).row, ROW.IDLE, 'back to base');
  assert.equal(a.pulsing, false);

  // No second pulse while celebrate stays true.
  a.setState({ mode: 'idle', celebrate: true }, t);
  assert.equal(a.row, ROW.IDLE);
  assert.equal(a.pulsing, false);

  // Falling then rising edge re-arms it.
  a.setState({ mode: 'idle', celebrate: false }, t);
  a.setState({ mode: 'idle', celebrate: true }, t);
  assert.equal(a.row, ROW.JUMP);
});

test('mid-pulse mode changes are deferred until the pulse finishes', () => {
  let t = 0;
  const a = createAnimator({ now: () => t });
  const step = 1000 / DEFAULT_FPS;
  a.setState({ mode: 'idle', celebrate: true }, 0);
  a.setState({ mode: 'busy', celebrate: true }, 0);
  assert.equal(a.row, ROW.JUMP, 'pulse is not interrupted');
  assert.equal(a.baseRow, ROW.BUSY);
  t = 2 * FRAMES_PER_ROW * step;
  assert.equal(a.tick(t).row, ROW.BUSY, 'lands on the newest base row');
});

test('a long stall resyncs instead of replaying every skipped frame', () => {
  let t = 0;
  const a = createAnimator({ now: () => t });
  a.setState({ mode: 'busy' }, 0);
  const before = a.tick(60 * 60 * 1000); // one hour of skipped frames
  assert.equal(before.row, ROW.BUSY);
  assert.ok(before.frame >= 0 && before.frame < FRAMES_PER_ROW);
});

// ---------------------------------------------------------------------------
// sprite renderer
// ---------------------------------------------------------------------------

test('sprite renderer crops the right grid cell and dedupes repeats', () => {
  const canvas = makeCanvas();
  const image = { fake: true };
  const r = createSpriteRenderer({ canvas, image, dpr: 1 });
  assert.equal(canvas.width, 192);
  assert.equal(canvas.height, 208);
  assert.equal(canvas.ctx.imageSmoothingEnabled, false);

  assert.equal(r.draw(ROW.FAILED, 3), true);
  const call = canvas.ctx.calls.find((c) => c[0] === 'drawImage');
  assert.deepEqual(call, ['drawImage', image, 3 * 192, 5 * 208, 192, 208, 0, 0, 192, 208]);

  assert.equal(r.draw(ROW.FAILED, 3), false, 'identical frame is skipped');
  assert.equal(r.draw(ROW.FAILED, 3, true), true, 'force redraws');
  r.invalidate();
  assert.equal(r.draw(ROW.FAILED, 3), true, 'invalidate clears the cache');
});

test('sprite renderer scales the backing store for DPR', () => {
  const canvas = makeCanvas();
  const r = createSpriteRenderer({ canvas, image: {}, dpr: 2 });
  assert.equal(canvas.width, 384);
  assert.equal(canvas.height, 416);
  r.draw(ROW.IDLE, 0);
  const call = canvas.ctx.calls.find((c) => c[0] === 'drawImage');
  assert.deepEqual(call.slice(6), [0, 0, 384, 416]);
});

// ---------------------------------------------------------------------------
// interactivity + menu geometry
// ---------------------------------------------------------------------------

test('interactivity toggles once per change and latches on menu open', () => {
  const calls = [];
  const i = createInteractivity({ setInteractive: (v) => calls.push(v) });
  i.sync();
  assert.deepEqual(calls, [false], 'baseline is click-through');

  i.setOverPet(true);
  i.setOverPet(true);
  assert.deepEqual(calls, [false, true], 'no duplicate calls');

  i.setMenuOpen(true);
  i.setOverPet(false);
  assert.deepEqual(calls, [false, true], 'menu keeps it interactive');
  assert.equal(i.interactive, true);

  i.setMenuOpen(false);
  assert.deepEqual(calls, [false, true, false]);

  i.setOverMenu(true);
  assert.equal(i.interactive, true);
  i.releaseAll();
  assert.equal(i.interactive, false);
  assert.deepEqual(calls, [false, true, false, true, false]);
});

test('clampMenu keeps the menu inside the window', () => {
  const view = { viewW: 256, viewH: 320, menuW: 104, menuH: 66 };
  assert.deepEqual(clampMenu({ x: 20, y: 30, ...view }), { x: 20, y: 30 });
  assert.deepEqual(clampMenu({ x: 250, y: 315, ...view }), { x: 148, y: 250 });
  assert.deepEqual(clampMenu({ x: -50, y: -50, ...view }), { x: 4, y: 4 });
  // Menu bigger than the window: pinned to the margin, never negative.
  assert.deepEqual(clampMenu({ x: 10, y: 10, menuW: 400, menuH: 400, viewW: 256, viewH: 320 }), {
    x: 4,
    y: 4,
  });
});

test('menu labels reflect the current flags', () => {
  assert.deepEqual(menuLabels({ muted: false, pinned: false }), {
    'toggle-mute': 'Mute',
    'toggle-pin': 'Pin',
    quit: 'Quit',
  });
  assert.deepEqual(menuLabels({ muted: true, pinned: true }), {
    'toggle-mute': 'Unmute',
    'toggle-pin': 'Unpin',
    quit: 'Quit',
  });
  assert.equal(menuLabels()['toggle-mute'], 'Mute');
});

// ---------------------------------------------------------------------------
// bubbles
// ---------------------------------------------------------------------------

test('bubble shows, replaces, then fades after 8s', () => {
  const el = makeEl('bubble');
  el.hidden = true;
  const timers = [];
  const b = createBubbles({
    el,
    schedule: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    cancel: (h) => {
      timers[h - 1] = null;
    },
  });

  assert.equal(b.show('  '), false, 'blank is ignored');
  assert.equal(b.show(null), false);
  assert.equal(el.hidden, true);

  assert.equal(b.show('  Working on it.  '), true);
  assert.equal(el.textContent, 'Working on it.', 'trimmed');
  assert.equal(el.hidden, false);
  assert.equal(el.classList.contains('is-visible'), true);
  assert.equal(b.visible, true);
  assert.equal(timers[0].ms, BUBBLE_TTL_MS);

  b.show('Newest line wins.');
  assert.equal(el.textContent, 'Newest line wins.');
  assert.equal(timers[0], null, 'old fade timer cancelled');

  timers[1].fn(); // 8s elapsed
  assert.equal(el.classList.contains('is-visible'), false, 'fade starts');
  assert.equal(el.hidden, false, 'still in the tree during the fade');
  assert.equal(b.visible, false);

  const clearTimer = timers[timers.length - 1];
  assert.equal(clearTimer.ms, BUBBLE_FADE_MS);
  clearTimer.fn();
  assert.equal(el.hidden, true);
  assert.equal(el.textContent, '');
});

test('bubble hide() tears down immediately', () => {
  const el = makeEl('bubble');
  const b = createBubbles({ el, schedule: () => 1, cancel: () => {} });
  b.show('hi');
  b.hide();
  assert.equal(el.hidden, true);
  assert.equal(el.textContent, '');
  assert.equal(b.visible, false);
});

test('createBubbles requires an element', () => {
  assert.throws(() => createBubbles({}), TypeError);
});

// ---------------------------------------------------------------------------
// boot() integration
// ---------------------------------------------------------------------------

async function bootHarness({ flags = { muted: false, pinned: false, spritePath: 'file:///sheet.webp' } } = {}) {
  const dom = makeDom();
  let resolveFlags;
  const pending = new Promise((r) => {
    resolveFlags = r;
  });
  let first = true;
  const g = makeGanyu(() => {
    if (first) {
      first = false;
      return pending;
    }
    return Promise.resolve(flags);
  });

  let t = 0;
  let pendingRaf = null;
  const booting = boot({
    win: dom.win,
    doc: dom.doc,
    ganyu: g.api,
    ImageCtor: FakeImage,
    raf: (fn) => {
      pendingRaf = fn;
      return 7;
    },
    cancelRaf: () => {
      pendingRaf = null;
    },
    now: () => t,
  });

  return {
    dom,
    g,
    booting,
    resolveFlags: () => resolveFlags(flags),
    stepRaf: () => {
      const fn = pendingRaf;
      pendingRaf = null;
      if (fn) fn();
    },
    hasRaf: () => pendingRaf !== null,
    setNow: (v) => {
      t = v;
    },
  };
}

test('boot subscribes to state before awaiting flags, so the first push is not lost', async () => {
  const h = await bootHarness();
  await flush();
  assert.ok(h.g.stateCb, 'onState registered before getFlags resolved');
  assert.ok(h.g.speakCb, 'onSpeak registered before getFlags resolved');
  assert.deepEqual(h.g.calls.setInteractive, [false], 'click-through baseline set');

  // Module A force-pushes on did-finish-load, which can beat the flags round-trip.
  h.g.stateCb({ mode: 'busy', sessionCount: 1, celebrate: false, walk: null });
  h.resolveFlags();
  const app = await h.booting;

  assert.ok(app, 'boot resolved');
  assert.equal(app.animator.row, ROW.BUSY, 'early state survived the await');
  assert.equal(app.renderer !== null, true, 'sprite loaded from flags.spritePath');
  app.dispose();
});

test('boot animates the canvas from the state feed', async () => {
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;

  h.g.stateCb({ mode: 'waiting', celebrate: false, walk: null });
  h.stepRaf();
  let call = h.dom.canvas.ctx.calls.filter((c) => c[0] === 'drawImage').pop();
  assert.deepEqual(call.slice(2, 6), [0, ROW.WAITING * FRAME_H, FRAME_W, FRAME_H]);

  h.g.stateCb({ mode: 'idle', celebrate: false, walk: { dir: 'right' } });
  h.setNow(1);
  h.stepRaf();
  call = h.dom.canvas.ctx.calls.filter((c) => c[0] === 'drawImage').pop();
  assert.deepEqual(call.slice(2, 6), [0, ROW.RUN_RIGHT * FRAME_H, FRAME_W, FRAME_H]);
  app.dispose();
});

test('boot flips interactivity on sprite hover', async () => {
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  h.g.calls.setInteractive.length = 0;

  h.dom.canvas.dispatch('mouseenter');
  assert.deepEqual(h.g.calls.setInteractive, [true]);
  h.dom.canvas.dispatch('mouseleave');
  assert.deepEqual(h.g.calls.setInteractive, [true, false]);

  // Pointer leaves the page without a canvas mouseleave: the latch still drops.
  h.dom.canvas.dispatch('mouseenter');
  h.dom.documentElement.dispatch('mouseleave');
  assert.deepEqual(h.g.calls.setInteractive, [true, false, true, false]);
  app.dispose();
});

test('right-click opens a clamped menu whose labels come from getFlags', async () => {
  const h = await bootHarness({ flags: { muted: true, pinned: false, spritePath: 'file:///s.webp' } });
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { menu, canvas } = h.dom;

  const ev = canvas.dispatch('contextmenu', { clientX: 240, clientY: 300 });
  assert.equal(ev.defaultPrevented, true, 'native menu suppressed');
  await flush();

  assert.equal(menu.hidden, false);
  assert.equal(menu.style.left, '148px', 'clamped inside the 256px window');
  assert.equal(menu.style.top, '250px');
  assert.equal(menu.style.visibility, '', 'revealed after measuring');
  assert.deepEqual(
    menu.children.map((b) => b.textContent),
    ['Unmute', 'Pin', 'Quit'],
  );
  assert.equal(app.interactivity.interactive, true, 'window is interactive while open');
  app.dispose();
});

test('menu clicks forward exactly the contract actions and close the menu', async () => {
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { menu, canvas } = h.dom;

  canvas.dispatch('contextmenu', { clientX: 10, clientY: 10 });
  await flush();
  menu.dispatch('click', { target: menu.children[0] });
  assert.deepEqual(h.g.calls.menuAction, ['toggle-mute']);
  assert.equal(menu.hidden, true, 'closes after acting');
  assert.equal(menu.children[0].textContent, 'Unmute', 'label flipped optimistically');
  assert.equal(app.interactivity.interactive, false, 'latch released on close');

  canvas.dispatch('contextmenu', { clientX: 10, clientY: 10 });
  await flush();
  menu.dispatch('click', { target: menu.children[2] });
  assert.deepEqual(h.g.calls.menuAction, ['toggle-mute', 'quit']);

  // A click on menu chrome (no data-action) is ignored.
  canvas.dispatch('contextmenu', { clientX: 10, clientY: 10 });
  await flush();
  menu.dispatch('click', { target: { closest: () => null } });
  assert.deepEqual(h.g.calls.menuAction, ['toggle-mute', 'quit']);
  assert.equal(menu.hidden, false);
  app.dispose();
});

test('menu closes on outside mousedown, Escape and window blur', async () => {
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { menu, canvas, doc, win } = h.dom;

  const open = async () => {
    canvas.dispatch('contextmenu', { clientX: 10, clientY: 10 });
    await flush();
    assert.equal(menu.hidden, false);
  };

  await open();
  doc.dispatch('mousedown', { target: menu.children[1] });
  assert.equal(menu.hidden, false, 'inside clicks keep it open');
  doc.dispatch('mousedown', { target: canvas });
  assert.equal(menu.hidden, true);

  await open();
  doc.dispatch('keydown', { key: 'Escape' });
  assert.equal(menu.hidden, true);

  await open();
  win.dispatch('blur');
  assert.equal(menu.hidden, true);

  // Second right-click toggles it closed.
  await open();
  canvas.dispatch('contextmenu', { clientX: 10, clientY: 10 });
  assert.equal(menu.hidden, true);
  app.dispose();
});

test('speak payloads land in the bubble; junk is ignored', async () => {
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;

  h.g.speakCb({ text: 'Tea first, then the build.' });
  assert.equal(h.dom.bubble.textContent, 'Tea first, then the build.');
  assert.equal(h.dom.bubble.hidden, false);
  h.g.speakCb(null);
  h.g.speakCb({});
  assert.equal(h.dom.bubble.textContent, 'Tea first, then the build.', 'kept the last real line');
  app.dispose();
  assert.equal(h.dom.bubble.hidden, true, 'dispose clears the bubble');
});

test('a missing or broken spritesheet degrades instead of throwing', async () => {
  for (const spritePath of [undefined, 'file:///broken.webp']) {
    const dom = makeDom();
    const g = makeGanyu(() => Promise.resolve({ muted: false, pinned: false, spritePath }));
    const app = await boot({
      win: dom.win,
      doc: dom.doc,
      ganyu: g.api,
      ImageCtor: FakeImage,
      raf: () => 1,
      cancelRaf: () => {},
      now: () => 0,
    });
    assert.ok(app, `boot survived spritePath=${spritePath}`);
    assert.equal(app.renderer, null);
    assert.equal(dom.canvas.dataset.broken, '1');
    // The state feed still works, so a later reload has correct rows.
    g.stateCb({ mode: 'failed', celebrate: false, walk: null });
    assert.equal(app.animator.row, ROW.FAILED);
    app.dispose();
  }
});

test('boot no-ops without a DOM or without the preload bridge', async () => {
  assert.equal(await boot({ win: undefined, doc: undefined, ganyu: undefined }), null);
  const dom = makeDom();
  assert.equal(await boot({ win: dom.win, doc: dom.doc, ganyu: undefined }), null);
  const bare = makeEl('#document', { getElementById: () => null });
  const g = makeGanyu(() => Promise.resolve({}));
  assert.equal(await boot({ win: dom.win, doc: bare, ganyu: g.api }), null);
});

test('dispose detaches every listener and restores click-through', async () => {
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  assert.ok(h.dom.canvas.listenerCount('mouseenter') > 0);

  h.dom.canvas.dispatch('mouseenter');
  app.dispose();
  assert.equal(h.dom.canvas.listenerCount('mouseenter'), 0);
  assert.equal(h.dom.canvas.listenerCount('contextmenu'), 0);
  assert.equal(h.dom.menu.listenerCount('click'), 0);
  assert.equal(h.dom.documentElement.listenerCount('mouseleave'), 0);
  assert.equal(h.g.calls.setInteractive.at(-1), false, 'window is click-through again');
  assert.equal(h.hasRaf(), false, 'frame loop stopped');
});
