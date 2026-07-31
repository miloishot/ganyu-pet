// Module E tests — success criterion 7:
//   "Wander scheduler unit tests with an injected clock: arms 20s after the
//    aggregate mode becomes calm (`idle` or `busy`), picks targets inside the
//    primary display work area, keeps walking across idle<->busy transitions,
//    and cancels immediately on `waiting`/`failed`."
//
// No real timers and no Electron: a virtual scheduler drives the module's real
// constants (20s arm, 45-120s gaps, 60px/s, 50ms ticks, 3-8s pauses).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWander, isCalm, CALM_MODES, WANDER_DEFAULTS } from '../src/main/wander.mjs';

const WIN_W = WANDER_DEFAULTS.windowWidth; // 256
const WIN_H = WANDER_DEFAULTS.windowHeight; // 320
const ARM = WANDER_DEFAULTS.armMs; // 20s
const FULL_HD = { x: 0, y: 0, width: 1920, height: 1040 }; // work area, taskbar removed

// The owner's real machine, measured against the Electron build: work area
// 1707x1019 at scaleFactor 1.5.
//
// Sizes seen on that window, all real readings: 259x323 straight out of the
// BrowserWindow constructor (it rounds the 256x320 request up), 260x324 after one
// bare setPosition, and 256x320 once module A pins the size with setBounds — which
// it does on every move, because a bare setPosition inflates the window a little
// per call and compounds (see window.mjs moveWindowPinned). 256x320 is therefore
// the production size; the others are asserted too, because module E must do
// whatever arithmetic it is handed.
const REAL_AREA = Object.freeze({ x: 0, y: 0, width: 1707, height: 1019 });
const REAL_SIZE = Object.freeze({ width: 260, height: 324 });
const AT_CREATE_SIZE = Object.freeze({ width: 259, height: 323 });
const PINNED_SIZE = Object.freeze({ width: 256, height: 320 });

function harness({ workArea = FULL_HD, randoms = [0.5], pinned = false, startX, startY, size } = {}) {
  let now = 0;
  let skew = 0; // clock-only offset, for simulating a late/suspended timer
  let nextId = 1;
  let drawIndex = 0;
  let pinnedFlag = pinned;
  let area = { ...workArea };
  let winSize = size ? { ...size } : null;
  let sizeThrows = false;
  // Stands in for the real window: seeded from startX/startY (undefined = "the
  // module does not know yet") and updated by every moveWindow, exactly as
  // win.getPosition() tracks win.setPosition().
  const pos = { x: startX, y: startY };
  const timers = new Map();
  const moves = [];
  const walkStates = [];
  const airborneStates = [];

  const dims = () => winSize ?? { width: WIN_W, height: WIN_H };

  const schedule = (fn, ms) => {
    const id = nextId++;
    timers.set(id, { at: now + ms, fn });
    return () => timers.delete(id);
  };

  function advance(ms) {
    const end = now + ms;
    let guard = 0;
    for (;;) {
      if (++guard > 500_000) throw new Error('advance: runaway timer loop');
      let pick = null;
      for (const [id, t] of timers) {
        if (t.at > end) continue;
        if (!pick || t.at < pick.timer.at || (t.at === pick.timer.at && id < pick.id)) {
          pick = { id, timer: t };
        }
      }
      if (!pick) break;
      timers.delete(pick.id);
      now = pick.timer.at;
      pick.timer.fn();
    }
    now = end;
    return end;
  }

  const wander = createWander({
    clock: { now: () => now + skew },
    schedule,
    moveWindow: (x, y) => {
      pos.x = x;
      pos.y = y;
      moves.push({ x, y, t: now });
    },
    getWorkArea: () => ({ ...area }),
    onWalkState: (walk) => walkStates.push(walk ? { dir: walk.dir, t: now } : null),
    onAirborne: (value) => airborneStates.push(value),
    isPinned: () => pinnedFlag,
    random: () => randoms[drawIndex++ % randoms.length],
    getPosition: () => ({ x: pos.x, y: pos.y }),
    ...(size
      ? {
        getWindowSize: () => {
          if (sizeThrows) throw new Error('window destroyed');
          return winSize && { ...winSize };
        },
      }
      : {}),
  });

  return {
    wander,
    advance,
    moves,
    walkStates,
    airborneStates,
    now: () => now,
    pin: (v) => {
      pinnedFlag = v;
    },
    /** Drag her, or drop her where a display change would have left her. */
    place: (x, y) => {
      pos.x = x;
      pos.y = y;
    },
    /** A resolution change, a monitor undocked, the taskbar growing. */
    setWorkArea: (next) => {
      area = { ...next };
    },
    /** What `getWindowSize` reports next. `'throw'` simulates a destroyed window. */
    setWindowSize: (next) => {
      sizeThrows = next === 'throw';
      if (!sizeThrows) winSize = next && { ...next };
    },
    /** Advance the clock without firing timers: the next tick arrives late. */
    bump: (ms) => {
      skew += ms;
    },
    pending: () => timers.size,
    dirs: () => walkStates.map((s) => (s ? s.dir : null)),
    get minX() {
      return area.x;
    },
    get maxX() {
      return area.x + area.width - dims().width;
    },
    get minY() {
      return area.y;
    },
    get bottomY() {
      return area.y + area.height - dims().height;
    },
  };
}

test('CALM_MODES and isCalm describe exactly the modes she strolls through', () => {
  assert.deepEqual([...CALM_MODES], ['idle', 'busy']);
  assert.ok(Object.isFrozen(CALM_MODES), 'frozen so callers cannot widen it at runtime');

  for (const m of ['idle', 'busy']) assert.equal(isCalm(m), true, `${m} is calm`);
  for (const m of ['waiting', 'failed', 'unknown', '', null, undefined]) {
    assert.equal(isCalm(m), false, `${String(m)} is not calm`);
  }

  // setMode accepts a module B state object, so isCalm has to as well.
  assert.equal(isCalm({ mode: 'busy', sessionCount: 2 }), true);
  assert.equal(isCalm({ mode: 'failed' }), false);
});

