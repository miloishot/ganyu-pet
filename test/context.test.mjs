// Module D (context) tests — the facts the brain is given, and the ones it must
// never be given.
//
// Everything here is a pure function over module B's debug ring, so there is no
// clock, no server and no network: a ring is just an array of the objects
// server.mjs records. Two themes run through the file:
//   1. degradation — an empty ring, a single event, a truncated capture and a
//      missing tool name all have to yield *less*, never an exception and never
//      a blank "unknown" that ends up in the bubble;
//   2. privacy — the allowlist is the only way into `tool_input`, and the last
//      section proves the owner's code cannot reach the wire even when the
//      unfiltered payload is handed straight to the input builder.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALLOWED_TOOL_INPUT_KEYS,
  RECENT_WINDOW_MS,
  basename,
  buildContext,
  describeAction,
  describeDuration,
  localTimePhrase,
  pickToolInput,
  projectFromCwd,
  redactSecrets,
  sessionSnapshot,
  shortCommand,
  summarizeRecent,
  trackActiveSince,
} from '../src/main/context.mjs';
import { buildBrainInput } from '../src/main/persona.mjs';
import { createSpeech } from '../src/main/speech.mjs';
import { createState } from '../src/main/state.mjs';

const CWD = 'C:\\Users\\kw11l\\Desktop\\ganyu-pet';
const ORCA = 'C:\\Users\\kw11l\\orca\\workspaces\\GolfCRM\\bay-daily-codes';
const NOW = new Date(2026, 6, 30, 22, 15).getTime(); // local, so the clock tests are TZ-proof
const MIN = 60_000;

/** One entry exactly as server.mjs records it. */
function entry({
  at = NOW,
  sessionId = 's1',
  event = 'PreToolUse',
  tool = null,
  input = null,
  cwd = CWD,
  failed = false,
  raw,
} = {}) {
  return {
    at,
    source: 'claude',
    sessionId,
    event,
    mode: failed ? 'failed' : 'busy',
    sessionMode: failed ? 'failed' : 'busy',
    failed,
    raw: raw !== undefined ? raw : {
      session_id: sessionId,
      cwd,
      hook_event_name: event,
      ...(tool ? { tool_name: tool } : {}),
      ...(input ? { tool_input: input } : {}),
    },
  };
}

// ---------------------------------------------------------------- projectFromCwd

test('projectFromCwd takes the basename of either path style', () => {
  assert.equal(projectFromCwd(CWD), 'ganyu-pet');
  assert.equal(projectFromCwd('/home/kw11l/dev/ganyu-pet/'), 'ganyu-pet');
  assert.equal(projectFromCwd('C:/Users/kw11l/Desktop/salesbridge'), 'salesbridge');
  assert.equal(projectFromCwd('C:\\'), null, 'a bare drive is not a project');
  assert.equal(projectFromCwd(''), null);
  assert.equal(projectFromCwd(null), null);
  assert.equal(projectFromCwd(undefined), null);
});

test('an Orca worktree keeps the repo AND the worktree name', () => {
  // The documented choice: "bay-daily-codes" alone never says which repo it is.
  assert.equal(projectFromCwd(ORCA), 'GolfCRM/bay-daily-codes');
  assert.equal(projectFromCwd('/home/kw11l/orca/workspaces/GolfCRM/bay-daily-codes'), 'GolfCRM/bay-daily-codes');
  assert.equal(projectFromCwd(`${ORCA}\\src\\domain\\access-code`), 'GolfCRM/bay-daily-codes',
    'a path inside the worktree still names the worktree, not the folder');
  assert.equal(projectFromCwd('C:\\Users\\kw11l\\orca\\workspaces\\GolfCRM'), 'GolfCRM',
    'the repo directory itself, with no worktree under it');
  assert.equal(projectFromCwd('C:\\Users\\kw11l\\orca\\notes\\GolfCRM'), 'GolfCRM',
    'only .../orca/workspaces/... is a worktree path');
});

