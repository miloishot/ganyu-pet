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
  ROW_FRAMES,
  ROW_COUNT,
  SHEET_W,
  SHEET_H,
  DEFAULT_FPS,
  WALK_FPS,
  fpsForRow,
  framesForRow,
  baseRowFor,
  createAnimator,
  createSpriteRenderer,
  createInteractivity,
  clampMenu,
  menuLabels,
  CHAT_FAILED_LINE,
  boot,
} from '../src/renderer/pet.mjs';
import {
  createBubbles,
  BUBBLE_TTL_MS,
  BUBBLE_FADE_MS,
  BUBBLE_PRIORITY,
  THINKING_CLASS,
  THINKING_MARK,
} from '../src/renderer/bubbles.mjs';

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

function makeInput(id) {
  const input = makeEl(id, { value: '' });
  input.focused = false;
  input.focus = () => {
    input.focused = true;
  };
  input.blur = () => {
    input.focused = false;
  };
  return input;
}

/**
 * The <audio> element she is played through — the four members
 * `createVoicePlayer` touches, and a log of every source it was handed. Present
 * in the harness because her voice now arrives *with* her words rather than
 * seconds behind them, so "did the bubble and the sound happen together" is a
 * question this file has to be able to ask.
 */
function makeAudioEl() {
  const el = makeEl('voice', {
    played: [],
    pauses: 0,
    loads: 0,
    src: '',
    pause() {
      el.pauses += 1;
    },
    play() {
      el.played.push(el.src);
      return Promise.resolve();
    },
    load() {
      el.loads += 1;
    },
    removeAttribute() {
      el.src = '';
    },
  });
  return el;
}

function makeDom() {
  const canvas = makeCanvas();
  const bubble = makeEl('bubble');
  bubble.hidden = true;
  const menu = makeEl('menu');
  menu.hidden = true;
  // Same order as index.html: Mute / Pin / Come here / Quit.
  menu.children = [
    makeButton('toggle-mute'),
    makeButton('toggle-pin'),
    makeButton('home'),
    makeButton('quit'),
  ];
  const chatInput = makeInput('chat-input');
  const chat = makeEl('chat');
  chat.hidden = true;
  chat.children = [chatInput];
  const documentElement = makeEl('html', { clientWidth: 256, clientHeight: 320 });
  const voice = makeAudioEl();
  const byId = { pet: canvas, bubble, menu, chat, 'chat-input': chatInput, voice };
  const doc = makeEl('#document', {
    documentElement,
    readyState: 'complete',
    getElementById: (id) => byId[id] || null,
  });
  const win = makeEl('#window', { devicePixelRatio: 1 });
  return { canvas, bubble, menu, chat, chatInput, voice, documentElement, doc, win };
}

/**
 * @param {() => Promise} flagsPromise
 * @param {{reply?: any}} [opts] `reply` is what sendChat resolves to; a function
 *   is called with the text so a test can gate or fail a single exchange.
 */
