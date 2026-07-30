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
  MAX_CHAT_LINE_CHARS,
  REQUIRED_KEYS,
  ROUTES,
  createBrain,
  loadBrainConfig,
  parseEnvFile,
  postProcess,
} from '../src/main/brain.mjs';
import { buildContext } from '../src/main/context.mjs';
import {
  BRAIN_INSTRUCTIONS,
  BRAIN_LINE_TARGET_CHARS,
  CHAT_INSTRUCTIONS,
  CHAT_LINE_TARGET_CHARS,
  OWNER_NAME,
  VOICE_EXAMPLES,
  buildBrainInput,
  buildChatInput,
} from '../src/main/persona.mjs';

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

// ============================================================ chat replies
//
// `requestChat({text, history})` is the seam chat.mjs calls. The transport is
// the ambient path's, unchanged and shared; what differs is the prompt, the
// length she is allowed, and the latch.

const HISTORY = Object.freeze([
  { role: 'owner', text: 'what are you working on?', at: 1000 },
  { role: 'ganyu', text: 'Watching the edits go past.', at: 1000 },
]);

// ---------------------------------------------------------------- the prompt

test('the chat prompt is the ambient prompt verbatim, examples and all', () => {
  // The whole reason CHAT_INSTRUCTIONS is a concatenation rather than a second
  // prompt: VOICE_EXAMPLES is what holds the register, and a chat prompt without
  // it drifts straight back to the corporate assistant they exist to prevent.
  assert.ok(CHAT_INSTRUCTIONS.startsWith(BRAIN_INSTRUCTIONS), 'not a paraphrase — the same text');
  for (const [situation, line] of VOICE_EXAMPLES) {
    assert.ok(CHAT_INSTRUCTIONS.includes(line), `voice example missing (${situation}): ${line}`);
  }
  assert.ok(CHAT_INSTRUCTIONS.includes(OWNER_NAME));
  assert.ok(!/mr/i.test(CHAT_INSTRUCTIONS), 'no "Mr" anywhere, not even in a prohibition');
  assert.ok(!/\b(sir|madam|master|mister)\b/i.test(CHAT_INSTRUCTIONS));
});

test('the chat prompt names the two rules it overrides, and only those two', () => {
  const added = CHAT_INSTRUCTIONS.slice(BRAIN_INSTRUCTIONS.length);
  assert.match(added, /spoken to you directly/);
  assert.match(added, /answer what he actually said/i);
  assert.match(added, /two of the rules above change/i, 'says it is an override, not a second opinion');

  // The ambient prompt's "exactly one short line, under 110" has to be replaced
  // by name, or the model is left holding two contradictory length rules.
  assert.ok(BRAIN_INSTRUCTIONS.includes(String(BRAIN_LINE_TARGET_CHARS)));
  assert.ok(added.includes(String(CHAT_LINE_TARGET_CHARS)));
  assert.match(added, /instead of exactly one line/i);
  assert.ok(CHAT_LINE_TARGET_CHARS > BRAIN_LINE_TARGET_CHARS, 'a chat reply gets more room');
});

// ---------------------------------------------------------------- the input

test('buildChatInput renders the conversation oldest first, then his message', () => {
  assert.deepEqual(buildChatInput({ text: 'and now?', history: HISTORY }).split('\n'), [
    'Earlier in this conversation:',
    'Kahweng: what are you working on?',
    'You: Watching the edits go past.',
    '',
    'Kahweng says to you: and now?',
  ]);

  // A first message has no conversation and, with no context, nothing else.
  assert.equal(buildChatInput({ text: 'hello' }), 'Kahweng says to you: hello');
  assert.equal(buildChatInput({}), 'Kahweng says to you: ');
});

test('buildChatInput collapses newlines and drops entries with nothing in them', () => {
  const input = buildChatInput({
    text: '  what\n\nbroke?  ',
    history: [
      { role: 'owner', text: '  hello\nthere ', at: 1 },
      { role: 'ganyu', text: '   ', at: 2 },
      { role: 'ganyu', text: null, at: 3 },
      'not an entry',
    ],
  });
  assert.deepEqual(input.split('\n'), [
    'Earlier in this conversation:',
    'Kahweng: hello there',
    '',
    'Kahweng says to you: what broke?',
  ]);
  assert.equal(buildChatInput({ text: 'hi', history: 'not an array' }), 'Kahweng says to you: hi');
});

