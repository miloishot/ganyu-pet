// Module D (brain) tests — the optional LLM voice. Every request is served by an
// injected `fetchImpl`: nothing here touches the network, and the config used is
// a fake, not the real .env.local.
//
// The contract under test is "never worse than the canned line": every failure
// path — no config, wrong route, rejected key, timeout, garbage body, a second
// concurrent event — must resolve to null so speech.mjs falls back.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_REASONING_EFFORT,
  MAX_BRAIN_LINE_CHARS,
  REQUIRED_KEYS,
  ROUTES,
  createBrain,
  loadBrainConfig,
  parseEnvFile,
  postProcess,
} from '../src/main/brain.mjs';
import { BRAIN_INSTRUCTIONS, buildBrainInput } from '../src/main/persona.mjs';

const CONFIG = Object.freeze({
  enabled: true,
  baseUrl: 'https://endpoint.invalid/api',
  model: 'test-model',
  apiKey: 'sk-test-not-a-real-key',
});

const DETAIL = Object.freeze({
  kind: 'failed',
  event: 'PostToolUse',
  tool: 'Bash',
  project: 'ganyu-pet',
  mode: 'failed',
  source: 'claude',
});
const SUMMARY = 'Claude Code hit an error running Bash in ganyu-pet';

/** Minimal stand-in for a fetch Response. */
function reply(status, body) {
  return { status, json: async () => body };
}
const responsesOk = (text) =>
  reply(200, { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] });
const chatOk = (text) => reply(200, { choices: [{ message: { content: text } }] });

/** fetchImpl that plays a fixed script and records every call. */
function scriptedFetch(...steps) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    return typeof step === 'function' ? step(url, init) : step;
  };
  fetchImpl.calls = calls;
  fetchImpl.urls = () => calls.map((c) => c.url);
  return fetchImpl;
}

/** Collects every line a logger would have printed, for the never-log-secrets check. */
function recorder() {
  const lines = [];
  const push = (m) => lines.push(String(m));
  return { lines, log: push, warn: push, error: push };
}

function tempEnv(t, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ganyu-brain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env.local');
  if (contents !== null) fs.writeFileSync(file, contents, 'utf8');
  return file;
}

const FULL_ENV = [
  '# ganyu brain',
  '',
  'GANYU_OPENAI_BASE_URL = https://endpoint.invalid/api/ ',
  'GANYU_OPENAI_MODEL=test-model',
  'GANYU_OPENAI_API_KEY=sk-test-not-a-real-key',
  '# GANYU_OPENAI_MODEL=commented-out',
  '',
].join('\n');

// ---------------------------------------------------------------- config

test('a missing .env.local disables the brain instead of throwing', (t) => {
  const missing = path.join(path.dirname(tempEnv(t, 'x=1')), 'nope.local');
  const config = loadBrainConfig({ envPath: missing });
  assert.equal(config.enabled, false);
  assert.equal(loadBrainConfig({}).enabled, false, 'no path at all is also just disabled');
});

test('an empty or missing key disables the brain, and the reason names the key', (t) => {
  const empty = loadBrainConfig({ envPath: tempEnv(t, FULL_ENV.replace('sk-test-not-a-real-key', '')) });
  assert.equal(empty.enabled, false);
  assert.match(empty.reason, /GANYU_OPENAI_API_KEY/);

  const noModel = loadBrainConfig({
    envPath: tempEnv(t, 'GANYU_OPENAI_BASE_URL=https://x.invalid\nGANYU_OPENAI_API_KEY=k\n'),
  });
  assert.equal(noModel.enabled, false);
  assert.match(noModel.reason, /GANYU_OPENAI_MODEL/);
  assert.deepEqual([...REQUIRED_KEYS].sort(), [
    'GANYU_OPENAI_API_KEY',
    'GANYU_OPENAI_BASE_URL',
    'GANYU_OPENAI_MODEL',
  ]);
});

