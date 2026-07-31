// Module D — context: the facts around a hook event, not just the event.
//
// The brain used to be handed one sentence ("Claude Code is about to run Edit in
// ganyu-pet") and nothing else, so it could only answer in generalities. The hook
// payloads module B already keeps in its 50-entry debug ring carry far more —
// which file, which command, which project, how often, and whether the last run
// failed — and all of it was being thrown away. Everything here is a pure
// function over that ring plus module B's aggregate: no I/O, no clock of its own,
// no Electron, nothing to mock.
//
// PRIVACY — this module decides what leaves the machine, so it reads `tool_input`
// through an explicit **allowlist** of keys (ALLOWED_TOOL_INPUT_KEYS), never a
// denylist. Paths, commands, patterns, hosts and agent names are sayable; the
// keys that carry the owner's actual work — `old_string`, `new_string`,
// `content`, `prompt`, `transcript_path`'s contents, environment values — are
// simply not on the list and there is no code path that can reach them. Two
// corollaries worth stating because they are easy to undo by accident:
//   1. Only *string* values are taken, so an object smuggled under an allowed key
//      is dropped rather than serialized.
//   2. A truncated ring entry ({truncated, bytes, preview}) is treated as having
//      no payload at all. `preview` is a raw prefix of the event JSON and can
//      contain a diff, so it is never read — such an entry simply yields less.
//
// The one exception to "metadata only", added 2026-07-31 at the owner's explicit
// request: `recentPrompts` reads the **top-level** `prompt` of a
// `UserPromptSubmit` payload, so she can react to what he asked for and not only
// to what his tools did. It is not a hole in the allowlist above — that governs
// `tool_input`, where `prompt` is a subagent brief and stays refused. It is a
// different key on a different event, bounded to one prompt of MAX_PROMPT_CHARS,
// redacted through `redactSecrets`, and switchable off at the network boundary
// (GANYU_SEE_PROMPTS, read in brain.mjs). It is the highest-risk field here and
// is commented as such at `recentPrompts`.

/** How far back `summarizeRecent` looks. Long enough to see a pattern, short enough to still be "now". */
export const RECENT_WINDOW_MS = 20 * 60 * 1000;

/** A quiet gap longer than this ends one working stretch and starts the next. */
export const ACTIVITY_GAP_MS = 30 * 60 * 1000;

/** Commands are quoted back to her; this is all she needs to recognise one. */
export const MAX_COMMAND_CHARS = 60;

/**
 * What he typed, not what his tools did — see `recentPrompts`.
 *
 * `MAX_PROMPTS` is 1 on purpose. This is the highest-risk field in the system:
 * every other thing that leaves the machine is metadata the app chose, and this
 * one is free text he may have pasted anything into. One prompt answers "what is
 * he trying to do" completely; a second only adds surface. **Raising it to 2 is
 * this one number** — `recentPrompts` and the briefing already handle a list.
 */
export const MAX_PROMPT_CHARS = 200;
export const MAX_PROMPTS = 1;

/** The only `tool_input` keys that may ever be read. See the privacy note above. */
export const ALLOWED_TOOL_INPUT_KEYS = Object.freeze([
  'file_path',
  'notebook_path',
  'path',
  'command',
  'pattern',
  'url',
  'subagent_type',
]);

/**
 * Finer than speech.toolClass — she says "editing" and "reading" differently, and
 * a grep is not a glob. Deliberately a separate table rather than an import, so
 * speech and context do not import each other.
 */
const ACTION_PATTERNS = [
  [/^(bash|shell|powershell|pwsh|cmd|exec|local_shell|run_command|terminal)/i, 'shell'],
  [/^(write|create_file)/i, 'write'],
  [/^(edit|multiedit|notebookedit|apply_patch|patch|update_file|str_replace)/i, 'edit'],
  [/^(read|view|open_file|notebookread)/i, 'read'],
  [/^(grep|search_files|rg)/i, 'grep'],
  [/^(glob|ls|list_dir|find)/i, 'glob'],
  [/^(websearch)/i, 'websearch'],
  [/^(webfetch|fetch|browse|http)/i, 'fetch'],
  [/^(task|agent|subagent|dispatch)/i, 'agent'],
];

