// Module L tests — the ledges she can stand on, with no child process and no
// Electron. The helper is a fake EventEmitter child whose stdout a test writes
// to by hand, the clock and the scheduler are virtual, and `toDip` divides by
// 1.5 so every physical-to-DIP conversion is visible in the numbers. Themes:
//   1. the line — anything malformed is ignored, one bad entry is dropped alone;
//   2. the geometry — DIP conversion, every exclusion, clipping, and occlusion,
//      which is the rule that decides whether a ledge is really there;
//   3. change detection — only a different list reaches a listener, however the
//      bytes were chunked;
//   4. the lifecycle — a dying helper is restarted on the backoff schedule and
//      then given up on, a healthy run forgives, and stop() kills our own child
//      through its handle and nothing ever comes back after it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  HELPER_INTERVAL_MS,
  LEDGE_DEFAULTS,
  POWERSHELL,
  SHELL_CLASSES,
  computeLedges,
  createLedgeSource,
  hwndFromBuffer,
  ledgesEqual,
  parseHelperLine,
  perchEnabled,
} from '../src/main/ledges.mjs';

// ------------------------------------------------------------------- geometry

/** Primary work area and her window, both in DIP. Her floor standing y is 676. */
const AREA = Object.freeze({ x: 0, y: 0, width: 1600, height: 1000 });
const HER = Object.freeze({ width: 260, height: 324 });
const SCALE = 1.5;

const toDip = ({ x, y, width, height }) => ({
  x: x / SCALE,
  y: y / SCALE,
  width: width / SCALE,
  height: height / SCALE,
});

/** A helper entry described in DIP `[left, top, right, bottom]`, emitted in physical px. */
function win(hwnd, [left, top, right, bottom], extra = {}) {
  return {
    hwnd,
    cls: 'Notepad',
    tool: false,
    through: false,
    l: left * SCALE,
    t: top * SCALE,
    r: right * SCALE,
    b: bottom * SCALE,
    ...extra,
  };
}

const compute = (windows, extra = {}) =>
  computeLedges({ windows, toDip, workArea: AREA, windowSize: HER, ownHwnd: null, ...extra });

/** The window every exclusion test tries to hide: a wide ledge at top 600. */
const BASE = () => win(1, [100, 600, 1100, 900]);
const BASE_LEDGE = Object.freeze({ left: 100, right: 1100, top: 600, hwnd: 1 });

/** Fully covers the row above BASE's edge, so if it survives step 2 BASE vanishes. */
const COVER = (hwnd, extra) => win(hwnd, [0, 300, 1600, 650], extra);

// ---------------------------------------------------------- parseHelperLine

test('parseHelperLine: a good line comes back normalised', () => {
  const line = JSON.stringify({
    v: 1,
    windows: [
      { hwnd: 11, cls: 'Notepad', tool: false, through: true, l: -7, t: 0, r: 900, b: 600 },
      { hwnd: 12, cls: 'X', tool: true, through: false, l: 1, t: 2, r: 3, b: 4 },
    ],
  });
  assert.deepEqual(parseHelperLine(line), {
    windows: [
      { hwnd: 11, cls: 'Notepad', tool: false, through: true, l: -7, t: 0, r: 900, b: 600 },
      { hwnd: 12, cls: 'X', tool: true, through: false, l: 1, t: 2, r: 3, b: 4 },
    ],
  });
  assert.deepEqual(parseHelperLine('{"v":1,"windows":[]}'), { windows: [] }, 'an empty desktop is a line, not an error');
  assert.deepEqual(parseHelperLine('{"v":1,"windows":[]}\r'), { windows: [] }, 'a CRLF tail is trimmed');
});

