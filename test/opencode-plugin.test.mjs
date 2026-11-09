// hooks/opencode/ganyu.js under node with a fake fetch: every mapped OpenCode
// event produces the right POST body, unmapped events post nothing, failures
// never escape or stall, and no message text / tool args / tool output leaks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import * as pluginModule from '../hooks/opencode/ganyu.js';
import { createHookServer } from '../src/main/server.mjs';
import { createState } from '../src/main/state.mjs';

const { GanyuPlugin } = pluginModule;
const CTX = { directory: 'C:\\work\\demo', worktree: 'C:\\work', project: { id: 'p1' } };

/** Swap globalThis.fetch for the duration of one test. */
function fakeFetch(t, impl = () => Promise.resolve({ body: null })) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return impl(url, init);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

async function load() {
  return GanyuPlugin(CTX);
}

const ev = (type, properties) => ({ event: { id: 'e1', type, properties } });

test('exports exactly one function (OpenCode calls every export as a plugin)', () => {
  assert.deepEqual(Object.keys(pluginModule), ['GanyuPlugin']);
  assert.equal(typeof GanyuPlugin, 'function');
});

test('posts to /event/opencode on GANYU_PORT, else 47821', async (t) => {
  const calls = fakeFetch(t);
  const hooks = await load();
  const saved = process.env.GANYU_PORT;
  t.after(() => { if (saved === undefined) delete process.env.GANYU_PORT; else process.env.GANYU_PORT = saved; });

  delete process.env.GANYU_PORT;
  hooks['chat.message']({ sessionID: 'ses_1' });
  process.env.GANYU_PORT = '47899';
  hooks['chat.message']({ sessionID: 'ses_1' });
  process.env.GANYU_PORT = 'nonsense';
  hooks['chat.message']({ sessionID: 'ses_1' });

  assert.deepEqual(calls.map((c) => c.url), [
    'http://127.0.0.1:47821/event/opencode',
    'http://127.0.0.1:47899/event/opencode',
    'http://127.0.0.1:47821/event/opencode',
  ]);
  assert.equal(calls[0].init.method, 'POST');
  assert.ok(calls[0].init.signal, 'every POST carries an abort signal');
});

test('every mapped event produces the right body', async (t) => {
  const calls = fakeFetch(t);
  const hooks = await load();
  const cwd = CTX.directory;

  const cases = [
    [() => hooks['tool.execute.before']({ tool: 'bash', sessionID: 's1', callID: 'c1' }, { args: {} }),
      { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'bash', cwd }],
    [() => hooks['chat.message']({ sessionID: 's1', agent: 'build', messageID: 'm1' }, { message: {}, parts: [] }),
      { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd }],
    [() => hooks.event(ev('session.created', { sessionID: 's1', info: { id: 's1' } })),
      { hook_event_name: 'SessionStart', session_id: 's1', cwd }],
    [() => hooks.event(ev('message.part.updated', { sessionID: 's1', part: { type: 'tool', tool: 'edit', callID: 'c1', state: { status: 'completed' } } })),
      { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'edit', cwd }],
    [() => hooks.event(ev('message.part.updated', { sessionID: 's1', part: { type: 'tool', tool: 'bash', callID: 'c2', state: { status: 'error' } } })),
      { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'bash', cwd }],
    [() => hooks.event(ev('permission.asked', { id: 'p1', sessionID: 's1', permission: 'bash', patterns: ['rm *'] })),
      { hook_event_name: 'PermissionRequest', session_id: 's1', tool_name: 'bash', cwd }],
    [() => hooks.event(ev('question.asked', { id: 'q1', sessionID: 's1', questions: [{ question: 'secret?' }] })),
      { hook_event_name: 'PermissionRequest', session_id: 's1', cwd }],
    [() => hooks.event(ev('permission.replied', { sessionID: 's1', requestID: 'p1', reply: 'once' })),
      { hook_event_name: 'PostToolUse', session_id: 's1', cwd }],
    [() => hooks.event(ev('question.replied', { sessionID: 's1', requestID: 'q1' })),
      { hook_event_name: 'PostToolUse', session_id: 's1', cwd }],
    [() => hooks.event(ev('question.rejected', { sessionID: 's1', requestID: 'q1' })),
      { hook_event_name: 'PostToolUse', session_id: 's1', cwd }],
    [() => hooks.event(ev('session.idle', { sessionID: 's1' })),
      { hook_event_name: 'Stop', session_id: 's1', cwd }],
    [() => hooks.event(ev('session.error', { sessionID: 's1', error: { name: 'APIError', data: { message: 'quota for key sk-123' } } })),
      { hook_event_name: 'Stop', session_id: 's1', cwd, error: 'APIError' }],
    [() => hooks.event(ev('session.deleted', { sessionID: 's1', info: { id: 's1' } })),
      { hook_event_name: 'SessionEnd', session_id: 's1', cwd }],
  ];
  for (const [fire, expected] of cases) {
    const before = calls.length;
    fire();
    assert.equal(calls.length, before + 1, `no POST for ${expected.hook_event_name}`);
    assert.deepEqual(calls.at(-1).body, expected);
  }
});

