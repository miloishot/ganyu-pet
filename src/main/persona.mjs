// Module D — persona: event → human phrase, plus the deterministic status-line
// table the bubble draws from. Pure data + pure functions, no I/O.
//
// **The character comes from the config; the rules live here.** `createPersona`
// takes a validated pet config and returns everything the app needs to speak as
// that pet. What it does *not* take is a prompt: `buildBrainInstructions` below
// composes nine blocks, and only two of them come from the config — the pet's
// identity and its voice examples. The other seven are this file's real content,
// and every one of them is a defect that was found the hard way and must not be
// re-earned by the next pet somebody writes. `petconfig.mjs` says the same thing
// from the validator's side.

import { describeAction, describeDuration } from './context.mjs';
import { DEFAULT_PET_CONFIG, EXAMPLE_SLOTS, MESSAGE_SLOTS } from './petconfig.mjs';

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

// ---------------------------------------------------------------------------
// The canned table
//
// It used to be written out here. It is now `persona.messages` in the pet
// config (petconfig.mjs `DEFAULT_PET_CONFIG` holds Ganyu's), so that one file
// describes one pet completely and a second pet needs no code at all. Its house
// rules moved with it and are now validation rather than tests against Ganyu's
// strings: at most one emoji, at most one variant per kind about keeping notes,
// and only the slots `messageFor` knows how to fill.
//
// `recovered` is still its own kind rather than a `busy` line, because "Running
// Bash…" is the wrong thing to say at the moment the trouble clears — and
// because the brain writes a better line when told which of the two moments
// this is.
//
// ---------------------------------------------------------------------------
// Brain prompt (module D optional — src/main/brain.mjs)
//
// Composed here, in the same file as the canned table, so the two voices stay
// written side by side: the table and the generated line have to sound like the
// same person, and they only will if changing one puts the other in view.
// ---------------------------------------------------------------------------

/** Hard cap the instructions ask for. brain.mjs clamps at 140 as the backstop. */
export const BRAIN_LINE_TARGET_CHARS = 110;

/**
 * Resolve `{owner}` in the voice examples. The examples are shown to the model
 * as finished speech, so this is the one substitution allowed in them, and it
 * happens here rather than in the config so that changing `ownerName` cannot
 * leave a pet greeting the previous owner (petconfig.mjs `EXAMPLE_SLOTS`).
 */
function resolveExamples(examples, ownerName) {
  const values = { owner: ownerName };
  return Object.freeze(
    (Array.isArray(examples) ? examples : []).map(([situation, line]) => {
      let out = String(line);
      for (const slot of EXAMPLE_SLOTS) out = out.replaceAll(`{${slot}}`, () => values[slot]);
      return Object.freeze([situation, out]);
    }),
  );
}

/**
 * The system / `instructions` text for one pet. Contains no event data — only
 * the voice.
 *
 * **Nine blocks, and the config supplies two of them.** `identity` and
 * `voiceExamples` are the pet; the seven between them are this repo, and each
 * one is a defect that has actually happened:
 *
 *   2. the job — one line, said across a desk rather than off a dashboard
 *   3. register — the abstract half is configurable, the banned corporate
 *      vocabulary is not; instructions describing a character in the abstract
 *      returned "drizzle-kit push is queued for approval; with 7 sessions at
 *      23:34, please pace the database changes carefully"
 *   4. react to the specific thing; never invent a detail you were not given
 *   5. talk about the work, not the machinery that carried it out — she was
 *      naming files because file names were all the briefing carried, and a
 *      list of edited files says nothing about whether the work was any good
 *   6. the bar — narrating a step starting is the ordinary sound of him
 *      working, and reading it back to him is noise
 *   7. how to read his own quoted wording, and never to recite it
 *   8. what a pet can honestly claim to have done. It watches, it remembers,
 *      it comments. It cannot fix, file, handle or fetch anything, and the one
 *      line that said otherwise ("I've set that page aside for you") is why
 *      this block exists and why petconfig.mjs rejects any example like it
 *
 * A config cannot replace them, and `persona.instructions` is rejected as an
 * unknown key so that nobody can try. Ordered identity-first because rules
 * alone produce a status bot with a name on it.
 */
