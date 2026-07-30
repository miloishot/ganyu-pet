// Module E tests — success criterion 7:
//   "Wander scheduler unit tests with an injected clock: engages only after
//    >=90s aggregate idle, picks targets inside the primary display work area,
//    cancels immediately on any state change."
//
// No real timers and no Electron: a virtual scheduler drives the module's real
// constants (90s arm, 2-5min gaps, 60px/s, 50ms ticks, 3-8s pauses).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createWander, WANDER_DEFAULTS } from '../src/main/wander.mjs';

const WIN_W = WANDER_DEFAULTS.windowWidth; // 256
const WIN_H = WANDER_DEFAULTS.windowHeight; // 320
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

test('does not engage before 90s of idle, engages at 90s', () => {
  // target fraction 0 (leftmost) / no pause / mid-range gap
  const h = harness({ randoms: [0, 0.9, 0.5] });

  h.wander.setMode('idle');
  h.advance(89_999);
  assert.equal(h.moves.length, 0, 'no window moves before the 90s threshold');
  assert.equal(h.walkStates.length, 0, 'no walk state pushed before the 90s threshold');
  assert.equal(h.wander.isWandering(), false);

  h.advance(1); // t = 90_000 exactly
  assert.deepEqual(h.dirs(), ['left'], 'starts from the bottom-right corner, walks left');
  assert.equal(h.wander.isWandering(), true);
  assert.equal(h.moves.length, 0, 'first pixel moves on the first 50ms tick, not on arming');

  h.advance(WANDER_DEFAULTS.tickMs);
  assert.deepEqual(h.moves.at(-1), { x: h.maxX - 3, y: h.bottomY, t: 90_050 });
});

test('walks at ~60 px/s in 50ms ticks along the bottom edge', () => {
  const h = harness({ randoms: [0, 0.9, 0.5] });
  h.wander.setMode('idle');
  h.advance(90_000);
  h.advance(1_000); // exactly one second of walking

  assert.equal(h.moves.length, 20, '20 ticks per second');
  assert.equal(h.maxX - h.moves.at(-1).x, 60, '60 px covered in 1s');
  assert.ok(
    h.moves.every((m) => m.y === h.bottomY),
    'Y stays fixed at the bottom edge',
  );
});

test('never wanders while the aggregate mode is not idle', () => {
  for (const mode of ['busy', 'waiting', 'failed']) {
    const h = harness();
    h.wander.setMode(mode);
    h.advance(30 * 60_000);
    assert.equal(h.moves.length, 0, `${mode}: no movement`);
    assert.equal(h.walkStates.length, 0, `${mode}: no walk state`);
    assert.equal(h.wander.isWandering(), false);
  }
});

test('a non-idle state restarts the 90s countdown from scratch', () => {
  const h = harness({ randoms: [0, 0.9, 0.5] });

  h.wander.setMode('idle');
  h.advance(80_000);
  h.wander.setMode('busy');
  h.advance(10 * 60_000);
  assert.equal(h.moves.length, 0, 'busy cancels the pending countdown');

  h.wander.setMode('idle');
  h.advance(89_999);
  assert.equal(h.walkStates.length, 0, 'countdown starts over, not resumed from 80s');
  h.advance(1);
  assert.deepEqual(h.dirs(), ['left']);
});

test('repeated idle notifications do not restart the countdown', () => {
  const h = harness({ randoms: [0, 0.9, 0.5] });

  h.wander.setMode('idle');
  h.advance(45_000);
  h.wander.setMode('idle');
  h.wander.setMode({ mode: 'idle', celebrate: true, sessionCount: 1 }); // module B state object
  h.advance(45_000); // 90s aggregate idle in total

  assert.deepEqual(h.dirs(), ['left'], 'armed at 90s despite the extra idle pushes');
});