test('unmapped events post nothing', async (t) => {
  const calls = fakeFetch(t);
  const hooks = await load();
  hooks.event(ev('session.status', { sessionID: 's1', status: { type: 'idle' } }));
  hooks.event(ev('session.updated', { sessionID: 's1', info: { id: 's1' } }));
  hooks.event(ev('message.updated', { sessionID: 's1', info: { role: 'assistant' } }));
  hooks.event(ev('message.part.updated', { sessionID: 's1', part: { type: 'text', text: 'hello' } }));
  hooks.event(ev('message.part.updated', { sessionID: 's1', part: { type: 'tool', tool: 'bash', state: { status: 'running' } } }));
  hooks.event(ev('session.error', { sessionID: 's1', error: { name: 'MessageAbortedError' } }));
  hooks.event(ev('file.edited', { file: 'a.txt' }));
  hooks.event(ev('session.idle', {}));
  hooks.event(undefined);
  hooks.event({});
  hooks['tool.execute.before']({ tool: 'bash' });
  assert.equal(calls.length, 0);
});

test('a subagent session reports under its parent and never celebrates', async (t) => {
  const calls = fakeFetch(t);
  const hooks = await load();
  hooks.event(ev('session.created', { sessionID: 'child', info: { id: 'child', parentID: 'root' } }));
  hooks['tool.execute.before']({ tool: 'read', sessionID: 'child', callID: 'c1' });
  hooks.event(ev('session.idle', { sessionID: 'child' }));
  assert.deepEqual(calls.map((c) => [c.body.hook_event_name, c.body.session_id]), [
    ['SubagentStart', 'root'],
    ['PreToolUse', 'root'],
    ['SubagentStop', 'root'],
  ]);
});

test('privacy: message text, tool args and tool output never reach the body', async (t) => {
  const calls = fakeFetch(t);
  const hooks = await load();
  const SECRET = 'TOP-SECRET-PAYLOAD';
  hooks['chat.message']({ sessionID: 's1', agent: SECRET }, { message: { content: SECRET }, parts: [{ type: 'text', text: SECRET }] });
  hooks['tool.execute.before']({ tool: 'bash', sessionID: 's1', callID: SECRET }, { args: { command: `echo ${SECRET}` } });
  hooks.event(ev('message.part.updated', {
    sessionID: 's1',
    part: { type: 'tool', tool: 'bash', callID: 'c', state: { status: 'completed', input: { command: SECRET }, output: SECRET, title: SECRET } },
  }));
  hooks.event(ev('permission.asked', { sessionID: 's1', permission: 'bash', patterns: [SECRET], metadata: { command: SECRET } }));
  hooks.event(ev('session.error', { sessionID: 's1', error: { name: 'APIError', data: { message: SECRET } } }));
  // A free-text "error name" is dropped rather than forwarded.
  hooks.event(ev('session.error', { sessionID: 's1', error: { name: `${SECRET} with spaces & symbols!` } }));
  assert.equal(calls.length, 6);
  for (const { init, body } of calls) {
    assert.ok(!init.body.includes(SECRET), `leak in ${init.body}`);
    for (const key of Object.keys(body)) {
      assert.ok(['hook_event_name', 'session_id', 'tool_name', 'cwd', 'error'].includes(key), `unexpected field ${key}`);
    }
  }
  assert.equal(calls.at(-1).body.error, 'UnknownError');
});