test('the chat briefing carries the activity, so "what broke" has facts to answer from', async () => {
  const context = {
    time: { hhmm: '22:15', daypart: 'late night', lateNight: true },
    recent: null,
    sessions: { count: 4, projects: ['ganyu-pet'], activeSince: null, activeForMs: null },
  };
  const fetchImpl = scriptedFetch(responsesOk('Bash stumbled, but it cleared.'));
  const brain = createBrain({ config: CONFIG, fetchImpl, getContext: () => context });

  assert.equal(await brain.requestChat({ text: 'what broke?' }), 'Bash stumbled, but it cleared.');
  const input = fetchImpl.calls[0].body.input;
  assert.equal(input, buildChatInput({ text: 'what broke?', history: [], context }));
  assert.match(input, /^Around him right now:$/m);
  assert.match(input, /^Right now: 4 coding sessions are running at once\.$/m);
  assert.match(input, /^Local time: 22:15, late night\.$/m);
  assert.match(input, /^Kahweng says to you: what broke\?$/m);
});

test('the clock is not rate-limited out of a chat briefing — he asked', async () => {
  // decideMentions exists because a fact in *every* ambient prompt reads as the
  // point of the prompt. A question is the opposite case: "how long have I been
  // at this" cannot be answered from a briefing that suppressed the clock.
  const context = {
    time: { hhmm: '01:40', daypart: 'late night', lateNight: true },
    recent: null,
    sessions: { count: 5, projects: [], activeSince: null, activeForMs: 5 * 60 * 60 * 1000 },
  };
  const fetchImpl = scriptedFetch(responsesOk('Nearly two, and still going.'));
  const brain = createBrain({ config: CONFIG, fetchImpl, getContext: () => context });

  await brain.requestChat({ text: 'what time is it?' });
  await brain.requestChat({ text: 'and how long have I been at this?' });

  assert.equal(fetchImpl.calls.length, 2);
  for (const call of fetchImpl.calls) {
    assert.match(call.body.input, /^Local time: 01:40, late night\. He has been working for about 5 hours\.$/m);
    assert.match(call.body.input, /^Right now: 5 coding sessions are running at once\.$/m);
  }
});

// ---------------------------------------------------------------- length

test('a chat reply is not clamped to the ambient line limit', async () => {
  assert.equal(MAX_BRAIN_LINE_CHARS, 140);
  assert.equal(MAX_CHAT_LINE_CHARS, 240);

  // Two sentences of the length the chat prompt asks for: must survive whole.
  const answer = 'The tests are green again. '.repeat(7).trim();
  assert.ok(answer.length > MAX_BRAIN_LINE_CHARS, `${answer.length} chars — the ambient clamp would cut it`);
  assert.ok(answer.length <= CHAT_LINE_TARGET_CHARS, 'and it is within what the chat prompt asks for');

  const chatFetch = scriptedFetch(responsesOk(answer));
  assert.equal(
    await createBrain({ config: CONFIG, fetchImpl: chatFetch }).requestChat({ text: 'how did it go?' }),
    answer,
    'nothing cut',
  );

  // The same text on the ambient path is still cut, so the two limits are real
  // and separate rather than one limit that quietly got looser for everyone.
  const ambientFetch = scriptedFetch(responsesOk(answer));
  const line = await createBrain({ config: CONFIG, fetchImpl: ambientFetch }).requestLine({ detail: DETAIL });
  assert.ok(line.length <= MAX_BRAIN_LINE_CHARS, `ambient length ${line.length}`);
  assert.ok(line.endsWith('…'));
});

