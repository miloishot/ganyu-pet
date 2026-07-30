// Module E — idle wander scheduler.
//
// Every side effect is injected, so this file imports nothing: no Electron, no
// timers of its own, no Date. That is what lets `test/wander.test.mjs` drive it
// with a fake clock and a virtual scheduler and still exercise the real
// constants (90s arming, 2-5min gaps, 60px/s, 50ms ticks, 3-8s pauses).
//
// Production wiring (module A):
//   createWander({
//     clock: { now: () => Date.now() },
//     schedule: (fn, ms) => { const t = setTimeout(fn, ms); return () => clearTimeout(t); },
//     moveWindow: (x, y) => win.setPosition(x, y),
//     getWorkArea: () => screen.getPrimaryDisplay().workArea,
//     onWalkState: (walk) => pushStateToRenderer({ walk }),
//     isPinned: () => flags.pinned,
//     random: Math.random,
//   })
// then, on every aggregate state change: wander.setMode(state.aggregate())

export const WANDER_DEFAULTS = Object.freeze({
  idleArmMs: 90_000, // aggregate mode must stay `idle` this long before we stroll
  gapMinMs: 120_000, // 2 min
  gapMaxMs: 300_000, // 5 min
  speedPxPerSec: 60,
  tickMs: 50,
  pauseChance: 0.35, // odds of one mid-walk breather per stroll
  pauseMinMs: 3_000,
  pauseMaxMs: 8_000,
  maxTickDtMs: 250, // clamp: a late/suspended timer must not teleport the pet
  windowWidth: 256, // contracts.md "Window (module A)" — ~256x320
  windowHeight: 320,
});

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

export function createWander({
  clock,
  schedule,
  moveWindow,
  getWorkArea,
  onWalkState = () => {},
  isPinned = () => false,
  random = Math.random,
  // Optional: lets the pet resume from where the user actually dragged it.
  // Without it we track x ourselves, seeded to the bottom-right corner (the
  // same initial position module A uses).
  getPosition = null,
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

  let armTimer = null; // the 90s idle countdown, or the 2-5min gap between strolls
  let tickTimer = null;
  let pauseTimer = null;

  let strolling = false; // true for a whole stroll, mid-walk pause included
  let walkDir = null; // last value handed to onWalkState
  let x = null; // tracked window position (float; rounded before moveWindow)
  let y = null;
  let target = null;
  let pauseAtX = null; // x threshold that triggers this stroll's breather
  let lastTickAt = 0;

  function bounds() {
    const wa = getWorkArea() || {};
    const ax = num(wa.x, 0);
    const ay = num(wa.y, 0);
    const aw = num(wa.width, 0);
    const ah = num(wa.height, 0);
    return {
      minX: ax,
      maxX: Math.max(ax, ax + aw - windowWidth),
      bottomY: Math.max(ay, ay + ah - windowHeight),
    };
  }

  function syncPosition(b) {
    if (typeof getPosition === 'function') {
      const p = getPosition();
      if (p && Number.isFinite(p.x)) x = p.x;
    }
    if (!Number.isFinite(x)) x = b.maxX; // bottom-right, matching module A's initial placement
    x = clamp(x, b.minX, b.maxX);
    y = b.bottomY; // Y is pinned to the bottom edge, always
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

  function cancelAll() {
    cancelHandle(armTimer);
    armTimer = null;
    abortStroll();
  }

  function scheduleNextStroll() {
    cancelHandle(armTimer);
    armTimer = schedule(onArmTimer, between(D.gapMinMs, D.gapMaxMs));
  }

  function onArmTimer() {
    armTimer = null;
    if (stopped || mode !== 'idle') return;
    // Pinned never strolls; keep polling so unpinning resumes without needing
    // another state change.
    if (isPinned()) {
      scheduleNextStroll();
      return;
    }
    startStroll();
  }

  function startStroll() {
    const b = bounds();
    syncPosition(b);

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

  function tick() {
    tickTimer = null;
    if (stopped) return;
    if (mode !== 'idle') {
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

    if (Math.abs(target - x) <= step) {
      x = target;
      moveWindow(Math.round(x), Math.round(y));
      endStroll();
      return;
    }

    x += dir * step;
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
    if (mode !== 'idle') {
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
    // state object from module B (`{mode, ...}`). Repeated `idle` notifications
    // are ignored, so a busy event stream that keeps the aggregate at `idle`
    // never restarts the 90s countdown.
    setMode(next) {
      if (stopped) return;
      const m = readMode(next);
      if (m === mode) return;
      mode = m;
      if (m === 'idle') {
        cancelHandle(armTimer);
        armTimer = schedule(onArmTimer, D.idleArmMs);
      } else {
        cancelAll(); // instant cancel: window stays where it is, walk state cleared
      }
    },

    // Reversible cancel: drop the in-flight stroll and any pending timer, then
    // re-arm the 90s countdown if the aggregate mode is still idle. This is the
    // right call for a transient "stop moving now" (module A invokes it when the
    // user pins the pet) — unlike stop(), the pet strolls again once the reason
    // goes away. Deliberately named `cancel` because module A resolves its
    // handle with pickMethod(wander, ['cancel', 'stop', ...]) and would
    // otherwise reach for the irreversible stop() on every pin toggle.
    cancel() {
      if (stopped) return;
      cancelAll();
      if (mode === 'idle') armTimer = schedule(onArmTimer, D.idleArmMs);
    },

    // Teardown (app quit). Irreversible.
    stop() {
      stopped = true;
      cancelAll();
      mode = null;
    },

    // For `GET /state`.wandering — true for the whole stroll, breather included.
    isWandering() {
      return strolling;
    },

    // Diagnostics/tests: a countdown or gap timer is pending, or we are strolling.
    isArmed() {
      return armTimer !== null || strolling;
    },
  };
}

export default createWander;
