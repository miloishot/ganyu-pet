// Module L — ledges: the places she can stand that are not the floor.
//
// The top edge of another window is a ledge. A fall can land on one, a stroll
// can walk along it, and when the window under her is minimized, moved or
// closed, she drops to whatever is below. This module answers only "where are
// the ledges right now"; module E (wander.mjs) owns every pixel of motion and
// re-validates each ledge against its own bounds on every tick.
//
// **Why a helper process.** Electron has no API that lists *other* programs'
// windows, and this repo takes no native dependencies. PowerShell 5.1 ships on
// every Windows and can P/Invoke user32/dwmapi through `Add-Type`, so ledges.ps1
// is a small read-only poller and this file is everything around it. The
// helper is `powershell.exe`, never `pwsh`, for the same reason voice.mjs
// gives: 5.1 is the one that is always there.
//
// **Why the helper speaks only on change.** It polls at 4 Hz but writes a line
// only when the line differs from the last one it wrote, so with nothing moving
// on screen the main process does no work at all. That only holds if HER window
// is left out of the stream — her rect changes on every stroll tick, and
// including it would turn per-change output back into per-poll output — so the
// helper drops every window owned by the Electron pid. (She would otherwise
// also occlude her own ledge.) `getOwnHwnd` here is a second net under that.
//
// **Why the DWM extended frame bounds, not GetWindowRect.** On Windows 10/11
// GetWindowRect includes the invisible ~7px resize border. A ledge taken from
// it sits 7px above the visible edge, and she stands in mid-air above every
// window on the screen. The extended frame bounds are the edge you can see.
//
// **Why DIP conversion happens here.** The helper reports physical pixels: it
// does not know the per-monitor scale and should not have to. Electron does,
// so `toDip` is injected (production: `screen.screenToDipRect(null, rect)`) and
// every rect is converted once, before any geometry runs.
//
// **Failure means no ledges, never an exception.** An empty list is exactly
// today's behaviour — the floor and nothing else — so every failure here (a
// malformed line, a getter that throws, a helper that dies) resolves to `[]`.
// A helper that keeps dying is restarted with backoff and then given up on for
// the rest of the run: a pet that cannot perch is still a pet, and a respawn
// loop of PowerShell processes is not something to leave running on his desk.
//
// Every side effect — the spawn, the clock, the scheduler, the screen — is
// injected, so test/ledges.test.mjs runs with no child process and no Electron.

import { StringDecoder } from 'node:string_decoder';

/** 5.1, not 7.x: see the header. */
export const POWERSHELL = 'powershell.exe';

/** The helper's poll interval. 4 Hz is the ceiling ledges.ps1 enforces itself. */
export const HELPER_INTERVAL_MS = 250;

/**
 * Restart policy for a helper that dies. Five consecutive deaths and perching is
 * off for the run; the backoff is indexed by how many have happened so far, so
 * the default schedule is 1s, 2s, 4s, 8s and then giving up. A helper that
 * stayed up for `healthyMs` is not part of a crash loop, so its death starts the
 * count again.
 */
export const LEDGE_DEFAULTS = Object.freeze({
  maxFailures: 5,
  backoffMs: Object.freeze([1000, 2000, 4000, 8000, 16000]),
  healthyMs: 60_000,
});

/**
 * Window classes that are part of the shell rather than windows: the desktop
 * (`Progman`, and the `WorkerW` that hosts the wallpaper behind it) and the
 * taskbars. The desktop covers the whole screen and would occlude every ledge;
 * the taskbar is outside the work area and is the floor's business anyway.
 */
export const SHELL_CLASSES = Object.freeze([
  'Progman',
  'WorkerW',
  'Shell_TrayWnd',
  'Shell_SecondaryTrayWnd',
]);
const SHELL = new Set(SHELL_CLASSES);

/** The protocol version ledges.ps1 writes. A line carrying any other is ignored. */
const LINE_VERSION = 1;