test('parseHelperLine: anything malformed is null', () => {
  for (const bad of [
    '',
    '   ',
    'not json',
    '{"v":1,"windows":[{"hwnd":1', // torn mid-line
    'null',
    '42',
    '"a string"',
    '[1,2,3]',
    '{"windows":[]}',
    '{"v":2,"windows":[]}',
    '{"v":"1","windows":[]}',
    '{"v":1}',
    '{"v":1,"windows":{}}',
    '{"v":1,"windows":"[]"}',
  ]) {
    assert.equal(parseHelperLine(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
  for (const notText of [null, undefined, 42, {}, ['{"v":1,"windows":[]}']]) {
    assert.equal(parseHelperLine(notText), null);
  }
});

test('parseHelperLine: an entry with an unusable number is dropped on its own', () => {
  const good = '{"hwnd":5,"cls":"A","tool":false,"through":false,"l":0,"t":0,"r":10,"b":10}';
  const line = `{"v":1,"windows":[${[
    '{"cls":"no hwnd","l":0,"t":0,"r":10,"b":10}',
    '{"hwnd":1,"l":null,"t":0,"r":10,"b":10}',
    '{"hwnd":2,"l":0,"t":"5","r":10,"b":10}',
    '{"hwnd":3,"l":0,"t":0,"r":1e999,"b":10}', // JSON.parse turns this into Infinity
    '{"hwnd":4,"l":0,"t":0,"r":10}',
    'null',
    '7',
    '[1,2]',
    good,
  ].join(',')}]}`;
  assert.deepEqual(parseHelperLine(line).windows.map((w) => w.hwnd), [5]);
});

test('parseHelperLine: flags must be real booleans and cls a string', () => {
  const line = '{"v":1,"windows":[{"hwnd":9,"cls":42,"tool":"true","through":1,"l":0,"t":0,"r":1,"b":1}]}';
  assert.deepEqual(parseHelperLine(line).windows[0], {
    hwnd: 9, cls: '', tool: false, through: false, l: 0, t: 0, r: 1, b: 1,
  });
});

// ------------------------------------------------------------ computeLedges

test('computeLedges: the DIP conversion is applied to every rect before any geometry', () => {
  const calls = [];
  const recording = (rect) => {
    calls.push(rect);
    return toDip(rect);
  };
  const ledges = computeLedges({
    windows: [{ hwnd: 3, cls: 'Notepad', tool: false, through: false, l: 300, t: 900, r: 1200, b: 1350 }],
    toDip: recording,
    workArea: AREA,
    windowSize: HER,
  });
  assert.deepEqual(calls, [{ x: 300, y: 900, width: 900, height: 450 }], 'toDip receives physical {x,y,width,height}');
  assert.deepEqual(ledges, [{ left: 200, right: 800, top: 600, hwnd: 3 }], 'and the ledge is in DIP');
});

test('computeLedges: values are DIP floats, never rounded', () => {
  const quarter = ({ x, y, width, height }) => ({ x: x / 1.25, y: y / 1.25, width: width / 1.25, height: height / 1.25 });
  const [ledge] = computeLedges({
    windows: [{ hwnd: 4, cls: 'A', tool: false, through: false, l: 101, t: 701, r: 1001, b: 1100 }],
    toDip: quarter,
    workArea: AREA,
    windowSize: HER,
  });
  assert.equal(ledge.left, 101 / 1.25);
  assert.equal(ledge.top, 701 / 1.25);
  assert.equal(ledge.right, 101 / 1.25 + 900 / 1.25);
});

test('computeLedges: a plain window is one ledge', () => {
  assert.deepEqual(compute([BASE()]), [BASE_LEDGE]);
});

test('computeLedges: her own window, tool windows and click-through windows are neither ledges nor occluders', () => {
  const cases = [
    ['own hwnd', (h) => win(h, [100, 600, 1100, 900]), (h) => COVER(h), { ownHwnd: 50 }],
    ['tool', (h) => win(h, [100, 600, 1100, 900], { tool: true }), (h) => COVER(h, { tool: true }), {}],
    ['through', (h) => win(h, [100, 600, 1100, 900], { through: true }), (h) => COVER(h, { through: true }), {}],
  ];
  for (const [name, asLedge, asCover, extra] of cases) {
    assert.deepEqual(compute([asLedge(50)], extra), [], `${name}: not a ledge`);
    assert.deepEqual(compute([asCover(50), BASE()], extra), [BASE_LEDGE], `${name}: does not occlude`);
  }
});

test('computeLedges: every shell class is neither a ledge nor an occluder', () => {
  assert.deepEqual([...SHELL_CLASSES].sort(), ['Progman', 'Shell_SecondaryTrayWnd', 'Shell_TrayWnd', 'WorkerW']);
  for (const cls of SHELL_CLASSES) {
    assert.deepEqual(compute([win(60, [100, 600, 1100, 900], { cls })]), [], `${cls}: not a ledge`);
    // The desktop is a full-screen window; if it occluded, nothing would ever be a ledge.
    assert.deepEqual(compute([COVER(60, { cls }), BASE()]), [BASE_LEDGE], `${cls}: does not occlude`);
  }
});

test('computeLedges: a zero-size window is dropped, before or after conversion', () => {
  // Wide enough and at a good height, so only its zero height keeps it from being a ledge.
  const flat = { hwnd: 70, cls: 'A', tool: false, through: false, l: 150, t: 900, r: 1650, b: 900 };
  assert.deepEqual(compute([flat]), []);
  assert.deepEqual(compute([{ ...flat, b: 1200 }]), [{ left: 100, right: 1100, top: 600, hwnd: 70 }], 'control');

  // Converts to nothing: the converter's answer is what counts, so a rect that
  // would otherwise cover BASE's edge neither stands nor occludes.
  const squash = (rect) => (rect.x === 0 ? { ...toDip(rect), width: 0 } : toDip(rect));
  assert.deepEqual(computeLedges({ windows: [COVER(71), BASE()], toDip: squash, workArea: AREA, windowSize: HER }), [BASE_LEDGE]);
});

test('computeLedges: a window narrower than her is no ledge, but still occludes', () => {
  assert.deepEqual(compute([win(80, [100, 600, 359, 900])]), [], '259 wide');
  assert.deepEqual(compute([win(80, [100, 600, 360, 900])]), [{ left: 100, right: 360, top: 600, hwnd: 80 }], 'exactly her width fits');
  // Narrow, above BASE in z-order, covering the row above its edge: BASE splits around it.
  assert.deepEqual(compute([win(81, [550, 500, 650, 700]), BASE()]), [
    { left: 100, right: 550, top: 600, hwnd: 1 },
    { left: 650, right: 1100, top: 600, hwnd: 1 },
  ]);
});

test('computeLedges: a window over the whole work area is never a ledge, and hides everything beneath it', () => {
  const maximized = win(90, [0, 0, 1600, 1000]);
  assert.deepEqual(compute([maximized]), []);
  assert.deepEqual(compute([maximized, BASE()]), [], 'everything below a maximized window is hidden');
  assert.deepEqual(compute([BASE(), maximized]), [BASE_LEDGE], 'but not what is above it');
  // A fullscreen window bigger than the work area (over the taskbar too) is the same.
  assert.deepEqual(compute([win(91, [-8, -8, 1608, 1100])]), []);
});

test('computeLedges: a ledge too high to keep her on screen is ignored', () => {
  assert.deepEqual(compute([win(100, [100, 323, 1100, 900])]), [], 'her head would be 1px above the work area');
  assert.deepEqual(compute([win(100, [100, 324, 1100, 900])]), [{ left: 100, right: 1100, top: 324, hwnd: 100 }]);
  // The work area need not start at 0: a taskbar on top moves the limit down.
  const lowered = { ...AREA, y: 40, height: 960 };
  assert.deepEqual(compute([win(100, [100, 340, 1100, 900])], { workArea: lowered }), []);
});

test('computeLedges: a ledge at or below the floor is the floor, and ignored', () => {
  assert.deepEqual(compute([win(110, [100, 1000, 1100, 1200])]), [], 'standing y equals the floor');
  assert.deepEqual(compute([win(110, [100, 1100, 1100, 1300])]), [], 'below the floor');
  assert.deepEqual(compute([win(110, [100, 999.5, 1100, 1200])]), [{ left: 100, right: 1100, top: 999.5, hwnd: 110 }]);
});

test('computeLedges: each ledge is clipped to the work area, then must still fit her', () => {
  assert.deepEqual(compute([win(120, [-300, 600, 500, 900])]), [{ left: 0, right: 500, top: 600, hwnd: 120 }]);
  assert.deepEqual(compute([win(121, [1200, 600, 2000, 900])]), [{ left: 1200, right: 1600, top: 600, hwnd: 121 }]);
  assert.deepEqual(compute([win(122, [-300, 600, 200, 900])]), [], 'only 200 of it is on screen');
  assert.deepEqual(compute([win(123, [1700, 600, 2600, 900])]), [], 'entirely on another monitor');
});

test('computeLedges: occlusion splits a ledge and drops the remainder too narrow for her', () => {
  // Occluder 300..700 above the edge: the left piece is 200 wide and goes.
  assert.deepEqual(compute([win(130, [300, 300, 700, 650]), BASE()]), [{ left: 700, right: 1100, top: 600, hwnd: 1 }]);
  // Two occluders leave three pieces; the 150px one in the middle is dropped.
  assert.deepEqual(compute([win(131, [400, 300, 450, 620]), win(132, [600, 300, 700, 620]), BASE()]), [
    { left: 100, right: 400, top: 600, hwnd: 1 },
    { left: 700, right: 1100, top: 600, hwnd: 1 },
  ]);
});

test('computeLedges: only windows above in z-order occlude, and only across the row above the edge', () => {
  assert.deepEqual(compute([BASE(), win(140, [300, 300, 700, 650])]), [BASE_LEDGE], 'a window below in z-order hides nothing');
  // Touching from above: its bottom is the edge, so it covers the row her feet need.
  assert.deepEqual(compute([win(141, [300, 300, 700, 600]), BASE()]), [{ left: 700, right: 1100, top: 600, hwnd: 1 }]);
  // Ending one row higher leaves that row clear.
  assert.deepEqual(compute([win(142, [300, 300, 700, 599]), BASE()]), [BASE_LEDGE]);
  // Starting at the edge covers the body of BASE, not the air above it.
  assert.deepEqual(compute([win(143, [300, 600, 500, 800]), BASE()]), [BASE_LEDGE]);
});

test('computeLedges: occlusion is half-open in x — the occluder\'s right edge is clear', () => {
  const ledges = compute([win(150, [360, 300, 700, 650]), BASE()]);
  assert.deepEqual(ledges, [
    { left: 100, right: 360, top: 600, hwnd: 1 }, // exactly her width up to the occluder's left edge
    { left: 700, right: 1100, top: 600, hwnd: 1 },
  ]);
});

test('computeLedges: results are sorted by top, then left', () => {
  const ledges = compute([
    win(160, [900, 700, 1500, 950]),
    win(161, [100, 400, 500, 500]),
    win(162, [100, 700, 500, 950]),
  ]);
  assert.deepEqual(ledges.map((l) => l.hwnd), [161, 162, 160]);
});

test('computeLedges: unusable inputs mean no ledges, never a guess or a throw', () => {
  assert.deepEqual(computeLedges({ windows: [BASE()], workArea: AREA, windowSize: HER }), [], 'no toDip');
  assert.deepEqual(compute([BASE()], { workArea: null }), []);
  assert.deepEqual(compute([BASE()], { workArea: { x: 0, y: 0, width: 0, height: 1000 } }), []);
  assert.deepEqual(compute([BASE()], { windowSize: { width: Number.NaN, height: 324 } }), []);
  assert.deepEqual(compute('nope'), []);
  assert.deepEqual(computeLedges(), []);
  // A converter that throws on one window costs that window and nothing else.
  const picky = (rect) => {
    if (rect.x === 0) throw new Error('no display');
    return toDip(rect);
  };
  assert.deepEqual(computeLedges({ windows: [COVER(170), BASE()], toDip: picky, workArea: AREA, windowSize: HER }), [BASE_LEDGE]);
});

// ------------------------------------------------------------- small helpers

test('ledgesEqual compares every field in order', () => {
  const a = [{ left: 1, right: 300, top: 400, hwnd: 2 }, { left: 5, right: 400, top: 500, hwnd: 3 }];
  assert.equal(ledgesEqual(a, a.map((l) => ({ ...l }))), true);
  assert.equal(ledgesEqual(a, [...a].reverse()), false);
  assert.equal(ledgesEqual(a, a.slice(0, 1)), false);
  for (const key of ['left', 'right', 'top', 'hwnd']) {
    assert.equal(ledgesEqual(a, [{ ...a[0], [key]: a[0][key] + 0.5 }, a[1]]), false, key);
  }
  assert.equal(ledgesEqual([], []), true);
  assert.equal(ledgesEqual(null, []), true, 'a non-array reads as empty');
  assert.equal(ledgesEqual(undefined, a), false);
});

test('perchEnabled: off only for the off spellings; unset and blank are on', () => {
  for (const off of ['0', 'false', 'FALSE', ' no ', 'off', 'Off', 'never', '\tOFF\n']) {
    assert.equal(perchEnabled(off), false, JSON.stringify(off));
  }
  for (const on of [undefined, null, '', '   ', '1', 'true', 'yes', 'on', 'sometimes']) {
    assert.equal(perchEnabled(on), true, JSON.stringify(on));
  }
});

test('hwndFromBuffer reads the native handle Buffer, 8 or 4 bytes', () => {
  const eight = Buffer.alloc(8);
  eight.writeBigUInt64LE(0x1a2b3cn, 0);
  assert.equal(hwndFromBuffer(eight), 0x1a2b3c);
  const four = Buffer.alloc(4);
  four.writeUInt32LE(0x00c0ffee, 0);
  assert.equal(hwndFromBuffer(four), 0x00c0ffee);
  for (const bad of [Buffer.alloc(2), Buffer.alloc(0), null, undefined, 1234, 'abcd', new Uint8Array(8), {}]) {
    assert.equal(hwndFromBuffer(bad), null);
  }
});

// ------------------------------------------------------------ the lifecycle

/** A child process with nothing behind it. A test writes its stdout and decides when it dies. */
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.kills = 0;
  }

  kill() {
    this.kills += 1;
    return true;
  }

  write(text) {
    this.stdout.emit('data', Buffer.from(text, 'utf8'));
  }

  send(windows) {
    this.write(`${JSON.stringify({ v: 1, windows })}\n`);
  }

  die(code = 1) {
    this.emit('exit', code, null);
  }
}

const SCRIPT = 'C:\\pet\\src\\main\\ledges.ps1';

function harness(overrides = {}) {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const schedule = (fn, ms) => {
    const id = nextId;
    nextId += 1;
    timers.set(id, { fn, at: now + ms, ms });
    return () => {
      timers.delete(id);
    };
  };
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      let pick = null;
      for (const [id, t] of timers) {
        if (t.at <= end && (!pick || t.at < pick.t.at)) pick = { id, t };
      }
      if (!pick) break;
      timers.delete(pick.id);
      now = pick.t.at;
      pick.t.fn();
    }
    now = end;
  }

  const spawns = [];
  const spawn = (cmd, args, opts) => {
    const child = new FakeChild();
    spawns.push({ cmd, args, opts, child });
    return child;
  };
  const logs = [];
  const state = { workArea: { ...AREA }, size: { ...HER }, ownHwnd: null };
  const source = createLedgeSource({
    spawn,
    scriptPath: SCRIPT,
    parentPid: 4242,
    toDip,
    getWorkArea: () => state.workArea,
    getWindowSize: () => state.size,
    getOwnHwnd: () => state.ownHwnd,
    schedule,
    clock: { now: () => now },
    log: { warn: (m) => logs.push(m), info: (m) => logs.push(m) },
    ...overrides,
  });
  const changes = [];
  source.onChange((list) => changes.push(list));
  return {
    source,
    spawns,
    logs,
    changes,
    state,
    timers,
    advance,
    child: () => spawns.at(-1).child,
    /** Delays of every pending restart, in schedule order. */
    pendingDelays: () => [...timers.values()].map((t) => t.ms),
  };
}