/** Commands that mean "he ran the tests" — worth counting separately, she can say it. */
const TEST_COMMAND_RE = /(^|[\s;&|(])(npm (run )?test|yarn test|pnpm test|bun test|node --test|vitest|jest|pytest|go test|cargo test|dotnet test)\b/i;

/**
 * Tokens that look like credentials, redacted before any command is quoted, as
 * [pattern, replacement] pairs so a rule that recognises a credential by its
 * *name* can keep the name and drop only the value.
 *
 * Over-redaction was the stated safe direction, and it went too far: `/` used to
 * be in the base64 class, so the perfectly ordinary path
 * `C:/Users/kw11l/AppData/Local/Temp/claude/C` — long, mixed case, a digit in
 * `kw11l` — matched the blob rule and she read out
 * `LOG="C:/<redacted>--Users-kw11l-…`. A path she cannot say is a fact lost on
 * every line that mentions one, so the rules below are anchored to things a path
 * never is: a vendor prefix, a solid hex run, a credential's own name, or a
 * blob with no separators in it at all.
 */
const SECRET_PATTERNS = [
  // ---- Shapes a pasted credential has and a command line rarely does. ----
  // These lead because several of them are invisible to the rules below: a JWT
  // and a connection string are built out of the very characters the base64 blob
  // rule excludes, so without these they would travel intact.
  //
  // A whole armoured private key. Prompt text is collapsed to one line before it
  // reaches here, so by then the block is a single token.
  [/-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?(?:-----END[^-]*-----|$)/g, '<redacted key>'],
  // A JWT: three base64url segments. The blob rule cannot see one — it excludes
  // `.`, `-` and `_`, which is most of what a JWT is made of. At best it would
  // redact the header and leave the payload and signature standing.
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '<redacted>'],
  // A connection string's credentials: `postgres://user:pass@host:5432/db`. The
  // scheme and host stay, because "he pasted a database URL" is the readable
  // half and the password is the part that must not travel.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1<redacted>@'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '<redacted>'],
  [/\bAIza[A-Za-z0-9_-]{20,}/g, '<redacted>'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '<redacted>'],
  [/\bhooks\.slack\.com\/services\/[A-Za-z0-9/_-]{10,}/g, 'hooks.slack.com/services/<redacted>'],
  // Vendor-prefixed keys. Nothing else looks like these, so they need no context.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '<redacted>'],
  [/\b(?:gh[pousr]_|xox[abposr]-)[A-Za-z0-9_-]{10,}/g, '<redacted>'],
  // 32+ hex digits in one unbroken token: a digest or a key. Path segments are
  // words, and a dashed path breaks at every `-`, so neither can reach 32.
  [/\b[0-9a-fA-F]{32,}\b/g, '<redacted>'],
  // `TOKEN=…`, `--api-key …`, `password: …` — the name says what the value is,
  // so the value goes whatever shape it has. The name stays: it is the readable
  // half, and it is what makes the redacted command still recognisable.
  [
    /([A-Za-z0-9_.-]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|apikey|token|secret|password|passwd)["']?\s*[=:]\s*)(["']?)[^\s"'`;&|]{12,}\2/gi,
    '$1$2<redacted>$2',
  ],
  [/\b(bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, '$1<redacted>'],
  // The same idea as the rule above, for the way a person *writes* it rather
  // than the way a shell parses it: "the password is hunter2please", "api key
  // sk_live_…". Free text is the only place this shape occurs, and prompt text
  // is free text — but it also catches `--password hunter2please` on a command
  // line, which the `=`/`:` rule never could. Deliberately requires the name and
  // the value to be adjacent, so "token limit", "secret sauce" and "the password
  // is wrong" are all left alone.
  [
    /\b((?:api[ _-]?keys?|access[ _-]?tokens?|auth[ _-]?tokens?|tokens?|secrets?|passwords?|passphrases?|passwd)\s+(?:is\s+|=\s*|:\s*)?)(["']?)[^\s"'`]{8,}\2/gi,
    '$1$2<redacted>$2',
  ],
  // A bare base64 blob: long, and mixed case + digits, which a word is not.
  // `/` and `-` are deliberately NOT in the class — that is the whole fix. A
  // real blob is one solid run; a path is short runs joined by separators.
  [/\b(?=[A-Za-z0-9+]*[A-Z])(?=[A-Za-z0-9+]*[a-z])(?=[A-Za-z0-9+]*[0-9])[A-Za-z0-9+]{32,}={0,2}/g, '<redacted>'],
];

