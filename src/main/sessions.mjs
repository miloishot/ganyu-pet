// Module D — sessions: the narrative of a coding session, read back out of the
// Claude Code transcript it was recorded in.
//
// WHY THIS EXISTS. Everything else she can see is *hook metadata*: a tool name, a
// file path, a project, an exit flag. From `Edit redeem.ts` she can say that a
// file changed and nothing more, so filenames became her whole vocabulary — she
// narrated the mechanics of the work because the mechanics were all she had. The
// fix is not a prompt rule telling her to stop naming files; it is giving her
// something better to talk about. The transcripts are that something: they carry
// the assistant's own prose account of what it did and why, and the owner's own
// words for what he wanted. "The redemption flow is passing again" lives in
// there. "Edit redeem.ts" is all that reaches her without it.
//
// PRIVACY — THIS IS THE WHOLE DESIGN, NOT A FEATURE OF IT.
//
// A transcript is the single most sensitive artefact on the machine. It contains
// full file contents, complete diffs, every tool result, command output, and
// anything the owner ever pasted into a prompt — including credentials. So this
// module is written as an **allowlist over line types and content types**, in the
// same spirit as context.mjs's `ALLOWED_TOOL_INPUT_KEYS`, and there is no code
// path here that can reach anything else.
//
// Exactly four things may leave this module:
//   1. `ai-title`  -> `aiTitle`                 — the generated session title.
//   2. `user`      -> text the OWNER typed      — his ask, in his words.
//   3. `assistant` -> `{type:'text'}` blocks    — its prose account of the work.
//   4. failure sentences *derived from* (3)     — no new surface; see `problemsFrom`.
//
// Everything else is dropped by not being reachable:
//   · `tool_use` items          — the inputs: diffs, file bodies, commands.
//   · `tool_result` items       — the outputs: file dumps, command output.
//   · `thinking` items          — the model's private reasoning, and it quotes code.
//   · `attachment` lines        — pasted images and files.
//   · `file-history-snapshot` / `file-history-delta` — literally the file contents.
//   · `system`, `mode`, `permission-mode`, `queue-operation`, `last-prompt`,
//     `pr-link`, and any line type not yet seen — unknown types are dropped, so a
//     future Claude Code release cannot widen this by adding one.
//   · `isSidechain` lines — subagent transcripts. Dropped for noise as much as for
//     privacy: a subagent's prose is about its own narrow errand, not about the work.
//
// Two further passes run on the text that *is* allowed, because "assistant prose"
// is not automatically safe:
//   · fenced code blocks are cut out of it (`stripCode`) — the assistant quotes
//     diffs, config and file bodies inside ``` fences constantly, and that is the
//     same content the tool_use allowlist above exists to refuse;
//   · what survives goes through `redactSecrets` from context.mjs, then through
//     this module's own `TRANSCRIPT_SECRETS` for the shapes a *pasted* credential
//     has and a command line does not (see that constant).
//
// Pure, dependency-free, `fs` injected. No Electron. Tests never read the real
// `~/.claude/projects`; they build a fixture fs.

import { redactSecrets, projectFromCwd } from './context.mjs';

/** Transcripts live one directory per working directory, one `.jsonl` per session. */
export const TRANSCRIPT_EXT = '.jsonl';

/** How many project directories `listSessions` will look inside. */
export const MAX_SCANNED_DIRS = 200;

/** Default number of sessions returned, newest first. */
export const DEFAULT_SESSION_LIMIT = 8;
export const MAX_SESSION_LIMIT = 25;

/**
 * Above this, only the trailing window of the file is read.
 *
 * This is not only a memory guard — it is the newest-weighting. A transcript is
 * append-only and the end of a session is the part that says how it turned out,
 * so the last two megabytes are strictly the more useful two megabytes. Measured
 * on this machine: the largest transcript here is 17MB / 1,854 lines, and
 * reading plus parsing all of it costs ~100ms, so the cap is about not holding a
 * 17MB string in the Electron main process every time he asks her a question,
 * not about being unable to.
 */
export const MAX_READ_BYTES = 2 * 1024 * 1024;

/** Per-item caps. An ask is a sentence; a note is a paragraph. */
export const MAX_ASK_CHARS = 200;
export const MAX_NOTE_CHARS = 400;
export const MAX_PROBLEM_CHARS = 200;