test('a full .env.local enables the brain, trimmed and without the trailing slash', (t) => {
  const config = loadBrainConfig({ envPath: tempEnv(t, FULL_ENV) });
  assert.deepEqual(config, {
    enabled: true,
    baseUrl: 'https://endpoint.invalid/api',
    model: 'test-model',
    apiKey: 'sk-test-not-a-real-key',
    reasoningEffort: DEFAULT_REASONING_EFFORT,
  });
  assert.equal(DEFAULT_REASONING_EFFORT, 'low');

  // Optional, and never required: the brain is usable without ever naming it.
  const explicit = loadBrainConfig({
    envPath: tempEnv(t, `${FULL_ENV}GANYU_OPENAI_REASONING_EFFORT=medium\n`),
  });
  assert.equal(explicit.reasoningEffort, 'medium');
  assert.ok(!REQUIRED_KEYS.includes('GANYU_OPENAI_REASONING_EFFORT'));
});

test('parseEnvFile skips blanks and comments and keeps `=` inside a value', () => {
  assert.deepEqual(parseEnvFile('# c\n\nA=1\nB=x=y\n  C  =  z  \n=novalue\n'), {
    A: '1',
    B: 'x=y',
    C: 'z',
  });
});

// ---------------------------------------------------------------- routing

test('a 404 on /v1/responses falls back to chat completions, and is remembered', async () => {
  const fetchImpl = scriptedFetch(reply(404, {}), chatOk('Understood, Kahweng.'));
  const brain = createBrain({ config: CONFIG, fetchImpl });

  assert.equal(await brain.requestLine({ detail: DETAIL, summary: SUMMARY }), 'Understood, Kahweng.');
  assert.deepEqual(fetchImpl.urls(), [
    `${CONFIG.baseUrl}${ROUTES.responses}`,
    `${CONFIG.baseUrl}${ROUTES.chat}`,
  ]);

  assert.equal(await brain.requestLine({ detail: DETAIL, summary: SUMMARY }), 'Understood, Kahweng.');
  assert.equal(fetchImpl.calls.length, 3, 'the second call does not re-probe /v1/responses');
  assert.equal(fetchImpl.urls()[2], `${CONFIG.baseUrl}${ROUTES.chat}`);
  assert.equal(brain.stats().route, 'chat');
});

test('the responses route is used first and its shorthand output_text is read', async () => {
  const fetchImpl = scriptedFetch(reply(200, { output_text: 'The tests pass, Kahweng.' }));
  const brain = createBrain({ config: CONFIG, fetchImpl });
  assert.equal(await brain.requestLine({ detail: DETAIL }), 'The tests pass, Kahweng.');
  assert.deepEqual(fetchImpl.urls(), [`${CONFIG.baseUrl}${ROUTES.responses}`]);
});

test('a 500, an unparseable body and an empty line all resolve to null', async () => {
  const boom = createBrain({ config: CONFIG, fetchImpl: scriptedFetch(reply(500, {})) });
  assert.equal(await boom.requestLine({ detail: DETAIL }), null);

  const garbage = createBrain({
    config: CONFIG,
    fetchImpl: scriptedFetch({ status: 200, json: async () => { throw new Error('not json'); } }),
  });
  assert.equal(await garbage.requestLine({ detail: DETAIL }), null);

  const blank = createBrain({ config: CONFIG, fetchImpl: scriptedFetch(responsesOk('   \n ')) });
  assert.equal(await blank.requestLine({ detail: DETAIL }), null);

  const offline = createBrain({
    config: CONFIG,
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND endpoint.invalid'); },
  });
  assert.equal(await offline.requestLine({ detail: DETAIL }), null);
});

test('a disabled config never fetches', async () => {
  const fetchImpl = scriptedFetch(responsesOk('hello'));
  const brain = createBrain({ config: { enabled: false, reason: 'no .env.local' }, fetchImpl });
  assert.equal(await brain.requestLine({ detail: DETAIL }), null);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(brain.isEnabled(), false);
});

// ---------------------------------------------------------------- failure modes

test('401 disables the brain permanently and says so exactly once', async () => {
  const fetchImpl = scriptedFetch(reply(401, {}));
  const log = recorder();
  const brain = createBrain({ config: CONFIG, fetchImpl, log });

  assert.equal(await brain.requestLine({ detail: DETAIL }), null);
  assert.equal(await brain.requestLine({ detail: DETAIL }), null);
  assert.equal(fetchImpl.calls.length, 1, 'the second call never reaches the network');
  assert.equal(brain.isEnabled(), false);

  const rejected = log.lines.filter((l) => l.includes('endpoint rejected the key'));
  assert.equal(rejected.length, 1);
  assert.match(rejected[0], /falling back to canned lines/);
});

