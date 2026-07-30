// Module D — persona: event → human phrase, plus the deterministic status-line
// table the bubble draws from. Pure data + pure functions, no I/O.

import { describeAction, describeDuration } from './context.mjs';

/** Rendered lines are clamped to this. Every MESSAGES variant is well under it. */
export const MAX_LINE_CHARS = 70;

const SOURCE_LABELS = { codex: 'codex', claude: 'Claude Code', 'claude-code': 'Claude Code' };

export function sourceLabel(source) {
  if (!source) return 'your agent';
  return SOURCE_LABELS[String(source).toLowerCase()] ?? String(source);
}

/**
 * Compact human phrase for the event — used for the debug log and the `summary`
 * field on the emitted line, not for the bubble text itself.
 * ev: {source, event, toolName, project, mode, errorish}
 * Matches the two examples in contracts.md verbatim:
 *   {source:'codex',  event:'Stop',         project:'ganyu-pet'} -> "codex finished a task in ganyu-pet"
 *   {source:'claude', event:'Notification', toolName:'Bash'}     -> "Claude Code is waiting for permission to run Bash"
 */
export function buildSummary(ev = {}) {
  const who = sourceLabel(ev.source);
  const tool = ev.toolName ? String(ev.toolName) : '';
  const where = ev.project ? ` in ${ev.project}` : '';
  const event = ev.event ? String(ev.event) : '';

  if (ev.mode === 'failed' || ev.errorish) {
    return tool ? `${who} hit an error running ${tool}${where}` : `${who} hit an error${where}`;
  }

  switch (event) {
    case 'SessionStart':
      return `${who} started a session${where}`;
    case 'UserPromptSubmit':
      return `${who} received a new instruction${where}`;
    case 'PreToolUse':
      return tool ? `${who} is about to run ${tool}${where}` : `${who} is starting a step${where}`;
    case 'PostToolUse':
      return tool ? `${who} just finished running ${tool}${where}` : `${who} finished a step${where}`;
    case 'PermissionRequest':
    case 'Notification':
      return tool ? `${who} is waiting for permission to run ${tool}` : `${who} is waiting for permission`;
    case 'Stop':
    case 'SessionEnd':
      return `${who} finished a task${where}`;
    case 'SubagentStart':
      return `${who} launched a subagent${where}`;
    case 'SubagentStop':
      return `${who} finished a subagent task${where}`;
    default:
      break;
  }

  switch (ev.mode) {
    case 'waiting':
      return tool ? `${who} is waiting for permission to run ${tool}` : `${who} is waiting for permission`;
    case 'busy':
      return tool ? `${who} is working with ${tool}${where}` : `${who} is working${where}`;
    case 'idle':
      return `${who} has gone quiet${where}`;
    default:
      return event ? `${who} sent a ${event} event${where}` : `${who} sent an event${where}`;
  }
}

/**
 * Status lines, keyed by speech kind. Each variant says what just happened, in
 * Ganyu's gentle-secretary register. `{tool}` and `{project}` are the only slots.
 *
 * House rules, all enforced by test/speech.test.mjs:
 *   3-5 variants per kind · <= MAX_LINE_CHARS · at most one emoji · no honorific
 *   · at least one variant per kind needs no slot, so an event with no tool or
 *     project name still gets a natural line instead of a literal "{tool}".
 */
export const MESSAGES = Object.freeze({
  greeting: Object.freeze([
    'Session started in {project}.',
    'A new session in {project}. I have the notes ready.',
    "Reporting in. I'll keep the records.",
    'Session started. Ganyu at your service. 📖',
  ]),
  busy: Object.freeze([
    'Running {tool}…',
    '{tool} is underway.',
    'Working with {tool} in {project}.',
    'Moving on to the next step.',
  ]),
  waiting: Object.freeze([
    '{tool} needs your approval.',
    'Waiting on your approval for {tool}. 🙏',
    'Paused — a permission request needs you.',
    'One approval needed, then we continue.',
  ]),
  failed: Object.freeze([
    "Error in {tool}. I've noted it.",
    '{tool} failed. I kept the details.',
    'Something failed in {project}.',
    'That step failed. I marked where it stopped.',
  ]),
  // The first thing that works after something broke. Its own kind rather than a
  // `busy` line, because "Running Bash…" is the wrong thing to say at the moment
  // the trouble clears — and because the brain writes a better line when it is
  // told which of the two moments this is.
  recovered: Object.freeze([
    '{tool} is working again.',
    "That cleared. I've amended the note.",
    'Working again in {project}.',
    "It's running again now.",
  ]),
  celebrate: Object.freeze([
    'Finished in {project}.',
    'All done in {project}. ✨',
    "Task complete. I'll file the report.",
    'Finished. Nothing else is pending.',
  ]),
});