/** How much of the helper's stderr is kept for the log line when it dies. */
const STDERR_TAIL_CHARS = 600;

const EMPTY = Object.freeze([]);

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// ---------------------------------------------------------------- the pure half

/** One window from the helper, or null when any of its numbers is unusable. */
function windowOf(entry) {
  if (!isObject(entry)) return null;
  const { hwnd, l, t, r, b } = entry;
  if (![hwnd, l, t, r, b].every(Number.isFinite)) return null;
  return {
    hwnd,
    cls: typeof entry.cls === 'string' ? entry.cls : '',
    tool: entry.tool === true,
    through: entry.through === true,
    l,
    t,
    r,
    b,
  };
}

/**
 * `parseHelperLine(line)` -> `{windows}` | null
 *
 * Null for anything that is not a version-1 line with a `windows` array. Inside
 * a good line, an entry with a missing or non-finite number is dropped on its
 * own rather than poisoning the rest — one odd window must not cost her every
 * ledge on the screen. (JSON has no NaN, but `1e999` parses to Infinity.)
 */
export function parseHelperLine(line) {
  if (typeof line !== 'string') return null;
  const text = line.trim();
  if (text === '') return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(data) || data.v !== LINE_VERSION || !Array.isArray(data.windows)) return null;
  const windows = [];
  for (const entry of data.windows) {
    const win = windowOf(entry);
    if (win) windows.push(win);
  }
  return { windows };
}

/** `{x, y, width, height}` -> edges, or null when it cannot be a work area. */
function areaOf(workArea) {
  const { x, y, width, height } = workArea ?? {};
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { left: x, top: y, right: x + width, bottom: y + height };
}

