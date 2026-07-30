// Module D tests — the bubble is a deterministic status indicator, so these
// cover: trigger rules, the 6s throttle (with waiting/failed bypassing it),
// throttled busy lines being DROPPED rather than queued, mute, slot
// substitution including the unknown-tool / unknown-project variants, and the
// MESSAGES house rules. With no brain injected notify() is synchronous and none
// of that changes; the last section adds the optional brain (see brain.test.mjs
// for the client itself) with an injected fake, never a network call.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INTERRUPT_KINDS,
  RECENT_LINES,
  THROTTLE_MS,
  createSpeech,
  modeForEvent,
  projectName,
  toolClass,
  toolNameOf,
} from '../src/main/speech.mjs';
import { createState } from '../src/main/state.mjs';
import { toSpeechDetail } from '../src/main/window.mjs';
import {
  MAX_LINE_CHARS,
  MESSAGES,
  buildSummary,
  messageFor,
  sourceLabel,
} from '../src/main/persona.mjs';

/** Test harness: manual clock, captured lines, deterministic variant choice. */
function harness(opts = {}) {
  const lines = [];
  let t = 1_000_000; // arbitrary non-zero epoch

  const speech = createSpeech({
    clock: { now: () => t },
    onLine: (line) => lines.push(line),
    isMuted: () => Boolean(opts.muted && opts.muted()),
    random: opts.random ?? (() => 0),
    brain: opts.brain ?? null,
  });

  return {
    speech,
    lines,
    now: () => t,
    advance(ms) {
      t += ms;
    },
  };
}

const sessionStart = { source: 'codex', event: 'SessionStart', sessionId: 's1', cwd: 'C:\\dev\\ganyu-pet' };
const bashPre = { source: 'codex', event: 'PreToolUse', sessionId: 's1', toolName: 'Bash', cwd: 'C:\\dev\\ganyu-pet' };
const editPre = { source: 'codex', event: 'PreToolUse', sessionId: 's1', toolName: 'Edit', cwd: 'C:\\dev\\ganyu-pet' };
const stop = { source: 'codex', event: 'Stop', sessionId: 's1', cwd: 'C:\\dev\\ganyu-pet' };
const permission = { source: 'claude', event: 'Notification', sessionId: 's2', toolName: 'Bash', mode: 'waiting' };
const failure = { source: 'claude', event: 'PostToolUse', sessionId: 's2', toolName: 'Bash', mode: 'failed' };

const CWD = 'C:\\Users\\kw11l\\Desktop\\ganyu-pet';

// ---------------------------------------------------------------- trigger rules

test('SessionStart greets, synchronously, with the project name in the line', () => {
  const h = harness();
  const res = h.speech.notify(sessionStart);
  assert.equal(res.spoken, true);
  assert.equal(res.reason, 'spoken');
  assert.equal(res.kind, 'greeting');
  assert.equal(h.lines.length, 1, 'the line is emitted before notify() returns');
  assert.equal(h.lines[0].text, 'Session started in ganyu-pet.');
  assert.equal(h.lines[0].text, res.text);
});

test('unknown events and a first tool use do not speak', () => {
  const h = harness();
  assert.equal(h.speech.notify({ source: 'codex', event: 'MysteryEvent', sessionId: 's1' }).reason, 'no-trigger');
  assert.equal(h.speech.notify({ source: 'codex', event: 'PostToolUse', sessionId: 's9', toolName: 'Read' }).reason, 'no-trigger');
  assert.equal(h.lines.length, 0);
});

test('tool-class change during busy speaks; the same class again does not', () => {
  const h = harness();
  h.speech.notify(editPre); // first tool of the session: no previous class, no line
  assert.equal(h.lines.length, 0);
  h.speech.notify({ ...editPre, toolName: 'Write' }); // still the edit class
  assert.equal(h.lines.length, 0);
  const res = h.speech.notify(bashPre); // edit -> shell: a class change
  assert.equal(res.kind, 'busy');
  assert.equal(res.text, 'Running Bash…');
  assert.equal(h.lines.length, 1);
});

test('Stop celebrates, Notification waits, a failed event sympathises', () => {
  const h = harness();
  assert.equal(h.speech.notify(stop).kind, 'celebrate');
  assert.equal(h.speech.notify(permission).kind, 'waiting');
  assert.equal(h.speech.notify(failure).kind, 'failed');
  assert.deepEqual(h.lines.map((l) => l.kind), ['celebrate', 'waiting', 'failed']);
  assert.deepEqual(h.lines.map((l) => l.text), [
    'Finished in ganyu-pet.',
    'Bash needs your approval.',
    "Error in Bash. I've noted it.",
  ]);
});

