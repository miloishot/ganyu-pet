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

// ---------------------------------------------------------- perching on ledges
//
// The top edges of other windows are surfaces too: she can be dropped onto one,
// stroll along it, and fall off it when the window moves, shrinks or closes. These
// cases bring their own harness because the one above can neither inject
// getLedges nor count random() draws — and every test above must stay exactly as
// it is, because together they are the proof that no ledges changes nothing.

const TICK = WANDER_DEFAULTS.tickMs; // 50
const MAX_X = FULL_HD.width - WIN_W; // 1664
const FLOOR_Y = FULL_HD.height - WIN_H; // 720
// The largest step physics may take in one tick: terminal velocity for the longest
// dt the clamp lets through. Anything bigger between two frames is a teleport.
const WORST_STEP = (WANDER_DEFAULTS.maxFallPxPerSec * WANDER_DEFAULTS.maxTickDtMs) / 1000; // 225

/** A ledge as ledges.mjs reports it: an unoccluded top edge of a window, in DIP. */
const ledge = (left, right, top, hwnd = 1) => ({ left, right, top, hwnd });
// Her window stands at `top - 320` (its bottom edge is her feet), and her whole
// 256px footprint has to be on the edge, so she can stand at x in [left, right - 256].
const SHELF = ledge(400, 1000, 500, 11); // stands at y 180, x in [400, 744]
const TABLE = ledge(300, 1200, 800, 22); // stands at y 480, x in [300, 944], under SHELF
const SHELF_Y = 180;
const TABLE_Y = 480;

function perchHarness({ randoms = [0.5], pinned = false, startX, startY, ledges, getLedges } = {}) {
  let now = 0;
  let skew = 0;
  let nextId = 1;
  let draws = 0;
  let pinnedFlag = pinned;
  let area = { ...FULL_HD };
  let current = (ledges || []).map((l) => ({ ...l }));
  const pos = { x: startX, y: startY };
  const timers = new Map();
  const moves = [];
  const walkStates = [];
  const airborneStates = [];

  const schedule = (fn, ms) => {
    const id = nextId++;
    timers.set(id, { at: now + ms, fn });
    return () => timers.delete(id);
  };

  function advance(ms) {
    const end = now + ms;
    for (let guard = 0; ; guard++) {
      if (guard > 500_000) throw new Error('advance: runaway timer loop');
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
  }

  // `getLedges` is handed over verbatim (throwing, frozen, garbage...). `ledges`
  // is a list the test can change, served as a fresh copy on every read the way
  // the real ledge source serves it. Neither means no injection at all.
  const injected =
    getLedges !== undefined
      ? { getLedges }
      : ledges
        ? { getLedges: () => current.map((l) => ({ ...l })) }
        : {};

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
    random: () => randoms[draws++ % randoms.length],
    getPosition: () => ({ x: pos.x, y: pos.y }),
    ...injected,
  });

  return {
    wander,
    advance,
    moves,
    walkStates,
    airborneStates,
    draws: () => draws,
    pending: () => timers.size,
    dirs: () => walkStates.map((s) => (s ? s.dir : null)),
    place: (x, y) => {
      pos.x = x;
      pos.y = y;
    },
    setWorkArea: (next) => {
      area = { ...next };
    },
    /** The window under her moved, shrank, was minimized or closed. */
    setLedges: (next) => {
      current = next.map((l) => ({ ...l }));
    },
    bump: (ms) => {
      skew += ms;
    },
  };
}

/** The largest jump between consecutive frames, on either axis, starting from `from`. */
function largestStep(from, moves) {
  let prev = from;
  let worst = 0;
  for (const m of moves) {
    worst = Math.max(worst, Math.abs(m.x - prev.x), Math.abs(m.y - prev.y));
    prev = m;
  }
  return worst;
}

const at = (m) => ({ x: m.x, y: m.y });

