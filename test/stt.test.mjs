// Module S (stt) tests — the listening half of push-to-talk, with no microphone
// and no network. Every request is served by an injected `fetchImpl`, and the
// config under test is a temp file, never the real .env.local.
//
// The contract is "never worse than saying nothing": a rejected key, a timeout,
// a dead endpoint, a garbage body, a double-press and a runaway recorder must
// each resolve to `null` while he is still holding the key down. Four themes:
//   1. config — a missing file or an empty key is an ordinary disabled pet, not
//      a throw, and the key it names is never a value it prints;
//   2. the request — the filename is the format declaration, so a part posted
//      without a usable extension is a request wasted;
//   3. failure — every path resolves null, and 401 stops asking forever;
//   4. the key — it appears in exactly one place, the Authorization header, and
//      in no log line, error or stats object anywhere.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  EXTENSIONS,
  MAX_AUDIO_BYTES,
  MAX_TRANSCRIPT_CHARS,
  REQUEST_TIMEOUT_MS,
  REQUIRED_KEY,
  TRANSCRIPTIONS_PATH,
  cleanTranscript,
  createStt,
  extensionFor,
  fileNameFor,
  loadSttConfig,
} from '../src/main/stt.mjs';
import { MAX_INPUT_CHARS } from '../src/main/chat.mjs';

const CONFIG = Object.freeze({
  enabled: true,
  baseUrl: 'https://stt.invalid',
  model: 'gpt-4o-transcribe',
  apiKey: 'sk-stt-not-a-real-key',
});

/** Three seconds of "audio". Its contents never matter; its size sometimes does. */
const CLIP = Buffer.alloc(4_096, 7);

/** Minimal stand-in for a fetch Response. */
const reply = (status, body) => ({ status, json: async () => body });
const transcribed = (text) => reply(200, { text });

/** fetchImpl that plays a fixed script and records every call. */
function scriptedFetch(...steps) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, form: init.body });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    return typeof step === 'function' ? step(url, init) : step;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** fetchImpl that answers only once `release()` is called, for the in-flight tests. */
function gatedFetch(answer = transcribed('first')) {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, form: init.body });
    await gate;
    return answer;
  };
  fetchImpl.calls = calls;
  fetchImpl.release = () => open();
  return fetchImpl;
}

/** fetchImpl that never answers, and rejects the way undici does when aborted. */
const hangingFetch = () => async (url, init) =>
  new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });

/** Collects every line a logger would have printed, for the never-log-the-key check. */
function recorder() {
  const lines = [];
  const push = (m) => lines.push(String(m));
  return { lines, log: push, warn: push, error: push };
}

function tempEnv(t, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ganyu-stt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env.local');
  if (contents !== null) fs.writeFileSync(file, contents, 'utf8');
  return file;
}

const FULL_ENV = [
  '# ganyu push-to-talk',
  '',
  'GANYU_STT_BASE_URL = https://api.openai.com/ ',
  'GANYU_STT_MODEL=gpt-4o-transcribe',
  'GANYU_STT_API_KEY=sk-stt-not-a-real-key',
  '# GANYU_STT_MODEL=commented-out',
  '',
].join('\n');

// ---------------------------------------------------------------- config

test('a missing .env.local disables transcription instead of throwing', (t) => {
  const missing = path.join(path.dirname(tempEnv(t, 'x=1')), 'nope.local');
  assert.equal(loadSttConfig({ envPath: missing }).enabled, false);
  assert.equal(loadSttConfig({}).enabled, false, 'no path at all is also just disabled');
  assert.equal(loadSttConfig().enabled, false, 'and no argument object at all');
});

test('an empty or missing key disables it, and the reason names the key', (t) => {
  const empty = loadSttConfig({ envPath: tempEnv(t, FULL_ENV.replace('sk-stt-not-a-real-key', '')) });
  assert.equal(empty.enabled, false);
  assert.match(empty.reason, new RegExp(REQUIRED_KEY));

  const none = loadSttConfig({ envPath: tempEnv(t, 'GANYU_STT_MODEL=whisper-1\n') });
  assert.equal(none.enabled, false);
  assert.match(none.reason, new RegExp(REQUIRED_KEY));
  assert.equal(none.apiKey, '', 'a disabled config carries no key at all');
});

test('a full .env.local enables it, trimmed and without the trailing slash', (t) => {
  assert.deepEqual(loadSttConfig({ envPath: tempEnv(t, FULL_ENV) }), {
    enabled: true,
    baseUrl: 'https://api.openai.com',
    model: 'gpt-4o-transcribe',
    apiKey: 'sk-stt-not-a-real-key',
    reason: null,
  });
});

