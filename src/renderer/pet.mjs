// Module C — canvas sprite engine + hover/menu wiring for the Ganyu overlay.
//
// Spritesheet: 8 columns x 9 rows of 192x208 frames (verified: the installed
// ganyu--chenxin-dlut sheet is exactly 1536x1872). The path arrives from
// ganyu.getFlags().spritePath as a file:// URL; nothing here reads the disk.
//
// Everything with a side effect is injectable so this file imports cleanly in
// plain node (no Electron, no DOM) for unit checks.

import { createBubbles } from './bubbles.mjs';

export const FRAME_W = 192;
export const FRAME_H = 208;
export const FRAMES_PER_ROW = 8;
export const ROW_COUNT = 9;

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
  busy: ROW.BUSY,
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

/**
 * The row a state resolves to ignoring the celebrate pulse: a walk direction
 * wins over the mode (wander only runs while idle), otherwise mode -> row.
 */
export function baseRowFor(state) {
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
    if (frame < FRAMES_PER_ROW) return;
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
  let current = null;

  function sync() {
    const want = overPet || overMenu || menuOpen;
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
    quit: 'Quit',
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
  if (!canvas || !bubbleEl || !menuEl) return null;

  const flags = (await ganyu.getFlags()) || {};
  let muted = Boolean(flags.muted);
  let pinned = Boolean(flags.pinned);

  const bubbles = createBubbles({ el: bubbleEl });
  const animator = createAnimator({ now });
  const interactivity = createInteractivity({
    setInteractive: (v) => ganyu.setInteractive(v),
  });
  interactivity.sync(); // establish the known-false baseline

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
    menuEl.hidden = false;
    interactivity.setMenuOpen(true);
    const rect = menuEl.getBoundingClientRect();
    const view = doc.documentElement;
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
  }

  paintMenu();

  // ---- listeners -----------------------------------------------------------

  const off = [];
  function on(target, type, handler, opts) {
    target.addEventListener(type, handler, opts);
    off.push(() => target.removeEventListener(type, handler, opts));
  }

  on(canvas, 'mouseenter', () => interactivity.setOverPet(true));
  on(canvas, 'mouseleave', () => interactivity.setOverPet(false));
  on(menuEl, 'mouseenter', () => interactivity.setOverMenu(true));
  on(menuEl, 'mouseleave', () => interactivity.setOverMenu(false));

  on(canvas, 'contextmenu', (ev) => {
    ev.preventDefault();
    if (menuEl.hidden) openMenuAt(ev.clientX, ev.clientY);
    else closeMenu();
  });
  on(menuEl, 'contextmenu', (ev) => ev.preventDefault());

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
    if (menuEl.hidden) return;
    if (menuEl.contains(ev.target)) return;
    closeMenu();
  });
  on(doc, 'keydown', (ev) => {
    if (ev.key === 'Escape') closeMenu();
  });
  if (win) on(win, 'blur', () => closeMenu());

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

  // ---- state + speech feeds ------------------------------------------------

  ganyu.onState((state) => {
    animator.setState(state || {}, now());
  });
  ganyu.onSpeak((payload) => {
    bubbles.show(payload && payload.text);
  });

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
    interactivity,
    renderer,
    dispose() {
      running = false;
      if (handle !== null && cancelRaf) cancelRaf(handle);
      handle = null;
      for (const undo of off.splice(0)) undo();
      bubbles.hide();
      closeMenu();
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