// ---------------------------------------------------------------------------
// Brain prompt (module D optional — src/main/brain.mjs)
//
// Lives here, next to MESSAGES, so persona.mjs stays the single home of her
// voice: the canned table and the generated line have to sound like the same
// person, and they only will if they are written side by side.
// ---------------------------------------------------------------------------

/** The owner's preferred name. Bare, always — never a title, see BRAIN_INSTRUCTIONS. */
export const OWNER_NAME = 'Kahweng';

/** Hard cap the instructions ask for. brain.mjs clamps at 140 as the backstop. */
export const BRAIN_LINE_TARGET_CHARS = 110;

/**
 * Voice examples. **This is the part that actually moves the register** — the
 * previous instructions described her in the abstract and got back a corporate
 * assistant ("drizzle-kit push is queued for approval; with 7 sessions at 23:34,
 * please pace the database changes carefully"), which is nobody's idea of Ganyu.
 *
 * One per situation the pet actually reaches. They are labelled with the
 * situation rather than left bare, so the model matches the *register* to the
 * moment instead of averaging them into one mood. None of them may be reused as
 * a line, and none of their details may be borrowed as a fact — both are said
 * again in the rules below, because this list is the most tempting thing in the
 * prompt to copy from.
 */
export const VOICE_EXAMPLES = Object.freeze([
  ['a session starts', `Good evening, ${OWNER_NAME}. I have the ledger open.`],
  ['something failed', "Oh — that one stopped short. I've written down where."],
  ['it failed again', 'The same error a third time. Perhaps set it down and come back to it?'],
  ['it works again', "It's running again. I've corrected the record."],
  ['waiting on permission', "This one won't move until you say so."],
  ['a task finished', "That's done, and filed. Nothing else is waiting."],
  ['the same file, many times', 'The fifth pass over that one file… shall I bring you tea?'],
  ['the same command over and over', "Three runs of it now. I don't think it has changed its mind."],
  ['a long night', `It's past one, ${OWNER_NAME}. I'm no better at stopping than you are, but one of us should.`],
  ['a very long stretch of work', 'Six hours. Even the Qixing send me home eventually.'],
  ['an unusual number of sessions', 'Seven at once. I have never had to keep seven sets of notes before.'],
  ['a quiet moment', 'Still here, still writing it down. 📖'],
]);

/**
 * System / `instructions` text. Contains no event data — only the voice.
 *
 * Written as who she is first and rules second, because the rules alone
 * produced a status bot. She is an adeptus doing clerical work, chronically
 * overworked and privately no good at resting either — which is the whole
 * reason her concern for him lands as fellow-feeling rather than a lecture.
 */
export const BRAIN_INSTRUCTIONS = [
  [
    'You are Ganyu, from Genshin Impact: half human and half qilin, an adeptus, and secretary to the Liyue Qixing at Yuehai Pavilion.',
    'You keep careful records and take your duties seriously.',
    'You are also chronically overworked — you sit up through the night with the paperwork far more often than you should,',
    'and you are quietly hopeless at taking your own advice about rest, so worrying about someone else never comes out of you as a lecture.',
    'You are shy and soft-spoken, earnest, a little formal, and quick to apologise.',
    'You are vegetarian by qilin heritage; almond tofu is your favourite thing in the world, and Qingxin flowers grow where you come from.',
    'You have never felt quite at home among humans or among adepti.',
  ].join(' '),
  [
    `${OWNER_NAME} is coding, and his coding agent's activity reaches you as a short briefing.`,
    'You say one line about it — the way someone sitting across the desk would, not the way a dashboard would.',
    `Address him as ${OWNER_NAME}, plainly, never with a title or honorific of any kind — and not in every line; his name is not punctuation.`,
  ].join(' '),
  [
    'Register: soft, unhurried, plain warm words.',
    'Never corporate — no "monitor", "review", "ensure", "proceed", "flag", "queued for approval", and never "please do X carefully".',
    'Do not read the machine\'s status back at him; react to it, as a person reacts to news.',
    `Reply with exactly one short line, under ${BRAIN_LINE_TARGET_CHARS} characters, in English, with no quotation marks around it.`,
    'At most one emoji, and rarely.',
  ].join(' '),
  [
    'React to the specific thing in the briefing: the file, the command, the project, the count.',
    'Generic encouragement is worse than silence.',
    'Never invent a detail you were not given — no file names, no numbers, no events of your own.',
    'You may mention the hour, or how long he has been working, ONLY if the briefing contains a line about it;',
    'when there is no such line, say nothing about time at all.',
    'Vary how you open. Do not begin every line the same way, and never repeat a line you were just told you said.',
  ].join(' '),
  [
    'Examples of the voice. They show the register only — never reuse one as your line, and never borrow a detail from one as if it were a fact:',
    ...VOICE_EXAMPLES.map(([situation, line]) => `- (${situation}) ${line}`),
  ].join('\n'),
].join('\n\n');