test('a fall lands on the ledge under her and settles exactly at its top minus her height', () => {
  const cases = [
    {
      label: 'dropped by a display change',
      act: (h) => {
        h.place(600, 0);
        assert.equal(h.wander.containNow(), false, 'inside the work area: nothing to clamp');
      },
    },
    { label: 'starting above it at launch', startX: 600, startY: 40, act: (h) => h.wander.containNow() },
    {
      label: 'let go above it',
      act: (h) => {
        h.wander.grab();
        h.wander.moveTo(600, 60);
        h.wander.release({ vx: 0, vy: 0 });
      },
    },
    {
      label: 'thrown straight up from above it',
      act: (h) => {
        h.wander.grab();
        h.wander.moveTo(600, 150);
        h.wander.release({ vx: 0, vy: -600 });
      },
    },
    // One-way, like a platform: rising from below she passes up through the
    // edge, and on the way back down she lands on top of it.
    {
      label: 'thrown up through it from below',
      act: (h) => {
        h.wander.grab();
        h.wander.moveTo(600, 400);
        h.wander.release({ vx: 0, vy: -1000 });
      },
    },
  ];

  for (const { label, startX, startY, act } of cases) {
    const h = perchHarness({ ledges: [SHELF, TABLE], startX, startY });
    act(h);
    assert.equal(h.wander.isFalling(), true, `${label}: in the air`);
    h.advance(20_000);

    assert.equal(h.wander.isFalling(), false, `${label}: settled`);
    assert.deepEqual(at(h.moves.at(-1)), { x: 600, y: SHELF_Y }, `${label}: exactly on the shelf`);
    assert.ok(h.moves.every((m) => m.x === 600), `${label}: the fall is vertical`);
    assert.equal(h.airborneStates.at(-1), false, `${label}: and the renderer is told she is down`);

    // Once above the shelf she never goes below it: no tunnelling through the
    // edge, bounces included.
    const above = h.moves.findIndex((m) => m.y < SHELF_Y);
    assert.ok(above >= 0, `${label}: she was above the shelf`);
    assert.ok(h.moves.slice(above).every((m) => m.y <= SHELF_Y), `${label}: and never fell through it`);
    if (label.endsWith('from below')) assert.ok(above > 1, 'it took several frames to rise through the gap');

    const settled = h.moves.length;
    assert.equal(h.wander.containNow(), false, `${label}: the poll finds her standing`);
    h.advance(10 * 60_000);
    assert.equal(h.moves.length, settled, `${label}: and she stays there`);
    assert.equal(h.wander.isFalling(), false);
  }
});

test('a ledge that moves down, moves up or closes beneath her drops her to the next surface below, never teleporting', () => {
  const cases = [
    // [what happened to the shelf, the ledges afterwards, where she must end up]
    ['moved down 100px', [ledge(400, 1000, 600, 11), TABLE], 280], // still the next surface below
    ['moved up 50px', [ledge(400, 1000, 450, 11), TABLE], TABLE_Y], // rose past her feet: not hers
    ['minimized', [TABLE], TABLE_Y],
    ['closed, with nothing below it', [], FLOOR_Y],
  ];
  for (const [label, after, landsAt] of cases) {
    const h = perchHarness({ ledges: [SHELF, TABLE], startX: 600, startY: SHELF_Y });
    assert.equal(h.wander.containNow(), false, `${label}: resting on the shelf to begin with`);
    assert.equal(h.wander.isFalling(), false, `${label}: and not falling`);

    h.setLedges(after);
    h.wander.containNow(); // production calls this from the ledge source's onChange
    assert.equal(h.wander.isFalling(), true, `${label}: standing on air now`);
    h.advance(100);
    h.bump(10_000); // and the machine sleeps mid-fall: the next tick is 10s late
    h.advance(20_000);

    assert.equal(h.wander.isFalling(), false, `${label}: settled`);
    assert.deepEqual(at(h.moves.at(-1)), { x: 600, y: landsAt }, `${label}: on the next surface down`);
    assert.ok(h.moves.every((m) => m.y >= SHELF_Y), `${label}: never above where she stood: no snapping up`);
    const worst = largestStep({ x: 600, y: SHELF_Y }, h.moves);
    assert.ok(worst <= WORST_STEP, `${label}: largest frame-to-frame jump ${worst}px, capped at ${WORST_STEP}px`);
    assert.deepEqual(h.airborneStates, [true, false], `${label}: one fall, edge-triggered`);
  }
});

