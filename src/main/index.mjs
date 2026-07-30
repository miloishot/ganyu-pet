// Module A — Electron main entry. Owns the window, the IPC contract, and the
// composition of modules B (server+state), D (speech) and E (wander) with
// production dependencies injected.

import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHANNELS,
  HOVER_POLL_MS,
  createHoverWatch,
  createPetWindow,
  registerIpc,
  resolveSpritePath,
  smokeFlags,
  spriteFileUrl,
  toSpeechDetail,
  toStatePayload,
} from './window.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(HERE, 'preload.cjs');
const RENDERER = path.join(HERE, '..', 'renderer', 'index.html');

const SMOKE = process.env.GANYU_SMOKE === '1';
const SMOKE_DELAY_MS = 5000;
const DEFAULT_PORT = 47821;
const STATE_POLL_MS = 1000;

// Transparent always-on-top windows are GPU-composited; on some Windows GPU
// stacks that shows up as a black box behind the sprite. Escape hatch only.
if (process.env.GANYU_NO_GPU === '1') app.disableHardwareAcceleration();

/** @type {import('electron').BrowserWindow | null} */
let win = null;
const flags = { muted: false, pinned: false };
let spriteUrl = null;

let state = null;
let server = null;
let walk = null;
let statePoll = null;
let hoverPoll = null;
let hoverWatch = null;
let disposeIpc = null;
let lastPushed = '';

// ---------------------------------------------------------------------------
// Production dependencies for the injected modules
// ---------------------------------------------------------------------------

/**
 * contracts.md describes the clock both as `clock.now()` and as
 * `() => Date.now()`; this satisfies both readings.
 */
function makeClock() {
  const clock = () => Date.now();
  clock.now = () => Date.now();
  return clock;
}

/** `schedule(fn, ms)` -> cancel handle. Callable, and `.cancel()`/`.clear()`. */
function schedule(fn, ms) {
  const timer = setTimeout(fn, ms);
  const cancel = () => clearTimeout(timer);
  cancel.cancel = cancel;
  cancel.clear = cancel;
  cancel.timer = timer;
  return cancel;
}

/**
 * Speech's `exec`. Accepts either shape module D may use:
 *   exec(prompt)                        -> Promise<string>   (trimmed stdout)
 *   exec(prompt, cb)                    -> execFile callback (err, stdout, stderr)
 *   exec(file, args[, opts][, cb])      -> execFile passthrough (promise when no cb)
 * The claude CLI is spawned with a 15s timeout and killed on expiry.
 */
function makeExec() {
  const bin = process.env.GANYU_CLAUDE_BIN || path.join(os.homedir(), '.local', 'bin', 'claude');
  const base = { timeout: 15000, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 1024 * 1024 };

  const run = (file, args, options, cb) => {
    if (cb) return execFile(file, args, { ...base, ...options }, cb);
    return new Promise((resolve, reject) => {
      execFile(file, args, { ...base, ...options }, (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        }
      });
    });
  };

  return function exec(a, b, c, d) {
    const cb = [b, c, d].find((x) => typeof x === 'function');
    const opts = [b, c, d].find((x) => x && typeof x === 'object' && !Array.isArray(x));

    if (typeof a === 'string' && Array.isArray(b)) return run(a, b, opts, cb);

    const prompt = typeof a === 'string' ? a : String(a?.prompt ?? a ?? '');
    const args = ['-p', prompt, '--model', 'haiku'];
    if (cb) return run(bin, args, opts, cb);
    return run(bin, args, opts, null).then((r) => r.stdout.trim());
  };
}

/** Wander's `moveWindow`. Accepts (x, y), (x) or ({x, y}). */
function moveWindow(a, b) {
  if (!win || win.isDestroyed()) return;
  let x = a;
  let y = b;
  if (a && typeof a === 'object') {
    x = a.x;
    y = a.y;
  }
  const [curX, curY] = win.getPosition();
  win.setPosition(
    Math.round(Number.isFinite(x) ? x : curX),
    Math.round(Number.isFinite(y) ? y : curY),
  );
}

// ---------------------------------------------------------------------------
// Renderer push
// ---------------------------------------------------------------------------

function send(channel, payload) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return;
  wc.send(channel, payload);
}