test('basename is tolerant of both separators and of nothing at all', () => {
  assert.equal(basename('C:\\a\\b\\index.ts'), 'index.ts');
  assert.equal(basename('src/main/persona.mjs'), 'persona.mjs');
  assert.equal(basename(''), null);
  assert.equal(basename(null), null);
});

// ---------------------------------------------------------------- describeAction

test('describeAction names the file for an edit, a write and a read', () => {
  assert.equal(
    describeAction(entry({ tool: 'Edit', input: { file_path: 'C:\\repo\\src\\domain\\index.ts' } })),
    'editing index.ts',
  );
  assert.equal(
    describeAction(entry({ tool: 'Write', input: { file_path: '/repo/src/new.mjs' } })),
    'writing new.mjs',
  );
  assert.equal(
    describeAction(entry({ tool: 'Read', input: { file_path: '/repo/src/persona.mjs' } })),
    'reading persona.mjs',
  );
  assert.equal(
    describeAction(entry({ tool: 'MultiEdit', input: {} })),
    'editing a file',
    'no path is still an edit, just a vaguer one',
  );
});

test('describeAction quotes the command for a shell tool, truncated to ~60 chars', () => {
  assert.equal(
    describeAction(entry({ tool: 'Bash', input: { command: 'npm test' } })),
    'running `npm test`',
  );
  const long = describeAction(entry({
    tool: 'Bash',
    input: { command: `node --test ${'test/very-long-file-name.test.mjs '.repeat(4)}` },
  }));
  assert.ok(long.length <= 'running ``'.length + 60, `not truncated: ${long}`);
  assert.ok(long.endsWith('…`'), long);
  assert.equal(
    describeAction(entry({ tool: 'Bash', input: { command: 'git status\ngit diff' } })),
    'running `git status git diff`',
    'newlines are collapsed, not sent as-is',
  );
});

test('describeAction covers search, fetch and subagent tools', () => {
  assert.equal(
    describeAction(entry({ tool: 'Grep', input: { pattern: 'buildBrainInput' } })),
    'searching for "buildBrainInput"',
  );
  assert.equal(
    describeAction(entry({ tool: 'Glob', input: { pattern: '**/*.test.mjs' } })),
    'looking for **/*.test.mjs',
  );
  assert.equal(
    describeAction(entry({ tool: 'WebFetch', input: { url: 'https://docs.anthropic.com/en/api/messages?x=1' } })),
    'fetching docs.anthropic.com',
    'the host only — never the path or the query',
  );
  assert.equal(
    describeAction(entry({ tool: 'Task', input: { subagent_type: 'Explore' } })),
    'dispatching the Explore agent',
  );
  assert.equal(
    describeAction({ ...entry({ tool: 'Task' }).raw, agent_type: 'general-purpose' }),
    'dispatching the general-purpose agent',
    'a bare payload works as well as a ring entry',
  );
});

test('an unknown tool is described by its own name, and no tool by nothing', () => {
  assert.equal(describeAction(entry({ tool: 'TodoWrite', input: { todos: [] } })), 'TodoWrite');
  assert.equal(describeAction(entry({ event: 'Stop' })), null, 'no tool, nothing to describe');
  assert.equal(describeAction(entry({ raw: null })), null);
  assert.equal(describeAction(null), null);
  assert.equal(describeAction({}), null);
  assert.equal(describeAction('nonsense'), null);
});

test('a truncated capture yields less detail and never throws', () => {
  // server.mjs replaces a payload over 4KB with this shape. `preview` is a raw
  // prefix of the event JSON — it can contain a diff, so it is never read.
  const truncated = entry({
    raw: {
      truncated: true,
      bytes: 9001,
      preview: '{"tool_name":"Edit","tool_input":{"old_string":"const SECRET = 1"',
    },
  });
  assert.equal(describeAction(truncated), null);
  assert.equal(summarizeRecent([truncated], { now: NOW }).count, 1, 'it is still an event');
  assert.deepEqual(summarizeRecent([truncated], { now: NOW }).tools, [], 'it just cannot say what kind');
});