test('createLedgeSource: start() launches the 5.1 helper with the contract arguments and returns at once', () => {
  const h = harness();
  assert.equal(h.source.start(), undefined);
  assert.equal(h.spawns.length, 1);
  const [{ cmd, args, opts }] = h.spawns;
  assert.equal(cmd, POWERSHELL);
  assert.equal(cmd, 'powershell.exe');
  assert.deepEqual(args, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT,
    '-ParentPid', '4242', '-IntervalMs', String(HELPER_INTERVAL_MS),
  ]);
  assert.deepEqual(opts, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.deepEqual(h.source.current(), [], 'nothing known before the first line');
  assert.ok(Object.isFrozen(h.source.current()));

  h.source.start();
  assert.equal(h.spawns.length, 1, 'a second start while running is a no-op');
});

test('createLedgeSource: without a parent pid the flag is left off', () => {
  const h = harness({ parentPid: null });
  h.source.start();
  assert.equal(h.spawns[0].args.includes('-ParentPid'), false);
});

test('createLedgeSource: stderr is drained, so a chatty helper can never block on a full pipe', () => {
  const h = harness();
  h.source.start();
  assert.ok(h.child().stderr.listenerCount('data') >= 1);
});

test('createLedgeSource: a line becomes DIP ledges and one onChange', () => {
  const h = harness();
  h.source.start();
  h.child().send([BASE()]);
  assert.deepEqual(h.source.current(), [BASE_LEDGE]);
  assert.equal(h.changes.length, 1);
  assert.deepEqual(h.changes[0], [BASE_LEDGE]);
  assert.ok(Object.isFrozen(h.source.current()));
  assert.ok(Object.isFrozen(h.source.current()[0]));
});

