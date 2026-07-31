// Module A — Electron main entry. Owns the window, the IPC contract, and the
// composition of modules B (server+state), D (speech) and E (wander) with
// production dependencies injected.

import { app, BrowserWindow, ipcMain, screen } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createChat } from './chat.mjs';
import { buildContext, payloadOf, trackActiveSince } from './context.mjs';
import {
  CHANNELS,
  DRAG_POLL_MS,
  HOVER_POLL_MS,
  WINDOW_SIZE,
  computeInitialBounds,
  createDragTracker,
  createHoverWatch,
  createPetWindow,
  enforceWindowSize,
  moveWindowPinned,
  registerIpc,
  resolveSpritePath,
  sizeWithinTolerance,
  smokeFlags,
  spriteFileUrl,
  toSpeechDetail,
  toStatePayload,
} from './window.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(HERE, 'preload.cjs');
const RENDERER = path.join(HERE, '..', 'renderer', 'index.html');
/** Optional, git-ignored, and read only here: the brain's endpoint + key. */
const ENV_FILE = path.join(HERE, '..', '..', '.env.local');

/**
 * Her ledger. Under Electron's `userData` (resolved at runtime, in
 * `composeRuntime` — it is only reliable after the app is ready), deliberately
 * **not** in the repo: a file the app appends to all evening would show up in
 * every `git status` and be committed by accident within the week.
 */
const LEDGER_FILE = 'ledger.jsonl';

/**
 * And the conversation, beside it and for the same reasons. Everything he has
 * ever said to her used to live in an array and nowhere else, so quitting the
 * pet erased it — see the note at the top of chat.mjs.
 */
const CHAT_FILE = 'chat.jsonl';

/**
 * `app.getPath('userData')` is only dependable once the app is ready, so this is
 * called from inside `composeRuntime` and never at module scope. Its failure is
 * contained: the pet loses its memory of that one thing, not its window.
 */
function userDataFile(name) {
  try {
    return path.join(app.getPath('userData'), name);
  } catch (err) {
    console.warn(`[ganyu] no userData path for ${name} (${err?.message}) — she will not remember`);
    return null;
  }
}

/**
 * The owner's Obsidian vault and the repo→project map his shell hooks read.
 * Both **read-only**, and only ever a note's title, date and `Left open`
 * bullets — see the privacy note in vault.mjs. Absent on any other machine,
 * which is simply a pet who does not mention his notes.
 */
const VAULT_PROJECTS = path.join(os.homedir(), 'second-brain', '03 Projects');
const PROJECT_MAP = path.join(os.homedir(), '.claude', 'hooks', 'projects.tsv');

/**
 * The topic-shaped vaults, which are not session logs and so need topics.mjs
 * rather than vault.mjs. Absent directories are skipped silently — he does not
 * have these on every machine.
 */
const TOPIC_VAULTS = Object.freeze([
  { dir: path.join(os.homedir(), 'invoco-vault'), label: 'Invoco engineering' },
  { dir: path.join(os.homedir(), 'invoco-vault-strategy'), label: 'Invoco strategy' },
]);

const SMOKE = process.env.GANYU_SMOKE === '1';
const SMOKE_DELAY_MS = 5000;
const DEFAULT_PORT = 47821;
const STATE_POLL_MS = 1000;

/** `screen` events that can invalidate the pet's position. */
const DISPLAY_EVENTS = ['display-metrics-changed', 'display-added', 'display-removed'];

// Transparent always-on-top windows are GPU-composited; on some Windows GPU
// stacks that shows up as a black box behind the sprite. Escape hatch only.
if (process.env.GANYU_NO_GPU === '1') app.disableHardwareAcceleration();

/** @type {import('electron').BrowserWindow | null} */
let win = null;
const flags = { muted: false, pinned: false };
let spriteUrl = null;

let state = null;
let server = null;
let chat = null;
let walk = null;
let statePoll = null;
let hoverPoll = null;
let hoverWatch = null;
let dragTracker = null;
let dragPoll = null;
let disposeIpc = null;
let lastPushed = '';
/**
 * The two motion facts the renderer needs and cannot see for itself: whether the
 * owner is holding her (so the click that ends the drag must not open the chat
 * strip) and whether she is off the ground (so the sprite draws the jump row).
 */
const motion = { dragging: false, airborne: false };
/**
 * `{since, last}` for the current working stretch, stepped on every hook event.
 * The debug ring holds 50 entries and sessions expire after 10 minutes, so
 * neither can answer "how long has he been at this" once an evening gets busy;
 * this can, and `trackActiveSince` restarts it after a long enough gap so a
 * night's sleep is not counted as work.
 */
