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
//
// The conversation now survives a restart. It used to live in this array and
// nowhere else, so quitting the pet erased every word they had ever exchanged —
// and a pet that is told she remembers things (§Ledger, and the one capability
// BRAIN_INSTRUCTIONS lets her claim) forgetting the actual conversation was the
// same defect the ledger was built to fix, one module along. Storage follows
// ledger.mjs exactly: append-only JSONL, `fs` and the path injected so this file
// stays Electron-free, corrupt lines skipped rather than thrown on, bounded, and
// rebuilt field by field on the way in *and* out.
//
// The two windows are different sizes on purpose. `DEFAULT_MAX_TURNS` (8) is
// what goes into the prompt, and it is a limit on *her attention* — a longer
// conversation in one request makes her worse, not better. The file's cap is a
// limit on *disk*, and there is no reason for it to be the same number.

/** A pasted essay is not a chat message. Longer input is cut, not rejected. */
export const MAX_INPUT_CHARS = 500;

/** Exchanges kept in the rolling window (one exchange = his line + her reply). */
export const DEFAULT_MAX_TURNS = 8;

/**
 * Exchanges kept on disk — what survives a restart, as opposed to what goes into
 * one request. At most 400 JSONL lines, the same order as the ledger's 500
 * entries, and around 100KB at the input cap above.
 *
 * He speaks to a desktop pet a handful of times an evening, so 200 exchanges is
 * months of conversation rather than days: long enough that "you asked me about
 * that last night" is true, and so is "you asked me that last week". Short
 * enough that the whole file is read on every append without it being noticeable,
 * and bounded, so a pet left running all year cannot fill a disk.
 */
export const DEFAULT_MAX_STORED_TURNS = 200;

/** The only roles that may be written. Anything else is not a turn. */
export const CHAT_ROLES = Object.freeze(['owner', 'ganyu']);

/** The whole of a stored turn. Nothing else is ever written — see sanitizeTurn. */
export const TURN_KEYS = Object.freeze(['at', 'role', 'text']);

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

/** A timestamp, or null. Spelled out because `Number(null)` is a Tuesday in 1970. */
function finiteMs(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Parent directory of a path, either separator. Null when there isn't one. */
function parentDir(p) {
  const s = String(p ?? '');
  const cut = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return cut > 0 ? s.slice(0, cut) : null;
}

/**
 * `sanitizeTurn(entry, fallbackAt)` — the storable form of one turn, or null if
 * there is nothing storable in it.
 *
 * Built out of three named fields rather than copied from the caller's object,
 * for the same reason `ledger.sanitizeEntry` is: a key nothing here reads has no
 * code path onto the disk. It runs on the way in *and* on the way back out, so a
 * hand-edited or half-written file cannot smuggle a field in either.
 */
export function sanitizeTurn(entry, fallbackAt = null) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;

  const role = typeof entry.role === 'string' ? entry.role.trim() : '';
  if (!CHAT_ROLES.includes(role)) return null;

  const text = typeof entry.text === 'string' ? entry.text.replace(/\s+/g, ' ').trim() : '';
  if (text === '') return null;

  const at = finiteMs(entry.at) ?? finiteMs(fallbackAt);
  if (at === null) return null;

  return { at, role, text: text.length <= MAX_INPUT_CHARS ? text : text.slice(0, MAX_INPUT_CHARS).trim() };
}

/**
 * The newest `turns` exchanges, dropped as whole exchanges — his line and the
 * reply it earned — exactly as the in-memory window drops them, so neither the
 * file nor the prompt ever opens on an answer whose question is no longer there.
 *
 * An exchange starts at an owner turn, so this walks back to the `turns`th
 * newest owner line and keeps everything from there — including a leading reply
 * that a hand-edited file might have left with no question in front of it, which
 * is dropped for the same reason. An unanswered message keeps its slot: it is
 * still a thing he said.
 */
function newestExchanges(entries, turns) {
  let owners = 0;
  let cut = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].role !== 'owner') continue;
    owners += 1;
    cut = i;
    if (owners === turns) break;
  }
  return cut === -1 ? [] : entries.slice(cut);
}

