// Module C — canvas sprite engine + hover/menu wiring for the Ganyu overlay.
//
// Spritesheet: 8 columns x 9 rows of 192x208 frames (verified: the installed
// ganyu--chenxin-dlut sheet is exactly 1536x1872). The path arrives from
// ganyu.getFlags().spritePath as a file:// URL; nothing here reads the disk.
//
// Everything with a side effect is injectable so this file imports cleanly in
// plain node (no Electron, no DOM) for unit checks.

import { createBubbles, BUBBLE_PRIORITY } from './bubbles.mjs';

export const FRAME_W = 192;
export const FRAME_H = 208;
export const FRAMES_PER_ROW = 8;
export const ROW_COUNT = 9;
export const SHEET_W = FRAME_W * FRAMES_PER_ROW; // 1536
export const SHEET_H = FRAME_H * ROW_COUNT; // 1872

// Measured real (non-transparent) frame count per row — the grid is 8 wide but
// most rows stop short and their trailing cells are fully transparent. Drawing
// those blanks is a visible blink, so animation must wrap here, not at 8.
export const ROW_FRAMES = Object.freeze([6, 8, 8, 4, 5, 8, 6, 6, 6]);

export const ROW = {
  IDLE: 0,
  RUN_RIGHT: 1,
  RUN_LEFT: 2,
  WAVE: 3,
  JUMP: 4,
  FAILED: 5,
  WAITING: 6,
  BUSY: 7,
  REVIEW: 8,
};

/** Aggregate mode -> row. Unknown modes fall back to idle. */
export const MODE_ROW = {
  idle: ROW.IDLE,
  // Row 7 (BUSY) is a run-in-place sprite and must never play while stationary —
  // REVIEW is the standing working pose, so busy maps there instead.
  busy: ROW.REVIEW,
  waiting: ROW.WAITING,
  failed: ROW.FAILED,
};

/** walk.dir -> row. */
export const WALK_ROW = {
  right: ROW.RUN_RIGHT,
  left: ROW.RUN_LEFT,
};

/** celebrate pulse: jump once, then wave once, then back to the base row. */
export const CELEBRATE_PULSE = [ROW.JUMP, ROW.WAVE];

export const DEFAULT_FPS = 8;
export const WALK_FPS = 6;

export function fpsForRow(row) {
  return row === ROW.RUN_RIGHT || row === ROW.RUN_LEFT ? WALK_FPS : DEFAULT_FPS;
}

export function framesForRow(row) {
  return ROW_FRAMES[row] ?? FRAMES_PER_ROW;
}

/**
 * The row a state resolves to ignoring the celebrate pulse: off the ground beats
 * everything, then a walk direction, then mode -> row. The precedence matters now
 * that the pet also strolls while busy — walking legs beat the standing busy
 * pose, and a pet held in the air or mid-throw beats both, because whatever the
 * machine is doing she is plainly not standing on anything.
 *
 * Airborne draws the jump row: 5 real frames of her off the ground, which is the
 * only pose on the sheet that is not a stance. It covers being held and being
 * thrown alike — from the sprite's point of view they are the same situation.
 */
export function baseRowFor(state) {
  if (state && state.airborne) return ROW.JUMP;
  const dir = state && state.walk && state.walk.dir;
  if (dir && Object.prototype.hasOwnProperty.call(WALK_ROW, dir)) return WALK_ROW[dir];
  const mode = state && state.mode;
  if (mode && Object.prototype.hasOwnProperty.call(MODE_ROW, mode)) return MODE_ROW[mode];
  return ROW.IDLE;
}

/**
 * Frame clock. Pure: feed it states and timestamps, read back {row, frame}.
 * The celebrate pulse triggers on the rising edge of state.celebrate only, so
 * repeated pushes during the 10s celebrate window do not restart it.
 */