function currentAggregate() {
  try {
    return state && typeof state.aggregate === 'function' ? state.aggregate() : null;
  } catch (err) {
    console.warn('[ganyu] aggregate() failed:', err?.message);
    return null;
  }
}

/**
 * Push `ganyu:state`, deduped. Also polled once a second because contracts.md
 * does not promise module B emits onChange when a transient flag expires
 * (celebrate 10s, failed 30s, session sweep 30s).
 */
function pushState(force = false) {
  const payload = toStatePayload(currentAggregate(), walk);
  const key = JSON.stringify(payload);
  if (!force && key === lastPushed) return;
  lastPushed = key;
  send(CHANNELS.state, payload);
}

function sendSpeak(line) {
  const text = typeof line === 'string' ? line : line?.text;
  if (typeof text === 'string' && text.trim()) {
    // The only externally observable proof that a POST /event reached the speech
    // trigger path rather than stopping at the state aggregator.
    if (process.env.GANYU_DEBUG === '1') {
      console.log(`[ganyu][speak] ${text.trim()}${line?.fallback ? ' (fallback)' : ''}`);
    }
    send(CHANNELS.speak, { text: text.trim() });
  }
}

// ---------------------------------------------------------------------------
// Cross-module dispatch
// ---------------------------------------------------------------------------

// contracts.md fixes the factory signatures of B/D/E but not the method names
// on what they return. These adapters try the plausible names once, so a
// mismatch is a one-line fix here instead of a silent no-op.
function pickMethod(target, names) {
  if (!target) return null;
  for (const name of names) {
    if (typeof target[name] === 'function') return { name, call: target[name].bind(target) };
  }
  return null;
}

function requireMethod(label, target, names) {
  const found = pickMethod(target, names);
  if (found && process.env.GANYU_DEBUG === '1') console.log(`[ganyu][wiring] ${label} -> .${found.name}()`);
  if (!found) {
    console.warn(
      `[ganyu][wiring] ${label}: none of [${names.join(', ')}] found on the returned object — ` +
        `it will receive no events. Add the real name to this list in src/main/index.mjs.`,
    );
  }
  return found;
}

let speechSink = null;
let wanderSink = null;
let wanderStop = null;
let speechTapped = false;

/** Only for the fallback tap, where no normalized event is available. */
function payloadHints(payload) {
  return {
    event: payload?.hook_event_name ?? payload?.event ?? payload?.type ?? null,
    sessionId: payload?.session_id ?? payload?.thread_id ?? payload?.sessionId ?? null,
    tool: payload?.tool_name ?? payload?.tool ?? null,
  };
}

/**
 * `event` is module B's normalized event ({source, event, mode, tool, ...}).
 * `toSpeechDetail` (window.mjs) builds the detail so the unit test can exercise
 * this exact seam rather than a copy of it.
 */
function notifySpeech(event, aggregate) {
  if (!speechSink || !event) return;
  const agg = aggregate ?? currentAggregate();
  const detail = toSpeechDetail(event, agg);
  try {
    if (speechSink.name === 'ingest') speechSink.call(event.source ?? null, detail);
    else speechSink.call(detail, agg);
  } catch (err) {
    console.warn('[ganyu] speech notify failed:', err?.message);
  }
}

const MODE_FIRST = new Set(['setMode', 'onMode', 'mode']);