test('the key is the only value without a default', (t) => {
  const config = loadSttConfig({ envPath: tempEnv(t, `${REQUIRED_KEY}=sk-only-the-key\n`) });
  assert.equal(config.enabled, true);
  assert.equal(config.baseUrl, DEFAULT_BASE_URL);
  assert.equal(config.model, DEFAULT_MODEL);
});

test('the env file is read through the injected fs, and a throwing one is just no config', () => {
  const readFileSync = () => `${REQUIRED_KEY}=sk-from-a-fake-fs\nGANYU_STT_MODEL=whisper-1\n`;
  const config = loadSttConfig({ envPath: '/anywhere/.env.local', fs: { readFileSync } });
  assert.equal(config.enabled, true);
  assert.equal(config.model, 'whisper-1');

  const broken = loadSttConfig({
    envPath: '/anywhere/.env.local',
    fs: { readFileSync: () => { throw new Error('EACCES'); } },
  });
  assert.equal(broken.enabled, false);
  assert.equal(broken.reason, 'no .env.local');
});

// ---------------------------------------------------------------- the filename

test('the part is always named with an extension the endpoint recognises', () => {
  assert.equal(extensionFor('audio/webm;codecs=opus'), 'webm');
  assert.equal(extensionFor('audio/WAV'), 'wav');
  assert.equal(extensionFor('application/octet-stream'), 'webm', 'unknown falls back to the recorder default');
  assert.equal(extensionFor(null), 'webm');

  assert.equal(fileNameFor({ mimeType: 'audio/webm;codecs=opus' }), 'utterance.webm');
  assert.equal(fileNameFor({ mimeType: 'audio/wav', fileName: 'clip' }), 'clip.wav');
  assert.equal(fileNameFor({ mimeType: 'audio/wav', fileName: 'clip.bin' }), 'clip.wav', 'an unusable extension is replaced');
  assert.equal(fileNameFor({ mimeType: 'audio/webm', fileName: 'held.ogg' }), 'held.ogg', 'a usable one is kept');
  // The name goes into a multipart header, so a caller-supplied one keeps no
  // path separators — and still comes out declaring a format.
  const hostile = fileNameFor({ mimeType: 'audio/mpeg', fileName: '../../etc/passwd' });
  assert.ok(!/[\\/:]/.test(hostile), hostile);
  assert.match(hostile, /\.mp3$/);
  assert.ok(Object.values(EXTENSIONS).every((ext) => /^[a-z0-9]+$/.test(ext)));
});

// ---------------------------------------------------------------- the request

test('the multipart body carries the audio as a named file and the model beside it', async () => {
  const fetchImpl = scriptedFetch(transcribed('Ganyu, what broke this morning?'));
  const stt = createStt({ config: CONFIG, fetchImpl });

  const text = await stt.transcribe({ audio: CLIP, mimeType: 'audio/webm;codecs=opus' });
  assert.equal(text, 'Ganyu, what broke this morning?');

  const { url, init, form } = fetchImpl.calls[0];
  assert.equal(url, `${CONFIG.baseUrl}${TRANSCRIPTIONS_PATH}`);
  assert.equal(init.method, 'POST');
  assert.ok(form instanceof FormData, 'the body is a FormData, so undici writes the multipart itself');

  const file = form.get('file');
  assert.equal(file.name, 'utterance.webm', 'the endpoint reads the container format off this name');
  assert.match(file.name, /\.[a-z0-9]+$/);
  assert.equal(file.type, 'audio/webm;codecs=opus');
  assert.equal(file.size, CLIP.length);
  assert.equal(form.get('model'), CONFIG.model);

  // Setting content-type by hand is the classic way to break this: FormData
  // supplies it *with the boundary*, and a hand-written one has none.
  assert.deepEqual(Object.keys(init.headers), ['authorization']);
  assert.equal(init.headers.authorization, `Bearer ${CONFIG.apiKey}`);
  assert.ok(init.signal, 'and it is abortable, or the timeout below could not fire');
});

test('base64 and data-URL audio from the renderer are accepted as bytes', async () => {
  const fetchImpl = scriptedFetch(transcribed('hello'));
  const stt = createStt({ config: CONFIG, fetchImpl });

  await stt.transcribe({ audio: CLIP.toString('base64'), mimeType: 'audio/webm' });
  assert.equal(fetchImpl.calls[0].form.get('file').size, CLIP.length);

  await stt.transcribe({
    audio: `data:audio/webm;base64,${CLIP.toString('base64')}`,
    mimeType: 'audio/webm',
  });
  assert.equal(fetchImpl.calls[1].form.get('file').size, CLIP.length, 'the data: prefix is not audio');
});

// ---------------------------------------------------------------- the transcript