let activity = null;

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
 * The window's measured outer size, captured once after the size has been pinned
 * (see `moveWindowPinned` in window.mjs for the drift this defends against, with
 * the numbers).
 *
 * Cached rather than re-read live, and snapped to canonical within the tolerance,
 * for one reason each:
 *  - live re-reads make the floor follow the drift, which walks the pet up the
 *    screen a pixel per tick;
 *  - the reported rect comes back +/-1 DIP depending on the parity of the window's
 *    position, so an unsnapped reading would put the floor at 698 or 699 according
 *    to where she happened to be standing when we measured.
 * A size genuinely outside the tolerance is still honoured — that is what the
 * measurement is for.
 */
let stableSize = null;

function captureWindowSize() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getBounds();
    if (!b || !Number.isFinite(b.width) || b.width <= 0 || !Number.isFinite(b.height) || b.height <= 0) return;
    stableSize = sizeWithinTolerance(b)
      ? { width: WINDOW_SIZE.width, height: WINDOW_SIZE.height }
      : { width: b.width, height: b.height };
    if (process.env.GANYU_DEBUG === '1') {
      console.log(`[ganyu][window] requested ${WINDOW_SIZE.width}x${WINDOW_SIZE.height}, reported ${b.width}x${b.height}, using ${stableSize.width}x${stableSize.height}`);
    }
  } catch {
    /* fall back to the constant */
  }
}

function measuredWindowSize() {
  if (!stableSize) captureWindowSize();
  return stableSize ?? { width: WINDOW_SIZE.width, height: WINDOW_SIZE.height };
}

/** Wander's `getPosition`: where the window really is, drags included. */
function windowPosition() {
  if (!win || win.isDestroyed()) return null;
  try {
    const [x, y] = win.getPosition();
    return { x, y };
  } catch {
    return null;
  }
}

/** The real cursor, in screen coordinates. Feeds the hover watch and the drag. */
function cursorPoint() {
  try {
    return screen.getCursorScreenPoint();
  } catch {
    return null;
  }
}

/**
 * Wander's `moveWindow`. Accepts (x, y), (x) or ({x, y}). Delegates to
 * `moveWindowPinned`, which re-pins the canonical DIP size on every move — a bare
 * `setPosition` inflates the window a little each call and compounds into
 * thousands of pixels. That mechanism, and why it must not be simplified away, is
 * documented at `moveWindowPinned` in window.mjs.
 */
function moveWindow(a, b) {
  if (!win || win.isDestroyed()) return;
  let x = a;
  let y = b;
  if (a && typeof a === 'object') {
    x = a.x;
    y = a.y;
  }
  const [curX, curY] = win.getPosition();
  moveWindowPinned(
    win,
    Number.isFinite(x) ? x : curX,
    Number.isFinite(y) ? y : curY,
  );
}

/**
 * The size guard. `moveWindowPinned` should mean this never fires; it is here to
 * catch any other resize path (a DPI change, or a move that did not go through
 * moveWindow) before the inflated window pushes the sprite off the bottom of the
 * screen. Runs alongside the 1s containment check, which re-clamps afterwards.
 */
