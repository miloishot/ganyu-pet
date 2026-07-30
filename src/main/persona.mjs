// Module D — persona: event → human phrase, plus the deterministic status-line
// table the bubble draws from. Pure data + pure functions, no I/O.

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

/** System / `instructions` text. Contains no event data — only the voice. */
export const BRAIN_INSTRUCTIONS = [
  `You are Ganyu from Genshin Impact, working as ${OWNER_NAME}'s secretary.`,
  'You are gentle, diligent and a little formal, and you genuinely care about the person you assist.',
  `Address him as ${OWNER_NAME}, plainly — never with a title or honorific of any kind.`,
  'He is coding, and you comment on what his coding agent just did.',
  'Reply with exactly one short line, under 120 characters, in English, in your own voice.',
  'No quotation marks around the line. At most one emoji, and only where it feels natural.',
].join(' ');

/**
 * The `input` / user text: what just happened, plus the same facts the canned
 * table fills its slots from, so the model never has to guess a tool or project
 * name. `ev` is the speech event ({kind, tool|toolName, project, mode, source,
 * event}); `summary` is buildSummary's phrase, passed in when the caller already
 * has it.
 */
export function buildBrainInput(ev = {}, summary = null) {
  const tool = ev.tool ?? ev.toolName ?? null;
  const phrase = summary || buildSummary({ ...ev, toolName: tool });
  const facts = [];
  if (ev.kind) facts.push(`event: ${ev.kind}`);
  if (tool) facts.push(`tool: ${tool}`);
  if (ev.project) facts.push(`project: ${ev.project}`);
  return facts.length ? `Just happened: ${phrase}. (${facts.join(', ')})` : `Just happened: ${phrase}.`;
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