test('does not engage before the 20s arm, engages exactly at 20s', () => {
  // target fraction 0 (leftmost) / no pause / mid-range gap
  const h = harness({ randoms: [0, 0.9, 0.5] });

  h.wander.setMode('idle');
  h.advance(ARM - 1);
  assert.equal(h.moves.length, 0, 'no window moves before the 20s threshold');
  assert.equal(h.walkStates.length, 0, 'no walk state pushed before the 20s threshold');
  assert.equal(h.wander.isWandering(), false);

  h.advance(1); // t = 20_000 exactly
  assert.deepEqual(h.dirs(), ['left'], 'starts from the bottom-right corner, walks left');
  assert.equal(h.wander.isWandering(), true);
  assert.equal(h.moves.length, 0, 'first pixel moves on the first 50ms tick, not on arming');

  h.advance(WANDER_DEFAULTS.tickMs);
  assert.deepEqual(h.moves.at(-1), { x: h.maxX - 3, y: h.bottomY, t: ARM + 50 });
});

test('arms 20s after entering either calm mode', () => {
  for (const calm of CALM_MODES) {
    const h = harness({ randoms: [0, 0.9, 0.5] });

    h.wander.setMode(calm);
    h.advance(ARM - 1);
    assert.equal(h.walkStates.length, 0, `${calm}: not armed a tick early`);

    h.advance(1 + WANDER_DEFAULTS.tickMs);
    assert.deepEqual(h.dirs(), ['left'], `${calm}: strolling 20s after entering`);
    assert.equal(h.moves.length, 1, `${calm}: one tick of travel`);
  }
});

test('walks at ~60 px/s in 50ms ticks along the bottom edge', () => {
  const h = harness({ randoms: [0, 0.9, 0.5] });
  h.wander.setMode('idle');
  h.advance(ARM);
  h.advance(1_000); // exactly one second of walking

  assert.equal(h.moves.length, 20, '20 ticks per second');
  assert.equal(h.maxX - h.moves.at(-1).x, 60, '60 px covered in 1s');
  assert.ok(
    h.moves.every((m) => m.y === h.bottomY),
    'Y stays fixed at the bottom edge',
  );
});

test('never wanders while a non-calm mode is active', () => {
  for (const mode of ['waiting', 'failed', 'sulking']) {
    const h = harness();
    h.wander.setMode(mode);
    h.advance(30 * 60_000);
    assert.equal(h.moves.length, 0, `${mode}: no movement`);
    assert.equal(h.walkStates.length, 0, `${mode}: no walk state`);
    assert.equal(h.wander.isWandering(), false);
  }
});

test('a non-calm state restarts the countdown from scratch', () => {
  const h = harness({ randoms: [0, 0.9, 0.5] });

  h.wander.setMode('idle');
  h.advance(15_000); // 5s short of the arm
  h.wander.setMode('waiting');
  h.advance(10 * 60_000);
  assert.equal(h.moves.length, 0, 'waiting cancels the pending countdown');

  h.wander.setMode('idle');
  h.advance(ARM - 1);
  assert.equal(h.walkStates.length, 0, 'countdown starts over, not resumed from 15s');
  h.advance(1);
  assert.deepEqual(h.dirs(), ['left']);
});

test('repeated identical mode notifications do not restart the countdown', () => {
  const h = harness({ randoms: [0, 0.9, 0.5] });

  h.wander.setMode('idle');
  h.advance(10_000);
  h.wander.setMode('idle');
  h.wander.setMode({ mode: 'idle', celebrate: true, sessionCount: 1 }); // module B state object
  h.advance(10_000); // 20s aggregate calm in total

  assert.deepEqual(h.dirs(), ['left'], 'armed at 20s despite the extra idle pushes');
});

test('an idle<->busy hop does not restart the countdown', () => {
  // The hook stream flips between idle and busy constantly as sessions start and
  // stop; if either flip restarted the countdown she would never reach the arm.
  const h = harness({ randoms: [0, 0.9, 0.5] });

  h.wander.setMode('idle');
  h.advance(15_000);
  h.wander.setMode('busy'); // a session picked up work
  h.advance(4_000);
  h.wander.setMode('idle'); // and finished it
  h.advance(999);
  assert.equal(h.walkStates.length, 0, 'not armed before 20s');

  h.advance(1); // t = 20_000, measured from the first calm mode
  assert.deepEqual(h.dirs(), ['left'], 'the countdown survived both hops');
});

test('a stroll survives an idle->busy transition mid-walk', () => {
  const h = harness({ randoms: [0, 0.9, 0.5] });
  h.wander.setMode('idle');
  h.advance(ARM);
  h.advance(500); // 10 ticks
  assert.equal(h.moves.length, 10);

  h.wander.setMode('busy'); // an agent starts working while she is walking
  assert.deepEqual(h.dirs(), ['left'], 'walk state untouched — no onWalkState(null)');
  assert.equal(h.wander.isWandering(), true);
  assert.equal(h.wander.isArmed(), true);

  h.advance(500);
  assert.equal(h.moves.length, 20, 'still moving 10 ticks later');
  assert.equal(h.maxX - h.moves.at(-1).x, 60, 'one uninterrupted second of travel');

  // 1664 px at 3 px/tick arrives on tick 555; the next stroll is 82.5s out.
  h.advance(600 * WANDER_DEFAULTS.tickMs);
  assert.equal(h.moves.at(-1).x, h.minX, 'runs the stroll to its target while busy');
});

test('a stroll survives a busy->idle transition mid-walk', () => {
  const h = harness({ randoms: [0, 0.9, 0.5] });
  h.wander.setMode('busy');
  h.advance(ARM);
  h.advance(500);
  assert.equal(h.moves.length, 10, 'she strolls under busy in the first place');

  h.wander.setMode('idle'); // the last session ended mid-stroll
  assert.deepEqual(h.dirs(), ['left'], 'walk state untouched');
  assert.equal(h.wander.isWandering(), true);

  h.advance(500);
  assert.equal(h.moves.length, 20, 'keeps walking');
  assert.equal(h.maxX - h.moves.at(-1).x, 60);
});

test('waiting and failed abort a walk in progress instantly', () => {
  for (const mode of ['waiting', 'failed']) {
    const h = harness({ randoms: [0, 0.9, 0.5] });
    h.wander.setMode('idle');
    h.advance(ARM);
    h.advance(500); // 10 ticks

    assert.equal(h.moves.length, 10);
    const frozenAt = h.moves.at(-1);

    h.wander.setMode(mode);
    assert.deepEqual(h.dirs(), ['left', null], `${mode}: onWalkState(null) fires on cancel`);
    assert.equal(h.wander.isWandering(), false);
    assert.equal(h.wander.isArmed(), false);

    h.advance(10 * 60_000);
    assert.equal(h.moves.length, 10, `${mode}: no further movement after cancel`);
    assert.deepEqual(h.moves.at(-1), frozenAt, `${mode}: the window is left where it stopped`);
  }
});