test('the chat backstop still cuts a runaway reply, at a word boundary', async () => {
  const runaway = 'word '.repeat(120).trim(); // 599 chars
  const fetchImpl = scriptedFetch(responsesOk(runaway));
  const replyText = await createBrain({ config: CONFIG, fetchImpl }).requestChat({ text: 'tell me everything' });

  assert.ok(replyText.length <= MAX_CHAT_LINE_CHARS, `length ${replyText.length}`);
  assert.ok(replyText.length > MAX_BRAIN_LINE_CHARS, 'and it used the chat allowance, not the ambient one');
  assert.ok(replyText.endsWith('…'));
  assert.ok(replyText.slice(0, -1).endsWith('word'), `cut mid-word: ${replyText}`);
  assert.equal(postProcess('', MAX_CHAT_LINE_CHARS), null);
});

// ---------------------------------------------------------------- transport

test('the chat path follows the same transport rules as the ambient one', async () => {
  const fetchImpl = scriptedFetch(reply(404, {}), chatOk('Of course.'));
  const brain = createBrain({ config: CONFIG, fetchImpl });

  assert.equal(await brain.requestChat({ text: 'busy?' }), 'Of course.');
  assert.deepEqual(fetchImpl.urls(), [
    `${CONFIG.baseUrl}${ROUTES.responses}`,
    `${CONFIG.baseUrl}${ROUTES.chat}`,
  ], 'responses first, chat completions as the fallback');
  assert.equal(brain.stats().route, 'chat', 'and the working route is remembered');

  const responsesBody = fetchImpl.calls[0].body;
  assert.equal(responsesBody.store, false, 'the owner disabled response storage');
  assert.equal(responsesBody.model, CONFIG.model);
  assert.equal(responsesBody.instructions, CHAT_INSTRUCTIONS);
  assert.deepEqual(responsesBody.reasoning, { effort: DEFAULT_REASONING_EFFORT });
  assert.ok(Number.isInteger(responsesBody.max_output_tokens));
  assert.equal(fetchImpl.calls[0].init.headers.authorization, `Bearer ${CONFIG.apiKey}`);

  assert.deepEqual(fetchImpl.calls[1].body.messages, [
    { role: 'system', content: CHAT_INSTRUCTIONS },
    { role: 'user', content: buildChatInput({ text: 'busy?' }) },
  ]);
  assert.equal(fetchImpl.calls[1].body.reasoning, undefined, 'never on the chat-completions route');
});

test('every chat failure resolves null and releases the latch', async () => {
  for (const [label, step] of Object.entries({
    'a 500': reply(500, {}),
    'an unparseable body': { status: 200, json: async () => { throw new Error('not json'); } },
    'a blank reply': responsesOk('   \n '),
  })) {
    const brain = createBrain({ config: CONFIG, fetchImpl: scriptedFetch(step) });
    assert.equal(await brain.requestChat({ text: 'hello?' }), null, label);
    assert.deepEqual(brain.stats().pending, { ambient: false, chat: false }, label);
  }

  const offline = createBrain({
    config: CONFIG,
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND endpoint.invalid'); },
  });
  assert.equal(await offline.requestChat({ text: 'hello?' }), null);
  assert.equal(offline.stats().pending.chat, false);
});

test('a chat request that never answers is aborted and resolves null', async () => {
  let aborted = false;
  const fetchImpl = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      });
    });

  const brain = createBrain({ config: CONFIG, fetchImpl, timeoutMs: 20 });
  assert.equal(await brain.requestChat({ text: 'anyone home?' }), null);
  assert.equal(aborted, true, 'the same 10s-style AbortController timeout applies');
  assert.equal(brain.stats().pending.chat, false, 'and the latch is not wedged');
});

test('401 on a chat request disables the brain for the ambient path too', async () => {
  const fetchImpl = scriptedFetch(reply(401, {}));
  const log = recorder();
  const brain = createBrain({ config: CONFIG, fetchImpl, log });

  assert.equal(await brain.requestChat({ text: 'hello' }), null);
  assert.equal(brain.isEnabled(), false);
  assert.equal(await brain.requestChat({ text: 'still there?' }), null);
  assert.equal(await brain.requestLine({ detail: DETAIL }), null);
  assert.equal(fetchImpl.calls.length, 1, 'nothing after the rejection reaches the network');

  const rejected = log.lines.filter((l) => l.includes('endpoint rejected the key'));
  assert.equal(rejected.length, 1, 'one log line, from whichever path hit it first');
  for (const entry of log.lines) assert.ok(!entry.includes(CONFIG.apiKey), entry);
});

