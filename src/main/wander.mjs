// Module E — wander scheduler.
//
// Every side effect is injected, so this file imports nothing: no Electron, no
// timers of its own, no Date. That is what lets `test/wander.test.mjs` drive it
// with a fake clock and a virtual scheduler and still exercise the real
// constants (20s arming, 45-120s gaps, 60px/s, 50ms ticks, 3-8s pauses).
//
// Why `busy` is a *calm* mode rather than a reason to stand still: the owner
// always has codex or Claude Code sessions open, so the lifecycle-hook stream
// keeps the aggregate mode pinned at `busy` for hours on end and `idle` never
// arrives. Gating the stroll on `idle` alone therefore meant she never strolled
// at all — she just looped the non-directional busy run on the spot. She now
// walks through `idle` and `busy` alike (CALM_MODES); only the attention modes
// (`waiting`, `failed`) freeze her where she stands, which is the whole point of
// those modes — she should be beside whatever needs looking at, not halfway
// across the screen.
//
// Containment is the other half of this module's job, and the half that was
// missing: the pet went off-screen and stayed there. Three rules cover it.
//   1. The window is *measured*, never assumed. Windows adds a few pixels of
//      invisible frame even to a frameless transparent window — the 256x320 this
//      module used to hardcode is really 260x324 once created, so every edge
//      landed 4px outside the work area. `getWindowSize` (production:
//      `win.getBounds()`) is read on every `bounds()` call.
//   2. `containNow()` re-clamps at any time, from any state. The old code only
//      clamped at the start of a stroll, so a resolution change, a monitor being
//      undocked, or a drag left her outside with nothing to pull her back — and
//      if the aggregate mode was stuck non-calm (`waiting`/`failed`) no stroll
//      ever came, so she stayed lost with no way to recall her.
//   3. Gravity. Above the floor she falls, bounces, and settles on it. Falling
//      outranks strolling, and unlike strolling it also runs while pinned and
//      while the mode is non-calm — gravity is containment, not behaviour.
//
// Production wiring (module A):
//   createWander({
//     clock: { now: () => Date.now() },
//     schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
//     moveWindow: (x, y) => moveWindowPinned(win, x, y),  // NOT win.setPosition
//     getWorkArea: () => screen.getPrimaryDisplay().workArea,
//     getWindowSize: () => win.getBounds(),      // measured, incl. the invisible frame
//     getPosition: () => { const [x, y] = win.getPosition(); return { x, y }; },
//     onWalkState: (walk) => pushStateToRenderer({ walk }),
//     isPinned: () => flags.pinned,
//     random: Math.random,
//   })
// then, on every aggregate state change: wander.setMode(state.aggregate())
// and call wander.containNow() on startup, from the 1s state poll, and on the
// `screen` events display-metrics-changed / display-added / display-removed.

export const WANDER_DEFAULTS = Object.freeze({
  armMs: 20_000, // aggregate mode must stay calm this long before the first stroll
  gapMinMs: 45_000,
  gapMaxMs: 120_000,
  speedPxPerSec: 60,
  tickMs: 50,
  pauseChance: 0.35, // odds of one mid-walk breather per stroll
  pauseMinMs: 3_000,
  pauseMaxMs: 8_000,
  maxTickDtMs: 250, // clamp: a late/suspended timer must not teleport the pet
  // Canonical window size. `getWindowSize` supersedes it when injected, but only
  // within maxSizeDriftPx — see windowSize().
  windowWidth: 256, // contracts.md "Window (module A)" — ~256x320
  windowHeight: 320,
  // A measured size further than this from the canonical one is not a window, it
  // is drift: a bare setPosition on Windows at fractional DPI inflates the window
  // a little per call and compounds into thousands of px (see window.mjs
  // moveWindowPinned). Module A pins the size to stop it, and this is module E's
  // own guard so a garbage reading can never corrupt the floor and maxX. The
  // legitimate mismatch it has to tolerate is only a few px of frame rounding.
  maxSizeDriftPx: 32,
  // Physics. Falling reuses the tickMs cadence and the maxTickDtMs clamp.
  gravityPxPerSec2: 1400,
  maxFallPxPerSec: 900, // terminal velocity
  restitution: 0.25, // fraction of impact speed returned by a bounce
  minBounceVelocity: 120, // below this a rebound settles instead of bouncing
});