// ---------------------------------------------------------------- redaction

test('secret-looking tokens are redacted out of a command before it is quoted', () => {
  const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789';
  const hex = 'a'.repeat(40);
  const b64 = 'aGVsbG9Xb3JsZDEyMzQ1Njc4OTBhYmNkZWY';

  assert.ok(!redactSecrets(`curl -H "Authorization: Bearer ${key}"`).includes(key));
  assert.ok(!redactSecrets(`export TOKEN=${hex}`).includes(hex));
  assert.ok(!redactSecrets(`echo ${b64}`).includes(b64));
  assert.match(redactSecrets(`export TOKEN=${hex}`), /<redacted>/);

  const described = describeAction(entry({ tool: 'Bash', input: { command: `gh auth login --with-token ${key}` } }));
  assert.ok(!described.includes(key), described);
  assert.ok(!described.includes('sk-proj'), described);

  // Ordinary commands are left alone.
  assert.equal(redactSecrets('npm test -- --watch=false'), 'npm test -- --watch=false');
  assert.equal(shortCommand('  npm   test  '), 'npm test');
  assert.equal(shortCommand('   '), null);
});

// ---------------------------------------------------------------- summarizeRecent

test('summarizeRecent counts tools, projects and test runs inside the window', () => {
  const ring = [
    ...Array.from({ length: 4 }, (_, i) => entry({ at: NOW - 10 * MIN + i, tool: 'Edit', input: { file_path: '/r/a.ts' } })),
    entry({ at: NOW - 9 * MIN, tool: 'Bash', input: { command: 'npm test' } }),
    entry({ at: NOW - 8 * MIN, tool: 'Bash', input: { command: 'npm test' } }),
    entry({ at: NOW - 7 * MIN, tool: 'Read', cwd: ORCA, input: { file_path: '/r/b.ts' } }),
    entry({ at: NOW - 40 * MIN, tool: 'Grep', input: { pattern: 'x' } }), // outside the window
  ];
  const recent = summarizeRecent(ring, { now: NOW });

  assert.equal(recent.count, 7, 'the 40-minute-old event is out of the window');
  assert.equal(recent.windowMs, RECENT_WINDOW_MS);
  assert.deepEqual(recent.tools, [
    { name: 'Edit', count: 4 },
    { name: 'Bash', count: 2 },
    { name: 'Read', count: 1 },
  ]);
  assert.deepEqual(recent.projects, [
    { name: 'ganyu-pet', count: 6 },
    { name: 'GolfCRM/bay-daily-codes', count: 1 },
  ]);
  assert.equal(recent.testRuns, 2);
  assert.ok(recent.from < recent.to);
});

test('summarizeRecent reports repeats only — one edit of one file is not news', () => {
  const ring = [
    entry({ at: NOW - 5 * MIN, tool: 'Edit', input: { file_path: '/r/src/index.ts' } }),
    entry({ at: NOW - 4 * MIN, tool: 'Edit', input: { file_path: '/r/src/index.ts' } }),
    entry({ at: NOW - 3 * MIN, tool: 'Edit', input: { file_path: '/r/src/other.ts' } }),
    entry({ at: NOW - 2 * MIN, tool: 'Bash', input: { command: 'npm test' } }),
    entry({ at: NOW - 1 * MIN, tool: 'Bash', input: { command: 'npm test' } }),
  ];
  const recent = summarizeRecent(ring, { now: NOW });
  assert.deepEqual(recent.files, [{ name: 'index.ts', count: 2 }]);
  assert.deepEqual(recent.commands, [{ text: 'npm test', count: 2 }]);
});