test('a disabled brain and an empty message both answer null without fetching', async () => {
  const off = scriptedFetch(responsesOk('hello'));
  assert.equal(
    await createBrain({ config: { enabled: false, reason: 'no .env.local' }, fetchImpl: off })
      .requestChat({ text: 'hello?' }),
    null,
  );
  assert.equal(off.calls.length, 0);

  // chat.mjs already refuses blank input; this is the same promise kept here, so
  // an empty message can never spend a request.
  const blank = scriptedFetch(responsesOk('hello'));
  const brain = createBrain({ config: CONFIG, fetchImpl: blank });
  for (const text of ['', '   ', '\n\t ', null, undefined]) {
    assert.equal(await brain.requestChat({ text }), null, JSON.stringify(text));
  }
  assert.equal(await brain.requestChat(), null, 'no argument at all');
  assert.equal(blank.calls.length, 0);
});

// ------------------------------------------------- chat vs ambient single-flight

test('a chat message is not dropped because an ambient request is in flight', async () => {
  // The defect this guards: a hook event landing a few milliseconds before he
  // presses Enter used to swallow his message on the shared latch, and he would
  // watch the pending bubble resolve to nothing for no reason he could see.
  let releaseAmbient = null;
  const held = new Promise((resolve) => { releaseAmbient = resolve; });
  const fetchImpl = scriptedFetch(async (_url, init) => {
    if (JSON.parse(init.body).instructions === CHAT_INSTRUCTIONS) return responsesOk('Still here.');
    await held;
    return responsesOk('Running the tests…');
  });
  const brain = createBrain({ config: CONFIG, fetchImpl });

  const ambient = brain.requestLine({ detail: DETAIL, summary: SUMMARY });
  assert.deepEqual(brain.stats().pending, { ambient: true, chat: false });

  assert.equal(await brain.requestChat({ text: 'what broke?' }), 'Still here.');
  assert.equal(fetchImpl.calls.length, 2, 'his message reached the endpoint anyway');

  releaseAmbient();
  assert.equal(await ambient, 'Running the tests…', 'and the ambient line still lands');
  assert.deepEqual(brain.stats().pending, { ambient: false, chat: false });
  assert.equal(brain.stats().inFlight, false);
});

test('an ambient line is not dropped because he is mid-conversation', async () => {
  let releaseChat = null;
  const held = new Promise((resolve) => { releaseChat = resolve; });
  const fetchImpl = scriptedFetch(async (_url, init) => {
    if (JSON.parse(init.body).instructions === CHAT_INSTRUCTIONS) {
      await held;
      return responsesOk('One moment.');
    }
    return responsesOk('That step failed.');
  });
  const brain = createBrain({ config: CONFIG, fetchImpl });

  const chatting = brain.requestChat({ text: 'how are the tests?' });
  assert.deepEqual(brain.stats().pending, { ambient: false, chat: true });
  assert.equal(brain.stats().inFlight, true, 'the boolean still means "anything in flight"');

  assert.equal(await brain.requestLine({ detail: DETAIL, summary: SUMMARY }), 'That step failed.');

  releaseChat();
  assert.equal(await chatting, 'One moment.');
});