test('createLedgeSource: only a changed list is emitted', () => {
  const h = harness();
  h.source.start();
  h.child().send([BASE()]);
  h.child().send([BASE()]);
  assert.equal(h.changes.length, 1, 'an identical line is not news');
  // A different line with the same ledges is not news either: a tooltip came and went.
  h.child().send([win(9, [0, 0, 50, 20], { tool: true }), BASE()]);
  assert.equal(h.changes.length, 1);
  h.child().send([win(2, [100, 500, 900, 800])]);
  assert.equal(h.changes.length, 2);
  assert.deepEqual(h.source.current(), [{ left: 100, right: 900, top: 500, hwnd: 2 }]);
});

test('createLedgeSource: partial chunks are reassembled, and several lines in one chunk all count', () => {
  const h = harness();
  h.source.start();
  const line = `${JSON.stringify({ v: 1, windows: [BASE()] })}\r\n`;
  h.child().write(line.slice(0, 7));
  h.child().write(line.slice(7, 40));
  assert.equal(h.changes.length, 0, 'nothing until the newline');
  h.child().stdout.emit('data', line.slice(40)); // a string chunk works too
  assert.deepEqual(h.source.current(), [BASE_LEDGE]);

  const second = JSON.stringify({ v: 1, windows: [win(2, [100, 500, 900, 800])] });
  const third = JSON.stringify({ v: 1, windows: [] });
  h.child().write(`${second}\n${third}\n`);
  assert.equal(h.changes.length, 3);
  assert.deepEqual(h.source.current(), []);
});