test('too-high, too-narrow and out-of-reach ledges are not surfaces, and each filter is exact', () => {
  // Every ignored ledge sits next to the smallest change that makes it count,
  // so each filter is shown to be the thing doing the ignoring.
  const dropAt = (opts, x) => {
    const h = perchHarness(opts);
    h.place(x, 0);
    h.wander.containNow();
    h.advance(20_000);
    return h.moves.length ? h.moves.at(-1).y : null;
  };

  // Too high: she would stand 0.3px above the top of the work area. Placed at the
  // top she is within FLOOR_EPS of it, so only the filter stops it holding her.
  const tooHigh = perchHarness({ ledges: [ledge(400, 1000, WIN_H - 0.3)] });
  tooHigh.place(600, 0);
  tooHigh.wander.containNow();
  assert.equal(tooHigh.wander.isFalling(), true, 'a ledge above the work area is ignored');
  tooHigh.advance(20_000);
  assert.equal(tooHigh.moves.at(-1).y, FLOOR_Y, 'and she falls past it to the floor');
  const atTop = perchHarness({ ledges: [ledge(400, 1000, WIN_H)] });
  atTop.place(600, 0);
  atTop.wander.containNow();
  assert.equal(atTop.wander.isFalling(), false, 'control: standing exactly at the top of the work area holds');

  // Too narrow: her whole footprint must be on the edge. 0.6px short leaves an
  // empty standing range [400, 399.4]; x 399.7 is within the half-pixel slack of
  // both of its ends, so only the empty-range filter keeps it from holding her.
  assert.equal(dropAt({ ledges: [ledge(400, 400 + WIN_W - 1, 500)] }, 400), FLOOR_Y, '1px narrower than her');
  assert.equal(dropAt({ ledges: [ledge(400, 400 + WIN_W - 0.6, 500)] }, 399.7), FLOOR_Y, '0.6px narrower than her');
  assert.equal(dropAt({ ledges: [ledge(400, 400 + WIN_W, 500)] }, 400), SHELF_Y, 'control: exactly her width holds');
  assert.equal(dropAt({ ledges: [ledge(400, 400 + WIN_W, 500)] }, 401), FLOOR_Y, '...at its one x only');

  // Wide enough, but not where she is: part of her footprint would be over air.
  for (const x of [399, 745]) assert.equal(dropAt({ ledges: [SHELF] }, x), FLOOR_Y, `x ${x} overhangs the shelf`);
  for (const x of [400, 744]) assert.equal(dropAt({ ledges: [SHELF] }, x), SHELF_Y, `control: x ${x} is on it`);

  // Clipped to the work area rather than discarded, and gone if nothing is left.
  assert.equal(dropAt({ ledges: [ledge(1500, 2400, 500)] }, MAX_X), SHELF_Y, 'runs off-screen: clipped');
  assert.equal(dropAt({ ledges: [ledge(1800, 2400, 500)] }, MAX_X), FLOOR_Y, 'nothing on-screen to stand on');

  // Malformed entries are dropped one by one; the good one next to them survives.
  const messy = [null, 'shelf', 7, ledge(NaN, 1000, 500), ledge(400, Infinity, 500), ledge(400, 1000, 500, NaN),
    { left: 400, right: 1000, top: 500 }, SHELF];
  assert.equal(dropAt({ getLedges: () => messy }, 600), SHELF_Y, 'the valid ledge still holds her');
  assert.equal(dropAt({ getLedges: () => messy.slice(0, -1) }, 600), FLOOR_Y, 'and none of the junk does');
  // A frozen list (the ledge source may hand out one shared array) is read, not rewritten.
  const frozen = Object.freeze([Object.freeze({ ...SHELF })]);
  assert.equal(dropAt({ getLedges: () => frozen }, 600), SHELF_Y, 'a frozen list works');
});

test('a stroll on a ledge picks its targets between the ledge ends and walks right up to them', () => {
  // stroll 1: target fraction 0 (left end) / no pause / 45s gap
  // stroll 2: target fraction 0.9999 (right end) / no pause / 45s gap
  const h = perchHarness({
    ledges: [SHELF, TABLE],
    startX: 600,
    startY: SHELF_Y,
    randoms: [0, 0.9, 0, 0.9999, 0.9, 0],
  });
  h.wander.setMode('idle');
  h.advance(ARM + 80_000); // 200px left, a 45s gap, 344px right

  assert.deepEqual(h.dirs(), ['left', null, 'right', null], 'two strolls along the shelf');
  assert.ok(h.moves.every((m) => m.y === SHELF_Y), 'both on the shelf');
  assert.ok(h.moves.every((m) => m.x >= 400 && m.x <= 744), 'never past either end');
  assert.ok(h.moves.some((m) => m.x === 400), 'walked to the left end');
  assert.equal(h.moves.at(-1).x, 744, 'and then to the right end');
  assert.deepEqual(h.airborneStates, [], 'never left the shelf');
});