test('nothing ever logs the key or the endpoint', async () => {
  const log = recorder();
  const brain = createBrain({
    config: CONFIG,
    log,
    fetchImpl: async () => { throw new Error(`connect ECONNREFUSED ${CONFIG.baseUrl}`); },
  });
  assert.equal(await brain.requestLine({ detail: DETAIL }), null);

  assert.ok(log.lines.length > 0, 'a failure is still reported');
  for (const line of log.lines) {
    assert.ok(!line.includes(CONFIG.apiKey), `leaked the key: ${line}`);
    assert.ok(!line.includes(CONFIG.baseUrl), `leaked the endpoint: ${line}`);
    assert.ok(!line.includes('ECONNREFUSED'), `leaked the error message: ${line}`);
  }
});

test('a request that never answers is aborted and resolves null', async () => {
  let aborted = false;
  const fetchImpl = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      });
    });

  const brain = createBrain({ config: CONFIG, fetchImpl, timeoutMs: 20 });
  assert.equal(await brain.requestLine({ detail: DETAIL }), null);
  assert.equal(aborted, true);
  assert.equal(brain.stats().inFlight, false, 'the single-flight guard is released');
});

test('only one request is in flight; a second event gets null without a fetch', async () => {
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = scriptedFetch(async () => { await gate; return responsesOk('One moment.'); });
  const brain = createBrain({ config: CONFIG, fetchImpl });

  const first = brain.requestLine({ detail: DETAIL });
  assert.equal(await brain.requestLine({ detail: DETAIL }), null, 'the second call gives up at once');
  assert.equal(fetchImpl.calls.length, 1);

  release();
  assert.equal(await first, 'One moment.');
  assert.equal(brain.stats().inFlight, false);

  // ...and the guard is not sticky: the next event is served normally.
  assert.equal(await brain.requestLine({ detail: DETAIL }), 'One moment.');
  assert.equal(fetchImpl.calls.length, 2);
});

// ---------------------------------------------------------------- post-processing

test('a multi-line reply is collapsed onto one line', async () => {
  const brain = createBrain({
    config: CONFIG,
    fetchImpl: scriptedFetch(responsesOk('  Tests are green.\nShall I write it up?\r\n ')),
  });
  assert.equal(await brain.requestLine({ detail: DETAIL }), 'Tests are green. Shall I write it up?');
});

test('an over-long reply is cut at a word boundary, never mid-word', async () => {
  const long = 'word '.repeat(60).trim(); // 299 chars
  const brain = createBrain({ config: CONFIG, fetchImpl: scriptedFetch(responsesOk(long)) });
  const line = await brain.requestLine({ detail: DETAIL });

  assert.equal(MAX_BRAIN_LINE_CHARS, 140);
  assert.ok(line.length <= MAX_BRAIN_LINE_CHARS, `length ${line.length}`);
  assert.ok(line.endsWith('…'));
  assert.ok(line.slice(0, -1).endsWith('word'), `cut mid-word: ${line}`);
  assert.equal(postProcess(''), null);
  assert.equal(postProcess(null), null);
});

// ---------------------------------------------------------------- the prompt

test('the instructions name Kahweng and carry no honorific', () => {
  assert.ok(BRAIN_INSTRUCTIONS.includes('Kahweng'));
  assert.ok(!/mr/i.test(BRAIN_INSTRUCTIONS), 'no "Mr" anywhere, not even in a prohibition');
  assert.ok(!/\b(sir|madam|master|mister)\b/i.test(BRAIN_INSTRUCTIONS));
  assert.match(BRAIN_INSTRUCTIONS, /Ganyu/);
  assert.match(BRAIN_INSTRUCTIONS, /one short line/);
});

test('the input carries the event kind, the tool and the project', () => {
  const input = buildBrainInput(DETAIL, SUMMARY);
  assert.equal(
    input,
    'Just happened: Claude Code hit an error running Bash in ganyu-pet. (event: failed, tool: Bash, project: ganyu-pet)',
  );
  // With no summary handy it falls back to buildSummary, and drops absent facts.
  assert.equal(
    buildBrainInput({ kind: 'greeting', source: 'codex', event: 'SessionStart' }),
    'Just happened: codex started a session. (event: greeting)',
  );
});