export function createAnimator({ now = () => Date.now() } = {}) {
  let baseRow = ROW.IDLE;
  let row = ROW.IDLE;
  let frame = 0;
  let lastAdvance = now();
  let pulseIndex = -1; // -1 = not pulsing
  let lastCelebrate = false;

  function goTo(nextRow, t) {
    if (nextRow === row) return;
    row = nextRow;
    frame = 0;
    lastAdvance = t;
  }

  function advance() {
    frame += 1;
    if (frame < framesForRow(row)) return;
    frame = 0;
    if (pulseIndex < 0) return;
    pulseIndex += 1;
    if (pulseIndex < CELEBRATE_PULSE.length) {
      row = CELEBRATE_PULSE[pulseIndex];
    } else {
      pulseIndex = -1;
      row = baseRow;
    }
  }

  return {
    setState(state, t = now()) {
      const celebrate = Boolean(state && state.celebrate);
      baseRow = baseRowFor(state);
      if (celebrate && !lastCelebrate) {
        pulseIndex = 0;
        row = CELEBRATE_PULSE[0];
        frame = 0;
        lastAdvance = t;
      } else if (pulseIndex < 0) {
        goTo(baseRow, t);
      }
      lastCelebrate = celebrate;
      return { row, frame };
    },

    tick(t = now()) {
      let guard = 0;
      for (;;) {
        const step = 1000 / fpsForRow(row);
        if (t - lastAdvance < step) break;
        if (guard >= FRAMES_PER_ROW * (CELEBRATE_PULSE.length + 1)) {
          // Long stall (window hidden / clock jump): resync instead of
          // replaying every skipped frame.
          lastAdvance = t;
          break;
        }
        guard += 1;
        lastAdvance += step;
        advance();
      }
      return { row, frame };
    },

    get row() {
      return row;
    },
    get frame() {
      return frame;
    },
    get pulsing() {
      return pulseIndex >= 0;
    },
    get baseRow() {
      return baseRow;
    },
  };
}

