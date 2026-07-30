// Module D — speech: decides when Ganyu talks, asks the claude CLI for a line,
// falls back to canned persona lines. No Electron import; every side effect is injectable.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  MAX_LINE_CHARS,
  buildPrompt,
  buildSummary,
  defaultUser,
  fallbackFor,
} from './persona.mjs';

export const COOLDOWN_MS = 45_000;
export const INTERRUPT_FLOOR_MS = 15_000;
export const EXEC_TIMEOUT_MS = 15_000;
export const INTERRUPT_KINDS = new Set(['waiting', 'failed']);

/** argv for the CLI, per contracts.md §Speech. */
export const claudeArgs = (prompt) => ['-p', prompt, '--model', 'haiku'];

const BUSY_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'SessionStart',
]);
const WAITING_EVENTS = new Set(['PermissionRequest', 'Notification']);
const IDLE_EVENTS = new Set(['Stop', 'SessionEnd']);

const TOOL_CLASS_PATTERNS = [
  [/^(bash|shell|powershell|pwsh|cmd|exec|local_shell|run_command|terminal)/i, 'shell'],
  [/^(edit|write|multiedit|notebookedit|apply_patch|patch|update_file|str_replace|create_file)/i, 'edit'],
  [/^(read|glob|grep|ls|list|search|view|find)/i, 'read'],
  [/^(webfetch|websearch|fetch|browse|http)/i, 'web'],
  [/^(task|agent|subagent|dispatch|workflow)/i, 'agent'],
];

/** Coarse tool grouping so "first Bash after a run of edits" registers as a change. */
export function toolClass(name) {
  if (!name) return 'none';
  const s = String(name);
  for (const [re, cls] of TOOL_CLASS_PATTERNS) if (re.test(s)) return cls;
  return s.toLowerCase();
}

/** Same event→mode table as module B; used only when the caller does not supply `mode`. */
export function modeForEvent(event, errorish = false) {
  if (errorish) return 'failed';
  if (!event) return null;
  if (WAITING_EVENTS.has(event)) return 'waiting';
  if (IDLE_EVENTS.has(event)) return 'idle';
  if (BUSY_EVENTS.has(event)) return 'busy';
  return null;
}

const ERROR_FIELDS = ['tool_response', 'toolResponse', 'last_message', 'lastMessage', 'message', 'result', 'error', 'stderr'];
const ERROR_MARKER = /(^|[^a-z])(error|failed|failure)([^a-z]|$)/i;

export function hasErrorMarker(payload) {
  if (!payload || typeof payload !== 'object') return false;
  for (const key of ERROR_FIELDS) {
    const v = payload[key];
    if (v == null) continue;
    if (typeof v === 'boolean') {
      if (v && (key === 'error' || key === 'failed')) return true;
      continue;
    }
    let s;
    try {
      s = typeof v === 'string' ? v : JSON.stringify(v);
    } catch {
      s = String(v);
    }
    if (s && ERROR_MARKER.test(s)) return true;
  }
  return false;
}