test('the ledge shrinking mid-stroll turns her at its new end, and shrinking out from under her drops her', () => {
  // target fraction 0.9999 (744, the right end) / no pause / turn-around roll 0.5
  const h = perchHarness({ ledges: [SHELF], startX: 450, startY: SHELF_Y, randoms: [0.9999, 0.9, 0.5] });
  h.wander.setMode('idle');
  h.advance(ARM + 30 * TICK);
  assert.deepEqual(at(h.moves.at(-1)), { x: 540, y: SHELF_Y }, '30 ticks right along the shelf');
  assert.deepEqual(h.dirs(), ['right']);

  // The window is resized narrower: the shelf now ends at x 600, short of her target.
  h.setLedges([ledge(400, 856, 500, 11)]);
  const shrunk = h.moves.length;
  h.advance(60 * TICK);
  const after = h.moves.slice(shrunk);
  assert.ok(after.every((m) => m.y === SHELF_Y && m.x <= 600), 'never past the new end, never off the shelf');
  assert.ok(after.some((m) => m.x === 600), 'walked up to the new end');
  assert.deepEqual(h.dirs(), ['right', 'left', null], 'turned around there, then arrived');
  // The fresh target is picked back along the *shelf*: 600 - between(1, 600 - 400)
  // at roll 0.5 is 500. Measured against the floor it would have been 400.
  assert.equal(h.moves.at(-1).x, 500, 'at a target picked inside the shrunken shelf');
  assert.equal(h.wander.isWandering(), false);

  // One step from her target when the shelf shrinks to end 2px short of it: the
  // target cannot be arrived at any more, so she turns at the new end instead.
  const near = perchHarness({ ledges: [SHELF], startX: 735, startY: SHELF_Y, randoms: [0.9999, 0.9, 0.5] });
  near.wander.setMode('idle');
  near.advance(ARM + 2 * TICK);
  assert.equal(near.moves.at(-1).x, 741, '3px short of her 744 target');
  near.setLedges([ledge(400, 998, 500, 11)]); // standing range [400, 742]
  near.advance(TICK);
  assert.deepEqual(at(near.moves.at(-1)), { x: 742, y: SHELF_Y }, 'stopped at the new end, not at the old target');
  assert.deepEqual(near.dirs(), ['right', 'left']);
  near.wander.containNow();
  assert.equal(near.wander.isFalling(), false, 'and is still standing on the shelf');

  // Narrower still, mid-stroll: the shelf no longer reaches where she is standing.
  const d = perchHarness({ ledges: [SHELF], startX: 560, startY: SHELF_Y, randoms: [0.9999, 0.9, 0.5] });
  d.wander.setMode('idle');
  d.advance(ARM + 5 * TICK);
  const standing = d.moves.at(-1);
  assert.deepEqual(at(standing), { x: 575, y: SHELF_Y }, 'walking right along the shelf');
  d.setLedges([ledge(400, 700, 500, 11)]); // standing range [400, 444]
  const before = d.moves.length;
  d.advance(20_000);
  const fall = d.moves.slice(before);
  assert.ok(fall.length > 0, 'she moved');
  assert.ok(fall.every((m) => m.x === standing.x), 'straight down from where she stood: not walked over the edge');
  assert.ok(fall[0].y > SHELF_Y, 'the very next frame is already a fall');
  assert.equal(fall.at(-1).y, FLOOR_Y, 'and she lands on the floor');
  assert.deepEqual(d.dirs(), ['right', null], 'the stroll was dropped');
  assert.equal(d.wander.isWandering(), false);
  assert.equal(d.wander.isFalling(), false);
});

test('a ledge running past the side of the work area is clipped: she strolls to the screen edge, not past it', () => {
  // Right side: standing range [1500, 2144] clipped to [1500, 1664]; fraction 0.9999 is its right end.
  const h = perchHarness({
    ledges: [ledge(1500, 2400, 500, 55)],
    startX: 1600,
    startY: SHELF_Y,
    randoms: [0.9999, 0.9, 0.5],
  });
  h.wander.setMode('idle');
  h.advance(ARM + 60 * TICK);
  assert.ok(h.moves.length > 0, 'she strolled');
  assert.ok(h.moves.every((m) => m.x <= MAX_X && m.y === SHELF_Y), 'never past the edge of the screen');
  assert.equal(h.moves.at(-1).x, MAX_X, 'the far end she walked to is the screen edge');

  // Left side: standing range [-500, 344] clipped to [0, 344]; fraction 0 is its left end.
  const l = perchHarness({ ledges: [ledge(-500, 600, 500, 66)], startX: 60, startY: SHELF_Y, randoms: [0, 0.9, 0.5] });
  l.wander.setMode('idle');
  l.advance(ARM + 60 * TICK);
  assert.ok(l.moves.length > 0, 'she strolled');
  assert.ok(l.moves.every((m) => m.x >= 0 && m.y === SHELF_Y), 'never past the left edge of the screen');
  assert.equal(l.moves.at(-1).x, 0, 'the far end she walked to is the screen edge');
});

test('a ledge overhead changes nothing about a stroll along the floor', () => {
  // target fraction 0 / pause roll 0.1 (pause) / pause at 50% / 3s breather
  const run = (ledges) => {
    const h = perchHarness({ ledges, randoms: [0, 0.1, 0.5, 0] });
    h.wander.setMode('idle');
    h.advance(ARM + 200_000);
    return { moves: h.moves, walkStates: h.walkStates, airborneStates: h.airborneStates, draws: h.draws() };
  };
  const bare = run(undefined);
  assert.ok(bare.moves.length > 500, 'a real stroll');
  assert.ok(bare.moves.every((m) => m.y === FLOOR_Y), 'along the floor');
  assert.deepEqual(run([SHELF, TABLE]), bare, 'same frames, same walk states, same random() draws');
});