test('every target sits inside the primary display work area', () => {
  const workArea = { x: 100, y: 50, width: 1000, height: 800 }; // non-zero origin
  const fractions = [0, 0.25, 0.5, 0.75, 0.999];
  // per stroll: target fraction / pause roll (0.9 = no pause) / gap roll (0 = 45s)
  const randoms = fractions.flatMap((f) => [f, 0.9, 0]);
  const h = harness({ workArea, randoms });

  h.wander.setMode('idle');
  h.advance(ARM);
  h.advance(800_000);

  assert.ok(h.moves.length > 0, 'strolled at least once');
  for (const m of h.moves) {
    assert.ok(m.x >= h.minX && m.x <= h.maxX, `x ${m.x} inside [${h.minX}, ${h.maxX}]`);
    assert.equal(m.y, h.bottomY);
  }

  // Split the move log into strolls on the multi-second gaps between them.
  const strolls = [];
  let current = [];
  let prevT = null;
  for (const m of h.moves) {
    if (prevT !== null && m.t - prevT > 1_000) {
      strolls.push(current);
      current = [];
    }
    current.push(m);
    prevT = m.t;
  }
  strolls.push(current);

  const arrivals = strolls.map((s) => s.at(-1).x).slice(0, fractions.length);
  const expected = fractions.map((f) => Math.round(h.minX + f * (h.maxX - h.minX)));
  assert.deepEqual(arrivals, expected, 'each stroll arrives at the random target');
});

test('pinned never arms in any calm mode, and unpinning resumes without a state change', () => {
  for (const calm of CALM_MODES) {
    const h = harness({ pinned: true }); // randoms all 0.5 -> no pause
    h.wander.setMode(calm);
    h.advance(30 * 60_000);
    assert.equal(h.moves.length, 0, `pinned + ${calm}: never strolls`);
    assert.equal(h.walkStates.length, 0, `pinned + ${calm}: no walk state pushed`);
    assert.equal(h.wander.isWandering(), false);

    h.pin(false);
    h.advance(WANDER_DEFAULTS.gapMaxMs + WANDER_DEFAULTS.tickMs);
    assert.ok(h.moves.length > 0, `${calm}: unpinned, the poll picks it back up`);
    assert.ok(
      h.moves.every((m) => m.x >= h.minX && m.x <= h.maxX && m.y === h.bottomY),
      'still inside the work area',
    );
  }
});

test('takes an occasional mid-walk pause of 3-8s, then continues in the same direction', () => {
  // target 0 (leftmost) / pause roll 0.1 (< 0.35 -> pause) / pause at 50% of the
  // journey / pause duration roll 0 (-> the 3s floor)
  const h = harness({ randoms: [0, 0.1, 0.5, 0] });
  h.wander.setMode('idle');
  h.advance(ARM);

  // Halfway point of 1664 -> 0 is x = 832; at 3px per tick that is tick 278.
  h.advance(278 * WANDER_DEFAULTS.tickMs);
  assert.equal(h.moves.length, 278);
  assert.equal(h.moves.at(-1).x, 830);
  assert.deepEqual(h.dirs(), ['left', null], 'stands still for the breather');
  assert.equal(h.wander.isWandering(), true, 'a breather is still part of the stroll');

  const pauseStart = h.now();
  h.advance(WANDER_DEFAULTS.pauseMinMs - 1);
  assert.equal(h.moves.length, 278, 'frozen for the whole pause');

  h.advance(1 + WANDER_DEFAULTS.tickMs);
  assert.equal(h.moves.length, 279, 'walking again');
  assert.deepEqual(h.dirs(), ['left', null, 'left'], 'resumes facing the same way');

  const resumedAt = h.walkStates.at(-1).t;
  const paused = resumedAt - pauseStart;
  assert.ok(
    paused >= WANDER_DEFAULTS.pauseMinMs && paused <= WANDER_DEFAULTS.pauseMaxMs,
    `pause ${paused}ms within 3-8s`,
  );
});

test('gap between strolls stays within 45-120 seconds', () => {
  const { gapMinMs, gapMaxMs, tickMs } = WANDER_DEFAULTS;

  for (const gapRoll of [0, 0.5, 0.99999]) {
    // stroll 1: target fraction 0.5 / no pause / gap roll
    // stroll 2: target fraction 0   / no pause / gap roll
    const h = harness({ randoms: [0.5, 0.9, gapRoll, 0, 0.9, gapRoll] });
    h.wander.setMode('idle');
    h.advance(ARM);
    h.advance(278 * tickMs); // 1664 -> 832 arrives on tick 278

    const arrived = h.moves.length;
    const arrivalT = h.now();
    assert.equal(h.moves.at(-1).x, 832, 'reached the target');
    assert.equal(h.wander.isWandering(), false, 'stroll over, waiting for the next');
    assert.equal(h.wander.isArmed(), true, 'gap timer pending');

    h.advance(gapMinMs - 1);
    assert.equal(h.moves.length, arrived, 'no stroll sooner than 45s');

    h.advance(gapMaxMs - gapMinMs + 1 + tickMs);
    assert.ok(h.moves.length > arrived, `stroll resumed by 2 min (gap roll ${gapRoll})`);

    const gap = h.moves[arrived].t - tickMs - arrivalT;
    assert.ok(gap >= gapMinMs && gap <= gapMaxMs, `gap ${gap}ms within 45-120s`);
    assert.ok(
      Math.abs(gap - (gapMinMs + gapRoll * (gapMaxMs - gapMinMs))) < 1,
      'gap is deterministic from the injected random',
    );
  }
});

test('faces right when the target is to the right', () => {
  const h = harness({ startX: 0, randoms: [0.99, 0.9, 0.5] });
  h.wander.setMode('idle');
  h.advance(ARM);
  h.advance(500);

  assert.deepEqual(h.dirs(), ['right']);
  assert.equal(h.moves.at(-1).x, 30, '10 ticks x 3px to the right of x=0');
});

