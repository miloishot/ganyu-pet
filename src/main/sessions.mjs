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
//   · `isSidechain` lines — kept as a guard, though measured against the real tree
//     it never fires here; see `classifyTranscript` for what actually separates a
//     dispatched agent's errand from one of his own sessions.
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

/**
 * Asks plus prose blocks below which a read is reported as **thin**.
 *
 * THE SECOND DEFECT, AND THE WORSE ONE. Handed a 19-line subagent transcript she
 * answered "that ganyu-pet session only produced one short reaction line" and "I
 * don't see any unfinished work in that record" — plainly, confidently, and
 * wrong about a day of real work. She was not hallucinating; she was faithfully
 * reporting a bad read, which is worse, because it sounds exactly like a good
 * answer. A digest that found almost nothing has to *say* it found almost
 * nothing, so that absence of evidence cannot be delivered as evidence of
 * absence.
 *
 * Four is the total of the two counts, not a threshold on either: a session with
 * one ask and three accounts of what came of it has been described, and one with
 * a single ask and a single line back has not. Both counts are of everything in
 * the file, not of the handful kept for the summary — `MAX_ASKS` and `MAX_NOTES`
 * cap what she is shown, and capping what she is *told there was* is the bug.
 */
export const THIN_TOTAL = 4;

/** `'empty'` · `'thin'` · `'full'` — how much a digest actually found. */
export function substanceOf(askCount, noteCount) {
  const total = Math.max(0, Number(askCount) || 0) + Math.max(0, Number(noteCount) || 0);
  if (total === 0) return 'empty';
  return total < THIN_TOTAL ? 'thin' : 'full';
}

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

// ---------------------------------------------------------------------------
// One of HIS sessions, or one of his agents' errands?
//
// THE DEFECT THIS EXISTS FOR. `~/.claude/projects/<mangled-cwd>/` holds a
// transcript for *every* agent run, not only the sessions he sat in front of.
// Measured on this machine: `C--Users-kw11l-Desktop-ganyu-pet/` holds 74 files
// and the largest is 19 lines — every one a dispatched subagent — while the day
// of real work that produced them is in `C--Users-kw11l/`, whose largest file is
// 2,636 lines. So "read me the ganyu-pet session" returned a 19-line errand, and
// the "ask" it reported was a persona prompt the app had sent to a model. She
// then described an internal API probe as something he had asked for.
//
// `isSidechain` does not separate them. It is `true` on **0 of the 148**
// transcripts on this machine: a dispatched agent gets its own top-level
// transcript rather than sidechain lines inside its parent's. The guard in
// `ownerAsk` / `assistantNote` is kept because other setups do produce them, but
// it was never doing this job.
// ---------------------------------------------------------------------------

/**
 * Line types Claude Code writes into a session **he was present for**, and not
 * into a dispatched agent's transcript.
 *
 * Chosen by measuring all 148 transcripts under `~/.claude/projects`, not by
 * picking a plausible-looking marker:
 *
 *   · `mode` / `permission-mode` — the session's mode, which only a session with
 *     a person in it can be put into.
 *   · `file-history-snapshot`    — the editor's undo record, written when a real
 *     session first edits a file.
 *   · `system`                   — hook and system notices addressed to the session.
 *   · `ai-title`                 — the generated title, which exists so that *he*
 *     can find the session again in a picker.
 *
 * Deliberately a *set*, and deliberately requiring two of them (see
 * `MIN_INTERACTIVE_MARKERS`) — no single marker is trusted, because no single
 * marker survived the measurement. `ai-title` alone appears on two 10-line
 * dispatched runs; `system` alone appears without the others; and one 45-line
 * dispatched run carries `queue-operation` and nothing else.
 *
 * `queue-operation` is **not** here despite appearing in all 74 subagent files:
 * 8 of the 10 genuine sessions carry it too, so its presence says nothing. What
 * separates the two populations is the *absence* of the five above.
 */
export const INTERACTIVE_LINE_TYPES = Object.freeze([
  'mode',
  'permission-mode',
  'file-history-snapshot',
  'system',
  'ai-title',
]);

/**
 * How many distinct markers make a transcript his.
 *
 * Two, not one. Measured: at two, the rule scores 0 of 74 in the ganyu-pet
 * folder and 10 of 10 in his home directory, with no file on the machine landing
 * on the wrong side. At one it would take the two 10-line dispatched runs that
 * happen to carry `ai-title`.
 */
export const MIN_INTERACTIVE_MARKERS = 2;