test('module B spellings (`tool`, `failed`) drive the failed trigger', () => {
  const h = harness();
  const res = h.speech.notify({
    source: 'claude', event: 'PostToolUse', sessionId: 's1', tool: 'Bash', mode: 'busy', failed: true,
  });
  assert.equal(res.kind, 'failed', 'a failing PostToolUse arrives with mode busy');
  assert.equal(res.text, "Error in Bash. I've noted it.");
});

test('speech never re-derives failure from payload text — module B decides', () => {
  const h = harness();
  const res = h.speech.handleEvent('claude', {
    session_id: 's1',
    cwd: CWD,
    hook_event_name: 'Stop',
    tool_response: 'Error: exit code 1',
    last_message: 'the build failed',
  });
  assert.equal(res.kind, 'celebrate');
  assert.equal(res.text, 'Finished in ganyu-pet.');
});

test('onEvent takes the object shape module A pushes; handleEvent takes both', () => {
  const h = harness();
  const res = h.speech.onEvent(
    {
      source: 'claude',
      payload: { session_id: 'abc', cwd: CWD, hook_event_name: 'Stop' },
      event: 'Stop',
      mode: 'idle',
    },
    { mode: 'idle', celebrate: true },
  );
  assert.equal(res.kind, 'celebrate');
  assert.equal(res.summary, 'Claude Code finished a task in ganyu-pet');

  const h2 = harness();
  assert.equal(h2.speech.handleEvent({ source: 'codex', event: 'SessionStart', sessionId: 's1' }).kind, 'greeting');
  const raw = h2.speech.handleEvent('claude', {
    session_id: 'abc', cwd: CWD, hook_event_name: 'Notification', tool_name: 'Bash',
  });
  assert.equal(raw.kind, 'waiting');
  assert.equal(raw.summary, 'Claude Code is waiting for permission to run Bash');
});

test('the emitted line carries kind, mode, source and the summary', () => {
  const h = harness();
  h.speech.notify(permission);
  assert.deepEqual(h.lines[0], {
    text: 'Bash needs your approval.',
    kind: 'waiting',
    mode: 'waiting',
    source: 'claude',
    summary: 'Claude Code is waiting for permission to run Bash',
  });
});

// ---------------------------------------------------------------- throttle

test('throttle is 6s: 5.999s is refused, 6s speaks', () => {
  const h = harness();
  assert.equal(h.speech.notify(sessionStart).spoken, true);

  h.advance(THROTTLE_MS - 1);
  const blocked = h.speech.notify(stop);
  assert.equal(blocked.spoken, false);
  assert.equal(blocked.reason, 'throttled');
  assert.equal(blocked.retryInMs, 1);
  assert.equal(h.lines.length, 1);

  h.advance(1);
  assert.equal(h.speech.notify(stop).spoken, true);
  assert.equal(h.lines.length, 2);
});

test('waiting and failed bypass the throttle and always speak', () => {
  const h = harness();
  h.speech.notify(sessionStart);
  assert.deepEqual([...INTERRUPT_KINDS], ['waiting', 'failed']);

  // Same millisecond as the greeting: neither is refused.
  assert.equal(h.speech.notify(permission).spoken, true);
  assert.equal(h.speech.notify({ ...failure, sessionId: 's7' }).spoken, true);
  assert.deepEqual(h.lines.map((l) => l.kind), ['greeting', 'waiting', 'failed']);
});

test('a throttled busy line is dropped, not queued', () => {
  const h = harness();
  h.speech.notify(sessionStart); // speaks
  h.speech.notify(editPre); // first class of the session, no line
  assert.equal(h.speech.notify(bashPre).reason, 'throttled');

  h.advance(60 * 60 * 1000); // an hour later: there was never anything held
  assert.deepEqual(h.lines.map((l) => l.kind), ['greeting']);
  // A stale status is worse than none, so there is no queue and no timer to flush.
  assert.deepEqual(Object.keys(h.speech.stats()).sort(), ['lastMode', 'lastSpokeAt']);
});

test('a spoken interrupt still restarts the throttle for ordinary kinds', () => {
  const h = harness();
  h.speech.notify(permission); // interrupt speaks with no history
  h.advance(THROTTLE_MS - 1);
  assert.equal(h.speech.notify(stop).reason, 'throttled');
  h.advance(1);
  assert.equal(h.speech.notify(stop).spoken, true);
});