test('createLedgeSource: a malformed line is ignored and the last good list stands', () => {
  const h = harness();
  h.source.start();
  h.child().send([BASE()]);
  h.child().write('garbage\n{"v":9,"windows":[]}\n\n{"v":1,"windows":[{"hwnd"\n');
  assert.equal(h.changes.length, 1);
  assert.deepEqual(h.source.current(), [BASE_LEDGE]);
});

test('createLedgeSource: her own hwnd is dropped, and an unreadable screen means no ledges', () => {
  const h = harness();
  h.state.ownHwnd = 1;
  h.source.start();
  h.child().send([BASE()]);
  assert.deepEqual(h.source.current(), []);

  const g = harness({ getWorkArea: () => { throw new Error('no display'); } });
  g.source.start();
  g.child().send([BASE()]);
  assert.deepEqual(g.source.current(), []);
});

test('createLedgeSource: a throwing listener is logged and does not stop the others', () => {
  const h = harness();
  const seen = [];
  h.source.onChange(() => { throw new Error('boom'); });
  h.source.onChange((list) => seen.push(list.length));
  h.source.start();
  assert.doesNotThrow(() => h.child().send([BASE()]));
  assert.deepEqual(seen, [1]);
  assert.equal(h.changes.length, 1);
  assert.ok(h.logs.some((m) => /listener threw/.test(m)));
});