test('a skid on a ledge decays on it like on the floor, and a skid past its end drops her off', () => {
  const h = perchHarness({ ledges: [SHELF] });
  h.wander.setMode('idle');
  h.wander.grab();
  h.wander.moveTo(500, SHELF_Y);
  h.wander.release({ vx: 300, vy: 0 }); // flicked along the shelf
  assert.equal(h.wander.isFalling(), true, 'a skid is physics, not a set-down');
  h.advance(20_000);
  const end = h.moves.at(-1);
  assert.equal(end.y, SHELF_Y, 'she never left the shelf');
  assert.ok(end.x > 500 && end.x < 744, `friction stopped her on it, at ${end.x}`);
  assert.equal(h.wander.isFalling(), false);

  const off = perchHarness({ ledges: [SHELF] });
  off.wander.setMode('idle');
  off.wander.grab();
  off.wander.moveTo(720, SHELF_Y);
  off.wander.release({ vx: 600, vy: 0 }); // 24px from the end, far too fast to stop in time
  off.advance(20_000);
  assert.equal(off.moves.at(-1).y, FLOOR_Y, 'she slid off the end and landed on the floor');
  assert.ok(off.moves.at(-1).x > 744, 'beyond the shelf, carried by the skid');
  assert.ok(
    off.moves.filter((m) => m.y === SHELF_Y).every((m) => m.x <= 744),
    'every frame at shelf height had her on the shelf',
  );
  assert.equal(off.wander.isFalling(), false);
});

test('with no ledges — none injected, empty, throwing or garbage — the trace is identical, draw for draw', () => {
  // arm, stroll with a breather, a calm hop, a wall moving in and the floor rising
  // under the stroll, a throw with the work area shrinking mid-flight, containment,
  // a drag up and a fall, the `home` recall, another stroll, cancel, stop.
  const script = (opts) => {
    const h = perchHarness({ randoms: [0, 0.1, 0.5, 0, 0.6, 0.2, 0.9, 0.3], ...opts });
    const flags = [];
    const mark = (label) => {
      flags.push([label, h.wander.isFalling(), h.wander.isHeld(), h.wander.isWandering(), h.wander.isArmed()]);
    };
    h.wander.containNow();
    mark('startup');
    h.wander.setMode('idle');
    h.advance(ARM);
    mark('armed');
    h.advance(400 * TICK);
    mark('walked, paused, resumed');
    h.wander.setMode('busy');
    h.advance(100 * TICK);
    mark('calm hop');
    h.setWorkArea({ x: 200, y: 0, width: 1720, height: 900 }); // left wall in, floor up
    h.advance(100 * TICK);
    mark('turned at the wall');
    h.wander.grab();
    mark('grabbed');
    h.wander.moveTo(300, 200);
    h.wander.moveTo(340, 180);
    h.wander.release({ vx: 900, vy: -200 });
    mark('thrown');
    h.advance(150);
    h.setWorkArea({ x: 0, y: 0, width: 1200, height: 900 }); // shrinks mid-flight
    h.advance(30_000);
    mark('landed');
    h.place(5_000, 5_000);
    h.wander.containNow();
    mark('contained');
    h.place(800, 100);
    h.wander.containNow();
    mark('dragged up');
    h.advance(30_000);
    mark('fell');
    h.wander.grab();
    h.wander.moveTo(99_999, 99_999);
    h.wander.release({ vx: 0, vy: 0 });
    mark('home');
    h.advance(300_000);
    mark('strolled again');
    h.wander.cancel();
    h.wander.setMode('waiting');
    mark('cancelled');
    h.wander.stop();
    mark('stopped');
    h.advance(60_000);
    return {
      moves: h.moves,
      walkStates: h.walkStates,
      airborneStates: h.airborneStates,
      draws: h.draws(),
      pending: h.pending(),
      flags,
    };
  };

  const base = script({}); // no getLedges at all: the floor-only module
  // Not a vacuous comparison: the scenario really does all of the above.
  const dirs = base.walkStates.map((s) => (s ? s.dir : null));
  assert.deepEqual(dirs.slice(0, 3), ['left', null, 'left'], 'strolled, took a breather, walked on');
  assert.ok(dirs.includes('right'), 'turned around at the wall that moved in');
  // This one anchors the floor rule itself, which comparing variants cannot: the
  // floor rising 140px under a stroll is containNow's to clamp, so she walks on at
  // the old y to the wall instead of gravity "landing" her upward onto the new floor.
  assert.ok(base.moves.some((m) => m.x === 200 && m.y === 720), 'strolled on below the risen floor');
  assert.ok(base.moves.some((m) => m.x === 944 && m.y < 580), 'the throw hit the shrunken right wall in mid-air');
  assert.ok(base.airborneStates.filter(Boolean).length >= 3, 'thrown, dropped, and picked up');
  assert.ok(base.moves.length > 300 && base.draws > 4, `${base.moves.length} frames, ${base.draws} draws`);
  assert.equal(base.pending, 0, 'and stop() left nothing pending');

  const cycling = (values) => {
    let i = 0;
    return () => values[i++ % values.length];
  };
  // Only entries that are invalid under every work area the script uses.
  const invalid = [
    null,
    'shelf',
    42,
    ledge(0, 1920, 300), // stands above the top of the work area
    ledge(400, 400 + WIN_W - 1, 700), // narrower than her
    ledge(NaN, 1000, 700),
    ledge(400, 1000, Infinity),
    ledge(400, 1000, 700, NaN),
    { left: 400, right: 1000, top: 700 }, // no hwnd
    ledge(0, 1920, FULL_HD.height), // standing y at the floor, not above it
    ledge(0, 1920, 5_000), // below the floor
    ledge(5_000, 9_000, 700), // off the side of the screen
  ];
  const variants = [
    ['getLedges: () => []', { getLedges: () => [] }],
    ['a frozen empty list', { getLedges: () => Object.freeze([]) }],
    [
      'a throwing getLedges',
      {
        getLedges: () => {
          throw new Error('ledge helper died');
        },
      },
    ],
    ['a non-array getLedges', { getLedges: cycling([null, undefined, 'ledges', 42, { length: 1, 0: SHELF }]) }],
    ['only invalid ledges', { getLedges: () => invalid }],
  ];
  for (const [label, opts] of variants) {
    assert.deepEqual(script(opts), base, `${label}: identical to having no getLedges at all`);
  }
});

