import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createState,
  normalizeEvent,
  hasErrorMarker,
  modeForEvent,
  PRIORITY,
} from '../src/main/state.mjs';

/** Injected clock: `t` is advanced explicitly by each test. */
function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
      return t;
    },
    get value() {
      return t;
    },
  };
}

const claudePayload = (over = {}) => ({
  session_id: 'abc',
  transcript_path: 'C:\\Users\\kw11l\\.claude\\projects\\x.jsonl',
  cwd: 'C:\\Users\\kw11l\\Desktop\\ganyu-pet',
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'npm test' },
  ...over,
});

test('normalizeEvent: sessionId falls back through the documented chain', () => {
  assert.equal(normalizeEvent('claude', { session_id: 'a' }).sessionId, 'a');
  assert.equal(normalizeEvent('codex', { thread_id: 'b' }).sessionId, 'b');
  assert.equal(normalizeEvent('codex', { sessionId: 'c' }).sessionId, 'c');
  assert.equal(normalizeEvent('codex', {}).sessionId, 'codex-unknown');
  assert.equal(normalizeEvent('claude', {}).sessionId, 'claude-unknown');
  assert.equal(normalizeEvent(undefined, null).sessionId, 'unknown-unknown');
});

test('normalizeEvent: event name from hook_event_name / event / type', () => {
  assert.equal(normalizeEvent('claude', { hook_event_name: 'Stop' }).event, 'Stop');
  assert.equal(normalizeEvent('codex', { event: 'PermissionRequest' }).event, 'PermissionRequest');
  assert.equal(normalizeEvent('codex', { type: 'PostToolUse' }).event, 'PostToolUse');
  assert.equal(normalizeEvent('codex', { event: { name: 'SessionStart' } }).event, 'SessionStart');
  assert.equal(normalizeEvent('codex', {}).event, null);
  assert.equal(normalizeEvent('codex', {}).mode, null, 'unknown event => activity ping only');
});

test('modeForEvent: full mapping table from contracts.md', () => {
  for (const ev of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'SessionStart']) {
    assert.equal(modeForEvent(ev.toLowerCase()), 'busy', ev);
  }
  assert.equal(modeForEvent('permissionrequest'), 'waiting');
  assert.equal(modeForEvent('notification'), 'waiting');
  assert.equal(modeForEvent('stop'), 'idle');
  assert.equal(modeForEvent('sessionend'), 'idle');
  assert.equal(modeForEvent('somethingelse'), null);
  // separator-tolerant canonicalization
  assert.equal(normalizeEvent('codex', { event: 'pre_tool_use' }).mode, 'busy');
  assert.equal(normalizeEvent('codex', { event: 'session-start' }).mode, 'busy');
});

test('hasErrorMarker: explicit flags and text scan, no path false-positives', () => {
  assert.equal(hasErrorMarker({ tool_response: { stderr: 'npm ERR! build failed', success: false } }), true);
  assert.equal(hasErrorMarker({ tool_response: { stdout: 'Error: cannot find module' } }), true);
  assert.equal(hasErrorMarker({ last_message: 'that FAILED unfortunately' }), true, 'case-insensitive');
  assert.equal(hasErrorMarker({ error: 'ENOENT' }), true);
  assert.equal(hasErrorMarker({ tool_response: { is_error: true } }), true);
  assert.equal(hasErrorMarker({ exit_code: 2 }), true);
  assert.equal(hasErrorMarker({ status: 'failed' }), true);

  assert.equal(hasErrorMarker({ error: null }), false);
  assert.equal(hasErrorMarker({ tool_response: { is_error: false, success: true } }), false);
  assert.equal(hasErrorMarker({ exit_code: 0 }), false);
  assert.equal(hasErrorMarker(claudePayload()), false);
  assert.equal(
    hasErrorMarker(claudePayload({ cwd: 'C:\\repos\\error-handling', tool_input: { command: 'grep failed *.log' } })),
    false,
    'cwd / tool_input are never scanned',
  );
  assert.equal(hasErrorMarker(null), false);
});

