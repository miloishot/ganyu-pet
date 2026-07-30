// Module B — per-session state machine + priority aggregation.
// Dependency-free, no Electron import: usable from tests and from --standalone.

export const MODES = ['idle', 'busy', 'waiting', 'failed'];
export const PRIORITY = { idle: 0, busy: 1, waiting: 2, failed: 3 };
const MODE_BY_RANK = ['idle', 'busy', 'waiting', 'failed'];

export const SESSION_TTL_MS = 10 * 60 * 1000;
export const CELEBRATE_MS = 10 * 1000;
export const FAILED_STICKY_MS = 30 * 1000;

// Canonical form: lowercase, separators stripped. `PreToolUse`, `pre_tool_use`
// and `pre-tool-use` all collapse to `pretooluse`.
const canon = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const BUSY_EVENTS = new Set([
  'pretooluse',
  'posttooluse',
  'userpromptsubmit',
  'subagentstart',
  'subagentstop',
  'sessionstart',
]);
const WAITING_EVENTS = new Set(['permissionrequest', 'notification']);
const IDLE_EVENTS = new Set(['stop', 'sessionend']);

/** Fields whose *values* are scanned for error/failure wording. */
const ERROR_TEXT_FIELDS = [
  'tool_response', 'toolResponse', 'tool_result', 'toolResult', 'result', 'response',
  'output', 'stdout', 'stderr', 'error', 'errors', 'message', 'last_message', 'lastMessage',
  'last_assistant_message', 'summary', 'reason', 'detail', 'details',
];
/** Objects inspected one level deep for explicit failure flags. */
const ERROR_FLAG_CONTAINERS = ['tool_response', 'toolResponse', 'tool_result', 'toolResult', 'result', 'response'];
const ERROR_TEXT_RE = /\b(error|errors|errored|failed|failing|failure|exception|traceback)\b/i;

function normalizeClock(clock) {
  if (typeof clock === 'function') return () => Number(clock());
  if (clock && typeof clock.now === 'function') return () => Number(clock.now());
  return () => Date.now();
}