const pad2 = (n) => String(n).padStart(2, '0');

/** A timestamp, or null. Spelled out because `Number(null)` is 0, which is a Tuesday in 1970. */
function finiteMs(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Path segments, either separator, drive letters and `.` dropped. */
function segments(p) {
  return String(p ?? '')
    .split(/[\\/]+/)
    .filter((s) => s !== '' && s !== '.' && !/^[A-Za-z]:$/.test(s));
}

/** Last path segment — the bit a human would say out loud. */
export function basename(p) {
  const parts = segments(p);
  return parts.length ? parts[parts.length - 1] : null;
}

/** One line, hard-capped, ellipsis when cut. Local so persona and context stay independent. */
function clampText(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Credential-looking tokens replaced. Applied to every command before it is quoted. */
export function redactSecrets(text) {
  let out = String(text ?? '');
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** A command as she may repeat it: one line, redacted, MAX_COMMAND_CHARS at most. */
export function shortCommand(command) {
  const clean = redactSecrets(command);
  const line = clampText(clean, MAX_COMMAND_CHARS);
  return line === '' ? null : line;
}

/**
 * The payload of a ring entry, or null when there isn't a usable one.
 * A truncated capture ({truncated, bytes, preview}) counts as "no payload" — see
 * the privacy note: its `preview` is arbitrary event JSON and is never read.
 */
export function payloadOf(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const raw = Object.hasOwn(entry, 'raw') ? entry.raw : entry;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.truncated === true) return null;
  return raw;
}

function toolOf(payload) {
  const raw = payload?.tool_name ?? payload?.toolName ?? payload?.tool ?? null;
  if (raw == null) return null;
  const name = typeof raw === 'object' ? (raw.name ?? raw.tool_name ?? null) : raw;
  const s = typeof name === 'string' ? name.trim() : '';
  return s === '' ? null : s;
}

function actionClass(tool) {
  if (!tool) return 'none';
  for (const [re, cls] of ACTION_PATTERNS) if (re.test(tool)) return cls;
  return 'other';
}

/**
 * The allowlist gate. Every read of `tool_input` in this file goes through here,
 * and a key not in ALLOWED_TOOL_INPUT_KEYS cannot be requested even by name.
 */
export function pickToolInput(input, keys = ALLOWED_TOOL_INPUT_KEYS) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const key of keys) {
    if (!ALLOWED_TOOL_INPUT_KEYS.includes(key)) continue;
    const value = input[key];
    if (typeof value !== 'string') continue; // strings only: no nested objects, no arrays
    const trimmed = value.trim();
    if (trimmed !== '') out[key] = trimmed;
  }
  return out;
}

function hostOf(url) {
  try {
    return new URL(url).host || null;
  } catch {
    const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(String(url ?? ''));
    return m ? m[1] : null;
  }
}

/**
 * `projectFromCwd(cwd)` — the name of the project the event happened in.
 *
 * Normally the basename of the cwd. An Orca worktree is the exception: the path
 * `C:\Users\kw11l\orca\workspaces\GolfCRM\bay-daily-codes` yields
 * **`GolfCRM/bay-daily-codes`**, repo *and* worktree, because two worktrees of one
 * repo are two different pieces of work and "bay-daily-codes" alone says nothing
 * about which repo it is. Deeper paths inside a worktree still resolve to the
 * worktree root, not the subdirectory.
 */
export function projectFromCwd(cwd) {
  const parts = segments(cwd);
  if (parts.length === 0) return null;
  for (let i = 0; i + 2 < parts.length; i += 1) {
    if (!/^\.?orca$/i.test(parts[i])) continue;
    if (parts[i + 1].toLowerCase() !== 'workspaces') continue;
    const repo = parts[i + 2];
    const worktree = parts[i + 3];
    return worktree ? `${repo}/${worktree}` : repo;
  }
  return parts[parts.length - 1];
}

/**
 * `describeAction(entry)` — one short clause for what a single event actually did,
 * built from the allowlisted parts of `tool_input`: "editing persona.mjs",
 * "running `npm test`", "fetching docs.anthropic.com".
 *
 * Takes a ring entry or a bare hook payload. Returns null when there is nothing
 * specific to say — no tool name, or a truncated capture — rather than guessing.
 */