test('every target sits inside the primary display work area', () => {
  const workArea = { x: 100, y: 50, width: 1000, height: 800 }; // non-zero origin
  const fractions = [0, 0.25, 0.5, 0.75, 0.999];
  // per stroll: target fraction / pause roll (0.9 = no pause) / gap roll (0 = 2 min)
  const randoms = fractions.flatMap((f) => [f, 0.9, 0]);
  const h = harness({ workArea, randoms });

  h.wander.setMode('idle');
  h.advance(90_000);
  h.advance(800_000);

  assert.ok(h.moves.length > 0, 'strolled at least once');
  for (const m of h.moves) {
    assert.ok(m.x >= h.minX && m.x <= h.maxX, `x ${m.x} inside [${h.minX}, ${h.maxX}]`);
    assert.equal(m.y, h.bottomY);
  }

  // Split the move log into strolls on the multi-minute gaps between them.
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

test('any state change cancels a walk in progress instantly', () => {
  const h = harness({ randoms: [0, 0.9, 0.5] });
  h.wander.setMode('idle');
  h.advance(90_000);
  h.advance(500); // 10 ticks

  assert.equal(h.moves.length, 10);
  const frozenAt = h.moves.at(-1);

  h.wander.setMode('busy');
  assert.deepEqual(h.dirs(), ['left', null], 'onWalkState(null) fires on cancel');
  assert.equal(h.wander.isWandering(), false);
  assert.equal(h.wander.isArmed(), false);

  h.advance(10 * 60_000);
  assert.equal(h.moves.length, 10, 'no further movement after cancel');
  assert.deepEqual(h.moves.at(-1), frozenAt, 'the window is left where it stopped');
});

test('pinned never arms, and unpinning resumes without a state change', () => {
  const h = harness({ pinned: true }); // randoms all 0.5 -> no pause
  h.wander.setMode('idle');
  h.advance(30 * 60_000);
  assert.equal(h.moves.length, 0, 'pinned: never strolls');
  assert.equal(h.walkStates.length, 0, 'pinned: no walk state pushed');
  assert.equal(h.wander.isWandering(), false);

  h.pin(false);
  h.advance(WANDER_DEFAULTS.gapMaxMs + WANDER_DEFAULTS.tickMs);
  assert.ok(h.moves.length > 0, 'unpinned: the poll picks it back up');
  assert.ok(
    h.moves.every((m) => m.x >= h.minX && m.x <= h.maxX && m.y === h.bottomY),
    'still inside the work area',
  );
});

test('takes an occasional mid-walk pause of 3-8s, then continues in the same direction', () => {
  // target 0 (leftmost) / pause roll 0.1 (< 0.35 -> pause) / pause at 50% of the
  // journey / pause duration roll 0 (-> the 3s floor)
  const h = harness({ randoms: [0, 0.1, 0.5, 0] });
  h.wander.setMode('idle');
  h.advance(90_000);

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

test('gap between strolls stays within 2-5 minutes', () => {
  const { gapMinMs, gapMaxMs, tickMs } = WANDER_DEFAULTS;

  for (const gapRoll of [0, 0.5, 0.99999]) {
    // stroll 1: target fraction 0.5 / no pause / gap roll
    // stroll 2: target fraction 0   / no pause / gap roll
    const h = harness({ randoms: [0.5, 0.9, gapRoll, 0, 0.9, gapRoll] });
    h.wander.setMode('idle');
    h.advance(90_000);
    h.advance(278 * tickMs); // 1664 -> 832 arrives on tick 278

    const arrived = h.moves.length;
    const arrivalT = h.now();
    assert.equal(h.moves.at(-1).x, 832, 'reached the target');
    assert.equal(h.wander.isWandering(), false, 'stroll over, waiting for the next');
    assert.equal(h.wander.isArmed(), true, 'gap timer pending');

    h.advance(gapMinMs - 1);
    assert.equal(h.moves.length, arrived, 'no stroll sooner than 2 min');

    h.advance(gapMaxMs - gapMinMs + 1 + tickMs);
    assert.ok(h.moves.length > arrived, `stroll resumed by 5 min (gap roll ${gapRoll})`);

    const gap = h.moves[arrived].t - tickMs - arrivalT;
    assert.ok(gap >= gapMinMs && gap <= gapMaxMs, `gap ${gap}ms within 2-5 min`);
    assert.ok(
      Math.abs(gap - (gapMinMs + gapRoll * (gapMaxMs - gapMinMs))) < 1,
      'gap is deterministic from the injected random',
    );
  }
});

test('faces right when the target is to the right', () => {
  const h = harness({ startX: 0, randoms: [0.99, 0.9, 0.5] });
  h.wander.setMode('idle');
  h.advance(90_000);
  h.advance(500);

  assert.deepEqual(h.dirs(), ['right']);
  assert.equal(h.moves.at(-1).x, 30, '10 ticks x 3px to the right of x=0');
});

test('stop() cancels every timer and clears the walk state', () => {
  const h = harness({ randoms: [0, 0.9, 0.5] });
  h.wander.setMode('idle');
  h.advance(90_000);
  h.advance(500);
  assert.equal(h.moves.length, 10);

  h.wander.stop();
  assert.deepEqual(h.dirs(), ['left', null]);
  assert.equal(h.pending(), 0, 'no timers left pending');

  h.wander.setMode('idle'); // ignored after stop
  h.advance(10 * 60_000);
  assert.equal(h.moves.length, 10);
});

test('cancel() stops the current stroll and re-arms the 90s countdown', () => {
  const h = harness({ randoms: [0, 0.9, 0.5] });
  h.wander.setMode('idle');
  h.advance(90_000);
  h.advance(500); // 10 ticks
  assert.equal(h.moves.length, 10);

  h.wander.cancel();
  assert.deepEqual(h.dirs(), ['left', null], 'walk state cleared');
  assert.equal(h.wander.isWandering(), false);

  const frozen = h.moves.at(-1);
  h.advance(89_999);
  assert.equal(h.moves.length, 10, 'no movement during the fresh countdown');
  assert.deepEqual(h.moves.at(-1), frozen, 'window left where it stopped');

  h.advance(1 + WANDER_DEFAULTS.tickMs);
  assert.equal(h.moves.length, 11, 're-armed: strolls again 90s after cancel');
});

test('cancel() while not idle does not re-arm', () => {
  const h = harness({ randoms: [0, 0.9, 0.5] });
  h.wander.setMode('busy');
  h.wander.cancel();
  h.advance(30 * 60_000);
  assert.equal(h.moves.length, 0);
  assert.equal(h.wander.isArmed(), false);
});

// Reproduces module A's toggle-pin handler: it calls the wander cancel handle
// and flips the pinned flag. Wandering must survive an unpin.
test('module A pin-toggle sequence: cancel() + pin, then unpin resumes', () => {
  const h = harness({ randoms: [0, 0.9, 0.5] });
  h.wander.setMode('idle');
  h.advance(90_000);
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