/** Last path segment, tolerant of both Windows and POSIX separators. */
export function projectName(p) {
  if (!p) return null;
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/** Trim CLI noise down to one displayable line of at most `max` characters. */
export function cleanLine(raw, max = MAX_LINE_CHARS) {
  if (raw == null) return '';
  let s = String(raw).replace(/\u001B\[[0-9;?]*[A-Za-z]/g, '');
  s = s.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) || '';
  s = s.replace(/^(?:ganyu|line|response|output)\s*[:：]\s*/i, '');
  s = s.replace(/^[\s`"'*_“‘]+/, '').replace(/[\s`"'*_”’]+$/, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > max) {
    const cut = s.slice(0, max - 1);
    const sp = cut.lastIndexOf(' ');
    const head = sp > Math.floor(max * 0.6) ? cut.slice(0, sp) : cut;
    s = `${head.replace(/[\s,.;:!?\-–—]+$/, '')}…`;
  }
  return s;
}

/** GANYU_CLAUDE_BIN > %USERPROFILE%\.local\bin\claude(.exe). */
export function resolveClaudeBin(env = process.env) {
  if (env.GANYU_CLAUDE_BIN) return env.GANYU_CLAUDE_BIN;
  const home = env.USERPROFILE || env.HOME || homedir();
  const base = path.join(home, '.local', 'bin', 'claude');
  const exe = `${base}.exe`;
  try {
    if (existsSync(exe)) return exe;
  } catch {
    /* fall through to the extensionless path */
  }
  return base;
}

function defaultSchedule(fn, ms) {
  const t = setTimeout(fn, ms);
  if (typeof t.unref === 'function') t.unref();
  return () => clearTimeout(t);
}

/**
 * createSpeech({exec, clock, onLine, isMuted, ...})
 *
 * exec     — execFile-shaped: exec(file, args, options, cb(err, stdout, stderr)). Default: node execFile.
 * clock    — {now()} or a () => ms function.
 * onLine   — called with {text, kind, mode, source, fallback}; `text` matches the ganyu:speak payload.
 * isMuted  — () => bool. Muted means no exec calls at all.
 *
 * Optional (defaults are production-safe): user, random, schedule, bin, args, timeoutMs,
 * cooldownMs, interruptFloorMs, onError.
 */
export function createSpeech({
  exec = execFile,
  clock = { now: () => Date.now() },
  onLine = () => {},
  isMuted = () => false,
  user = defaultUser(),
  random = Math.random,
  schedule = defaultSchedule,
  bin = resolveClaudeBin(),
  args = claudeArgs,
  timeoutMs = EXEC_TIMEOUT_MS,
  cooldownMs = COOLDOWN_MS,
  interruptFloorMs = INTERRUPT_FLOOR_MS,
  onError = () => {},
} = {}) {
  const now = () => (typeof clock === 'function' ? clock() : clock.now());
  const muted = () => (typeof isMuted === 'function' ? Boolean(isMuted()) : Boolean(isMuted));

  let lastSpokeAt = null;
  let lastMode = null;
  let inFlight = false;
  let pending = null; // queue depth 1 — newest trigger replaces the previous one
  let cancelWake = null;
  const toolClasses = new Map(); // sessionId -> last tool class
  const lastLines = new Map(); // kind -> last canned line used

  const floorFor = (kind) => (INTERRUPT_KINDS.has(kind) ? interruptFloorMs : cooldownMs);

  function rememberClass(sessionId, cls) {
    toolClasses.delete(sessionId);
    toolClasses.set(sessionId, cls);
    if (toolClasses.size > 32) toolClasses.delete(toolClasses.keys().next().value);
  }

  function normalizeEvent(input = {}) {
    const p = input.payload && typeof input.payload === 'object' ? input.payload : {};
    const source = input.source ?? p.source ?? 'agent';
    const event = input.event ?? p.hook_event_name ?? p.event ?? p.type ?? null;
    const sessionId =
      input.sessionId ?? p.session_id ?? p.thread_id ?? p.sessionId ?? `${source}-unknown`;
    const toolName = input.toolName ?? p.tool_name ?? p.toolName ?? p.tool?.name ?? null;
    const project =
      input.project ?? projectName(input.cwd ?? p.cwd ?? p.project_dir ?? p.workspace ?? null);
    const errorish = input.errorish ?? hasErrorMarker(p);
    const mode = input.mode ?? modeForEvent(event, errorish);
    return { source, event, sessionId, toolName, project, errorish, mode };
  }

  /** Chatty-mode trigger rules. Also updates mode / tool-class tracking. */
  function decideTrigger(ev) {
    const prevMode = lastMode;
    if (ev.mode) lastMode = ev.mode;

    const prevClass = toolClasses.get(ev.sessionId) ?? null;
    const cls = toolClass(ev.toolName);
    if (cls !== 'none') rememberClass(ev.sessionId, cls);

    if (ev.mode === 'failed' && (prevMode !== 'failed' || ev.errorish)) return 'failed';
    if (ev.mode === 'waiting' && (prevMode !== 'waiting' || WAITING_EVENTS.has(ev.event))) {
      return 'waiting';
    }
    if (ev.event === 'SessionStart') return 'greeting';
    if (IDLE_EVENTS.has(ev.event)) return 'celebrate';
    if (ev.mode === 'busy' && cls !== 'none' && prevClass !== null && cls !== prevClass) {
      return 'busy';
    }
    return null;
  }

  /** `schedule` may hand back a function, or an object with .cancel()/.clear(). */
  function toCancel(handle) {
    if (typeof handle === 'function') return handle;
    if (handle && typeof handle.cancel === 'function') return () => handle.cancel();
    if (handle && typeof handle.clear === 'function') return () => handle.clear();
    return () => {};
  }

  function armWake(delayMs) {
    if (cancelWake) cancelWake();
    cancelWake = toCancel(schedule(wake, Math.max(0, delayMs)));
  }

  function wake() {
    if (cancelWake) cancelWake();
    cancelWake = null;
    if (!pending) return;
    if (muted()) {
      pending = null;
      return;
    }
    if (inFlight) return; // the in-flight completion flushes the queue
    const t = now();
    const wait = waitFor(pending.kind, t);
    if (wait > 0) {
      armWake(wait);
      return;
    }
    const trigger = pending;
    pending = null;
    dispatch(trigger, t);
  }

  function waitFor(kind, t) {
    if (lastSpokeAt === null) return 0;
    return Math.max(0, floorFor(kind) - (t - lastSpokeAt));
  }

  function flushPending() {
    if (!pending) return;
    const t = now();
    const wait = waitFor(pending.kind, t);
    if (wait > 0) armWake(wait);
    else wake();
  }

  function emit(text, trigger, fallback) {
    if (!text) return null;
    if (muted()) return null; // mute flipped while the CLI was running
    const line = { text, kind: trigger.kind, mode: trigger.ev.mode ?? null, source: trigger.ev.source, fallback };
    try {
      onLine(line);
    } catch (err) {
      try {
        onError(err);
      } catch {
        /* never let a listener break the pet */
      }
    }
    return line;
  }

  function cannedLine(kind) {
    const line = fallbackFor(kind, { random, avoid: lastLines.get(kind) ?? null });
    lastLines.set(kind, line);
    return line;
  }

  function dispatch(trigger, t) {
    const summary = buildSummary(trigger.ev);
    const prompt = buildPrompt({ user, summary });
    const argv = args(prompt);
    const options = {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    };

    lastSpokeAt = t; // reserve the slot up front: one CLI call in flight, cooldown starts now
    inFlight = true;

    let emitted = null;
    let settled = false;
    const done = (err, stdout) => {
      if (settled) return;
      settled = true;
      inFlight = false;
      const text = cleanLine(stdout);
      emitted = err || !text ? emit(cannedLine(trigger.kind), trigger, true) : emit(text, trigger, false);
      flushPending();
    };

    try {
      exec(bin, argv, options, done);
    } catch (err) {
      done(err, '');
    }

    return {
      dispatched: true,
      reason: 'dispatched',
      kind: trigger.kind,
      summary,
      prompt,
      args: argv,
      spoken: Boolean(emitted),
      text: emitted ? emitted.text : null,
      fallback: emitted ? emitted.fallback : null,
    };
  }

  /**
   * Feed one normalized-or-raw event. Returns a descriptor:
   * {dispatched, reason: 'no-trigger'|'muted'|'cooldown'|'in-flight'|'dispatched', kind, ...}
   */
  function notify(input = {}) {
    const ev = normalizeEvent(input);
    const kind = decideTrigger(ev);
    if (!kind) return { dispatched: false, spoken: false, reason: 'no-trigger', kind: null };
    if (muted()) return { dispatched: false, spoken: false, reason: 'muted', kind };

    const trigger = { kind, ev };
    const t = now();
    const wait = waitFor(kind, t);
    if (wait > 0) {
      pending = trigger;
      armWake(wait);
      return { dispatched: false, spoken: false, reason: 'cooldown', kind, retryInMs: wait };
    }
    if (inFlight) {
      pending = trigger;
      return { dispatched: false, spoken: false, reason: 'in-flight', kind };
    }
    pending = null;
    return dispatch(trigger, t);
  }

  return {
    notify,
    /** Alias — module A probes for `onEvent` first and calls it with the event object. */
    onEvent: notify,
    /**
     * Convenience for a raw hook payload: handleEvent('claude', payload[, mode]).
     * Also tolerates being handed a single event object (same shape as notify).
     */
    handleEvent(source, payload, mode) {
      if (source && typeof source === 'object') return notify(source);
      return notify({ source, payload, ...(mode ? { mode } : {}) });
    },
    /** Introspection for tests and debugging. */
    stats() {
      return {
        lastSpokeAt,
        lastMode,
        inFlight,
        pendingKind: pending ? pending.kind : null,
        wakeArmed: Boolean(cancelWake),
      };
    },
    dispose() {
      if (cancelWake) cancelWake();
      cancelWake = null;
      pending = null;
      toolClasses.clear();
      lastLines.clear();
    },
  };
}

export default createSpeech;