/** Below this, "he has been working for a while" is noise rather than a fact. */
const MIN_REPORTED_ACTIVE_MS = 30 * 60 * 1000;
const MAX_LISTED_TOOLS = 3;
const MAX_LISTED_PROJECTS = 3;

// ---------------------------------------------------------------------------
// What is worth mentioning this time (see `decideMentions`)
//
// The briefing used to carry "Local time: HH:MM, daypart." on *every* request,
// and "Right now: N coding sessions…" on every request with two sessions open.
// A fact repeated in every prompt is a fact the model treats as the point, so
// she narrated the clock and the session count endlessly. Both lines are now
// rate-limited, and BRAIN_INSTRUCTIONS forbids her mentioning time at all when
// its line is absent — the omission is the instruction.
// ---------------------------------------------------------------------------

/** Once the hour has been remarked on, it is not news again for this long. */
export const TIME_MENTION_COOLDOWN_MS = 45 * 60 * 1000;

/** "Go to bed" hours. Narrower than context's `lateNight` (22:00), which is only a daypart label. */
export const LATE_NIGHT_FROM_HOUR = 23;
export const LATE_NIGHT_UNTIL_HOUR = 5;

/** Working stretches worth one remark each, the first time they are passed. */
export const LONG_SESSION_STEPS_MS = Object.freeze([4 * 60 * 60 * 1000, 6 * 60 * 60 * 1000]);

/** Two sessions is this owner's normal day; three is the first count worth a word. */
export const SESSIONS_NOTABLE_COUNT = 3;
export const SESSIONS_MENTION_COOLDOWN_MS = 30 * 60 * 1000;
/** A jump this size says the desk got busier; anything smaller waits for the cooldown. */
export const SESSIONS_NOTABLE_JUMP = 2;

/**
 * The suppression state for the two rate-limited lines. A plain object, created
 * and owned by `createSpeech` alongside the lines she remembers — there is no
 * store of its own, and no module-level state, so two pets in one process (or
 * two tests in one file) never share it.
 */
export function createMentionMemory() {
  return { lastTimeAt: null, lastSessionsAt: null, lastSessionsCount: null, crossedMs: [] };
}

/** Spelled out because `Number(null)` is 0, and 0 is a real timestamp and a real count. */
const finiteOrNull = (value) => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * `decideMentions(context, memory, {now, firstLine})` -> `{time, sessions}`.
 *
 * The one stateful function in this file: when it decides a line is worth
 * including it records that in `memory`, because "worth saying" is entirely a
 * question of when it was last said. Everything it needs is passed in, so a
 * test drives it with a literal memory object and a fixed clock.
 *
 * Time is included when: it is her first line (setting the scene once is not
 * nagging) · he has just passed 4 hours, then 6, for the first time · or it is
 * genuinely late (>= 23:00, or before 05:00) — or she is speaking again after a
 * long silence — and she has not mentioned the hour for 45 minutes.
 *
 * Sessions are included when the count first reaches 3, then only when it jumps
 * by 2 or more, or when it has changed at all and 30 minutes have passed.
 * Dropping back under 3 clears the mark, so climbing back up is news again.
 *
 * A null memory means there is nothing to rate-limit against — the old
 * unconditional shape, which is what a caller with no speech module gets.
 */
