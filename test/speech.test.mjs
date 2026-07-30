// Module D tests — success criterion 6: prompt template, 45s cooldown with 15s
// interrupt floor for waiting/failed, canned fallback when the CLI call fails.
// Everything runs with a mocked exec + injected clock: no Electron, no live CLI.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COOLDOWN_MS,
  INTERRUPT_FLOOR_MS,
  claudeArgs,
  cleanLine,
  createSpeech,
  hasErrorMarker,
  modeForEvent,
  projectName,
  toolClass,
} from '../src/main/speech.mjs';
import {
  FALLBACK_LINES,
  MAX_LINE_CHARS,
  PROMPT_TEMPLATE,
  buildPrompt,
  buildSummary,
  fallbackFor,
  sourceLabel,
} from '../src/main/persona.mjs';

/** Test harness: manual clock, manual timers, scripted exec. */
function harness(opts = {}) {
  const calls = [];
  const lines = [];
  const timers = [];
  let t = 1_000_000; // arbitrary non-zero epoch
  let reply = { err: null, stdout: 'A line from Haiku.' };

  const speech = createSpeech({
    exec: (file, args, options, cb) => {
      calls.push({ file, args, options });
      cb(reply.err, reply.stdout, reply.stderr ?? '');
    },
    clock: { now: () => t },
    onLine: (line) => lines.push(line),
    isMuted: () => Boolean(opts.muted && opts.muted()),
    user: 'Isaac',
    random: () => 0,
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    bin: 'C:\\fake\\claude.exe',
    ...opts.overrides,
  });

  return {
    speech,
    calls,
    lines,
    timers,
    now: () => t,
    advance(ms) {
      t += ms;
    },
    setReply(next) {
      reply = next;
    },
    /** Fire every live timer whose deadline has passed (order preserved). */
    runTimers() {
      const due = timers.filter((x) => !x.cancelled && !x.fired);
      for (const timer of due) {
        timer.fired = true;
        timer.fn();
      }
    },
  };
}

const sessionStart = { source: 'codex', event: 'SessionStart', sessionId: 's1', cwd: 'C:\\dev\\ganyu-pet' };
const bashPre = { source: 'codex', event: 'PreToolUse', sessionId: 's1', toolName: 'Bash', cwd: 'C:\\dev\\ganyu-pet' };
const editPre = { source: 'codex', event: 'PreToolUse', sessionId: 's1', toolName: 'Edit', cwd: 'C:\\dev\\ganyu-pet' };
const stop = { source: 'codex', event: 'Stop', sessionId: 's1', cwd: 'C:\\dev\\ganyu-pet' };
const permission = { source: 'claude', event: 'Notification', sessionId: 's2', toolName: 'Bash', mode: 'waiting' };
const failure = { source: 'claude', event: 'PostToolUse', sessionId: 's2', toolName: 'Bash', mode: 'failed' };

// ---------------------------------------------------------------- prompt template

test('PROMPT_TEMPLATE matches the contract text with both slots', () => {
  assert.equal(
    PROMPT_TEMPLATE,
    "You are Ganyu from Genshin Impact, working as {user}'s diligent secretary. React to this " +
      'coding-agent event in ONE short line (max 90 chars), gentle and dutiful, in English, at ' +
      'most one emoji, occasionally hinting you could use a nap. Event: {summary}. Reply with ' +
      'ONLY the line.',
  );
});

test('buildPrompt substitutes user and summary and leaves no slots behind', () => {
  const prompt = buildPrompt({ user: 'Isaac', summary: 'codex finished a task in ganyu-pet' });
  assert.equal(
    prompt,
    "You are Ganyu from Genshin Impact, working as Isaac's diligent secretary. React to this " +
      'coding-agent event in ONE short line (max 90 chars), gentle and dutiful, in English, at ' +
      'most one emoji, occasionally hinting you could use a nap. Event: codex finished a task in ' +
      'ganyu-pet. Reply with ONLY the line.',
  );
  assert.ok(!prompt.includes('{user}'));
  assert.ok(!prompt.includes('{summary}'));
});

