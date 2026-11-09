// ganyu-pet — OpenCode plugin. Installed by `node hooks/install-hooks.mjs`
// into <opencode config dir>/plugins/ganyu.js.
//
// OpenCode has no stdin hook commands, so this plugin plays the part that
// hooks/ganyu-hook.cmd plays for codex and Claude Code: it maps OpenCode events
// onto the hook_event_name vocabulary src/main/state.mjs already understands and
// POSTs a small JSON body to http://127.0.0.1:<port>/event/opencode.
//
// Rules (contracts.md §Hook delivery → OpenCode):
//   - never block, slow or crash OpenCode: nothing is awaited, every POST is
//     fire-and-forget with a 1s abort, every error is swallowed, nothing printed;
//   - privacy: the body carries only hook_event_name, session_id, tool_name,
//     cwd, and (session errors only) a short error kind — never prompt or message
//     text, tool arguments, tool output or file contents;
//   - port: GANYU_PORT, else 47821 (the same rule as ganyu-hook.cmd).
//
// Export shape: OpenCode 1.18 calls *every* exported function as a plugin, so
// this file exports exactly one thing.

const DEFAULT_PORT = 47821;
const TIMEOUT_MS = 1000;
const MAX_CHILDREN = 500;
const MAX_FIELD = 128;

function port() {
  const n = Number(globalThis.process?.env?.GANYU_PORT);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : DEFAULT_PORT;
}

/** Short identifier-ish strings only — anything else is dropped, not truncated into a leak. */
function token(value) {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  return v !== '' && v.length <= MAX_FIELD && /^[\w.:\-/ ]+$/.test(v) ? v : undefined;
}

function post(body) {
  try {
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
    const pending = globalThis.fetch(`http://127.0.0.1:${port()}/event/opencode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (pending && typeof pending.then === 'function') {
      pending.then((res) => res?.body?.cancel?.(), () => {}).catch(() => {});
    }
  } catch {
    // The pet is optional. Nothing reaches OpenCode's UI.
  }
}

export const GanyuPlugin = async (ctx) => {
  const cwd = typeof ctx?.directory === 'string' ? ctx.directory
    : typeof ctx?.worktree === 'string' ? ctx.worktree : undefined;

  // Subagent sessions (info.parentID set) report under their parent, so a
  // finishing subagent reads as SubagentStop (still busy), not as a Stop.
  const parentOf = new Map();

  function send(event, sessionID, extra = {}) {
    const raw = token(sessionID);
    if (!raw) return;
    const parent = parentOf.get(raw);
    const name = parent && event === 'Stop' ? 'SubagentStop'
      : parent && event === 'SessionStart' ? 'SubagentStart'
        : event;
    const body = { hook_event_name: name, session_id: parent ?? raw };
    const tool = token(extra.tool);
    if (tool) body.tool_name = tool;
    if (cwd) body.cwd = cwd;
    const error = token(extra.error);
    if (error) body.error = error;
    post(body);
  }

  function remember(info) {
    const id = token(info?.id);
    const parent = token(info?.parentID);
    if (!id || !parent) return;
    if (parentOf.size >= MAX_CHILDREN) parentOf.delete(parentOf.keys().next().value);
    parentOf.set(id, parentOf.get(parent) ?? parent);
  }

  function onEvent(event) {
    const type = event?.type;
    const p = event?.properties ?? {};
    switch (type) {
      case 'session.created':
        remember(p.info);
        send('SessionStart', p.sessionID ?? p.info?.id);
        break;
      case 'session.updated':
        remember(p.info);
        break;
      case 'session.idle':
        send('Stop', p.sessionID);
        break;
      case 'session.error': {
        const kind = p.error?.name;
        // The owner pressing abort is not a failure; the session.idle that
        // follows settles the pet.
        if (kind === 'MessageAbortedError') break;
        send('Stop', p.sessionID, { error: token(kind) ?? 'UnknownError' });
        break;
      }
      case 'session.deleted': {
        const id = p.sessionID ?? p.info?.id;
        send('SessionEnd', id);
        parentOf.delete(token(id));
        break;
      }
      case 'permission.asked':
        send('PermissionRequest', p.sessionID, { tool: p.permission });
        break;
      case 'question.asked':
        send('PermissionRequest', p.sessionID);
        break;
      case 'permission.replied':
      case 'question.replied':
      case 'question.rejected':
        send('PostToolUse', p.sessionID);
        break;
      case 'message.part.updated': {
        const part = p.part;
        const status = part?.state?.status;
        if (part?.type === 'tool' && (status === 'completed' || status === 'error')) {
          send('PostToolUse', p.sessionID ?? part.sessionID, { tool: part.tool });
        }
        break;
      }
      default:
        break;
    }
  }

  const guard = (fn) => (...args) => {
    try {
      fn(...args);
    } catch {
      // never let the pet break OpenCode
    }
  };

  return {
    // Not awaited by OpenCode; returns at once anyway.
    event: guard(({ event } = {}) => onEvent(event)),
    // Trigger hooks ARE awaited, so they return synchronously and never await the POST.
    'tool.execute.before': guard((input) => send('PreToolUse', input?.sessionID, { tool: input?.tool })),
    'chat.message': guard((input) => send('UserPromptSubmit', input?.sessionID)),
  };
};