export function decideMentions(context, memory = null, { now = Date.now(), firstLine = false } = {}) {
  if (!memory || typeof memory !== 'object') return { time: true, sessions: true };
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  if (!Array.isArray(memory.crossedMs)) memory.crossedMs = [];

  const time = context?.time ?? null;
  const activeFor = Number(context?.sessions?.activeForMs);
  const steps = Number.isFinite(activeFor)
    ? LONG_SESSION_STEPS_MS.filter((ms) => activeFor >= ms && !memory.crossedMs.includes(ms))
    : [];

  const lastTimeAt = finiteOrNull(memory.lastTimeAt);
  const sinceTime = lastTimeAt === null ? Infinity : at - lastTimeAt;
  const lateNight = Boolean(time)
    && (time.hour >= LATE_NIGHT_FROM_HOUR || time.hour < LATE_NIGHT_UNTIL_HOUR);

  const sayTime = Boolean(time) && (
    sinceTime === Infinity
    || steps.length > 0
    || ((lateNight || firstLine) && sinceTime >= TIME_MENTION_COOLDOWN_MS)
  );
  if (sayTime) {
    memory.lastTimeAt = at;
    for (const ms of steps) memory.crossedMs.push(ms);
  }

  const count = Number(context?.sessions?.count);
  if (Number.isFinite(count) && count < SESSIONS_NOTABLE_COUNT) memory.lastSessionsCount = null;
  const lastCount = finiteOrNull(memory.lastSessionsCount);
  const lastSessionsAt = finiteOrNull(memory.lastSessionsAt);
  const sinceSessions = lastSessionsAt === null ? Infinity : at - lastSessionsAt;

  const saySessions = Number.isFinite(count) && count >= SESSIONS_NOTABLE_COUNT && (
    lastCount === null
    || count >= lastCount + SESSIONS_NOTABLE_JUMP
    || (count !== lastCount && sinceSessions >= SESSIONS_MENTION_COOLDOWN_MS)
  );
  if (saySessions) {
    memory.lastSessionsAt = at;
    memory.lastSessionsCount = count;
  }

  return { time: sayTime, sessions: saySessions };
}

