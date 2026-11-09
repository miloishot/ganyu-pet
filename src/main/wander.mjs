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
// Being picked up is the fourth rule, and it is why `grab`/`moveTo`/`release`
// live here rather than in module A. Module A owns the *input* (which button
// went down, where the cursor is), but there must be exactly one writer of the
// window position or the drag and the stroll fight each other 20 times a second.
// So a drag suspends this module the same way `waiting`/`failed` does — arm
// timer cancelled, stroll abandoned, fall dropped — and every dragged pixel goes
// out through the same `moveWindow` as every strolled one. `release` hands the
// cursor's velocity back to the physics, which is what turns a flick into a
// throw: she keeps her horizontal speed through the air, bounces off the side
// walls, and skids to a stop on the floor.
//
// Perching is the fifth rule, and it changes what "the floor" means rather than
// adding a new kind of motion. `getLedges` hands over the visible top edges of
// other windows; every one she fits on is a *surface*, and the floor is simply
// the lowest surface, the one spanning the whole work area. Everything above then
// runs unchanged against "the surface under her": she rests on one, falls when she
// is on none, lands on the highest one below her feet, bounces and skids on it,
// and strolls only between its ends. One physics loop rather than a second one for
// ledges, so a ledge can never drift out of step with how the floor behaves. Two
// rules keep it honest: a ledge is re-validated against this module's own bounds
// on every read (the list is a snapshot of other processes' windows, and her size
// or the work area may have changed since), and a ledge is never "under" her once
// it has risen above her feet — a window moving up can drop her, never teleport
// her onto it. With no ledges this is exactly the floor-only module it was.
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
//     getLedges: () => ledgeSource.current(),  // ledges.mjs; [] when GANYU_PERCH=0 or the helper is down
//   })
// then, on every aggregate state change: wander.setMode(state.aggregate())
// and call wander.containNow() on startup, from the 1s state poll, on the
// `screen` events display-metrics-changed / display-added / display-removed, and
// from ledgeSource.onChange — a window moving out from under her is a display
// change in miniature, and containNow is what notices she is standing on air.

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
  // Throw physics. A wall returns more than the floor does on purpose: at the
  // floor's 0.25 a thrown pet hits the side of the screen and stops dead, which
  // reads as a collision bug rather than as a bounce.
  wallRestitution: 0.5,
  // Landing with horizontal speed left is a skid, not a full stop — without it a
  // flick along the floor (where there is no air time to spend the speed in) does
  // nothing at all, which reads as the throw having been ignored.
  groundFrictionPxPerSec2: 1600,
  minSlideVelocity: 40, // below this a skid stops, and a release is not a throw
  // A flick can report an arbitrarily large cursor velocity if the sample window
  // catches a single huge jump; this is the ceiling on what physics is handed.
  maxThrowPxPerSec: 2400,
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
  // Fires on the edges of "off the ground" — held in the cursor, or mid-flight.
  // The renderer draws the jump row from it; nothing here depends on it, so the
  // default no-op is a complete wiring.
  onAirborne = () => {},
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
  // Optional: the top edges of other windows she can stand on, as
  // `{left, right, top, hwnd}` in DIP (see readLedges). Absent, throwing, or
  // returning garbage means "no ledges", which is the floor-only behaviour.
  getLedges = null,
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
  let held = false; // in the cursor: this module still owns the position, module A aims it
  let airborne = false; // last value handed to onAirborne (held or falling)
  let walkDir = null; // last value handed to onWalkState
  let x = null; // tracked window position (float; rounded before moveWindow)
  let y = null;
  let vx = 0; // horizontal velocity, px/s — only ever non-zero after a throw
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
    const minX = ax;
    const maxX = Math.max(ax, ax + aw - size.width);
    const minY = ay;
    const bottomY = Math.max(ay, ay + ah - size.height);
    return { minX, maxX, minY, bottomY, ledges: readLedges(minX, maxX, minY, bottomY, size) };
  }

  /**
   * The ledges she can stand on, as surfaces `{y, lo, hi}`: `y` is the window-y
   * she stands at (the edge's top minus her height — her feet are the window's
   * bottom edge, exactly as for the floor) and `[lo, hi]` the window-x range in
   * which her whole footprint is on the edge.
   *
   * Re-validated here against this module's own bounds rather than trusted: the
   * list is a snapshot of other processes' windows, taken against whatever her
   * size and the work area were at the time. A ledge she would stand on above the
   * top of the work area, or that is not clearly above the floor, or that she does
   * not fit on, is not a surface. Read fresh on every bounds() call, never cached
   * (production returns a ready-made array, so it is cheap), and never mutated —
   * it may be a frozen array shared with other readers. Anything malformed is
   * dropped entry by entry, and a getLedges that throws or returns a non-array
   * means no ledges at all: perching is an extra, so a broken helper must leave
   * the floor-only behaviour standing rather than take containment down with it.
   */
  function readLedges(minX, maxX, minY, bottomY, size) {
    if (typeof getLedges !== 'function') return [];
    let list;
    try {
      list = getLedges();
    } catch {
      return [];
    }
    if (!Array.isArray(list)) return [];
    const surfaces = [];
    for (const l of list) {
      // Per entry, so a hostile one (a throwing getter, a revoked Proxy) costs
      // that entry rather than taking containNow() down with it.
      let left;
      let right;
      let top;
      let hwnd;
      try {
        if (!l) continue;
        ({ left, right, top, hwnd } = l);
      } catch {
        continue;
      }
      if (
        !Number.isFinite(left) || !Number.isFinite(right) ||
        !Number.isFinite(top) || !Number.isFinite(hwnd)
      ) continue;
      const sy = top - size.height;
      if (!(sy >= minY && sy < bottomY - FLOOR_EPS)) continue;
      const lo = Math.max(left, minX);
      const hi = Math.min(right - size.width, maxX);
      if (lo > hi) continue;
      surfaces.push({ y: sy, lo, hi });
    }
    return surfaces;
  }

  /** The floor as a surface: the whole width of the work area. */
  function floorOf(b) {
    return { y: b.bottomY, lo: b.minX, hi: b.maxX };
  }

  /**
   * Whether ledge `s` holds her up at window-x `px`. The slack is FLOOR_EPS for
   * the same reason as on the vertical axis: moveWindow rounds, and readPosition
   * adopts that rounded value, so a pet parked on a fractional ledge end reads
   * back up to half a pixel outside it. Without the slack, the 1s containNow poll
   * would walk her off the end of her own ledge.
   */
  function supports(s, px) {
    return px >= s.lo - FLOOR_EPS && px <= s.hi + FLOOR_EPS;
  }

  /**
   * The surface she is resting on, or null if she is standing on air.
   *
   * The floor keeps today's one-sided test (`y` at or *below* bottomY - EPS) on
   * purpose. A work area that shrinks under her leaves her below the new floor,
   * and that is containNow's to clamp, not gravity's to "fall" up from — a
   * symmetric test here would change the floor-only behaviour. The floor is
   * checked first for the same reason. Ledges get the symmetric test: a ledge
   * that moved more than EPS in either direction is no longer under her.
   */
  function surfaceUnder(b) {
    if (y >= b.bottomY - FLOOR_EPS) return floorOf(b);
    for (const s of b.ledges) {
      if (Math.abs(y - s.y) <= FLOOR_EPS && supports(s, x)) return s;
    }
    return null;
  }

  /**
   * Where a falling step that started at `fromY` would land: the highest surface
   * not above her feet at the start of the step (so she passes up through a ledge
   * from below and lands on it from above, and a ledge that rose past her feet is
   * not hers to snap onto) that holds her up at the step's final x. The floor is
   * the unconditional fallback, as it was before ledges existed: it catches her
   * even from below.
   */
  function landingSurface(b, fromY) {
    let best = floorOf(b);
    for (const s of b.ledges) {
      if (s.y >= fromY - FLOOR_EPS && s.y < best.y && supports(s, x)) best = s;
    }
    return best;
  }

  /**
   * Adopt the window's real position. Skipped while we are moving it ourselves —
   * mid-motion this module owns the position, and re-reading a rounded value
   * every tick would fight the float integration.
   */
  function readPosition() {
    if (strolling || falling || held) return;
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

  /** Edge-triggered like pushWalk: the renderer only needs the transitions. */
  function setAirborne(next) {
    const value = Boolean(next);
    if (value === airborne) return;
    airborne = value;
    onAirborne(value);
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

  // Deliberately leaves a fall in progress — and a pet being held — alone:
  // `cancel()` is the pin toggle and setMode's non-calm branch, and neither
  // pinning nor a `failed` mode is a reason to leave her hanging in mid-air or to
  // yank her out of the owner's hand. Only stop() (teardown) kills either.
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

  /**
   * `vx0`/`vy0` are the launch velocity: zero for an ordinary fall (dragged up,
   * or left high by a display change), the cursor's for a throw.
   */
  function startFall(vx0 = 0, vy0 = 0) {
    if (stopped || falling) return false;
    if (strolling) abortStroll(); // gravity outranks the stroll
    falling = true;
    vx = vx0;
    vy = vy0;
    lastFallAt = clock.now();
    cancelHandle(fallTimer);
    fallTimer = schedule(fallTick, D.tickMs);
    setAirborne(true);
    return true;
  }

  /**
   * Start falling if she is standing on no surface — dragged up, left high by a
   * display change, or the window she was perched on moved, shrank or closed.
   * Runs regardless of mode and pinned state, but never out of the owner's hand:
   * while held, this module's position is his to aim.
   */
  function maybeFall(b) {
    if (stopped || falling || held || !Number.isFinite(y)) return false;
    if (surfaceUnder(b)) return false;
    return startFall();
  }

  function fallTick() {
    fallTimer = null;
    if (stopped || !falling) return;
    if (held) {
      // Caught in mid-air. grab() already cleared the timer; this is the tick
      // that was already in flight when it did.
      falling = false;
      return;
    }

    const b = bounds();
    const now = clock.now();
    const dt = clamp(now - lastFallAt, 0, D.maxTickDtMs) / 1000; // same clamp as tick()
    lastFallAt = now;

    // Ground contact is decided from where the step *starts*: friction belongs to
    // a tick that began on a surface (the floor or a ledge), so a skid decays and
    // a flight does not. The start y also bounds which surfaces she can land on.
    const fromY = y;
    // A ledge counts as contact only when she is not moving up: a throw that
    // carries her up *through* a ledge passes its standing y in mid-air, and a
    // tick that happens to start within EPS of it must not skid her. The floor
    // keeps its old rule exactly (contact whatever vy is), so floor-only
    // behaviour is unchanged; the one asymmetry is that the tick leaving a
    // ledge on a bounce gets no friction where the floor's would.
    const under = surfaceUnder(b);
    const onSurface = under !== null && (under.y === b.bottomY || vy >= 0);

    vy = Math.min(vy + D.gravityPxPerSec2 * dt, D.maxFallPxPerSec);
    y += vy * dt;

    if (vx !== 0) {
      if (onSurface) {
        const drop = D.groundFrictionPxPerSec2 * dt;
        vx = Math.abs(vx) <= drop ? 0 : vx - Math.sign(vx) * drop;
      }
      x += vx * dt;
      if (x < b.minX) {
        x = b.minX;
        vx = -vx * D.wallRestitution;
      } else if (x > b.maxX) {
        x = b.maxX;
        vx = -vx * D.wallRestitution;
      }
      if (onSurface && Math.abs(vx) < D.minSlideVelocity) vx = 0;
    }
    x = clamp(x, b.minX, b.maxX); // the work area can change mid-flight

    // Chosen after x has moved, so a skid that carries her past a ledge's end
    // finds no ledge under her and she drops off it like walking off a table.
    const land = landingSurface(b, fromY);
    if (y < land.y) {
      moveWindow(Math.round(x), Math.round(y));
      fallTimer = schedule(fallTick, D.tickMs);
      return;
    }

    const rebound = vy * D.restitution;
    y = land.y; // exactly on the surface, whether she bounces or settles
    // And inside its standing range: `supports` allows EPS of slack, so a skid can
    // stop up to half a pixel past a ledge's end, the window rounds a further
    // half pixel out, and the 1s containNow poll then reads her back as standing
    // on air. At most a 0.5px nudge; on the floor x is already in range (no-op).
    x = clamp(x, land.lo, land.hi);
    moveWindow(Math.round(x), Math.round(y));

    if (rebound >= D.minBounceVelocity) {
      vy = -rebound;
      fallTimer = schedule(fallTick, D.tickMs);
      return;
    }

    vy = 0;
    if (vx !== 0) {
      // Landed, but not stopped: she is skidding. Friction ends this.
      fallTimer = schedule(fallTick, D.tickMs);
      return;
    }
    falling = false;
    setAirborne(false);
    afterLanding();
  }

  // --------------------------------------------------------------- pick her up

  /**
   * Picked up. Suspends this module exactly the way a non-calm mode does —
   * countdown cancelled, stroll abandoned, fall dropped — and takes the window's
   * real position as the starting point, because module A is about to aim it.
   */
  function grab() {
    if (stopped) return false;
    cancelHandle(armTimer);
    armTimer = null;
    abortStroll();
    cancelHandle(fallTimer);
    fallTimer = null;
    falling = false;
    vx = 0;
    vy = 0;

    const b = bounds();
    readPosition(); // still un-held, so this adopts wherever she really is
    if (!Number.isFinite(x)) x = b.maxX;
    if (!Number.isFinite(y)) y = b.bottomY;

    held = true;
    setAirborne(true);
    return true;
  }

  /**
   * Where the cursor says she should be. Clamped to the work area, so she cannot
   * be dragged off the screen she was lost off before — containment is not
   * something the owner should be able to switch off by holding her.
   */
  function moveTo(nx, ny) {
    if (stopped || !held) return false;
    const b = bounds();
    x = clamp(num(nx, x), b.minX, b.maxX);
    y = clamp(num(ny, y), b.minY, b.bottomY);
    moveWindow(Math.round(x), Math.round(y));
    return true;
  }

  /**
   * Let go, with the cursor's velocity. That velocity is the whole difference
   * between putting her down and throwing her, so it goes straight into the same
   * physics that gravity already uses rather than into a second animation path.
   */
  function release(velocity) {
    if (stopped || !held) return false;
    held = false;

    const cap = D.maxThrowPxPerSec;
    const vx0 = clamp(num(velocity && velocity.vx, 0), -cap, cap);
    const vy0 = clamp(num(velocity && velocity.vy, 0), -cap, cap);

    // Set down rather than thrown: already on a surface (the floor or a ledge),
    // not moving up, and no sideways speed worth simulating. Nothing to fly, so
    // hand her straight back to the ordinary scheduler.
    const b = bounds();
    const under = surfaceUnder(b);
    if (under && vy0 >= 0 && Math.abs(vx0) < D.minSlideVelocity) {
      y = under.y;
      // Same reason as the landing clamp in fallTick: set down within EPS past a
      // ledge's end, she would read back as standing on air on the next poll.
      // Ledges only: on the floor an out-of-range x (the work area changed while
      // she was held) is containNow's to fix, exactly as it was before ledges.
      const cx = under.y === b.bottomY ? x : clamp(x, under.lo, under.hi);
      if (cx !== x) {
        x = cx;
        moveWindow(Math.round(x), Math.round(y));
      }
      vx = 0;
      vy = 0;
      setAirborne(false);
      afterLanding();
      return true;
    }

    startFall(vx0, vy0);
    return true;
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
    // Held is exempt, and only held: `moveTo` clamps every dragged pixel to the
    // same bounds, so there is nothing here to fix and a second writer to cause.
    if (stopped || held) return false;
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
    // Pinned never strolls, and neither does a pet still in the air or in the
    // owner's hand; keep polling so unpinning (or landing, or being put down)
    // resumes without needing another state change.
    if (isPinned() || falling || held) {
      scheduleNextStroll();
      return;
    }
    startStroll();
  }

  function startStroll() {
    const b = bounds();
    syncPosition(b);
    if (maybeFall(b)) return; // dragged up since the last stroll: fall first

    // The target is picked on whatever she is standing on, so a stroll on a
    // ledge stays on it. On the floor this is the whole work area, as it always was.
    const s = surfaceUnder(b) || floorOf(b);
    target = clamp(Math.round(between(s.lo, s.hi)), s.lo, s.hi);

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
   * target on the way back instead of stopping dead against it. `s` is the
   * surface she is walking on, so on a ledge its ends are the walls: the window
   * under her shrank, and she turns at the new end rather than walk into the air.
   */
  function turnAround(s, wall, dirAfter) {
    x = wall;
    moveWindow(Math.round(x), Math.round(y));

    const span = dirAfter > 0 ? s.hi - x : x - s.lo;
    if (span < 1) {
      endStroll(); // no room to walk in either direction
      return;
    }
    target = clamp(Math.round(x + dirAfter * between(1, span)), s.lo, s.hi);
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
    // Re-derived every tick rather than remembered from the start of the stroll:
    // the window under her can shrink between two steps. maybeFall above already
    // proved she is on something, so the floor fallback is only a backstop.
    const s = surfaceUnder(b) || floorOf(b);

    // Arrival wins over the wall check, so a target sitting exactly on an edge
    // still ends the stroll rather than bouncing off it. A target now *outside*
    // the surface cannot be arrived at, and falls through to the wall check.
    if (Math.abs(target - x) <= step && target >= s.lo && target <= s.hi) {
      x = target;
      moveWindow(Math.round(x), Math.round(y));
      endStroll();
      return;
    }

    const next = x + dir * step;
    if (next < s.lo) {
      turnAround(s, s.lo, 1);
      return;
    }
    if (next > s.hi) {
      turnAround(s, s.hi, -1);
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
      held = false;
      setAirborne(false);
      vx = 0;
      vy = 0;
      mode = null;
    },

    // Containment, callable at any time from any state. See containNow above.
    containNow,

    // Picked up, dragged, thrown. Module A owns the cursor and calls these three;
    // the position itself is still written here and nowhere else.
    grab,
    moveTo,
    release,

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

    // Diagnostics/tests: in the owner's hand.
    isHeld() {
      return held;
    },
  };
}

export default createWander;