/** Crops one grid cell onto the canvas, scaled for the display's DPR. */
export function createSpriteRenderer({
  canvas,
  image,
  frameW = FRAME_W,
  frameH = FRAME_H,
  dpr = 1,
}) {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  canvas.width = Math.round(frameW * scale);
  canvas.height = Math.round(frameH * scale);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  let lastRow = -1;
  let lastFrame = -1;

  return {
    draw(row, frame, force = false) {
      if (!force && row === lastRow && frame === lastFrame) return false;
      lastRow = row;
      lastFrame = frame;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(
        image,
        frame * frameW,
        row * frameH,
        frameW,
        frameH,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      return true;
    },
    invalidate() {
      lastRow = -1;
      lastFrame = -1;
    },
  };
}

/**
 * Click-through arbiter. The window starts ignoring mouse events with
 * {forward: true}, so hover still reaches the DOM; we flip to interactive only
 * while the pointer is over the sprite or the menu (or the menu is open, so
 * travelling between the two does not drop interactivity mid-click).
 */
export function createInteractivity({ setInteractive }) {
  let overPet = false;
  let overMenu = false;
  let menuOpen = false;
  let chatOpen = false;
  let dragging = false;
  let current = null;

  function sync() {
    const want = overPet || overMenu || menuOpen || chatOpen || dragging;
    if (want === current) return current;
    current = want;
    setInteractive(want);
    return current;
  }

  return {
    setOverPet(v) {
      overPet = Boolean(v);
      return sync();
    },
    setOverMenu(v) {
      overMenu = Boolean(v);
      return sync();
    },
    setMenuOpen(v) {
      menuOpen = Boolean(v);
      return sync();
    },
    /**
     * Chat latch. Same shape as menuOpen, and load-bearing for a different
     * reason: an open input has to survive the pointer wandering off the
     * window entirely, because he is looking at the keyboard, not the pet.
     */
    setChatOpen(v) {
      chatOpen = Boolean(v);
      return sync();
    },
    /**
     * Drag latch. The reason it exists rather than leaning on `overPet`: the
     * window chases the cursor, so on a fast drag it lags behind and the pointer
     * spends most of the gesture off the sprite. Without this the overlay would
     * go click-through mid-throw and the mouseup that ends the drag would land
     * on the desktop instead.
     */
    setDragging(v) {
      dragging = Boolean(v);
      return sync();
    },
    /** Pointer left the window entirely — drop every hover latch at once. */
    releaseAll() {
      overPet = false;
      overMenu = false;
      menuOpen = false;
      chatOpen = false;
      dragging = false;
      return sync();
    },
    sync,
    get interactive() {
      return current === true;
    },
  };
}

const MENU_MARGIN = 4;

/** Clamp the menu inside the (small) window so it never renders off-screen. */
export function clampMenu({ x, y, menuW, menuH, viewW, viewH, margin = MENU_MARGIN }) {
  const maxX = Math.max(margin, viewW - menuW - margin);
  const maxY = Math.max(margin, viewH - menuH - margin);
  return {
    x: Math.min(Math.max(x, margin), maxX),
    y: Math.min(Math.max(y, margin), maxY),
  };
}

export function menuLabels({ muted = false, pinned = false } = {}) {
  return {
    'toggle-mute': muted ? 'Unmute' : 'Mute',
    'toggle-pin': pinned ? 'Unpin' : 'Pin',
    // The recall action. Phrased as the owner asking rather than as a command to
    // a window manager — every other label here is a switch, this one is a
    // request to a person. An action with no label renders a blank button, so
    // this entry is what makes `home` reachable at all.
    home: 'Come here',
    quit: 'Quit',
  };
}

/**
 * The reply never came. Something must always take the pending dots back down,
 * so a dead brain reads as a distracted secretary rather than a frozen one.
 *
 * This one stays a sentence while the pending state no longer is (see
 * `THINKING_MARK` in bubbles.mjs): it is a real message, and the difference
 * between the two is that this one is said rarely and has something to say.
 */
export const CHAT_FAILED_LINE = 'Forgive me — my thoughts went quiet just then.';

/**
 * The only two formats main ever sends: Edge's MP3 and the local SAPI
 * fallback's WAV. Anything else is refused rather than pasted into a `src`.
 */
export const AUDIO_MIMES = Object.freeze(['audio/mpeg', 'audio/wav']);

/**
 * Her voice, played through one `<audio>` element.
 *
 * **A new line interrupts the one being spoken; it never queues.** Two reasons,
 * and they are the same two the bubble already answers to. A status line is only
 * worth hearing while it is still true, so a queue would have her narrating
 * something he has already watched finish (this is why speech.mjs drops a
 * throttled line rather than holding it). And the bubble shows the newest line
 * immediately — a queue would leave her voice describing the previous one while
 * he reads this one, which is worse than either on its own.
 *
 * In practice they rarely collide at all: the non-urgent throttle is 90s, and
 * even an urgent interruption clears a 6s floor against the same kind.
 *
 * `el` may be null — an overlay with no audio element is a silent pet, not a
 * broken one.
 */
export function createVoicePlayer({ el } = {}) {
  let playing = false;

  function stop() {
    if (!el) return false;
    try {
      el.pause?.();
      el.removeAttribute?.('src');
      // Without this the element keeps the old buffer and a later play() can
      // resume it instead of the line it was just given.
      el.load?.();
    } catch {
      /* an element that will not stop is not worth an exception */
    }
    playing = false;
    return true;
  }

  return {
    /** Play `{mime, base64}`. Returns false when there was nothing playable. */
    play(payload) {
      if (!el || !payload) return false;
      const { mime, base64 } = payload;
      if (!AUDIO_MIMES.includes(mime) || typeof base64 !== 'string' || base64 === '') return false;
      try {
        el.pause?.();
        el.src = `data:${mime};base64,${base64}`;
        const started = el.play?.();
        // Autoplay is allowed in Electron (`autoplayPolicy` defaults to
        // no-user-gesture-required), but a rejected promise here would be an
        // unhandled rejection in a window with no console open.
        if (started && typeof started.catch === 'function') started.catch(() => {});
        playing = true;
        return true;
      } catch {
        return false;
      }
    },
    stop,
    get playing() {
      return playing;
    },
  };
}

function loadImage({ src, ImageCtor }) {
  return new Promise((resolve, reject) => {
    const img = new ImageCtor();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load spritesheet: ${src}`));
    img.src = src;
  });
}

/**
 * Wire the overlay. Returns {dispose} plus internals for debugging.
 * Injectables exist so this can be driven in a test harness; production calls
 * boot() with no arguments.
 */
export async function boot({
  win = typeof window !== 'undefined' ? window : undefined,
  doc = typeof document !== 'undefined' ? document : undefined,
  ganyu = win && win.ganyu,
  ImageCtor = win && win.Image,
  raf = win && win.requestAnimationFrame ? win.requestAnimationFrame.bind(win) : undefined,
  cancelRaf = win && win.cancelAnimationFrame ? win.cancelAnimationFrame.bind(win) : undefined,
  now = () => (win && win.performance ? win.performance.now() : Date.now()),
} = {}) {
  if (!doc || !ganyu) return null;

  const canvas = doc.getElementById('pet');
  const bubbleEl = doc.getElementById('bubble');
  const menuEl = doc.getElementById('menu');
  const chatEl = doc.getElementById('chat');
  const chatInput = doc.getElementById('chat-input');
  if (!canvas || !bubbleEl || !menuEl || !chatEl || !chatInput) return null;
  // Deliberately not in the guard above: a missing <audio> costs her the sound,
  // and taking the whole overlay down over it would cost him the pet.
  const voiceEl = doc.getElementById('voice');

  const bubbles = createBubbles({ el: bubbleEl });
  const voice = createVoicePlayer({ el: voiceEl });
  const animator = createAnimator({ now });
  const interactivity = createInteractivity({
    setInteractive: (v) => ganyu.setInteractive(v),
  });
  interactivity.sync(); // establish the known-false baseline

  // ---- drag ----------------------------------------------------------------
  // The renderer's whole share of picking her up is the button: down on the
  // sprite, and up anywhere. Main watches the real cursor from there and decides
  // whether that was a click or a pick-up (see createDragTracker in window.mjs),
  // then says so as `dragging` on `ganyu:state`. Deciding it here would need a
  // mousemove that a click-through overlay does not reliably get on this machine.
  //
  // Declared above the state subscription, not beside its listeners: module A
  // force-pushes `ganyu:state` on did-finish-load, which can land while boot() is
  // still awaiting getFlags(), and a `let` read before its declaration throws.

  let pressing = false; // left button is down on the sprite
  let dragging = false; // ...and main promoted it to a drag
  /**
   * A drag ends in a `mouseup` on the sprite, which is also the second half of a
   * `click` — so without this, letting go of her would open the chat strip every
   * single time. Set locally on mouseup rather than waiting for main to confirm
   * the drag ended: `click` fires immediately after `mouseup`, long before an IPC
   * round trip could come back.
   */
  let suppressClick = false;

  function setDragging(value) {
    if (value === dragging) return;
    dragging = value;
    interactivity.setDragging(value);
    // Nothing to aim at while she is in the air, and the menu would be left
    // hanging where she used to be.
    if (value) closeMenu();
  }

  function endPress() {
    if (!pressing) return false;
    pressing = false;
    if (dragging) {
      suppressClick = true;
      setDragging(false);
    }
    bridge('drag', 'release');
    return true;
  }

  // ---- state + speech feeds ------------------------------------------------
  // Subscribed BEFORE any await: module A force-pushes ganyu:state on
  // did-finish-load and then only pushes on change, so a listener registered
  // after `await getFlags()` can miss the only push it will ever get.

  ganyu.onState((state) => {
    animator.setState(state || {}, now());
    setDragging(Boolean(state && state.dragging));
  });
  ganyu.onSpeak((payload) => {
    // Ambient priority: a hook line yields to a reply he is still reading.
    bubbles.show(payload && payload.text, { priority: BUBBLE_PRIORITY.ambient });
  });
  // The audio for a line already shown. Main sends this only for lines that
  // passed the mute and salience gates, so there is nothing left to decide here
  // beyond interrupting whatever she was mid-sentence on.
  if (typeof ganyu.onAudio === 'function') ganyu.onAudio((payload) => voice.play(payload));

  const flags = (await ganyu.getFlags()) || {};
  let muted = Boolean(flags.muted);
  let pinned = Boolean(flags.pinned);

  // ---- menu ----------------------------------------------------------------

  const menuButtons = Array.from(menuEl.querySelectorAll('[data-action]'));

  function paintMenu() {
    const labels = menuLabels({ muted, pinned });
    for (const btn of menuButtons) {
      const label = labels[btn.dataset.action];
      if (label) btn.textContent = label;
    }
  }

  function closeMenu() {
    if (menuEl.hidden) return;
    menuEl.hidden = true;
    // Clearing overMenu too: a menu hidden from under the pointer does not
    // reliably emit mouseleave, and a stuck latch would leave the overlay
    // permanently interactive (i.e. blocking the desktop underneath).
    interactivity.setOverMenu(false);
    interactivity.setMenuOpen(false);
  }

  async function openMenuAt(clientX, clientY) {
    // Re-read flags on open: main may have toggled them from elsewhere.
    try {
      const fresh = (await ganyu.getFlags()) || {};
      muted = Boolean(fresh.muted);
      pinned = Boolean(fresh.pinned);
    } catch {
      /* keep the mirrored values */
    }
    paintMenu();
    // Measure while invisible so the first paint is already at the final spot.
    menuEl.style.visibility = 'hidden';
    menuEl.style.left = '0px';
    menuEl.style.top = '0px';
    menuEl.hidden = false;
    interactivity.setMenuOpen(true);
    const rect = menuEl.getBoundingClientRect();
    const view = doc.documentElement || { clientWidth: 256, clientHeight: 320 };
    const { x, y } = clampMenu({
      x: clientX,
      y: clientY,
      menuW: rect.width,
      menuH: rect.height,
      viewW: view.clientWidth,
      viewH: view.clientHeight,
    });
    menuEl.style.left = `${x}px`;
    menuEl.style.top = `${y}px`;
    menuEl.style.visibility = '';
  }

  paintMenu();

  // ---- chat ----------------------------------------------------------------
  // The input strip is absolutely positioned inside the existing 256x320
  // window (styles.css #chat) — the window must not grow, so the strip lies
  // over the sprite's feet rather than beside it.

  let chatPending = false;

  const bridge = (name, ...args) =>
    (typeof ganyu[name] === 'function' ? ganyu[name](...args) : undefined);

  function chatIsOpen() {
    return chatEl.hidden !== true;
  }

  function openChat() {
    if (chatIsOpen()) {
      if (typeof chatInput.focus === 'function') chatInput.focus();
      return;
    }
    chatEl.hidden = false;
    interactivity.setChatOpen(true);
    // The overlay is constructed focusable:false so it never steals focus from
    // the editor, which also means it cannot receive a keystroke. Main has to
    // make it focusable and focus it before the caret is real.
    bridge('setFocused', true);
    if (typeof chatInput.focus === 'function') chatInput.focus();
  }

  function closeChat() {
    if (!chatIsOpen()) return;
    chatEl.hidden = true;
    chatInput.value = '';
    if (typeof chatInput.blur === 'function') chatInput.blur();
    interactivity.setChatOpen(false);
    // Hand focus back and make the window unfocusable again — an always-on-top
    // overlay that keeps focus is an overlay that swallows the next keystroke
    // meant for the editor.
    bridge('setFocused', false);
  }

  async function submitChat() {
    // Single-flight matches chat.mjs: a second send while one is pending would
    // resolve null there anyway, and would replace this pending bubble with a
    // failure line for a message that is still perfectly in flight.
    if (chatPending) return false;
    const typed = typeof chatInput.value === 'string' ? chatInput.value : '';
    if (typed.trim() === '') return false;

    chatInput.value = '';
    chatPending = true;
    // Dots, not a sentence — she heard him and something is happening, without
    // her saying the same words before every answer she ever gives.
    bubbles.thinking();

    let reply = null;
    try {
      reply = await bridge('sendChat', typed);
    } catch {
      reply = null;
    } finally {
      chatPending = false;
    }

    // Whatever happened, the dots are not allowed to be her last word.
    const line = typeof reply === 'string' && reply.trim() !== '' ? reply : CHAT_FAILED_LINE;
    bubbles.show(line, { priority: BUBBLE_PRIORITY.chat });
    return true;
  }

  // ---- listeners -----------------------------------------------------------

  const off = [];
  function on(target, type, handler, opts) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, handler, opts);
    off.push(() => target.removeEventListener(type, handler, opts));
  }

  on(canvas, 'mouseenter', () => interactivity.setOverPet(true));
  on(canvas, 'mouseleave', () => interactivity.setOverPet(false));
  on(menuEl, 'mouseenter', () => interactivity.setOverMenu(true));
  on(menuEl, 'mouseleave', () => interactivity.setOverMenu(false));

  // Watchdog: pointer left the page. Without this, a fast exit that swallows
  // the canvas mouseleave would leave the window interactive forever.
  const root = doc.documentElement;
  on(root, 'mouseleave', () => {
    if (!menuEl.hidden) return; // keep an open menu usable
    // Same for an open input, and it matters more: he is typing, so the pointer
    // has no reason to stay on a 256px window. Releasing here would make the
    // window click-through mid-sentence and drop the rest of what he types.
    if (chatIsOpen()) return;
    // And the same again mid-drag, where the pointer leaving is not a signal at
    // all — she is being carried, and the window is behind the cursor.
    if (pressing || dragging) return;
    interactivity.releaseAll();
  });

  // Left button down on the sprite starts a *press*, which becomes either a drag
  // or a click. Right-click is the menu and never a pick-up.
  on(canvas, 'mousedown', (ev) => {
    if (ev && ev.button !== undefined && ev.button !== 0) return;
    if (pressing) return;
    pressing = true;
    suppressClick = false;
    bridge('drag', 'press');
  });

  // On the document, not the canvas: a fast drag leaves the window trailing the
  // cursor, so the button can easily come up somewhere else on the overlay.
  on(doc, 'mouseup', (ev) => {
    if (ev && ev.button !== undefined && ev.button !== 0) return;
    endPress();
  });

  // Left-click toggles the chat strip; right-click still opens the menu below.
  on(canvas, 'click', (ev) => {
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    // She was just put down. That is not a request to talk.
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    closeMenu();
    if (chatIsOpen()) closeChat();
    else openChat();
  });

  on(chatInput, 'keydown', (ev) => {
    if (ev.key === 'Enter') {
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      submitChat();
      return;
    }
    if (ev.key === 'Escape') {
      if (typeof ev.preventDefault === 'function') ev.preventDefault();
      closeChat();
    }
  });

  on(canvas, 'contextmenu', (ev) => {
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    if (menuEl.hidden) openMenuAt(ev.clientX, ev.clientY);
    else closeMenu();
  });
  on(menuEl, 'contextmenu', (ev) => {
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
  });

  on(menuEl, 'click', (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('[data-action]') : null;
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'toggle-mute') muted = !muted;
    if (action === 'toggle-pin') pinned = !pinned;
    paintMenu();
    closeMenu();
    ganyu.menuAction(action);
  });

  on(doc, 'mousedown', (ev) => {
    const target = ev && ev.target;
    const inside = (el) => Boolean(el.contains && el.contains(target));
    if (!menuEl.hidden && !inside(menuEl)) closeMenu();
    // The sprite is exempt: mousedown precedes click, so closing here would let
    // the click that follows reopen an input he had just typed into.
    if (chatIsOpen() && target !== canvas && !inside(chatEl)) closeChat();
  });
  on(doc, 'keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    closeMenu();
    closeChat();
  });
  on(win, 'blur', () => {
    closeMenu();
    // He clicked into the editor. Close, and give up focusability with it.
    closeChat();
    // A press the window will never see the end of. Put her down rather than
    // leaving her stuck to a cursor that has gone somewhere else.
    endPress();
  });

  // ---- sprite --------------------------------------------------------------

  let renderer = null;
  const spritePath = flags.spritePath;
  if (spritePath && ImageCtor) {
    try {
      const image = await loadImage({ src: spritePath, ImageCtor });
      renderer = createSpriteRenderer({
        canvas,
        image,
        dpr: (win && win.devicePixelRatio) || 1,
      });
    } catch (err) {
      canvas.dataset.broken = '1';
      console.error('[ganyu] sprite load failed', err);
    }
  } else {
    canvas.dataset.broken = '1';
    console.error('[ganyu] no spritePath in flags');
  }

  // ---- frame loop ----------------------------------------------------------

  let handle = null;
  let running = Boolean(renderer && raf);
  function loop() {
    const { row, frame } = animator.tick(now());
    renderer.draw(row, frame);
    if (running) handle = raf(loop);
  }
  if (running) handle = raf(loop);

  return {
    animator,
    bubbles,
    voice,
    interactivity,
    renderer,
    chat: { open: openChat, close: closeChat, submit: submitChat, get isOpen() { return chatIsOpen(); } },
    drag: { get pressing() { return pressing; }, get dragging() { return dragging; } },
    flags: { get muted() { return muted; }, get pinned() { return pinned; }, spritePath },
    dispose() {
      running = false;
      if (handle !== null && cancelRaf) cancelRaf(handle);
      handle = null;
      endPress(); // tell main before the listeners go, or the drag outlives us
      for (const undo of off.splice(0)) undo();
      bubbles.hide();
      voice.stop(); // a bubble torn down while she is still speaking is a ghost
      closeMenu();
      closeChat();
      interactivity.releaseAll();
    },
  };
}

// Auto-boot in the renderer only. Importing this module in node is inert.
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const start = () => {
    boot().catch((err) => console.error('[ganyu] renderer boot failed', err));
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}
