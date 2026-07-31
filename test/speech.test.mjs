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
  NOTABLE_INTERVAL_MS,
  QUIET_STRETCH_MS,
  QUIET_THROTTLE_MS,
  RECENT_LINES,
  THROTTLE_MS,
  createSpeech,
  modeForEvent,
  projectName,
  salienceOf,
  toolClass,
  toolNameOf,
} from '../src/main/speech.mjs';
import { createState } from '../src/main/state.mjs';
import { toSpeechDetail } from '../src/main/window.mjs';
import {
  BRAIN_INSTRUCTIONS,
  BRAIN_LINE_TARGET_CHARS,
  MAX_LINE_CHARS,
  MESSAGES,
  VOICE_EXAMPLES,
  buildSummary,
  messageFor,
  sourceLabel,
} from '../src/main/persona.mjs';

/**
 * A ledger, shrunk to the one method speech calls. `entries` is what reached
 * the disk in production — the assertions below read it directly rather than
 * going through a real file, which ledger.test.mjs already covers.
 */
function fakeLedger({ throws = false } = {}) {
  const entries = [];
  return {
    entries,
    kinds: () => entries.map((e) => e.kind),
    record(entry) {
      if (throws) throw new Error('disk is on fire');
      entries.push(entry);
      return entry;
    },
  };
}

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
    ledger: opts.ledger ?? null,
  });

  return {
    speech,
    lines,
    ledger: opts.ledger ?? null,
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

test('the non-urgent throttle is 90s: 89.999s is refused, 90s speaks', () => {
  const h = harness();
  assert.equal(h.speech.notify(sessionStart).spoken, true);

  h.advance(QUIET_THROTTLE_MS - 1);
  const blocked = h.speech.notify(stop);
  assert.equal(blocked.spoken, false);
  assert.equal(blocked.reason, 'throttled');
  assert.equal(blocked.retryInMs, 1);
  assert.equal(h.lines.length, 1);

  h.advance(1);
  assert.equal(h.speech.notify(stop).spoken, true);
  assert.equal(h.lines.length, 2);
});

test('two sessions hitting the same wall together is one bubble, not two', () => {
  const h = harness();
  h.speech.notify(permission);
  // Same kind, same second, different session: one piece of news.
  const second = h.speech.notify({ ...permission, sessionId: 's9' });
  assert.equal(second.spoken, false);
  assert.equal(second.reason, 'throttled');
  assert.equal(second.retryInMs, THROTTLE_MS);

  h.advance(THROTTLE_MS);
  assert.equal(h.speech.notify({ ...permission, sessionId: 's9' }).spoken, true);
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

test('a throttled line is dropped, not queued', () => {
  const h = harness();
  h.speech.notify(sessionStart); // speaks
  h.advance(1000);
  assert.equal(h.speech.notify(stop).reason, 'throttled');

  h.advance(60 * 60 * 1000); // an hour later: there was never anything held
  assert.deepEqual(h.lines.map((l) => l.kind), ['greeting']);
  // A stale status is worse than none, so there is no queue and no timer to flush.
  assert.deepEqual(Object.keys(h.speech.stats()).sort(), [
    'failStreak', 'lastKind', 'lastMode', 'lastNotableAt', 'lastSpokeAt',
  ]);
});

test('a spoken interrupt still restarts the throttle for ordinary kinds', () => {
  const h = harness();
  h.speech.notify(permission); // interrupt speaks with no history
  h.advance(QUIET_THROTTLE_MS - 1);
  assert.equal(h.speech.notify(stop).reason, 'throttled');
  h.advance(1);
  assert.equal(h.speech.notify(stop).spoken, true);
});

// ---------------------------------------------------------------- salience
//
// The throttle decides how *often* she may speak; salience decides whether this
// event is worth a line at all. Without it, several agents emitting
// PreToolUse/PostToolUse continuously meant she narrated whichever Read or Grep
// happened to clear the throttle — "she keeps telling me the most random
// things". Silence is what makes the remaining lines mean anything.

test('salienceOf ranks the moments worth interrupting him for', () => {
  const routine = (over = {}) => salienceOf({ kind: 'busy', quietForMs: 0, ...over });

  assert.equal(salienceOf({ kind: null }).level, null);
  assert.equal(salienceOf({ kind: 'waiting' }).level, 'urgent');
  for (const kind of ['greeting', 'celebrate', 'recovered']) {
    assert.equal(routine({ kind }).level, 'always', kind);
  }

  assert.equal(routine().level, null, 'routine tool traffic on its own is silence');
  assert.equal(routine().reason, 'routine');
  assert.equal(routine({ quietForMs: QUIET_STRETCH_MS }).level, 'always', 'unless she has said nothing for ten minutes');
  assert.equal(routine({ patterns: ['repeat-file'] }).level, 'notable');
  assert.equal(
    routine({ patterns: ['repeat-file'], sinceNotableMs: NOTABLE_INTERVAL_MS - 1 }).level,
    null,
    'one pattern remark per ten minutes, not one per matching event',
  );
});

test('failures speak on the first, third and fifth — not on every retry', () => {
  const level = (n) => salienceOf({ kind: 'failed', failStreak: n }).level;
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 10].map(level), [
    'urgent', null, 'urgent', null, 'urgent', null, null, 'urgent',
  ]);
  assert.equal(salienceOf({ kind: 'failed', failStreak: 2 }).reason, 'repeat-failure');
  assert.equal(salienceOf({ kind: 'failed', failStreak: 3 }).reason, 'failure-streak-3');
});

test('a minute of ordinary Reads and Bashes produces no commentary at all', () => {
  const h = harness();
  h.speech.notify(sessionStart); // her first line, out of the way

  let last = null;
  for (let i = 0; i < 20; i += 1) {
    h.advance(2000);
    last = h.speech.notify(i % 2 ? bashPre : { ...editPre, toolName: 'Read' });
    assert.equal(last.spoken, false, `spoke on routine event ${i}`);
  }
  assert.equal(last.reason, 'not-salient');
  assert.deepEqual(h.lines.map((l) => l.kind), ['greeting']);
});

test('the first line after ten quiet minutes lands, then she goes quiet again', () => {
  const h = harness();
  h.speech.notify(sessionStart);
  h.speech.notify(editPre); // establishes the session's tool class; says nothing

  h.advance(QUIET_STRETCH_MS);
  const first = h.speech.notify(bashPre);
  assert.equal(first.spoken, true, 'ten minutes of silence earns one line');
  assert.equal(first.kind, 'busy');

  h.advance(60_000);
  const next = h.speech.notify({ ...editPre, toolName: 'Read' });
  assert.equal(next.spoken, false);
  assert.equal(next.reason, 'not-salient');
});

test('the same file five times over is worth one remark, and only one', () => {
  const h = harness();
  h.speech.notify(sessionStart);

  let spoken = 0;
  for (let i = 0; i < 12; i += 1) {
    h.advance(30_000);
    const res = h.speech.notify({
      source: 'claude',
      event: 'PreToolUse',
      sessionId: 's1',
      cwd: CWD,
      toolName: i % 2 ? 'Read' : 'Edit',
      toolInput: { file_path: `${CWD}\\src\\main\\persona.mjs` },
    });
    if (res.spoken) spoken += 1;
  }
  assert.equal(spoken, 1, 'twelve passes over one file is one remark, not eight');
});

test('a retry loop is not a recovery, and does not reset the streak', () => {
  const h = harness();
  const failed = { source: 'claude', event: 'PostToolUse', sessionId: 's2', toolName: 'Bash', mode: 'failed' };
  const retry = { source: 'claude', event: 'PreToolUse', sessionId: 's2', toolName: 'Bash', mode: 'busy' };

  const spoken = [];
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    h.advance(30_000);
    // "About to run it again" says nothing about whether it works. If this
    // counted as a recovery she would sympathise afresh on every attempt.
    assert.equal(h.speech.notify(retry).reason, 'no-trigger', `attempt ${attempt}`);
    h.advance(30_000);
    const res = h.speech.notify(failed);
    assert.equal(res.kind, 'failed');
    assert.equal(h.speech.stats().failStreak, attempt);
    if (res.spoken) spoken.push(attempt);
  }
  assert.deepEqual(spoken, [1, 3, 5], 'the first, the third and the fifth — not all five');
});