/**
 * The durable half. Append-only JSONL under a path the caller resolves (module A
 * puts it in Electron's `userData`, beside the ledger), pruned back to `turns`
 * exchanges newest-kept via temp-file-then-rename, so a crash mid-prune costs
 * the temp file and not the conversation.
 *
 * With no path or no fs this is a no-op that still answers every call, so
 * `createChat` needs no branch for "he has no disk" — which is also what every
 * existing test that constructs a chat without a file gets, unchanged.
 */
function createStore({ filePath = null, fs = null, turns = DEFAULT_MAX_STORED_TURNS } = {}) {
  const usable = Boolean(filePath)
    && Boolean(fs)
    && typeof fs.appendFileSync === 'function'
    && typeof fs.readFileSync === 'function'
    && typeof fs.writeFileSync === 'function';

  if (!usable) {
    return {
      enabled: false,
      path: filePath ?? null,
      read: () => [],
      append: () => null,
      clear: () => false,
      stats: () => ({ path: filePath ?? null, enabled: false, turns: 0, exchanges: 0, oldest: null, newest: null, maxStoredTurns: turns }),
    };
  }

  const path = String(filePath);
  const tempPath = `${path}.tmp`;
  let storedOwners = null; // unknown until something reads the file
  let dirReady = false;

  function ensureDir() {
    if (dirReady) return;
    const dir = parentDir(path);
    if (dir && typeof fs.mkdirSync === 'function') {
      const exists = typeof fs.existsSync === 'function' ? fs.existsSync(dir) : false;
      if (!exists) fs.mkdirSync(dir, { recursive: true });
    }
    dirReady = true;
  }

  /**
   * Every valid turn in the file, oldest first. A missing file, an unreadable
   * one and an empty one all mean the same thing — no history yet — and a
   * corrupt or half-written line is skipped rather than thrown on, because a
   * long-running process is appending to this and a crash truncates whatever
   * was mid-write.
   */
  function read() {
    let text = '';
    try {
      if (typeof fs.existsSync === 'function' && !fs.existsSync(path)) {
        storedOwners = 0;
        return [];
      }
      text = String(fs.readFileSync(path, 'utf8') ?? '');
    } catch {
      storedOwners = null; // unknown, not zero — do not prune on a read failure
      return [];
    }

    const turnsOut = [];
    let owners = 0;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line === '') continue;
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // a truncated tail, or something that was never JSON
      }
      const turn = sanitizeTurn(parsed);
      if (!turn) continue;
      turnsOut.push(turn);
      if (turn.role === 'owner') owners += 1;
    }
    storedOwners = owners;
    // A hand-edited file need not be in order, and the seeded window is read
    // off the end of this.
    turnsOut.sort((a, b) => a.at - b.at);
    return turnsOut;
  }

  /** Rewrite with the newest `turns` exchanges. Corrupt lines are dropped on the way. */
  function prune() {
    const kept = newestExchanges(read(), turns);
    const body = kept.map((turn) => `${JSON.stringify(turn)}\n`).join('');
    try {
      ensureDir();
      fs.writeFileSync(tempPath, body, 'utf8');
      if (typeof fs.renameSync === 'function') {
        fs.renameSync(tempPath, path);
      } else {
        // No rename available: the write itself is the risk window, and it is
        // narrower than leaving the file unbounded forever.
        fs.writeFileSync(path, body, 'utf8');
        try {
          fs.unlinkSync?.(tempPath);
        } catch { /* a stray temp file is harmless; the next prune overwrites it */ }
      }
      storedOwners = kept.reduce((n, turn) => n + (turn.role === 'owner' ? 1 : 0), 0);
      return true;
    } catch {
      // storedOwners is left above the cap on purpose: the next append retries.
      return false;
    }
  }

  return {
    enabled: true,
    path,
    read,
    /** One turn appended. Never throws: a pet who cannot write is still a pet. */
    append(entry, fallbackAt) {
      const turn = sanitizeTurn(entry, fallbackAt);
      if (!turn) return null;
      if (storedOwners === null) read();
      try {
        ensureDir();
        fs.appendFileSync(path, `${JSON.stringify(turn)}\n`, 'utf8');
      } catch {
        return null;
      }
      if (turn.role === 'owner') {
        storedOwners = (storedOwners ?? 0) + 1;
        if (storedOwners > turns) prune();
      }
      return turn;
    },
    /**
     * Forget the conversation, on disk as well as in memory. An empty file
     * rather than a deleted one: the next append then has nothing to recreate,
     * and `clear()` on a pet whose disk has gone read-only is still a `clear()`
     * of the window.
     */
    clear() {
      try {
        ensureDir();
        fs.writeFileSync(path, '', 'utf8');
        storedOwners = 0;
        return true;
      } catch {
        return false;
      }
    },
    stats() {
      const all = read();
      return {
        path,
        enabled: true,
        turns: all.length,
        exchanges: all.reduce((n, turn) => n + (turn.role === 'owner' ? 1 : 0), 0),
        oldest: all.length ? all[0].at : null,
        newest: all.length ? all[all.length - 1].at : null,
        maxStoredTurns: turns,
      };
    },
  };
}