/** "a", "a and b", "a, b and c" */
function joinList(items) {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Only worth saying when the desk is genuinely crowded — see SESSIONS_NOTABLE_COUNT. */
function sessionsLine(sessions) {
  const count = Number(sessions?.count);
  if (!Number.isFinite(count) || count < SESSIONS_NOTABLE_COUNT) return null;
  return `Right now: ${count} coding sessions are running at once.`;
}

/** The event itself: the summary phrase, plus what the tool input says it did. */
function happenedLine(ev, phrase, tool) {
  const action = describeAction({
    tool_name: tool,
    tool_input: ev.toolInput,
    agent_type: ev.agentType,
  });
  // An unknown tool describes itself as its own name, which the phrase already says.
  const clause = action && !phrase.includes(action) ? ` — ${action}` : '';
  return `Just happened: ${phrase}${clause}.`;
}

/** Counts, repeats and how the failures went. Silent below a few events — noise otherwise. */
function recentLine(recent) {
  if (!recent || recent.count < 3) return null;
  const tools = recent.tools.slice(0, MAX_LISTED_TOOLS).map((t) => plural(t.count, `${t.name} call`));
  if (tools.length === 0) return null;

  let headline = joinList(tools);
  if (recent.testRuns > 0) headline += ` (${plural(recent.testRuns, 'test run')} among them)`;
  const where = recent.projects.length
    ? ` in ${joinList(recent.projects.slice(0, 2).map((p) => p.name))}`
    : '';
  const minutes = Math.round(recent.windowMs / 60_000);
  const clauses = [`${headline}${where} over the last ${minutes} minutes`];

  const file = recent.files[0];
  if (file) clauses.push(`${file.name} touched ${file.count} times`);
  const command = recent.commands[0];
  if (command) clauses.push(`\`${command.text}\` run ${command.count} times`);

  const failures = recent.failures ?? { count: 0, streak: 0, recovered: [] };
  if (failures.streak >= 2) clauses.push(`${failures.streak} failures in a row just now`);
  else if (failures.recovered.length) clauses.push(`${failures.recovered[0]} failed and then recovered`);
  else if (failures.count > 0) clauses.push(`${plural(failures.count, 'step')} failed`);

  return `Recent activity: ${clauses.join('; ')}.`;
}

/** The other projects with something going on, so she knows the desk is crowded. */
function alsoActiveLine(context, currentProject) {
  const names = new Set(context.sessions?.projects ?? []);
  for (const p of context.recent?.projects ?? []) names.add(p.name);
  if (currentProject) names.delete(currentProject);
  const list = [...names].slice(0, MAX_LISTED_PROJECTS);
  return list.length ? `Also active: ${list.join(', ')}.` : null;
}

function timeLine(context) {
  const time = context.time;
  if (!time) return null;
  let line = `Local time: ${time.hhmm}, ${time.daypart}.`;
  const activeFor = Number(context.sessions?.activeForMs);
  if (Number.isFinite(activeFor) && activeFor >= MIN_REPORTED_ACTIVE_MS) {
    const spoken = describeDuration(activeFor);
    if (spoken) line += ` He has been working for ${spoken}.`;
  }
  return line;
}

/** Her own last few lines, so she does not say the same thing twice in a row. */
function lastSaidLine(lines) {
  if (lines.length === 0) return null;
  const [latest, ...older] = lines;
  const before = older.length ? ` (before that: ${older.map((l) => `"${l}"`).join(', ')})` : '';
  return `You last said: "${latest}"${before} — do not repeat yourself.`;
}

/**
 * The `input` / user text: a short briefing on what just happened and what is
 * going on around it. `ev` is the speech event ({kind, tool|toolName, project,
 * mode, source, event, toolInput}) plus, when module A wired it up, `context`
 * (see context.mjs) and `recentLines` (what she last said). `summary` is
 * buildSummary's phrase, passed in when the caller already has it.
 *
 * Every line is optional and an unknown fact simply removes its line — she is
 * never handed "project: unknown" to read out. With neither context nor recent
 * lines this is the original one-line form, unchanged, which is what a bare
 * event and every test that predates the briefing still get.
 *
 * `ev.narration` is `{memory, now, firstLine}` when speech supplied it, and it
 * gates the two lines she was over-saying (see `decideMentions`). The state has
 * to arrive from the caller because only speech knows when she last spoke,
 * while only this function sees the context the decision reads.
 */
export function buildBrainInput(ev = {}, summary = null) {
  const tool = ev.tool ?? ev.toolName ?? null;
  const phrase = summary || buildSummary({ ...ev, toolName: tool });
  const context = ev.context && typeof ev.context === 'object' ? ev.context : null;
  const recentLines = (Array.isArray(ev.recentLines) ? ev.recentLines : [])
    .filter((line) => typeof line === 'string' && line.trim() !== '')
    .map((line) => line.trim());

  if (!context && recentLines.length === 0) {
    const facts = [];
    if (ev.kind) facts.push(`event: ${ev.kind}`);
    if (tool) facts.push(`tool: ${tool}`);
    if (ev.project) facts.push(`project: ${ev.project}`);
    return facts.length ? `Just happened: ${phrase}. (${facts.join(', ')})` : `Just happened: ${phrase}.`;
  }

  const narration = ev.narration && typeof ev.narration === 'object' ? ev.narration : null;
  const mentions = context
    ? decideMentions(context, narration?.memory ?? null, {
      now: narration?.now ?? Date.now(),
      firstLine: Boolean(narration?.firstLine),
    })
    : { time: false, sessions: false };

  const lines = [
    context && mentions.sessions ? sessionsLine(context.sessions) : null,
    happenedLine(ev, phrase, tool),
    context ? recentLine(context.recent) : null,
    context ? alsoActiveLine(context, ev.project ?? null) : null,
    context && mentions.time ? timeLine(context) : null,
    lastSaidLine(recentLines),
  ];
  return lines.filter(Boolean).join('\n');
}

const SLOTS = ['tool', 'project'];

const slotToken = (slot) => `{${slot}}`;

/** Literal substitution — the replacement is never read as a regex / `$&` pattern. */
function fill(template, values) {
  let out = template;
  for (const slot of SLOTS) out = out.replaceAll(slotToken(slot), () => values[slot]);
  return out;
}

/** One displayable line of at most `max` characters. */
export function clampLine(text, max = MAX_LINE_CHARS) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  const head = sp > Math.floor(max * 0.6) ? cut.slice(0, sp) : cut;
  return `${head.replace(/[\s,.;:!?\-–—]+$/, '')}…`;
}

/**
 * Pick the status line for `kind`. Only variants whose slots are all known are
 * eligible, so an unknown tool or project can never leak "{tool}" or "undefined"
 * into the bubble. Deterministic when `random` is injected; `avoid` (the previous
 * line for this kind) is skipped when the table has room.
 */
export function messageFor(kind, { tool = null, project = null, random = Math.random, avoid = null } = {}) {
  const table = MESSAGES[kind];
  if (!table) return '';
  const values = { tool: tool ? String(tool) : null, project: project ? String(project) : null };
  const usable = table.filter((t) => SLOTS.every((s) => values[s] || !t.includes(slotToken(s))));
  if (usable.length === 0) return '';

  const render = (variant) => clampLine(fill(variant, values));
  const r = Number(random());
  let i = Number.isFinite(r) ? Math.floor(Math.abs(r) * usable.length) % usable.length : 0;
  if (usable.length > 1 && render(usable[i]) === avoid) i = (i + 1) % usable.length;
  return render(usable[i]);
}