// ---------------------------------------------------------------- mute

test('muted: no lines at all, and unmuting resumes', () => {
  let muted = true;
  const h = harness({ muted: () => muted });
  assert.equal(h.speech.notify(sessionStart).reason, 'muted');
  assert.equal(h.speech.notify(failure).reason, 'muted', 'not even the interrupt kinds');
  assert.equal(h.lines.length, 0);
  assert.equal(h.speech.stats().lastSpokeAt, null);

  muted = false;
  assert.equal(h.speech.notify(stop).spoken, true);
  assert.equal(h.lines.length, 1);
});

// ---------------------------------------------------------------- messages & slots

test('MESSAGES: five kinds, 3-5 variants, <= 70 chars, one emoji, no honorific', () => {
  assert.equal(MAX_LINE_CHARS, 70);
  assert.deepEqual(Object.keys(MESSAGES).sort(), ['busy', 'celebrate', 'failed', 'greeting', 'waiting']);

  for (const [kind, table] of Object.entries(MESSAGES)) {
    assert.ok(Array.isArray(table), `${kind} table missing`);
    assert.ok(table.length >= 3 && table.length <= 5, `${kind} has ${table.length} variants`);
    assert.equal(new Set(table).size, table.length, `${kind} has duplicate variants`);
    assert.ok(table.some((t) => !t.includes('{')), `${kind} has no slot-free variant`);
    for (const line of table) {
      assert.ok(line.length > 0 && line.length <= MAX_LINE_CHARS, `too long (${line.length}): ${line}`);
      const emoji = line.match(/\p{Extended_Pictographic}/gu) ?? [];
      assert.ok(emoji.length <= 1, `more than one emoji: ${line}`);
      assert.ok(!/\b(mr|mrs|ms|miss|sir|madam|master)\b/i.test(line), `honorific: ${line}`);
      assert.ok(!/\{(?!tool\}|project\})/.test(line), `unknown slot: ${line}`);
    }
  }
});

test('every kind renders with no tool and no project without leaking a slot', () => {
  for (const kind of Object.keys(MESSAGES)) {
    for (const r of [0, 0.2, 0.4, 0.6, 0.8, 0.99]) {
      const line = messageFor(kind, { random: () => r });
      assert.ok(line.length > 0, `${kind} produced no line at random=${r}`);
      assert.ok(!line.includes('{'), `${kind} leaked a slot: ${line}`);
      assert.ok(!/\b(undefined|null)\b/.test(line), `${kind} leaked a value: ${line}`);
    }
  }
});

test('an event with no tool and no project still gets a natural line', () => {
  const h = harness();
  const greeting = h.speech.notify({ source: 'codex', event: 'SessionStart', sessionId: 's1' });
  assert.equal(greeting.text, "Reporting in. I'll keep the records.");

  h.advance(THROTTLE_MS);
  const idle = h.speech.notify({ source: 'codex', event: 'SessionEnd', sessionId: 's1' });
  assert.equal(idle.kind, 'celebrate');
  assert.equal(idle.text, 'Task complete. I\'ll file the report.');

  const waiting = h.speech.notify({ source: 'codex', event: 'PermissionRequest', sessionId: 's1' });
  assert.equal(waiting.text, 'Paused — a permission request needs you.');
});

test('slot substitution is literal: $& and $` in a name stay as typed', () => {
  const line = messageFor('busy', { tool: '$&-$`tool', project: 'p', random: () => 0 });
  assert.equal(line, 'Running $&-$`tool…');
});

test('messageFor is deterministic with an injected random and avoids repeats', () => {
  assert.equal(messageFor('waiting', { tool: 'Bash', random: () => 0 }), 'Bash needs your approval.');
  assert.equal(
    messageFor('waiting', { tool: 'Bash', random: () => 0, avoid: 'Bash needs your approval.' }),
    'Waiting on your approval for Bash. 🙏',
  );
  assert.equal(messageFor('nonsense-kind', { random: () => 0 }), '');
});

test('consecutive lines of the same kind do not repeat the previous one', () => {
  const h = harness();
  h.speech.notify(permission);
  h.speech.notify({ ...permission, sessionId: 's5' });
  assert.equal(h.lines.length, 2);
  assert.notEqual(h.lines[0].text, h.lines[1].text);
});