test('stop() cancels every timer and clears the walk state', () => {
  const h = harness({ randoms: [0, 0.9, 0.5] });
  h.wander.setMode('idle');
  h.advance(ARM);
  h.advance(500);
  assert.equal(h.moves.length, 10);

  h.wander.stop();
  assert.deepEqual(h.dirs(), ['left', null]);
  assert.equal(h.pending(), 0, 'no timers left pending');

  h.wander.setMode('idle'); // ignored after stop
  h.advance(10 * 60_000);
  assert.equal(h.moves.length, 10);
});

test('cancel() stops the current stroll and re-arms the 20s countdown', () => {
  const h = harness({ randoms: [0, 0.9, 0.5] });
  h.wander.setMode('idle');
  h.advance(ARM);
  h.advance(500); // 10 ticks
  assert.equal(h.moves.length, 10);

  h.wander.cancel();
  assert.deepEqual(h.dirs(), ['left', null], 'walk state cleared');
  assert.equal(h.wander.isWandering(), false);

  const frozen = h.moves.at(-1);
  h.advance(ARM - 1);
  assert.equal(h.moves.length, 10, 'no movement during the fresh countdown');
  assert.deepEqual(h.moves.at(-1), frozen, 'window left where it stopped');

  h.advance(1 + WANDER_DEFAULTS.tickMs);
  assert.equal(h.moves.length, 11, 're-armed: strolls again 20s after cancel');
});

test('cancel() re-arms under busy too, because busy is calm', () => {
  const h = harness({ randoms: [0, 0.9, 0.5] });
  h.wander.setMode('busy');
  h.advance(ARM);
  h.advance(500);
  assert.equal(h.moves.length, 10);

  h.wander.cancel();
  assert.equal(h.wander.isWandering(), false);
  assert.equal(h.wander.isArmed(), true, 'countdown re-armed while still busy');

  h.advance(ARM - 1);
  assert.equal(h.moves.length, 10, 'no movement during the fresh countdown');
  h.advance(1 + WANDER_DEFAULTS.tickMs);
  assert.equal(h.moves.length, 11, 'strolls again 20s after cancel');
});

test('cancel() while a non-calm mode is active does not re-arm', () => {
  for (const mode of ['waiting', 'failed']) {
    const h = harness({ randoms: [0, 0.9, 0.5] });
    h.wander.setMode(mode);
    h.wander.cancel();
    h.advance(30 * 60_000);
    assert.equal(h.moves.length, 0, `${mode}: still frozen`);
    assert.equal(h.wander.isArmed(), false, `${mode}: nothing pending`);
  }
});

// Reproduces module A's toggle-pin handler: it calls the wander cancel handle
// and flips the pinned flag. Wandering must survive an unpin.
test('module A pin-toggle sequence: cancel() + pin, then unpin resumes', () => {
  const h = harness({ randoms: [0, 0.9, 0.5] });
  h.wander.setMode('idle');
  h.advance(ARM);
  h.advance(500);
  assert.equal(h.moves.length, 10);

  h.pin(true);
  h.wander.cancel();
  h.advance(30 * 60_000);
  assert.equal(h.moves.length, 10, 'pinned: frozen, no strolls');

  h.pin(false);
  h.advance(WANDER_DEFAULTS.gapMaxMs + WANDER_DEFAULTS.tickMs);
  assert.ok(h.moves.length > 10, 'unpinned without any state change: strolls again');
});

test('stop() stays irreversible even after cancel()', () => {
  const h = harness({ randoms: [0, 0.9, 0.5] });
  h.wander.setMode('idle');
  h.wander.stop();
  h.wander.cancel();
  assert.equal(h.pending(), 0, 'cancel() must not resurrect a stopped scheduler');
  h.advance(60 * 60_000);
  assert.equal(h.moves.length, 0);
});

test('createWander rejects missing side-effect injections', () => {
  assert.throws(() => createWander(), TypeError);
  assert.throws(() => createWander({ clock: { now: () => 0 }, schedule: () => {} }), TypeError);
});

// --------------------------------------------------------------- containment
//
// The owner lost the pet off the edge of the screen. Two causes, both fixed here:
// the window is 4px bigger than the constant this module used to clamp against,
// and nothing re-clamped her between strolls — so a work-area change while the
// aggregate mode sat at `waiting`/`failed` (no strolls at all) stranded her for good.

test('bounds() clamps to the measured window size, not the 256x320 constant', () => {
  const h = harness({ workArea: REAL_AREA, size: REAL_SIZE });
  assert.equal(h.maxX, 1447, 'work area 1707 minus the measured 260');
  assert.equal(h.bottomY, 695, 'work area 1019 minus the measured 324');

  // The module agrees, not just the harness arithmetic: dropped past the far
  // corner she lands on exactly those numbers.
  h.place(9_999, 9_999);
  assert.equal(h.wander.containNow(), true);
  assert.deepEqual(h.moves.at(-1), { x: 1447, y: 695, t: 0 });

  // Straight out of the constructor, before module A pins the size.
  const atCreate = harness({ workArea: REAL_AREA, size: AT_CREATE_SIZE });
  assert.equal(atCreate.maxX, 1448);
  assert.equal(atCreate.bottomY, 696);

  // And the production case: module A pins 256x320 on every move, so that is the
  // size it reports and these are the real numbers.
  const pinned = harness({ workArea: REAL_AREA, size: PINNED_SIZE });
  assert.equal(pinned.maxX, 1451, 'production maxX');
  assert.equal(pinned.bottomY, 699, 'production floor');
  pinned.place(9_999, 9_999);
  pinned.wander.containNow();
  assert.deepEqual(pinned.moves.at(-1), { x: 1451, y: 699, t: 0 });
  assert.ok(1451 + PINNED_SIZE.width <= REAL_AREA.width, 'flush against the right edge, not past it');
  assert.ok(699 + PINNED_SIZE.height <= REAL_AREA.height, 'flush against the bottom edge, not past it');

  // With no injection at all the defaults give the same answer, because they are
  // the canonical size the window is pinned to.
  const assumed = harness({ workArea: REAL_AREA });
  assert.equal(assumed.maxX, 1451);
  assert.equal(assumed.bottomY, 699);
});

