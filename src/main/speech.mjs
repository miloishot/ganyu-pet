// Module D — speech: decides when Ganyu says something and turns the hook event
// into a status line.
//
// Two sources, one gate. The deterministic MESSAGES table in persona.mjs is the
// baseline and is always available: the bubble is a status indicator, so for
// `waiting` / `failed` it has to appear the instant the event lands, which no
// network round-trip can promise. An optional brain (brain.mjs) writes a better
// line for the same event; when it arrives in time it replaces the canned one,
// and when it doesn't — unconfigured, slow, failing — nothing about the old
// behaviour changes. Both sources emit through `show()`, so mute and the
// throttle gate them identically.
// No Electron import; every side effect is injectable.

import { pickToolInput, projectFromCwd } from './context.mjs';
import { buildSummary, messageFor } from './persona.mjs';

/** Minimum gap between lines. `waiting` / `failed` ignore it — they are the point. */
export const THROTTLE_MS = 6_000;

/** How many of her own lines she remembers, and is reminded of, at a time. */
export const RECENT_LINES = 3;
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

/**
 * Last path segment, tolerant of both Windows and POSIX separators — with one
 * exception, which is why it lives in context.mjs rather than here: an Orca
 * worktree keeps `<repo>/<worktree>`, since "bay-daily-codes" alone does not say
 * which repo it belongs to.
 */
export const projectName = projectFromCwd;

/**
 * createSpeech({clock, onLine, isMuted, random, brain})
 *
 * clock    — {now()} or a () => ms function.
 * onLine   — called synchronously with {text, kind, mode, source, summary};
 *            `text` matches the ganyu:speak payload.
 * isMuted  — () => bool. Muted means no line at all.
 * random   — injectable for deterministic variant choice in tests.
 * brain    — optional {requestLine({detail, summary})} -> Promise<string|null>.
 *            Absent (the default) is the original synchronous behaviour, exactly.
 */
export function createSpeech({
  clock = { now: () => Date.now() },
  onLine = () => {},
  isMuted = () => false,
  random = Math.random,
  brain = null,
} = {}) {
  const now = () => (typeof clock === 'function' ? clock() : clock.now());
  const muted = () => (typeof isMuted === 'function' ? Boolean(isMuted()) : Boolean(isMuted));

  const askBrain = typeof brain?.requestLine === 'function' ? brain : null;

  let lastSpokeAt = null;
  let lastMode = null;
  let shownCount = 0; // bumped on every emitted line; a brain reply for an older one is stale
  const toolClasses = new Map(); // sessionId -> last tool class
  // The last few lines she actually said, newest first. One store serving two
  // readers: `avoid` keeps the canned table off the variant it just used, and the
  // brain is told the same lines so it does not paraphrase itself all evening.
  const recentLines = [];

  function rememberLine(kind, text, fromTable) {
    recentLines.unshift({ kind, text, fromTable });
    if (recentLines.length > RECENT_LINES) recentLines.length = RECENT_LINES;
  }

  /** Only table lines: a generated line is never a variant, so it would disable `avoid`. */
  const avoidFor = (kind) => recentLines.find((l) => l.fromTable && l.kind === kind)?.text ?? null;
  const spokenLines = () => recentLines.map((l) => l.text);

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
    // What the tool was actually asked to do — the difference between "running a
    // tool" and "editing persona.mjs". Reduced to the allowlisted keys here, at
    // the edge, so the keys carrying his code (old_string, content, prompt) do
    // not travel any further into the app than the event that carried them.
    const toolInput = pickToolInput(input.toolInput ?? input.tool_input ?? p.tool_input);
    const agentType = input.agentType ?? p.agent_type ?? null;
    return { source, event, sessionId, toolName, project, errorish, mode, toolInput, agentType };
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
   * The single gate every line passes through, canned or generated. Mute and the
   * throttle are checked here rather than at the trigger, because a brain reply
   * is shown some seconds after its event: by then the owner may have muted her,
   * or a newer line may already own the bubble.
   */
  function show(kind, text, ev, summary, fromTable = true) {
    if (!text) return { spoken: false, reason: 'no-line', kind, summary };
    if (muted()) return { spoken: false, reason: 'muted', kind, summary };

    const t = now();
    const wait = waitFor(kind, t);
    if (wait > 0) {
      // Dropped, not queued: a status line is only useful while it is still
      // true, and a queued one would narrate work that ended six seconds ago.
      return { spoken: false, reason: 'throttled', kind, retryInMs: wait, summary };
    }

    rememberLine(kind, text, fromTable);
    lastSpokeAt = t;
    shownCount += 1;
    emit({ text, kind, mode: ev.mode ?? null, source: ev.source, summary });
    return { spoken: true, reason: 'spoken', kind, text, summary };
  }

  /** What the brain is told about the event. Metadata only — see brain.mjs. */
  function brainDetail(ev, kind) {
    return {
      kind,
      event: ev.event,
      tool: ev.toolName,
      project: ev.project,
      mode: ev.mode ?? null,
      source: ev.source,
      toolInput: ev.toolInput ?? {},
      agentType: ev.agentType ?? null,
      recentLines: spokenLines(),
    };
  }

  /**
   * Ask the brain, then show its line — or, for a non-urgent kind that got
   * nothing back, the canned line it was standing in for. `seq` is the emitted-
   * line count at the moment the request was fired: if it has moved, another
   * event has taken the bubble since and this reply is about old news.
   */
  async function awaitBrain({ kind, ev, summary, canned, seq, urgent }) {
    let line = null;
    try {
      line = await askBrain.requestLine({ detail: brainDetail(ev, kind), summary });
    } catch {
      line = null; // requestLine promises never to reject; belt and braces
    }
    if (shownCount !== seq) return { spoken: false, reason: 'stale', kind, summary };
    if (line) return show(kind, line, ev, summary, false);
    // Urgent kinds already showed their canned line; do not repeat it.
    if (urgent) return { spoken: false, reason: 'brain-empty', kind, summary };
    return show(kind, canned, ev, summary);
  }

  /**
   * Feed one normalized-or-raw event. Returns a descriptor:
   * {spoken, reason: 'no-trigger'|'muted'|'throttled'|'spoken'|'brain-pending', kind, ...}
   *
   * With a brain configured the descriptor also carries `pending`, a promise of
   * the descriptor for whatever the brain path ends up showing.
   */
  function notify(input = {}) {
    const ev = normalizeEvent(input);
    const kind = decideTrigger(ev);
    if (!kind) return { spoken: false, reason: 'no-trigger', kind: null };
    if (muted()) return { spoken: false, reason: 'muted', kind };

    const wait = waitFor(kind, now());
    if (wait > 0) return { spoken: false, reason: 'throttled', kind, retryInMs: wait };

    const summary = buildSummary(ev);
    const canned = messageFor(kind, {
      tool: ev.toolName,
      project: ev.project,
      random,
      avoid: avoidFor(kind),
    });

    if (!askBrain) return show(kind, canned, ev, summary);

    // `waiting` and `failed` are the whole point of the pet: they show at once,
    // at the old latency, and a better line only replaces them if one arrives.
    // Everything else can afford to wait for the brain before showing anything,
    // which avoids a visible flip from canned to generated on every event.
    const urgent = INTERRUPT_KINDS.has(kind);
    const first = urgent ? show(kind, canned, ev, summary) : null;
    const pending = awaitBrain({ kind, ev, summary, canned, seq: shownCount, urgent });
    return urgent
      ? { ...first, pending }
      : { spoken: false, reason: 'brain-pending', kind, summary, pending };
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
      recentLines.length = 0;
    },
  };
}

export default createSpeech;