test('buildPrompt treats $-sequences in the summary literally', () => {
  const prompt = buildPrompt({ user: 'Isaac', summary: 'codex ran $& in $`repo`' });
  assert.ok(prompt.includes('Event: codex ran $& in $`repo`.'));
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

test('exec is called with the claude CLI argv, 15s timeout and the built prompt', () => {
  const h = harness();
  const res = h.speech.notify(sessionStart);
  assert.equal(res.dispatched, true);
  assert.equal(res.kind, 'greeting');
  assert.equal(h.calls.length, 1);

  const { file, args, options } = h.calls[0];
  assert.equal(file, 'C:\\fake\\claude.exe');
  assert.equal(args.length, 4);
  assert.equal(args[0], '-p');
  assert.equal(args[2], '--model');
  assert.equal(args[3], 'haiku');
  assert.equal(args[1], buildPrompt({ user: 'Isaac', summary: 'codex started a session in ganyu-pet' }));
  assert.deepEqual(args, claudeArgs(args[1]));
  assert.equal(options.timeout, 15_000);
  assert.equal(options.windowsHide, true);
  assert.equal(h.lines[0].text, 'A line from Haiku.');
  assert.equal(h.lines[0].fallback, false);
});

// ---------------------------------------------------------------- trigger rules

test('SessionStart greets; unknown events and plain idle do not speak', () => {
  const h = harness();
  assert.equal(h.speech.notify(sessionStart).kind, 'greeting');
  h.advance(COOLDOWN_MS);
  assert.equal(h.speech.notify({ source: 'codex', event: 'MysteryEvent', sessionId: 's1' }).reason, 'no-trigger');
  assert.equal(h.speech.notify({ source: 'codex', event: 'PostToolUse', sessionId: 's9', toolName: 'Read' }).reason, 'no-trigger');
  assert.equal(h.calls.length, 1);
});

test('tool-class change during busy speaks; the same class again does not', () => {
  const h = harness();
  h.speech.notify(editPre); // first tool of the session: no previous class, no line
  assert.equal(h.calls.length, 0);
  h.speech.notify({ ...editPre, toolName: 'Write' }); // still the edit class
  assert.equal(h.calls.length, 0);
  const res = h.speech.notify(bashPre); // edit -> shell: a class change
  assert.equal(res.kind, 'busy');
  assert.equal(h.calls.length, 1);
});

test('Stop triggers the celebrate kind', () => {
  const h = harness();
  assert.equal(h.speech.notify(stop).kind, 'celebrate');
  assert.equal(h.calls.length, 1);
});

test('onEvent takes the object shape module A pushes (event + aggregate mode)', () => {
  const h = harness();
  const res = h.speech.onEvent(
    {
      source: 'claude',
      payload: { session_id: 'abc', cwd: 'C:\\dev\\ganyu-pet', hook_event_name: 'Stop' },
      event: 'Stop',
      mode: 'idle',
    },
    { mode: 'idle', celebrate: true },
  );
  assert.equal(res.kind, 'celebrate');
  assert.equal(res.summary, 'Claude Code finished a task in ganyu-pet');
});

test('handleEvent also accepts a single event object', () => {
  const h = harness();
  assert.equal(h.speech.handleEvent({ source: 'codex', event: 'SessionStart', sessionId: 's1' }).kind, 'greeting');
});

test('raw hook payloads normalize through handleEvent', () => {
  const h = harness();
  const res = h.speech.handleEvent('claude', {
    session_id: 'abc',
    cwd: 'C:\\Users\\kw11l\\Desktop\\ganyu-pet',
    hook_event_name: 'Notification',
    tool_name: 'Bash',
  });
  assert.equal(res.kind, 'waiting');
  assert.equal(res.summary, 'Claude Code is waiting for permission to run Bash');
});

// ---------------------------------------------------------------- cooldown

test('global cooldown is 45s: 44.999s is refused, 45s speaks', () => {
  const h = harness();
  h.speech.notify(sessionStart);
  assert.equal(h.calls.length, 1);

  h.advance(COOLDOWN_MS - 1);
  const blocked = h.speech.notify(stop);
  assert.equal(blocked.dispatched, false);
  assert.equal(blocked.reason, 'cooldown');
  assert.equal(blocked.retryInMs, 1);
  assert.equal(h.calls.length, 1);

  h.advance(1);
  h.speech.notify(stop);
  assert.equal(h.calls.length, 2);
  assert.equal(h.lines.length, 2);
});

test('waiting interrupts at 15s but not at 14.999s', () => {
  const h = harness();
  h.speech.notify(sessionStart);
  h.advance(INTERRUPT_FLOOR_MS - 1);
  assert.equal(h.speech.notify(permission).reason, 'cooldown');
  assert.equal(h.calls.length, 1);

  h.advance(1);
  const res = h.speech.notify({ ...permission, sessionId: 's3' });
  assert.equal(res.kind, 'waiting');
  assert.equal(h.calls.length, 2);
});

test('failed interrupts at the 15s floor; busy still waits the full 45s', () => {
  const h = harness();
  h.speech.notify(sessionStart);

  h.advance(20_000); // past the interrupt floor, inside the global cooldown
  h.speech.notify(editPre);
  h.speech.notify(bashPre);
  assert.equal(h.calls.length, 1, 'busy triggers must not interrupt inside 45s');

  assert.equal(h.speech.notify(failure).kind, 'failed');
  assert.equal(h.calls.length, 2);
});

test('queue depth 1: the newest pending trigger replaces the older one', () => {
  const h = harness();
  h.speech.notify(sessionStart);
  assert.equal(h.calls.length, 1);

  h.advance(1000);
  h.speech.notify(editPre);
  h.speech.notify(bashPre); // queued busy
  h.advance(1000);
  h.speech.notify(stop); // replaces it
  assert.equal(h.speech.stats().pendingKind, 'celebrate');
  assert.equal(h.calls.length, 1);

  h.advance(COOLDOWN_MS);
  h.runTimers();
  assert.equal(h.calls.length, 2, 'exactly one queued line is emitted');
  assert.equal(h.lines.length, 2);
  assert.equal(h.lines[1].kind, 'celebrate');
  assert.equal(h.speech.stats().pendingKind, null);
});

test('a queued trigger that is still inside its cooldown re-arms instead of speaking', () => {
  const h = harness();
  h.speech.notify(sessionStart);
  h.advance(1000);
  h.speech.notify(stop); // queued, wake armed for 44s out
  h.runTimers(); // fire the wake early: cooldown not elapsed
  assert.equal(h.calls.length, 1);
  assert.equal(h.speech.stats().pendingKind, 'celebrate');
  assert.equal(h.speech.stats().wakeArmed, true);
});

test('dispose cancels the pending trigger and its timer', () => {
  const h = harness();
  h.speech.notify(sessionStart);
  h.advance(1000);
  h.speech.notify(stop);
  h.speech.dispose();
  h.advance(COOLDOWN_MS);
  h.runTimers();
  assert.equal(h.calls.length, 1);
  assert.equal(h.speech.stats().pendingKind, null);
});

// ---------------------------------------------------------------- fallback

test('every fallback table has >= 6 lines within 90 chars and at most one emoji', () => {
  const kinds = ['greeting', 'busy', 'waiting', 'failed', 'celebrate', 'idle'];
  for (const kind of kinds) {
    const table = FALLBACK_LINES[kind];
    assert.ok(Array.isArray(table), `${kind} table missing`);
    assert.ok(table.length >= 6, `${kind} has only ${table.length} lines`);
    assert.equal(new Set(table).size, table.length, `${kind} has duplicate lines`);
    for (const line of table) {
      assert.ok(line.length > 0 && line.length <= MAX_LINE_CHARS, `too long: ${line}`);
      const emoji = line.match(/\p{Extended_Pictographic}/gu) ?? [];
      assert.ok(emoji.length <= 1, `more than one emoji: ${line}`);
    }
  }
});

test('exec error falls back to a canned line for that kind', () => {
  const h = harness();
  h.setReply({ err: new Error('spawn ENOENT'), stdout: '' });
  h.speech.notify(sessionStart);
  assert.equal(h.lines.length, 1);
  assert.equal(h.lines[0].fallback, true);
  assert.equal(h.lines[0].kind, 'greeting');
  assert.ok(FALLBACK_LINES.greeting.includes(h.lines[0].text));
});

test('timeout kill falls back, and the cooldown still applies afterwards', () => {
  const h = harness();
  const killed = Object.assign(new Error('Command failed: timeout'), { killed: true, signal: 'SIGKILL' });
  h.setReply({ err: killed, stdout: '' });
  h.speech.notify(permission);
  assert.equal(h.lines.length, 1);
  assert.ok(FALLBACK_LINES.waiting.includes(h.lines[0].text));

  h.advance(INTERRUPT_FLOOR_MS - 1);
  assert.equal(h.speech.notify({ ...permission, sessionId: 's4' }).reason, 'cooldown');
  assert.equal(h.calls.length, 1);
});

test('empty or whitespace-only CLI output falls back', () => {
  for (const stdout of ['', '   \n\n  ', undefined]) {
    const h = harness();
    h.setReply({ err: null, stdout });
    h.speech.notify(failure);
    assert.equal(h.lines.length, 1);
    assert.equal(h.lines[0].fallback, true);
    assert.ok(FALLBACK_LINES.failed.includes(h.lines[0].text));
  }
});

test('a throwing exec is caught and falls back', () => {
  const lines = [];
  const speech = createSpeech({
    exec: () => {
      throw new Error('no such file');
    },
    clock: { now: () => 0 },
    onLine: (line) => lines.push(line),
    random: () => 0,
    schedule: () => () => {},
  });
  speech.notify(stop);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].fallback, true);
  assert.ok(FALLBACK_LINES.celebrate.includes(lines[0].text));
});