test('per-session modes: busy / waiting / idle+celebrate', () => {
  const clock = fakeClock();
  const state = createState({ clock });

  state.ingest('claude', claudePayload());
  assert.equal(state.aggregate().mode, 'busy');
  assert.equal(state.aggregate().sessionCount, 1);

  clock.advance(1000);
  state.ingest('claude', claudePayload({ hook_event_name: 'PermissionRequest' }));
  assert.equal(state.aggregate().mode, 'waiting');

  clock.advance(1000);
  state.ingest('claude', claudePayload({ hook_event_name: 'Stop', tool_name: undefined }));
  let snap = state.aggregate();
  assert.equal(snap.mode, 'idle');
  assert.equal(snap.celebrate, true, 'Stop sets a transient celebrate flag');
  assert.equal(snap.sessions[0].mode, 'idle');

  clock.advance(9_999);
  assert.equal(state.aggregate().celebrate, true, 'celebrate lasts 10s');
  clock.advance(2);
  snap = state.aggregate();
  assert.equal(snap.celebrate, false);
  assert.equal(snap.mode, 'idle');
});

test('failed is sticky for 30s then falls back to the underlying mode', () => {
  const clock = fakeClock();
  const state = createState({ clock });

  state.ingest('codex', { thread_id: 't1', event: 'PreToolUse', tool_name: 'Bash' });
  assert.equal(state.aggregate().mode, 'busy');

  clock.advance(500);
  state.ingest('codex', {
    thread_id: 't1',
    event: 'PostToolUse',
    tool_name: 'Bash',
    tool_response: { exit_code: 1, stderr: 'tsc: 3 errors' },
  });
  assert.equal(state.aggregate().mode, 'failed');

  clock.advance(29_000);
  assert.equal(state.aggregate().mode, 'failed', 'still sticky at 29.5s');
  clock.advance(1_500);
  assert.equal(state.aggregate().mode, 'busy', 'falls back to the underlying mode (PostToolUse => busy)');
});

test('a failing Stop suppresses celebrate', () => {
  const clock = fakeClock();
  const state = createState({ clock });
  state.ingest('claude', claudePayload({ hook_event_name: 'Stop', last_message: 'the build failed' }));
  const snap = state.aggregate();
  assert.equal(snap.mode, 'failed');
  assert.equal(snap.celebrate, false);
});

test('unknown events are activity pings: mode unchanged, lastSeen refreshed', () => {
  const clock = fakeClock();
  const state = createState({ clock });
  state.ingest('codex', { thread_id: 't1', event: 'PreToolUse' });
  clock.advance(1000);
  state.ingest('codex', { thread_id: 't1', event: 'SomeFutureCodexHook' });
  const snap = state.aggregate();
  assert.equal(snap.mode, 'busy');
  assert.equal(snap.sessions[0].lastSeen, clock.value);
});

test('an error marker on an unknown event still fails the session', () => {
  const state = createState({ clock: fakeClock() });
  state.ingest('codex', { thread_id: 't1', event: 'MysteryHook', result: { success: false } });
  assert.equal(state.aggregate().mode, 'failed');
});

test('aggregate takes the highest-priority mode across live sessions', () => {
  const clock = fakeClock();
  const state = createState({ clock });
  assert.deepEqual(PRIORITY, { idle: 0, busy: 1, waiting: 2, failed: 3 });

  state.ingest('claude', { session_id: 's-idle', hook_event_name: 'SessionEnd' });
  assert.equal(state.aggregate().mode, 'idle');

  state.ingest('claude', { session_id: 's-busy', hook_event_name: 'PreToolUse' });
  assert.equal(state.aggregate().mode, 'busy');

  state.ingest('codex', { thread_id: 's-wait', event: 'PermissionRequest' });
  assert.equal(state.aggregate().mode, 'waiting');

  state.ingest('codex', { thread_id: 's-fail', event: 'PostToolUse', tool_response: { success: false } });
  assert.equal(state.aggregate().mode, 'failed');
  assert.equal(state.aggregate().sessionCount, 4);

  // failed expires -> waiting is next in line
  clock.advance(31_000);
  assert.equal(state.aggregate().mode, 'waiting');
});

test('same session id from different sources stays distinct', () => {
  const state = createState({ clock: fakeClock() });
  state.ingest('codex', { session_id: 'dup', event: 'PreToolUse' });
  state.ingest('claude', { session_id: 'dup', hook_event_name: 'PermissionRequest' });
  const snap = state.aggregate();
  assert.equal(snap.sessionCount, 2);
  assert.deepEqual(snap.sessions.map((s) => s.source).sort(), ['claude', 'codex']);
});