test('createLedgeSource: onChange returns an unsubscribe', () => {
  const h = harness();
  const seen = [];
  const off = h.source.onChange(() => seen.push(1));
  h.source.start();
  h.child().send([BASE()]);
  off();
  h.child().send([]);
  assert.deepEqual(seen, [1]);
  assert.equal(h.changes.length, 2);
});

test('createLedgeSource: a death clears the ledges and restarts on the backoff schedule, then gives up', () => {
  const h = harness();
  h.source.start();
  h.child().send([BASE()]);
  assert.equal(h.changes.length, 1);

  h.child().die();
  assert.deepEqual(h.source.current(), [], 'a dead helper knows nothing about the screen');
  assert.equal(h.changes.length, 2, 'and the clearing is emitted');
  assert.deepEqual(h.changes[1], []);

  // Default schedule: 1s, 2s, 4s, 8s, and the fifth consecutive death disables.
  for (const delay of [1000, 2000, 4000]) {
    assert.deepEqual(h.pendingDelays(), [delay]);
    const before = h.spawns.length;
    h.advance(delay - 1);
    assert.equal(h.spawns.length, before, `not before ${delay}ms`);
    h.advance(1);
    assert.equal(h.spawns.length, before + 1, `respawned at ${delay}ms`);
    h.child().die();
  }
  assert.deepEqual(h.pendingDelays(), [8000]);
  h.advance(8000);
  assert.equal(h.spawns.length, 5);
  assert.equal(h.source.isDisabled(), false);
  h.child().die();

  assert.equal(h.source.isDisabled(), true);
  assert.equal(h.timers.size, 0, 'no restart pending');
  h.advance(10 * 60_000);
  assert.equal(h.spawns.length, 5, 'no more spawns, ever');
  h.source.start();
  assert.equal(h.spawns.length, 5, 'not even when asked');
  assert.deepEqual(h.source.current(), []);
  assert.equal(h.logs.filter((m) => /perching is off/.test(m)).length, 1, 'one log line says so');
  assert.equal(h.changes.length, 2, 'deaths with nothing known emit nothing');
});