test('a very long project name is clamped instead of overflowing the bubble', () => {
  const h = harness();
  const res = h.speech.notify({ source: 'codex', event: 'Stop', sessionId: 's1', project: 'x'.repeat(200) });
  assert.ok(res.text.length <= MAX_LINE_CHARS, `length ${res.text.length}`);
  assert.ok(res.text.endsWith('…'));
  assert.equal(h.lines[0].text, res.text);
});

test('buildSummary reproduces both contract examples verbatim', () => {
  assert.equal(
    buildSummary({ source: 'codex', event: 'Stop', project: 'ganyu-pet' }),
    'codex finished a task in ganyu-pet',
  );
  assert.equal(
    buildSummary({ source: 'claude', event: 'Notification', toolName: 'Bash', mode: 'waiting' }),
    'Claude Code is waiting for permission to run Bash',
  );
  assert.equal(sourceLabel('claude'), 'Claude Code');
});

// ---------------------------------------------------------------- robustness

test('a throwing onLine listener does not break notify', () => {
  const speech = createSpeech({
    clock: { now: () => 0 },
    onLine: () => {
      throw new Error('boom');
    },
    random: () => 0,
  });
  assert.equal(speech.notify(sessionStart).spoken, true);
});

test('dispose clears the tool-class memory', () => {
  const h = harness();
  h.speech.notify(editPre);
  h.speech.dispose();
  assert.equal(h.speech.notify(bashPre).reason, 'no-trigger', 'nothing left to compare the class against');
});

// ---------------------------------------------------------------- normalization helpers

test('toolClass groups tools so edit -> shell counts as a change', () => {
  assert.equal(toolClass('Bash'), 'shell');
  assert.equal(toolClass('Write'), 'edit');
  assert.equal(toolClass('MultiEdit'), 'edit');
  assert.equal(toolClass('Read'), 'read');
  assert.equal(toolClass(null), 'none');
  assert.equal(toolClass('SomethingElse'), 'somethingelse');
});

test('modeForEvent mirrors the module B table', () => {
  assert.equal(modeForEvent('PreToolUse'), 'busy');
  assert.equal(modeForEvent('PermissionRequest'), 'waiting');
  assert.equal(modeForEvent('Notification'), 'waiting');
  assert.equal(modeForEvent('Stop'), 'idle');
  assert.equal(modeForEvent('SessionEnd'), 'idle');
  assert.equal(modeForEvent('PostToolUse', true), 'failed');
  assert.equal(modeForEvent('Whatever'), null);
});

test('projectName takes the last segment of either path style', () => {
  assert.equal(projectName('C:\\Users\\kw11l\\Desktop\\ganyu-pet'), 'ganyu-pet');
  assert.equal(projectName('/home/x/ganyu-pet/'), 'ganyu-pet');
  assert.equal(projectName(''), null);
});

test('toolNameOf accepts the string and object spellings', () => {
  assert.equal(toolNameOf('Bash'), 'Bash');
  assert.equal(toolNameOf({ name: 'Bash' }), 'Bash');
  assert.equal(toolNameOf({ tool_name: 'Bash' }), 'Bash');
  assert.equal(toolNameOf(null), null);
  assert.equal(toolNameOf(''), null);
});

// ------------------------------------------------- cross-module integration (B -> A -> D)
//
// The trigger tests above hand-feed `toolName`/`mode`/`failed`. Module B emits
// `tool`/`failed` and module A forwards its normalized event with no `payload`,
// so those tests can all pass while the wired app speaks only some of the five
// triggers. This drives the real seam: raw hook payload -> state.ingest ->
// state.onEvent -> toSpeechDetail -> speech.onEvent.

test('all five triggers fire through the real B -> A -> D seam', () => {
  const h = harness();
  const state = createState({ clock: { now: () => h.now() } });
  state.onEvent((event, aggregate) => h.speech.onEvent(toSpeechDetail(event, aggregate), aggregate));

  state.ingest('claude', { session_id: 's1', cwd: CWD, hook_event_name: 'SessionStart' });

  h.advance(THROTTLE_MS);
  state.ingest('claude', { session_id: 's1', cwd: CWD, hook_event_name: 'PreToolUse', tool_name: 'Edit' });
  state.ingest('claude', { session_id: 's1', cwd: CWD, hook_event_name: 'PreToolUse', tool_name: 'Bash' });

  // Both interrupts land inside the throttle window on purpose.
  state.ingest('claude', { session_id: 's1', cwd: CWD, hook_event_name: 'Notification', tool_name: 'Bash' });
  state.ingest('claude', {
    session_id: 's1', cwd: CWD, hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_response: { is_error: true },
  });

  h.advance(THROTTLE_MS);
  state.ingest('claude', { session_id: 's1', cwd: CWD, hook_event_name: 'Stop' });

  assert.deepEqual(h.lines.map((l) => l.kind), ['greeting', 'busy', 'waiting', 'failed', 'celebrate']);
  assert.deepEqual(h.lines.map((l) => l.text), [
    'Session started in ganyu-pet.',
    'Running Bash…',
    'Bash needs your approval.',
    "Error in Bash. I've noted it.",
    'Finished in ganyu-pet.',
  ]);
});