test('sessions expire after 10 minutes; sweep prunes them', () => {
  const clock = fakeClock();
  const state = createState({ clock });
  state.ingest('claude', claudePayload());
  assert.equal(state.aggregate().sessionCount, 1);

  clock.advance(9 * 60 * 1000);
  assert.equal(state.aggregate().sessionCount, 1, 'alive at 9 min');

  clock.advance(61 * 1000);
  const snap = state.aggregate();
  assert.equal(snap.sessionCount, 0, 'expired past 10 min');
  assert.equal(snap.mode, 'idle');
  assert.equal(state.sweep(), 1, 'sweep reports one pruned session');
  assert.equal(state.sweep(), 0);
});

test('onChange fires on real changes only, and unsubscribes', () => {
  const clock = fakeClock();
  const state = createState({ clock });
  const seen = [];
  const off = state.onChange((snapshot, change) => seen.push([snapshot.mode, change?.event ?? null]));

  state.ingest('claude', claudePayload());
  assert.deepEqual(seen, [['busy', 'PreToolUse']]);

  clock.advance(10);
  state.ingest('claude', claudePayload({ tool_name: 'Read' }));
  assert.equal(seen.length, 2, 'lastSeen moved, so the snapshot changed');

  const before = seen.length;
  state.sweep();
  assert.equal(seen.length, before, 'no-op sweep does not emit');

  off();
  clock.advance(10);
  state.ingest('claude', claudePayload({ hook_event_name: 'Stop' }));
  assert.equal(seen.length, before, 'unsubscribed');
});

test('onEvent fires for every ingest, including unknown events', () => {
  const state = createState({ clock: fakeClock() });
  const events = [];
  state.onEvent((ev) => events.push(ev));
  state.ingest('claude', claudePayload());
  state.ingest('claude', claudePayload({ hook_event_name: 'Whatever' }));
  assert.equal(events.length, 2);
  assert.equal(events[0].tool, 'Bash');
  assert.equal(events[0].previousMode, 'idle');
  assert.equal(events[0].sessionMode, 'busy');
  assert.equal(events[1].mode, null);
});

test('a throwing listener does not break ingest', () => {
  const state = createState({ clock: fakeClock(), log: { error() {} } });
  state.onChange(() => {
    throw new Error('boom');
  });
  assert.equal(state.ingest('claude', claudePayload()).mode, 'busy');
  assert.equal(state.aggregate().mode, 'busy');
});

test('setWalk drives the wandering flag and emits', () => {
  const state = createState({ clock: fakeClock() });
  const seen = [];
  state.onChange((s) => seen.push(s.wandering));
  assert.equal(state.aggregate().wandering, false);
  state.setWalk({ dir: 'left' });
  let snap = state.aggregate();
  assert.equal(snap.wandering, true);
  assert.deepEqual(snap.walk, { dir: 'left' });
  state.setWalk({ dir: 'sideways' });
  assert.equal(state.aggregate().wandering, false, 'invalid dir clears the walk');
  state.setWalk(null);
  assert.deepEqual(seen, [true, false]);
});

test('clock may be a function or an object with now()', () => {
  const asFn = createState({ clock: () => 42 });
  asFn.ingest('claude', claudePayload());
  assert.equal(asFn.aggregate().sessions[0].lastSeen, 42);

  const asObj = createState({ clock: { now: () => 99 } });
  asObj.ingest('claude', claudePayload());
  assert.equal(asObj.aggregate().sessions[0].lastSeen, 99);

  const real = createState({});
  real.ingest('claude', claudePayload());
  assert.ok(real.aggregate().sessions[0].lastSeen > 1_600_000_000_000, 'defaults to Date.now()');
});

test('snapshot shape matches the GET /state contract', () => {
  const state = createState({ clock: fakeClock() });
  state.ingest('claude', claudePayload());
  const snap = state.aggregate();
  for (const key of ['mode', 'sessionCount', 'sessions', 'celebrate', 'wandering']) {
    assert.ok(key in snap, `missing ${key}`);
  }
  assert.deepEqual(Object.keys(snap.sessions[0]).sort(), ['id', 'lastSeen', 'mode', 'source']);
  assert.equal(typeof snap.celebrate, 'boolean');
  assert.equal(typeof snap.wandering, 'boolean');
});