/**
 * createChat({brain, maxTurns, now, filePath, fs, maxStoredTurns})
 *   -> {send, history, clear, pending, enabled, path, stats}
 *
 * `brain` is module D's brain, or anything shaped like it. `requestChat` is the
 * seam that matters — see `ask()` for the exact call and why `requestLine` is
 * only a fallback.
 *
 * `filePath` + `fs` are the durable conversation (see createStore). Both absent
 * is the original behaviour: she talks, and forgets at the door.
 */
export function createChat({
  brain = null,
  maxTurns = DEFAULT_MAX_TURNS,
  now = Date.now,
  timeoutMs = REQUEST_TIMEOUT_MS,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
  filePath = null,
  fs = null,
  maxStoredTurns = DEFAULT_MAX_STORED_TURNS,
} = {}) {
  const turns = Number.isFinite(maxTurns) && maxTurns > 0 ? Math.floor(maxTurns) : DEFAULT_MAX_TURNS;
  const stored = Number.isFinite(maxStoredTurns) && maxStoredTurns > 0
    ? Math.floor(maxStoredTurns)
    : DEFAULT_MAX_STORED_TURNS;
  const store = createStore({ filePath, fs, turns: stored });

  /**
   * Seeded from the tail of the file, so the first thing she is handed after a
   * restart is the end of the last conversation rather than nothing. The window
   * is still `turns` exchanges — the file holds far more (see
   * DEFAULT_MAX_STORED_TURNS), and this takes only what a request may carry.
   */
  const entries = newestExchanges(store.read(), turns);
  let inFlight = false;

  const ownerCount = () => entries.reduce((n, e) => n + (e.role === 'owner' ? 1 : 0), 0);

  /**
   * Append, then drop whole exchanges off the front — his line and the reply it
   * earned — rather than individual entries, so the window never opens on an
   * answer to a question that is no longer there.
   *
   * The disk write is the same entry through the same rule, and its failure is
   * nobody's business here: a conversation he can still see is worth more than
   * one she can prove she wrote down.
   */
  function record(role, text) {
    const entry = { role, text, at: now() };
    entries.push(entry);
    while (ownerCount() > turns) {
      entries.shift();
      while (entries.length > 0 && entries[0].role === 'ganyu') entries.shift();
    }
    store.append(entry, Date.now());
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
    /** Whether the conversation is being written down at all. */
    enabled: store.enabled,
    path: store.path,
    /**
     * Forget it — the window *and* the file. Clearing only the window would
     * leave the conversation on disk to be seeded straight back in at the next
     * restart, which is the opposite of what asking to forget means.
     */
    clear() {
      entries.length = 0;
      store.clear();
    },
    get pending() {
      return inFlight;
    },
    /** Introspection for tests and debugging, in the shape ledger.stats() uses. */
    stats: store.stats,
  };
}

export default createChat;
