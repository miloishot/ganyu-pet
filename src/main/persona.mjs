// Module D — persona: prompt template, event → summary phrasing, canned fallbacks.
// Pure data + pure functions. No I/O beyond reading process.env for the default user name.

export const MAX_LINE_CHARS = 90;

/** Exact template from contracts.md §Speech. `{user}` and `{summary}` are the only slots. */
export const PROMPT_TEMPLATE =
  "You are Ganyu from Genshin Impact, working as {user}'s diligent secretary. " +
  'React to this coding-agent event in ONE short line (max 90 chars), gentle and dutiful, ' +
  'in English, at most one emoji, occasionally hinting you could use a nap. ' +
  'Address them by name only, never with an honorific (no Mr., Miss, or Sir). ' +
  'Event: {summary}. Reply with ONLY the line.';

/** Owner's preferred name (2026-07-30). GANYU_USER overrides. */
export function defaultUser(env = process.env) {
  return env.GANYU_USER || 'Kahweng';
}

/** Literal slot substitution — replacement text is never treated as a regex/`$&` pattern. */
export function buildPrompt({ user, summary } = {}) {
  const u = String(user ?? defaultUser());
  const s = String(summary ?? 'an unspecified event');
  return PROMPT_TEMPLATE.replace('{user}', () => u).replace('{summary}', () => s);
}

const SOURCE_LABELS = { codex: 'codex', claude: 'Claude Code', 'claude-code': 'Claude Code' };

export function sourceLabel(source) {
  if (!source) return 'your agent';
  return SOURCE_LABELS[String(source).toLowerCase()] ?? String(source);
}

/**
 * Compact human phrase for the prompt's `{summary}` slot.
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
 * Canned lines used when the CLI call fails, times out, or returns nothing.
 * Keyed by speech kind: greeting | busy | waiting | failed | celebrate | idle.
 * >= 6 lines per key, each <= 90 chars, at most one emoji.
 */
export const FALLBACK_LINES = Object.freeze({
  greeting: Object.freeze([
    'Good day. Ganyu reporting for duty — the ledger is open.',
    "I've tidied the desk and brewed the tea. Shall we begin?",
    "Reporting in. I'll keep the records while you work.",
    "A new session, then. I'll stay close by.",
    "Ready when you are. I've set out today's notes.",
    'Ganyu, at your service. Steady progress today, I hope.',
    'Welcome back. Shall I take minutes of this one? 📖',
  ]),
  busy: Object.freeze([
    "Switching tools already? I'll update the paperwork.",
    "Noted — I'll log this step in the ledger.",
    "Diligent as ever. I'm keeping the notes tidy.",
    "A new task in hand. I'll track it for you.",
    "Steady work is best. I'm keeping count.",
    "I'll file this alongside the rest. Do carry on.",
    'Mm, busy work. Perhaps a short nap after this? 🌙',
  ]),
  waiting: Object.freeze([
    'There is a request awaiting your approval. 🙏',
    'Pardon me — this one needs your permission first.',
    'Everything is paused until you say the word.',
    'A small decision is waiting on your desk.',
    "I'll hold here until you approve it.",
    'One signature needed, then we continue.',
    "Awaiting your word. I'll keep the seat warm.",
  ]),
  failed: Object.freeze([
    "It didn't go through. Shall we look again together?",
    "An error, I'm afraid. Nothing we cannot sort out.",
    "That step failed. I've noted where it stopped.",
    'Setbacks happen. Take a breath, then retry. 🍃',
    'Something went wrong — I kept the details for you.',
    "Not our finest attempt. Let's try once more.",
    "I've marked the error in the margin for later.",
  ]),
  celebrate: Object.freeze([
    'All finished. Well done — the ledger balances. ✨',
    "Task complete. I'll file the report.",
    'Done and dusted. Perhaps a nap now? 🌙',
    "That's settled. Lovely work.",
    "Finished. I'll tidy up the notes.",
    "Complete. Rest a moment; you've earned it.",
    'Another one closed. I do enjoy a neat record.',
  ]),
  idle: Object.freeze([
    "All quiet. I'll keep watch.",
    'Nothing pending. I might close my eyes a moment. 🌙',
    'The desk is clear. Call me when needed.',
    "Idle hands... though I don't mind the quiet.",
    "I'll tidy the archives while we wait.",
    "Peaceful, isn't it? I'll stay nearby.",
  ]),
});

/**
 * Pick a canned line for `kind`. Deterministic when `random` is injected.
 * `avoid` (the previous line for this kind) is skipped when the table has room.
 */
export function fallbackFor(kind, { random = Math.random, avoid = null } = {}) {
  const table = FALLBACK_LINES[kind] ?? FALLBACK_LINES.idle;
  const r = Number(random());
  const base = Number.isFinite(r) ? Math.floor(Math.abs(r) * table.length) % table.length : 0;
  let i = base;
  if (table.length > 1 && table[i] === avoid) i = (i + 1) % table.length;
  return table[i];
}