test('consecutive fallbacks of the same kind avoid repeating the previous line', () => {
  const h = harness();
  h.setReply({ err: new Error('nope'), stdout: '' });
  h.speech.notify(permission);
  h.advance(INTERRUPT_FLOOR_MS);
  h.speech.notify({ ...permission, sessionId: 's5' });
  assert.equal(h.lines.length, 2);
  assert.notEqual(h.lines[0].text, h.lines[1].text);
});

test('fallbackFor is deterministic with an injected random and defaults to idle', () => {
  assert.equal(fallbackFor('waiting', { random: () => 0 }), FALLBACK_LINES.waiting[0]);
  assert.equal(fallbackFor('waiting', { random: () => 0.99 }), FALLBACK_LINES.waiting.at(-1));
  assert.ok(FALLBACK_LINES.idle.includes(fallbackFor('nonsense-kind', { random: () => 0 })));
});

// ---------------------------------------------------------------- mute

test('muted: no exec calls at all and no lines', () => {
  let muted = true;
  const h = harness({ muted: () => muted });
  assert.equal(h.speech.notify(sessionStart).reason, 'muted');
  assert.equal(h.calls.length, 0);
  assert.equal(h.lines.length, 0);
  assert.equal(h.speech.stats().pendingKind, null);

  muted = false;
  h.speech.notify(stop);
  assert.equal(h.calls.length, 1);
});

