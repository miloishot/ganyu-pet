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
  createPetWindow,
  registerIpc,
  resolveSpritePath,
  smokeFlags,
  spriteFileUrl,
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
  if (typeof text === 'string' && text.trim()) send(CHANNELS.speak, { text: text.trim() });
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
  if (!found) console.warn(`[ganyu] ${label}: no method among [${names.join(', ')}] — events will not reach it`);
  return found;
}

let speechSink = null;
let wanderSink = null;
let wanderStop = null;

function notifySpeech(source, payload) {
  if (!speechSink) return;
  const aggregate = currentAggregate();
  const event = payload?.hook_event_name ?? payload?.event ?? payload?.type ?? null;
  try {
    if (speechSink.name === 'ingest') speechSink.call(source, payload);
    else speechSink.call({ source, payload, event, mode: aggregate?.mode ?? 'idle', aggregate }, aggregate);
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

  // Speech needs event-level detail (tool-class change during busy), which the
  // aggregate does not carry. Wrapping ingest is the one seam that sees every
  // normalized event regardless of how module B routes internally. Installed
  // before the server is constructed so it captures the wrapped reference.
  if (typeof state.ingest === 'function') {
    const rawIngest = state.ingest.bind(state);
    state.ingest = (source, payload) => {
      const result = rawIngest(source, payload);
      notifySpeech(source, payload);
      return result;
    };
  }

  const speechMod = await tryImport('./speech.mjs');
  if (speechMod?.createSpeech) {
    const speech = speechMod.createSpeech({
      exec: makeExec(),
      clock,
      onLine: sendSpeak,
      isMuted: () => flags.muted,
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
        if (typeof state?.setWandering === 'function') state.setWandering(Boolean(next));
        pushState();
      },
      isPinned: () => flags.pinned,
      random: Math.random,
    });
    wanderSink = requireMethod('wander', wander, ['onState', 'update', 'setState', 'notify', 'setMode', 'onMode']);
    wanderStop = pickMethod(wander, ['cancel', 'stop', 'disarm', 'reset']);
  }

  if (typeof state.onChange === 'function') {
    state.onChange(() => {
      pushState();
      notifyWander();
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
        logger: console,
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

  disposeIpc = registerIpc({ ipcMain, getWindow: () => win, getFlags, onMenuAction: handleMenuAction });

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
  app.whenReady().then(main);
}