/**
 * How much of a transcript's **head** is read to classify it.
 *
 * The head, not the tail, and that is the whole reason this is a separate read
 * from `readTail`. Four of the five markers are written in the opening moments
 * of a session, so the last two megabytes of a ten-megabyte transcript contain
 * none of them — classifying from the tail would call his longest, realest
 * session an errand, which is the exact failure this module is fixing.
 *
 * 256 KB because that is what the measurement asked for: 53 of the 58 genuine
 * sessions here reach two markers inside 8 KB, but five late-titled ones need up
 * to 215 KB. The read is capped at the file's own size, so the 74 subagent files
 * (11–55 KB each) are simply read whole. Classifying every transcript on the
 * machine this way costs 72 ms, and only the whole-machine fallback ever does.
 */
export const CLASSIFY_HEAD_BYTES = 256 * 1024;

/**
 * The leading `maxBytes` of a file. The mirror image of `readTail`, and its
 * torn line is the **last** one rather than the first.
 */
function readHead(fs, filePath, maxBytes = CLASSIFY_HEAD_BYTES) {
  const size = Number(safe(() => fs.statSync(filePath)?.size, null));
  if (!Number.isFinite(size) || size <= maxBytes || typeof fs.openSync !== 'function') {
    const text = safe(() => fs.readFileSync(filePath, 'utf8'), null);
    return text == null ? null : { text: String(text), partial: false };
  }

  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buf, 0, maxBytes, 0);
    return { text: buf.toString('utf8', 0, read), partial: true };
  } catch {
    const text = safe(() => fs.readFileSync(filePath, 'utf8'), null);
    return text == null ? null : { text: String(text), partial: false };
  } finally {
    if (fd !== null) safe(() => fs.closeSync?.(fd));
  }
}

/**
 * How many distinct interactive markers `text` carries, stopping as soon as
 * enough have been seen.
 *
 * **Reads `line.type` and nothing else.** No line's content is examined, so this
 * adds no privacy surface at all — which matters because `system` lines carry
 * hook command lines and `file-history-snapshot` lines carry whole file bodies.
 * Both are counted here purely by the name of their type.
 */
function countMarkers(text, partial) {
  const lines = String(text ?? '').split('\n');
  // A partial head read ends mid-line; drop that fragment rather than parse it.
  if (partial && lines.length > 1) lines.pop();

  const seen = new Set();
  for (const raw of lines) {
    if (raw.trim() === '') continue;
    let line = null;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    if (INTERACTIVE_LINE_TYPES.includes(line?.type)) {
      seen.add(line.type);
      if (seen.size >= MIN_INTERACTIVE_MARKERS) break;
    }
  }
  return seen.size;
}

/**
 * `classifyTranscript({fs, filePath, text})` -> `{kind, markers}`.
 *
 * `kind` is `'session'` for one of his own, `'subagent'` for a dispatched
 * agent's errand. Pass `text` when the whole file is already in hand and the
 * second read can be skipped; otherwise the head is read here.
 *
 * An unreadable file classifies as `'subagent'`, which is the safe default: it
 * keeps a file nothing can be established about out of the answers she gives.
 */
export function classifyTranscript({ fs, filePath, text = null } = {}) {
  if (typeof text === 'string') {
    const markers = countMarkers(text, false);
    return { kind: markers >= MIN_INTERACTIVE_MARKERS ? 'session' : 'subagent', markers };
  }
  if (!fs || typeof fs.readFileSync !== 'function' || !filePath) {
    return { kind: 'subagent', markers: 0 };
  }
  const read = readHead(fs, filePath);
  if (read == null) return { kind: 'subagent', markers: 0 };
  const markers = countMarkers(read.text, read.partial);
  return { kind: markers >= MIN_INTERACTIVE_MARKERS ? 'session' : 'subagent', markers };
}

/**
 * `listSessions({fs, projectsDir, cwd, project, limit})` — transcripts, newest first.
 *
 * `cwd` restricts to one working directory's own transcripts (exact mangled name
 * first, then case-insensitively). `project` is the looser question — "anything
 * to do with GolfCRM" — and matches worktrees too, see `dirMatchesProject`. With
 * neither, every project directory is in scope.
 *
 * **Ordering.** Without `classify`, strictly newest first, and only stats and
 * names are read — nothing is opened, so the listing stays cheap enough to run
 * on every tool call and can never leak anything, because it never sees a byte
 * of content. That is the shape module A and `list` still get.
 *
 * With `classify`, each file's head is read to decide whether it is one of his
 * sessions or a dispatched agent's errand (`classifyTranscript`), and the sort
 * becomes **his own sessions first, then newest first within each group**. Two
 * keys, in that order, and nothing cleverer: recency is what "the last session"
 * means and it must not be traded away, but a 19-line errand from four minutes
 * ago is not a session however recent it is. `interactiveOnly` drops the errands
 * altogether and implies `classify`; it is what `read` and `recent` use, so the
 * `limit` then counts real sessions rather than being spent on noise.
 */