export function describeAction(entry) {
  const payload = payloadOf(entry);
  const tool = toolOf(payload);
  if (!tool) return null;

  const input = pickToolInput(payload.tool_input);
  const cls = actionClass(tool);

  if (cls === 'shell') {
    const command = input.command ? shortCommand(input.command) : null;
    return command ? `running \`${command}\`` : 'running a shell command';
  }
  if (cls === 'write' || cls === 'edit' || cls === 'read') {
    const file = basename(input.file_path ?? input.notebook_path ?? input.path);
    const verb = cls === 'write' ? 'writing' : cls === 'edit' ? 'editing' : 'reading';
    return file ? `${verb} ${file}` : `${verb} a file`;
  }
  if (cls === 'grep') {
    const pattern = input.pattern ? clampText(input.pattern, 40) : null;
    return pattern ? `searching for "${pattern}"` : 'searching the code';
  }
  if (cls === 'glob') {
    const what = input.pattern ? clampText(input.pattern, 40) : basename(input.path);
    return what ? `looking for ${what}` : 'listing files';
  }
  if (cls === 'fetch') {
    const host = input.url ? hostOf(input.url) : null;
    return host ? `fetching ${host}` : 'fetching a page';
  }
  if (cls === 'websearch') return 'searching the web';
  if (cls === 'agent') {
    const agent = input.subagent_type
      ?? (typeof payload.agent_type === 'string' ? payload.agent_type.trim() : null);
    return agent ? `dispatching the ${agent} agent` : 'dispatching a subagent';
  }
  return tool;
}

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

/** Map -> [{name, count}], commonest first, ties broken by name so it is deterministic. */
function ranked(map, key = 'name') {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([name, count]) => ({ [key]: name, count }));
}

/**
 * `summarizeRecent(ring, {now, windowMs})` — what the last `windowMs` looked like,
 * as facts rather than prose: counts per tool and per project, which files and
 * commands were repeated, and how the failures went.
 *
 * `recovered` names the tools that failed and then succeeded again later in the
 * window; `streak` is the run of consecutive failures at the very end, which is
 * the one that is still happening. Entries with no usable payload still count
 * towards `count` and the failure tally — they are events, they just don't say
 * what they were.
 */
export function summarizeRecent(ring, { now = Date.now(), windowMs = RECENT_WINDOW_MS } = {}) {
  const at = (e) => finiteMs(e?.at);
  const cutoff = Number(now) - Number(windowMs);
  const entries = (Array.isArray(ring) ? ring : [])
    .filter((e) => e && typeof e === 'object' && at(e) !== null && at(e) >= cutoff)
    .sort((a, b) => at(a) - at(b));

  const tools = new Map();
  const projects = new Map();
  const files = new Map();
  const commands = new Map();
  const lastOutcome = new Map();
  const recovered = new Set();
  let failures = 0;
  let testRuns = 0;

  for (const entry of entries) {
    const payload = payloadOf(entry);
    const tool = toolOf(payload);
    const project = projectFromCwd(payload?.cwd ?? payload?.workspace ?? null);
    const failed = entry.failed === true;

    if (tool) bump(tools, tool);
    if (project) bump(projects, project);
    if (failed) failures += 1;

    if (tool) {
      if (failed) lastOutcome.set(tool, 'failed');
      else {
        if (lastOutcome.get(tool) === 'failed') recovered.add(tool);
        lastOutcome.set(tool, 'ok');
      }
    }

    const input = pickToolInput(payload?.tool_input, ['file_path', 'notebook_path', 'command']);
    const cls = actionClass(tool);
    if (cls === 'edit' || cls === 'write' || cls === 'read') {
      const file = basename(input.file_path ?? input.notebook_path);
      if (file) bump(files, file);
    }
    if (input.command) {
      const command = shortCommand(input.command);
      if (command) bump(commands, command);
      if (TEST_COMMAND_RE.test(input.command)) testRuns += 1;
    }
  }

  let streak = 0;
  for (let i = entries.length - 1; i >= 0 && entries[i].failed === true; i -= 1) streak += 1;

  return {
    windowMs: Number(windowMs),
    count: entries.length,
    from: entries.length ? at(entries[0]) : null,
    to: entries.length ? at(entries[entries.length - 1]) : null,
    tools: ranked(tools),
    projects: ranked(projects),
    // Only repeats: one edit of one file is not a fact worth a sentence.
    files: ranked(files).filter((f) => f.count > 1),
    commands: ranked(commands, 'text').filter((c) => c.count > 1),
    testRuns,
    failures: { count: failures, streak, recovered: [...recovered].sort() },
  };
}