/** Her window's outer size, or null when it is not a size. */
function sizeOf(windowSize) {
  const { width, height } = windowSize ?? {};
  if (![width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * One helper rect, physical px, converted to DIP edges. Null when it is empty
 * before or after conversion, or when the converter fails on it — a window we
 * cannot place is a window we do not reason about at all.
 */
function dipRectOf(win, toDip) {
  if (win.r <= win.l || win.b <= win.t) return null;
  let d;
  try {
    d = toDip({ x: win.l, y: win.t, width: win.r - win.l, height: win.b - win.t });
  } catch {
    return null;
  }
  const { x, y, width, height } = d ?? {};
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { hwnd: win.hwnd, left: x, top: y, right: x + width, bottom: y + height };
}

/**
 * Whether a window's top edge may be a ledge at all, before occlusion. Every
 * window that fails this still occludes the ones below it — being a bad ledge
 * does not make a window transparent.
 */
function isCandidate(win, area, her) {
  // Covers the whole work area: a maximized or fullscreen window. Its top edge
  // is the top of the screen, and standing on it would put her off-screen.
  if (win.left <= area.left && win.top <= area.top && win.right >= area.right && win.bottom >= area.bottom) {
    return false;
  }
  if (win.right - win.left < her.width) return false; // her feet would overhang both ends
  const standY = win.top - her.height;
  if (standY < area.top) return false; // her head would be above the work area
  // Not strictly above the floor: a ledge at or below the floor is the floor.
  return standY < area.bottom - her.height;
}

/**
 * `[left, right]` segments minus the half-open interval `[a, b)`. Pieces of
 * zero width can come out of this; the width filter that follows drops them.
 */
function subtract(segments, a, b) {
  const out = [];
  for (const [left, right] of segments) {
    if (b <= left || a >= right) {
      out.push([left, right]);
      continue;
    }
    if (a > left) out.push([left, a]);
    if (b < right) out.push([b, right]);
  }
  return out;
}

/**
 * `computeLedges({windows, toDip, workArea, windowSize, ownHwnd})` -> `Ledge[]`
 *
 * `windows` is the helper's list, top of the z-order first. A Ledge is
 * `{left, right, top, hwnd}` in DIP, unrounded: she stands at window-y
 * `top - windowHeight` and fits at window-x `x` iff `left <= x <= right - width`.
 *
 * **Occlusion.** A point of an edge counts only if no window *above* it in the
 * z-order covers the pixel row just above the edge — that row is where her feet
 * go, so a window there would have her standing inside it. "Above" means every
 * earlier window that is a real window at all (step 2), including the ones that
 * can never be a ledge themselves: a maximized window above everything hides
 * every ledge beneath it, which is the truth of what is on the screen.
 *
 * No `toDip`, no usable work area or no usable size: `[]`, not a guess. A ledge
 * in the wrong coordinate space is worse than none — she would stand in the air.
 */
export function computeLedges({ windows, toDip, workArea, windowSize, ownHwnd = null } = {}) {
  if (!Array.isArray(windows) || typeof toDip !== 'function') return [];
  const area = areaOf(workArea);
  const her = sizeOf(windowSize);
  if (!area || !her) return [];

  // Step 2: what is a window at all. Everything dropped here neither holds her
  // up nor hides anything — her own window, tool windows (tooltips, floating
  // palettes), click-through overlays, and the shell.
  const real = [];
  for (const win of windows) {
    if (!isObject(win)) continue;
    if (ownHwnd != null && win.hwnd === ownHwnd) continue;
    if (win.tool || win.through || SHELL.has(win.cls)) continue;
    const rect = dipRectOf(win, toDip);
    if (rect) real.push(rect);
  }

  const ledges = [];
  real.forEach((win, index) => {
    if (!isCandidate(win, area, her)) return;
    // Clip to the work area first: a window half off the screen has only its
    // on-screen part to offer, and that part may be too narrow for her.
    let segments = [[Math.max(win.left, area.left), Math.min(win.right, area.right)]];
    const above = win.top - 1;
    for (let j = 0; j < index && segments.length > 0; j += 1) {
      const occ = real[j];
      if (occ.top <= above && above < occ.bottom) segments = subtract(segments, occ.left, occ.right);
    }
    for (const [left, right] of segments) {
      // Her whole footprint must fit, so a sliver between two occluders is not a ledge.
      if (right - left >= her.width) ledges.push({ left, right, top: win.top, hwnd: win.hwnd });
    }
  });

  return ledges.sort((a, b) => a.top - b.top || a.left - b.left);
}

/** Same ledges in the same order. Change detection, so a non-array is just empty. */
export function ledgesEqual(a, b) {
  const x = Array.isArray(a) ? a : EMPTY;
  const y = Array.isArray(b) ? b : EMPTY;
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i += 1) {
    const p = x[i];
    const q = y[i];
    if (p === q) continue;
    if (!p || !q || p.left !== q.left || p.right !== q.right || p.top !== q.top || p.hwnd !== q.hwnd) {
      return false;
    }
  }
  return true;
}

/**
 * `GANYU_PERCH` — whether she may stand on windows. **Default on**, and off by
 * the same spellings brain.mjs uses for its boolean keys, with one difference
 * on purpose: brain's set counts a blank value as off, and here a blank value
 * is on. A key he has not given a value is a key he has not turned off.
 */
const PERCH_OFF = new Set(['0', 'false', 'no', 'off', 'never']);
export const perchEnabled = (value) =>
  value == null || !PERCH_OFF.has(String(value).trim().toLowerCase());

/**
 * `win.getNativeWindowHandle()` -> hwnd as a number, or null.
 *
 * The handle is a Buffer holding the HWND in machine byte order: eight bytes on
 * 64-bit, four on 32-bit. An HWND only ever uses the low 32 bits, so the Number
 * conversion loses nothing, and it then compares equal to the helper's `hwnd`.
 */
export function hwndFromBuffer(buf) {
  if (!Buffer.isBuffer(buf)) return null;
  if (buf.length >= 8) return Number(buf.readBigUInt64LE(0));
  if (buf.length >= 4) return buf.readUInt32LE(0);
  return null;
}

// --------------------------------------------------------------- the lifecycle

/** `schedule` returns a cancel function, an object with `.cancel()`, or a raw timer. */
function cancelHandle(handle) {
  if (!handle) return;
  if (typeof handle === 'function') handle();
  else if (typeof handle.cancel === 'function') handle.cancel();
  else clearTimeout(handle);
}

const defaultSchedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

/** index.mjs passes a clock that is both callable and has `.now`; accept either. */
function nowFrom(clock) {
  if (typeof clock?.now === 'function') return () => clock.now();
  if (typeof clock === 'function') return () => clock();
  return () => Date.now();
}

/**
 * createLedgeSource({spawn, scriptPath, parentPid, toDip, getWorkArea,
 *   getWindowSize, getOwnHwnd, schedule, enabled, maxFailures, backoffMs,
 *   healthyMs, clock, log})
 *   -> {start(), stop(), current(), onChange(fn) -> unsubscribe, isDisabled()}
 *
 * `start()` launches the helper and returns at once. Nothing at startup waits
 * on it: until its first line arrives `current()` is `[]`, which is the floor
 * and nothing else — exactly what she had before this module existed.
 *
 * Every line is parsed, turned into ledges with the work area and her size as
 * they are *now*, and compared with the last list; only a different list is
 * stored and handed to the listeners. Production's listener is
 * `wander.containNow()`, which is what makes her fall the moment the window
 * under her goes away.
 *
 * `stop()` kills the helper through the handle of the process we spawned —
 * `child.kill()` — and nothing else. Never by image name: he runs other
 * PowerShell windows, and killing `powershell.exe` by name would take them too.
 */
export function createLedgeSource({
  spawn,
  scriptPath,
  parentPid = null,
  toDip,
  getWorkArea,
  getWindowSize,
  getOwnHwnd = null,
  schedule = defaultSchedule,
  enabled = true,
  maxFailures = LEDGE_DEFAULTS.maxFailures,
  backoffMs = LEDGE_DEFAULTS.backoffMs,
  healthyMs = LEDGE_DEFAULTS.healthyMs,
  clock = null,
  log = null,
} = {}) {
  const now = nowFrom(clock);
  const delays = Array.isArray(backoffMs) && backoffMs.length > 0 ? backoffMs : LEDGE_DEFAULTS.backoffMs;

  let disabled = !enabled;
  let stopped = false;
  let child = null; // the helper we are listening to, or null
  let startedAt = 0;
  let failures = 0; // consecutive deaths; a healthy run resets it
  let restartTimer = null;
  let ledges = EMPTY;
  const listeners = new Set();

  const say = (level, message) => {
    try {
      log?.[level]?.(`[ganyu][perch] ${message}`);
    } catch {
      /* a logger that throws is not a reason to stop perching */
    }
  };

  /** An injected getter's answer, or null if it is missing or throws. */
  const read = (fn) => {
    if (typeof fn !== 'function') return null;
    try {
      return fn();
    } catch {
      return null;
    }
  };

  function publish(next) {
    if (ledgesEqual(next, ledges)) return;
    ledges = next.length > 0 ? Object.freeze(next.map((ledge) => Object.freeze({ ...ledge }))) : EMPTY;
    // A copy, so a listener that unsubscribes itself does not skip its neighbour.
    for (const fn of [...listeners]) {
      if (stopped) break; // a listener stopped the source: the rest were cleared
      try {
        fn(ledges);
      } catch (err) {
        say('warn', `a ledge listener threw (${err?.name ?? 'error'})`);
      }
    }
  }

  function handleLine(line) {
    const parsed = parseHelperLine(line);
    if (!parsed) return; // a stray or torn line is not news about the screen
    const ownHwnd = read(getOwnHwnd);
    publish(computeLedges({
      windows: parsed.windows,
      toDip,
      workArea: read(getWorkArea),
      windowSize: read(getWindowSize),
      ownHwnd: Number.isFinite(ownHwnd) ? ownHwnd : null,
    }));
  }

  function helperArgs() {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', String(scriptPath)];
    // Optional in the helper; without it her own window comes through and
    // `getOwnHwnd` is the only thing that drops it.
    if (Number.isInteger(parentPid) && parentPid > 0) args.push('-ParentPid', String(parentPid));
    args.push('-IntervalMs', String(HELPER_INTERVAL_MS));
    return args;
  }

  /**
   * One death. Counted once per child however many of `exit`/`error` it fires,
   * because Node documents that either, or both, may arrive.
   */
  function failed(reason) {
    if (now() - startedAt >= healthyMs) failures = 0;
    failures += 1;
    publish(EMPTY); // the ledges she knew about are no longer known to be there
    if (stopped) return; // a listener of that publish may have stopped us
    if (failures >= maxFailures) {
      disabled = true;
      say('warn', `the ledge helper failed ${failures} times in a row (last: ${reason}); perching is off for the rest of this run`);
      return;
    }
    const delay = delays[Math.min(failures - 1, delays.length - 1)];
    say('warn', `the ledge helper ${reason}; restarting it in ${delay}ms`);
    restartTimer = schedule(() => {
      restartTimer = null;
      launch();
    }, delay);
  }

  function attach(proc) {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let stderrTail = '';

    const died = (reason) => {
      if (proc !== child) return; // stale: already counted, or we stopped it
      child = null;
      const tail = stderrTail.replace(/\s+/g, ' ').trim();
      failed(tail ? `${reason}: ${tail}` : reason);
    };

    proc.stdout?.on?.('data', (chunk) => {
      if (proc !== child) return;
      pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let nl = pending.indexOf('\n');
      while (nl !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        handleLine(line);
        if (proc !== child) return; // a listener stopped the source mid-chunk
        nl = pending.indexOf('\n');
      }
    });
    proc.stdout?.on?.('error', () => {}); // the exit event is the one that counts
    // Drained, not ignored: an unread stderr pipe fills up and blocks the helper
    // mid-write, which looks exactly like a helper with nothing to say.
    proc.stderr?.on?.('data', (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_CHARS);
    });
    proc.stderr?.on?.('error', () => {});
    proc.on('exit', (code, signal) => died(`exited (code ${code ?? 'none'}, signal ${signal ?? 'none'})`));
    proc.on('error', (err) => died(`failed (${err?.code ?? err?.name ?? 'error'})`));
  }

  function launch() {
    if (stopped || disabled || child || restartTimer) return;
    startedAt = now();
    let proc = null;
    try {
      proc = spawn(POWERSHELL, helperArgs(), { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      failed(`could not be started (${err?.code ?? err?.name ?? 'error'})`);
      return;
    }
    if (!proc || typeof proc.on !== 'function') {
      failed('could not be started (no process handle)');
      return;
    }
    child = proc;
    attach(proc);
  }

  return {
    /** Launch the helper and return immediately. A no-op when disabled, stopped, or already running. */
    start() {
      launch();
    },

    /** Idempotent teardown: no pending restart, no child, no listeners, no ledges. */
    stop() {
      if (stopped) return;
      stopped = true;
      cancelHandle(restartTimer);
      restartTimer = null;
      const proc = child;
      child = null; // before kill(), so its exit event is recognised as ours
      if (proc) {
        try {
          proc.kill();
        } catch {
          /* already gone */
        }
      }
      listeners.clear();
      ledges = EMPTY;
    },

    /** The last computed list, frozen. `[]` before the first line, while disabled, and after stop. */
    current() {
      return ledges;
    },

    onChange(fn) {
      if (typeof fn !== 'function' || stopped) return () => {};
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    isDisabled() {
      return disabled;
    },
  };
}

export default createLedgeSource;
