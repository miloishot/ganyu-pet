// Module ledger — the things she has actually witnessed, written down.
//
// The bug this exists for: she told the owner "I've set that page aside for
// you". She had not, and could not have — nothing in the app remembered a
// single event past the moment it arrived. The voice examples in persona.mjs
// describe a secretary who keeps records ("I've written down where", "I've
// corrected the record", "That's done, and filed"), and with no storage behind
// them the model generalised from the register into a claim of capability. The
// owner asked how she does that, which was the right question, and the honest
// answer was that she doesn't. So: make it true.
//
// Append-only JSONL, one notable event per line, read back two ways: `digest()`
// hands her a short summary of the recent past unasked, and `search()` lets her
// go and look. Both matter, and for a while only the first existed — the file
// kept 500 entries and the digest could reach six hours of them, so the rest sat
// on the disk with no caller able to name them. It is her memory, not a log
// file — routine tool traffic never reaches it, because a ledger holding every
// Read is one nothing can be recalled from, and it would spend maxEntries in
// minutes. The caller has already decided what is notable (speech.mjs owns
// salience); this module only decides what is *storable*.
//
// PRIVACY — the same line context.mjs holds, enforced the same way: by
// construction, not by deletion. `sanitizeEntry` builds a new object out of six
// named fields and never copies the caller's, so a key it was not expecting has
// no code path onto the disk even when the caller hands one over. Paths,
// commands, tool names and project names may be written; file contents, diffs,
// prompt text and transcripts may not, ever. Values are strings only (an object
// smuggled under `detail` is dropped rather than serialised) and hard-clamped,
// so a caller that ignores all of the above still writes at most one short line.
//
// No Electron import, and `fs` is injected — the tests drive a fake and never
// touch a real disk.

/** How many entries survive a prune. A few days of notable events, not a log. */
export const DEFAULT_MAX_ENTRIES = 500;

/**
 * How far back `digest()` looks by default. Long enough to cover an evening's
 * work, short enough that this morning's failures are not reported as news.
 *
 * A **default**, and reachable from both ends: `digest({windowMs})` overrides it
 * per call, and `createLedger({digestWindowMs})` moves the default itself. It
 * used to be the only window there was, which meant the file held 500 entries
 * and six hours of them could be reached — the rest were on the disk and
 * unreachable by any caller. `search()` below is the other half of that fix.
 */
export const DIGEST_WINDOW_MS = 6 * 60 * 60 * 1000;

/** What `search()` returns when the caller does not say. A recall, not a dump. */
export const DEFAULT_SEARCH_LIMIT = 10;

/**
 * And the most it will ever return, whatever it is asked for. Results are read
 * by a model with a few hundred characters to answer in, so an unbounded search
 * would not be a better answer — it would be a worse one, more slowly.
 */
export const MAX_SEARCH_LIMIT = 50;

/**
 * The only kinds that may be written. They are speech.mjs's trigger kinds minus
 * `busy`: a tool-class change during ordinary work is exactly the traffic this
 * file exists to keep out. `notable` is the pattern level from `salienceOf`,
 * which has no trigger kind of its own.
 */
export const LEDGER_KINDS = Object.freeze([
  'greeting',
  'celebrate',
  'waiting',
  'failed',
  'recovered',
  'notable',
]);

/** The whole of an entry. Nothing else is ever written — see the privacy note. */
export const ENTRY_KEYS = Object.freeze(['at', 'kind', 'project', 'tool', 'detail', 'sessionId']);

/** A detail is one clause ("editing index.ts"), never a payload. */
export const MAX_DETAIL_CHARS = 120;

/** A project, tool or session id. Generous; nothing legitimate comes close. */
export const MAX_NAME_CHARS = 80;

/** The digest goes into every request, and long context makes her worse. */
export const MAX_DIGEST_CHARS = 320;

/** The four patterns speech.mjs tallies, as something she could actually say. */
const PATTERN_PHRASES = Object.freeze({
  'repeat-file': 'the same file kept coming back',
  'repeat-command': 'the same command run over and over',
  'many-sessions': 'a crowd of sessions at once',
  'project-run': 'a long unbroken run in one project',
});