// ------------------------------------------------- optional brain (module D)
//
// The brain only ever improves on the canned line: it must not delay an urgent
// bubble, must not speak through a mute, and must not land a line about an event
// the bubble has already moved on from.

/**
 * Stand-in for brain.mjs: every request hangs until the test releases it, and it
 * enforces the same single-flight rule the real client does.
 */
function fakeBrain() {
  const calls = [];
  let pending = null;
  return {
    calls,
    requestLine(args) {
      calls.push(args);
      if (pending) return Promise.resolve(null); // one in flight at a time
      return new Promise((resolve) => {
        pending = resolve;
      });
    },
    reply(line) {
      const resolve = pending;
      pending = null;
      resolve(line);
    },
  };
}

test('an urgent kind shows the canned line at once, then the brain line replaces it', async () => {
  const brain = fakeBrain();
  const h = harness({ brain });

  const res = h.speech.notify(permission);
  assert.equal(res.spoken, true, 'no waiting on the network for a permission prompt');
  assert.equal(h.lines.length, 1);
  assert.equal(h.lines[0].text, 'Bash needs your approval.');

  assert.equal(brain.calls.length, 1);
  assert.deepEqual(brain.calls[0].detail, {
    kind: 'waiting',
    event: 'Notification',
    tool: 'Bash',
    project: null,
    mode: 'waiting',
    source: 'claude',
    toolInput: {},
    agentType: null,
    // The canned line is already in the bubble, so it is the first thing she is
    // told not to repeat.
    recentLines: ['Bash needs your approval.'],
  });
  assert.equal(brain.calls[0].summary, 'Claude Code is waiting for permission to run Bash');

  brain.reply('Kahweng, Bash is waiting on your word.');
  const settled = await res.pending;
  assert.equal(settled.spoken, true);
  assert.equal(h.lines.length, 2, 'a second line replaces the bubble');
  assert.equal(h.lines[1].text, 'Kahweng, Bash is waiting on your word.');
  assert.equal(h.lines[1].kind, 'waiting');
  assert.equal(h.lines[1].summary, h.lines[0].summary);
});

test('an urgent kind keeps its canned line when the brain returns nothing', async () => {
  const brain = fakeBrain();
  const h = harness({ brain });
  const res = h.speech.notify(failure);

  brain.reply(null);
  const settled = await res.pending;
  assert.equal(settled.spoken, false);
  assert.equal(settled.reason, 'brain-empty');
  assert.deepEqual(h.lines.map((l) => l.text), ["Error in Bash. I've noted it."]);
});

test('a non-urgent kind waits for the brain, and falls back to canned on null', async () => {
  const brain = fakeBrain();
  const h = harness({ brain });

  const greeting = h.speech.notify(sessionStart);
  assert.equal(greeting.spoken, false);
  assert.equal(greeting.reason, 'brain-pending');
  assert.equal(h.lines.length, 0, 'nothing is shown until the brain answers');

  brain.reply('A new session in ganyu-pet, Kahweng. I have the notes ready.');
  assert.equal((await greeting.pending).spoken, true);
  assert.deepEqual(h.lines.map((l) => l.text), [
    'A new session in ganyu-pet, Kahweng. I have the notes ready.',
  ]);

  h.advance(THROTTLE_MS);
  const done = h.speech.notify(stop);
  brain.reply(null);
  const settled = await done.pending;
  assert.equal(settled.spoken, true);
  assert.equal(settled.text, 'Finished in ganyu-pet.', 'the canned line stands in');
  assert.equal(h.lines.length, 2);
});