/** `PreToolUse`, `pre_tool_use`, `pre-tool-use` all collapse to one spelling. */
const canonEvent = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * `recentPrompts(ring, {now, windowMs})` — what the owner most recently *asked
 * for*, as opposed to what his tools then did.
 *
 * Until this existed she could see only tool metadata, so she could react to a
 * failing `npm test` but never to the fact that he had asked for the timezone
 * bug to be fixed. The owner approved sending prompt text on 2026-07-31.
 *
 * Three things bound it, and all three matter:
 *
 *   1. **Only a `UserPromptSubmit` payload's top-level `prompt`.** Not any field
 *      called `prompt` anywhere: `tool_input.prompt` is a *subagent brief* the
 *      allowlist deliberately refuses (see `ALLOWED_TOOL_INPUT_KEYS`), and it
 *      stays refused — this reads a different key on a different event, and a
 *      truncated ring entry still yields nothing at all.
 *   2. **Redacted, through the same `redactSecrets` the commands go through**,
 *      which grew several rules for this: pasted keys, JWTs, connection strings
 *      and armoured private keys are shapes a command line rarely carries and a
 *      pasted prompt very much does.
 *   3. **Bounded** — `MAX_PROMPTS` of them, `MAX_PROMPT_CHARS` each, collapsed
 *      to one line, and inside the same recency window as everything else, so a
 *      prompt from this morning is not offered as what he just asked for.
 *
 * Oldest first, so a reader can say "he asked X, then Y" in order.
 */
export function recentPrompts(ring, { now = Date.now(), windowMs = RECENT_WINDOW_MS } = {}) {
  const cutoff = Number(now) - Number(windowMs);
  const out = [];
  const entries = Array.isArray(ring) ? ring : [];
  for (let i = entries.length - 1; i >= 0 && out.length < MAX_PROMPTS; i -= 1) {
    const entry = entries[i];
    const at = finiteMs(entry?.at);
    if (at === null || at < cutoff) continue;
    const payload = payloadOf(entry);
    if (!payload) continue;
    const event = payload.hook_event_name ?? payload.event ?? payload.type ?? null;
    if (canonEvent(event) !== 'userpromptsubmit') continue;
    if (typeof payload.prompt !== 'string') continue;
    const line = clampText(redactSecrets(payload.prompt), MAX_PROMPT_CHARS);
    if (line !== '') out.push(line);
  }
  return out.reverse();
}

/** Module B's aggregate, however it was handed to us. Never throws. */
function aggregateOf(state) {
  if (!state) return null;
  if (Array.isArray(state)) return { sessionCount: state.length, sessions: state };
  if (typeof state.aggregate === 'function') {
    try {
      return state.aggregate();
    } catch {
      return null;
    }
  }
  if (Array.isArray(state.sessions)) return state;
  return null;
}

/**
 * `sessionSnapshot(state, {now, ring, activeSinceMs})` — how many agents are live,
 * which projects they are in, and how long the owner has been at it.
 *
 * The projects come from the ring (module B's session records carry no cwd), by
 * taking the newest event seen for each live session id.
 *
 * **`activeForMs` is a lower bound, not a measurement.** Prefer the caller's
 * `activeSinceMs`, which module A carries from the first event of the current
 * working stretch (see `trackActiveSince`). With no hint, the earliest timestamp
 * still visible is used — and both the ring (50 entries) and the session table
 * (10-minute TTL) forget, so a long uninterrupted stretch reads as shorter than
 * it was. It is never an over-estimate, which is the direction that matters when
 * she is about to tell him to go to bed.
 */