/** A timestamp, or null. Spelled out because `Number(null)` is a Tuesday in 1970. */
function finiteMs(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** One line, collapsed, trimmed, hard-capped. Empty and non-strings are null. */
function shortText(value, max) {
  if (typeof value !== 'string') return null; // strings only: no objects, no arrays
  const s = value.replace(/\s+/g, ' ').trim();
  if (s === '') return null;
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Parent directory of a path, either separator. Null when there isn't one. */
function parentDir(p) {
  const s = String(p ?? '');
  const cut = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return cut > 0 ? s.slice(0, cut) : null;
}

/**
 * `sanitizeEntry(entry, fallbackAt)` — the storable form of what the caller
 * offered, or null if there is nothing storable in it.
 *
 * This is the privacy gate, and it works by building a fresh object rather than
 * copying and deleting: `old_string`, `new_string`, `content`, `prompt` and
 * every other key that carries the owner's actual work cannot reach the disk,
 * because nothing here reads them. It runs on the way in *and* on the way out,
 * so a hand-edited or half-written file cannot smuggle a field back in either.
 */
export function sanitizeEntry(entry, fallbackAt = null) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;

  const kind = typeof entry.kind === 'string' ? entry.kind.trim() : '';
  if (!LEDGER_KINDS.includes(kind)) return null;

  const at = finiteMs(entry.at) ?? finiteMs(fallbackAt);
  if (at === null) return null;

  const out = { at, kind };
  const project = shortText(entry.project, MAX_NAME_CHARS);
  const tool = shortText(entry.tool, MAX_NAME_CHARS);
  const detail = shortText(entry.detail, MAX_DETAIL_CHARS);
  const sessionId = shortText(entry.sessionId, MAX_NAME_CHARS);
  if (project) out.project = project;
  if (tool) out.tool = tool;
  if (detail) out.detail = detail;
  if (sessionId) out.sessionId = sessionId;
  return out;
}

/**
 * "about 40 minutes" / "about an hour and a half" / "about 3 hours". Null under
 * a minute. Deliberately the same phrasing as context.describeDuration and
 * deliberately a copy rather than an import: the two modules stay independent,
 * and this one must not grow a dependency on a module that is edited elsewhere.
 */
export function describeSpan(ms) {
  const minutes = Math.round(Number(ms) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return null;
  if (minutes < 75) return `about ${Math.max(5, Math.round(minutes / 5) * 5)} minutes`;
  const halves = Math.round(minutes / 30);
  const hours = Math.floor(halves / 2);
  if (halves % 2 === 1) return hours === 1 ? 'about an hour and a half' : `about ${hours} and a half hours`;
  return hours === 1 ? 'about an hour' : `about ${hours} hours`;
}

// Past four hours a duration stops being how a person says it — "about 5 hours
// ago" is arithmetic, "earlier this evening" is a memory. Two tables rather than
// one plus grammar, because "earlier this night" and "in the small hours today"
// are both wrong and no rule cheaply gets them right.
const DAYPART_BOUNDS = [5, 8, 12, 14, 18, 22];
const DAYPART_TODAY = [
  'in the small hours',
  'early this morning',
  'earlier this morning',
  'around midday',
  'earlier this afternoon',
  'earlier this evening',
  'earlier tonight',
];
const DAYPART_YESTERDAY = [
  'in the small hours yesterday',
  'early yesterday morning',
  'yesterday morning',
  'around midday yesterday',
  'yesterday afternoon',
  'yesterday evening',
  'last night',
];

function daypartIndex(hour) {
  let i = 0;
  for (const bound of DAYPART_BOUNDS) if (hour >= bound) i += 1;
  return i;
}

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * `describeAgo(at, now)` — when something happened, as she would say it: "just
 * now", "about 40 minutes ago", "earlier this evening", "last night". The
 * crossover at four hours is where the arithmetic form stops sounding like a
 * memory; the crossover into the yesterday table is the calendar day, which for
 * this owner is a thing that happens mid-session.
 */
export function describeAgo(at, now) {
  const from = finiteMs(at);
  const to = finiteMs(now);
  if (from === null || to === null) return null;
  const gap = to - from;
  if (gap < 60_000) return 'just now';
  if (gap < 4 * 60 * 60 * 1000) {
    const span = describeSpan(gap);
    return span ? `${span} ago` : 'just now';
  }
  const then = new Date(from);
  const days = Math.round((startOfDay(new Date(to)) - startOfDay(then)) / 86_400_000);
  const part = daypartIndex(then.getHours());
  if (days <= 0) return DAYPART_TODAY[part];
  if (days === 1) return DAYPART_YESTERDAY[part];
  return `${days} days ago`;
}

const countPhrase = (n, one, many = `${one}s`) => (n === 1 ? `one ${one}` : `${n} ${many}`);

/**
 * createLedger({filePath, fs, now, maxEntries})
 *
 * filePath   — where the JSONL lives. The parent directory is created if missing.
 * fs         — node:fs shaped: existsSync / readFileSync / appendFileSync /
 *              writeFileSync / mkdirSync, plus renameSync and unlinkSync if the
 *              platform has them (the prune degrades gracefully without them).
 * now        — () => ms, injected so the digest's relative phrasing is testable.
 * maxEntries — the file is pruned back to this many, newest kept.
 * digestWindowMs — how far back `digest()` looks when the call does not say.
 *
 * Every read hits the file. It is at most `maxEntries` short lines and notable
 * events are minutes apart, so a cache would buy nothing and would go stale the
 * moment anything else touched the file.
 *
 * With no path or no fs the whole thing is a no-op that still answers every
 * call — module A can construct it unconditionally, exactly as it does the brain.
 */
export function createLedger({
  filePath = null,
  fs = null,
  now = Date.now,
  maxEntries = DEFAULT_MAX_ENTRIES,
  digestWindowMs = DIGEST_WINDOW_MS,
} = {}) {
  const clock = () => {
    const t = Number(typeof now === 'function' ? now() : now);
    return Number.isFinite(t) ? t : Date.now();
  };

  const capRaw = Number(maxEntries);
  const cap = Number.isFinite(capRaw) && capRaw > 0 ? Math.floor(capRaw) : DEFAULT_MAX_ENTRIES;

  const windowRaw = Number(digestWindowMs);
  const defaultWindowMs = Number.isFinite(windowRaw) && windowRaw > 0 ? windowRaw : DIGEST_WINDOW_MS;

  const usable = Boolean(filePath)
    && Boolean(fs)
    && typeof fs.appendFileSync === 'function'
    && typeof fs.readFileSync === 'function'
    && typeof fs.writeFileSync === 'function';

  if (!usable) {
    return {
      enabled: false,
      path: filePath ?? null,
      record: () => null,
      recent: () => [],
      since: () => [],
      forProject: () => [],
      search: () => [],
      digest: () => null,
      stats: () => ({ path: filePath ?? null, enabled: false, entries: 0, oldest: null, newest: null, maxEntries: cap }),
    };
  }

  const path = String(filePath);
  const tempPath = `${path}.tmp`;
  let lineCount = null; // unknown until something reads the file
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
   * Every valid entry in the file, oldest first, and `lineCount` refreshed on
   * the way past. A corrupt or half-written line is skipped, never thrown on:
   * this file is appended to by a long-running process and a crash truncates
   * whatever was mid-write. A missing file is simply an empty ledger.
   */
  function readAll() {
    let text = '';
    try {
      if (typeof fs.existsSync === 'function' && !fs.existsSync(path)) {
        lineCount = 0;
        return [];
      }
      text = String(fs.readFileSync(path, 'utf8') ?? '');
    } catch {
      lineCount = null; // unknown, not zero — do not prune on a read failure
      return [];
    }

    const entries = [];
    let lines = 0;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line === '') continue;
      lines += 1;
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // a truncated tail, or something that was never JSON
      }
      const entry = sanitizeEntry(parsed);
      if (entry) entries.push(entry);
    }
    lineCount = lines;
    // A hand-edited file need not be in order, and the digest's "going back"
    // phrase reads the first element.
    entries.sort((a, b) => a.at - b.at);
    return entries;
  }

  /**
   * Rewrite the file with the newest `cap` entries. Temp file then rename, so a
   * crash mid-prune costs the temp file and not the ledger; if the rename throws
   * the original is still exactly where it was, which is the property the test
   * pins. Corrupt lines are dropped on the way through, so a prune also repairs.
   */
  function prune() {
    const kept = readAll().slice(-cap);
    const body = kept.map((entry) => `${JSON.stringify(entry)}\n`).join('');
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
      lineCount = kept.length;
      return true;
    } catch {
      // lineCount is left above the cap on purpose: the next record retries.
      return false;
    }
  }

  /**
   * `record(entry)` — append one notable thing. Returns the entry as stored, or
   * null when there was nothing storable (unknown kind, unusable shape) or the
   * write failed. Never throws: a pet that cannot write her diary is still a pet.
   */
  function record(input) {
    const entry = sanitizeEntry(input, clock());
    if (!entry) return null;
    if (lineCount === null) readAll();
    try {
      ensureDir();
      fs.appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {
      return null;
    }
    lineCount = (lineCount ?? 0) + 1;
    if (lineCount > cap) prune();
    return entry;
  }

  const limitOf = (n, fallback) => {
    const value = Number(n);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  };

  /**
   * How a project or tool name is matched: case-insensitively, because Windows
   * hands the same directory back in whatever case it was typed in and
   * `ganyu-pet` and `Ganyu-Pet` are not two projects. Empty means "no filter".
   */
  const nameKey = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

  /** The newest `n`, newest first. Every read in this module is newest first. */
  function recent(n = 10) {
    return readAll().slice(-limitOf(n, 10)).reverse();
  }

  /** Everything at or after `ms`, newest first. An unusable timestamp is "all of it". */
  function since(ms) {
    const from = finiteMs(ms);
    const all = readAll();
    return (from === null ? all : all.filter((e) => e.at >= from)).reverse();
  }

  /** Recall scoped to one project, newest first. Matched by `nameKey` above. */
  function forProject(name, n = 10) {
    const key = nameKey(name);
    if (key === '') return [];
    return readAll()
      .filter((e) => (e.project ?? '').toLowerCase() === key)
      .slice(-limitOf(n, 10))
      .reverse();
  }

  /**
   * `search({query, kind, project, tool, since, until, limit})` — look something
   * up, rather than be handed a summary of the last six hours.
   *
   * Everything is optional and the filters compose (AND); with no arguments at
   * all this is `recent()`. Newest first, like every read in this module, and
   * bounded by `limit` (default DEFAULT_SEARCH_LIMIT, hard cap MAX_SEARCH_LIMIT).
   *
   * **Keyword, not semantic, and that is the right call at this scale.** The
   * corpus is a few hundred entries of six short fields — an embedding index
   * would cost a dependency, a build step and a model round trip to do worse
   * than `includes()` on "npm test". `query` is split on whitespace and *every*
   * term must appear somewhere in the entry's detail, tool or project text, so
   * "npm test failed" narrows instead of matching nothing the way one long
   * substring would. The command string lives inside `detail` (context.
   * describeAction wrote it there), which is why there is no separate field for
   * it; `kind` has its own parameter and is deliberately **not** in the haystack,
   * so a file called `failed.ts` does not drag in every failure.
   *
   * `kind` takes one name or a list. An unrecognised one is dropped, and a
   * filter left with nothing recognisable in it is dropped entirely rather than
   * matching zero rows: a caller's typo should cost precision, not turn a pet
   * who remembers the evening into one who says she remembers nothing.
   */
  function search({
    query = null,
    kind = null,
    project = null,
    tool = null,
    since = null,
    until = null,
    limit = DEFAULT_SEARCH_LIMIT,
  } = {}) {
    const terms = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);

    const asked = (Array.isArray(kind) ? kind : [kind])
      .map((k) => (typeof k === 'string' ? k.trim().toLowerCase() : ''))
      .filter((k) => LEDGER_KINDS.includes(k));
    const kinds = asked.length ? new Set(asked) : null;

    const wantProject = nameKey(project);
    const wantTool = nameKey(tool);
    const from = finiteMs(since);
    const to = finiteMs(until);
    const take = Math.min(limitOf(limit, DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT);

    return readAll()
      .filter((entry) => {
        if (kinds && !kinds.has(entry.kind)) return false;
        if (wantProject && (entry.project ?? '').toLowerCase() !== wantProject) return false;
        if (wantTool && (entry.tool ?? '').toLowerCase() !== wantTool) return false;
        if (from !== null && entry.at < from) return false;
        if (to !== null && entry.at > to) return false;
        if (terms.length === 0) return true;
        const hay = `${entry.detail ?? ''} ${entry.tool ?? ''} ${entry.project ?? ''}`.toLowerCase();
        return terms.every((term) => hay.includes(term));
      })
      .slice(-take)
      .reverse();
  }

  /**
   * `digest({now, windowMs})` — what she remembers, in a form that can be
   * dropped straight into the prompt beside persona's other briefing lines.
   * Two lines at most and hard-capped: this goes into every request, and a long
   * context makes her worse, not better. Null when there is nothing to say —
   * and the absence is the instruction, exactly as it is for the time line.
   *
   *   You remember, going back about 2 hours: 2 failures (running `npm test`),
   *   the last about 40 minutes ago; one approval you waited on, about an hour
   *   ago; 3 sessions started.
   *   Projects: ganyu-pet, GolfCRM/bay-daily-codes.
   */
  function digest({ now: at = null, windowMs = defaultWindowMs } = {}) {
    const t = finiteMs(at) ?? clock();
    const win = finiteMs(windowMs);
    const cutoff = win === null ? -Infinity : t - win;
    const entries = readAll().filter((e) => e.at >= cutoff);
    if (entries.length === 0) return null;

    const byKind = new Map();
    for (const entry of entries) {
      const list = byKind.get(entry.kind);
      if (list) list.push(entry);
      else byKind.set(entry.kind, [entry]);
    }
    const of = (kind) => byKind.get(kind) ?? [];

    // "the last X ago" only once there is more than one of them.
    const when = (list) => {
      const ago = describeAgo(list[list.length - 1].at, t);
      if (!ago) return null;
      return list.length > 1 ? `the last ${ago}` : ago;
    };
    const withWhen = (list, phrase) => {
      const tail = when(list);
      return tail ? `${phrase}, ${tail}` : phrase;
    };
    // What failed, as she saw it: the caller's clause if it gave one, else the
    // tool's own name. Two at most — a list is a fact, an inventory is noise.
    const namesOf = (list) => {
      const seen = [];
      for (const entry of list) {
        const name = entry.detail ?? entry.tool;
        if (name && !seen.includes(name)) seen.push(name);
        if (seen.length === 2) break;
      }
      return seen.join(', ');
    };

    // Ranked, because only the first four are kept: what broke and what she was
    // asked for outrank how many things started.
    const clauses = [];
    const failed = of('failed');
    if (failed.length) {
      const what = namesOf(failed);
      clauses.push(withWhen(failed, `${countPhrase(failed.length, 'failure')}${what ? ` (${what})` : ''}`));
    }
    const recovered = of('recovered');
    if (recovered.length) {
      clauses.push(withWhen(recovered, countPhrase(recovered.length, 'recovery', 'recoveries')));
    }
    const waiting = of('waiting');
    if (waiting.length) {
      clauses.push(withWhen(waiting, `${countPhrase(waiting.length, 'approval')} you waited on`));
    }
    const notable = of('notable');
    if (notable.length) {
      const last = notable[notable.length - 1];
      const phrase = PATTERN_PHRASES[last.detail] ?? last.detail;
      clauses.push(phrase ? `you noticed ${phrase}` : 'you noticed something worth remarking on');
    }
    const finished = of('celebrate');
    if (finished.length) clauses.push(`${countPhrase(finished.length, 'task')} finished`);
    const started = of('greeting');
    if (started.length) clauses.push(`${countPhrase(started.length, 'session')} started`);

    if (clauses.length === 0) return null;

    const span = describeSpan(t - entries[0].at);
    const head = span ? `You remember, going back ${span}: ` : 'You remember: ';
    const lines = [shortText(`${head}${clauses.slice(0, 4).join('; ')}.`, MAX_DIGEST_CHARS - 80)];

    const counts = new Map();
    for (const entry of entries) {
      if (entry.project) counts.set(entry.project, (counts.get(entry.project) ?? 0) + 1);
    }
    const projects = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 3)
      .map(([name]) => name);
    if (projects.length) lines.push(shortText(`Projects: ${projects.join(', ')}.`, 76));

    return lines.filter(Boolean).join('\n');
  }

  return {
    enabled: true,
    path,
    record,
    recent,
    since,
    forProject,
    search,
    digest,
    /** Introspection for tests and debugging, in the shape speech/brain use. */
    stats() {
      const all = readAll();
      return {
        path,
        enabled: true,
        entries: all.length,
        oldest: all.length ? all[0].at : null,
        newest: all.length ? all[all.length - 1].at : null,
        maxEntries: cap,
      };
    },
  };
}

export default createLedger;