test('within a kind the single-flight guard still holds', async () => {
  const gates = { chat: null, ambient: null };
  const fetchImpl = scriptedFetch((_url, init) => (
    JSON.parse(init.body).instructions === CHAT_INSTRUCTIONS
      ? new Promise((resolve) => { gates.chat = () => resolve(responsesOk('Here.')); })
      : new Promise((resolve) => { gates.ambient = () => resolve(responsesOk('Working.')); })
  ));
  const brain = createBrain({ config: CONFIG, fetchImpl });

  const firstChat = brain.requestChat({ text: 'one' });
  assert.equal(await brain.requestChat({ text: 'two' }), null, 'a second chat gives up at once');

  const firstAmbient = brain.requestLine({ detail: DETAIL });
  assert.equal(await brain.requestLine({ detail: DETAIL }), null, 'and a second ambient event too');
  assert.equal(fetchImpl.calls.length, 2, 'one request per kind, not four');

  gates.chat();
  gates.ambient();
  assert.equal(await firstChat, 'Here.');
  assert.equal(await firstAmbient, 'Working.');
  assert.deepEqual(brain.stats().pending, { ambient: false, chat: false }, 'neither latch is sticky');
});

// ---------------------------------------------------------------- privacy

const SECRETS = Object.freeze({
  file_path: 'C:\\repo\\src\\auth.ts',
  old_string: 'const OLD_PASSWORD = "hunter2";',
  new_string: 'const NEW_PASSWORD = "correct-horse-battery";',
  content: 'the entire contents of the file he is writing',
  prompt: 'what the owner actually typed into his agent',
  command: 'npm test',
});

const LEAKS = ['hunter2', 'correct-horse', 'OLD_PASSWORD', 'NEW_PASSWORD',
  'entire contents', 'actually typed'];

test('a chat request can carry no more of his machine than an ambient one', async () => {
  const at = Date.now();
  const ring = Array.from({ length: 4 }, (_, i) => ({
    at: at - (5 - i) * 60_000,
    source: 'claude',
    sessionId: 's1',
    event: 'PreToolUse',
    mode: 'busy',
    raw: {
      session_id: 's1',
      cwd: 'C:\\repo',
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: SECRETS,
    },
  }));

  const fetchImpl = scriptedFetch(responsesOk('It was the auth file.'));
  await createBrain({
    config: CONFIG,
    fetchImpl,
    getContext: () => buildContext({ ring, state: null, now: at }),
  }).requestChat({
    text: 'what broke?',
    history: [{ role: 'owner', text: 'anything wrong?', at }],
  });

  // The whole serialized request, not just the input — a leak anywhere in it counts.
  const sent = fetchImpl.calls[0].init.body;
  for (const secret of LEAKS) {
    assert.ok(!sent.includes(secret), `the chat request leaked ${secret}`);
  }
  assert.ok(sent.includes('auth.ts'), 'the file *name* is still sayable — that is what the allowlist is for');

  // And there is no channel for it either: requestChat reads `text` and
  // `history` and nothing else, so a caller cannot hand it a payload to render.
  const smuggled = scriptedFetch(responsesOk('ok'));
  await createBrain({ config: CONFIG, fetchImpl: smuggled }).requestChat({
    text: 'hello',
    history: [],
    detail: { toolInput: SECRETS },
    context: SECRETS,
    summary: SECRETS.content,
  });
  for (const secret of LEAKS) {
    assert.ok(!smuggled.calls[0].init.body.includes(secret), `an extra argument reached the prompt: ${secret}`);
  }
});

// ---------------------------------------------------------------- her memory
//
// Two digests, read on the chat path only: the ledger's (what she saw and wrote
// down — ledger.mjs) and the vault's (what he wrote down, and what he left open
// — vault.mjs). They are what turn "what broke earlier?" from a question she
// can only guess at into one she can answer, and they are deliberately absent
// from the ambient path — see persona.buildChatInput for why.

const MEMORY = Object.freeze({
  ledger: 'You remember, going back about 2 hours: 2 failures (running `npm test`), '
    + 'the last about 40 minutes ago; one approval you waited on, about an hour ago.\n'
    + 'Projects: ganyu-pet, GolfCRM.',
  vault: 'Your notes for GolfCRM — "Bay codes — the timezone fix" (2026-07-29).\n'
    + 'Still open there: The DST edge case at 02:00; Rotate the CI secret.',
});