export function sessionSnapshot(state, { now = Date.now(), ring = [], activeSinceMs = null } = {}) {
  const snapshot = aggregateOf(state);
  const sessions = Array.isArray(snapshot?.sessions) ? snapshot.sessions : [];
  const count = Number.isFinite(Number(snapshot?.sessionCount))
    ? Number(snapshot.sessionCount)
    : sessions.length;

  const entries = Array.isArray(ring) ? ring : [];
  const projectById = new Map();
  for (const entry of entries) {
    if (!entry || entry.sessionId == null) continue;
    const project = projectFromCwd(payloadOf(entry)?.cwd ?? payloadOf(entry)?.workspace ?? null);
    if (project) projectById.set(String(entry.sessionId), project);
  }

  const projects = [];
  for (const session of sessions) {
    const project = projectById.get(String(session?.id));
    if (project && !projects.includes(project)) projects.push(project);
  }

  let since = finiteMs(activeSinceMs);
  if (since === null) {
    const seen = [
      ...entries.map((e) => finiteMs(e?.at)),
      ...sessions.map((s) => finiteMs(s?.lastSeen)),
    ].filter((n) => n !== null);
    since = seen.length ? Math.min(...seen) : null;
  }

  return {
    count,
    projects,
    activeSince: since,
    activeForMs: since === null ? null : Math.max(0, Number(now) - since),
  };
}

const DAYPARTS = [
  [5, 'early morning'],
  [8, 'morning'],
  [12, 'midday'],
  [14, 'afternoon'],
  [18, 'evening'],
  [21, 'late evening'],
  [22, 'late night'],
];

/**
 * `localTimePhrase(now)` — {hhmm, daypart, lateNight}. `lateNight` is the one the
 * persona acts on: from 22:00 to 05:00 she is allowed to suggest he stop.
 */
export function localTimePhrase(now = Date.now()) {
  const d = now instanceof Date ? now : new Date(Number(now));
  if (Number.isNaN(d.getTime())) return null;
  const hour = d.getHours();
  const minute = d.getMinutes();
  let daypart = 'the small hours';
  for (const [from, name] of DAYPARTS) if (hour >= from) daypart = name;
  return {
    hour,
    minute,
    hhmm: `${pad2(hour)}:${pad2(minute)}`,
    daypart,
    lateNight: hour >= 22 || hour < 5,
  };
}

/** "about 40 minutes" / "about an hour" / "about 3 and a half hours". Null under a minute. */
export function describeDuration(ms) {
  const minutes = Math.round(Number(ms) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return null;
  if (minutes < 75) return `about ${Math.max(5, Math.round(minutes / 5) * 5)} minutes`;
  const halves = Math.round(minutes / 30);
  const hours = Math.floor(halves / 2);
  if (halves % 2 === 1) return hours === 1 ? 'about an hour and a half' : `about ${hours} and a half hours`;
  return hours === 1 ? 'about an hour' : `about ${hours} hours`;
}

/**
 * `trackActiveSince(prev, at)` — the working-stretch clock, as a pure step
 * function so module A only has to hold the value. A quiet gap longer than
 * `gapMs` is a new stretch: he went to bed, and coming back at 09:00 must not
 * report that he has been working for eleven hours.
 */
export function trackActiveSince(prev, at = Date.now(), { gapMs = ACTIVITY_GAP_MS } = {}) {
  const t = Number(at);
  if (!Number.isFinite(t)) return prev ?? null;
  const since = Number(prev?.since);
  const last = Number(prev?.last);
  if (!Number.isFinite(since) || !Number.isFinite(last) || t - last > gapMs || t < since) {
    return { since: t, last: t };
  }
  return { since, last: Math.max(last, t) };
}

/**
 * Everything above, assembled once per brain request. Module A injects the ring
 * and the state; nothing else in the app needs to know the shape.
 *
 * Returns null rather than throwing — a brain input without context is the old
 * thin line, which still works.
 */
export function buildContext({
  ring = [],
  state = null,
  now = Date.now(),
  activeSinceMs = null,
  windowMs = RECENT_WINDOW_MS,
} = {}) {
  try {
    const entries = Array.isArray(ring) ? ring : [];
    return {
      time: localTimePhrase(now),
      recent: summarizeRecent(entries, { now, windowMs }),
      sessions: sessionSnapshot(state, { now, ring: entries, activeSinceMs }),
      // Extracted unconditionally; whether it is *sent* is brain.mjs's call, at
      // the network boundary, where GANYU_SEE_PROMPTS is read. Deciding it here
      // would put the switch behind a pure function with no access to config,
      // and leave two places able to reach the field.
      prompts: recentPrompts(entries, { now, windowMs }),
    };
  } catch {
    return null;
  }
}

export default buildContext;