function isPresent(value) {
  if (value == null || value === false || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function isErrorFlag(key, value) {
  const k = canon(key);
  if (k === 'error' || k === 'errors' || k === 'failed' || k === 'failure') return isPresent(value);
  if (k === 'iserror' || k === 'isfailure' || k === 'iserr') return value === true;
  if (k === 'success' || k === 'ok') return value === false;
  if (k === 'exitcode' || k === 'returncode' || k === 'statuscode') {
    return value != null && value !== '' && Number(value) !== 0;
  }
  if (k === 'status' || k === 'state' || k === 'outcome' || k === 'resultstatus') {
    return typeof value === 'string' && /^(error|errored|failed|failure|fail)$/i.test(value.trim());
  }
  return false;
}

/** Flatten values (not keys) to text, depth- and width-capped. */
function textOf(value, depth = 0) {
  if (value == null) return '';
  const t = typeof value;
  if (t === 'string') return value;
  if (t === 'number' || t === 'boolean') return String(value);
  if (t !== 'object' || depth >= 4) return '';
  if (Array.isArray(value)) return value.slice(0, 25).map((v) => textOf(v, depth + 1)).join(' \n');
  return Object.values(value).slice(0, 50).map((v) => textOf(v, depth + 1)).join(' \n');
}

/**
 * True when the payload carries an error/failure marker. Only the fields listed
 * above are inspected — scanning the whole payload would false-positive on
 * `cwd: "C:\\repos\\error-handling"` or a `tool_input` command mentioning errors.
 */
export function hasErrorMarker(payload) {
  if (!payload || typeof payload !== 'object') return false;
  for (const [key, value] of Object.entries(payload)) {
    if (isErrorFlag(key, value)) return true;
  }
  for (const name of ERROR_FLAG_CONTAINERS) {
    const container = payload[name];
    if (!container || typeof container !== 'object' || Array.isArray(container)) continue;
    for (const [key, value] of Object.entries(container)) {
      if (isErrorFlag(key, value)) return true;
    }
  }
  for (const name of ERROR_TEXT_FIELDS) {
    if (!(name in payload)) continue;
    if (ERROR_TEXT_RE.test(textOf(payload[name]))) return true;
  }
  return false;
}

function pickEventName(payload) {
  const raw = payload.hook_event_name ?? payload.hookEventName ?? payload.event
    ?? payload.event_name ?? payload.eventName ?? payload.type ?? payload.hook;
  if (raw == null) return null;
  if (typeof raw === 'object') {
    const nested = raw.name ?? raw.type ?? raw.event ?? raw.event_name;
    return nested == null ? null : String(nested);
  }
  const str = String(raw).trim();
  return str === '' ? null : str;
}

export function modeForEvent(canonical) {
  if (!canonical) return null;
  if (BUSY_EVENTS.has(canonical)) return 'busy';
  if (WAITING_EVENTS.has(canonical)) return 'waiting';
  if (IDLE_EVENTS.has(canonical)) return 'idle';
  // Tolerant fallbacks for codex event names we have not seen yet.
  if (canonical.includes('permission') || canonical.includes('approval') || canonical.includes('elicit')) return 'waiting';
  if (canonical.startsWith('pretool') || canonical.startsWith('posttool') || canonical.startsWith('tooluse')) return 'busy';
  return null;
}

/**
 * Defensive normalization of a codex / Claude Code hook payload.
 * `mode === null` means "unknown event" → activity ping only.
 */
export function normalizeEvent(source, payload, at = Date.now()) {
  const src = typeof source === 'string' && source.trim() !== '' ? source.trim().toLowerCase() : 'unknown';
  const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const sessionId = String(
    body.session_id ?? body.thread_id ?? body.sessionId ?? body.threadId ?? body.conversation_id ?? `${src}-unknown`,
  );
  const event = pickEventName(body);
  const canonical = canon(event);
  const message = body.message ?? body.notification ?? body.last_message ?? body.reason ?? null;
  return {
    source: src,
    sessionId,
    event: event ?? null,
    canonical: canonical === '' ? null : canonical,
    mode: modeForEvent(canonical),
    failed: hasErrorMarker(body),
    tool: body.tool_name ?? body.toolName ?? body.tool ?? null,
    cwd: body.cwd ?? body.workspace ?? null,
    message: typeof message === 'string' ? message : null,
    permission: /permission|approve|approval|confirm/i.test(
      `${canonical} ${typeof message === 'string' ? message : ''}`,
    ),
    at,
  };
}

/**
 * createState({clock}) → {ingest, aggregate, onChange, ...}
 * `clock` may be a function or an object with `.now()`; both are accepted.
 */
export function createState({
  clock,
  sessionTtlMs = SESSION_TTL_MS,
  celebrateMs = CELEBRATE_MS,
  failedStickyMs = FAILED_STICKY_MS,
  log = console,
} = {}) {
  const now = normalizeClock(clock);
  const sessions = new Map();
  const changeListeners = new Set();
  const eventListeners = new Set();
  let walk = null;
  let lastSnapshotJson = null;

  const keyOf = (ev) => `${ev.source}::${ev.sessionId}`;

  function effectiveMode(session, t) {
    return session.failedUntil > t ? 'failed' : session.mode;
  }

  function aggregate() {
    const t = now();
    const live = [];
    let rank = 0;
    let celebrate = false;
    for (const session of sessions.values()) {
      if (t - session.lastSeen >= sessionTtlMs) continue;
      const mode = effectiveMode(session, t);
      rank = Math.max(rank, PRIORITY[mode] ?? 0);
      if (session.celebrateUntil > t) celebrate = true;
      live.push({ id: session.id, source: session.source, mode, lastSeen: session.lastSeen });
    }
    live.sort((a, b) => a.lastSeen - b.lastSeen || (a.id < b.id ? -1 : 1));
    return {
      mode: MODE_BY_RANK[rank],
      sessionCount: live.length,
      sessions: live,
      celebrate,
      wandering: walk !== null,
      walk,
    };
  }

  function notify(listeners, ...args) {
    for (const cb of listeners) {
      try {
        cb(...args);
      } catch (err) {
        log?.error?.(`ganyu-state: listener threw: ${err?.message ?? err}`);
      }
    }
  }

  /** Emit onChange only when the aggregate snapshot actually differs. */
  function emitChange(change) {
    const snapshot = aggregate();
    const json = JSON.stringify(snapshot);
    if (json === lastSnapshotJson) return snapshot;
    lastSnapshotJson = json;
    notify(changeListeners, snapshot, change ?? null);
    return snapshot;
  }

  function ingest(source, payload) {
    const ev = normalizeEvent(source, payload, now());
    const key = keyOf(ev);
    const session = sessions.get(key) ?? {
      id: ev.sessionId,
      source: ev.source,
      mode: 'idle',
      firstSeen: ev.at,
      lastSeen: ev.at,
      celebrateUntil: 0,
      failedUntil: 0,
      lastEvent: null,
      lastTool: null,
    };
    const previousMode = effectiveMode(session, ev.at);

    session.lastSeen = ev.at;
    session.lastEvent = ev.event;
    if (ev.tool) session.lastTool = ev.tool;
    if (ev.mode) session.mode = ev.mode;
    // `Stop` celebrates — unless this very payload failed, or the session is
    // still inside its sticky-failed window.
    if (ev.canonical === 'stop' && !ev.failed && !(session.failedUntil > ev.at)) {
      session.celebrateUntil = ev.at + celebrateMs;
    }
    if (ev.failed) {
      session.failedUntil = ev.at + failedStickyMs;
      session.celebrateUntil = 0;
    }
    sessions.set(key, session);

    ev.previousMode = previousMode;
    ev.sessionMode = effectiveMode(session, ev.at);
    notify(eventListeners, ev, aggregate());
    emitChange(ev);
    return ev;
  }

  /** Prune expired sessions and re-emit if the snapshot moved (celebrate/failed expiry). */
  function sweep() {
    const t = now();
    let pruned = 0;
    for (const [key, session] of sessions) {
      if (t - session.lastSeen >= sessionTtlMs) {
        sessions.delete(key);
        pruned += 1;
      }
    }
    emitChange(null);
    return pruned;
  }

  function setWalk(next) {
    const valid = next && (next.dir === 'left' || next.dir === 'right') ? { dir: next.dir } : null;
    walk = valid;
    return emitChange(null);
  }

  function onChange(cb) {
    changeListeners.add(cb);
    return () => changeListeners.delete(cb);
  }

  function onEvent(cb) {
    eventListeners.add(cb);
    return () => eventListeners.delete(cb);
  }

  return {
    ingest,
    aggregate,
    onChange,
    // additive, for module A/D/E wiring
    onEvent,
    sweep,
    setWalk,
    setWandering: (value) => setWalk(value === true ? { dir: 'right' } : (value || null)),
    get sessionCount() {
      return aggregate().sessionCount;
    },
  };
}

export default createState;