test('a successful response yields the transcript, trimmed to one line', async () => {
  const stt = createStt({
    config: CONFIG,
    fetchImpl: scriptedFetch(transcribed('  what did that\n  GolfCRM session get done?  ')),
  });
  assert.equal(await stt.transcribe({ audio: CLIP, mimeType: 'audio/wav' }),
    'what did that GolfCRM session get done?');
  assert.equal(stt.stats().transcribed, 1);
});

test('a whitespace-only transcript is silence, not a message', async () => {
  for (const body of [{ text: '   \n\t ' }, { text: '' }, {}, { text: 42 }, null]) {
    const stt = createStt({ config: CONFIG, fetchImpl: scriptedFetch(reply(200, body)) });
    assert.equal(await stt.transcribe({ audio: CLIP, mimeType: 'audio/wav' }), null,
      `an empty string would be sent to chat.send as a message he never spoke: ${JSON.stringify(body)}`);
  }
  assert.equal(cleanTranscript('  '), null);
});

test('a transcript is capped where chat.send caps its input', async () => {
  const stt = createStt({
    config: CONFIG,
    fetchImpl: scriptedFetch(transcribed('word '.repeat(400)), transcribed('x'.repeat(600))),
  });
  const wordy = await stt.transcribe({ audio: CLIP, mimeType: 'audio/wav' });
  // At most the cap: the trim after the cut can eat a space, and a transcript
  // ending in half a word is not worth a character of precision here.
  assert.ok(wordy.length <= MAX_TRANSCRIPT_CHARS && wordy.length > MAX_TRANSCRIPT_CHARS - 10, wordy.length);
  assert.equal((await stt.transcribe({ audio: CLIP, mimeType: 'audio/wav' })).length, MAX_TRANSCRIPT_CHARS);
  assert.equal(MAX_TRANSCRIPT_CHARS, MAX_INPUT_CHARS, 'what he sees is what gets sent');
});

// ---------------------------------------------------------------- failure

test('a rejecting fetch resolves null rather than throwing', async () => {
  const log = recorder();
  const stt = createStt({
    config: CONFIG,
    log,
    fetchImpl: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' }); },
  });
  assert.equal(await stt.transcribe({ audio: CLIP, mimeType: 'audio/wav' }), null);
  assert.equal(stt.stats().failed, 1);
  assert.equal(stt.isEnabled(), true, 'one bad minute is not a wrong key');
  assert.ok(log.lines.some((line) => line.includes('TypeError')), 'reported by name');
  assert.ok(log.lines.every((line) => !line.includes(CONFIG.baseUrl)), 'and never by URL');
});

test('a request that never answers is abandoned at the timeout and yields null', async () => {
  const stt = createStt({ config: CONFIG, fetchImpl: hangingFetch(), timeoutMs: 20 });
  const started = Date.now();
  assert.equal(await stt.transcribe({ audio: CLIP, mimeType: 'audio/wav' }), null);
  assert.ok(Date.now() - started < 1_000, 'it did not wait for the endpoint to change its mind');
  assert.equal(stt.stats().failed, 1);
  assert.ok(REQUEST_TIMEOUT_MS < 10_000, 'and the shipped timeout sits under the brain it feeds');
});

test('a non-2xx answer yields null and says the status', async () => {
  const log = recorder();
  const stt = createStt({ config: CONFIG, log, fetchImpl: scriptedFetch(reply(500, {})) });
  assert.equal(await stt.transcribe({ audio: CLIP, mimeType: 'audio/wav' }), null);
  assert.ok(log.lines.some((line) => line.includes('500')));
  assert.equal(stt.isEnabled(), true, 'a 500 is the endpoint having a bad day, not a wrong key');
});

test('a malformed body yields null instead of taking the pet down', async () => {
  const stt = createStt({
    config: CONFIG,
    fetchImpl: scriptedFetch({ status: 200, json: async () => { throw new SyntaxError('not JSON'); } }),
  });
  assert.equal(await stt.transcribe({ audio: CLIP, mimeType: 'audio/wav' }), null);
});

test('a rejected key disables transcription permanently — the next press makes no request', async () => {
  for (const status of [401, 403]) {
    const log = recorder();
    const fetchImpl = scriptedFetch(reply(status, {}), transcribed('never reached'));
    const stt = createStt({ config: CONFIG, log, fetchImpl });

    assert.equal(await stt.transcribe({ audio: CLIP, mimeType: 'audio/wav' }), null);
    assert.equal(stt.isEnabled(), false);
    assert.equal(await stt.transcribe({ audio: CLIP, mimeType: 'audio/wav' }), null);
    assert.equal(fetchImpl.calls.length, 1, `${status} must not be retried on every press`);

    const spoken = log.lines.filter((line) => line.includes('rejected the key'));
    assert.equal(spoken.length, 1, 'said once, not once per press');
    assert.ok(spoken[0].includes(REQUIRED_KEY), 'and it names the cause');
    assert.ok(spoken[0].includes(String(status)));
  }
});

