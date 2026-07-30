import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHookServer, parseEventBody, resolvePort } from '../src/main/server.mjs';
import { createState } from '../src/main/state.mjs';

const SERVER_PATH = fileURLToPath(new URL('../src/main/server.mjs', import.meta.url));

function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/** Start an in-process server on an ephemeral port; torn down after the test. */
async function startServer(t, { clock = fakeClock(), state, ...opts } = {}) {
  const hooks = createHookServer({
    state: state ?? createState({ clock }),
    port: 0,
    sweepMs: 0,
    log: { error() {} },
    ...opts,
  });
  const info = await hooks.start();
  t.after(() => hooks.stop());
  return { hooks, base: info.url, info, clock };
}

const postJson = (base, source, payload) => fetch(`${base}/event/${source}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: typeof payload === 'string' ? payload : JSON.stringify(payload),
});

const postForm = (base, source, payload) => fetch(`${base}/event/${source}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
});

const getState = async (base) => (await fetch(`${base}/state`)).json();

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Spawn `node src/main/server.mjs ...` and wait for its listening line. */
function spawnServer(t, args) {
  const child = spawn(process.execPath, [SERVER_PATH, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
  });

  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start in 15s.\n${stdout}\n${stderr}`)), 15_000);
    const check = () => {
      const m = /GANYU_SERVER_LISTENING (\{.*\})/.exec(stdout);
      if (m) {
        clearTimeout(timer);
        resolve(JSON.parse(m[1]));
      }
    };
    child.stdout.on('data', check);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code}).\n${stdout}\n${stderr}`));
    });
    check();
  });

  return { child, listening, exited, out: () => stdout, err: () => stderr };
}

// ---------------------------------------------------------------------------
// success criterion 3 — the standalone end-to-end sequence
// ---------------------------------------------------------------------------

test('criterion 3: standalone server drives busy -> waiting -> idle+celebrate -> failed', { timeout: 30_000 }, async (t) => {
  const port = await freePort();
  const proc = spawnServer(t, ['--standalone', '--port', String(port)]);
  const info = await proc.listening;
  assert.equal(info.port, port, '--port N is honoured');
  assert.equal(info.host, '127.0.0.1', 'binds loopback only');
  assert.equal(info.standalone, true);
  const base = `http://127.0.0.1:${port}`;

  assert.equal(await (await fetch(`${base}/healthz`)).text(), 'ok');

  // codex-shaped PreToolUse -> busy
  const pre = await postJson(base, 'codex', {
    thread_id: 'codex-1',
    event: 'PreToolUse',
    tool_name: 'shell',
    tool_input: { command: 'npm test' },
    cwd: 'C:\\Users\\kw11l\\Desktop\\ganyu-pet',
  });
  assert.equal(pre.status, 200);
  assert.equal((await pre.json()).ok, true);
  let snap = await getState(base);
  assert.equal(snap.mode, 'busy');
  assert.equal(snap.sessionCount, 1);
  assert.equal(snap.sessions[0].id, 'codex-1');
  assert.equal(snap.sessions[0].source, 'codex');

  // PermissionRequest -> waiting
  await postJson(base, 'codex', { thread_id: 'codex-1', event: 'PermissionRequest', tool_name: 'shell' });
  assert.equal((await getState(base)).mode, 'waiting');

  // Stop -> idle + transient celebrate
  await postJson(base, 'codex', { thread_id: 'codex-1', event: 'Stop' });
  snap = await getState(base);
  assert.equal(snap.mode, 'idle');
  assert.equal(snap.celebrate, true);

  // error marker -> failed
  await postJson(base, 'codex', {
    thread_id: 'codex-1',
    event: 'PostToolUse',
    tool_name: 'shell',
    tool_response: { exit_code: 1, stderr: 'npm ERR! Test failed.  See above for more details.' },
  });
  snap = await getState(base);
  assert.equal(snap.mode, 'failed');

  // form-encoded delivery works too (this is what the .cmd hook may send)
  await postForm(base, 'claude', {
    session_id: 'claude-1',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
  });
  snap = await getState(base);
  assert.equal(snap.sessionCount, 2);
  assert.equal(snap.mode, 'failed', 'failed still outranks busy');

  const debug = await (await fetch(`${base}/debug/events`)).json();
  assert.equal(debug.events.length, 5);
  assert.equal(debug.events.at(-1).source, 'claude');
  assert.ok(debug.events.at(-1).raw.tool_name === 'Bash', 'raw payload retained in the ring buffer');
});