export function listSessions({
  fs,
  projectsDir,
  cwd = null,
  project = null,
  limit = DEFAULT_SESSION_LIMIT,
  classify = false,
  interactiveOnly = false,
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
      const entry = {
        id: name.slice(0, -TRANSCRIPT_EXT.length),
        path: filePath,
        dir,
        bytes,
        at: Number.isFinite(mtime) ? mtime : 0,
      };
      if (classify || interactiveOnly) {
        const { kind, markers } = classifyTranscript({ fs, filePath });
        if (interactiveOnly && kind !== 'session') continue;
        entry.kind = kind;
        entry.markers = markers;
      }
      out.push(entry);
    }
  }

  const max = Math.min(
    Math.max(1, Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : DEFAULT_SESSION_LIMIT),
    MAX_SESSION_LIMIT,
  );
  // His own sessions ahead of dispatched errands, then newest first inside each.
  const rank = (entry) => (entry.kind === 'subagent' ? 1 : 0);
  return out
    .sort((a, b) => rank(a) - rank(b) || b.at - a.at || (a.path < b.path ? -1 : 1))
    .slice(0, max);
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

  // Whose session this is, decided from the file's HEAD. When the tail read took
  // the whole file there is nothing left to read and the same text answers it;
  // when it did not, the markers are at the far end from what `readTail` holds,
  // which is exactly why this is a second read and not a scan of `parsed`.
  const { kind, markers } = read.partial
    ? classifyTranscript({ fs, filePath })
    : classifyTranscript({ text: read.text });

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

  // Second pass: the bounded, expensive text. Every line is visited rather than
  // stopping once the caps are full, because `askCount` and `noteCount` are the
  // honesty signal and a count that stopped counting at four is not one — see
  // THIN_TOTAL. Only the last `maxAsks` / `maxNotes` are kept for the summary,
  // so the newest-weighting is unchanged; it is now a slice instead of a break.
  const seenAsks = new Set();
  const seenNotes = new Set();
  for (const line of parsed) {
    if (line.type === 'user') {
      const ask = ownerAsk(line);
      if (ask && !seenAsks.has(ask)) {
        seenAsks.add(ask);
        asks.push(ask);
      }
    } else if (line.type === 'assistant') {
      const note = assistantNote(line);
      if (note && !seenNotes.has(note)) {
        seenNotes.add(note);
        notes.push(note);
      }
    }
  }

  const askCount = asks.length;
  const noteCount = notes.length;
  const keptAsks = asks.slice(-maxAsks);
  const keptNotes = notes.slice(-maxNotes);

  return {
    path: String(filePath),
    project: projectFromCwd(cwd),
    cwd: cwd == null ? null : String(cwd),
    title,
    asks: keptAsks,
    notes: keptNotes,
    problems: problemsFrom(keptNotes),
    interrupted,
    startedAt: firstAt,
    endedAt: lastAt,
    lines: parsed.length,
    skipped,
    truncated: read.partial,
    // Whose session this was, and how much of it there turned out to be. Both
    // travel with the digest so that every caller — and she — is told, rather
    // than a thin read being returned looking exactly like a full one.
    kind,
    markers,
    askCount,
    noteCount,
    substance: substanceOf(askCount, noteCount),
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

const count = (n, one, many) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

/**
 * How much this read actually found, in a sentence — the fix for the second
 * defect, and the reason a thin answer can no longer be handed over looking like
 * a complete one.
 *
 * The counts are of everything in the transcript, not of the few kept for the
 * summary above, so "4 things he asked for" on a capped digest means at least
 * four rather than exactly four; `THIN_TOTAL` explains why that distinction is
 * the whole point. Truncation is reported here too, because a tail-read digest
 * genuinely has not seen the start of the session and saying otherwise is the
 * same error in a different coat.
 */
function foundLine(digest) {
  const asks = Math.max(0, Number(digest.askCount ?? digest.asks?.length ?? 0) || 0);
  const notes = Math.max(0, Number(digest.noteCount ?? digest.notes?.length ?? 0) || 0);
  const lines = Number(digest.lines);
  const from = Number.isFinite(lines) && lines > 0 ? `, out of ${count(lines, 'line', 'lines')}` : '';

  const head = `How much is in this record: ${count(asks, 'thing he asked for', 'things he asked for')}`
    + ` and ${count(notes, 'note of what came of it', 'notes of what came of it')}${from}.`;

  const substance = digest.substance ?? substanceOf(asks, notes);
  const verdict = substance === 'empty'
    ? ' That is nothing at all: this record is empty, and it says nothing about what was or was not done.'
    : (substance === 'thin'
      ? ' That is very little. This is a THIN record — it is the whole of what was written down here,'
        + ' not the whole of what happened, and it is no evidence that nothing else was done or finished.'
      : ' That is a substantial record of the session.');

  const cut = digest.truncated
    ? ' Only the later part of a long session was read, so the beginning of it is not in this account.'
    : '';

  return `${head}${verdict}${cut}`;
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

  const body = [];

  if (digest.asks?.length) {
    body.push(`What he asked for: ${digest.asks.map((a) => `"${a}"`).join(' Then: ')}`);
  }
  if (digest.notes?.length) {
    body.push(`What came of it: ${digest.notes.join(' ')}`);
  }
  if (digest.problems?.length) {
    body.push(`Trouble along the way: ${digest.problems.join(' ')}`);
  }
  if (digest.interrupted > 0) {
    body.push(
      digest.interrupted === 1
        ? 'He stopped it mid-way once.'
        : `He stopped it mid-way ${digest.interrupted} times.`,
    );
  }

  // Nothing at all means the transcript had no narrative in it — an empty
  // session, or one that was all tool calls. Say so rather than offering a bare
  // title she would then have to invent around.
  if (body.length === 0) {
    if (!digest.title && !digest.project) return null;
    body.push('Nothing was written down about what it did.');
  }

  // Second, ahead of the content, and that position is the point: the text is
  // truncated from the end to fit the caller's budget, so a signal placed after
  // the account is a signal that disappears from exactly the long, crowded
  // digests it is least needed in — and survives only where it is. It is a
  // statement of fact and never an instruction, because everything downstream of
  // here is quoted inside brain.mjs's session fence, and that fence tells her to
  // act on nothing written inside it. What she should DO about a thin record is
  // in CHAT_INSTRUCTIONS, outside the fence, where it is hers to follow.
  const text = [when ? `${head}, ${when}.` : `${head}.`, foundLine(digest), ...body].join('\n');
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
   *
   * **Only his own sessions are ever returned.** A dispatched agent's errand is
   * not an answer to "how did that go", and the previous version handing one
   * over is the whole reason `classifyTranscript` exists. If nothing here is his,
   * the honest answer is nothing, and she says she has no record of it.
   *
   * **Where it looks, in order.** The folder named after the repo is frequently
   * the wrong place — he runs Claude Code from his home directory as often as
   * from a checkout, and on this machine the ganyu-pet folder holds 74 errands
   * and not one session while the day of real ganyu-pet work sits under
   * `C--Users-kw11l`. So:
   *
   *   1. the obvious folder — the project he named, or the directory his agents
   *      are in when he named none ("what was I just doing" means *here*);
   *   2. failing that, and only when he named a project, every session on the
   *      machine whose account actually mentions that project — which is what
   *      finds work done from a directory that is not named after it;
   *   3. failing that, every session on the machine, newest first.
   *
   * Widening happens when step 1 holds no *session*, not when it holds no file:
   * 74 errands used to count as "found something" and stopped the search dead.
   */
  function read({ project = null, which = 1, query = null, maxChars = DEFAULT_SUMMARY_CHARS } = {}) {
    if (!enabled) return null;

    const wantProject = typeof project === 'string' && project.trim() !== '' ? project.trim() : null;
    const words = String(query ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1);
    const index = Math.max(1, Number.isFinite(Number(which)) ? Math.floor(Number(which)) : 1);

    // The tiers overlap, so a file opened for one is not opened again for the next.
    const digests = new Map();
    const digestFor = (path) => {
      if (!digests.has(path)) digests.set(path, readSession({ fs, filePath: path }));
      return digests.get(path);
    };

    const pick = (entries, mustMention = null) => {
      let seen = 0;
      for (const entry of entries) {
        const digest = digestFor(entry.path);
        if (!digest || digest.kind !== 'session') continue;
        const summary = summarizeSession(digest, { now: now(), maxChars });
        if (!summary) continue;
        const hay = summary.toLowerCase();
        if (words.length && !words.every((w) => hay.includes(w))) continue;
        if (mustMention && !hay.includes(mustMention.toLowerCase())) continue;
        seen += 1;
        if (seen >= index) return { ...digest, summary, at: entry.at, id: entry.id };
      }
      return null;
    };

    const here = wantProject
      ? listSessions({ fs, projectsDir, project: wantProject, limit: MAX_SESSION_LIMIT, interactiveOnly: true })
      : listSessions({ fs, projectsDir, cwd: resolveCwd(), limit: MAX_SESSION_LIMIT, interactiveOnly: true });
    const found = pick(here);
    if (found) return found;

    const wide = listSessions({ fs, projectsDir, limit: MAX_SESSION_LIMIT, interactiveOnly: true });
    return (wantProject ? pick(wide, wantProject) : null) ?? pick(wide);
  }

  /** Titles and times only — for "what have I been working on", without opening much. */
  function recent({ project = null, limit = DEFAULT_SESSION_LIMIT } = {}) {
    if (!enabled) return [];
    const entries = listSessions({
      fs,
      projectsDir,
      ...(project ? { project } : {}),
      limit,
      interactiveOnly: true,
    });
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