test('summarizeRecent tells a failure that recovered from one that is still going', () => {
  const failThenPass = summarizeRecent([
    entry({ at: NOW - 5 * MIN, tool: 'Bash', input: { command: 'npm test' }, failed: true }),
    entry({ at: NOW - 4 * MIN, tool: 'Bash', input: { command: 'npm test' } }),
  ], { now: NOW }).failures;
  assert.deepEqual(failThenPass, { count: 1, streak: 0, recovered: ['Bash'] });

  const stillFailing = summarizeRecent([
    entry({ at: NOW - 3 * MIN, tool: 'Bash' }),
    entry({ at: NOW - 2 * MIN, tool: 'Bash', failed: true }),
    entry({ at: NOW - 1 * MIN, tool: 'Bash', failed: true }),
  ], { now: NOW }).failures;
  assert.deepEqual(stillFailing, { count: 2, streak: 2, recovered: [] });

  // A different tool succeeding does not clear the first tool's failure.
  const other = summarizeRecent([
    entry({ at: NOW - 3 * MIN, tool: 'Bash', failed: true }),
    entry({ at: NOW - 2 * MIN, tool: 'Edit' }),
  ], { now: NOW }).failures;
  assert.deepEqual(other, { count: 1, streak: 0, recovered: [] });
});

test('an empty ring, and a ring of one, degrade to empty facts rather than throwing', () => {
  for (const ring of [[], null, undefined, 'not a ring', [null, {}, { at: 'nope' }]]) {
    const recent = summarizeRecent(ring, { now: NOW });
    assert.equal(recent.count, 0, `${JSON.stringify(ring)} produced ${recent.count}`);
    assert.deepEqual(recent.tools, []);
    assert.deepEqual(recent.projects, []);
    assert.deepEqual(recent.files, []);
    assert.deepEqual(recent.commands, []);
    assert.deepEqual(recent.failures, { count: 0, streak: 0, recovered: [] });
    assert.equal(recent.from, null);
  }

  const one = summarizeRecent([entry({ tool: 'Edit', input: { file_path: '/r/a.ts' } })], { now: NOW });
  assert.equal(one.count, 1);
  assert.deepEqual(one.tools, [{ name: 'Edit', count: 1 }]);
  assert.deepEqual(one.files, [], 'a single edit is not a repeat');
});

// ---------------------------------------------------------------- sessionSnapshot

test('sessionSnapshot counts live sessions and names their projects from the ring', () => {
  const state = {
    aggregate: () => ({
      sessionCount: 2,
      sessions: [
        { id: 's1', source: 'claude', mode: 'busy', lastSeen: NOW - MIN },
        { id: 's2', source: 'claude', mode: 'busy', lastSeen: NOW },
      ],
    }),
  };
  const ring = [
    entry({ at: NOW - 2 * MIN, sessionId: 's1', cwd: CWD, tool: 'Edit' }),
    entry({ at: NOW - MIN, sessionId: 's2', cwd: ORCA, tool: 'Edit' }),
    entry({ at: NOW, sessionId: 's3', cwd: 'C:\\dev\\salesbridge', tool: 'Edit' }), // expired session
  ];

  const snap = sessionSnapshot(state, { now: NOW, ring });
  assert.equal(snap.count, 2);
  assert.deepEqual(snap.projects, ['ganyu-pet', 'GolfCRM/bay-daily-codes']);
  assert.equal(snap.activeSince, NOW - 2 * MIN, 'derived from the oldest thing still visible');
  assert.equal(snap.activeForMs, 2 * MIN);
});

test('sessionSnapshot prefers the caller`s activeSince, and survives a broken state', () => {
  const fourHours = NOW - 4 * 60 * MIN;
  const withHint = sessionSnapshot(null, { now: NOW, ring: [entry()], activeSinceMs: fourHours });
  assert.equal(withHint.activeForMs, 4 * 60 * MIN, 'the ring only remembers 50 events; module A remembers more');

  const broken = sessionSnapshot({ aggregate: () => { throw new Error('boom'); } }, { now: NOW });
  assert.deepEqual(broken, { count: 0, projects: [], activeSince: null, activeForMs: null });
  assert.equal(sessionSnapshot(undefined, { now: NOW }).count, 0);
  assert.equal(sessionSnapshot([{ id: 's1', lastSeen: NOW }], { now: NOW }).count, 1, 'a bare session array works too');
});