test('port already in use: clear error, exit 1', { timeout: 20_000 }, async (t) => {
  const port = await freePort();
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => holder.close(resolve)));

  const child = spawn(process.execPath, [SERVER_PATH, '--standalone', '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr += d; });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 1);
  assert.match(stderr, /already in use/i);
  assert.match(stderr, new RegExp(String(port)));
});

// ---------------------------------------------------------------------------
// HTTP contract
// ---------------------------------------------------------------------------

test('GET /healthz returns 200 ok', async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'ok');
});

test('GET /state matches the documented shape', async (t) => {
  const { base } = await startServer(t);
  const empty = await getState(base);
  assert.deepEqual(
    Object.keys(empty).filter((k) => k !== 'walk').sort(),
    ['celebrate', 'mode', 'sessionCount', 'sessions', 'wandering'],
  );
  assert.equal(empty.mode, 'idle');
  assert.equal(empty.sessionCount, 0);
  assert.deepEqual(empty.sessions, []);
});

test('POST accepts raw JSON and form-encoded payload=<json>', async (t) => {
  const { base } = await startServer(t);
  await postJson(base, 'claude', { session_id: 'raw', hook_event_name: 'PreToolUse' });
  await postForm(base, 'claude', { session_id: 'form', hook_event_name: 'PermissionRequest' });
  const snap = await getState(base);
  assert.equal(snap.sessionCount, 2);
  assert.equal(snap.mode, 'waiting');
});

test('POST accepts a bare event name and an ?event= hint', async (t) => {
  const { base } = await startServer(t);
  const bare = await fetch(`${base}/event/codex`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'PreToolUse',
  });
  assert.equal(bare.status, 200);
  assert.equal((await getState(base)).mode, 'busy');

  await fetch(`${base}/event/codex?event=Stop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thread_id: 'codex-unknown' }),
  });
  const snap = await getState(base);
  assert.equal(snap.mode, 'idle');
  assert.equal(snap.celebrate, true);
});

test('unknown source is 404 and never ingested', async (t) => {
  const { base } = await startServer(t);
  const res = await postJson(base, 'bogus', { session_id: 'x', hook_event_name: 'PreToolUse' });
  assert.equal(res.status, 404);
  assert.equal((await getState(base)).sessionCount, 0);
});

test('unparseable body is 400 and lands in the debug ring', async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(`${base}/event/claude`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json at all',
  });
  assert.equal(res.status, 400);
  const debug = await (await fetch(`${base}/debug/events`)).json();
  assert.equal(debug.events.at(-1).ok, false);
  assert.match(debug.events.at(-1).bodyPreview, /not json/);
  assert.equal((await getState(base)).sessionCount, 0);
});

test('empty body is 400', async (t) => {
  const { base } = await startServer(t);
  const res = await fetch(`${base}/event/claude`, { method: 'POST' });
  assert.equal(res.status, 400);
});

test('oversized body is rejected with 413', async (t) => {
  const { base } = await startServer(t, { maxBodyBytes: 1024 });
  const res = await postJson(base, 'claude', { session_id: 'big', hook_event_name: 'PreToolUse', pad: 'x'.repeat(4096) })
    .catch((err) => err);
  if (res instanceof Error) {
    // Node may surface the destroyed socket as a fetch failure; the point is it did not ingest.
    assert.match(String(res.message), /fetch failed|socket|terminated/i);
  } else {
    assert.equal(res.status, 413);
  }
  assert.equal((await getState(base)).sessionCount, 0);
});

test('wrong methods and unknown routes are rejected', async (t) => {
  const { base } = await startServer(t);
  assert.equal((await fetch(`${base}/event/codex`)).status, 405);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/state`, { method: 'DELETE' })).status, 405);
});

test('GET /debug/events is a 50-entry ring buffer', async (t) => {
  const { base, clock } = await startServer(t);
  for (let i = 0; i < 55; i += 1) {
    clock.advance(1);
    await postJson(base, 'claude', { session_id: `s${i}`, hook_event_name: 'PreToolUse' });
  }
  const debug = await (await fetch(`${base}/debug/events`)).json();
  assert.equal(debug.events.length, 50);
  assert.equal(debug.count, 50);
  assert.equal(debug.events[0].sessionId, 's5', 'oldest entries dropped');
  assert.equal(debug.events.at(-1).sessionId, 's54');
});