test('pinned on a ledge she never strolls, yet still drops when the window under her closes', () => {
  const h = perchHarness({ pinned: true, startX: 600, startY: SHELF_Y, ledges: [SHELF] });
  h.wander.setMode('idle');
  h.advance(30 * 60_000);
  assert.equal(h.moves.length, 0, 'pinned: not one step along the shelf');
  assert.equal(h.walkStates.length, 0);
  assert.equal(h.wander.containNow(), false, 'the poll finds her standing on it');
  assert.equal(h.wander.isFalling(), false);

  h.setLedges([]);
  h.wander.containNow();
  assert.equal(h.wander.isFalling(), true, 'gravity outranks the pin, on a ledge as on the floor');
  h.advance(20_000);
  assert.deepEqual(at(h.moves.at(-1)), { x: 600, y: FLOOR_Y });
  assert.equal(h.wander.isWandering(), false, 'and she still never strolls');
});

test('she can be picked up off a ledge, set down on another, and dropped from there into the air', () => {
  // target fraction 0.5 (x 572 on the shelf, 622 on the table) / no pause / 82.5s gaps
  const h = perchHarness({ ledges: [SHELF, TABLE], startX: 600, startY: SHELF_Y });
  h.wander.setMode('idle');
  h.advance(ARM + 5 * TICK);
  assert.equal(h.wander.isWandering(), true, 'strolling along the shelf');

  assert.equal(h.wander.grab(), true);
  assert.equal(h.wander.isHeld(), true);
  assert.equal(h.wander.isWandering(), false, 'the stroll is abandoned');
  assert.deepEqual(h.dirs(), ['left', null]);
  h.wander.moveTo(500, TABLE_Y);
  const down = h.moves.length;
  h.wander.release({ vx: 0, vy: 0 });
  assert.equal(h.wander.isFalling(), false, 'set down on the table, not dropped onto it');
  assert.deepEqual(h.airborneStates, [true, false]);
  assert.equal(h.wander.isArmed(), true, 'straight back to the ordinary scheduler');
  h.advance(1_000);
  assert.equal(h.moves.length, down, 'not one physics tick spent on standing still');

  h.advance(82_500 + 10_000); // the next stroll happens on the table
  const onTable = h.moves.slice(down);
  assert.ok(onTable.length > 0, 'she strolled again');
  assert.ok(onTable.every((m) => m.y === TABLE_Y && m.x >= 300 && m.x <= 944), 'along the table');
  assert.equal(h.moves.at(-1).x, 622, 'to a target picked on the table');

  h.wander.grab();
  h.wander.moveTo(1_300, 300); // over neither ledge
  h.wander.release({ vx: 0, vy: 0 });
  assert.equal(h.wander.isFalling(), true, 'let go in mid-air');
  h.advance(20_000);
  assert.deepEqual(at(h.moves.at(-1)), { x: 1_300, y: FLOOR_Y }, 'past the table, onto the floor');
});