test('muting between the request and the reply drops the brain line', async () => {
  let muted = false;
  const brain = fakeBrain();
  const h = harness({ brain, muted: () => muted });

  const res = h.speech.notify(permission);
  assert.equal(h.lines.length, 1, 'the canned line was already out');

  muted = true;
  brain.reply('Kahweng, a permission is pending.');
  const settled = await res.pending;
  assert.equal(settled.spoken, false);
  assert.equal(settled.reason, 'muted');
  assert.equal(h.lines.length, 1, 'the brain line is gated exactly like a canned one');

  // And while muted the brain is not asked at all — no tokens, no request.
  assert.equal(h.speech.notify(stop).reason, 'muted');
  assert.equal(brain.calls.length, 1);
});

test('a brain reply whose bubble was taken by a newer line is dropped', async () => {
  const brain = fakeBrain();
  const h = harness({ brain });

  const done = h.speech.notify(stop); // non-urgent: in flight, nothing shown yet
  assert.equal(h.lines.length, 0);

  h.speech.notify(permission); // an interrupt takes the bubble meanwhile
  assert.equal(h.lines.length, 1);
  assert.equal(h.lines[0].kind, 'waiting');

  brain.reply('All finished in ganyu-pet, Kahweng.');
  const settled = await done.pending;
  assert.equal(settled.spoken, false);
  assert.equal(settled.reason, 'stale');
  assert.equal(h.lines.length, 1, 'a line about the previous event never lands');
  // The throttle is measured from what was actually shown, not from the dropped reply.
  assert.equal(h.speech.stats().lastSpokeAt, h.now());
});

test('the brain is told the last three lines she said, canned or generated', async () => {
  const brain = fakeBrain();
  const h = harness({ brain });

  // Four lines said, so the oldest has to fall out of a ring of three.
  const first = h.speech.notify(permission); // urgent: the canned line is already out
  brain.reply(null);
  await first.pending;

  h.advance(THROTTLE_MS);
  const greeting = h.speech.notify(sessionStart);
  brain.reply('A new session in ganyu-pet, Kahweng.'); // a generated line counts too
  await greeting.pending;

  h.advance(THROTTLE_MS);
  const done = h.speech.notify(stop);
  brain.reply(null); // falls back to the canned celebrate line
  await done.pending;

  h.advance(THROTTLE_MS);
  h.speech.notify({ ...failure, sessionId: 's7' });

  assert.deepEqual(h.lines.map((l) => l.text), [
    'Bash needs your approval.',
    'A new session in ganyu-pet, Kahweng.',
    'Finished in ganyu-pet.',
    "Error in Bash. I've noted it.",
  ]);
  assert.deepEqual(brain.calls.at(-1).detail.recentLines, [
    "Error in Bash. I've noted it.", // newest first, and the one in the bubble right now
    'Finished in ganyu-pet.',
    'A new session in ganyu-pet, Kahweng.', // generated lines are remembered as well
  ]);
  assert.equal(RECENT_LINES, 3);
});

test('the tool input reaches the brain, filtered to the allowlist', () => {
  const brain = fakeBrain();
  const h = harness({ brain });
  h.speech.notify({
    ...permission,
    toolInput: { command: 'npm test', old_string: 'const SECRET = 1', content: 'a whole file' },
  });
  assert.deepEqual(brain.calls[0].detail.toolInput, { command: 'npm test' });
});

test('a throttled event never reaches the brain', () => {
  const brain = fakeBrain();
  const h = harness({ brain });
  h.speech.notify(permission); // urgent: shown, and asks the brain
  assert.equal(brain.calls.length, 1);

  h.advance(THROTTLE_MS - 1);
  assert.equal(h.speech.notify(stop).reason, 'throttled');
  assert.equal(brain.calls.length, 1, 'no request for a line that could not be shown');
});

test('free-text "error" in a tool response no longer makes her kneel (regression)', () => {
  const h = harness();
  const state = createState({ clock: { now: () => h.now() } });
  state.onEvent((event, aggregate) => h.speech.onEvent(toSpeechDetail(event, aggregate), aggregate));

  state.ingest('claude', { session_id: 's1', cwd: CWD, hook_event_name: 'PreToolUse', tool_name: 'Read' });
  state.ingest('claude', {
    session_id: 's1', cwd: CWD, hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_input: { command: 'rg -n error src' },
    tool_response: 'npm ERR! the build failed\nTraceback (most recent call last):',
  });

  assert.equal(state.aggregate().mode, 'busy', 'the aggregate never enters failed');
  assert.deepEqual(h.lines.map((l) => l.kind), ['busy'], 'read -> shell is a class change, not a failure');
  assert.equal(h.speech.stats().lastMode, 'busy');
});