test('an implausible measured size is rejected in favour of the canonical defaults', () => {
  // Mid-drift getBounds() reports sizes in the thousands. Believing one would put
  // the floor and maxX far off-screen and lose her completely — the exact failure
  // this whole change exists to fix.
  const garbage = [
    ['drifted', { width: 1_762, height: 2_838 }],
    ['wildly drifted', { width: 9_000, height: 9_000 }],
    ['zero', { width: 0, height: 0 }],
    ['negative', { width: -256, height: -320 }],
    ['NaN', { width: NaN, height: NaN }],
    ['one dimension only', { width: 256, height: 4_000 }],
    ['not an object', null],
  ];
  // Asserted through containment rather than the harness getters: where she
  // actually lands *is* maxX and the floor as the module computed them.
  for (const [label, size] of [...garbage, ['throwing (destroyed window)', 'throw']]) {
    const h = harness({ workArea: REAL_AREA, size: PINNED_SIZE });
    h.setWindowSize(size);
    h.place(9_999, 9_999);
    h.wander.containNow();
    assert.deepEqual(h.moves.at(-1), { x: 1451, y: 699, t: 0 }, `${label}: falls back to the canonical size`);
  }

  // A size at exactly the tolerance is still trusted — that is the point of
  // measuring in the first place.
  const drift = WANDER_DEFAULTS.maxSizeDriftPx; // 32
  const edge = harness({ workArea: REAL_AREA, size: { width: 256 + drift, height: 320 + drift } });
  edge.place(9_999, 9_999);
  edge.wander.containNow();
  assert.deepEqual(edge.moves.at(-1), { x: 1451 - drift, y: 699 - drift, t: 0 }, 'honoured at exactly the tolerance');

  // One px past it and the whole reading is discarded — both dimensions, not just
  // the offending one, because a half-trusted measurement is not a measurement.
  const over = harness({ workArea: REAL_AREA, size: { width: 256 + drift + 1, height: 320 + drift } });
  over.place(9_999, 9_999);
  over.wander.containNow();
  assert.deepEqual(over.moves.at(-1), { x: 1451, y: 699, t: 0 }, 'rejected one px past it');
});

test('containNow pulls her back inside from every edge', () => {
  const cases = [
    ['off the right', { x: 2_400, y: 695 }, { x: 1447, y: 695 }],
    ['off the bottom', { x: 800, y: 1_400 }, { x: 800, y: 695 }],
    ['off the left', { x: -600, y: 695 }, { x: 0, y: 695 }],
    ['off the top', { x: 800, y: -400 }, { x: 800, y: 0 }],
    ['off both at once', { x: 5_000, y: 5_000 }, { x: 1447, y: 695 }],
  ];
  for (const [label, from, want] of cases) {
    const h = harness({ workArea: REAL_AREA, size: REAL_SIZE });
    h.place(from.x, from.y);
    assert.equal(h.wander.containNow(), true, `${label}: reports the move`);
    const at = h.moves.at(-1);
    assert.deepEqual({ x: at.x, y: at.y }, want, `${label}: fully inside`);
  }
});

test('containNow makes no moveWindow call at all when she is already inside', () => {
  const h = harness({ workArea: REAL_AREA, size: REAL_SIZE });
  for (const [x, y] of [[0, 695], [800, 695], [1447, 695]]) {
    h.place(x, y);
    assert.equal(h.wander.containNow(), false, `${x},${y} is already inside`);
  }
  assert.equal(h.moves.length, 0, 'not one moveWindow call — cheap enough for the 1s poll');
  assert.equal(h.wander.isFalling(), false, 'and no fall started from the floor');
});

test('containNow ignores the pinned flag and the aggregate mode', () => {
  // A pinned pet stranded off-screen is exactly the trap the owner hit: pinning
  // stops her strolling, and stopping her strolling used to stop containment too.
  for (const mode of ['failed', 'waiting', 'idle', 'busy']) {
    const h = harness({ workArea: REAL_AREA, size: REAL_SIZE, pinned: true });
    h.wander.setMode(mode);
    h.place(3_000, 695);
    assert.equal(h.wander.containNow(), true, `${mode} + pinned: still contained`);
    assert.deepEqual(h.moves.at(-1), { x: 1447, y: 695, t: 0 });
    assert.equal(h.wander.isWandering(), false, `${mode}: containment is not a stroll`);
  }
});

test('containNow rescues a pet stranded by a work-area change under a stuck non-calm mode', () => {
  const h = harness({ workArea: REAL_AREA, size: REAL_SIZE });
  h.wander.setMode('failed'); // wander is cancelled: no stroll will ever re-clamp her
  h.place(1447, 695); // flush in the bottom-right corner of the old work area

  h.setWorkArea({ x: 0, y: 0, width: 1024, height: 768 }); // a monitor is undocked
  h.advance(60 * 60_000);
  assert.equal(h.moves.length, 0, 'an hour later the scheduler still has not noticed — the bug');

  assert.equal(h.wander.containNow(), true, 'the 1s poll is what recovers her');
  assert.deepEqual(h.moves.at(-1), { x: 764, y: 444, t: h.now() }, '1024-260, 768-324');
});

// ------------------------------------------------------------------- gravity

test('above the floor she falls, bounces with decreasing height, and settles exactly on it', () => {
  const h = harness({ workArea: REAL_AREA, size: REAL_SIZE });
  const FLOOR = h.bottomY; // 695
  h.place(800, 100); // dragged well up the screen

  assert.equal(h.wander.containNow(), false, 'inside the work area, so nothing to clamp');
  assert.equal(h.wander.isFalling(), true, 'but above the floor, so gravity takes over');

  h.advance(20_000);
  assert.equal(h.wander.isFalling(), false, 'settled');

  const ys = h.moves.map((m) => m.y);
  assert.ok(h.moves.every((m) => m.x === 800), 'gravity is vertical only');

  const deltas = ys.slice(1).map((v, i) => v - ys[i]);
  for (let i = 1; i < 6; i++) {
    assert.ok(deltas[i] > deltas[i - 1], `accelerating: tick ${i} moved ${deltas[i]} > ${deltas[i - 1]}`);
  }

  // Bounce arcs: from each landing to the next, how far she got back up.
  const landings = ys.reduce((acc, v, i) => (v === FLOOR && ys[i - 1] !== FLOOR ? [...acc, i] : acc), []);
  const apexes = landings.slice(0, -1).map((from, k) => FLOOR - Math.min(...ys.slice(from, landings[k + 1] + 1)));
  assert.ok(apexes.length >= 1, 'she bounces at least once');
  assert.ok(apexes.length <= 3, `at most a few bounces, got ${apexes.length}`);
  for (let i = 1; i < apexes.length; i++) {
    assert.ok(apexes[i] < apexes[i - 1], `bounce ${i} (${apexes[i]}px) lower than bounce ${i - 1} (${apexes[i - 1]}px)`);
  }
  assert.ok(apexes[0] > 0 && apexes[0] < 100, `first rebound ${apexes[0]}px is a bounce, not a second drop`);

  assert.equal(ys.at(-1), FLOOR, 'settles exactly on the floor');
  const settled = h.moves.length;
  h.advance(10 * 60_000);
  assert.equal(h.moves.length, settled, 'and stays there');
});