test('debug ring truncates very large payloads', async (t) => {
  const { base } = await startServer(t);
  await postJson(base, 'claude', {
    session_id: 'big',
    hook_event_name: 'PreToolUse',
    tool_input: { command: 'x'.repeat(9000) },
  });
  const debug = await (await fetch(`${base}/debug/events`)).json();
  assert.equal(debug.events.at(-1).raw.truncated, true);
  assert.ok(debug.events.at(-1).raw.preview.length <= 4096);
});

test('celebrate and session TTL are visible over HTTP with an injected clock', async (t) => {
  const clock = fakeClock();
  const { base } = await startServer(t, { clock });
  await postJson(base, 'claude', { session_id: 'c1', hook_event_name: 'Stop' });
  assert.equal((await getState(base)).celebrate, true);
  clock.advance(11_000);
  assert.equal((await getState(base)).celebrate, false);
  clock.advance(10 * 60 * 1000);
  const snap = await getState(base);
  assert.equal(snap.sessionCount, 0);
  assert.equal(snap.mode, 'idle');
});

test('server binds 127.0.0.1 only', async (t) => {
  const { hooks } = await startServer(t);
  const addr = hooks.server.address();
  assert.equal(addr.address, '127.0.0.1');
});

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

test('resolvePort: flag > env > default', () => {
  assert.equal(resolvePort([], {}), 47821);
  assert.equal(resolvePort([], { GANYU_PORT: '47900' }), 47900);
  assert.equal(resolvePort(['--standalone', '--port', '47899'], { GANYU_PORT: '47900' }), 47899);
  assert.equal(resolvePort(['--port=47898'], {}), 47898);
  assert.equal(resolvePort(['--port', 'nope'], {}), 47821);
  assert.equal(resolvePort(['--port', '99999'], {}), 47821);
});

test('parseEventBody handles every shape the hook can produce', () => {
  const claude = { session_id: 'a', hook_event_name: 'PreToolUse' };
  assert.deepEqual(parseEventBody(JSON.stringify(claude), 'application/json'), claude);
  assert.deepEqual(
    parseEventBody(new URLSearchParams({ payload: JSON.stringify(claude) }).toString(), 'application/x-www-form-urlencoded'),
    claude,
  );
  // urlencoded without the header
  assert.deepEqual(parseEventBody(`payload=${encodeURIComponent(JSON.stringify(claude))}`, 'text/plain'), claude);
  // double-encoded JSON
  assert.deepEqual(parseEventBody(JSON.stringify(JSON.stringify(claude)), 'application/json'), claude);
  // {"payload":"<json>"} wrapper
  assert.deepEqual(parseEventBody(JSON.stringify({ payload: JSON.stringify(claude) }), 'application/json'), claude);
  // Windows paths whose escaping was lost in transit ("\U" is not a valid JSON escape)
  assert.deepEqual(
    parseEventBody('{"session_id":"a","hook_event_name":"Stop","cwd":"C:\\Users\\kw11l\\Desktop"}', 'application/json'),
    { session_id: 'a', hook_event_name: 'Stop', cwd: 'C:\\Users\\kw11l\\Desktop' },
  );
  // ...without breaking payloads that were escaped correctly
  assert.deepEqual(
    parseEventBody(JSON.stringify({ cwd: 'C:\\Users\\kw11l', note: 'line\nbreak' }), 'application/json'),
    { cwd: 'C:\\Users\\kw11l', note: 'line\nbreak' },
  );
  // bare event names
  assert.deepEqual(parseEventBody('Stop', 'text/plain'), { event: 'Stop' });
  assert.deepEqual(parseEventBody('event=Stop', 'application/x-www-form-urlencoded'), { event: 'Stop' });
  // nothing usable
  assert.equal(parseEventBody('', 'application/json'), null);
  assert.equal(parseEventBody('   ', 'application/json'), null);
  assert.equal(parseEventBody('{"broken":', 'application/json'), null);
  assert.equal(parseEventBody(JSON.stringify([1, 2, 3]), 'application/json'), null);
});
