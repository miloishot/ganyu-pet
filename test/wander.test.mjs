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

function harness({ workArea = FULL_HD, randoms = [0.5], pinned = false, startX } = {}) {
  let now = 0;
  let nextId = 1;
  let drawIndex = 0;
  let pinnedFlag = pinned;
  const timers = new Map();
  const moves = [];
  const walkStates = [];

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
    clock: { now: () => now },
    schedule,
    moveWindow: (x, y) => moves.push({ x, y, t: now }),
    getWorkArea: () => ({ ...workArea }),
    onWalkState: (walk) => walkStates.push(walk ? { dir: walk.dir, t: now } : null),
    isPinned: () => pinnedFlag,
    random: () => randoms[drawIndex++ % randoms.length],
    ...(startX === undefined ? {} : { getPosition: () => ({ x: startX, y: 0 }) }),
  });

  return {
    wander,
    advance,
    moves,
    walkStates,
    now: () => now,
    pin: (v) => {
      pinnedFlag = v;
    },
    pending: () => timers.size,
    dirs: () => walkStates.map((s) => (s ? s.dir : null)),
    minX: workArea.x,
    maxX: workArea.x + workArea.width - WIN_W,
    bottomY: workArea.y + workArea.height - WIN_H,
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