/** How many of each survive into a digest, newest-weighted. */
export const MAX_ASKS = 4;
export const MAX_NOTES = 4;
export const MAX_PROBLEMS = 3;

/** Default and ceiling for the rendered summary. Callers bound it; see `summarizeSession`. */
export const DEFAULT_SUMMARY_CHARS = 1200;
export const MAX_SUMMARY_CHARS = 2000;

/**
 * Prose shorter than this is an interstitial, not an account of anything —
 * "Installed." / "Done." / "Now the tests." Kept out so the newest-weighted
 * budget is not spent on filler before it reaches the real summary.
 */
const MIN_NOTE_CHARS = 60;

/**
 * A block that only *announces* the next step, which is exactly the mechanical
 * narration this whole module exists to stop her repeating. Measured against a
 * real transcript: "I'll check for a todo list — let me look at the project
 * directory and any tracking files." is one of these; the block two turns later
 * beginning "Both merged, and the verification turned up something I have to
 * own." is not, and is the one worth her breath.
 *
 * Only applied below `PREAMBLE_MAX_CHARS` — a long block that happens to open
 * with "Let me" still ends up saying something.
 */
const PREAMBLE_RE = /^(?:i'?ll\b|i am going to\b|i'?m going to\b|let me\b|now (?:i'?ll|let me)\b|next,? i'?ll\b|checking\b|looking at\b|reading\b|starting\b|first,? (?:i'?ll|let me)\b)/i;
const PREAMBLE_MAX_CHARS = 200;

/**
 * User lines that are machinery rather than an ask. All of these were observed
 * in real transcripts on this machine; the list is a prefix test, so a block that
 * opens with one is dropped whole.
 *
 * `<system-reminder>` is the exception and is handled separately in `ownerAsk` —
 * it is usually *appended* to a genuine prompt rather than being the whole line,
 * so dropping the line would throw away the ask along with it.
 */
const USER_NOISE_PREFIXES = Object.freeze([
  '<task-notification>',
  '<local-command-caveat>',
  '<local-command-stdout>',
  '<local-command-stderr>',
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<user-prompt-submit-hook>',
  '<bash-input>',
  '<bash-stdout>',
  '<bash-stderr>',
  '<function_results>',
  '[request interrupted',
  '[image:',
  'caveat: the messages below',
  'api error',
]);

/** Counted rather than quoted — it says he stopped it, which is a fact without being text. */
const INTERRUPTED_RE = /^\[request interrupted/i;

/**
 * Failure language, used only to pick sentences out of prose she is already
 * allowed to see (see `problemsFrom`). Deliberately about *outcomes* — a
 * sentence saying something broke — rather than the word "error" anywhere, which
 * as state.mjs records the hard way matches most of what agent work talks about.
 */
const PROBLEM_RE = /\b(?:fail(?:s|ed|ing|ure)?|broke|broken|breaks|regress(?:ed|ion)|crash(?:ed|es)?|times? out|timed out|does ?n[o']?t work|is ?n[o']?t working|could ?n[o']?t|unable to|still (?:red|failing|broken)|blocked on|stuck on|reverted|rolled back)\b/i;

/**
 * Secret shapes a transcript can carry that a command line effectively cannot,
 * layered on top of context.mjs's `redactSecrets` rather than added to it.
 *
 * Kept separate on purpose. That list is tuned against a measured
 * over-redaction bug — `/` was once in its base64 class and it ate ordinary
 * Windows paths — and it runs on every command she quotes, several times a
 * minute. These rules only ever see transcript prose, which is where a *pasted*
 * credential turns up, so a false positive here costs one redacted word in a
 * summary instead of making every quoted command unreadable.
 *
 * Every one is anchored to a vendor prefix, because in free prose that is the
 * only thing that distinguishes a key from a long word.
 */
const TRANSCRIPT_SECRETS = Object.freeze([
  // Stripe and friends: `sk_live_…`, `rk_test_…`, `whsec_…`. The underscore form
  // is invisible to context.mjs's `sk-` rule, which requires the hyphen.
  [/\b[a-z]{2,4}_(?:live|test)_[A-Za-z0-9]{10,}/gi, '<redacted>'],
  [/\bwhsec_[A-Za-z0-9_-]{10,}/gi, '<redacted>'],
  // Google OAuth client secret — a fixed prefix and nothing else like it.
  [/\bGOCSPX-[A-Za-z0-9_-]{10,}/g, '<redacted>'],
  // npm, PyPI, HuggingFace, Doppler, Vercel, Fly.
  [/\bnpm_[A-Za-z0-9]{20,}/g, '<redacted>'],
  [/\bpypi-[A-Za-z0-9_-]{20,}/g, '<redacted>'],
  [/\bhf_[A-Za-z0-9]{20,}/g, '<redacted>'],
  [/\bdp\.[a-z]{2,4}\.[A-Za-z0-9]{20,}/g, '<redacted>'],
  // Supabase / PostgREST anon+service keys are JWTs and context.mjs has them.
  // What it does not have is the bare `service_role` key named in prose.
  [/\b(service[_-]?role[_-]?key\s*[=:]?\s*)(["']?)[A-Za-z0-9._-]{20,}\2/gi, '$1$2<redacted>$2'],
]);

/** Everything a value passes through before it may be spoken about. */
function redactAll(text) {
  let out = redactSecrets(text);
  for (const [re, replacement] of TRANSCRIPT_SECRETS) out = out.replace(re, replacement);
  return out;
}

/**
 * Markdown flattened into something a person could read aloud.
 *
 * Not cosmetic. The assistant writes its summaries in full markdown, and left as
 * they are she is handed `## Merged` / `- **PR #3** → …` / a bare pull-request
 * URL, which is unreadable as speech and — worse — unparseable as sentences:
 * measured against a real transcript, `1.` in an ordered list was being read as
 * the end of a sentence, so `problemsFrom` pulled out the fragment
 * "## Do now (blocked on you, in order) 1." and offered it as something that had
 * gone wrong.
 *
 * Each line loses its marker and gains a full stop if it had no terminator, so
 * the sentence splitter downstream sees real boundaries. Inline backticks keep
 * their contents — a file name or a short commit sha is exactly the kind of
 * detail she may legitimately reach for — while bare URLs are dropped outright,
 * being pure noise in something spoken.
 */
export function flattenMarkdown(text) {
  const out = [];
  for (const raw of String(text ?? '').split('\n')) {
    let line = raw
      .replace(/^\s{0,3}>\s?/, '')
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\d{1,2}[.)]\s+/, '')
      .replace(/^\s*\|(.*)\|\s*$/, '$1')
      .trim();
    // A table rule or a horizontal rule carries nothing.
    if (line === '' || /^[|\s:*_-]+$/.test(line)) continue;
    line = line
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\bhttps?:\/\/\S+/gi, '')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/`+([^`]+)`+/g, '$1')
      .replace(/\|/g, ', ')
      .trim();
    // A URL removed from mid-sentence leaves its punctuation behind — measured:
    // "merge PR #3, then PR #4 — → About 10 minutes" once read "— → " where two
    // links had been.
    line = line.replace(/[\s]*[—–>→:,;]+[\s]*$/, '').replace(/\s*[—–]\s*[→>]\s*/g, ' — ').trim();
    if (line === '') continue;
    out.push(line);
  }
  // Terminators are added only when lines are being *joined*, so the splitter
  // downstream sees real boundaries. A single line is left exactly as written —
  // his ask and the session title are quoted, and inventing a full stop on the
  // end of "merge three and four" is putting words in his mouth.
  if (out.length <= 1) return out[0] ?? '';
  return out.map((line) => (/[.!?:;,]$/.test(line) ? line : `${line}.`)).join(' ');
}

/**
 * Marker-shaped runs, stripped for the same reason brain.mjs strips them from a
 * ledger row: this text ends up inside a fence, and nothing quoted may close the
 * fence early or forge a second one. Transcript prose is *far* more likely to
 * contain something fence-shaped than a ledger row is, because it is prose that
 * discusses prompts.
 */
const MARKER_SHAPED = /<{2,}[^<>]*>{2,}/g;

/**
 * One line, flattened, marker-free, redacted, hard-capped. Empty in, empty out.
 *
 * `flattenMarkdown` runs first because it is line-based and everything after it
 * collapses the newlines it needs; it is idempotent, so the second pass over an
 * already-flattened problem sentence changes nothing.
 */
function clean(text, max) {
  const s = redactAll(flattenMarkdown(text))
    .replace(MARKER_SHAPED, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s === '') return '';
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Fenced code cut out of prose, plus the shapes that are code without a fence.
 *
 * The unterminated case matters and is handled first: a transcript is appended
 * to while a session runs, and a block that opens a fence and has not closed it
 * is a block whose remainder is code. Cutting to the end of the string is the
 * only safe reading of it.
 */
export function stripCode(text) {
  let s = String(text ?? '');
  // Closed fences, ``` or ~~~, any info string.
  s = s.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n[ \t]*\2[^\n]*(?=\n|$)/g, '$1');
  // An opening fence with no closing one: everything after it goes.
  s = s.replace(/(^|\n)[ \t]*(?:`{3,}|~{3,})[\s\S]*$/, '$1');
  // A diff pasted without a fence — `+++ b/file`, `@@ -1,4 +1,6 @@`.
  s = s.replace(/(^|\n)(?:[-+]{3} [ab]?[/\\]?\S+|@@[^\n]*@@)[^\n]*/g, '$1');
  return s;
}

/** `<system-reminder>…</system-reminder>` and friends, which ride along on real prompts. */
function stripWrappedBlocks(text) {
  return String(text ?? '')
    .replace(/<(system-reminder|local-command-caveat|local-command-stdout|local-command-stderr|task-notification|command-name|command-message|command-args|user-prompt-submit-hook)>[\s\S]*?<\/\1>/gi, ' ')
    // An unterminated one, same reasoning as the fence above.
    .replace(/<(?:system-reminder|task-notification|local-command-[a-z]+)>[\s\S]*$/i, ' ');
}

const isNoise = (text) => {
  const s = String(text ?? '').trimStart().toLowerCase();
  return USER_NOISE_PREFIXES.some((p) => s.startsWith(p));
};

/**
 * The owner's text out of a `user` line, or null.
 *
 * `message.content` is a bare string for something he typed and an array when the
 * line is carrying tool results — in which case only `{type:'text'}` parts are
 * read and everything else, `tool_result` included, is unreachable.
 */
export function ownerAsk(line) {
  if (line?.isMeta === true || line?.isSidechain === true) return null;
  const content = line?.message?.content;
  let raw = '';
  if (typeof content === 'string') raw = content;
  else if (Array.isArray(content)) {
    raw = content
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text)
      .join('\n');
  }
  if (raw.trim() === '') return null;
  if (isNoise(raw)) return null;
  const stripped = stripCode(stripWrappedBlocks(raw));
  const text = clean(stripped, MAX_ASK_CHARS);
  // A prompt that was *only* a reminder block collapses to nothing, which is the
  // right answer — there was no ask in it.
  return text === '' ? null : text;
}

/**
 * The assistant's prose out of an `assistant` line, or null.
 *
 * Only `{type:'text'}`. `tool_use` (the diffs and commands) and `thinking` (the
 * private reasoning, which quotes code freely) are not read, and there is no
 * parameter that would make them readable.
 */
export function assistantNote(line) {
  if (line?.isSidechain === true) return null;
  const content = line?.message?.content;
  if (!Array.isArray(content)) return null;
  const raw = content
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
  if (raw.trim() === '') return null;
  const text = clean(stripCode(raw), MAX_NOTE_CHARS);
  if (text.length < MIN_NOTE_CHARS) return null;
  if (text.length < PREAMBLE_MAX_CHARS && PREAMBLE_RE.test(text)) return null;
  return text;
}

/** Sentences, roughly. Good enough to pull one clause out of a paragraph. */
function sentences(text) {
  return String(text ?? '')
    .split(/(?<=[.!?])\s+|\s+[—–]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Below this a "sentence" is a fragment, and a fragment explains nothing. */
const MIN_PROBLEM_CHARS = 25;

/** Parenthetical asides removed — see the call site in `problemsFrom`. */
const withoutAsides = (text) => String(text ?? '').replace(/\([^)]*\)?/g, ' ');

/**
 * Does this read as a statement rather than as a leftover of a list or a
 * heading? It must start like prose and have enough words to say something.
 *
 * This exists because of a real defect: `PROBLEM_RE` matched "blocked on" inside
 * the heading "Do now (blocked on you, in order)", and she was handed a
 * to-do-list header as the thing that had gone wrong.
 */
function isClause(sentence) {
  const s = String(sentence ?? '').trim();
  if (s.length < MIN_PROBLEM_CHARS) return false;
  if (!/^[A-Za-z]/.test(s)) return false;
  return s.split(/\s+/).length >= 5;
}

/**
 * What went wrong, taken **only** from prose already allowed through above — so
 * this adds no new privacy surface at all, it re-reads what is already out.
 *
 * Deliberately not built from tool results or exit codes: those say a command
 * returned non-zero, which she already gets from the hook events, and they are
 * the payloads this module refuses to open.
 */
export function problemsFrom(notes, limit = MAX_PROBLEMS) {
  const out = [];
  const seen = new Set();
  for (let i = notes.length - 1; i >= 0 && out.length < limit; i -= 1) {
    for (const sentence of sentences(notes[i])) {
      // Tested with parenthetical asides removed. An aside is by definition not
      // what the sentence is about, and this is the second half of the real
      // defect below: "Do now (blocked on you, in order)" is a to-do heading
      // whose only failure word sits inside the brackets. A sentence that
      // genuinely reports trouble says so in its main clause.
      if (!PROBLEM_RE.test(withoutAsides(sentence))) continue;
      if (!isClause(sentence)) continue;
      const text = clean(sentence, MAX_PROBLEM_CHARS);
      const key = text.toLowerCase();
      if (text === '' || seen.has(key)) continue;
      seen.add(key);
      out.push(text);
      if (out.length >= limit) break;
    }
  }
  return out.reverse();
}

// ---------------------------------------------------------------------------
// Finding transcripts
// ---------------------------------------------------------------------------

/**
 * The directory name Claude Code gives a working directory: every character
 * that is not a letter, a digit or a hyphen becomes a hyphen.
 *
 * Derived from the real layout on this machine rather than assumed —
 * `C:\Users\kw11l\Desktop\ganyu-pet` is `C--Users-kw11l-Desktop-ganyu-pet` (the
 * `:\` pair makes the doubled hyphen), `~/.claude` is `C--Users-kw11l--claude`
 * (the dot), and `~/Desktop/zmk-new_corne` is `C--Users-kw11l-desktop-zmk-new-corne`
 * (the underscore). Case is preserved, which is why lookup falls back to a
 * case-insensitive match: `desktop` and `Desktop` both occur here, decided by
 * whatever the shell happened to pass that day.
 */
export function mangleCwd(cwd) {
  return String(cwd ?? '').replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Does transcript directory `dirName` belong to project `project`?
 *
 * Mangling is not reversible — `ganyu-pet` and a directory `ganyu/pet` mangle
 * alike — so this asks the question in the direction that *is* decidable: mangle
 * the project name and look for it as a whole segment. `GolfCRM` matches both
 * `C--Users-kw11l-desktop-GolfCRM` (the repo) and
 * `C--Users-kw11l-orca-workspaces-GolfCRM-admin-mobile` (a worktree of it), which
 * is what he means when he asks about GolfCRM.
 */
export function dirMatchesProject(dirName, project) {
  const needle = mangleCwd(project).toLowerCase();
  if (needle === '') return true;
  const hay = String(dirName ?? '').toLowerCase();
  return hay === needle || hay.endsWith(`-${needle}`) || hay.includes(`-${needle}-`);
}

const isTranscript = (name) => typeof name === 'string' && name.endsWith(TRANSCRIPT_EXT);

function safe(fn, fallback = null) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** `readdirSync` that copes with `withFileTypes` results and with plain strings. */
function namesIn(fs, dir) {
  const entries = safe(() => fs.readdirSync(dir), null);
  if (!Array.isArray(entries)) return [];
  return entries.map((e) => (typeof e === 'string' ? e : e?.name)).filter((n) => typeof n === 'string');
}

const joinPath = (dir, name) => `${String(dir).replace(/[\\/]+$/, '')}/${name}`;

/**
 * `listSessions({fs, projectsDir, cwd, project, limit})` — transcripts, newest first.
 *
 * `cwd` restricts to one working directory's own transcripts (exact mangled name
 * first, then case-insensitively). `project` is the looser question — "anything
 * to do with GolfCRM" — and matches worktrees too, see `dirMatchesProject`. With
 * neither, every project directory is in scope.
 *
 * Only stats and names are read here; nothing is opened. That keeps a listing
 * cheap enough to run on every tool call, and it means a listing can never leak
 * anything, because it never sees a byte of content.
 */
export function listSessions({
  fs,
  projectsDir,
  cwd = null,
  project = null,
  limit = DEFAULT_SESSION_LIMIT,
} = {}) {
  if (!fs || typeof fs.readdirSync !== 'function' || !projectsDir) return [];

  let dirs = namesIn(fs, projectsDir).slice(0, MAX_SCANNED_DIRS);

  if (cwd) {
    const want = mangleCwd(cwd);
    const exact = dirs.find((d) => d === want);
    dirs = exact ? [exact] : dirs.filter((d) => d.toLowerCase() === want.toLowerCase());
  } else if (project) {
    dirs = dirs.filter((d) => dirMatchesProject(d, project));
  }

  const out = [];
  for (const dir of dirs) {
    const full = joinPath(projectsDir, dir);
    for (const name of namesIn(fs, full)) {
      if (!isTranscript(name)) continue;
      const filePath = joinPath(full, name);
      const stat = safe(() => fs.statSync(filePath), null);
      const bytes = Number(stat?.size);
      // A zero-byte transcript is a session that opened and never said anything.
      if (!Number.isFinite(bytes) || bytes <= 0) continue;
      const mtime = Number(stat?.mtimeMs ?? stat?.mtime);
      out.push({
        id: name.slice(0, -TRANSCRIPT_EXT.length),
        path: filePath,
        dir,
        bytes,
        at: Number.isFinite(mtime) ? mtime : 0,
      });
    }
  }

  const max = Math.min(
    Math.max(1, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : DEFAULT_SESSION_LIMIT),
    MAX_SESSION_LIMIT,
  );
  return out.sort((a, b) => b.at - a.at || (a.path < b.path ? -1 : 1)).slice(0, max);
}

/**
 * The file's text, or the trailing `MAX_READ_BYTES` of it when it is large.
 *
 * A partial read starts mid-line, so the first line is always discarded —
 * exactly the same defence the parser applies to a torn *last* line, for the
 * same reason. An injected `fs` without `openSync` simply reads the whole file:
 * the cap is an optimisation, never a correctness requirement.
 */
function readTail(fs, filePath, maxBytes = MAX_READ_BYTES) {
  const size = Number(safe(() => fs.statSync(filePath)?.size, null));
  if (!Number.isFinite(size) || size <= maxBytes || typeof fs.openSync !== 'function') {
    const text = safe(() => fs.readFileSync(filePath, 'utf8'), null);
    return text == null ? null : { text: String(text), partial: false };
  }

  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
    return { text: buf.toString('utf8', 0, read), partial: true };
  } catch {
    const text = safe(() => fs.readFileSync(filePath, 'utf8'), null);
    return text == null ? null : { text: String(text), partial: false };
  } finally {
    if (fd !== null) safe(() => fs.closeSync?.(fd));
  }
}

/**
 * `readSession({fs, filePath, maxAsks, maxNotes})` — one transcript as a digest,
 * or null when there is no readable file.
 *
 * **Never throws.** A transcript is appended to while a session is live, so the
 * last line of a 2,500-line file is routinely half-written; an unparseable line
 * is skipped in silence and counted, and one torn line must never cost the other
 * 2,499. The same tolerance covers a file that is not JSONL at all — it simply
 * yields a digest with nothing in it.
 *
 * Newest-weighted: asks and notes are collected walking *backwards* from the end
 * and then put back into order, because how a session turned out is what he is
 * asking about and the middle of it rarely is.
 */
export function readSession({
  fs,
  filePath,
  maxAsks = MAX_ASKS,
  maxNotes = MAX_NOTES,
  maxBytes = MAX_READ_BYTES,
} = {}) {
  if (!fs || typeof fs.readFileSync !== 'function' || !filePath) return null;
  const read = readTail(fs, filePath, maxBytes);
  if (read == null) return null;

  const rawLines = read.text.split('\n');
  // A tail read starts mid-line; drop that fragment rather than trying to parse it.
  if (read.partial && rawLines.length > 1) rawLines.shift();

  const parsed = [];
  let skipped = 0;
  for (const raw of rawLines) {
    if (raw.trim() === '') continue;
    let line = null;
    try {
      line = JSON.parse(raw);
    } catch {
      skipped += 1; // a torn last line, or a truncated first one — never fatal
      continue;
    }
    if (line && typeof line === 'object' && !Array.isArray(line)) parsed.push(line);
    else skipped += 1;
  }

  let title = null;
  let cwd = null;
  let interrupted = 0;
  let firstAt = null;
  let lastAt = null;

  const asks = [];
  const notes = [];

  // Forward pass: only the cheap scalars, which need every line.
  for (const line of parsed) {
    if (line.type === 'ai-title' && typeof line.aiTitle === 'string' && line.aiTitle.trim()) {
      title = clean(line.aiTitle, MAX_ASK_CHARS); // last one wins: titles get refined
    }
    if (cwd == null && typeof line.cwd === 'string' && line.cwd.trim() !== '') cwd = line.cwd;
    const at = Date.parse(line.timestamp ?? '');
    if (Number.isFinite(at)) {
      if (firstAt === null || at < firstAt) firstAt = at;
      if (lastAt === null || at > lastAt) lastAt = at;
    }
    if (line.type === 'user') {
      const content = line.message?.content;
      const flat = typeof content === 'string'
        ? content
        : (Array.isArray(content)
          ? content.filter((p) => p?.type === 'text').map((p) => p?.text ?? '').join(' ')
          : '');
      if (INTERRUPTED_RE.test(String(flat).trimStart())) interrupted += 1;
    }
  }

  // Backward pass: the bounded, expensive text. Newest first, reversed at the end.
  for (let i = parsed.length - 1; i >= 0; i -= 1) {
    const line = parsed[i];
    if (line.type === 'user' && asks.length < maxAsks) {
      const ask = ownerAsk(line);
      if (ask && !asks.includes(ask)) asks.push(ask);
    } else if (line.type === 'assistant' && notes.length < maxNotes) {
      const note = assistantNote(line);
      if (note && !notes.includes(note)) notes.push(note);
    }
    if (asks.length >= maxAsks && notes.length >= maxNotes) break;
  }
  asks.reverse();
  notes.reverse();

  return {
    path: String(filePath),
    project: projectFromCwd(cwd),
    cwd: cwd == null ? null : String(cwd),
    title,
    asks,
    notes,
    problems: problemsFrom(notes),
    interrupted,
    startedAt: firstAt,
    endedAt: lastAt,
    lines: parsed.length,
    skipped,
    truncated: read.partial,
  };
}

/** "3 minutes ago" / "about 2 hours ago" / "yesterday". Null when there is no timestamp. */
export function describeWhen(at, now = Date.now()) {
  const t = Number(at);
  if (!Number.isFinite(t) || t <= 0) return null;
  const mins = Math.round((Number(now) - t) / 60_000);
  if (!Number.isFinite(mins)) return null;
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours === 1 ? 'about an hour ago' : `about ${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/**
 * `summarizeSession(digest, {now, maxChars})` — the digest rendered as something
 * she can speak from, or null when the transcript held nothing worth reading.
 *
 * Deliberately labelled prose rather than JSON. It goes into the prompt as
 * quoted data, and a reader who has to work out what a field means will start
 * reciting field names; "What he asked for:" needs no explaining.
 *
 * The order is the order she needs it in: what it *was*, what he wanted, what
 * came of it, what went wrong, what is unfinished. Sections are dropped whole
 * when empty, so she is never handed "Problems: none" to read out.
 */
export function summarizeSession(digest, { now = Date.now(), maxChars = DEFAULT_SUMMARY_CHARS } = {}) {
  if (!digest || typeof digest !== 'object') return null;
  const budget = Math.min(
    Math.max(120, Number.isFinite(Number(maxChars)) ? Math.floor(Number(maxChars)) : DEFAULT_SUMMARY_CHARS),
    MAX_SUMMARY_CHARS,
  );

  const where = digest.project ? ` in ${digest.project}` : '';
  const when = describeWhen(digest.endedAt ?? null, now);
  const head = digest.title
    ? `Session "${digest.title}"${where}`
    : `A session${where}`;

  const parts = [when ? `${head}, ${when}.` : `${head}.`];

  if (digest.asks?.length) {
    parts.push(`What he asked for: ${digest.asks.map((a) => `"${a}"`).join(' Then: ')}`);
  }
  if (digest.notes?.length) {
    parts.push(`What came of it: ${digest.notes.join(' ')}`);
  }
  if (digest.problems?.length) {
    parts.push(`Trouble along the way: ${digest.problems.join(' ')}`);
  }
  if (digest.interrupted > 0) {
    parts.push(
      digest.interrupted === 1
        ? 'He stopped it mid-way once.'
        : `He stopped it mid-way ${digest.interrupted} times.`,
    );
  }

  // Nothing but the header means the transcript had no narrative in it at all —
  // an empty session, or one that was all tool calls. Say so rather than
  // offering a bare title she would then have to invent around.
  if (parts.length === 1) {
    if (!digest.title && !digest.project) return null;
    parts.push('Nothing was written down about what it did.');
  }

  const text = parts.join('\n');
  return text.length <= budget ? text : `${text.slice(0, budget - 1).trimEnd()}…`;
}

/**
 * `createSessions({fs, projectsDir, cwd})` — the small stateful wrapper module A
 * wires up, so nothing outside this file has to know where transcripts live.
 *
 * `cwd` may be a function, because the directory his agents are in changes as he
 * moves between repos and index.mjs already resolves it lazily from the newest
 * hook event (`agentCwd`). A `projectsDir` that does not exist is not an error:
 * every call simply answers with nothing, which is what a machine with no
 * transcripts should look like.
 */
export function createSessions({ fs, projectsDir = null, cwd = null, now = Date.now } = {}) {
  const resolveCwd = () => {
    const value = typeof cwd === 'function' ? safe(() => cwd(), null) : cwd;
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  };

  const enabled = Boolean(fs && projectsDir);

  /**
   * `read({project, which, query, maxChars})` — the one call the tool makes.
   *
   * `which` is 1-based and 1 means "the most recent". `query` filters on the
   * digest rather than on the raw file: a session matches when every word of it
   * appears in the title, his asks or the prose — which is the only text this
   * module is willing to look at anyway, so a query can never be used to search
   * the parts it refuses to read.
   */
  function read({ project = null, which = 1, query = null, maxChars = DEFAULT_SUMMARY_CHARS } = {}) {
    if (!enabled) return null;

    const wantProject = typeof project === 'string' && project.trim() !== '' ? project.trim() : null;
    const words = String(query ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1);
    const index = Math.max(1, Number.isFinite(Number(which)) ? Math.floor(Number(which)) : 1);

    // With no project named, prefer the directory his agents are actually in —
    // "what was I just doing" means here, not the newest thing on the machine.
    const scoped = wantProject
      ? listSessions({ fs, projectsDir, project: wantProject, limit: MAX_SESSION_LIMIT })
      : listSessions({ fs, projectsDir, cwd: resolveCwd(), limit: MAX_SESSION_LIMIT });
    const candidates = scoped.length
      ? scoped
      : listSessions({ fs, projectsDir, limit: MAX_SESSION_LIMIT });

    let seen = 0;
    for (const entry of candidates) {
      const digest = readSession({ fs, filePath: entry.path });
      if (!digest) continue;
      const summary = summarizeSession(digest, { now: now(), maxChars });
      if (!summary) continue;
      if (words.length) {
        const hay = summary.toLowerCase();
        if (!words.every((w) => hay.includes(w))) continue;
      }
      seen += 1;
      if (seen >= index) return { ...digest, summary, at: entry.at, id: entry.id };
    }
    return null;
  }

  /** Titles and times only — for "what have I been working on", without opening much. */
  function recent({ project = null, limit = DEFAULT_SESSION_LIMIT } = {}) {
    if (!enabled) return [];
    const entries = project
      ? listSessions({ fs, projectsDir, project, limit })
      : listSessions({ fs, projectsDir, limit });
    return entries.map((entry) => {
      const digest = readSession({ fs, filePath: entry.path, maxAsks: 1, maxNotes: 1 });
      return {
        id: entry.id,
        at: entry.at,
        project: digest?.project ?? null,
        title: digest?.title ?? null,
      };
    });
  }

  return { enabled, read, recent, list: (opts = {}) => listSessions({ fs, projectsDir, ...opts }) };
}

export default createSessions;