/** Sub-pixel slack, so float jitter at rest cannot re-trigger a fall. */
const FLOOR_EPS = 0.5;

// The modes she is content to stroll through. `busy` is in here deliberately —
// see the header. Anything outside this list (`waiting`, `failed`, and any mode
// a future module B invents) aborts a stroll instantly and keeps her put.
export const CALM_MODES = Object.freeze(['idle', 'busy']);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);

// `schedule` is documented to return a cancel handle. Accept a cancel function
// (preferred), an object with .cancel(), or a raw setTimeout handle, so a naive
// `schedule: setTimeout` wiring still cancels instead of leaking ghost ticks.
function cancelHandle(handle) {
  if (!handle) return;
  if (typeof handle === 'function') handle();
  else if (typeof handle.cancel === 'function') handle.cancel();
  else clearTimeout(handle);
}

function readMode(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value.mode === 'string') return value.mode;
  return 'unknown';
}

// Accepts a mode string or a whole module B state object, so callers can hand it
// the same value they hand setMode(). An unset mode (null) is not calm.
export function isCalm(value) {
  return CALM_MODES.includes(readMode(value));
}

export function createWander({
  clock,
  schedule,
  moveWindow,
  getWorkArea,
  onWalkState = () => {},
  isPinned = () => false,
  random = Math.random,
  // Optional: lets the pet resume from where the user actually dragged it, and
  // is what makes containment possible at all — without it we only know the
  // position we last set. Seeded to the bottom-right corner (the same initial
  // position module A uses) when absent.
  getPosition = null,
  // Optional but wired in production: the *measured* outer size of the window,
  // `{width, height}` (extra keys ignored, so `win.getBounds()` fits). Windows
  // adds invisible frame padding, so the constants below are 4px optimistic and
  // used only as a fallback.
  getWindowSize = null,
  windowWidth = WANDER_DEFAULTS.windowWidth,
  windowHeight = WANDER_DEFAULTS.windowHeight,
} = {}) {
  const D = WANDER_DEFAULTS;

  for (const [name, fn] of [
    ['clock.now', clock && clock.now],
    ['schedule', schedule],
    ['moveWindow', moveWindow],
    ['getWorkArea', getWorkArea],
  ]) {
    if (typeof fn !== 'function') {
      throw new TypeError(`createWander: ${name} must be a function`);
    }
  }

  let mode = null; // last aggregate mode we were told about
  let stopped = false;

  let armTimer = null; // the 20s calm countdown, or the 45-120s gap between strolls
  let tickTimer = null;
  let pauseTimer = null;
  let fallTimer = null; // separate from tickTimer: a stroll abort must not kill a fall

  let strolling = false; // true for a whole stroll, mid-walk pause included
  let falling = false;
  let walkDir = null; // last value handed to onWalkState
  let x = null; // tracked window position (float; rounded before moveWindow)
  let y = null;
  let vy = 0; // vertical velocity, px/s, positive = downward
  let target = null;
  let pauseAtX = null; // x threshold that triggers this stroll's breather
  let lastTickAt = 0;
  let lastFallAt = 0;

  /**
   * The measured outer size of the window, falling back to the canonical constants
   * when `getWindowSize` is absent, throws, or reports something implausible.
   * Read on every `bounds()` call rather than cached: a DPI change resizes the
   * window.
   *
   * The implausibility check is not paranoia. On Windows at fractional DPI a bare
   * `setPosition` inflates the window on every call, and mid-drift `getBounds()`
   * reports sizes in the thousands. Trusting one of those readings would push the
   * floor and maxX far off-screen and lose the pet completely — the exact failure
   * being fixed. Module A pins the size so it cannot drift; this is module E
   * refusing to be corrupted even if that ever stops working.
   */
  function windowSize() {
    if (typeof getWindowSize === 'function') {
      try {
        const s = getWindowSize();
        const w = s && s.width;
        const h = s && s.height;
        if (
          Number.isFinite(w) && w > 0 && Math.abs(w - windowWidth) <= D.maxSizeDriftPx &&
          Number.isFinite(h) && h > 0 && Math.abs(h - windowHeight) <= D.maxSizeDriftPx
        ) {
          return { width: w, height: h };
        }
      } catch {
        // A destroyed window throws; the constants are still a usable answer.
      }
    }
    return { width: windowWidth, height: windowHeight };
  }

  function bounds() {
    const wa = getWorkArea() || {};
    const ax = num(wa.x, 0);
    const ay = num(wa.y, 0);
    const aw = num(wa.width, 0);
    const ah = num(wa.height, 0);
    const size = windowSize();
    return {
      minX: ax,
      maxX: Math.max(ax, ax + aw - size.width),
      minY: ay,
      bottomY: Math.max(ay, ay + ah - size.height),
    };
  }

  /**
   * Adopt the window's real position. Skipped while we are moving it ourselves —
   * mid-motion this module owns the position, and re-reading a rounded value
   * every tick would fight the float integration.
   */
  function readPosition() {
    if (strolling || falling) return;
    if (typeof getPosition !== 'function') return;
    try {
      const p = getPosition();
      if (!p) return;
      if (Number.isFinite(p.x)) x = p.x;
      if (Number.isFinite(p.y)) y = p.y;
    } catch {
      // Keep the tracked values.
    }
  }

  function syncPosition(b) {
    readPosition();
    if (!Number.isFinite(x)) x = b.maxX; // bottom-right, matching module A's initial placement
    if (!Number.isFinite(y)) y = b.bottomY;
    x = clamp(x, b.minX, b.maxX);
    y = clamp(y, b.minY, b.bottomY);
  }

  function pushWalk(next) {
    const dir = next ? next.dir : null;
    if (dir === walkDir) return;
    walkDir = dir;
    onWalkState(dir ? { dir } : null);
  }

  function between(lo, hi) {
    return lo + random() * (hi - lo);
  }

  function clearMotionTimers() {
    cancelHandle(tickTimer);
    tickTimer = null;
    cancelHandle(pauseTimer);
    pauseTimer = null;
  }

  // Abandon the current stroll where it stands. Does not schedule anything.
  function abortStroll() {
    clearMotionTimers();
    strolling = false;
    target = null;
    pauseAtX = null;
    pushWalk(null);
  }

  // Deliberately leaves a fall in progress alone: `cancel()` is the pin toggle and
  // setMode's non-calm branch, and neither pinning nor a `failed` mode is a reason
  // to leave her hanging in mid-air. Only stop() (teardown) kills the fall.
  function cancelAll() {
    cancelHandle(armTimer);
    armTimer = null;
    abortStroll();
  }

  function scheduleNextStroll() {
    cancelHandle(armTimer);
    armTimer = schedule(onArmTimer, between(D.gapMinMs, D.gapMaxMs));
  }

  // ------------------------------------------------------------------ gravity

  /** Back to normal scheduling after a landing, without stealing a pending timer. */
  function afterLanding() {
    if (stopped || armTimer !== null || !isCalm(mode)) return;
    scheduleNextStroll();
  }

  function startFall() {
    if (stopped || falling) return false;
    if (strolling) abortStroll(); // gravity outranks the stroll
    falling = true;
    vy = 0;
    lastFallAt = clock.now();
    cancelHandle(fallTimer);
    fallTimer = schedule(fallTick, D.tickMs);
    return true;
  }

  /**
   * Start falling if she is above the floor — dragged up, or left high by a
   * display change. Runs regardless of mode and pinned state.
   */
  function maybeFall(b) {
    if (stopped || falling || !Number.isFinite(y)) return false;
    if (y >= b.bottomY - FLOOR_EPS) return false;
    return startFall();
  }

  function fallTick() {
    fallTimer = null;
    if (stopped || !falling) return;

    const b = bounds();
    const now = clock.now();
    const dt = clamp(now - lastFallAt, 0, D.maxTickDtMs) / 1000; // same clamp as tick()
    lastFallAt = now;

    vy = Math.min(vy + D.gravityPxPerSec2 * dt, D.maxFallPxPerSec);
    y += vy * dt;
    x = clamp(x, b.minX, b.maxX); // the work area can change mid-fall

    if (y < b.bottomY) {
      moveWindow(Math.round(x), Math.round(y));
      fallTimer = schedule(fallTick, D.tickMs);
      return;
    }

    const rebound = vy * D.restitution;
    y = b.bottomY; // exactly on the floor, whether she bounces or settles
    moveWindow(Math.round(x), Math.round(y));

    if (rebound >= D.minBounceVelocity) {
      vy = -rebound;
      fallTimer = schedule(fallTick, D.tickMs);
      return;
    }

    vy = 0;
    falling = false;
    afterLanding();
  }

  /**
   * Pull the window back inside the work area from wherever it is, then hand off
   * to gravity if it is above the floor. Safe to call at any time and from any
   * state — no mode check, no pinned check, no stroll required — and a no-op (no
   * moveWindow call) when she is already fully inside. Returns true if it moved
   * her. Module A calls this on startup, from the 1s state poll, and on the
   * `screen` display events.
   */
  function containNow() {
    if (stopped) return false;
    const b = bounds();
    readPosition();
    // Nothing known and nothing to read: seed the corner without moving her.
    if (!Number.isFinite(x)) x = b.maxX;
    if (!Number.isFinite(y)) y = b.bottomY;

    const cx = clamp(x, b.minX, b.maxX);
    const cy = clamp(y, b.minY, b.bottomY);
    const moved = cx !== x || cy !== y;
    x = cx;
    y = cy;
    if (moved) moveWindow(Math.round(x), Math.round(y));

    maybeFall(b);
    return moved;
  }

  function onArmTimer() {
    armTimer = null;
    if (stopped || !isCalm(mode)) return;
    // Pinned never strolls, and neither does a pet still in the air; keep polling
    // so unpinning (or landing) resumes without needing another state change.
    if (isPinned() || falling) {
      scheduleNextStroll();
      return;
    }
    startStroll();
  }

  function startStroll() {
    const b = bounds();
    syncPosition(b);
    if (maybeFall(b)) return; // dragged up since the last stroll: fall first

    target = clamp(Math.round(between(b.minX, b.maxX)), b.minX, b.maxX);

    pauseAtX = null;
    if (random() < D.pauseChance) {
      pauseAtX = x + (target - x) * (0.3 + random() * 0.4);
    }

    if (Math.abs(target - x) < 1) {
      // Already there — skip rather than flash a one-frame walk animation.
      endStroll();
      return;
    }

    strolling = true;
    pushWalk({ dir: target > x ? 'right' : 'left' });
    lastTickAt = clock.now();
    tickTimer = schedule(tick, D.tickMs);
  }

  /**
   * A wall moved under her — the work area shrank, the window grew, or she was
   * dropped outside — so turn around at the edge and keep walking toward a fresh
   * target on the way back instead of stopping dead against it.
   */
  function turnAround(b, wall, dirAfter) {
    x = wall;
    moveWindow(Math.round(x), Math.round(y));

    const span = dirAfter > 0 ? b.maxX - x : x - b.minX;
    if (span < 1) {
      endStroll(); // no room to walk in either direction
      return;
    }
    target = clamp(Math.round(x + dirAfter * between(1, span)), b.minX, b.maxX);
    pauseAtX = null; // the breather threshold belonged to the abandoned path
    pushWalk({ dir: dirAfter > 0 ? 'right' : 'left' });
    tickTimer = schedule(tick, D.tickMs);
  }

  function tick() {
    tickTimer = null;
    if (stopped) return;
    const b = bounds();
    if (maybeFall(b)) return; // gravity outranks the stroll, the mode and the pin
    if (!isCalm(mode)) {
      abortStroll();
      return;
    }
    if (isPinned()) {
      abortStroll();
      scheduleNextStroll();
      return;
    }

    const now = clock.now();
    const dt = clamp(now - lastTickAt, 0, D.maxTickDtMs);
    lastTickAt = now;

    const step = (D.speedPxPerSec * dt) / 1000;
    const dir = target > x ? 1 : -1;

    // Arrival wins over the wall check, so a target sitting exactly on an edge
    // still ends the stroll rather than bouncing off it. A target now *outside*
    // the work area cannot be arrived at, and falls through to the wall check.
    if (Math.abs(target - x) <= step && target >= b.minX && target <= b.maxX) {
      x = target;
      moveWindow(Math.round(x), Math.round(y));
      endStroll();
      return;
    }

    const next = x + dir * step;
    if (next < b.minX) {
      turnAround(b, b.minX, 1);
      return;
    }
    if (next > b.maxX) {
      turnAround(b, b.maxX, -1);
      return;
    }

    x = next;
    moveWindow(Math.round(x), Math.round(y));

    if (pauseAtX !== null && (dir > 0 ? x >= pauseAtX : x <= pauseAtX)) {
      pauseAtX = null;
      pushWalk(null); // stand still, idle animation, still "wandering"
      pauseTimer = schedule(resume, between(D.pauseMinMs, D.pauseMaxMs));
      return;
    }

    tickTimer = schedule(tick, D.tickMs);
  }

  function resume() {
    pauseTimer = null;
    if (stopped) return;
    if (maybeFall(bounds())) return; // dragged up mid-breather
    if (!isCalm(mode)) {
      abortStroll();
      return;
    }
    if (isPinned()) {
      abortStroll();
      scheduleNextStroll();
      return;
    }
    pushWalk({ dir: target > x ? 'right' : 'left' });
    lastTickAt = clock.now();
    tickTimer = schedule(tick, D.tickMs);
  }

  function endStroll() {
    clearMotionTimers();
    strolling = false;
    target = null;
    pauseAtX = null;
    pushWalk(null);
    scheduleNextStroll();
  }

  return {
    // Call on every aggregate state change. Accepts a mode string or the whole
    // state object from module B (`{mode, ...}`). Repeated identical modes are
    // ignored, and so is every hop between two calm modes — idle<->busy churns
    // constantly as sessions start and stop, and treating that as a state change
    // would abort her stroll every few seconds. So a calm->calm transition
    // leaves an in-flight stroll walking and leaves the countdown running;
    // only arriving in a calm mode from a non-calm one arms it.
    setMode(next) {
      if (stopped) return;
      const m = readMode(next);
      if (m === mode) return;
      const wasCalm = isCalm(mode);
      mode = m;
      if (!isCalm(m)) {
        cancelAll(); // instant cancel: window stays where it is, walk state cleared
      } else if (!wasCalm) {
        cancelHandle(armTimer);
        armTimer = schedule(onArmTimer, D.armMs);
      }
    },

    // Reversible cancel: drop the in-flight stroll and any pending timer, then
    // re-arm the countdown if the aggregate mode is still calm. This is the
    // right call for a transient "stop moving now" (module A invokes it when the
    // user pins the pet) — unlike stop(), the pet strolls again once the reason
    // goes away. Deliberately named `cancel` because module A resolves its
    // handle with pickMethod(wander, ['cancel', 'stop', ...]) and would
    // otherwise reach for the irreversible stop() on every pin toggle.
    cancel() {
      if (stopped) return;
      cancelAll();
      if (isCalm(mode)) armTimer = schedule(onArmTimer, D.armMs);
    },

    // Teardown (app quit). Irreversible — and the only thing that cancels a fall.
    stop() {
      stopped = true;
      cancelAll();
      cancelHandle(fallTimer);
      fallTimer = null;
      falling = false;
      vy = 0;
      mode = null;
    },

    // Containment, callable at any time from any state. See containNow above.
    containNow,

    // For `GET /state`.wandering — true for the whole stroll, breather included.
    isWandering() {
      return strolling;
    },

    // Diagnostics/tests: a countdown or gap timer is pending, or we are strolling.
    // Falling is deliberately not "armed" — it is containment, not a stroll.
    isArmed() {
      return armTimer !== null || strolling;
    },

    // Diagnostics/tests: mid-fall or mid-bounce.
    isFalling() {
      return falling;
    },
  };
}

export default createWander;