test('failure: fetch throws, rejects or hangs -> hooks return at once and throw nothing', async (t) => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  const signals = [];
  const behaviours = [
    () => { throw new Error('sync boom'); },
    () => Promise.reject(new Error('ECONNREFUSED')),
    (_url, init) => { signals.push(init.signal); return new Promise(() => {}); },
  ];
  for (const impl of behaviours) {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      const hooks = await load();
      const started = Date.now();
      const results = [
        hooks['tool.execute.before']({ tool: 'bash', sessionID: 's1' }, { args: {} }),
        hooks['chat.message']({ sessionID: 's1' }, {}),
        hooks.event(ev('session.idle', { sessionID: 's1' })),
      ];
      await Promise.all(results);
      assert.ok(Date.now() - started < 100, 'a hook waited on the network');
    } finally {
      globalThis.fetch = original;
    }
  }
  // fetch missing entirely.
  const original = globalThis.fetch;
  globalThis.fetch = undefined;
  try {
    const hooks = await load();
    assert.doesNotThrow(() => hooks['chat.message']({ sessionID: 's1' }));
  } finally {
    globalThis.fetch = original;
  }

  // The hung request is aborted by its own signal within 1.5s.
  assert.equal(signals.length, 3);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.ok(signals.every((s) => s.aborted), 'hung POST was never aborted');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
});

test('server down: real fetch to a closed port settles quietly', async (t) => {
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));

  const saved = process.env.GANYU_PORT;
  process.env.GANYU_PORT = String(port);
  t.after(() => { if (saved === undefined) delete process.env.GANYU_PORT; else process.env.GANYU_PORT = saved; });
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  const hooks = await load();
  assert.doesNotThrow(() => hooks.event(ev('session.idle', { sessionID: 's1' })));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(unhandled, []);
});

test('end to end: plugin -> real hook server -> busy, waiting, idle + celebrate', async (t) => {
  const state = createState();
  const server = createHookServer({ state, port: 0, sweepMs: 0, log: { error() {} } });
  const info = await server.start();
  t.after(() => server.stop());
  const saved = process.env.GANYU_PORT;
  process.env.GANYU_PORT = String(new URL(info.url).port);
  t.after(() => { if (saved === undefined) delete process.env.GANYU_PORT; else process.env.GANYU_PORT = saved; });

  const hooks = await load();
  const snap = async () => (await fetch(`${info.url}/state`)).json();
  const settle = async (want) => {
    for (let i = 0; i < 50; i++) {
      const s = await snap();
      if (s.mode === want) return s;
      await new Promise((r) => setTimeout(r, 20));
    }
    return snap();
  };

  hooks['tool.execute.before']({ tool: 'bash', sessionID: 'ses_e2e' });
  let s = await settle('busy');
  assert.equal(s.mode, 'busy');
  assert.deepEqual(s.sessions.map((x) => [x.source, x.id]), [['opencode', 'ses_e2e']]);

  hooks.event(ev('permission.asked', { sessionID: 'ses_e2e', permission: 'bash' }));
  assert.equal((await settle('waiting')).mode, 'waiting');

  hooks.event(ev('session.idle', { sessionID: 'ses_e2e' }));
  s = await settle('idle');
  assert.equal(s.mode, 'idle');
  assert.equal(s.celebrate, true);
});