test('createLedgeSource: the backoff index clamps to the last entry', () => {
  const h = harness({ maxFailures: 8 });
  h.source.start();
  const delays = [];
  for (let i = 0; i < 7; i += 1) {
    h.child().die();
    const [delay] = h.pendingDelays();
    delays.push(delay);
    h.advance(delay);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 16000, 16000]);
  h.child().die();
  assert.equal(h.source.isDisabled(), true);
  assert.equal(h.spawns.length, 8);
  assert.deepEqual(LEDGE_DEFAULTS.backoffMs, [1000, 2000, 4000, 8000, 16000]);
});

test('createLedgeSource: a helper that stayed up for healthyMs resets the failure count', () => {
  const h = harness();
  h.source.start();
  for (const delay of [1000, 2000, 4000]) {
    h.child().die();
    h.advance(delay);
  }
  // Fourth child: just short of healthy, so it still counts as the fourth failure.
  h.advance(59_999);
  h.child().die();
  assert.deepEqual(h.pendingDelays(), [8000]);
  h.advance(8000);
  // Fifth child: healthy, so its death is the first of a new run, not the fifth.
  h.advance(60_000);
  h.child().die();
  assert.equal(h.source.isDisabled(), false);
  assert.deepEqual(h.pendingDelays(), [1000]);
  // And it takes five fresh consecutive deaths to disable.
  for (const delay of [1000, 2000, 4000, 8000]) {
    h.advance(delay);
    h.child().die();
  }
  assert.equal(h.source.isDisabled(), true);
});

test('createLedgeSource: exit and error from the same child count once', () => {
  const h = harness();
  h.source.start();
  const first = h.child();
  first.emit('error', Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }));
  first.die();
  assert.deepEqual(h.pendingDelays(), [1000]);
  h.advance(1000);
  h.child().die();
  assert.deepEqual(h.pendingDelays(), [2000], 'the second child is the second failure, not the third');
  assert.ok(h.logs.some((m) => /ENOENT/.test(m)));
});

test('createLedgeSource: the death log carries the helper\'s stderr', () => {
  const h = harness();
  h.source.start();
  h.child().stderr.emit('data', Buffer.from('Add-Type : Cannot add type.\r\n  At line 37\r\n'));
  h.child().die(1);
  assert.ok(h.logs.some((m) => /code 1/.test(m) && /Add-Type : Cannot add type\. At line 37/.test(m)));
});

test('createLedgeSource: a spawn that throws is a failure, not an exception', () => {
  let calls = 0;
  const h = harness({
    spawn: () => {
      calls += 1;
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    },
  });
  assert.doesNotThrow(() => h.source.start());
  assert.equal(calls, 1);
  assert.deepEqual(h.pendingDelays(), [1000]);
  for (const delay of [1000, 2000, 4000, 8000]) h.advance(delay);
  assert.equal(calls, 5);
  assert.equal(h.source.isDisabled(), true);
});

test('createLedgeSource: lines from a child that already died are ignored', () => {
  const h = harness();
  h.source.start();
  const dead = h.child();
  dead.die();
  dead.send([BASE()]);
  assert.deepEqual(h.source.current(), []);
  assert.equal(h.changes.length, 0);
});

test('createLedgeSource: enabled:false never spawns', () => {
  const h = harness({ enabled: false });
  assert.equal(h.source.isDisabled(), true);
  h.source.start();
  h.advance(10 * 60_000);
  assert.equal(h.spawns.length, 0);
  assert.deepEqual(h.source.current(), []);
  assert.equal(h.source.isDisabled(), true);
});

test('createLedgeSource: stop() kills our child by its handle and nothing comes back', () => {
  const h = harness();
  h.source.start();
  const child = h.child();
  child.send([BASE()]);
  assert.equal(h.changes.length, 1);

  h.source.stop();
  assert.equal(child.kills, 1, 'child.kill() on the handle we spawned');
  assert.deepEqual(h.source.current(), []);
  child.send([win(2, [100, 500, 900, 800])]); // a line in flight when it was killed
  child.die(null); // and the exit that kill() causes
  assert.equal(h.changes.length, 1, 'listeners are cleared');
  h.advance(10 * 60_000);
  assert.equal(h.spawns.length, 1, 'never restarted');
  h.source.start();
  assert.equal(h.spawns.length, 1, 'stop is final');

  h.source.stop();
  assert.equal(child.kills, 1, 'stop is idempotent');
  assert.equal(h.logs.length, 0, 'our own kill is not a failure');
});