test('home via grab + moveTo + release still lands her in the corner with ledges about, even mid-fall', () => {
  const corner = ledge(1_300, 1_920, 500, 33); // a ledge right above the corner: stands at y 180
  const h = perchHarness({ ledges: [SHELF, corner] });
  h.wander.setMode('idle');
  h.place(600, 0);
  h.wander.containNow();
  assert.equal(h.wander.isFalling(), true, 'falling toward the shelf when he asks her home');
  h.advance(100);

  h.wander.grab();
  h.wander.moveTo(MAX_X, FLOOR_Y);
  h.wander.release({ vx: 0, vy: 0 });
  assert.equal(h.wander.isFalling(), false, 'the fall is over, not still integrating');
  assert.deepEqual(at(h.moves.at(-1)), { x: MAX_X, y: FLOOR_Y }, 'in the corner, on the floor under the ledge');

  const home = h.moves.length;
  assert.equal(h.wander.containNow(), false, 'standing on the floor');
  h.advance(WANDER_DEFAULTS.gapMinMs - 1);
  assert.equal(h.moves.length, home, 'nothing drags her back out of it');
});

test('containment stands down while she is held, even as the ledges change under her', () => {
  const h = perchHarness({ ledges: [SHELF] });
  h.wander.grab();
  h.wander.moveTo(600, 100);
  const carried = h.moves.length;

  h.setLedges([TABLE]);
  assert.equal(h.wander.containNow(), false, 'the onChange call finds nothing to do');
  h.setLedges([]);
  assert.equal(h.wander.containNow(), false);
  assert.equal(h.moves.length, carried, 'and moves her not at all');
  assert.equal(h.wander.isFalling(), false, 'nor drops her out of his hand');
  assert.equal(h.wander.isHeld(), true);

  h.setLedges([SHELF, TABLE]);
  h.wander.release({ vx: 0, vy: 0 });
  h.advance(20_000);
  assert.deepEqual(at(h.moves.at(-1)), { x: 600, y: SHELF_Y }, 'let go, she lands on the shelf below her');
});

test('fractional ledge coordinates survive rounding: the poll never knocks her off her own ledge', () => {
  // DIP edges are fractional at 125%/150% scaling; moveWindow and getPosition are
  // whole pixels. Stands at y 180.4, x in [400.3, 744.7].
  const h = perchHarness({ ledges: [ledge(400.3, 1000.7, 500.4, 44)], randoms: [0, 0.9, 0.5] });
  h.place(600, 0);
  h.wander.containNow();
  h.advance(20_000);
  assert.equal(h.wander.isFalling(), false);
  assert.deepEqual(at(h.moves.at(-1)), { x: 600, y: 180 }, 'landed at 180.4, rounded for the window');
  const airborne = h.airborneStates.length;

  // The poll re-reads the window's whole-pixel position: 0.4px off the edge.
  assert.equal(h.wander.containNow(), false);
  assert.equal(h.wander.containNow(), false);
  assert.equal(h.wander.isFalling(), false, 'still standing on it');

  h.wander.setMode('idle');
  h.advance(ARM + 80 * TICK); // target fraction 0: the left end, 400.3
  assert.equal(h.moves.at(-1).x, 400, 'walked to the fractional end, rounded for the window');
  assert.equal(h.wander.isWandering(), false, 'and arrived');
  h.wander.containNow(); // reads x back as 400: 0.3px past the end of the ledge
  assert.equal(h.wander.isFalling(), false, 'half a pixel of slack: rounding cannot walk her off it');
  assert.equal(h.airborneStates.length, airborne, 'and no airborne edge flickered');
});

// ------------------------------------------------- review fixes (perching, r1)

function reviewRig(ledges, start = { x: 200, y: 600 }) {
  let now = 0;
  let id = 1;
  const timers = new Map();
  const pos = { ...start };
  const moves = [];
  const w = createWander({
    clock: { now: () => now },
    schedule: (fn, ms) => {
      const i = id++;
      timers.set(i, { at: now + ms, fn });
      return () => timers.delete(i);
    },
    moveWindow: (mx, my) => {
      pos.x = mx;
      pos.y = my;
      moves.push([mx, my]);
    },
    getWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
    getWindowSize: () => ({ width: 256, height: 320 }),
    getPosition: () => ({ ...pos }),
    getLedges: () => ledges,
  });
  const runFall = () => {
    for (let n = 0; w.isFalling() && n < 2000; n++) {
      let pick = null;
      for (const [i, t] of timers) if (!pick || t.at < pick.t.at || (t.at === pick.t.at && i < pick.i)) pick = { i, t };
      timers.delete(pick.i);
      now = pick.t.at;
      pick.t.fn();
    }
  };
  return { w, pos, moves, runFall };
}