test('the responses request body carries store:false, the model and both prompt halves', async () => {
  const fetchImpl = scriptedFetch(responsesOk('Noted.'));
  const brain = createBrain({ config: CONFIG, fetchImpl });
  await brain.requestLine({ detail: DETAIL, summary: SUMMARY });

  const { body, init } = fetchImpl.calls[0];
  assert.equal(body.store, false, 'the owner disabled response storage');
  assert.equal(body.model, CONFIG.model);
  assert.equal(body.instructions, BRAIN_INSTRUCTIONS);
  assert.equal(body.input, buildBrainInput(DETAIL, SUMMARY));
  assert.ok(Number.isInteger(body.max_output_tokens));
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.authorization, `Bearer ${CONFIG.apiKey}`);
});

test('the responses body asks for low reasoning effort, and the chat body never does', async () => {
  // Measured on the owner's endpoint: `low` answered in 3.0s against 5.5s, and
  // wrote better lines. Chat completions has no such parameter at all.
  const fetchImpl = scriptedFetch(reply(404, {}), chatOk('Noted.'));
  const brain = createBrain({ config: CONFIG, fetchImpl });
  await brain.requestLine({ detail: DETAIL });

  assert.deepEqual(fetchImpl.calls[0].body.reasoning, { effort: 'low' });
  assert.equal(fetchImpl.calls[1].body.reasoning, undefined);
  assert.equal(fetchImpl.calls[1].body.max_output_tokens, undefined);
});

test('the reasoning effort is configurable, and `none` omits the field entirely', async () => {
  const high = scriptedFetch(responsesOk('Noted.'));
  await createBrain({ config: { ...CONFIG, reasoningEffort: 'high' }, fetchImpl: high })
    .requestLine({ detail: DETAIL });
  assert.deepEqual(high.calls[0].body.reasoning, { effort: 'high' });

  // The escape hatch for a model that rejects the parameter.
  const none = scriptedFetch(responsesOk('Noted.'));
  await createBrain({ config: { ...CONFIG, reasoningEffort: 'none' }, fetchImpl: none })
    .requestLine({ detail: DETAIL });
  assert.equal(none.calls[0].body.reasoning, undefined);
  assert.equal(none.calls[0].body.store, false, 'the rest of the body is unchanged');
});

test('injected context is folded into the input, and a broken getter is survivable', async () => {
  const context = {
    time: { hhmm: '22:15', daypart: 'late night', lateNight: true },
    recent: null,
    sessions: { count: 4, projects: [], activeSince: null, activeForMs: null },
  };
  const withContext = scriptedFetch(responsesOk('Noted.'));
  await createBrain({ config: CONFIG, fetchImpl: withContext, getContext: () => context })
    .requestLine({ detail: DETAIL, summary: SUMMARY });

  const sent = withContext.calls[0].body.input;
  assert.equal(sent, buildBrainInput({ ...DETAIL, context }, SUMMARY));
  assert.match(sent, /^Right now: 4 coding sessions are running at once\.$/m);
  assert.match(sent, /^Local time: 22:15, late night\.$/m);

  // A getter that throws costs the briefing, never the line.
  const broken = scriptedFetch(responsesOk('Noted.'));
  const log = recorder();
  const line = await createBrain({
    config: CONFIG,
    fetchImpl: broken,
    log,
    getContext: () => { throw new Error('ring unavailable'); },
  }).requestLine({ detail: DETAIL, summary: SUMMARY });

  assert.equal(line, 'Noted.');
  assert.equal(broken.calls[0].body.input, buildBrainInput(DETAIL, SUMMARY), 'back to the thin input');
  for (const entry of log.lines) assert.ok(!entry.includes('ring unavailable'), entry);
});

test('the chat-completions body carries the same prompt as system + user', async () => {
  const fetchImpl = scriptedFetch(reply(405, {}), chatOk('Noted.'));
  const brain = createBrain({ config: CONFIG, fetchImpl });
  await brain.requestLine({ detail: DETAIL, summary: SUMMARY });

  const { body } = fetchImpl.calls[1];
  assert.deepEqual(body.messages, [
    { role: 'system', content: BRAIN_INSTRUCTIONS },
    { role: 'user', content: buildBrainInput(DETAIL, SUMMARY) },
  ]);
  assert.equal(body.model, CONFIG.model);
  assert.equal(body.store, undefined, 'store is a Responses-API field');
});