// ---------------------------------------------------------------- line hygiene

test('cleanLine strips quotes, prefixes and extra lines and clamps to 90 chars', () => {
  assert.equal(cleanLine('"All finished. Well done."'), 'All finished. Well done.');
  assert.equal(cleanLine('Ganyu: I will take note of that.'), 'I will take note of that.');
  assert.equal(cleanLine('\n\n  First line.  \nSecond line.\n'), 'First line.');
  assert.equal(cleanLine('`Done.`'), 'Done.');
  assert.equal(cleanLine('a [note] in brackets'), 'a [note] in brackets');

  const long = `${'word '.repeat(40)}end`;
  const clamped = cleanLine(long);
  assert.ok(clamped.length <= MAX_LINE_CHARS, `length ${clamped.length}`);
  assert.ok(clamped.endsWith('…'));
  assert.equal(cleanLine(null), '');
});

test('long CLI output is clamped before reaching onLine', () => {
  const h = harness();
  h.setReply({ err: null, stdout: 'x'.repeat(300) });
  h.speech.notify(sessionStart);
  assert.ok(h.lines[0].text.length <= MAX_LINE_CHARS);
  assert.equal(h.lines[0].fallback, false);
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

test('hasErrorMarker only scans the response/message fields', () => {
  assert.equal(hasErrorMarker({ tool_response: 'Error: exit code 1' }), true);
  assert.equal(hasErrorMarker({ last_message: 'the build FAILED' }), true);
  assert.equal(hasErrorMarker({ error: true }), true);
  assert.equal(hasErrorMarker({ tool_input: { command: 'grep error src' } }), false);
  assert.equal(hasErrorMarker({ tool_response: 'all good' }), false);
  assert.equal(hasErrorMarker(null), false);
});

test('projectName takes the last segment of either path style', () => {
  assert.equal(projectName('C:\\Users\\kw11l\\Desktop\\ganyu-pet'), 'ganyu-pet');
  assert.equal(projectName('/home/x/ganyu-pet/'), 'ganyu-pet');
  assert.equal(projectName(''), null);
});