test('sessionSnapshot reads a real state aggregate', () => {
  const state = createState({ clock: () => NOW });
  state.ingest('claude', { session_id: 's1', cwd: CWD, hook_event_name: 'PreToolUse', tool_name: 'Edit' });
  state.ingest('claude', { session_id: 's2', cwd: ORCA, hook_event_name: 'PreToolUse', tool_name: 'Edit' });

  const ring = [entry({ sessionId: 's1', cwd: CWD }), entry({ sessionId: 's2', cwd: ORCA })];
  const snap = sessionSnapshot(state, { now: NOW, ring });
  assert.equal(snap.count, 2);
  assert.deepEqual(snap.projects.sort(), ['GolfCRM/bay-daily-codes', 'ganyu-pet']);
});

// ---------------------------------------------------------------- clock helpers

test('localTimePhrase gives the hour, a daypart, and a late-night flag', () => {
  const at = (h, m = 0) => localTimePhrase(new Date(2026, 6, 30, h, m).getTime());
  assert.equal(at(22, 15).hhmm, '22:15');
  assert.equal(at(22, 15).daypart, 'late night');
  assert.equal(at(22, 15).lateNight, true);
  assert.equal(at(2, 5).hhmm, '02:05');
  assert.equal(at(2, 5).daypart, 'the small hours');
  assert.equal(at(2, 5).lateNight, true);
  assert.equal(at(9, 0).daypart, 'morning');
  assert.equal(at(9, 0).lateNight, false);
  assert.equal(at(15, 30).daypart, 'afternoon');
  assert.equal(at(19, 0).daypart, 'evening');
  assert.equal(at(21, 0).daypart, 'late evening');
  assert.equal(localTimePhrase('not a time'), null);
});

test('describeDuration rounds to something a person would actually say', () => {
  assert.equal(describeDuration(0), null);
  assert.equal(describeDuration(31 * MIN), 'about 30 minutes');
  assert.equal(describeDuration(62 * MIN), 'about 60 minutes');
  assert.equal(describeDuration(90 * MIN), 'about an hour and a half');
  assert.equal(describeDuration(4 * 60 * MIN), 'about 4 hours');
  assert.equal(describeDuration(3.5 * 60 * MIN), 'about 3 and a half hours');
  assert.equal(describeDuration('nonsense'), null);
});

test('trackActiveSince holds one stretch and starts a new one after a long gap', () => {
  const start = trackActiveSince(null, 1000);
  assert.deepEqual(start, { since: 1000, last: 1000 });

  const later = trackActiveSince(start, 1000 + 20 * MIN);
  assert.equal(later.since, 1000, 'still the same evening');
  assert.equal(later.last, 1000 + 20 * MIN);

  const nextDay = trackActiveSince(later, 1000 + 20 * MIN + 31 * MIN);
  assert.equal(nextDay.since, 1000 + 51 * MIN, 'a 31-minute silence ends the stretch');
  assert.deepEqual(trackActiveSince(start, 'nonsense'), start, 'a bad clock reading changes nothing');
});

// ---------------------------------------------------------------- buildContext + the rendered input

/** The shape module A injects, built from a ring that looks like a real evening. */
function eveningContext(overrides = {}) {
  const ring = [
    ...Array.from({ length: 5 }, (_, i) => entry({
      at: NOW - (12 - i) * MIN, cwd: ORCA, sessionId: 's1', tool: 'Edit',
      input: { file_path: `${ORCA}\\src\\domain\\access-code\\index.ts` },
    })),
    entry({ at: NOW - 6 * MIN, cwd: ORCA, sessionId: 's1', tool: 'Bash', input: { command: 'npm test' }, failed: true }),
    entry({ at: NOW - 5 * MIN, cwd: ORCA, sessionId: 's1', tool: 'Bash', input: { command: 'npm test' } }),
    entry({ at: NOW - 4 * MIN, cwd: CWD, sessionId: 's2', tool: 'Read', input: { file_path: `${CWD}\\src\\main\\persona.mjs` } }),
  ];
  const state = {
    aggregate: () => ({
      sessionCount: 5,
      sessions: [
        { id: 's1', lastSeen: NOW - 5 * MIN },
        { id: 's2', lastSeen: NOW - 4 * MIN },
      ],
    }),
  };
  return buildContext({
    ring, state, now: NOW, activeSinceMs: NOW - 4 * 60 * MIN, ...overrides,
  });
}