test('perch: rising up through a ledge is mid-air — no ground friction on that tick', () => {
  const throwUp = (ledges) => {
    const r = reviewRig(ledges);
    r.w.containNow();
    r.w.grab();
    r.w.moveTo(200, 600);
    r.moves.length = 0;
    r.w.release({ vx: 100, vy: -1500 });
    r.runFall();
    return r.moves;
  };
  const free = throwUp(Object.freeze([]));
  // A ledge whose standing y is exactly where she is after the first tick, while
  // she is still rising: the second tick starts "on" it, moving up.
  const [, y1] = free[0];
  const ledge = Object.freeze([Object.freeze({ left: 0, right: 1919, top: y1 + 320, hwnd: 1 })]);
  const through = throwUp(ledge);
  assert.ok(free[1][1] < free[0][1], 'precondition: still rising on tick 2');
  assert.deepEqual(through.slice(0, 3), free.slice(0, 3), 'the first ticks of the flight are untouched by the ledge she passes');
});

test('perch: set down within the slack past a ledge end, the 1s poll leaves her on it', () => {
  // lo 300, hi 800.3 at standing y 400.
  const ledge = Object.freeze([Object.freeze({ left: 300, right: 1056.3, top: 720, hwnd: 7 })]);
  const r = reviewRig(ledge, { x: 600, y: 400 });
  r.w.grab();
  r.w.moveTo(800.7, 400);
  r.w.release({ vx: 0, vy: 0 });
  assert.equal(r.w.isFalling(), false);
  for (let i = 0; i < 3; i++) r.w.containNow();
  assert.equal(r.w.isFalling(), false, 'an unchanged ledge never drops her');
  assert.ok(r.pos.x <= 800.8 && r.pos.y === 400, `still on the ledge at ${r.pos.x},${r.pos.y}`);

  // Mirror at the left end.
  const left = Object.freeze([Object.freeze({ left: 300.7, right: 1056, top: 720, hwnd: 7 })]);
  const m = reviewRig(left, { x: 600, y: 400 });
  m.w.grab();
  m.w.moveTo(300.3, 400);
  m.w.release({ vx: 0, vy: 0 });
  m.w.containNow();
  assert.equal(m.w.isFalling(), false);
});

test('perch: no skid that comes to rest on a ledge is knocked off it by the poll', () => {
  let drops = 0;
  let rests = 0;
  for (const frac of [0, 0.1, 0.3, 0.5]) {
    const ledge = Object.freeze([Object.freeze({ left: 300, right: 1056 + frac, top: 720, hwnd: 7 })]);
    for (let sx = 600; sx <= 800; sx += 7) {
      for (let vx0 = 40; vx0 <= 1400; vx0 += 37) {
        const r = reviewRig(ledge, { x: sx, y: 400 });
        r.w.grab();
        r.w.moveTo(sx, 400);
        r.w.release({ vx: vx0, vy: 0 });
        r.runFall();
        if (r.pos.y !== 400) continue; // skidded off the end: fine, that is a fall
        rests += 1;
        r.w.containNow();
        if (r.w.isFalling()) drops += 1;
      }
    }
  }
  assert.ok(rests > 100, `enough skids came to rest on the ledge (${rests})`);
  assert.equal(drops, 0);
});

test('perch: a hostile ledge entry costs that entry, not containment', () => {
  const evil = {};
  Object.defineProperty(evil, 'left', { get() { throw new Error('boom'); } });
  const good = { left: 0, right: 1919, top: 720, hwnd: 2 };
  const r = reviewRig([evil, good], { x: 600, y: 100 });
  assert.doesNotThrow(() => r.w.containNow());
  r.runFall();
  assert.equal(r.pos.y, 400, 'landed on the good ledge');
});

test('perch: setting her down on the floor never moves her, even if the work area shrank while held', () => {
  // Pinned after a review round where a ledge-only clamp leaked onto the floor:
  // on the floor an out-of-range x is containNow's business, exactly as before.
  let area = { x: 0, y: 0, width: 1920, height: 1040 };
  const moves = [];
  const pos = { x: 1600, y: 720 };
  const w = createWander({
    clock: { now: () => 0 },
    schedule: () => () => {},
    moveWindow: (mx, my) => { pos.x = mx; pos.y = my; moves.push([mx, my]); },
    getWorkArea: () => area,
    getWindowSize: () => ({ width: 256, height: 320 }),
    getPosition: () => ({ ...pos }),
    getLedges: () => [],
  });
  w.grab();
  w.moveTo(1600, 720);
  area = { x: 0, y: 0, width: 1200, height: 1040 }; // maxX 944 now; she is at 1600
  moves.length = 0;
  w.release({ vx: 0, vy: 0 });
  assert.deepEqual(moves, [], 'release itself writes no position on the floor');
  w.containNow();
  assert.deepEqual(moves.at(-1), [944, 720], 'containNow is what pulls her back');
});