test('what she remembers reaches a chat reply', async () => {
  const fetchImpl = scriptedFetch(responsesOk('Twice, both on the test run.'));
  const brain = createBrain({ config: CONFIG, fetchImpl, getMemory: () => MEMORY });

  assert.equal(await brain.requestChat({ text: 'what broke earlier?' }), 'Twice, both on the test run.');
  const input = fetchImpl.calls[0].body.input;
  assert.ok(input.includes(MEMORY.ledger), 'the ledger digest is missing from the briefing');
  assert.ok(input.includes(MEMORY.vault), 'the vault digest is missing from the briefing');
});

test('and never an ambient one — a status remark is worse for having it', async () => {
  // The ambient prompt asks for one line under 110 characters about the thing
  // that just happened. A paragraph of recall pulls the other way, and there is
  // no room to resolve the two.
  const fetchImpl = scriptedFetch(responsesOk('That one stopped short.'));
  const brain = createBrain({ config: CONFIG, fetchImpl, getMemory: () => MEMORY });

  await brain.requestLine({ detail: DETAIL, summary: SUMMARY });
  const input = fetchImpl.calls[0].body.input;
  assert.ok(!input.includes('You remember'), 'the ledger digest reached the ambient prompt');
  assert.ok(!input.includes('Your notes for'), 'the vault digest reached the ambient prompt');
  assert.ok(!input.includes('Left open'));
});

test('the briefing puts what is happening first, then what she remembers, then the conversation', () => {
  const context = {
    time: null,
    recent: null,
    sessions: { count: 4, projects: [], activeSince: null, activeForMs: null },
  };
  const input = buildChatInput({
    text: 'what broke earlier?',
    history: HISTORY,
    context,
    memory: MEMORY,
  });
  const order = ['Around him right now:', 'You remember, going back', 'Your notes for GolfCRM', 'Earlier in this conversation:', 'Kahweng says to you:']
    .map((marker) => input.indexOf(marker));
  assert.ok(order.every((i) => i >= 0), `a block is missing: ${order.join(', ')}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'the blocks are out of order');

  // Unlabelled on purpose: both digests already address her ("You remember…"),
  // and a heading over them reads as a list to recite rather than as memory.
  assert.ok(!/^(Memory|Recall|Your ledger):/m.test(input));
});

test('half a memory, no memory and a broken memory are all just less', async () => {
  assert.ok(!buildChatInput({ text: 'hi', memory: { ledger: null, vault: MEMORY.vault } }).includes('You remember'));
  assert.ok(!buildChatInput({ text: 'hi', memory: { ledger: '   ', vault: null } }).includes('\n\n'));
  assert.equal(buildChatInput({ text: 'hi', memory: null }), 'Kahweng says to you: hi');
  assert.equal(buildChatInput({ text: 'hi', memory: 'not an object' }), 'Kahweng says to you: hi');

  // A reader that throws must cost the recall and nothing else — the reply is
  // the thing he is sitting there waiting for.
  const fetchImpl = scriptedFetch(responsesOk('Still here.'));
  const log = recorder();
  const brain = createBrain({
    config: CONFIG,
    fetchImpl,
    log,
    getMemory: () => {
      throw new Error('the ledger is on fire');
    },
  });
  assert.equal(await brain.requestChat({ text: 'are you there?' }), 'Still here.');
  assert.ok(log.lines.some((l) => /memory unavailable/.test(l)));
  assert.ok(!log.lines.some((l) => /on fire/.test(l)), 'the error message is not repeated back');
});

test('the chat prompt says she may claim what she noted, and nothing else', async () => {
  // The rule itself is in BRAIN_INSTRUCTIONS, so it is in this prompt verbatim
  // (see the first test in this section). What is added here is the half that
  // only chat can reach: on this path he can *ask her to do things*.
  assert.match(CHAT_INSTRUCTIONS, /You cannot edit a file, run a command, fix anything, set a page aside/i);
  const added = CHAT_INSTRUCTIONS.slice(BRAIN_INSTRUCTIONS.length);
  assert.match(added, /Anything else he asks of you, you cannot do/i);
  assert.match(added, /you tell him so gently instead of agreeing to it/i);
  assert.match(added, /do not read them out/i, 'the digests are background, not a script');
});