test('a second transcribe while one is in flight resolves null and sends nothing', async () => {
  const fetchImpl = gatedFetch(transcribed('the first one'));
  const stt = createStt({ config: CONFIG, fetchImpl });

  const first = stt.transcribe({ audio: CLIP, mimeType: 'audio/wav' });
  const second = stt.transcribe({ audio: CLIP, mimeType: 'audio/wav' });
  assert.equal(await second, null, 'a double-press is not a second utterance');
  assert.equal(fetchImpl.calls.length, 1);

  fetchImpl.release();
  assert.equal(await first, 'the first one', 'and the one already recorded still lands');
  assert.equal(stt.stats().dropped, 1);

  // The latch is released afterwards, or the first double-press would be the last press.
  fetchImpl.release();
  assert.equal(await stt.transcribe({ audio: CLIP, mimeType: 'audio/wav' }), 'the first one');
  assert.equal(fetchImpl.calls.length, 2);
});

test('audio over the ceiling is refused before a request is spent on it', async () => {
  const log = recorder();
  const fetchImpl = scriptedFetch(transcribed('never reached'));
  const stt = createStt({ config: CONFIG, log, fetchImpl });

  const runaway = Buffer.alloc(MAX_AUDIO_BYTES + 1);
  assert.equal(await stt.transcribe({ audio: runaway, mimeType: 'audio/wav' }), null);
  assert.equal(fetchImpl.calls.length, 0, 'a stuck recorder must not cost a request');
  assert.ok(log.lines.some((line) => line.includes('refusing')));
  assert.ok(MAX_AUDIO_BYTES < 25 * 1024 * 1024, 'and well under what the endpoint would accept');

  // The ceiling is a bug detector, not a limit an utterance can reach.
  assert.equal(await stt.transcribe({ audio: Buffer.alloc(MAX_AUDIO_BYTES), mimeType: 'audio/wav' }),
    'never reached');
});

test('no usable audio is refused without a request', async () => {
  const fetchImpl = scriptedFetch(transcribed('never reached'));
  const stt = createStt({ config: CONFIG, fetchImpl });
  for (const audio of [null, undefined, Buffer.alloc(0), '', 12, {}]) {
    assert.equal(await stt.transcribe({ audio, mimeType: 'audio/wav' }), null);
  }
  assert.equal(await stt.transcribe(), null, 'and no argument object at all');
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(stt.stats().rejected, 7);
});

test('a config that never enabled makes no request and never throws', async () => {
  const fetchImpl = scriptedFetch(transcribed('never reached'));
  for (const config of [{ enabled: false }, { ...CONFIG, apiKey: '' }, { ...CONFIG, model: '' }, null]) {
    const stt = createStt({ config, fetchImpl });
    assert.equal(stt.isEnabled(), false);
    assert.equal(await stt.transcribe({ audio: CLIP, mimeType: 'audio/wav' }), null);
  }
  assert.equal(createStt({ config: CONFIG, fetchImpl: null }).isEnabled(), false);
  assert.equal(fetchImpl.calls.length, 0);
});

// ---------------------------------------------------------------- the key

test('the key reaches the Authorization header and nothing else', async () => {
  const log = recorder();
  const cases = [
    transcribed('fine'),
    reply(500, {}),
    reply(401, {}),
    async () => { throw new Error(`request to ${CONFIG.baseUrl}${TRANSCRIPTIONS_PATH} failed`); },
  ];

  for (const step of cases) {
    const stt = createStt({ config: CONFIG, log, fetchImpl: scriptedFetch(step) });
    // The oversized and empty paths log too, so they belong in this sweep.
    await stt.transcribe({ audio: Buffer.alloc(MAX_AUDIO_BYTES + 1), mimeType: 'audio/wav' });
    await assert.doesNotReject(stt.transcribe({ audio: CLIP, mimeType: 'audio/wav' }));
    assert.ok(!JSON.stringify(stt.stats()).includes(CONFIG.apiKey), 'nor into stats');
    assert.ok(!JSON.stringify(stt.stats().lastError ?? {}).includes(CONFIG.baseUrl));
  }

  assert.ok(log.lines.length > 0, 'the sweep printed something to check');
  for (const line of log.lines) assert.ok(!line.includes(CONFIG.apiKey), `leaked the key: ${line}`);
});

test('a logger that throws is not a reason to lose the transcript', async () => {
  const stt = createStt({
    config: CONFIG,
    log: { warn: () => { throw new Error('broken logger'); } },
    fetchImpl: scriptedFetch(reply(500, {}), transcribed('still here')),
  });
  assert.equal(await stt.transcribe({ audio: CLIP, mimeType: 'audio/wav' }), null);
  assert.equal(await stt.transcribe({ audio: CLIP, mimeType: 'audio/wav' }), 'still here');
});