test('the fall respects terminal velocity', () => {
  const h = harness({ workArea: { x: 0, y: 0, width: 1707, height: 6_000 }, size: REAL_SIZE });
  h.place(800, 0);
  h.wander.containNow();
  h.advance(60_000);

  const ys = h.moves.map((m) => m.y);
  const deltas = ys.slice(1).map((v, i) => v - ys[i]);
  const cap = (WANDER_DEFAULTS.maxFallPxPerSec * WANDER_DEFAULTS.tickMs) / 1000; // 45px
  assert.equal(Math.max(...deltas), cap, `a 50ms step never exceeds ${cap}px`);
  assert.equal(ys.at(-1), h.bottomY, 'still lands exactly on the floor');
});

test('a late tick during a fall cannot teleport her down the screen', () => {
  const h = harness({ workArea: { x: 0, y: 0, width: 1707, height: 20_000 }, size: REAL_SIZE });
  h.place(800, 0);
  h.wander.containNow();
  h.advance(150); // three ordinary ticks of falling

  const before = h.moves.at(-1).y;
  h.bump(10_000); // the machine slept: the next timer fires 10s late
  h.advance(WANDER_DEFAULTS.tickMs);

  const jump = h.moves.at(-1).y - before;
  const worst = (WANDER_DEFAULTS.maxFallPxPerSec * WANDER_DEFAULTS.maxTickDtMs) / 1000; // 225px
  assert.ok(jump > 0, 'she is still falling');
  assert.ok(jump <= worst, `one late tick moved her ${jump}px, capped at ${worst}px`);
  assert.ok(jump < 1_000, 'unclamped, 10s at terminal velocity would have been 9000px');
});

test('gravity outranks a stroll in progress, the pinned flag and a non-calm mode', () => {
  // Mid-stroll, a display change drops the floor away beneath her.
  const h = harness({ randoms: [0, 0.9, 0.5] });
  h.wander.setMode('idle');
  h.advance(ARM);
  h.advance(500);
  assert.equal(h.moves.length, 10, 'strolling left along the old floor');
  assert.equal(h.moves.at(-1).y, 720);

  h.setWorkArea({ x: 0, y: 0, width: 1920, height: 1_240 });
  h.advance(WANDER_DEFAULTS.tickMs);
  assert.equal(h.wander.isFalling(), true, 'the next tick hands her to gravity');
  assert.equal(h.wander.isWandering(), false, 'the stroll is dropped, not resumed after');
  assert.equal(h.dirs().at(-1), null, 'and onWalkState(null) reported it');

  h.advance(20_000);
  assert.equal(h.moves.at(-1).y, 920, 'landed on the new floor (1240 - 320)');

  // Pinned, and with the mode stuck non-calm: still falls. Gravity is
  // containment, not behaviour.
  for (const mode of ['failed', 'waiting']) {
    const p = harness({ workArea: REAL_AREA, size: REAL_SIZE, pinned: true });
    p.wander.setMode(mode);
    p.place(800, 100);
    p.wander.containNow();
    assert.equal(p.wander.isFalling(), true, `${mode} + pinned: gravity still applies`);
    p.advance(20_000);
    assert.equal(p.moves.at(-1).y, 695, `${mode} + pinned: lands on the floor`);
    assert.equal(p.wander.isWandering(), false, `${mode} + pinned: and never strolls`);
  }
});

test('a fall settles her on the floor after containment drops her in from off the top', () => {
  const h = harness({ workArea: REAL_AREA, size: REAL_SIZE });
  h.place(800, -400);
  assert.equal(h.wander.containNow(), true);
  assert.deepEqual(h.moves.at(-1), { x: 800, y: 0, t: 0 }, 'clamped to the top of the work area');

  h.advance(20_000);
  assert.equal(h.moves.at(-1).y, 695, 'then falls the rest of the way to the floor');
  assert.equal(h.wander.isFalling(), false);
});

// --------------------------------------------------------------- edge bounce

test('a stroll aimed past the wall turns around instead of stopping dead against it', () => {
  const h = harness({ startX: 0, startY: FULL_HD.height - WIN_H, randoms: [0.99, 0.9, 0.5] });
  h.wander.setMode('idle');
  h.advance(ARM);
  h.advance(100 * WANDER_DEFAULTS.tickMs); // 300px right; the target was 1647
  assert.deepEqual(h.dirs(), ['right']);
  assert.equal(h.moves.at(-1).x, 300);

  // A monitor is undocked mid-stroll: her target is now 1000px past the wall.
  h.setWorkArea({ x: 0, y: 0, width: 900, height: FULL_HD.height });
  const wall = h.maxX; // 900 - 256
  assert.equal(wall, 644);
  h.advance(400 * WANDER_DEFAULTS.tickMs);

  assert.ok(h.moves.every((m) => m.x <= wall), 'never crosses the wall');
  assert.deepEqual(h.dirs().slice(0, 2), ['right', 'left'], 'onWalkState reports the flip');

  const turnedAt = h.moves.findIndex((m) => m.x === wall);
  assert.ok(turnedAt > 0, 'she reached the wall');
  assert.equal(h.moves.filter((m) => m.x === wall).length, 1, 'one touch, not parked against it');
  assert.ok(h.moves.length > turnedAt + 50, 'and kept walking for a long way afterwards');
  assert.ok(h.moves.at(-1).x < wall, 'heading back into the work area, at a fresh target');
  assert.ok(h.moves.at(-1).x > h.minX, 'a fresh target, not just a run to the far wall');
});

// ------------------------------------------------- picked up, carried, thrown
//
// The drag lives here rather than in module A for one reason: two things writing
// the window position 20 times a second fight, and the loser is whichever wrote
// first. Module A reads the cursor and aims; every pixel still leaves through
// this module's `moveWindow`.