test('a recovery after a failure is always worth a line', () => {
  const h = harness();
  assert.equal(h.speech.notify(failure).kind, 'failed');
  assert.equal(h.speech.stats().failStreak, 1);

  h.advance(QUIET_THROTTLE_MS);
  const back = h.speech.notify({
    source: 'claude', event: 'PostToolUse', sessionId: 's2', toolName: 'Bash', mode: 'busy',
  });
  assert.equal(back.kind, 'recovered');
  assert.equal(back.spoken, true);
  assert.equal(h.speech.stats().failStreak, 0, 'the thing that worked clears the streak');
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

test('MESSAGES: six kinds, 3-5 variants, <= 70 chars, one emoji, no honorific', () => {
  assert.equal(MAX_LINE_CHARS, 70);
  assert.deepEqual(Object.keys(MESSAGES).sort(), [
    'busy', 'celebrate', 'failed', 'greeting', 'recovered', 'waiting',
  ]);

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
  // "I'll keep the records" until the greeting was rebalanced: two of the four
  // greetings announced her filing, and this is the one that fires every session.
  assert.equal(greeting.text, "Reporting in. I'll keep you company.");

  h.advance(QUIET_THROTTLE_MS);
  const idle = h.speech.notify({ source: 'codex', event: 'SessionEnd', sessionId: 's1' });
  assert.equal(idle.kind, 'celebrate');
  // "I'll file the report" until the ledger landed: she files nothing, and a
  // canned line promising it is the same false claim the persona rule now bans.
  assert.equal(idle.text, 'Task complete. I\'ll note it down.');

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
  h.advance(THROTTLE_MS);
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

test('every salient trigger fires through the real B -> A -> D seam', () => {
  const h = harness();
  const state = createState({ clock: { now: () => h.now() } });
  state.onEvent((event, aggregate) => h.speech.onEvent(toSpeechDetail(event, aggregate), aggregate));

  state.ingest('claude', { session_id: 's1', cwd: CWD, hook_event_name: 'SessionStart' });

  // A tool-class change on its own is exactly the traffic she used to narrate.
  h.advance(QUIET_THROTTLE_MS);
  state.ingest('claude', { session_id: 's1', cwd: CWD, hook_event_name: 'PreToolUse', tool_name: 'Edit' });
  state.ingest('claude', { session_id: 's1', cwd: CWD, hook_event_name: 'PreToolUse', tool_name: 'Bash' });

  // Both interrupts land inside the throttle window on purpose.
  state.ingest('claude', { session_id: 's1', cwd: CWD, hook_event_name: 'Notification', tool_name: 'Bash' });
  state.ingest('claude', {
    session_id: 's1', cwd: CWD, hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_response: { is_error: true },
  });

  // The next step that finishes and works is the recovery.
  h.advance(QUIET_THROTTLE_MS);
  state.ingest('claude', { session_id: 's1', cwd: CWD, hook_event_name: 'PostToolUse', tool_name: 'Read' });

  h.advance(QUIET_THROTTLE_MS);
  state.ingest('claude', { session_id: 's1', cwd: CWD, hook_event_name: 'Stop' });

  assert.deepEqual(h.lines.map((l) => l.kind), [
    'greeting', 'waiting', 'failed', 'recovered', 'celebrate',
  ]);
  assert.deepEqual(h.lines.map((l) => l.text), [
    'Session started in ganyu-pet.',
    'Bash needs your approval.',
    "Error in Bash. I've noted it.",
    'Read is working again.',
    'Finished in ganyu-pet.',
  ]);
});

// ------------------------------------------------- her voice (module D — persona)
//
// The owner's verdict on the generated lines was "she doesn't talk like Ganyu".
// The instructions described her in the abstract, which reliably produces a
// corporate assistant; these guard the two things that actually fix that — who
// she is, and worked examples of the register.

test('the voice examples cover the moments she reaches, and obey her own rules', () => {
  assert.ok(VOICE_EXAMPLES.length >= 8 && VOICE_EXAMPLES.length <= 12, `${VOICE_EXAMPLES.length} examples`);
  assert.equal(
    new Set(VOICE_EXAMPLES.map(([, line]) => line)).size,
    VOICE_EXAMPLES.length,
    'a duplicated example teaches her to repeat herself',
  );

  for (const [situation, line] of VOICE_EXAMPLES) {
    assert.ok(situation.length > 0, 'every example is labelled with its moment');
    assert.ok(line.length <= BRAIN_LINE_TARGET_CHARS, `too long (${line.length}): ${line}`);
    assert.ok(!line.includes('\n'), `more than one line: ${line}`);
    assert.ok(!line.includes('"'), `quoted: ${line}`);
    assert.ok(!/\b(mr|mrs|ms|miss|sir|madam)\b/i.test(line), `honorific: ${line}`);
    assert.ok(
      !/\b(monitor|ensure|proceed|flag|queued for approval)\b/i.test(line),
      `corporate register: ${line}`,
    );
    assert.ok(!/please \w+ carefully/i.test(line), `preachy: ${line}`);
    assert.ok((line.match(/\p{Extended_Pictographic}/gu) ?? []).length <= 1, `emoji: ${line}`);
  }
});

/**
 * Claims she cannot back. Each entry is a claim to have *acted on his work*, or
 * a promise to — not a list of forbidden English.
 *
 * This exists because of one line she actually said: "I've set that page aside
 * for you." Nothing in the app could set anything aside; she generalised the
 * claim out of a register full of secretarial competence, and the examples are
 * where the model reads that register from. So the examples are where it is
 * enforced. Note what is *not* here: "noted", "written down", "remember",
 * "corrected the record" — the ledger makes those true, which is the whole
 * reason it was built.
 */
const FORBIDDEN_CLAIMS = [
  [/\bset\b[^.?!]{0,24}\baside\b/i, 'setting his work aside'],
  [/\b(fixed|repaired|patched|resolved)\b/i, 'fixing it'],
  [/\bhandled\b/i, 'handling it'],
  [/\b(postponed|deferred|rescheduled)\b/i, 'postponing it'],
  [/\btook care of\b/i, 'taking care of it'],
  [/\bsorted (it|that|them) out\b/i, 'sorting it out'],
  [/\b(filed|archived|submitted)\b/i, 'filing a real thing'],
  [/\bcleaned (it|that|them) up\b/i, 'cleaning up'],
  [/\bI'?(ve| have) (run|ran|edited|deleted|removed|changed|updated)\b/i, 'touching his files'],
  [/\bI'?ll (fix|handle|sort|file|run|edit|take care|deal with|look after)\b/i, 'promising to'],
  [/\bleave it (with|to) me\b/i, 'promising to'],
  [/\bshall I (bring|fetch|make|get)\b/i, 'offering to fetch something'],
];

test('no line of hers claims an action she cannot take', () => {
  // Both halves of her voice: the examples the brain copies its register from,
  // and the canned table the bubble draws verbatim. "Task complete. I'll file
  // the report." lived in the second one until the ledger landed.
  const everything = [
    ...VOICE_EXAMPLES.map(([situation, line]) => [`example (${situation})`, line]),
    ...Object.entries(MESSAGES).flatMap(([kind, table]) => table.map((line) => [`${kind} variant`, line])),
  ];
  for (const [where, line] of everything) {
    for (const [pattern, claim] of FORBIDDEN_CLAIMS) {
      assert.ok(!pattern.test(line), `${where} claims ${claim}: ${line}`);
    }
  }
});

/**
 * The vocabulary she keeps records in. Matching on words rather than on whole
 * lines is the point: no single line here was ever wrong, and a rewrite that
 * swapped "the ledger" for "my notes" in six places would have fixed nothing.
 */
const RECORD_KEEPING = [
  /\bledgers?\b/i,
  /\brecords?\b/i,
  /\bnotes?\b/i,
  /\bnoted\b/i,
  /\bwrit(e|es|ten|ing)\b/i,
  /\bwrote\b/i,
  /\bjot(s|ted|ting)?\b/i,
];

const mentionsRecordKeeping = (line) => RECORD_KEEPING.some((re) => re.test(line));

/**
 * Six of the twelve examples used to be about writing things down — the fix for
 * the claim bug above, overapplied — and half a list is not a register but a
 * theme, so she announced her ledger at every moment that reached her until the
 * owner asked what she even meant by it. The capability is true and stays; its
 * share is what broke, exactly as it did for the clock and the session count.
 */
test('record-keeping is one note in her voice, not the whole of it', () => {
  const withRecord = VOICE_EXAMPLES.filter(([, line]) => mentionsRecordKeeping(line));
  assert.ok(
    withRecord.length <= 3,
    `${withRecord.length} of ${VOICE_EXAMPLES.length} examples are about her records `
      + `(${withRecord.map(([situation]) => situation).join(', ')})`,
  );
  // The floor matters too: rebalancing it away entirely would take with it the
  // one claim the ledger exists to make honest.
  assert.ok(withRecord.length >= 1, 'she keeps a real ledger — at least one example may say so');
  assert.ok(
    VOICE_EXAMPLES.filter(([, line]) => /\bledgers?\b/i.test(line)).length <= 1,
    'the word "ledger" twice is a catchphrase; once is character',
  );

  // MESSAGES goes into the bubble verbatim, so the same skew reads the same way.
  for (const [kind, table] of Object.entries(MESSAGES)) {
    const n = table.filter(mentionsRecordKeeping).length;
    assert.ok(n <= 1, `${kind} has ${n} of ${table.length} variants about her records`);
  }
});

test('the examples are introduced as a range, not as a checklist to work through', () => {
  assert.match(BRAIN_INSTRUCTIONS, /not a checklist to work through/i);
  assert.match(BRAIN_INSTRUCTIONS, /should not mention your notes or your record at all/i);
});

test('the standing rule names what she may claim and what she may not', () => {
  // She keeps a real ledger now, so exactly one class of claim is true.
  assert.match(BRAIN_INSTRUCTIONS, /you may say you have noted something, written it down/i);
  assert.match(BRAIN_INSTRUCTIONS, /You cannot edit a file, run a command, fix anything, set a page aside/i);
  assert.match(BRAIN_INSTRUCTIONS, /never say or imply that you have done so or are about to/i);
  assert.match(BRAIN_INSTRUCTIONS, /say so plainly and kindly/i);
  assert.match(BRAIN_INSTRUCTIONS, /do not pretend, and do not promise it for later/i);
});

test('the instructions carry who she is, the hard rules, and every example', () => {
  for (const [, line] of VOICE_EXAMPLES) {
    assert.ok(BRAIN_INSTRUCTIONS.includes(line), `example missing from the prompt: ${line}`);
  }
  for (const fact of [/qilin/i, /Yuehai Pavilion/, /almond tofu/i, /Qingxin/i, /overworked/i]) {
    assert.match(BRAIN_INSTRUCTIONS, fact);
  }
  // The rules that predate this rewrite and must survive it.
  assert.match(BRAIN_INSTRUCTIONS, /never with a title or honorific of any kind/i);
  assert.match(BRAIN_INSTRUCTIONS, /Never invent a detail you were not given/i);
  assert.match(BRAIN_INSTRUCTIONS, /Vary how you open/i);
  assert.match(BRAIN_INSTRUCTIONS, /never repeat a line you were just told you said/i);
  // And the two the owner's complaint added.
  assert.match(BRAIN_INSTRUCTIONS, /Never corporate/i);
  assert.match(BRAIN_INSTRUCTIONS, /ONLY if the briefing contains a line about it/);
  assert.match(BRAIN_INSTRUCTIONS, new RegExp(`under ${BRAIN_LINE_TARGET_CHARS} characters`));
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
  const { narration, ...detail } = brain.calls[0].detail;
  assert.deepEqual(detail, {
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
  // Snapshotted before the canned line went out, or the urgent path would look
  // like a continuation of itself and never count as her first line.
  assert.equal(narration.now, h.now());
  assert.equal(narration.firstLine, true);
  assert.equal(typeof narration.memory, 'object');
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

  h.advance(QUIET_THROTTLE_MS);
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

  h.advance(QUIET_THROTTLE_MS);
  const greeting = h.speech.notify(sessionStart);
  brain.reply('A new session in ganyu-pet, Kahweng.'); // a generated line counts too
  await greeting.pending;

  h.advance(QUIET_THROTTLE_MS);
  const done = h.speech.notify(stop);
  brain.reply(null); // falls back to the canned celebrate line
  await done.pending;

  h.advance(QUIET_THROTTLE_MS);
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

// ------------------------------------------------- what she writes down (the ledger)
//
// Speech is the only writer, and the question here is only ever *what gets in*.
// Salience has already decided what was worth interrupting him for; recording
// is a translation of that decision, never a second opinion on it — a ledger
// that re-derived its own idea of "notable" would drift from the lines she
// actually said, and the digest would describe an evening he did not have.
//
// The file itself, the pruning and the digest are ledger.test.mjs's; the fake
// here records what speech *offered*, which is the seam this section owns.

test('a salient moment is written down, with what the tool was doing', () => {
  const ledger = fakeLedger();
  const h = harness({ ledger });
  h.speech.notify({
    source: 'claude',
    event: 'PostToolUse',
    sessionId: 's2',
    toolName: 'Bash',
    mode: 'failed',
    cwd: 'C:\\Users\\kw11l\\Desktop\\GolfCRM',
    toolInput: { command: 'npm test' },
  });
  assert.deepEqual(ledger.entries, [{
    at: h.now(),
    kind: 'failed',
    project: 'GolfCRM',
    tool: 'Bash',
    detail: 'running `npm test`',
    sessionId: 's2',
  }]);
});

test('only the six kinds worth remembering reach it — never busy', () => {
  const ledger = fakeLedger();
  const h = harness({ ledger });

  h.speech.notify(sessionStart);                       // greeting
  h.advance(QUIET_THROTTLE_MS);
  h.speech.notify(permission);                         // waiting
  h.advance(QUIET_THROTTLE_MS);
  h.speech.notify(failure);                            // failed
  h.advance(QUIET_THROTTLE_MS);
  h.speech.notify({ ...failure, event: 'PostToolUse', mode: 'busy' }); // recovered
  h.advance(QUIET_THROTTLE_MS);
  h.speech.notify(stop);                               // celebrate

  assert.deepEqual(ledger.kinds(), ['greeting', 'waiting', 'failed', 'recovered', 'celebrate']);
});

test('routine tool traffic is not remembered, even when it is worth a line', () => {
  const ledger = fakeLedger();
  const h = harness({ ledger });

  h.speech.notify(sessionStart);
  assert.deepEqual(ledger.kinds(), ['greeting']);

  // A class change she is quiet about: ordinary work, and nothing to recall.
  h.advance(1000);
  h.speech.notify(editPre);
  const quiet = h.speech.notify(bashPre);
  assert.equal(quiet.reason, 'not-salient');

  // And a class change she *does* speak, because ten minutes of silence
  // promotes it. This is the interesting one: the line is worth showing, the
  // event is still a Bash call in the middle of an ordinary afternoon, and a
  // ledger holding those spends its whole file in an evening.
  h.advance(QUIET_STRETCH_MS);
  const spoken = h.speech.notify(editPre);
  assert.equal(spoken.kind, 'busy');
  assert.equal(spoken.spoken, true);

  assert.deepEqual(ledger.kinds(), ['greeting'], 'busy has no ledger kind, at any salience');
});

test('a pattern she remarks on is remembered as the pattern', () => {
  const ledger = fakeLedger();
  const h = harness({ ledger });
  const pass = {
    source: 'claude',
    event: 'PostToolUse',
    sessionId: 's1',
    mode: 'busy',
    cwd: 'C:\\dev\\ganyu-pet',
    toolInput: { file_path: 'C:\\dev\\ganyu-pet\\src\\main\\persona.mjs' },
  };
  // A first line, so the long-quiet promotion is not what fires below.
  h.speech.notify(sessionStart);
  h.advance(QUIET_THROTTLE_MS);
  // Read, edit, read, edit over the same file: a class change every time, so
  // each one is a `busy` trigger, and the fifth completes the repeat-file tally.
  for (let i = 0; i < 6; i += 1) {
    h.advance(1000);
    h.speech.notify({ ...pass, toolName: i % 2 === 0 ? 'Read' : 'Edit' });
  }

  const notable = ledger.entries.filter((e) => e.kind === 'notable');
  assert.equal(notable.length, 1, 'one remark per ten minutes, and one entry to match');
  assert.equal(notable[0].detail, 'repeat-file', 'the pattern, which ledger.digest phrases');
  assert.equal(notable[0].project, 'ganyu-pet');
});

test('a repeated failure she stays quiet about is not written down either', () => {
  const ledger = fakeLedger();
  const h = harness({ ledger });
  const failed = { source: 'claude', event: 'PostToolUse', sessionId: 's2', toolName: 'Bash', mode: 'failed' };
  const retry = { source: 'claude', event: 'PreToolUse', sessionId: 's2', toolName: 'Bash', mode: 'busy' };

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    h.advance(30_000);
    h.speech.notify(retry);
    h.advance(30_000);
    h.speech.notify(failed);
  }
  // The same 1/3/5 the bubble shows: the streak rule is the salience gate, and
  // the ledger inherits it rather than counting again.
  assert.equal(ledger.entries.length, 3);
  assert.ok(ledger.entries.every((e) => e.kind === 'failed'));
});

test('a line she had no room for is still remembered', () => {
  const ledger = fakeLedger();
  const h = harness({ ledger });
  // Two sessions stop for approval two seconds apart. One bubble — the 6s
  // same-kind floor, which exists so seven sessions hitting one wall is one
  // piece of news — but two approvals are genuinely waiting on him, and the
  // digest is the only place the second can still reach him.
  const first = h.speech.notify({ ...permission, sessionId: 'a' });
  h.advance(2000);
  const second = h.speech.notify({ ...permission, sessionId: 'b' });

  assert.equal(first.spoken, true);
  assert.equal(second.reason, 'throttled', 'the bubble refused it');
  assert.deepEqual(ledger.kinds(), ['waiting', 'waiting'], 'the record did not');
  assert.deepEqual(ledger.entries.map((e) => e.sessionId), ['a', 'b']);
});

test('muted is a quiet evening in the record as well as on screen', () => {
  const ledger = fakeLedger();
  const h = harness({ ledger, muted: () => true });
  assert.equal(h.speech.notify(sessionStart).reason, 'muted');
  assert.equal(h.speech.notify(failure).reason, 'muted');
  assert.deepEqual(ledger.entries, []);
});

test('a ledger that cannot write is not a pet that cannot talk', () => {
  const h = harness({ ledger: fakeLedger({ throws: true }) });
  const res = h.speech.notify(sessionStart);
  assert.equal(res.spoken, true);
  assert.equal(h.lines.length, 1);
});

test('with no ledger she behaves exactly as she did before', () => {
  const h = harness();
  assert.equal(h.speech.notify(sessionStart).spoken, true);
  assert.equal(h.lines.length, 1);
});