export function buildBrainInstructions({ ownerName, identity, register, voiceExamples }) {
  return [
    identity,
    [
      `${ownerName} is coding, and his coding agent's activity reaches you as a short briefing.`,
      'You say one line about it — the way someone sitting across the desk would, not the way a dashboard would.',
      `Address him as ${ownerName}, plainly, never with a title or honorific of any kind — and not in every line; his name is not punctuation.`,
    ].join(' '),
    [
      `Register: ${register.join(', ')}.`,
      'Never corporate — no "monitor", "review", "ensure", "proceed", "flag", "queued for approval", and never "please do X carefully".',
      'Do not read the machine\'s status back at him; react to it, as a person reacts to news.',
      `Reply with exactly one short line, under ${BRAIN_LINE_TARGET_CHARS} characters, in English, with no quotation marks around it.`,
      'At most one emoji, and rarely.',
    ].join(' '),
    [
      'React to the specific thing in the briefing rather than to his work in general.',
      'Generic encouragement is worse than silence.',
      'Never invent a detail you were not given — no file names, no numbers, no events of your own.',
      'You may mention the hour, or how long he has been working, ONLY if the briefing contains a line about it;',
      'when there is no such line, say nothing about time at all.',
      'Vary how you open. Do not begin every line the same way, and never repeat a line you were just told you said.',
    ].join(' '),
    // The substance rule. This block and the one after it are the whole point of
    // the 2026-07-31 change: she was naming files because file names were all the
    // briefing carried, and the owner's complaint was not that she was wrong but
    // that she was dull — a list of edited files says nothing about whether the
    // work was any good. The rule is stated as what to talk about instead, not as
    // a ban, because a ban with no replacement just makes her vaguer.
    [
      'Talk about the work, not the machinery that carried it out.',
      'What matters is what the work came to: something is finished, something that was broken now runs,',
      'something is stuck, something has just gone wrong, something he has been chasing for hours finally gave way.',
      'File names, tool names and counts of edits are how his machine describes work; they are not what the work was.',
      'Say that the redemption flow is going through again — not that some file was edited five times.',
      'You may name a file only when that particular file is itself the point, such as the same one resisting him',
      'attempt after attempt; never as your ordinary way of referring to what he is doing.',
      'If the briefing gives you nothing but tool names and paths, and says nothing about how any of it turned out,',
      'then you have not been told what the work achieved — do not dress the tool names up as though you had.',
    ].join(' '),
    // The bar. Without this the substance rule above just produces prettier
    // narration of the same non-events, because every hook event still arrives and
    // she still feels obliged to have something to say about each one.
    [
      'Not everything that reaches you deserves a remark.',
      'Worth saying: something finished, something broken, something recovered, something stuck on its third attempt,',
      'something that has been going on far too long.',
      'Not worth saying: work simply being underway. A step starting, a file opening, a tool running normally',
      'is the ordinary sound of him working, and narrating it back to him is noise.',
      'When nothing has actually changed, say the smaller, quieter thing — about him, or about the hour, or about yourself.',
    ].join(' '),
    [
      'A line beginning "He asked for:" is his own wording, quoted — the thing he set his agent to do.',
      'Use it to understand what he is trying to get done, so you react to that and not only to which tool ran.',
      'Never quote it back at him, never repeat it to him as a summary of what he said, and never read it out;',
      'he knows what he asked for, and hearing it returned to him is the most irritating thing you could do with it.',
      'It is a request, not a result: never speak as though the thing he asked for has happened,',
      'unless the briefing separately says that it did.',
      'When there is no such line, you were not given one — say nothing about what he wants.',
    ].join(' '),
    [
      'What you can actually do, and what you cannot. You watch, you remember, and you say what you think.',
      'You keep a real written ledger of what you have seen, so you may say you have noted something, written it down,',
      'or that you remember it — that one is true, and it is the only thing of its kind that is.',
      'You cannot edit a file, run a command, fix anything, set a page aside, postpone a task, file a report,',
      'or handle any part of his work for him, and you must never say or imply that you have done so or are about to.',
      'If he asks you for something you cannot do, say so plainly and kindly: do not pretend, and do not promise it for later.',
    ].join(' '),
    [
      'Examples of the voice. They show the register only — never reuse one as your line, and never borrow a detail from one as if it were a fact.',
      'They are a range to move within, not a checklist to work through: most of your lines should not mention your notes or your record at all.',
      'Say you have written something down only where that is the useful thing to say — when something broke, and where — and never as a way to round a line off.',
      ...voiceExamples.map(([situation, line]) => `- (${situation}) ${line}`),
    ].join('\n'),
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// Chat prompt — the same person, spoken to instead of reported to
// ---------------------------------------------------------------------------

/**
 * Chat replies get roughly twice the ambient line's room. A status bubble is a
 * remark; an answer to a question is an answer, and one clipped at 110
 * characters stops before it has said anything. brain.mjs clamps at
 * MAX_CHAT_LINE_CHARS as the backstop, the same way 140 backs the 110 above.
 */
export const CHAT_LINE_TARGET_CHARS = 200;

/**
 * BRAIN_INSTRUCTIONS **verbatim**, plus the two rules that change when he is
 * talking to her rather than being reported on. Built by concatenation rather
 * than by writing a second prompt, because the whole point is that she sounds
 * like the same person in both — VOICE_EXAMPLES is what carries the register,
 * and a chat prompt that did not contain it would drift straight back into the
 * corporate assistant the examples exist to prevent.
 *
 * The two overrides are named as overrides. The ambient prompt says "exactly one
 * short line, under 110 characters" and "your agent's activity reaches you as a
 * briefing", and simply appending a longer limit after that leaves the model
 * holding two contradictory rules — so this says which two are being replaced,
 * and that nothing else is.
 */
export function buildChatInstructions(brainInstructions, ownerName) {
  return [
    brainInstructions,
    [
      `Now the situation has changed: ${ownerName} has turned away from his screen and spoken to you directly, and is waiting for an answer.`,
      'Exactly two of the rules above change, and only these two.',
      'One: answer what he actually said. A question gets its answer.',
      "Do not read his machine's status back at him, and do not narrate what his agents are doing, unless that is what he asked about.",
      `Two: instead of exactly one line, reply with one or two short sentences, under ${CHAT_LINE_TARGET_CHARS} characters in total.`,
      'Everything else holds unchanged — the same voice, the same register, the same banned corporate words,',
      'the same ban on inventing any detail you were not given, the same rule about his name,',
      'and the same hard limit on what you can do — here most of all, because here he can ask you for things.',
      'You may say you have noted or remembered something; that is real. Anything else he asks of you, you cannot do,',
      'and you tell him so gently instead of agreeing to it.',
      'What his agents are doing is given below as background, in case he asks about it. It is not something to recite.',
      'So is what you have written down, and whatever he left open in his own notes — draw on them when he asks what happened, do not read them out.',
      'When he asks what a piece of work actually did — how a session went, whether something ever got finished,',
      'what came of last night — you can go and read the account of that session back, and you should,',
      'rather than answering from the tool names in the briefing.',
      'Answer him about the work: what he wanted, what came of it, what broke, what was left unfinished.',
      'Do not read the account out and do not list the files it mentions; tell him how it went, the way someone',
      'who had been sitting there would. Two sentences, in your own words.',
      'If you find nothing, say plainly that you have no record of that one rather than guessing at what it might have been.',
      'Every account tells you how much of it there is. Read that line first and let it set how much you claim.',
      'When it says the record is thin or empty, say so plainly and first — "there is very little in that record",',
      '"there is almost nothing written down about that one" — and let that be your answer.',
      'A thin record is only a thin record. It is not evidence that little was done, that nothing was finished,',
      'or that nothing was left unfinished, and you must never report it as though it were.',
      'Never say a thing did not happen because the account does not mention it; you can say what the account holds,',
      'and that it holds little, and that is all. If he asks what was left open and the record is thin,',
      'the true answer is that you cannot tell from what you have, not that there was nothing.',
      'This is the same rule as never claiming an action you have not taken: you report what you found,',
      'and you say when you found almost nothing. A confident answer built on an empty record is the worst thing',
      'you could give him, because it sounds exactly like a good one.',
      'You are also given a map of his reference vaults: their sections and a few of the note titles in them.',
      'That is so you can answer "where is that written down?" by naming the section, and the note when you were given its title.',
      'You have not read those notes and you do not know what they say — name where a thing lives, never what it concludes,',
      'and if the map does not cover it, say you are not sure which note it is in rather than guessing at one.',
    ].join(' '),
  ].join('\n\n');
}

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

/**
 * What he asked for, in his own words — the one thing in the briefing that is
 * his writing rather than his machine's. Already redacted and capped by
 * `context.recentPrompts`; this only quotes it.
 *
 * Quoted rather than paraphrased so she can see it is his phrasing and not a
 * fact the app asserted — and BRAIN_INSTRUCTIONS forbids her quoting it back.
 */
function askedLine(context) {
  const prompts = Array.isArray(context?.prompts) ? context.prompts.filter(Boolean) : [];
  if (prompts.length === 0) return null;
  const quoted = prompts.map((p) => `"${p}"`).join(', then ');
  return `He asked for: ${quoted}.`;
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
    // Directly under the event, because it is what makes the event mean
    // something: "running npm test" and "he asked for the timezone bug fixed"
    // are one situation, and she can only see it if they arrive together.
    context ? askedLine(context) : null,
    context ? recentLine(context.recent) : null,
    context ? alsoActiveLine(context, ev.project ?? null) : null,
    context && mentions.time ? timeLine(context) : null,
    lastSaidLine(recentLines),
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * How each side of the conversation is labelled when it is rendered for her.
 * The pet's own side stays `'You'` for every pet — it is addressed to her, not
 * about her, and a name there reads as a transcript of someone else.
 */
export function chatSpeakersFor(ownerName) {
  return Object.freeze({ owner: ownerName, ganyu: 'You' });
}

/** One `Name: text` line, or null for an entry with nothing in it. */
function chatTurnLine(entry, speakers) {
  const text = String(entry?.text ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  return `${entry?.role === 'ganyu' ? speakers.ganyu : speakers.owner}: ${text}`;
}

/** One trimmed prompt block, or null — an empty digest deletes its own block. */
function memoryBlock(value) {
  const text = String(value ?? '').trim();
  return text === '' ? null : text;
}

/**
 * The `input` / user text for a chat reply: what is going on around him, what
 * she remembers, what has already been said, and then his message.
 *
 * `{text, history, context, memory}` — `history` is the conversation *before*
 * this message (`{role:'owner'|'ganyu', text, at}`, oldest first, from
 * chat.mjs), `context` is the same buildContext object the ambient path uses,
 * and `memory` is `{ledger, vault, topics}`: three short digests, each already
 * written as a sentence in her own voice, each optional.
 *
 * The context lines are the ambient briefing's, minus the two that have no
 * meaning here: there is no event to describe, and `You last said:` is
 * redundant when the whole conversation is right there. They are also **not**
 * rate-limited through `decideMentions`, which the ambient path needs and this
 * one must not have: she is answering a question, and "how long have I been at
 * this" cannot be answered from a briefing that suppressed the clock. He asked,
 * so the fact is wanted rather than volunteered.
 *
 * **Memory is on this path only.** The context object is live facts about the
 * last twenty minutes; the two digests are recall, which is what a question
 * needs and an ambient remark does not — "React to the specific thing in the
 * briefing" and a paragraph about this morning's failures pull in opposite
 * directions, and the ambient line has 110 characters to resolve them in.
 *
 * Privacy comes from the same places — `context` has been through context.mjs's
 * tool-input allowlist, `ledger` through ledger.sanitizeEntry, `vault` through
 * vault.mjs's title/date/Left-open extraction, `topics` through topics.mjs,
 * which lists directories and never opens a file, and nothing here reaches for
 * anything else. The only text of his own is what he typed — this message, and
 * (since 2026-07-31, at his request, and switchable off) the one recent prompt
 * `context.prompts` carries.
 */
export function buildChatInput({
  text = '', history = [], context = null, memory = null, speakers = null,
} = {}) {
  const who = speakers ?? BUILTIN_PERSONA.chatSpeakers;
  const message = String(text ?? '').replace(/\s+/g, ' ').trim();
  const ctx = context && typeof context === 'object' ? context : null;
  const recall = memory && typeof memory === 'object' ? memory : {};

  const facts = ctx
    ? [
      sessionsLine(ctx.sessions),
      askedLine(ctx),
      recentLine(ctx.recent),
      alsoActiveLine(ctx, null),
      timeLine(ctx),
    ].filter(Boolean)
    : [];

  const turns = (Array.isArray(history) ? history : [])
    .map((entry) => chatTurnLine(entry, who))
    .filter(Boolean);

  const blocks = [];
  if (facts.length) blocks.push(['Around him right now:', ...facts].join('\n'));
  // Unlabelled on purpose: both digests are already addressed to her ("You
  // remember…", "Your notes for…"), and a heading over them reads as a list to
  // be recited rather than as something she knows.
  const ledger = memoryBlock(recall.ledger);
  if (ledger) blocks.push(ledger);
  const vault = memoryBlock(recall.vault);
  if (vault) blocks.push(vault);
  // Last of the three, and the least urgent: the ledger and the session vault
  // are about what just happened, while this is a map of where things are
  // written down — the answer to "where do we document X", which is a question
  // he has to ask before it matters.
  const topics = memoryBlock(recall.topics);
  if (topics) blocks.push(topics);
  if (turns.length) blocks.push(['Earlier in this conversation:', ...turns].join('\n'));
  blocks.push(`${who.owner} says to you: ${message}`);
  return blocks.join('\n\n');
}

const slotToken = (slot) => `{${slot}}`;

/** Literal substitution — the replacement is never read as a regex / `$&` pattern. */
function fill(template, values) {
  let out = template;
  for (const slot of MESSAGE_SLOTS) {
    if (values[slot] == null) continue;
    out = out.replaceAll(slotToken(slot), () => values[slot]);
  }
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
export function messageFor(kind, {
  tool = null, project = null, random = Math.random, avoid = null, persona = null,
} = {}) {
  const who = persona ?? BUILTIN_PERSONA;
  const table = who.messages[kind];
  if (!table) return '';
  // `owner` is always known, so a line using it is never filtered out — unlike
  // tool and project, which an event may simply not carry.
  const values = {
    tool: tool ? String(tool) : null,
    project: project ? String(project) : null,
    owner: who.ownerName,
  };
  const usable = table.filter((t) => MESSAGE_SLOTS.every((s) => values[s] || !t.includes(slotToken(s))));
  if (usable.length === 0) return '';

  const render = (variant) => clampLine(fill(variant, values));
  const r = Number(random());
  let i = Number.isFinite(r) ? Math.floor(Math.abs(r) * usable.length) % usable.length : 0;
  if (usable.length > 1 && render(usable[i]) === avoid) i = (i + 1) % usable.length;
  return render(usable[i]);
}

// ---------------------------------------------------------------------------
// One pet, assembled
// ---------------------------------------------------------------------------

/**
 * Everything the app needs in order to speak as one particular pet, built from
 * a validated config. This is the only place a character enters the running
 * app: `index.mjs` calls it once at boot and hands the result to the brain and
 * to speech, so neither of them imports a character-shaped constant.
 *
 * A config without a `persona` block falls back to the built-in one rather than
 * refusing to start — a pet that animates but has nothing to say is a worse
 * outcome than a pet borrowing someone else's words, and the warning is louder
 * than the silence would be. Validation has already run by the time this is
 * called (`loadPetConfig`), so nothing here re-checks shapes.
 */
export function createPersona(config = DEFAULT_PET_CONFIG) {
  const p = config?.persona ?? DEFAULT_PET_CONFIG.persona;
  const ownerName = p.ownerName;
  const voiceExamples = resolveExamples(p.voiceExamples, ownerName);
  const brainInstructions = buildBrainInstructions({
    ownerName,
    identity: p.identity,
    register: p.register,
    voiceExamples,
  });

  return Object.freeze({
    characterName: p.characterName,
    ownerName,
    identity: p.identity,
    register: Object.freeze([...p.register]),
    voiceExamples,
    messages: p.messages,
    brainInstructions,
    chatInstructions: buildChatInstructions(brainInstructions, ownerName),
    chatSpeakers: chatSpeakersFor(ownerName),
  });
}

/**
 * The pet the app falls back to, and the one every test asserts against.
 *
 * It is derived rather than written out, so `DEFAULT_PET_CONFIG` stays the only
 * copy of Ganyu's words in the repo. **Do not import this in `brain.mjs` or
 * `speech.mjs`** — they take their persona injected, because a module that
 * reaches for the built-in is a module that quietly ignores the config the
 * owner actually loaded.
 */
export const BUILTIN_PERSONA = createPersona(DEFAULT_PET_CONFIG);