test('being picked up suspends the stroll and the countdown, and putting her down resumes both', () => {
  const h = harness({ randoms: [0, 0.9, 0.5] });
  h.wander.setMode('idle');
  h.advance(ARM);
  h.advance(200); // four ticks of strolling
  assert.equal(h.wander.isWandering(), true);

  assert.equal(h.wander.grab(), true);
  assert.equal(h.wander.isHeld(), true);
  assert.equal(h.wander.isWandering(), false, 'the stroll is abandoned, not paused');
  assert.equal(h.dirs().at(-1), null, 'and onWalkState reported the stop');
  assert.equal(h.wander.isArmed(), false, 'no countdown ticking behind the drag either');

  const carried = h.moves.length;
  h.advance(10 * 60_000);
  assert.equal(h.moves.length, carried, 'ten minutes in his hand and she never strolls out of it');

  h.wander.release({ vx: 0, vy: 0 });
  assert.equal(h.wander.isHeld(), false);
  assert.equal(h.wander.isArmed(), true, 'the gap timer is running again');

  h.advance(WANDER_DEFAULTS.gapMaxMs + ARM);
  assert.ok(h.moves.length > carried, 'and she strolls again, without needing a state change');
});

test('a dragged pixel goes out through moveWindow, clamped to the work area', () => {
  const h = harness({ workArea: REAL_AREA, size: REAL_SIZE });
  h.wander.grab();

  assert.equal(h.wander.moveTo(400, 200), true);
  assert.deepEqual(h.moves.at(-1), { x: 400, y: 200, t: 0 });

  // She cannot be dragged off the screen she was lost off in the first place:
  // containment is not something holding her should switch off.
  h.wander.moveTo(-500, -500);
  assert.deepEqual({ x: h.moves.at(-1).x, y: h.moves.at(-1).y }, { x: h.minX, y: h.minY });
  h.wander.moveTo(99_999, 99_999);
  assert.deepEqual({ x: h.moves.at(-1).x, y: h.moves.at(-1).y }, { x: h.maxX, y: h.bottomY });

  // A garbage coordinate keeps the axis it cannot replace, rather than moving the
  // window to NaN.
  h.wander.moveTo(undefined, h.bottomY);
  assert.deepEqual({ x: h.moves.at(-1).x, y: h.moves.at(-1).y }, { x: h.maxX, y: h.bottomY });

  h.wander.release({ vx: 0, vy: 0 });
  const settled = h.moves.length;
  assert.equal(h.wander.moveTo(100, 100), false, 'moveTo is inert once she is put down');
  assert.equal(h.moves.length, settled);
});

test('released with sideways speed she flies, bounces off the wall, and settles on the floor', () => {
  const h = harness({ workArea: REAL_AREA, size: REAL_SIZE });
  h.wander.setMode('idle');
  h.wander.grab();
  h.wander.moveTo(300, 200); // held well above the floor, over on the left
  const thrownAt = h.moves.length;

  h.wander.release({ vx: 900, vy: -200 }); // flicked hard to the right, slightly up
  assert.equal(h.wander.isFalling(), true, 'a throw is the same physics as a fall');

  h.advance(30_000);
  assert.equal(h.wander.isFalling(), false, 'she settles');

  const flight = h.moves.slice(thrownAt);
  const xs = flight.map((m) => m.x);
  const ys = flight.map((m) => m.y);

  assert.ok(ys.some((y) => y < 200), 'the upward part of the flick actually lifted her');
  assert.equal(Math.max(...xs), h.maxX, 'she reached the right-hand wall');
  assert.equal(ys.at(-1), h.bottomY, 'and ends up on the floor');
  assert.ok(xs.at(-1) < h.maxX, 'having bounced back off the wall rather than sticking to it');
  assert.ok(xs.at(-1) > 300, 'well to the right of where she was thrown from');

  const wallAt = xs.indexOf(h.maxX);
  const after = xs.slice(wallAt + 1);
  assert.ok(after.length > 0, 'the wall was not the last thing that happened');
  assert.ok(
    after.every((x, i) => i === 0 || x <= after[i - 1]),
    'every step after the wall goes back the other way',
  );

  const settled = h.moves.length;
  h.advance(WANDER_DEFAULTS.gapMinMs - 1);
  assert.equal(h.moves.length, settled, 'and stays where she landed');
});

test('a flick along the floor skids to a stop rather than being ignored', () => {
  // No air time to spend the speed in, so without ground friction this throw
  // would land on the settle branch and do nothing at all — which reads as the
  // flick having been dropped rather than as physics.
  const h = harness({ workArea: REAL_AREA, size: REAL_SIZE });
  h.wander.setMode('idle');
  h.wander.grab();
  h.wander.moveTo(400, h.bottomY);
  h.wander.release({ vx: -600, vy: 0 });
  assert.equal(h.wander.isFalling(), true);

  h.advance(20_000);
  const end = h.moves.at(-1);
  assert.equal(end.y, h.bottomY, 'she never left the floor');
  assert.ok(end.x < 350, `she travelled left, ending at ${end.x}`);
  assert.ok(end.x > h.minX, 'and friction stopped her short of the wall');
  assert.equal(h.wander.isFalling(), false);
});

test('putting her down is not a throw', () => {
  const h = harness({ workArea: REAL_AREA, size: REAL_SIZE });
  h.wander.setMode('idle');
  h.wander.grab();
  h.wander.moveTo(600, h.bottomY);
  const down = h.moves.length;

  // On the floor, not moving up, and under the slide threshold: nothing to fly.
  assert.equal(h.wander.release({ vx: WANDER_DEFAULTS.minSlideVelocity - 1, vy: 0 }), true);
  assert.equal(h.wander.isFalling(), false);
  h.advance(1_000);
  assert.equal(h.moves.length, down, 'not one physics tick spent on standing still');
  assert.equal(h.wander.isArmed(), true, 'straight back to the ordinary scheduler');
});

test('she can be caught in mid-air, and nothing keeps falling behind the drag', () => {
  const h = harness({ workArea: REAL_AREA, size: REAL_SIZE });
  h.place(800, 100);
  h.wander.containNow();
  assert.equal(h.wander.isFalling(), true);
  h.advance(100);

  h.wander.grab();
  assert.equal(h.wander.isFalling(), false, 'caught');
  assert.equal(h.wander.isHeld(), true);

  const caught = h.moves.length;
  h.advance(10_000);
  assert.equal(h.moves.length, caught, 'gravity does not tick while she is held');

  h.wander.release({ vx: 0, vy: 0 });
  h.advance(20_000);
  assert.equal(h.moves.at(-1).y, h.bottomY, 'and the rest of the fall happens on release');
});