function guardWindowSize() {
  if (!win || win.isDestroyed()) return;
  try {
    const drifted = enforceWindowSize(win);
    if (drifted) {
      console.warn(`[ganyu] window size drifted to ${drifted.width}x${drifted.height} — reset`);
    }
  } catch (err) {
    console.warn('[ganyu] window size guard failed:', err?.message);
  }
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

/** Module B's debug ring, oldest first, or an empty one. */
function debugRing() {
  return typeof server?.debugEvents === 'function' ? server.debugEvents() : [];
}

/**
 * The directory his agents are working in — the newest hook event carrying one.
 * This is what decides which vault project's notes the pet can see, and it is
 * emphatically **not** `process.cwd()`: that is always this repo, which has no
 * vault folder, so resolving from it would make the whole feature inert.
 */
function agentCwd() {
  const ring = debugRing();
  for (let i = ring.length - 1; i >= 0; i -= 1) {
    const cwd = payloadOf(ring[i])?.cwd;
    if (typeof cwd === 'string' && cwd.trim() !== '') return cwd;
  }
  return process.cwd();
}

/**
 * Push `ganyu:state`, deduped. Also polled once a second because contracts.md
 * does not promise module B emits onChange when a transient flag expires
 * (celebrate 10s, failed 30s, session sweep 30s).
 */
function pushState(force = false) {
  const payload = toStatePayload(currentAggregate(), walk, motion);
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
      console.log(`[ganyu][speak] ${text.trim()}${line?.summary ? ` — ${line.summary}` : ''}`);
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
let wanderContain = null;
let wanderIsActive = null;
/** `(x, y) => void` — put her down at a spot, through module E. See goHome. */
let wanderPlace = null;
let speechTapped = false;

/**
 * Pull the pet back inside the work area. Cheap enough for the 1s poll because
 * module E no-ops when she is already inside. Called on startup, from the state
 * poll, and on every `screen` display event — the owner lost her off the right
 * edge of a 1707px work area and, with the aggregate mode stuck non-calm, no
 * stroll ever came to re-clamp her.
 */
function containPet() {
  if (!wanderContain) return;
  try {
    wanderContain.call();
  } catch (err) {
    console.warn('[ganyu] contain failed:', err?.message);
  }
}

/**
 * The cursor poll that carries her while the left button is down. Deliberately
 * only alive between a press and its release: 16ms is the right rate for a drag
 * and the wrong one to leave running all evening.
 */
function startDragPoll() {
  if (dragPoll) return;
  dragPoll = setInterval(() => {
    if (dragTracker) dragTracker.poll();
  }, DRAG_POLL_MS);
}

function stopDragPoll() {
  if (dragPoll) clearInterval(dragPoll);
  dragPoll = null;
}

/**
 * `ganyu:drag`. The renderer reports the button; whether the press became a
 * pick-up is the tracker's call, from the real cursor — see createDragTracker for
 * why that decision cannot live in the renderer on this machine.
 */
function onDragPhase(phase) {
  if (!dragTracker) return;
  if (phase === 'press') {
    dragTracker.press();
    startDragPoll();
    return;
  }
  dragTracker.release();
  stopDragPoll();
}

/**
 * A display change can rescale the window as well as move the work area, so
 * re-pin the canonical size and re-measure before re-clamping. Pins
 * unconditionally (tolerance 0) rather than via guardWindowSize, so a routine
 * DPI change is not reported as drift.
 */
function onDisplayChange() {
  if (win && !win.isDestroyed()) {
    try {
      enforceWindowSize(win, { tolerance: 0 });
    } catch (err) {
      console.warn('[ganyu] window resize on display change failed:', err?.message);
    }
  }
  stableSize = null;
  captureWindowSize();
  containPet();
}

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
    state.onEvent((event, aggregate) => {
      activity = trackActiveSince(activity, Date.now());
      notifySpeech(event, aggregate);
    });
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

  // Her memory, both halves. The ledger is what she saw and wrote down; the
  // vault is what he wrote down. Both are optional, both fail to null, and both
  // are constructed unconditionally — `createLedger({filePath: null})` and a
  // vault with no directory to read are objects that answer every call with
  // nothing, which is exactly what the rest of the wiring wants.
  let ledger = null;
  const ledgerMod = await tryImport('./ledger.mjs');
  if (ledgerMod?.createLedger) {
    // Everything below this line — the server, speech, wander — is worth more
    // than her diary, so a missing path costs the ledger and nothing else.
    ledger = ledgerMod.createLedger({ filePath: userDataFile(LEDGER_FILE), fs });
    console.log(`[ganyu] ledger: ${ledger.enabled ? ledger.path : 'disabled'}`);
  }

  let vault = null;
  const vaultMod = await tryImport('./vault.mjs');
  if (vaultMod?.createVault) {
    vault = vaultMod.createVault({
      fs,
      projectsDir: VAULT_PROJECTS,
      mapPath: PROJECT_MAP,
      // A getter, not a value: the project changes as he moves between repos.
      cwd: agentCwd,
    });
  }

  let topics = null;
  const topicsMod = await tryImport('./topics.mjs');
  if (topicsMod?.createTopics) {
    topics = topicsMod.createTopics({ fs, vaults: TOPIC_VAULTS });
    console.log(`[ganyu] topic vaults: ${topics.digest() ? 'readable' : 'none found'}`);
  }

  /** The digests, read per chat message. Never a reason a reply fails. */
  const readMemory = () => ({
    ledger: ledger?.digest?.() ?? null,
    vault: vault?.digest?.() ?? null,
    topics: topics?.digest?.() ?? null,
  });

  // The brain is optional in every sense: no .env.local, no key, or an endpoint
  // that turns us away all mean the same thing — the canned MESSAGES table does
  // the talking, exactly as it did before. Nothing here logs a config value.
  let brain = null;
  const brainMod = await tryImport('./brain.mjs');
  if (brainMod?.loadBrainConfig && brainMod?.createBrain) {
    const brainConfig = brainMod.loadBrainConfig({ envPath: ENV_FILE });
    if (brainConfig.enabled) {
      brain = brainMod.createBrain({
        config: brainConfig,
        log: console,
        // Read fresh per request, and lazily: the server that owns the ring is
        // created further down this same function.
        getContext: () => buildContext({
          ring: debugRing(),
          state,
          now: Date.now(),
          activeSinceMs: activity?.since ?? null,
        }),
        // Chat only — brain.mjs reads this on `requestChat` and nowhere else.
        getMemory: readMemory,
        // Her one tool, also chat-only: the difference between being handed a
        // digest and being able to go and look. A function rather than the
        // ledger itself, so brain.mjs never imports ledger.mjs. Read-only, and
        // absent when the ledger has no file to read.
        searchMemory: ledger?.enabled && typeof ledger.search === 'function'
          ? (args) => ledger.search(args)
          : null,
      });
      console.log(`[ganyu] brain: enabled (model ${brainConfig.model})`);
      console.log(
        brain.stats().memorySearch
          ? '[ganyu] memory search: on — she can look things up in her ledger'
          : '[ganyu] memory search: off — she has only the digest',
      );
    } else {
      console.log(`[ganyu] brain: disabled (${brainConfig.reason}) — canned lines only`);
    }
  }

  // The owner's half of the conversation. Built unconditionally, with whatever
  // the brain turned out to be: `createChat({brain: null})` is not a broken chat,
  // it is one whose every `send` resolves null — which is precisely the contract
  // `ganyu:chat` promises and what the renderer already draws its in-character
  // fallback from. Guarding the construction instead would only move the null
  // one layer out and add a way for the channel to hang.
  chat = createChat({ brain, filePath: userDataFile(CHAT_FILE), fs });
  console.log(
    brain
      ? '[ganyu] chat: enabled'
      : '[ganyu] chat: disabled (no brain) — she cannot answer, the bubble says so',
  );
  // Separate from the line above, because they are separate facts: she can be
  // able to answer and unable to remember it, or the reverse.
  console.log(
    chat.enabled
      ? `[ganyu] conversation: ${chat.path} (${chat.stats().exchanges} exchanges remembered)`
      : '[ganyu] conversation: not saved — she will not remember this past a restart',
  );

  const speechMod = await tryImport('./speech.mjs');
  if (speechMod?.createSpeech) {
    const speech = speechMod.createSpeech({
      clock,
      onLine: sendSpeak,
      // Smoke is a startup check: keep stray bubbles out of the stdout it parses.
      isMuted: () => flags.muted || SMOKE,
      brain,
      ledger,
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
      // Measured, not assumed — see measuredWindowSize.
      getWindowSize: measuredWindowSize,
      getPosition: windowPosition,
      onWalkState: (next) => {
        walk = next;
        // Pass the walk object, not a boolean: state.setWandering(true) coerces to
        // {dir:'right'}, so GET /state reported the wrong direction while walking left.
        if (typeof state?.setWandering === 'function') state.setWandering(next ?? null);
        pushState();
      },
      // Off the ground: held in the cursor, or mid-throw. The renderer draws the
      // jump row from it, so it has to arrive on the edge rather than wait for
      // the 1s poll — a whole throw is over inside a second.
      onAirborne: (value) => {
        motion.airborne = Boolean(value);
        pushState();
      },
      isPinned: () => flags.pinned,
      random: Math.random,
    });
    wanderSink = requireMethod('wander', wander, ['onState', 'update', 'setState', 'notify', 'setMode', 'onMode']);
    wanderStop = pickMethod(wander, ['cancel', 'stop', 'disarm', 'reset']);
    wanderContain = requireMethod('wander contain', wander, ['containNow', 'contain']);
    // `walk` is null during a mid-stroll breather, so it under-reports wandering
    // on GET /state; the module's own isWandering() spans the whole stroll.
    wanderIsActive = typeof wander.isWandering === 'function' ? () => wander.isWandering() : null;

    // Picking her up. The tracker reads the cursor and decides; module E still
    // writes every pixel, which is the point of routing the drag through it
    // rather than moving the window from here behind its back.
    if (typeof wander.grab === 'function') {
      // The same three calls are how `home` puts her in the corner — see goHome.
      wanderPlace = (x, y) => {
        wander.grab();
        wander.moveTo(x, y);
        wander.release({ vx: 0, vy: 0 });
      };
      dragTracker = createDragTracker({
        now: () => Date.now(),
        getCursorPoint: cursorPoint,
        getPosition: windowPosition,
        grab: () => wander.grab(),
        moveTo: (x, y) => wander.moveTo(x, y),
        release: (velocity) => wander.release(velocity),
        onDragging: (value) => {
          motion.dragging = Boolean(value);
          // The tracker can end a drag by itself (its lost-mouseup backstop), so
          // the poll is stopped here as well as in the release handler.
          if (!value) stopDragPoll();
          pushState();
        },
      });
    } else {
      console.warn('[ganyu][wiring] wander has no grab() — the pet cannot be picked up');
    }
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
        getWandering: () => (wanderIsActive ? wanderIsActive() : walk !== null),
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

/**
 * Recall: snap her back to the initial bottom-right corner. The last resort when
 * the pet is somewhere the owner cannot reach — reachable even while pinned, and
 * even while the mode is stuck non-calm. Uses the measured size so the corner it
 * lands on is genuinely inside the work area.
 */
function goHome() {
  if (!win || win.isDestroyed()) return;
  const home = computeInitialBounds(screen.getPrimaryDisplay().workArea, measuredWindowSize());

  // Through module E's hold API rather than around it. `cancel()` deliberately
  // leaves a fall running — pinning is no reason to hang her in mid-air — so with
  // throws in the mix, moving the window from here would be undone a tick later
  // by a fall still integrating from its own stale coordinates. grab/moveTo/
  // release drops the stroll *and* the fall, writes the position through the one
  // writer there is, and hands her back to the ordinary scheduler.
  if (wanderPlace) {
    try {
      wanderPlace(home.x, home.y);
      pushState();
      return;
    } catch (err) {
      console.warn('[ganyu] recall through wander failed:', err?.message);
    }
  }

  // No module E, or it does not know how to be held: move her directly. Drop any
  // stroll first, or its next tick drags her straight back out.
  if (wanderStop) {
    try {
      wanderStop.call();
    } catch (err) {
      console.warn('[ganyu] wander stop failed:', err?.message);
    }
  }
  moveWindowPinned(win, home.x, home.y); // never a bare setPosition — see window.mjs
  containPet(); // resyncs module E's tracked position to where she now is
  pushState();
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
  if (action === 'home') {
    goHome();
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
  // The BrowserWindow constructor rounds a 256x320 request up to a 259x323 outer
  // rect on this machine, which hangs 3px past the work area. One pinned move
  // normalizes it to exactly 256x320 (measured), so do that before measuring —
  // otherwise every geometry consumer inherits the constructor's rounding.
  enforceWindowSize(win, { tolerance: 0 });
  captureWindowSize();
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
  // Mute/Pin/Home/Quit menu — the only user controls — is unreachable.
  hoverWatch = createHoverWatch({
    // Live position, but the *stable* size: getBounds' width/height inflate ~1px
    // per move (see measuredWindowSize), which slid the sprite's hover box further
    // off the sprite the longer she walked, until the right-click menu — the only
    // user control, and the only way to reach 'home' — could not be opened at all.
    getBounds: () => {
      const at = windowPosition();
      return at ? { ...at, ...measuredWindowSize() } : null;
    },
    getCursorPoint: cursorPoint,
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
    // Read through the module-level tracker, not captured: composeRuntime builds
    // it below, and a press before then is simply a press with nothing behind it.
    onDrag: onDragPhase,
    // Read per message, not captured: composeRuntime builds `chat` below, after
    // this runs. Anything he types before then answers null instead of rejecting.
    getChat: () => chat,
  });

  try {
    await composeRuntime();
  } catch (err) {
    console.error('[ganyu] composition failed:', err?.stack ?? err?.message);
  }

  // Contain once now that module E exists and the geometry is settled.
  containPet();

  // A resolution or scaling change, or a monitor being docked or undocked, can
  // strand her outside the new work area — nothing in the stroll scheduler would
  // notice until the next stroll, and a non-calm mode means there is no next
  // stroll. `screen` is only valid after app.whenReady(), which main() is inside.
  for (const event of DISPLAY_EVENTS) screen.on(event, onDisplayChange);

  statePoll = setInterval(() => {
    guardWindowSize(); // reset any residual drift first, then re-clamp
    containPet();
    pushState();
  }, STATE_POLL_MS);

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
  stopDragPoll();
  if (dragTracker) {
    try {
      dragTracker.cancel(); // put her down where she is; never throw on the way out
    } catch {
      /* shutting down */
    }
  }
  for (const event of DISPLAY_EVENTS) {
    try {
      screen.removeListener(event, onDisplayChange);
    } catch {
      /* shutting down */
    }
  }
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
  console.log('[ganyu] another instance is already running — exiting');
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