test('buildBrainInput renders the briefing, one fact per line', () => {
  const input = buildBrainInput({
    kind: 'busy',
    event: 'PreToolUse',
    tool: 'Edit',
    project: 'GolfCRM/bay-daily-codes',
    mode: 'busy',
    source: 'claude',
    toolInput: { file_path: `${ORCA}\\src\\domain\\access-code\\index.ts` },
    context: eveningContext(),
    recentLines: ['Running npm test…'],
  });

  assert.deepEqual(input.split('\n'), [
    'Right now: 5 coding sessions are running at once.',
    'Just happened: Claude Code is about to run Edit in GolfCRM/bay-daily-codes — editing index.ts.',
    'Recent activity: 5 Edit calls, 2 Bash calls and 1 Read call (2 test runs among them) in GolfCRM/bay-daily-codes and ganyu-pet over the last 20 minutes; index.ts touched 5 times; `npm test` run 2 times; Bash failed and then recovered.',
    'Also active: ganyu-pet.',
    'Local time: 22:15, late night. He has been working for about 4 hours.',
    'You last said: "Running npm test…" — do not repeat yourself.',
  ]);
});

test('an unknown fact removes its line — never an empty or "unknown" one', () => {
  const bare = buildContext({ ring: [], state: null, now: NOW });
  const input = buildBrainInput({
    kind: 'greeting', event: 'SessionStart', source: 'codex', context: bare,
  });
  const lines = input.split('\n');

  assert.deepEqual(lines, [
    'Just happened: codex started a session.',
    'Local time: 22:15, late night.',
  ]);
  assert.ok(!/unknown|undefined|null|: *$/i.test(input), input);
  assert.ok(!input.includes('Right now'), 'one session is not worth saying');
  assert.ok(!input.includes('Recent activity'), 'an empty ring has no activity to report');
  assert.ok(!input.includes('working for'), 'a span we cannot measure is not asserted');
});

test('with no context at all the input is exactly the old one-line form', () => {
  assert.equal(
    buildBrainInput({ kind: 'busy', tool: 'Edit', project: 'ganyu-pet', source: 'claude', event: 'PreToolUse' }),
    'Just happened: Claude Code is about to run Edit in ganyu-pet. (event: busy, tool: Edit, project: ganyu-pet)',
  );
  assert.equal(buildBrainInput(), 'Just happened: your agent sent an event.');
});

test('the recent-lines hint carries up to three lines, newest first', () => {
  const input = buildBrainInput({
    kind: 'busy', tool: 'Edit', source: 'claude', event: 'PreToolUse',
    recentLines: ['Running Bash…', 'Session started in ganyu-pet.', 'Finished in ganyu-pet.', 'dropped'],
  });
  const last = input.split('\n').at(-1);
  assert.equal(
    last,
    'You last said: "Running Bash…" (before that: "Session started in ganyu-pet.", "Finished in ganyu-pet.", "dropped") — do not repeat yourself.',
  );
  assert.ok(!buildBrainInput({ kind: 'busy', recentLines: ['', '   '] }).includes('You last said'));
});

// ---------------------------------------------------------------- privacy
//
// The hard line: paths, commands, tool names, project names and counts may go to
// the endpoint. His code may not. This is enforced by an allowlist, so the test
// hands the *unfiltered* payload to every layer and checks the secrets cannot
// come out the other end.