test('containment stands down while she is held — one writer, not two', () => {
  // containNow() runs from module A's 1s poll, so it fires several times during
  // any real drag. It must not clamp, must not report a move, and above all must
  // not hand her to gravity out of his hand.
  const h = harness({ workArea: REAL_AREA, size: REAL_SIZE });
  h.wander.grab();
  h.wander.moveTo(400, 100);
  const carried = h.moves.length;

  assert.equal(h.wander.containNow(), false, 'the poll finds nothing to do');
  assert.equal(h.moves.length, carried, 'and moves her not at all');
  assert.equal(h.wander.isFalling(), false, 'nor drops her');
});

test('onAirborne fires on the edges of being off the ground, and only on the edges', () => {
  const h = harness({ workArea: REAL_AREA, size: REAL_SIZE });
  h.wander.grab();
  assert.deepEqual(h.airborneStates, [true], 'picked up');

  h.wander.moveTo(400, 100);
  h.wander.moveTo(420, 120);
  assert.deepEqual(h.airborneStates, [true], 'carrying her is not an edge');

  h.wander.release({ vx: 0, vy: 0 });
  assert.deepEqual(h.airborneStates, [true], 'still off the ground, now falling');

  h.advance(20_000);
  assert.deepEqual(h.airborneStates, [true, false], 'and down again on landing');

  // An ordinary fall is the same signal: the renderer draws one row for both.
  h.place(400, 100);
  h.wander.containNow();
  assert.deepEqual(h.airborneStates, [true, false, true]);
  h.advance(20_000);
  assert.deepEqual(h.airborneStates, [true, false, true, false]);
});

test('an absurd release velocity is capped rather than believed', () => {
  const h = harness({ workArea: REAL_AREA, size: REAL_SIZE });
  h.wander.grab();
  h.wander.moveTo(700, 300);
  h.wander.release({ vx: 999_999, vy: 0 });

  h.advance(WANDER_DEFAULTS.tickMs);
  const step = h.moves.at(-1).x - 700;
  const cap = (WANDER_DEFAULTS.maxThrowPxPerSec * WANDER_DEFAULTS.tickMs) / 1000;
  assert.ok(step > 0 && step <= cap, `one tick moved her ${step}px, capped at ${cap}px`);

  // Garbage is zero, not NaN: a NaN coordinate moves the window nowhere at all.
  const g = harness({ workArea: REAL_AREA, size: REAL_SIZE });
  g.wander.grab();
  g.wander.moveTo(700, 300);
  g.wander.release({ vx: NaN, vy: 'fast' });
  g.advance(20_000);
  assert.deepEqual(
    { x: g.moves.at(-1).x, y: g.moves.at(-1).y },
    { x: 700, y: g.bottomY },
    'straight down, and nothing sideways',
  );
});

test('pinning and a stuck non-calm mode do not stop him picking her up', () => {
  for (const mode of ['failed', 'waiting']) {
    const h = harness({ workArea: REAL_AREA, size: REAL_SIZE, pinned: true });
    h.wander.setMode(mode);

    h.wander.grab();
    h.wander.moveTo(500, 300);
    assert.deepEqual(h.moves.at(-1), { x: 500, y: 300, t: 0 }, `${mode} + pinned: carried anyway`);

    // setMode's non-calm branch cancels the stroll; it must not empty his hand.
    h.wander.setMode(mode === 'failed' ? 'waiting' : 'failed');
    assert.equal(h.wander.isHeld(), true, 'a mode change does not take her out of his hand');

    h.wander.release({ vx: 0, vy: 0 });
    h.advance(20_000);
    assert.equal(h.moves.at(-1).y, h.bottomY, `${mode} + pinned: gravity still lands her`);
    assert.equal(h.wander.isWandering(), false, 'and she still never strolls');
  }
});

test('stop() is the one thing that ends a drag, and ends it by putting her down', () => {
  const h = harness({ workArea: REAL_AREA, size: REAL_SIZE });
  h.wander.grab();
  h.wander.moveTo(500, 100);

  h.wander.stop();
  assert.equal(h.wander.isHeld(), false);
  assert.deepEqual(h.airborneStates, [true, false], 'the renderer is told she is down');
  assert.equal(h.wander.moveTo(600, 100), false, 'nothing moves after teardown');
  assert.equal(h.wander.grab(), false);
  assert.equal(h.wander.release({ vx: 500, vy: 0 }), false);
});

test('grab + moveTo + release is the recall path, and it ends a fall in progress', () => {
  // This is what module A's `home` action does now. It has to go through the hold
  // API rather than move the window itself: `cancel()` deliberately leaves a fall
  // running, so a bare move would be undone one tick later by physics still
  // integrating from where she used to be — reachable the moment throws exist.
  const h = harness({ workArea: REAL_AREA, size: REAL_SIZE });
  h.wander.setMode('idle');
  h.place(300, 100);
  h.wander.containNow();
  assert.equal(h.wander.isFalling(), true, 'mid-fall when he asks her to come back');

  h.wander.grab();
  h.wander.moveTo(h.maxX, h.bottomY);
  h.wander.release({ vx: 0, vy: 0 });

  assert.equal(h.wander.isFalling(), false, 'the fall is over, not still integrating');
  assert.deepEqual(
    { x: h.moves.at(-1).x, y: h.moves.at(-1).y },
    { x: h.maxX, y: h.bottomY },
    'and she is in the corner',
  );

  const home = h.moves.length;
  h.advance(WANDER_DEFAULTS.gapMinMs - 1);
  assert.equal(h.moves.length, home, 'nothing drags her back out of it');
});

test('release without a grab is inert, so a stray mouseup cannot launch her', () => {
  const h = harness({ workArea: REAL_AREA, size: REAL_SIZE });
  h.wander.setMode('idle');
  h.place(800, h.bottomY);
  assert.equal(h.wander.release({ vx: 900, vy: -600 }), false);
  assert.equal(h.wander.isFalling(), false);
  assert.equal(h.moves.length, 0);
});