function notifyWander() {
  if (!wanderSink) return;
  const aggregate = currentAggregate() || { mode: 'idle' };
  const mode = aggregate.mode ?? 'idle';
  try {
    if (MODE_FIRST.has(wanderSink.name)) wanderSink.call(mode, aggregate);
    else wanderSink.call(aggregate, mode);
  } catch (err) {
    console.warn('[ganyu] wander notify failed:', err?.message);
  }
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

async function tryImport(spec) {
  try {
    return await import(spec);
  } catch (err) {
    // B/D/E are authored in parallel; a missing sibling must not stop the
    // window (and must not fail `npm run smoke`).
    console.warn(`[ganyu] optional module unavailable ${spec}: ${err?.code ?? err?.message}`);
    return null;
  }
}

/**
 * The hook scripts hardcode port 47821, so losing it means the pet can never
 * hear anything: log clearly and exit 1 (contracts.md HTTP contract). Any other
 * socket error leaves the window up.
 */
function onServerError(err) {
  console.error(`[ganyu] hook server error on 127.0.0.1:${process.env.GANYU_PORT ?? DEFAULT_PORT}: ${err?.code ?? ''} ${err?.message ?? err}`);
  if (!SMOKE && (err?.code === 'EADDRINUSE' || err?.code === 'EACCES')) app.exit(1);
}

async function composeRuntime() {
  const clock = makeClock();

  const stateMod = await tryImport('./state.mjs');
  if (stateMod?.createState) state = stateMod.createState({ clock });
  if (!state) {
    console.warn('[ganyu] running without state — renderer stays idle');
    return;
  }

  // Speech needs per-event detail (tool-class change during busy), which the
  // aggregate does not carry. Module B's `onEvent(cb)` is the clean seam: it
  // yields (normalizedEvent, aggregate). If a build of B ever lacks it, fall
  // back to wrapping `ingest` — degrade, never abort (no server = deaf pet).
  if (typeof state.onEvent === 'function') {
    state.onEvent((event, aggregate) => notifySpeech(event, aggregate));
    speechTapped = true;
  } else if (typeof state.ingest === 'function') {
    const rawIngest = state.ingest.bind(state);
    try {
      state.ingest = (source, payload) => {
        const result = rawIngest(source, payload);
        notifySpeech({ source, ...payloadHints(payload) }, currentAggregate());
        return result;
      };
      speechTapped = state.ingest !== rawIngest;
    } catch (err) {
      console.warn(`[ganyu][wiring] could not tap state.ingest (${err?.message})`);
    }
    if (!speechTapped) {
      console.warn('[ganyu][wiring] no state.onEvent and state.ingest is not writable — speech falls back to mode changes only');
    }
  }

  const speechMod = await tryImport('./speech.mjs');
  if (speechMod?.createSpeech) {
    const speech = speechMod.createSpeech({
      exec: makeExec(),
      clock,
      onLine: sendSpeak,
      // Smoke has a 20s budget and the claude CLI a 15s timeout — never let a
      // stray line spawn a subprocess during the check.
      isMuted: () => flags.muted || SMOKE,
    });
    speechSink = requireMethod('speech', speech, ['onEvent', 'handleEvent', 'notify', 'trigger', 'onState', 'ingest', 'speak']);
  }

  const wanderMod = await tryImport('./wander.mjs');
  if (wanderMod?.createWander) {
    const wander = wanderMod.createWander({
      clock,
      schedule,
      moveWindow,
      getWorkArea: () => screen.getPrimaryDisplay().workArea,
      onWalkState: (next) => {
        walk = next;
        // Pass the walk object, not a boolean: state.setWandering(true) coerces to
        // {dir:'right'}, so GET /state reported the wrong direction while walking left.
        if (typeof state?.setWandering === 'function') state.setWandering(next ?? null);
        pushState();
      },
      isPinned: () => flags.pinned,
      random: Math.random,
    });
    wanderSink = requireMethod('wander', wander, ['onState', 'update', 'setState', 'notify', 'setMode', 'onMode']);
    wanderStop = pickMethod(wander, ['cancel', 'stop', 'disarm', 'reset']);
  }

  if (typeof state.onChange === 'function') {
    state.onChange((aggregate, event) => {
      pushState();
      notifyWander();
      // Only when neither seam above worked: a mode transition is less
      // information than an event, but better than a silent pet.
      if (!speechTapped) notifySpeech(event ?? { source: null, event: null, mode: aggregate?.mode }, aggregate);
    });
  }

  const serverMod = await tryImport('./server.mjs');
  const createServer = serverMod?.createServer ?? serverMod?.createHookServer ?? serverMod?.default;
  if (typeof createServer === 'function') {
    // Smoke runs on an ephemeral port so a live pet can't fail the check.
    const port = Number(process.env.GANYU_PORT ?? (SMOKE ? 0 : DEFAULT_PORT));
    try {
      server = await createServer({
        state,
        port,
        host: '127.0.0.1',
        // Module B's option is `log`, not `logger` — `logger` was silently ignored.
        log: console,
        ingest: (source, payload) => state.ingest(source, payload),
        onEvent: (source, payload) => state.ingest(source, payload),
        getWandering: () => walk !== null,
      });
      // A factory that already listened needs no start(); an http.Server would
      // otherwise be re-listened on a random port.
      const start = pickMethod(server, ['start', 'listen']);
      if (start && server.listening !== true) await start.call();
      if (server && typeof server.on === 'function') server.on('error', onServerError);
    } catch (err) {
      if (err?.code !== 'ERR_SERVER_ALREADY_LISTEN') onServerError(err);
    }
  }

  notifyWander();
  pushState(true);
}

// ---------------------------------------------------------------------------
// Menu actions / flags
// ---------------------------------------------------------------------------

function getFlags() {
  return { muted: flags.muted, pinned: flags.pinned, spritePath: spriteUrl };
}

function handleMenuAction(action) {
  if (action === 'toggle-mute') {
    flags.muted = !flags.muted;
    return;
  }
  if (action === 'toggle-pin') {
    flags.pinned = !flags.pinned;
    if (flags.pinned) {
      if (wanderStop) {
        try {
          wanderStop.call();
        } catch (err) {
          console.warn('[ganyu] wander stop failed:', err?.message);
        }
      }
      walk = null;
      if (typeof state?.setWandering === 'function') state.setWandering(false);
      pushState();
    }
    return;
  }
  if (action === 'quit') app.quit();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function main() {
  spriteUrl = spriteFileUrl(resolveSpritePath());
  if (!spriteUrl) console.warn('[ganyu] spritesheet not found — renderer will have no sprite');

  win = createPetWindow({
    BrowserWindow,
    workArea: screen.getPrimaryDisplay().workArea,
    preloadPath: PRELOAD,
  });
  win.on('closed', () => {
    win = null;
  });
  win.webContents.on('did-finish-load', () => pushState(true));
  win.loadFile(RENDERER).catch((err) => {
    console.error('[ganyu] failed to load renderer:', err?.message);
  });

  // Hover interactivity: forwarded mouse-move does not reach this window on
  // Electron 43 / Win11, so main polls the real cursor (see createHoverWatch).
  // Without it the pet never becomes interactive and the right-click
  // Mute/Pin/Quit menu — the only user controls — is unreachable.
  hoverWatch = createHoverWatch({
    getBounds: () => (win && !win.isDestroyed() ? win.getBounds() : null),
    getCursorPoint: () => {
      try {
        return screen.getCursorScreenPoint();
      } catch {
        return null;
      }
    },
    apply: (interactive) => {
      if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!interactive, { forward: true });
    },
  });
  hoverPoll = setInterval(() => hoverWatch.poll(), HOVER_POLL_MS);

  disposeIpc = registerIpc({
    ipcMain,
    getWindow: () => win,
    getFlags,
    onMenuAction: handleMenuAction,
    onInteractive: (interactive) => hoverWatch.setRendererWants(interactive),
  });

  try {
    await composeRuntime();
  } catch (err) {
    console.error('[ganyu] composition failed:', err?.stack ?? err?.message);
  }

  statePoll = setInterval(() => pushState(), STATE_POLL_MS);

  if (SMOKE) {
    setTimeout(() => {
      console.log(`SMOKE_OK ${JSON.stringify(smokeFlags(win))}`);
      app.quit();
    }, SMOKE_DELAY_MS);
  }
}

function cleanup() {
  if (statePoll) clearInterval(statePoll);
  statePoll = null;
  if (hoverPoll) clearInterval(hoverPoll);
  hoverPoll = null;
  if (disposeIpc) disposeIpc();
  disposeIpc = null;
  if (wanderStop) {
    try {
      wanderStop.call();
    } catch {
      /* shutting down */
    }
  }
  const stopServer = pickMethod(server, ['close', 'stop']);
  if (stopServer) {
    try {
      stopServer.call();
    } catch {
      /* shutting down */
    }
  }
}

// Single-instance lock. Skipped under GANYU_SMOKE so the smoke check never
// depends on whether a real pet is already running.
const gotLock = SMOKE ? true : app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) win.showInactive();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', cleanup);
  app.whenReady().then(main).catch((err) => {
    // Without this, a throw in main() is an unhandled rejection and `npm run
    // smoke` reports a 20s timeout instead of the actual cause.
    console.error('[ganyu] fatal during startup:', err?.stack ?? err?.message ?? err);
    app.exit(1);
  });
}