const PRIVATE = Object.freeze({
  file_path: 'C:\\repo\\src\\auth.ts',
  old_string: 'const OLD_PASSWORD = "hunter2";',
  new_string: 'const NEW_PASSWORD = "correct-horse-battery";',
  content: 'the entire contents of the file he is writing',
  prompt: 'what the owner actually typed into his agent',
  description: 'a private note about the task',
  command: 'echo hi',
});

const LEAKS = ['hunter2', 'correct-horse', 'OLD_PASSWORD', 'NEW_PASSWORD',
  'entire contents', 'actually typed', 'private note'];

function assertNoLeak(text, label) {
  for (const secret of LEAKS) {
    assert.ok(!String(text).includes(secret), `${label} leaked ${secret}: ${text}`);
  }
}

test('the tool_input allowlist is a list of keys, and nothing else gets through', () => {
  assert.deepEqual([...ALLOWED_TOOL_INPUT_KEYS].sort(), [
    'command', 'file_path', 'notebook_path', 'path', 'pattern', 'subagent_type', 'url',
  ]);
  for (const forbidden of ['old_string', 'new_string', 'content', 'prompt', 'description', 'transcript_path']) {
    assert.ok(!ALLOWED_TOOL_INPUT_KEYS.includes(forbidden), `${forbidden} must never be allowlisted`);
  }

  // Asking for a forbidden key by name does not get it either.
  assert.deepEqual(pickToolInput(PRIVATE, ['file_path', 'old_string', 'content']), {
    file_path: PRIVATE.file_path,
  });
  // A non-string under an allowed key is dropped rather than serialized.
  assert.deepEqual(pickToolInput({ file_path: { nested: 'object' }, command: ['a'] }), {});
});

test('no file content, diff or prompt reaches the built input, from any layer', () => {
  const payload = {
    session_id: 's1',
    cwd: CWD,
    hook_event_name: 'PreToolUse',
    tool_name: 'Edit',
    tool_input: PRIVATE,
    transcript_path: 'C:\\Users\\kw11l\\.claude\\projects\\s1.jsonl',
  };

  assertNoLeak(describeAction(payload), 'describeAction');
  assert.equal(describeAction(payload), 'editing auth.ts', 'the path is sayable, its contents are not');

  const context = buildContext({ ring: [entry({ tool: 'Edit', input: PRIVATE })], state: null, now: NOW });
  assertNoLeak(JSON.stringify(context), 'buildContext');

  // The unfiltered tool_input handed straight to the input builder, which is what
  // would happen if speech's own allowlist call were ever removed.
  const input = buildBrainInput({
    kind: 'busy', tool: 'Edit', project: 'ganyu-pet', source: 'claude', event: 'PreToolUse',
    toolInput: PRIVATE, context, recentLines: ['Running Edit…'],
  });
  assertNoLeak(input, 'buildBrainInput');
  assert.ok(input.includes('editing auth.ts'), input);
});

test('and none of it survives the real speech -> brain seam either', async () => {
  const asked = [];
  const speech = createSpeech({
    clock: { now: () => NOW },
    onLine: () => {},
    random: () => 0,
    brain: {
      requestLine(args) {
        asked.push(args);
        return Promise.resolve(null);
      },
    },
  });

  const state = createState({ clock: () => NOW });
  state.onEvent((event) => speech.onEvent({ ...event, aggregate: null }));
  state.ingest('claude', {
    session_id: 's1', cwd: CWD, hook_event_name: 'Notification', tool_name: 'Edit', tool_input: PRIVATE,
  });

  assert.equal(asked.length, 1, 'the event reached the brain');
  assertNoLeak(JSON.stringify(asked[0].detail), 'brainDetail');
  assertNoLeak(buildBrainInput(asked[0].detail, asked[0].summary), 'the input the brain would send');
  assert.deepEqual(asked[0].detail.toolInput, { file_path: PRIVATE.file_path, command: PRIVATE.command },
    'speech filters at the edge as well');
});