function makeGanyu(flagsPromise, { reply = 'Of course.' } = {}) {
  const calls = {
    setInteractive: [],
    menuAction: [],
    getFlags: 0,
    sendChat: [],
    setFocused: [],
    drag: [],
    /** `{menu}` on every open and close — main arms Escape off this. */
    overlayOpen: [],
  };
  let stateCb = null;
  let speakCb = null;
  let audioCb = null;
  let dismissCb = null;
  return {
    calls,
    /** Main asking the overlay to close, for the two dismissals only it can see. */
    get dismissCb() {
      return dismissCb;
    },
    get stateCb() {
      return stateCb;
    },
    get speakCb() {
      return speakCb;
    },
    /** The late-audio channel: a line already on screen, catching up with itself. */
    get audioCb() {
      return audioCb;
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
      onAudio(cb) {
        audioCb = cb;
        return () => {
          audioCb = null;
        };
      },
      onDismiss(cb) {
        dismissCb = cb;
        return () => {
          dismissCb = null;
        };
      },
      setInteractive(v) {
        calls.setInteractive.push(v);
      },
      setOverlayOpen(open) {
        calls.overlayOpen.push({ menu: Boolean(open && open.menu) });
      },
      menuAction(a) {
        calls.menuAction.push(a);
      },
      drag(phase) {
        calls.drag.push(phase);
      },
      getFlags() {
        calls.getFlags += 1;
        return flagsPromise();
      },
      sendChat(text) {
        calls.sendChat.push(text);
        return typeof reply === 'function' ? reply(text) : Promise.resolve(reply);
      },
      setFocused(v) {
        calls.setFocused.push(v);
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

/** A reply the test holds open, so the pending bubble can be inspected. */
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

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

test('per-row frame counts are the measured ones, with a full-row fallback', () => {
  assert.deepEqual(ROW_FRAMES, [6, 8, 8, 4, 5, 8, 6, 6, 6]);
  assert.equal(ROW_FRAMES.length, ROW_COUNT, 'one count per row');
  assert.equal(Object.isFrozen(ROW_FRAMES), true);

  assert.equal(framesForRow(ROW.IDLE), 6, 'cols 6-7 are transparent');
  assert.equal(framesForRow(ROW.RUN_RIGHT), 8);
  assert.equal(framesForRow(ROW.WAVE), 4);
  assert.equal(framesForRow(ROW.JUMP), 5);

  // Unknown rows fall back to the grid width rather than yielding undefined.
  assert.equal(framesForRow(ROW_COUNT), FRAMES_PER_ROW);
  assert.equal(framesForRow(-1), FRAMES_PER_ROW);
  assert.equal(framesForRow(undefined), FRAMES_PER_ROW);
});

test('mode -> row map follows contracts.md', () => {
  assert.deepEqual(MODE_ROW, { idle: 0, busy: 8, waiting: 6, failed: 5 });
  assert.deepEqual(WALK_ROW, { right: 1, left: 2 });
  assert.deepEqual(CELEBRATE_PULSE, [4, 3]);
});

test('baseRowFor maps every mode and falls back to idle', () => {
  assert.equal(baseRowFor({ mode: 'idle' }), ROW.IDLE);
  assert.equal(baseRowFor({ mode: 'busy' }), ROW.REVIEW);
  assert.equal(baseRowFor({ mode: 'waiting' }), ROW.WAITING);
  assert.equal(baseRowFor({ mode: 'failed' }), ROW.FAILED);
  assert.equal(baseRowFor({ mode: 'nonsense' }), ROW.IDLE);
  assert.equal(baseRowFor(null), ROW.IDLE);
  assert.equal(baseRowFor({}), ROW.IDLE);
});

test('walk direction wins over mode', () => {
  assert.equal(baseRowFor({ mode: 'idle', walk: { dir: 'right' } }), ROW.RUN_RIGHT);
  assert.equal(baseRowFor({ mode: 'idle', walk: { dir: 'left' } }), ROW.RUN_LEFT);
  assert.equal(baseRowFor({ mode: 'busy', walk: { dir: 'left' } }), ROW.RUN_LEFT);
  assert.equal(baseRowFor({ mode: 'busy', walk: { dir: 'sideways' } }), ROW.REVIEW);
  assert.equal(baseRowFor({ mode: 'busy', walk: null }), ROW.REVIEW);
});

test('stationary busy uses the standing review row, not the run-in-place one', () => {
  assert.equal(baseRowFor({ mode: 'busy' }), ROW.REVIEW);
  assert.equal(baseRowFor({ mode: 'busy', walk: { dir: 'left' } }), ROW.RUN_LEFT, 'walk still wins');
  assert.equal(
    Object.values(MODE_ROW).includes(ROW.BUSY),
    false,
    'row 7 runs on the spot, so no mode may reach it',
  );
});

test('walk rows animate at 6 fps, everything else at 8', () => {
  assert.equal(fpsForRow(ROW.RUN_LEFT), WALK_FPS);
  assert.equal(fpsForRow(ROW.RUN_RIGHT), WALK_FPS);
  for (const row of [ROW.IDLE, ROW.WAVE, ROW.JUMP, ROW.FAILED, ROW.WAITING, ROW.BUSY, ROW.REVIEW]) {
    assert.equal(fpsForRow(row), DEFAULT_FPS);
  }
});

// ---------------------------------------------------------------------------
// animator
// ---------------------------------------------------------------------------

test("animator loops a row's real frames at the row fps", () => {
  let t = 0;
  const a = createAnimator({ now: () => t });
  a.setState({ mode: 'busy' }, 0);
  assert.equal(a.row, ROW.REVIEW);
  const frames = framesForRow(ROW.REVIEW); // 6, not the full 8
  const step = 1000 / DEFAULT_FPS;
  for (let i = 1; i < frames; i += 1) {
    t = i * step;
    assert.equal(a.tick(t).frame, i, `frame ${i}`);
  }
  t = frames * step;
  assert.equal(a.tick(t).frame, 0, 'wraps to 0');
  assert.equal(a.row, ROW.REVIEW, 'stays on the same row');
});

test('a whole busy loop never lands on the run-in-place row', () => {
  assert.equal(ROW_FRAMES[ROW.REVIEW], 6, 'row 8 has 6 real frames');
  let t = 0;
  const a = createAnimator({ now: () => t });
  const step = 1000 / DEFAULT_FPS;
  const seen = [a.setState({ mode: 'busy' }, 0)];
  for (let i = 1; i <= 12; i += 1) {
    t = i * step;
    seen.push(a.tick(t));
  }
  for (const { row } of seen) assert.notEqual(row, ROW.BUSY, 'row 7 must be unreachable');
  assert.equal(
    seen.every((s) => s.row === ROW.REVIEW),
    true,
    'stays on the standing pose',
  );
  assert.deepEqual(
    seen.map((s) => s.frame),
    [0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5, 0],
    'two clean loops of 6',
  );
});

test('idle never draws the two empty trailing cells', () => {
  let t = 0;
  const a = createAnimator({ now: () => t });
  a.setState({ mode: 'idle' }, 0);
  const step = 1000 / DEFAULT_FPS;
  const seen = [a.frame];
  for (let i = 1; i <= 12; i += 1) {
    t = i * step;
    seen.push(a.tick(t).frame);
  }
  // Two clean loops of 6: the blink came from frames 6 and 7 rendering blank.
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5, 0]);
  assert.equal(a.row, ROW.IDLE, 'idle never leaves its row');
});

test('rows that do fill the sheet still run all 8 frames', () => {
  const cases = [
    [ROW.RUN_RIGHT, { mode: 'idle', walk: { dir: 'right' } }],
    [ROW.RUN_LEFT, { mode: 'idle', walk: { dir: 'left' } }],
    [ROW.FAILED, { mode: 'failed' }],
  ];
  for (const [row, state] of cases) {
    assert.equal(framesForRow(row), FRAMES_PER_ROW, `row ${row} is full`);
    let t = 0;
    const a = createAnimator({ now: () => t });
    a.setState(state, 0);
    assert.equal(a.row, row);
    const step = 1000 / fpsForRow(row);
    // +1ms of slack: the walk step (1000/6) is not exact in binary.
    for (let i = 1; i < FRAMES_PER_ROW; i += 1) {
      t = i * step + 1;
      assert.equal(a.tick(t).frame, i, `row ${row} frame ${i}`);
    }
    t = FRAMES_PER_ROW * step + 1;
    assert.equal(a.tick(t).frame, 0, `row ${row} wraps at 8`);
  }
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

  t = framesForRow(ROW.JUMP) * step;
  assert.equal(a.tick(t).row, ROW.WAVE, 'then wave');
  assert.equal(a.pulsing, true);

  t = (framesForRow(ROW.JUMP) + framesForRow(ROW.WAVE)) * step;
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

test('the pulse hands over on each row\'s own last frame', () => {
  let t = 0;
  const a = createAnimator({ now: () => t });
  const step = 1000 / DEFAULT_FPS;
  const jump = framesForRow(ROW.JUMP); // 5
  const wave = framesForRow(ROW.WAVE); // 4
  a.setState({ mode: 'idle', celebrate: true }, 0);

  for (let i = 1; i < jump; i += 1) {
    t = i * step;
    assert.deepEqual(a.tick(t), { row: ROW.JUMP, frame: i });
  }
  t = jump * step;
  assert.deepEqual(a.tick(t), { row: ROW.WAVE, frame: 0 }, 'jump ends after 5, not 8');

  for (let i = 1; i < wave; i += 1) {
    t = (jump + i) * step;
    assert.deepEqual(a.tick(t), { row: ROW.WAVE, frame: i });
  }
  t = (jump + wave) * step;
  assert.deepEqual(a.tick(t), { row: ROW.IDLE, frame: 0 }, 'wave ends after 4, not 8');
  assert.equal(a.pulsing, false);
});

test('mid-pulse mode changes are deferred until the pulse finishes', () => {
  let t = 0;
  const a = createAnimator({ now: () => t });
  const step = 1000 / DEFAULT_FPS;
  a.setState({ mode: 'idle', celebrate: true }, 0);
  a.setState({ mode: 'busy', celebrate: true }, 0);
  assert.equal(a.row, ROW.JUMP, 'pulse is not interrupted');
  assert.equal(a.baseRow, ROW.REVIEW);
  t = (framesForRow(ROW.JUMP) + framesForRow(ROW.WAVE)) * step;
  assert.equal(a.tick(t).row, ROW.REVIEW, 'lands on the newest base row');
  assert.equal(a.frame, 0, 'the new row starts at frame 0, never mid-row');
});

test('a long stall resyncs instead of replaying every skipped frame', () => {
  let t = 0;
  const a = createAnimator({ now: () => t });
  a.setState({ mode: 'busy' }, 0);
  const before = a.tick(60 * 60 * 1000); // one hour of skipped frames
  assert.equal(before.row, ROW.REVIEW);
  assert.ok(before.frame >= 0 && before.frame < framesForRow(ROW.REVIEW));
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
    'toggle-call': 'Talk in calls',
    home: 'Come here',
    quit: 'Quit',
  });
  assert.deepEqual(menuLabels({ muted: true, pinned: true }), {
    'toggle-mute': 'Unmute',
    'toggle-pin': 'Unpin',
    'toggle-call': 'Talk in calls',
    home: 'Come here',
    quit: 'Quit',
  });
  assert.equal(menuLabels()['toggle-mute'], 'Mute');
  // Computed from the live flag, never stored as text.
  assert.equal(menuLabels({ callMode: true })['toggle-call'], 'Stop talking in calls');
  assert.equal(menuLabels({ callMode: false })['toggle-call'], 'Talk in calls');
});

test('every MENU_ACTIONS entry has a label, or its button renders blank', () => {
  // The recall action was reachable over IPC and unlabelled for two modules'
  // worth of work: main filtered `home` through, and the renderer drew nothing.
  // paintMenu only writes a label it finds, so a missing one is a blank button
  // rather than a crash — which is exactly why it went unnoticed.
  const labels = menuLabels();
  for (const action of ['toggle-mute', 'toggle-pin', 'toggle-call', 'home', 'quit']) {
    assert.equal(typeof labels[action], 'string', `${action} has a label`);
    assert.ok(labels[action].trim() !== '', `${action}'s label is not blank`);
  }
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

test('thinking() raises the wordless pending state at chat priority', () => {
  const el = makeEl('bubble');
  el.hidden = true;
  const b = createBubbles({ el, schedule: () => 1, cancel: () => {} });

  assert.equal(b.thinking(), true);
  assert.equal(el.textContent, THINKING_MARK, 'dots, not words');
  assert.equal(el.hidden, false, 'he can see something is happening');
  assert.equal(el.classList.contains(THINKING_CLASS), true);
  assert.equal(b.isThinking, true);
  assert.equal(b.priority, BUBBLE_PRIORITY.chat, 'holds the bubble like the old sentence did');

  // Which is the point of chat priority: a hook line cannot interrupt her.
  assert.equal(b.show('Running npm test…'), false, 'ambient refused mid-thought');
  assert.equal(el.textContent, THINKING_MARK);
  assert.equal(b.isThinking, true);
});

test('anything the bubble shows next takes the dots down', () => {
  // The guarantee lives here rather than at the call sites: the reply, the
  // failure line, teardown and a later ambient line all clear it without anyone
  // having to remember to, so nothing can leave the bubble pulsing at a finished
  // answer.
  const make = () => {
    const el = makeEl('bubble');
    const timers = [];
    const b = createBubbles({
      el,
      schedule: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      cancel: (handle) => {
        timers[handle - 1] = null;
      },
    });
    return { el, b, timers };
  };

  const answered = make();
  answered.b.thinking();
  answered.b.show('Of course.', { priority: BUBBLE_PRIORITY.chat });
  assert.equal(answered.b.isThinking, false, 'a reply clears the pulse');
  assert.equal(answered.el.textContent, 'Of course.');

  const torn = make();
  torn.b.thinking();
  torn.b.hide();
  assert.equal(torn.b.isThinking, false, 'teardown clears it');

  // The case no call site would have remembered: the reply took longer than the
  // bubble's own 8s, so the hold lapsed and a hook line got the bubble first.
  const ambient = make();
  ambient.b.thinking();
  ambient.timers[0].fn();
  assert.equal(ambient.b.show('Running npm test…'), true, 'ambient gets in once the hold ends');
  assert.equal(ambient.b.isThinking, false, 'and it clears the pulse too');
  assert.equal(ambient.el.textContent, 'Running npm test…');
});

test('the fade timer clears the pending class along with the text', () => {
  const el = makeEl('bubble');
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

  b.thinking();
  assert.equal(b.isThinking, true);

  timers[0].fn(); // 8s: a reply slower than the bubble's own lifetime
  assert.equal(b.visible, false, 'the bubble starts to fade');
  timers[timers.length - 1].fn(); // fade done
  assert.equal(el.textContent, '');
  assert.equal(b.isThinking, false, 'a faded bubble is not left holding the class');

  // And the reply that finally arrives shows as an ordinary line.
  b.show('Sorry — that took a while.', { priority: BUBBLE_PRIORITY.chat });
  assert.equal(el.classList.contains(THINKING_CLASS), false);
});

// ---------------------------------------------------------------------------
// boot() integration
// ---------------------------------------------------------------------------

async function bootHarness({
  flags = { muted: false, pinned: false, spritePath: 'file:///sheet.webp' },
  reply = 'Of course.',
  setup = null,
} = {}) {
  const dom = makeDom();
  if (setup) setup(dom);
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
  }, { reply });

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
  assert.equal(app.animator.row, ROW.REVIEW, 'early state survived the await');
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
    ['Unmute', 'Pin', 'Come here', 'Quit'],
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
  menu.dispatch('click', { target: menu.children[3] });
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
  // Anywhere in the window that is not the menu and not the sprite: the bubble,
  // or the transparent corners, whose hit target is the body. The sprite is
  // deliberately not this case — mousedown on her is the first half of a gesture
  // the canvas handlers finish, and the test below is what covers it.
  doc.dispatch('mousedown', { target: h.dom.bubble });
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

// ---------------------------------------------------------------------------
// closing the menu — the paths that were dead
// ---------------------------------------------------------------------------
//
// The owner could not close the menu and had to restart the app. The reason is
// that of the five ways out a user would try, four could not work:
//
//   Escape                   the window is focusable:false, so no keydown ever
//                            reaches the DOM (main answers this — see the
//                            escape-hatch tests in window.test.mjs)
//   clicking away            a window that cannot take focus cannot blur, and a
//                            click outside its 256x320 rect is not its event
//   right-clicking the menu  preventDefault() and nothing else
//   right-clicking her       mousedown closed it, then contextmenu reopened it
//   clicking her             closed it and opened the chat strip, which reads as
//                            being handed something else rather than dismissed
//
// The Escape and blur handlers stay wired regardless: the chat flow lifts
// focusability, so both are live there, and the tests above still hold them.

test('right-clicking her toggles the menu shut, in the real browser event order', async () => {
  // The bug in one test. On Windows the right button fires mousedown before
  // contextmenu, and the document handler used to close the menu on that
  // mousedown — so contextmenu found it hidden and opened it straight back up.
  // The fake DOM does not bubble, which is exactly why the old toggle test
  // passed against a toggle that could not work.
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { menu, canvas, doc } = h.dom;

  const rightClickOnSprite = async () => {
    doc.dispatch('mousedown', { target: canvas, button: 2 }); // bubbled
    canvas.dispatch('mousedown', { button: 2 });
    canvas.dispatch('contextmenu', { clientX: 40, clientY: 40 });
    await flush();
  };

  await rightClickOnSprite();
  assert.equal(menu.hidden, false, 'first right-click opens it');

  await rightClickOnSprite();
  assert.equal(menu.hidden, true, 'and the second one closes it, rather than moving it');
  assert.equal(app.interactivity.interactive, false, 'the latch goes with it');

  await rightClickOnSprite();
  assert.equal(menu.hidden, false, 'still a toggle, not a one-shot');
  app.dispose();
});

test('right-clicking the menu itself closes it', async () => {
  // The single most natural recovery — right-click the thing a right-click
  // produced — and it used to do nothing at all. It matters most in the case
  // that goes wrong: the menu opens at the cursor, so it is normally sitting
  // over the sprite, and a second right-click aimed at her lands on the menu.
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { menu, canvas } = h.dom;

  canvas.dispatch('contextmenu', { clientX: 10, clientY: 10 });
  await flush();
  assert.equal(menu.hidden, false);

  const ev = menu.dispatch('contextmenu', { clientX: 12, clientY: 12 });
  assert.equal(ev.defaultPrevented, true, 'Chromium\'s own menu is still suppressed');
  assert.equal(menu.hidden, true, 'and it closes');
  assert.equal(app.interactivity.interactive, false);

  // A menu button is inside the menu, and gets the same treatment.
  canvas.dispatch('contextmenu', { clientX: 10, clientY: 10 });
  await flush();
  menu.dispatch('contextmenu', { target: menu.children[2] });
  assert.equal(menu.hidden, true, 'anywhere on the menu, not just its padding');
  assert.deepEqual(h.g.calls.menuAction, [], 'and closing is not acting');
  app.dispose();
});

test('clicking her closes an open menu, and does not open the chat strip instead', async () => {
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { menu, canvas, chat, doc } = h.dom;

  canvas.dispatch('contextmenu', { clientX: 10, clientY: 10 });
  await flush();
  assert.equal(menu.hidden, false);

  doc.dispatch('mousedown', { target: canvas, button: 0 }); // bubbled
  canvas.dispatch('mousedown', { button: 0 });
  doc.dispatch('mouseup', { button: 0 });
  canvas.dispatch('click', {});

  assert.equal(menu.hidden, true, 'the click dismissed it');
  assert.equal(chat.hidden, true, 'and was spent doing so — nothing else appeared');
  assert.equal(app.interactivity.interactive, false);

  // The very next click is an ordinary one: dismissal costs exactly one.
  canvas.dispatch('mousedown', { button: 0 });
  doc.dispatch('mouseup', { button: 0 });
  canvas.dispatch('click', {});
  assert.equal(chat.hidden, false, 'the chat strip still opens when no menu is up');
  app.dispose();
});

test('a mousedown on her never pre-empts the gesture the canvas handlers finish', async () => {
  // Both canvas rules in the document handler are the same rule: her mousedown
  // is half a gesture, and acting on it here breaks the other half. For the chat
  // strip it reopened an input he had just typed into; for the menu it made the
  // right-click toggle unreachable.
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { menu, canvas, chat, chatInput, doc } = h.dom;

  canvas.dispatch('contextmenu', { clientX: 10, clientY: 10 });
  await flush();
  doc.dispatch('mousedown', { target: canvas, button: 2 });
  assert.equal(menu.hidden, false, 'the menu survives her mousedown');

  app.menu.close();
  canvas.dispatch('click', {});
  chatInput.value = 'still typing';
  doc.dispatch('mousedown', { target: canvas, button: 0 });
  assert.equal(chat.hidden, false, 'and so does the input strip');
  assert.equal(chatInput.value, 'still typing');
  app.dispose();
});

// ---------------------------------------------------------------------------
// the dismissal contract with main
// ---------------------------------------------------------------------------

test('the menu tells main every time it opens and closes', async () => {
  // This is what arms and releases the global Escape hook. A close that forgot
  // to report would leave Escape belonging to this app with no menu to close —
  // strictly worse than the bug being fixed, so every close path must report.
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
  assert.deepEqual(h.g.calls.overlayOpen, [{ menu: true }]);

  // Every way out, each of which must produce exactly one `false`.
  const closes = [
    ['a menu action', () => menu.dispatch('click', { target: menu.children[0] })],
    ['right-click on the menu', () => menu.dispatch('contextmenu', {})],
    ['outside mousedown', () => doc.dispatch('mousedown', { target: h.dom.bubble })],
    ['clicking her', () => canvas.dispatch('click', {})],
    ['Escape from main', () => h.g.dismissCb('escape')],
    ['the pointer-leave grace', () => h.g.dismissCb('pointer-left')],
    ['blur', () => win.dispatch('blur')],
    ['a drag starting', () => h.g.stateCb({ mode: 'idle', dragging: true, walk: null })],
  ];
  for (const [label, close] of closes) {
    h.g.calls.overlayOpen.length = 0;
    if (menu.hidden) await open();
    h.g.calls.overlayOpen.length = 0;
    close();
    assert.equal(menu.hidden, true, `${label} closes the menu`);
    assert.deepEqual(h.g.calls.overlayOpen, [{ menu: false }], `${label} reports the close`);
    h.g.stateCb({ mode: 'idle', dragging: false, walk: null });
  }

  await open();
  h.g.calls.overlayOpen.length = 0;
  app.dispose();
  assert.deepEqual(h.g.calls.overlayOpen, [{ menu: false }], 'teardown reports it too');
});

test('a dismissal from main closes the menu, and only for a reason it recognises', async () => {
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { menu, canvas } = h.dom;

  canvas.dispatch('contextmenu', { clientX: 10, clientY: 10 });
  await flush();

  for (const junk of ['quit', '', null, undefined, 'ESCAPE', { reason: 'escape' }]) {
    h.g.dismissCb(junk);
    assert.equal(menu.hidden, false, `${String(junk)} is not a dismissal`);
  }

  h.g.dismissCb('escape');
  assert.equal(menu.hidden, true);
  assert.equal(app.interactivity.interactive, false, 'and the latch went with it');
  app.dispose();
});

test('Escape takes the menu down first, and leaves a half-typed message alone', async () => {
  // Main's Escape hook is armed while the menu is open, and it outranks the
  // input's own keydown — so with both up it has to behave like a layered
  // dismissal rather than clearing the screen.
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { menu, canvas, chat, chatInput } = h.dom;

  canvas.dispatch('click', {});
  chatInput.value = 'half a thought';
  canvas.dispatch('contextmenu', { clientX: 10, clientY: 10 });
  await flush();
  assert.equal(menu.hidden, false);
  assert.equal(chat.hidden, false, 'both are up');

  h.g.dismissCb('escape');
  assert.equal(menu.hidden, true, 'the topmost thing goes');
  assert.equal(chat.hidden, false, 'and what he was writing survives');
  assert.equal(chatInput.value, 'half a thought');

  h.g.dismissCb('escape');
  assert.equal(chat.hidden, true, 'a second Escape closes the input');
  app.dispose();
});

test('the pointer-leave grace never throws away what he is typing', async () => {
  // He walks the cursor off a 256px window constantly while typing — he is
  // looking at the keyboard. The grace period exists for an abandoned menu, and
  // it must not become a way to lose a message.
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { chat, chatInput, canvas } = h.dom;

  canvas.dispatch('click', {});
  chatInput.value = 'most of a sentence';

  h.g.dismissCb('pointer-left');
  assert.equal(chat.hidden, false, 'the input strip is not the menu');
  assert.equal(chatInput.value, 'most of a sentence');
  assert.equal(app.interactivity.interactive, true, 'and the overlay stays reachable');
  app.dispose();
});

// ---------------------------------------------------------------------------
// the hard invariant
// ---------------------------------------------------------------------------

test('a menu that has lost the latch keeping it reachable closes itself', async () => {
  // The state that costs a restart: the menu is still painted, but the latch
  // that held the window mouse-opaque is gone, so every click now passes through
  // to the desktop. Nothing on it can be clicked, and no event that could close
  // it will ever be delivered again. It is not allowed to survive a frame.
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { menu, canvas } = h.dom;

  canvas.dispatch('contextmenu', { clientX: 10, clientY: 10 });
  await flush();
  assert.equal(menu.hidden, false);
  assert.equal(app.interactivity.interactive, true);

  // Reach behind the renderer and drop the latch on its own, which is exactly
  // what a future `releaseAll()` in the wrong place would do.
  app.interactivity.releaseAll();
  assert.equal(app.menu.guard(), true, 'the guard caught it');
  assert.equal(menu.hidden, true, 'and closed the menu rather than stranding it');
  assert.deepEqual(h.g.calls.overlayOpen.at(-1), { menu: false }, 'main told, so Escape is released');

  assert.equal(app.menu.guard(), false, 'and it is quiet when nothing is wrong');
  app.dispose();
});

test('the guard runs on the frame loop and on every state push', async () => {
  // Two carriers because neither covers everything: the frame loop does not
  // exist when the spritesheet failed to load, and state pushes are deduped.
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { menu, canvas } = h.dom;

  canvas.dispatch('contextmenu', { clientX: 10, clientY: 10 });
  await flush();
  app.interactivity.releaseAll();
  h.stepRaf();
  assert.equal(menu.hidden, true, 'the frame loop swept it up');

  canvas.dispatch('contextmenu', { clientX: 10, clientY: 10 });
  await flush();
  app.interactivity.releaseAll();
  h.g.stateCb({ mode: 'busy', celebrate: false, walk: null });
  assert.equal(menu.hidden, true, 'and so does a state push');
  app.dispose();
});

test('releaseAll never leaves a visible surface on a click-through window', async () => {
  // The watchdog path: the pointer left the page. It stands down for an open
  // menu, an open input and a live drag — but when it does fire, nothing may be
  // left painted on a window that no longer accepts a click.
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { menu, chat, canvas, documentElement } = h.dom;

  canvas.dispatch('contextmenu', { clientX: 10, clientY: 10 });
  await flush();
  documentElement.dispatch('mouseleave');
  assert.equal(menu.hidden, false, 'an open menu holds the watchdog off');
  assert.equal(app.interactivity.interactive, true);

  app.menu.close();
  canvas.dispatch('click', {});
  documentElement.dispatch('mouseleave');
  assert.equal(chat.hidden, false, 'so does an open input');
  assert.equal(app.interactivity.interactive, true);

  canvas.dispatch('click', {}); // closes the strip
  documentElement.dispatch('mouseleave');
  assert.equal(app.interactivity.interactive, false, 'and now it fires');
  assert.equal(menu.hidden, true);
  assert.equal(chat.hidden, true);
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

// ------------------------------------------------ her words and her voice, together
//
// Main holds a line back until its audio exists and then sends both in one
// message, so the renderer's whole job is to paint and play them in the same
// tick. What is worth testing here is the seam either side of that: the audio
// must not outlive a line the bubble refused, and it must not be waited for.

const MP3 = { mime: 'audio/mpeg', base64: 'QUJD' };

test('a line arrives with its own audio and both happen in the same tick', async () => {
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;

  h.g.speakCb({ text: 'The build is clean.', audio: MP3 });

  assert.equal(h.dom.bubble.textContent, 'The build is clean.');
  assert.equal(h.dom.bubble.hidden, false);
  assert.deepEqual(h.dom.voice.played, ['data:audio/mpeg;base64,QUJD'], 'played, not queued');
  assert.equal(app.voice.playing, true);
  app.dispose();
});

test('a line with no audio is still shown, immediately', async () => {
  // The deadline expired, or the synthesizer is off. Either way she is read.
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;

  h.g.speakCb({ text: 'The build is clean.' });

  assert.equal(h.dom.bubble.textContent, 'The build is clean.');
  assert.deepEqual(h.dom.voice.played, []);
  app.dispose();
});

test('audio for a line the bubble refused is never heard', async () => {
  // He asked a question and is reading the answer; a hook line arriving behind
  // it is dropped by the priority rule. Playing its audio anyway would have her
  // speaking a sentence that is nowhere on screen.
  const h = await bootHarness({ reply: 'The tests pass.' });
  await flush();
  h.resolveFlags();
  const app = await h.booting;

  h.dom.canvas.dispatch('click', {});
  h.dom.chatInput.value = 'how did it go?';
  h.dom.chatInput.dispatch('keydown', { key: 'Enter' });
  await flush();
  assert.equal(h.dom.bubble.textContent, 'The tests pass.');
  const heard = h.dom.voice.played.length;

  h.g.speakCb({ text: 'Edit finished in ganyu-pet.', audio: MP3 });

  assert.equal(h.dom.bubble.textContent, 'The tests pass.', 'the reply keeps the bubble');
  assert.equal(h.dom.voice.played.length, heard, 'and the refused line stays silent');
  app.dispose();
});

test('late audio still plays, because its line is already up', async () => {
  // The other half of the rule: an urgent kind shows at once and is voiced when
  // it can be, so `ganyu:audio` is played on arrival with nothing left to decide.
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;

  h.g.speakCb({ text: 'Claude needs your approval.' });
  assert.deepEqual(h.dom.voice.played, [], 'shown unvoiced first');

  h.g.audioCb(MP3);

  assert.deepEqual(h.dom.voice.played, ['data:audio/mpeg;base64,QUJD']);
  app.dispose();
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

// ---------------------------------------------------------------------------
// chat — interactivity latch
// ---------------------------------------------------------------------------

test('interactivity latches chatOpen exactly like menuOpen', () => {
  const calls = [];
  const i = createInteractivity({ setInteractive: (v) => calls.push(v) });
  i.sync();
  assert.deepEqual(calls, [false], 'baseline is click-through');

  i.setChatOpen(true);
  i.setChatOpen(true);
  assert.deepEqual(calls, [false, true], 'no duplicate calls');
  assert.equal(i.interactive, true);

  // He is looking at the keyboard: the pointer coming and going over the sprite
  // must not drop interactivity out from under an open input.
  i.setOverPet(true);
  i.setOverPet(false);
  assert.deepEqual(calls, [false, true], 'chat latch holds through hover changes');
  assert.equal(i.interactive, true);

  i.setChatOpen(false);
  assert.deepEqual(calls, [false, true, false], 'reverts when the input closes');

  i.setChatOpen(true);
  i.releaseAll();
  assert.equal(i.interactive, false, 'releaseAll drops the chat latch too');
});

// ---------------------------------------------------------------------------
// chat — bubble precedence
// ---------------------------------------------------------------------------

test('a chat line takes the bubble; an ambient line is dropped while it shows', () => {
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

  // Ambient is the default, and holds nothing.
  assert.equal(b.show('Running npm test…'), true);
  assert.equal(b.priority, BUBBLE_PRIORITY.ambient);

  // A reply wins over an ambient line already on screen.
  assert.equal(b.show('I am here.', { priority: BUBBLE_PRIORITY.chat }), true);
  assert.equal(el.textContent, 'I am here.');
  assert.equal(b.priority, BUBBLE_PRIORITY.chat);

  // ...and the ambient line cannot take it back while he is reading.
  assert.equal(b.show('Edit finished.'), false, 'ambient refused');
  assert.equal(el.textContent, 'I am here.');

  // Chat never blocks chat: this is how the pending line is replaced.
  assert.equal(b.show('One more thing.', { priority: BUBBLE_PRIORITY.chat }), true);
  assert.equal(el.textContent, 'One more thing.');

  // The hold is the line's own TTL — once it starts fading, ambient is welcome.
  timers.filter(Boolean).at(-1).fn();
  assert.equal(b.visible, false);
  assert.equal(b.priority, BUBBLE_PRIORITY.ambient, 'hold released with the line');
  assert.equal(b.show('Edit finished.'), true);
  assert.equal(el.textContent, 'Edit finished.');

  b.hide();
  assert.equal(b.priority, BUBBLE_PRIORITY.ambient, 'hide clears the hold');
});

// ---------------------------------------------------------------------------
// chat — open / close / focus
// ---------------------------------------------------------------------------

test('left-click opens the input, focuses it, and holds the overlay interactive', async () => {
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { canvas, chat, chatInput } = h.dom;
  h.g.calls.setInteractive.length = 0;

  assert.equal(chat.hidden, true, 'starts closed');
  canvas.dispatch('click', { clientX: 120, clientY: 260 });

  assert.equal(chat.hidden, false);
  assert.equal(chatInput.focused, true, 'caret is in the field');
  assert.deepEqual(h.g.calls.setInteractive, [true], 'window is interactive while open');
  assert.deepEqual(h.g.calls.setFocused, [true], 'main asked to make the window focusable');
  assert.equal(app.chat.isOpen, true);
  app.dispose();
});

test('Escape closes and clears the input, and restores click-through', async () => {
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { canvas, chat, chatInput, doc } = h.dom;

  canvas.dispatch('click', {});
  chatInput.value = 'half a thought';
  chatInput.dispatch('keydown', { key: 'Escape' });

  assert.equal(chat.hidden, true);
  assert.equal(chatInput.value, '', 'cleared, not left for next time');
  assert.equal(chatInput.focused, false);
  assert.equal(h.g.calls.setInteractive.at(-1), false, 'click-through restored');
  assert.deepEqual(h.g.calls.setFocused, [true, false], 'focusability handed back');

  // The document-level handler closes it too, for when focus is elsewhere.
  canvas.dispatch('click', {});
  assert.equal(chat.hidden, false);
  doc.dispatch('keydown', { key: 'Escape' });
  assert.equal(chat.hidden, true);
  assert.equal(app.chat.isOpen, false);
  app.dispose();
});

test('clicking outside closes the input; clicking the sprite toggles it', async () => {
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { canvas, chat, chatInput, doc, menu } = h.dom;

  canvas.dispatch('click', {});
  assert.equal(chat.hidden, false);

  // A mousedown inside the strip keeps it open — that is how he clicks the field.
  doc.dispatch('mousedown', { target: chatInput });
  assert.equal(chat.hidden, false);

  doc.dispatch('mousedown', { target: menu });
  assert.equal(chat.hidden, true, 'outside mousedown closes it');

  // Second click on the sprite closes it, rather than reopening it forever.
  canvas.dispatch('click', {});
  assert.equal(chat.hidden, false);
  canvas.dispatch('click', {});
  assert.equal(chat.hidden, true);

  // mousedown precedes click, so the sprite is exempt from the outside rule —
  // otherwise the mousedown would close what the click is about to reopen.
  canvas.dispatch('click', {});
  chatInput.value = 'still typing';
  doc.dispatch('mousedown', { target: canvas });
  assert.equal(chat.hidden, false, 'sprite mousedown does not close it');
  assert.equal(chatInput.value, 'still typing', 'and does not clear it');
  app.dispose();
});

test('the pointer leaving the window does not release interactivity while typing', async () => {
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { canvas, documentElement } = h.dom;

  canvas.dispatch('click', {});
  h.g.calls.setInteractive.length = 0;

  documentElement.dispatch('mouseleave');
  assert.deepEqual(h.g.calls.setInteractive, [], 'latch survives the pointer leaving');
  assert.equal(app.interactivity.interactive, true);

  // Once the input is closed the watchdog behaves exactly as before.
  documentElement.dispatch('mouseleave');
  canvas.dispatch('click', {}); // toggles closed
  assert.deepEqual(h.g.calls.setInteractive, [false]);
  app.dispose();
});

test('window blur closes the input and gives focusability back', async () => {
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;

  h.dom.canvas.dispatch('click', {});
  h.dom.win.dispatch('blur');
  assert.equal(h.dom.chat.hidden, true);
  assert.deepEqual(h.g.calls.setFocused, [true, false]);
  assert.equal(h.g.calls.setInteractive.at(-1), false);
  app.dispose();
});

// ---------------------------------------------------------------------------
// chat — sending
// ---------------------------------------------------------------------------

test('Enter sends, shows a temporary line, then replaces it with the reply', async () => {
  const gate = deferred();
  const h = await bootHarness({ reply: () => gate.promise });
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { canvas, chatInput, bubble } = h.dom;

  canvas.dispatch('click', {});
  chatInput.value = '  how is it going?  ';
  chatInput.dispatch('keydown', { key: 'Enter' });
  await flush();

  assert.deepEqual(h.g.calls.sendChat, ['  how is it going?  '], 'the raw text goes to main');
  assert.equal(chatInput.value, '', 'field cleared on send');
  assert.equal(bubble.textContent, THINKING_MARK, 'dots while she thinks, not a sentence');
  assert.equal(bubble.classList.contains(THINKING_CLASS), true, 'and the class CSS pulses');
  assert.equal(bubble.hidden, false, 'he can see that she heard him');
  assert.equal(h.dom.chat.hidden, false, 'the input stays open for the next message');

  gate.resolve('It goes well, thank you.');
  await flush();
  assert.equal(bubble.textContent, 'It goes well, thank you.', 'pending state replaced');
  assert.equal(bubble.classList.contains(THINKING_CLASS), false, 'and the pulse stopped with it');
  app.dispose();
});

test('a failed reply replaces the pending dots rather than leaving them hanging', async () => {
  for (const reply of [null, '   ', () => Promise.reject(new Error('down'))]) {
    const h = await bootHarness({ reply });
    await flush();
    h.resolveFlags();
    const app = await h.booting;

    h.dom.canvas.dispatch('click', {});
    h.dom.chatInput.value = 'are you there?';
    h.dom.chatInput.dispatch('keydown', { key: 'Enter' });
    await flush();
    await flush();

    assert.equal(h.dom.bubble.textContent, CHAT_FAILED_LINE, `reply=${String(reply)}`);
    assert.notEqual(h.dom.bubble.textContent, THINKING_MARK);
    assert.equal(
      h.dom.bubble.classList.contains(THINKING_CLASS),
      false,
      `reply=${String(reply)}: nothing may leave the dots pulsing forever`,
    );
    app.dispose();
  }
});

test('the dots carry the audio wait too, and come down onto words and sound at once', async () => {
  // The one thing that must not happen: the dots being replaced by a blank
  // pause, or by the reply arriving mute and then talking to itself later. Main
  // holds the reply until its audio is ready, so the dots cover both waits and
  // the strip paints and plays in the same tick.
  const gate = deferred();
  const h = await bootHarness({ reply: () => gate.promise });
  await flush();
  h.resolveFlags();
  const app = await h.booting;

  h.dom.canvas.dispatch('click', {});
  h.dom.chatInput.value = 'how did the build go?';
  h.dom.chatInput.dispatch('keydown', { key: 'Enter' });
  await flush();
  assert.equal(h.dom.bubble.textContent, THINKING_MARK, 'still thinking while the voice is made');
  assert.deepEqual(h.dom.voice.played, [], 'and nothing is playing yet');

  gate.resolve({ text: 'It goes well, thank you.', audio: MP3 });
  await flush();

  assert.equal(h.dom.bubble.textContent, 'It goes well, thank you.');
  assert.equal(h.dom.bubble.classList.contains(THINKING_CLASS), false);
  assert.deepEqual(h.dom.voice.played, ['data:audio/mpeg;base64,QUJD'], 'spoken as it appears');
  app.dispose();
});

test('a reply that outran its own audio is still shown, and stays silent', async () => {
  const h = await bootHarness({ reply: { text: 'It goes well.', audio: null } });
  await flush();
  h.resolveFlags();
  const app = await h.booting;

  h.dom.canvas.dispatch('click', {});
  h.dom.chatInput.value = 'well?';
  h.dom.chatInput.dispatch('keydown', { key: 'Enter' });
  await flush();

  assert.equal(h.dom.bubble.textContent, 'It goes well.');
  assert.deepEqual(h.dom.voice.played, []);
  app.dispose();
});

test('a bare string reply is still understood', async () => {
  // What the channel answered before she had a voice. Tolerated so a shape
  // mismatch between main and the renderer costs the sound, not the answer.
  const h = await bootHarness({ reply: 'It goes well.' });
  await flush();
  h.resolveFlags();
  const app = await h.booting;

  h.dom.canvas.dispatch('click', {});
  h.dom.chatInput.value = 'well?';
  h.dom.chatInput.dispatch('keydown', { key: 'Enter' });
  await flush();

  assert.equal(h.dom.bubble.textContent, 'It goes well.');
  assert.deepEqual(h.dom.voice.played, []);
  app.dispose();
});

test('the pending state is wordless, and the failure line is not', () => {
  // The distinction the owner asked for: dots are what she shows before every
  // single answer, so they must not be words. The failure line is rare and has
  // something to say, so it stays a sentence.
  assert.equal(/[a-z]/i.test(THINKING_MARK), false, 'not a word, not a sentence');
  assert.equal(THINKING_MARK.trim(), THINKING_MARK, 'and survives the bubble trim');
  assert.ok(THINKING_MARK.length > 0);
  assert.ok(/[a-z]/i.test(CHAT_FAILED_LINE), 'the failure line is still a real message');
});

test('blank input is not sent, and a second Enter while pending is ignored', async () => {
  const gate = deferred();
  const h = await bootHarness({ reply: () => gate.promise });
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { canvas, chatInput } = h.dom;

  canvas.dispatch('click', {});
  for (const blank of ['', '   ']) {
    chatInput.value = blank;
    chatInput.dispatch('keydown', { key: 'Enter' });
    await flush();
  }
  assert.deepEqual(h.g.calls.sendChat, [], 'nothing sent');
  assert.equal(h.dom.bubble.hidden, true, 'and no pending bubble');

  chatInput.value = 'first';
  chatInput.dispatch('keydown', { key: 'Enter' });
  await flush();
  chatInput.value = 'second';
  chatInput.dispatch('keydown', { key: 'Enter' });
  await flush();
  assert.deepEqual(h.g.calls.sendChat, ['first'], 'single-flight: the second Enter is dropped');

  gate.resolve('Yes?');
  await flush();
  chatInput.value = 'third';
  chatInput.dispatch('keydown', { key: 'Enter' });
  await flush();
  assert.deepEqual(h.g.calls.sendChat, ['first', 'third'], 'the latch releases with the reply');
  app.dispose();
});

test('a chat reply outranks an ambient line arriving at the same moment', async () => {
  const gate = deferred();
  const h = await bootHarness({ reply: () => gate.promise });
  await flush();
  h.resolveFlags();
  const app = await h.booting;

  h.dom.canvas.dispatch('click', {});
  h.dom.chatInput.value = 'are you free?';
  h.dom.chatInput.dispatch('keydown', { key: 'Enter' });
  await flush();

  // A hook fires while she is thinking. It must not take the bubble — the dots
  // hold it at chat priority exactly as the old pending sentence did.
  h.g.speakCb({ text: 'Running npm test…' });
  assert.equal(h.dom.bubble.textContent, THINKING_MARK, 'ambient blocked mid-exchange');
  assert.equal(h.dom.bubble.classList.contains(THINKING_CLASS), true, 'still pulsing');

  gate.resolve('For you, always.');
  await flush();
  assert.equal(h.dom.bubble.textContent, 'For you, always.', 'the answer wins');
  app.dispose();
});

test('an ambient line does not stomp a reply he is still reading', async () => {
  const h = await bootHarness({ reply: 'The build is clean.' });
  await flush();
  h.resolveFlags();
  const app = await h.booting;

  h.dom.canvas.dispatch('click', {});
  h.dom.chatInput.value = 'how did the build go?';
  h.dom.chatInput.dispatch('keydown', { key: 'Enter' });
  await flush();
  assert.equal(h.dom.bubble.textContent, 'The build is clean.');

  h.g.speakCb({ text: 'Edit finished in ganyu-pet.' });
  assert.equal(h.dom.bubble.textContent, 'The build is clean.', 'the reply holds the bubble');
  app.dispose();
});

test('dispose closes an open chat and hands focusability back', async () => {
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;

  h.dom.canvas.dispatch('click', {});
  assert.equal(h.dom.chat.hidden, false);
  app.dispose();
  assert.equal(h.dom.chat.hidden, true);
  assert.equal(h.dom.chatInput.listenerCount('keydown'), 0);
  assert.equal(h.dom.canvas.listenerCount('click'), 0);
  assert.deepEqual(h.g.calls.setFocused, [true, false]);
  assert.equal(h.g.calls.setInteractive.at(-1), false);
});

// ---------------------------------------------------------------------------
// chat — the same audit the menu failed
// ---------------------------------------------------------------------------

test('the input strip does not share the menu\'s dead exits, because it lifts focus', async () => {
  // The audit, pinned. The menu's Escape and blur handlers were unreachable
  // because the window is focusable:false. The strip is not in that position and
  // never was: `openChat` asks main to make the window focusable and focuses the
  // field, which is precisely what makes a keydown and a blur real events here.
  // Three independent ways out, none of them the mouse-only one the menu was
  // left with. If a future change stops lifting focus, this is the test that
  // should fail rather than the owner discovering it with a restart.
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { canvas, chat, chatInput, doc, win } = h.dom;

  const open = () => {
    canvas.dispatch('click', {});
    assert.equal(chat.hidden, false);
    assert.equal(
      h.g.calls.setFocused.at(-1),
      true,
      'the strip is only closable by keyboard because it asked for focus',
    );
  };

  open();
  chatInput.dispatch('keydown', { key: 'Escape' });
  assert.equal(chat.hidden, true, 'Escape in the field');

  open();
  doc.dispatch('keydown', { key: 'Escape' });
  assert.equal(chat.hidden, true, 'Escape anywhere on the page');

  open();
  win.dispatch('blur');
  assert.equal(chat.hidden, true, 'clicking into the editor');

  open();
  doc.dispatch('mousedown', { target: h.dom.menu });
  assert.equal(chat.hidden, true, 'a mousedown elsewhere on the overlay');

  open();
  canvas.dispatch('click', {});
  assert.equal(chat.hidden, true, 'and clicking her toggles it');
  app.dispose();
});

test('a click-through overlay is still typeable, which is why the strip is not force-closed', async () => {
  // The asymmetry, deliberately. `setIgnoreMouseEvents` takes the mouse away and
  // leaves keyboard focus alone, so a menu on an unlatched window is unusable
  // while an input strip on one is merely unclickable — he can still type and
  // still press Escape. Closing it under him would destroy a message to fix
  // nothing, so the reachability guard covers the menu and stops there.
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { canvas, chat, chatInput } = h.dom;

  canvas.dispatch('click', {});
  chatInput.value = 'most of a sentence';
  app.interactivity.releaseAll();

  assert.equal(app.menu.guard(), false, 'no menu, nothing to sweep up');
  assert.equal(chat.hidden, false, 'the strip stays');
  assert.equal(chatInput.value, 'most of a sentence', 'and so does what he wrote');

  // It is still closable by every keyboard route, which is the whole argument.
  chatInput.dispatch('keydown', { key: 'Escape' });
  assert.equal(chat.hidden, true);
  app.dispose();
});

test('boot no-ops when the chat elements are missing from the page', async () => {
  const dom = makeDom();
  const byId = {
    pet: dom.canvas,
    bubble: dom.bubble,
    menu: dom.menu,
    chat: dom.chat, // no #chat-input
  };
  const doc = makeEl('#document', {
    documentElement: dom.documentElement,
    readyState: 'complete',
    getElementById: (id) => byId[id] || null,
  });
  const g = makeGanyu(() => Promise.resolve({}));
  assert.equal(await boot({ win: dom.win, doc, ganyu: g.api }), null);
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

// ---------------------------------------------------------------------------
// picking her up
// ---------------------------------------------------------------------------

test('interactivity latches dragging, and the latch outlives the pointer leaving the sprite', () => {
  // The window chases the cursor, so on a fast drag it trails behind and the
  // pointer spends most of the gesture off the sprite. Without this latch the
  // overlay would go click-through mid-throw and the mouseup that ends the drag
  // would land on the desktop instead.
  const calls = [];
  const i = createInteractivity({ setInteractive: (v) => calls.push(v) });
  i.sync();
  assert.deepEqual(calls, [false]);

  i.setOverPet(true);
  i.setDragging(true);
  assert.deepEqual(calls, [false, true], 'already interactive from the hover');

  i.setOverPet(false);
  assert.equal(i.interactive, true, 'the drag holds it open');
  assert.deepEqual(calls, [false, true], 'and does it without a second call');

  i.setDragging(false);
  assert.deepEqual(calls, [false, true, false], 'released when the drag ends');

  i.setDragging(true);
  i.releaseAll();
  assert.equal(i.interactive, false, 'releaseAll drops the drag latch too');
});

test('airborne draws the jump row, outranking the walk direction and the mode', () => {
  assert.equal(baseRowFor({ mode: 'idle', airborne: true }), ROW.JUMP);
  assert.equal(baseRowFor({ mode: 'failed', airborne: true }), ROW.JUMP, 'whatever the machine is doing');
  assert.equal(
    baseRowFor({ mode: 'busy', walk: { dir: 'right' }, airborne: true }),
    ROW.JUMP,
    'she is plainly not running along anything',
  );
  assert.equal(baseRowFor({ mode: 'busy', walk: { dir: 'right' }, airborne: false }), ROW.RUN_RIGHT);
  assert.equal(framesForRow(ROW.JUMP), 5, 'and it is a real five-frame row, not a blank one');
});

test('a left press on the sprite is reported to main, and the release with it', async () => {
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { canvas, doc } = h.dom;

  canvas.dispatch('mousedown', { button: 0 });
  assert.deepEqual(h.g.calls.drag, ['press'], 'the button, and only the button');
  assert.equal(app.drag.pressing, true);
  assert.equal(app.drag.dragging, false, 'whether it is a drag is not the renderer\'s call');

  // On the document, not the canvas: a fast drag leaves the window trailing the
  // cursor, so the button often comes up somewhere else on the overlay.
  doc.dispatch('mouseup', { button: 0 });
  assert.deepEqual(h.g.calls.drag, ['press', 'release']);
  assert.equal(app.drag.pressing, false);
  app.dispose();
});

test('right-click is the menu and never a pick-up', async () => {
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;

  h.dom.canvas.dispatch('mousedown', { button: 2 });
  assert.deepEqual(h.g.calls.drag, [], 'no press at all');
  h.dom.canvas.dispatch('contextmenu', { clientX: 10, clientY: 10 });
  await flush();
  assert.equal(h.dom.menu.hidden, false, 'the menu still opens');
  app.dispose();
});

test('a press that main calls a click still opens the chat strip', async () => {
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { canvas, doc, chat } = h.dom;

  // No `dragging` ever arrives on ganyu:state, so this was a click.
  canvas.dispatch('mousedown', { button: 0 });
  doc.dispatch('mouseup', { button: 0 });
  canvas.dispatch('click', {});
  assert.equal(chat.hidden, false, 'the chat path is untouched by the drag plumbing');

  canvas.dispatch('mousedown', { button: 0 });
  doc.dispatch('mouseup', { button: 0 });
  canvas.dispatch('click', {});
  assert.equal(chat.hidden, true, 'and still toggles');
  app.dispose();
});

test('letting go of a dragged pet does not open the chat strip', async () => {
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { canvas, doc, chat, menu } = h.dom;

  canvas.dispatch('mousedown', { button: 0 });
  h.g.stateCb({ mode: 'idle', dragging: true, airborne: true, walk: null });
  assert.equal(app.drag.dragging, true, 'main promoted the press');
  assert.equal(app.interactivity.interactive, true, 'and the latch is holding');
  assert.equal(menu.hidden, true);

  // mouseup is also the second half of a click, which is the whole problem.
  doc.dispatch('mouseup', { button: 0 });
  canvas.dispatch('click', {});
  assert.equal(chat.hidden, true, 'she was put down, not spoken to');
  assert.equal(app.drag.dragging, false);
  assert.equal(app.interactivity.interactive, false, 'and the latch let go');

  // Exactly one click is swallowed: the next one is a real one.
  canvas.dispatch('mousedown', { button: 0 });
  doc.dispatch('mouseup', { button: 0 });
  canvas.dispatch('click', {});
  assert.equal(chat.hidden, false, 'the very next click opens it as usual');
  app.dispose();
});

test('a drag closes an open menu, and survives the pointer leaving the window', async () => {
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { canvas, doc, menu, documentElement } = h.dom;

  canvas.dispatch('contextmenu', { clientX: 10, clientY: 10 });
  await flush();
  assert.equal(menu.hidden, false);

  canvas.dispatch('mousedown', { button: 0 });
  h.g.stateCb({ mode: 'idle', dragging: true, airborne: true, walk: null });
  assert.equal(menu.hidden, true, 'nothing to aim a menu at while she is in the air');

  // The watchdog that normally re-arms click-through must stand down: the pointer
  // leaving is not a signal mid-drag, it is the drag.
  documentElement.dispatch('mouseleave');
  assert.equal(app.interactivity.interactive, true, 'still interactive');

  doc.dispatch('mouseup', { button: 0 });
  assert.equal(app.interactivity.interactive, false);
  app.dispose();
});

test('a press the window never sees the end of is given back on blur and on dispose', async () => {
  const blurred = await bootHarness();
  await flush();
  blurred.resolveFlags();
  const first = await blurred.booting;
  blurred.dom.canvas.dispatch('mousedown', { button: 0 });
  blurred.dom.win.dispatch('blur');
  assert.deepEqual(blurred.g.calls.drag, ['press', 'release'], 'not left stuck to a cursor that left');
  assert.equal(first.drag.pressing, false);
  first.dispose();

  const torn = await bootHarness();
  await flush();
  torn.resolveFlags();
  const app = await torn.booting;
  torn.dom.canvas.dispatch('mousedown', { button: 0 });
  app.dispose();
  assert.deepEqual(torn.g.calls.drag, ['press', 'release'], 'told before the listeners went');
});

test('the Come here button is wired to the recall action', async () => {
  const h = await bootHarness();
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  const { menu, canvas } = h.dom;

  canvas.dispatch('contextmenu', { clientX: 10, clientY: 10 });
  await flush();
  const home = menu.children.find((b) => b.dataset.action === 'home');
  assert.ok(home, 'the entry exists');
  assert.equal(home.textContent, 'Come here');

  menu.dispatch('click', { target: home });
  assert.deepEqual(h.g.calls.menuAction, ['home'], 'the action main has been filtering for all along');
  assert.equal(menu.hidden, true, 'and it closes behind itself like every other entry');
  app.dispose();
});

// ------------------------------------------------------------------ call mode
//
// The renderer half of call mode: the toggle, and the rule that the call hears
// exactly what the room hears — after every gate, never around one.

function makeCallMedia({ devices } = {}) {
  const kit = { gum: [], tracks: [], els: [], listeners: new Set() };
  kit.devices = devices || [
    { kind: 'audiooutput', deviceId: 'default', label: 'Speakers' },
    { kind: 'audiooutput', deviceId: 'vm-aux', label: 'Voicemeeter AUX Input (VB-Audio)' },
  ];
  kit.mediaDevices = {
    enumerateDevices: async () => kit.devices.slice(),
    getUserMedia: async (c) => {
      kit.gum.push(c);
      const t = { stopped: false, stop() { t.stopped = true; } };
      kit.tracks.push(t);
      return { getTracks: () => [t] };
    },
    addEventListener: (type, fn) => kit.listeners.add(fn),
    removeEventListener: (type, fn) => kit.listeners.delete(fn),
  };
  kit.Audio = function FakeCallAudio() {
    const el = {
      sinkId: '', src: '', srcObject: null, played: [], paused: 0,
      async setSinkId(id) { el.sinkId = id; },
      play() { el.played.push(el.src); return Promise.resolve(); },
      pause() { el.paused += 1; },
      load() {},
      removeAttribute() { el.src = ''; },
    };
    kit.els.push(el);
    return el;
  };
  kit.AudioContext = function FakeCtx() {
    return {
      close: () => Promise.resolve(),
      createMediaStreamDestination: () => ({ stream: {} }),
      createMediaStreamSource: () => ({ connect() {} }),
      decodeAudioData: async () => ({}),
      createBufferSource: () => ({ connect() {}, start() {}, stop() {} }),
    };
  };
  kit.setup = (dom) => {
    dom.win.navigator = { mediaDevices: kit.mediaDevices };
    dom.win.Audio = kit.Audio;
    dom.win.AudioContext = kit.AudioContext;
    // Same place as index.html: after Pin.
    dom.menu.children.splice(2, 0, makeButton('toggle-call'));
  };
  return kit;
}

const CALL_FLAGS = {
  muted: false,
  pinned: false,
  callMode: false,
  call: { device: 'voicemeeter aux input', mixMic: false, mic: '' },
  spritePath: 'file:///sheet.webp',
};

async function callHarness({ flags = CALL_FLAGS, devices, reply } = {}) {
  const kit = makeCallMedia({ devices });
  const h = await bootHarness({ flags, reply, setup: kit.setup });
  await flush();
  h.resolveFlags();
  const app = await h.booting;
  // Main's half: it owns the flags, flips them on each action, and is what the
  // menu re-reads on every open — as index.mjs does.
  const main = { ...flags };
  const sendAction = h.g.api.menuAction;
  h.g.api.menuAction = (a) => {
    if (a === 'toggle-mute') main.muted = !main.muted;
    if (a === 'toggle-call') main.callMode = !main.callMode;
    sendAction(a);
  };
  h.g.api.getFlags = () => Promise.resolve({ ...main });
  const button = (action) => h.dom.menu.children.find((b) => b.dataset.action === action);
  const click = async (btn) => {
    h.dom.canvas.dispatch('contextmenu', { clientX: 10, clientY: 10 });
    await flush();
    h.dom.menu.dispatch('click', { target: btn });
    await flush();
  };
  return { h, app, kit, callBtn: button('toggle-call'), button, click };
}

test('call toggle: label flips from live state, main is told, the sink is routed', async () => {
  const { h, app, kit, callBtn, click } = await callHarness();
  assert.equal(callBtn.textContent, 'Talk in calls');
  await click(callBtn);
  assert.deepEqual(h.g.calls.menuAction, ['toggle-call']);
  assert.equal(app.flags.callMode, true);
  assert.equal(callBtn.textContent, 'Stop talking in calls');
  assert.equal(app.call.active, true);
  assert.equal(kit.els[0].sinkId, 'vm-aux');
  assert.equal(kit.gum.length, 0, 'route mode never opens the mic');

  await click(callBtn);
  assert.deepEqual(h.g.calls.menuAction, ['toggle-call', 'toggle-call']);
  assert.equal(app.call.active, false);
  assert.equal(callBtn.textContent, 'Talk in calls');
  app.dispose();
});

test('call mode: an accepted line plays locally AND into the call; a refused one in neither', async () => {
  const { h, app, kit, callBtn, click } = await callHarness({ reply: 'The tests pass.' });
  await click(callBtn);

  h.g.speakCb({ text: 'The build is clean.', audio: MP3 });
  assert.deepEqual(h.dom.voice.played, ['data:audio/mpeg;base64,QUJD'], 'the room still hears her');
  assert.deepEqual(kit.els[0].played, ['data:audio/mpeg;base64,QUJD'], 'and so does the call');

  h.g.audioCb(MP3);
  assert.equal(kit.els[0].played.length, 2, 'late audio reaches the call too');

  // A reply holds the bubble; an ambient line behind it is refused.
  h.dom.canvas.dispatch('click', {});
  h.dom.chatInput.value = 'how did it go?';
  h.dom.chatInput.dispatch('keydown', { key: 'Enter' });
  await flush();
  assert.equal(h.dom.bubble.textContent, 'The tests pass.');
  const local = h.dom.voice.played.length;
  const inCall = kit.els[0].played.length;
  h.g.speakCb({ text: 'Edit finished.', audio: MP3 });
  assert.equal(h.dom.voice.played.length, local);
  assert.equal(kit.els[0].played.length, inCall, 'a line the bubble refused is not heard in the call either');
  app.dispose();
});

test('a muted pet sends nothing into the call, and muting silences the call mid-line', async () => {
  const { h, app, kit, callBtn, button, click } = await callHarness({ flags: { ...CALL_FLAGS, muted: true } });
  await click(callBtn);
  h.g.audioCb(MP3);
  assert.deepEqual(kit.els[0].played, [], 'muted: nothing to the call');

  await click(button('toggle-mute')); // unmute
  h.g.audioCb(MP3);
  assert.equal(kit.els[0].played.length, 1);
  const paused = kit.els[0].paused;
  await click(button('toggle-mute')); // mute again, mid-line
  assert.ok(kit.els[0].paused > paused, 'the line in progress is stopped in the call');
  assert.equal(app.call.active, true, 'mute silences her; it does not leave the call');
  h.g.audioCb(MP3);
  assert.equal(kit.els[0].played.length, 1, 'and nothing new reaches it');
  app.dispose();
});

test('device not found: call mode turns itself off with one canned line, local audio untouched', async () => {
  const { h, app, kit, callBtn, click } = await callHarness({
    devices: [{ kind: 'audiooutput', deviceId: 'default', label: 'Speakers' }],
  });
  await click(callBtn);
  await flush();
  assert.equal(app.flags.callMode, false);
  assert.deepEqual(h.g.calls.menuAction, ['toggle-call', 'toggle-call'], 'main is told it is off again');
  assert.equal(callBtn.textContent, 'Talk in calls');
  assert.match(h.dom.bubble.textContent, /voicemeeter aux input/);
  assert.equal(kit.els.length, 0);

  h.g.audioCb(MP3);
  assert.deepEqual(h.dom.voice.played, ['data:audio/mpeg;base64,QUJD'], 'she is still heard in the room');
  app.dispose();
});

test('mix mode: the mic is open only while call mode is on, and quit closes it first', async () => {
  const { h, app, kit, callBtn, button, click } = await callHarness({
    flags: { ...CALL_FLAGS, call: { device: 'Voicemeeter AUX', mixMic: true, mic: '' } },
  });
  assert.equal(kit.gum.length, 0, 'not at boot');
  await click(callBtn);
  await flush();
  assert.equal(kit.gum.length, 1);
  assert.equal(kit.gum[0].video, false);
  await click(callBtn);
  assert.ok(kit.tracks.every((t) => t.stopped), 'toggle-off stops the tracks');

  await click(callBtn);
  await flush();
  assert.equal(kit.tracks.length, 2);
  await click(button('quit'));
  assert.ok(kit.tracks.every((t) => t.stopped), 'quit stops the tracks');
  assert.equal(h.g.calls.menuAction.at(-1), 'quit');
  app.dispose();
});

test('a reloaded renderer picks up live call mode; dispose closes the mic', async () => {
  const { app, kit } = await callHarness({
    flags: { ...CALL_FLAGS, callMode: true, call: { device: 'Voicemeeter AUX', mixMic: true, mic: '' } },
  });
  await flush();
  assert.equal(app.call.active, true);
  app.dispose();
  assert.ok(kit.tracks.length === 1 && kit.tracks[0].stopped);
  assert.equal(app.call.active, false);
});