test('createLedgeSource: stop() cancels a pending restart', () => {
  const h = harness();
  h.source.start();
  h.child().die();
  assert.equal(h.timers.size, 1);
  h.source.stop();
  assert.equal(h.timers.size, 0);
  h.advance(10 * 60_000);
  assert.equal(h.spawns.length, 1);
  assert.deepEqual(h.source.current(), []);
});

test('createLedgeSource: a listener that stops the source mid-emit ends the emit', () => {
  const h = harness();
  const after = [];
  h.source.onChange(() => h.source.stop());
  h.source.onChange(() => after.push(1));
  h.source.start();
  h.child().send([BASE()]);
  assert.deepEqual(after, []);
  assert.equal(h.child().kills, 1);
  assert.deepEqual(h.source.current(), []);
});

// ---------------------------------------------------------------- composition
//
// The promise the owner relies on: GANYU_PERCH=0, and a helper that never comes
// up at all, are both *exactly* today's floor-only pet. Proven end to end — a
// real ledge source feeding a real createWander — by comparing every
// moveWindow, walk and airborne callback against a wander built with no
// getLedges at all.

import { createWander } from '../src/main/wander.mjs';

function wanderTrace(makeGetLedges) {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const schedule = (fn, ms) => {
    const id = nextId++;
    timers.set(id, { fn, at: now + ms });
    return () => timers.delete(id);
  };
  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      let pick = null;
      for (const [id, t] of timers) {
        if (t.at <= end && (!pick || t.at < pick.t.at || (t.at === pick.t.at && id < pick.id))) pick = { id, t };
      }
      if (!pick) break;
      timers.delete(pick.id);
      now = pick.t.at;
      pick.t.fn();
    }
    now = end;
  };
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const trace = [];
  const clock = { now: () => now };
  const getLedges = makeGetLedges({ schedule, clock, advance });
  const w = createWander({
    clock,
    schedule,
    random,
    moveWindow: (x, y) => trace.push(['move', x, y]),
    getWorkArea: () => AREA,
    getWindowSize: () => ({ width: 256, height: 320 }),
    onWalkState: (s) => trace.push(['walk', s && s.dir]),
    onAirborne: (v) => trace.push(['air', v]),
    ...(getLedges ? { getLedges } : {}),
  });
  w.containNow();
  w.setMode('idle');
  advance(60_000); // arm + a stroll
  w.grab();
  w.moveTo(300, 100);
  w.release({ vx: 900, vy: -300 }); // a throw: flight, wall, floor, skid
  advance(10_000);
  w.setMode('waiting');
  advance(5_000);
  w.setMode('busy');
  advance(180_000);
  w.stop();
  return trace;
}

test('composition: GANYU_PERCH=0 and a helper that never starts are both the floor-only pet', () => {
  const baseline = wanderTrace(() => null);
  assert.ok(baseline.length > 50, 'scenario must actually move her');

  const disabled = wanderTrace(({ schedule, clock }) => {
    const src = createLedgeSource({
      spawn: () => { throw new Error('must never spawn'); },
      scriptPath: SCRIPT, toDip, getWorkArea: () => AREA, getWindowSize: () => HER,
      schedule, clock, enabled: false, log: { warn() {}, info() {} },
    });
    src.start();
    assert.equal(src.isDisabled(), true);
    return () => src.current();
  });
  assert.deepEqual(disabled, baseline);

  // spawn throws every time → restarted on the backoff, then given up on. The
  // wander scenario runs across the whole failure sequence and after it.
  let spawnCalls = 0;
  let src;
  const neverStarts = wanderTrace(({ schedule, clock }) => {
    src = createLedgeSource({
      spawn: () => { spawnCalls += 1; throw new Error('ENOENT powershell.exe'); },
      scriptPath: SCRIPT, toDip, getWorkArea: () => AREA, getWindowSize: () => HER,
      schedule, clock, log: { warn() {}, info() {} },
    });
    src.start();
    return () => src.current();
  });
  assert.deepEqual(neverStarts, baseline);
  assert.equal(src.isDisabled(), true, 'repeated failure turns perching off');
  assert.equal(spawnCalls, LEDGE_DEFAULTS.maxFailures ?? 5);
});
