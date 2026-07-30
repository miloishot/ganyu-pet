// Module chat — the owner's half of the conversation.
//
// Everything before this file was one-way: hooks fired, she reacted. This is
// the path in the other direction. It is deliberately pure — no Electron, no
// timers it did not receive, no knowledge of IPC — so the whole conversation
// can be driven from a unit test with a fake brain.
//
// The one hard promise: `send()` always resolves. A line, or null. Never a
// rejection and never a hang, because the renderer puts a "thinking" bubble up
// the moment it calls this, and something has to take that bubble back down.

/** A pasted essay is not a chat message. Longer input is cut, not rejected. */
export const MAX_INPUT_CHARS = 500;

/** Exchanges kept in the rolling window (one exchange = his line + her reply). */
export const DEFAULT_MAX_TURNS = 8;

/**
 * Backstop only. The brain's own request timeout is 10s and it resolves null
 * rather than rejecting, so this fires only if a brain misbehaves — but a
 * promise that never settles would wedge the single-flight latch for the rest
 * of the session and leave the pending bubble up forever, so it is worth the
 * six lines.
 */
export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Channels for the chat path. window.mjs owns CHANNELS and the original five;
 * these two are registered by index.mjs directly, and named in the same style.
 * The preload hardcodes the same strings (it is CommonJS and cannot import an
 * ESM module), exactly as it already does for the other five.
 */
export const CHAT_CHANNELS = Object.freeze({
  chat: 'ganyu:chat',
  setFocus: 'ganyu:set-focus',
});

/**
 * Fallback phrasing when the brain predates `requestChat`. It goes in as
 * `summary`, which persona.buildBrainInput renders verbatim after "Just
 * happened:", so it is written to read naturally in that slot.
 */
const FALLBACK_SUMMARY_PREFIX = 'the owner is speaking to you directly and just said';

/** One line: whitespace collapsed (the input is single-line), trimmed, capped. */
function cleanInput(raw) {
  const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  return text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS).trim() : text;
}

/** A usable reply, or null. Blank and non-strings are both "no reply". */
function cleanReply(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  return text === '' ? null : text;
}

/**
 * createChat({brain, maxTurns, now}) -> {send, history, clear, pending}
 *
 * `brain` is module D's brain, or anything shaped like it. `requestChat` is the
 * seam that matters — see `ask()` for the exact call and why `requestLine` is
 * only a fallback.
 */
export function createChat({
  brain = null,
  maxTurns = DEFAULT_MAX_TURNS,
  now = Date.now,
  timeoutMs = REQUEST_TIMEOUT_MS,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
} = {}) {
  const turns = Number.isFinite(maxTurns) && maxTurns > 0 ? Math.floor(maxTurns) : DEFAULT_MAX_TURNS;
  const entries = [];
  let inFlight = false;

  const ownerCount = () => entries.reduce((n, e) => n + (e.role === 'owner' ? 1 : 0), 0);

  /**
   * Append, then drop whole exchanges off the front — his line and the reply it
   * earned — rather than individual entries, so the window never opens on an
   * answer to a question that is no longer there.
   */
  function record(role, text) {
    entries.push({ role, text, at: now() });
    while (ownerCount() > turns) {
      entries.shift();
      while (entries.length > 0 && entries[0].role === 'ganyu') entries.shift();
    }
  }

  function history() {
    return entries.map((entry) => ({ ...entry }));
  }

  /**
   * Ask for a CHAT reply — an answer to what he said, not a status line about
   * what his agent did. `brain.requestChat({text, history})` is the real seam;
   * `requestLine` is the fallback for a brain built before it existed, handed a
   * chat-shaped detail so it at least knows it is being spoken to.
   */
  function ask(text, priorHistory) {
    if (!brain) return null;
    if (typeof brain.requestChat === 'function') {
      return brain.requestChat({ text, history: priorHistory });
    }
    if (typeof brain.requestLine === 'function') {
      return brain.requestLine({
        detail: { kind: 'chat', mode: 'chat', text, history: priorHistory },
        summary: `${FALLBACK_SUMMARY_PREFIX}: "${text}"`,
      });
    }
    return null;
  }

  function withTimeout(promise) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
    let timer = null;
    const guard = new Promise((resolve) => {
      timer = schedule(() => resolve(null), timeoutMs);
    });
    return Promise.race([promise, guard]).finally(() => {
      if (timer !== null) cancel(timer);
    });
  }

  /**
   * One message in, one reply or null out.
   *
   * Single-flight rather than queued: a queued message would be answered against
   * a conversation he has already moved on from, and the renderer can only show
   * one bubble anyway. A second send while one is pending resolves null, and the
   * renderer keeps its pending bubble up for the first one.
   */
  async function send(raw) {
    const text = cleanInput(raw);
    if (text === '' || inFlight) return null;
    inFlight = true;
    try {
      // Snapshot first: `history` is the conversation *before* this message, and
      // `text` carries the message itself. Recording his line before the await
      // means a failed reply still leaves what he said in the window.
      const priorHistory = history();
      record('owner', text);

      const reply = cleanReply(await withTimeout(Promise.resolve().then(() => ask(text, priorHistory))));
      if (reply) record('ganyu', reply);
      return reply;
    } catch {
      // A brain that rejects is a brain that failed; the renderer needs a null,
      // not an exception it would have to translate into one anyway.
      return null;
    } finally {
      inFlight = false;
    }
  }

  return {
    send,
    history,
    clear() {
      entries.length = 0;
    },
    get pending() {
      return inFlight;
    },
  };
}

export default createChat;
