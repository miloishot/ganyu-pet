// Module D — speech: decides when Ganyu says something and turns the hook event
// into a deterministic status line from the persona MESSAGES table.
//
// There is no LLM here any more. The bubble is a status indicator: it has to
// appear the instant the event lands and read the same way every time, which a
// ~4s CLI round-trip (and its canned-fallback path) could not do.
// No Electron import; every side effect is injectable.

import { buildSummary, messageFor } from './persona.mjs';

/** Minimum gap between lines. `waiting` / `failed` ignore it — they are the point. */
export const THROTTLE_MS = 6_000;
export const INTERRUPT_KINDS = new Set(['waiting', 'failed']);

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

/** A tool name may arrive as a string or as an object ({name} / {tool_name}). */
export function toolNameOf(value) {
  if (value == null) return null;
  if (typeof value === 'object') {
    const nested = value.name ?? value.tool_name ?? value.toolName ?? null;
    return typeof nested === 'string' && nested !== '' ? nested : null;
  }
  const s = String(value);
  return s === '' ? null : s;
}

/** Last path segment, tolerant of both Windows and POSIX separators. */
export function projectName(p) {
  if (!p) return null;
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/**
 * createSpeech({clock, onLine, isMuted, random})
 *
 * clock    — {now()} or a () => ms function.
 * onLine   — called synchronously with {text, kind, mode, source, summary};
 *            `text` matches the ganyu:speak payload.
 * isMuted  — () => bool. Muted means no line at all.
 * random   — injectable for deterministic variant choice in tests.
 */
export function createSpeech({
  clock = { now: () => Date.now() },
  onLine = () => {},
  isMuted = () => false,
  random = Math.random,
} = {}) {
  const now = () => (typeof clock === 'function' ? clock() : clock.now());
  const muted = () => (typeof isMuted === 'function' ? Boolean(isMuted()) : Boolean(isMuted));

  let lastSpokeAt = null;
  let lastMode = null;
  const toolClasses = new Map(); // sessionId -> last tool class
  const lastLines = new Map(); // kind -> last line used, so variants alternate

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
    // `tool` and `failed` are module B's spellings (state.mjs normalizeEvent) and
    // module A forwards B's normalized event verbatim, with no `payload`. Reading
    // only `toolName`/`errorish` left toolName null in production, so the busy
    // trigger could never fire and the line never carried a tool name.
    const toolName = toolNameOf(input.toolName ?? input.tool ?? p.tool_name ?? p.toolName ?? p.tool);
    const project =
      input.project ?? projectName(input.cwd ?? p.cwd ?? p.project_dir ?? p.workspace ?? null);
    // Whether something failed is module B's call (state.mjs hasErrorMarker), and
    // speech trusts it. Speech used to re-derive it by scanning payload text,
    // which flagged 36 of 42 live events as failures.
    const errorish = Boolean(input.errorish ?? input.failed);
    // An errorish event is `failed` whatever its event name says: a PostToolUse
    // carrying an error arrives with mode 'busy', which would otherwise shadow it.
    const mode = errorish ? 'failed' : (input.mode ?? modeForEvent(event, errorish));
    return { source, event, sessionId, toolName, project, errorish, mode };
  }

  /** Trigger rules. Also updates mode / tool-class tracking. */
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

  function waitFor(kind, t) {
    if (lastSpokeAt === null || INTERRUPT_KINDS.has(kind)) return 0;
    return Math.max(0, THROTTLE_MS - (t - lastSpokeAt));
  }

  function emit(line) {
    try {
      onLine(line);
    } catch {
      /* never let a listener break the pet */
    }
  }

  /**
   * Feed one normalized-or-raw event. Returns a descriptor:
   * {spoken, reason: 'no-trigger'|'muted'|'throttled'|'spoken', kind, ...}
   */
  function notify(input = {}) {
    const ev = normalizeEvent(input);
    const kind = decideTrigger(ev);
    if (!kind) return { spoken: false, reason: 'no-trigger', kind: null };
    if (muted()) return { spoken: false, reason: 'muted', kind };

    const t = now();
    const wait = waitFor(kind, t);
    if (wait > 0) {
      // Dropped, not queued: a status line is only useful while it is still
      // true, and a queued one would narrate work that ended six seconds ago.
      return { spoken: false, reason: 'throttled', kind, retryInMs: wait };
    }

    const summary = buildSummary(ev);
    const text = messageFor(kind, {
      tool: ev.toolName,
      project: ev.project,
      random,
      avoid: lastLines.get(kind) ?? null,
    });
    if (!text) return { spoken: false, reason: 'no-line', kind, summary };

    lastLines.set(kind, text);
    lastSpokeAt = t;
    emit({ text, kind, mode: ev.mode ?? null, source: ev.source, summary });
    return { spoken: true, reason: 'spoken', kind, text, summary };
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
      return { lastSpokeAt, lastMode };
    },
    dispose() {
      toolClasses.clear();
      lastLines.clear();
    },
  };
}

export default createSpeech;
