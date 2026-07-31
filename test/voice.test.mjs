// Module V tests — her voice, with no network and no child process.
//
// Everything with a side effect is injected, so the fake below is a WebSocket
// that opens, streams and dies exactly when a test says so. Four themes:
//   1. the token — deterministic for a fixed clock, and floored to five minutes,
//      because a wrong Sec-MS-GEC is a 403 and a 403 is silence;
//   2. failure — a refused socket, one that never opens, and one that dies
//      mid-sentence all have to yield the fallback or null, never a throw and
//      never a promise that no longer settles;
//   3. the warm socket — reused across lines, reconnected after a close, since
//      that is worth ~900ms per line and is the only reason this is stateful;
//   4. the gate — audio follows the bubble. A muted, throttled or non-salient
//      line makes no sound, because it never reached `show()` in the first place.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIO_MIME,
  CONNECT_TIMEOUT_MS,
  DEFAULT_VOICE,
  GEC_VERSION,
  MAX_SPEAK_CHARS,
  READALOUD_WSS,
  SPEAK_TIMEOUT_MS,
  TRUSTED_CLIENT_TOKEN,
  VoiceAuthError,
  WAV_MIME,
  buildSsml,
  createLocalVoice,
  createVoice,
  escapeSsml,
  loadVoiceConfig,
  secMsGec,
} from '../src/main/voice.mjs';
import { AUDIO_HOLD_MS, createSpeech, QUIET_THROTTLE_MS } from '../src/main/speech.mjs';
import { CHANNELS, registerIpc } from '../src/main/window.mjs';
import { createVoicePlayer } from '../src/renderer/pet.mjs';

/** Let queued microtasks run. The module awaits its own socket, so tests must too. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A WebSocket that does nothing until a test tells it to. `sent` is every frame
 * the module wrote, which is how the SSML and the handshake are asserted without
 * a protocol decoder.
 */
class FakeSocket {
  static made = [];

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.sent = [];
    this.readyState = 0; // CONNECTING
    this.closed = false;
    FakeSocket.made.push(this);
  }

  static last() {
    return FakeSocket.made[FakeSocket.made.length - 1];
  }

  static reset() {
    FakeSocket.made = [];
  }

  send(frame) {
    this.sent.push(String(frame));
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }

  // ---- test-side controls -------------------------------------------------

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  error(message) {
    this.onerror?.({ message });
  }

  /** The server hung up. `dropSocket` must notice and let the next line reconnect. */
  hangUp(code = 1006, reason = 'abnormal') {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  /** The X-RequestId the module put on its most recent ssml frame. */
  requestId() {
    const ssml = [...this.sent].reverse().find((f) => f.includes('Path:ssml'));
    return ssml ? /X-RequestId:(\S+)/.exec(ssml)?.[1] ?? null : null;
  }

  /** One binary audio frame, framed exactly as the real endpoint frames it. */
  audio(bytes, requestId = this.requestId()) {
    const head = Buffer.from(`X-RequestId:${requestId}\r\nPath:audio\r\n\r\n`, 'ascii');
    const frame = Buffer.alloc(2 + head.length + bytes.length);
    frame.writeUInt16BE(head.length, 0);
    head.copy(frame, 2);
    Buffer.from(bytes).copy(frame, 2 + head.length);
    this.onmessage?.({ data: frame });
  }

  turnEnd(requestId = this.requestId()) {
    this.onmessage?.({ data: `X-RequestId:${requestId}\r\nPath:turn.end\r\n\r\n{}` });
  }

  /** The whole happy path for one line: some audio, then the end of the turn. */
  reply(bytes = [1, 2, 3, 4]) {
    this.audio(Buffer.from(bytes));
    this.turnEnd();
  }
}

/** Timers under the test's control, so a 10s timeout costs no wall-clock time. */
function fakeTimers() {
  const pending = new Map();
  let id = 0;
  return {
    schedule(fn, ms) {
      const key = (id += 1);
      pending.set(key, { fn, ms });
      return key;
    },
    cancel(key) {
      pending.delete(key);
    },
    /** Fire every outstanding timer, newest last. */
    runAll() {
      for (const [key, timer] of [...pending]) {
        pending.delete(key);
        timer.fn();
      }
    },
    get size() {
      return pending.size;
    },
  };
}

/** A local synthesizer that always works, so the fallback is observable. */
function fakeFallback() {
  const calls = [];
  return {
    calls,
    async speak(text) {
      calls.push(text);
      return { mime: WAV_MIME, base64: 'ZmFrZS13YXY=', bytes: 9, ms: 3, source: 'sapi' };
    },
  };
}

function makeVoice(extra = {}) {
  FakeSocket.reset();
  const timers = fakeTimers();
  const voice = createVoice({
    WebSocketImpl: FakeSocket,
    now: () => 1_700_000_000_000,
    schedule: timers.schedule,
    cancel: timers.cancel,
    newId: (() => {
      let n = 0;
      return () => `id${(n += 1)}`;
    })(),
    ...extra,
  });
  return { voice, timers };
}

// ------------------------------------------------------------------ the token

test('the GEC token is deterministic for a fixed clock and floors to five minutes', () => {
  // A five-minute bucket boundary. 11644473600 is divisible by 300, so flooring
  // Unix seconds and flooring FILETIME ticks land on the same edges.
  const bucket = Math.floor(1_785_000_000_000 / 300_000) * 300_000;

  assert.equal(secMsGec(bucket), secMsGec(bucket), 'same clock, same token');
  assert.equal(secMsGec(bucket), secMsGec(bucket + 299_999), 'still inside the window');
  assert.notEqual(secMsGec(bucket), secMsGec(bucket + 300_000), 'the next window is a new token');
  assert.match(secMsGec(bucket), /^[0-9A-F]{64}$/, 'uppercase hex SHA-256');
});

test('the token matches the working probe byte for byte', () => {
  // Golden vector taken from the standalone probe that was verified against the
  // live endpoint, so a refactor of secMsGec cannot quietly change the answer.
  assert.equal(
    secMsGec(1_785_000_000_000),
    '9660FD031A1F99E785A66185BE18DD874B69513B6A5592CABBC7944CEF6CDC10',
  );
});

test('the connection URL carries the token, the version and the trusted token', async () => {
  const { voice } = makeVoice();
  voice.speak('hello');
  await tick();

  const { url, options } = FakeSocket.last();
  assert.ok(url.startsWith(READALOUD_WSS), 'the read-aloud endpoint');
  assert.ok(url.includes(`TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`));
  assert.ok(url.includes(`Sec-MS-GEC-Version=${GEC_VERSION}`));
  assert.ok(url.includes(`Sec-MS-GEC=${secMsGec(1_700_000_000_000)}`));
  assert.equal(options.headers.Origin.startsWith('chrome-extension://'), true);
});

// ------------------------------------------------------------------ the SSML

test('SSML escapes the five entities and carries the voice and prosody', () => {
  const ssml = buildSsml({ text: 'A & B <c> "d" \'e\'', voice: 'en-US-AvaMultilingualNeural' });
  assert.ok(ssml.includes('&amp;') && ssml.includes('&lt;c&gt;'), 'entities escaped');
  assert.ok(!/[<>]c[<>]/.test(ssml.replace(/<[^>]+>/g, '')), 'no raw angle brackets in the text');
  assert.ok(ssml.includes("name='en-US-AvaMultilingualNeural'"));
  assert.ok(ssml.includes("xml:lang='en-US'"), 'the language follows the voice');
  assert.ok(/<prosody pitch='[^']+' rate='[^']+'>/.test(ssml));
});

test('escapeSsml leaves ordinary text alone', () => {
  assert.equal(escapeSsml('Kahweng, the build finished.'), 'Kahweng, the build finished.');
});

// ------------------------------------------------------------- the happy path

test('a line comes back as base64 mp3', async () => {
  const { voice } = makeVoice();
  const pending = voice.speak('The build finished.');
  await tick();

  const ws = FakeSocket.last();
  ws.open();
  await tick();

  assert.ok(ws.sent[0].includes('Path:speech.config'), 'format handshake first');
  assert.ok(ws.sent[0].includes('audio-24khz-48kbitrate-mono-mp3'));
  assert.ok(ws.sent[1].includes('Path:ssml'));
  assert.ok(ws.sent[1].includes('The build finished.'));

  ws.reply([0xff, 0xfb, 0x10, 0x00]);
  const audio = await pending;

  assert.equal(audio.mime, AUDIO_MIME);
  assert.equal(audio.source, 'edge');
  assert.equal(Buffer.from(audio.base64, 'base64').length, 4);
  assert.equal(voice.stats().spoken, 1);
});

test('an empty line never opens a socket', async () => {
  const { voice } = makeVoice();
  assert.equal(await voice.speak('   '), null);
  assert.equal(await voice.speak(null), null);
  assert.equal(FakeSocket.made.length, 0);
});

test('an over-long line is capped rather than refused', async () => {
  const { voice } = makeVoice();
  voice.speak('x'.repeat(MAX_SPEAK_CHARS + 200));
  await tick();
  const ws = FakeSocket.last();
  ws.open();
  await tick();
  const spoken = /<prosody[^>]*>([^<]*)</.exec(ws.sent[1])[1];
  assert.equal(spoken.length, MAX_SPEAK_CHARS);
});

// ----------------------------------------------------------------- failure

test('a 403 surfaces as a named error naming the version to bump, and falls back', async () => {
  const fallback = fakeFallback();
  const { voice } = makeVoice({ fallback });
  const pending = voice.speak('Kahweng, the tests passed.');
  await tick();

  FakeSocket.last().error('Unexpected server response: 403');
  const audio = await pending;

  const { lastError } = voice.stats();
  assert.equal(lastError.name, 'VoiceAuthError');
  assert.ok(lastError.message.includes(GEC_VERSION), 'the message names the string to change');
  assert.ok(lastError.message.includes('GEC_VERSION'), 'and the constant to change it in');

  assert.equal(audio.source, 'sapi', 'she still speaks, in the dated voice');
  assert.deepEqual(fallback.calls, ['Kahweng, the tests passed.']);
  assert.equal(voice.stats().fellBack, 1);
});

test('a refused socket with no fallback is silence, not an exception', async () => {
  const { voice } = makeVoice();
  const pending = voice.speak('hello');
  await tick();
  FakeSocket.last().error('Unexpected server response: 403');
  assert.equal(await pending, null);
  assert.equal(voice.stats().failed, 1);
});

test('an ordinary connection failure is not reported as an auth failure', async () => {
  const { voice } = makeVoice();
  const pending = voice.speak('hello');
  await tick();
  FakeSocket.last().error('getaddrinfo ENOTFOUND speech.platform.bing.com');
  await pending;
  assert.equal(voice.stats().lastError.name, 'VoiceConnectError');
});

test('a socket that never opens times out and returns null', async () => {
  const { voice, timers } = makeVoice();
  const pending = voice.speak('hello');
  await tick();

  assert.equal(FakeSocket.made.length, 1, 'it did try');
  assert.ok(timers.size > 0, `a ${CONNECT_TIMEOUT_MS}ms guard is armed`);
  timers.runAll(); // the connect timeout fires

  assert.equal(await pending, null);
  assert.equal(voice.stats().lastError.name, 'VoiceConnectError');
  assert.equal(FakeSocket.last().closed, true, 'the half-open socket is closed');
});

test('a socket that opens but never answers times out and does not wedge the next line', async () => {
  const { voice, timers } = makeVoice();
  const first = voice.speak('one');
  await tick();
  const dead = FakeSocket.last();
  dead.open();
  await tick();

  timers.runAll(); // the SPEAK_TIMEOUT_MS guard fires
  assert.equal(await first, null, `nothing within ${SPEAK_TIMEOUT_MS}ms is nothing`);
  assert.equal(dead.closed, true, 'the suspect socket is dropped, not reused');

  const second = voice.speak('two');
  await tick();
  const fresh = FakeSocket.last();
  assert.notEqual(fresh, dead, 'the next line gets a new socket');
  fresh.open();
  await tick();
  fresh.reply();
  assert.equal((await second).source, 'edge');
});

test('a socket that dies mid-sentence settles the line instead of hanging', async () => {
  const { voice } = makeVoice();
  const pending = voice.speak('hello');
  await tick();
  const ws = FakeSocket.last();
  ws.open();
  await tick();
  ws.audio(Buffer.from([1, 2]));
  ws.hangUp();
  assert.equal(await pending, null, 'half a sentence is not a sentence');
});

// -------------------------------------------------------------- warm socket

test('the warm socket is reused across two speaks', async () => {
  const { voice } = makeVoice();

  const first = voice.speak('one');
  await tick();
  const ws = FakeSocket.last();
  ws.open();
  await tick();
  ws.reply();
  await first;

  const second = voice.speak('two');
  await tick();
  ws.reply([9, 9]);
  await second;

  assert.equal(FakeSocket.made.length, 1, 'one connection, two lines');
  assert.equal(voice.stats().connects, 1);
  assert.equal(voice.stats().spoken, 2);
  assert.equal(ws.sent.filter((f) => f.includes('Path:ssml')).length, 2);
  assert.equal(ws.sent.filter((f) => f.includes('Path:speech.config')).length, 1);
});

test('a closed socket reconnects on the next line', async () => {
  const { voice } = makeVoice();

  const first = voice.speak('one');
  await tick();
  const original = FakeSocket.last();
  original.open();
  await tick();
  original.reply();
  await first;

  original.hangUp(1000, 'idle'); // the endpoint drops an idle connection
  assert.equal(voice.stats().connected, false);

  const second = voice.speak('two');
  await tick();
  const replacement = FakeSocket.last();
  assert.notEqual(replacement, original, 'a new socket, not the dead one');
  replacement.open();
  await tick();
  replacement.reply();

  assert.equal((await second).source, 'edge');
  assert.equal(voice.stats().connects, 2);
});

test('warm() opens the socket before there is anything to say', async () => {
  const { voice } = makeVoice();
  const warming = voice.warm();
  await tick();
  FakeSocket.last().open();
  assert.equal(await warming, true);
  assert.equal(voice.stats().connected, true);
});

test('warm() on a refusing endpoint is false, not a throw', async () => {
  const { voice } = makeVoice();
  const warming = voice.warm();
  await tick();
  FakeSocket.last().error('Unexpected server response: 403');
  assert.equal(await warming, false);
});

// ------------------------------------------------------------------ overlap

test('a newer line supersedes the one being synthesized, and the old one stays silent', async () => {
  const fallback = fakeFallback();
  const { voice } = makeVoice({ fallback });

  const stale = voice.speak('the old news');
  await tick();
  const ws = FakeSocket.last();
  ws.open();
  await tick();

  const fresh = voice.speak('the new news');
  assert.equal(await stale, null, 'superseded resolves null');
  assert.deepEqual(fallback.calls, [], 'and must NOT arrive late through the fallback');

  await tick();
  ws.reply([7, 7, 7]);
  const audio = await fresh;

  assert.equal(audio.source, 'edge');
  assert.equal(voice.stats().superseded, 1);
  const ssml = ws.sent.filter((f) => f.includes('Path:ssml'));
  assert.equal(ssml.length, 2);
  assert.ok(ssml[1].includes('the new news'));
});

test('audio for an abandoned request is never spliced onto the next line', async () => {
  const { voice } = makeVoice();
  const first = voice.speak('one');
  await tick();
  const ws = FakeSocket.last();
  ws.open();
  await tick();
  const staleId = ws.requestId();

  const second = voice.speak('two');
  await first;
  await tick();

  ws.audio(Buffer.from([1, 1, 1, 1, 1, 1]), staleId); // late audio for the old line
  ws.audio(Buffer.from([2, 2]));
  ws.turnEnd();

  const audio = await second;
  assert.equal(Buffer.from(audio.base64, 'base64').length, 2, 'only the new line');
});

test('close() settles a line in flight rather than leaving its promise hanging', async () => {
  const { voice } = makeVoice();
  const pending = voice.speak('hello');
  await tick();
  const ws = FakeSocket.last();
  ws.open();
  await tick();
  voice.close();
  assert.equal(await pending, null);
  assert.equal(ws.closed, true);
  assert.equal(await voice.speak('anything'), null, 'and she stays closed');
});

// ------------------------------------------------------------------- config

test('with no .env.local at all she still has a voice', () => {
  const config = loadVoiceConfig({ envPath: null, fs: null });
  assert.equal(config.enabled, true, 'default ON — this path needs no key');
  assert.equal(config.mode, 'edge');
  assert.equal(config.voice, DEFAULT_VOICE);
  assert.equal(config.ambient, true);
});

test('GANYU_VOICE turns her off, pins her local, or is ignored', () => {
  const read = (text) => loadVoiceConfig({ envPath: 'x', fs: { readFileSync: () => text } });

  for (const off of ['off', '0', 'false', 'no', 'none', 'mute']) {
    const config = read(`GANYU_VOICE=${off}`);
    assert.equal(config.enabled, false, `${off} is off`);
    assert.ok(config.reason.includes('GANYU_VOICE'));
  }
  for (const local of ['local', 'sapi', 'offline']) {
    assert.equal(read(`GANYU_VOICE=${local}`).mode, 'local', `${local} never touches the network`);
  }
  assert.equal(read('GANYU_VOICE=on').mode, 'edge');
  assert.equal(read('# nothing here\n').enabled, true);
});

test('GANYU_VOICE_NAME picks the voice and GANYU_VOICE_AMBIENT silences the unprompted half', () => {
  const read = (text) => loadVoiceConfig({ envPath: 'x', fs: { readFileSync: () => text } });

  assert.equal(read('GANYU_VOICE_NAME=ja-JP-NanamiNeural').voice, 'ja-JP-NanamiNeural');
  assert.equal(read('GANYU_VOICE_NAME=   ').voice, DEFAULT_VOICE, 'blank falls back');
  assert.equal(read('GANYU_VOICE_AMBIENT=off').ambient, false);
  assert.equal(read('GANYU_VOICE_AMBIENT=1').ambient, true);
  assert.equal(read('GANYU_VOICE_NAME=x').ambient, true, 'a key he never wrote is not off');
});

test('an unreadable .env.local is the default config, not a crash', () => {
  const config = loadVoiceConfig({
    envPath: 'x',
    fs: {
      readFileSync() {
        throw new Error('EACCES');
      },
    },
  });
  assert.equal(config.enabled, true);
  assert.equal(config.voice, DEFAULT_VOICE);
});

// -------------------------------------------------------- the local fallback

test('the local voice shells powershell.exe with an encoded System.Speech script', async () => {
  const calls = [];
  const local = createLocalVoice({
    execFile: (file, args, opts, cb) => {
      calls.push({ file, args, opts });
      cb(null);
    },
    fs: { readFileSync: () => Buffer.from([1, 2, 3]), unlinkSync: () => {} },
    tmpDir: 'C:\\Temp',
    newId: () => 'abc',
  });

  const audio = await local.speak("Kahweng's build finished.");

  assert.equal(calls.length, 1);
  // powershell.exe (5.1), NOT pwsh: System.Speech is a .NET Framework assembly
  // and `Add-Type -AssemblyName System.Speech` fails on PowerShell 7.
  assert.equal(calls[0].file, 'powershell.exe');
  assert.ok(calls[0].args.includes('-EncodedCommand'));
  assert.equal(calls[0].opts.windowsHide, true);

  const script = Buffer.from(calls[0].args.at(-1), 'base64').toString('utf16le');
  assert.ok(script.includes('Add-Type -AssemblyName System.Speech'));
  assert.ok(script.includes('SetOutputToWaveFile'));
  assert.ok(script.includes("Kahweng''s build finished."), 'quotes doubled, not escaped');
  assert.ok(!script.includes('\n'), 'one line, so the literal cannot be broken out of');

  assert.equal(audio.mime, WAV_MIME);
  assert.equal(audio.source, 'sapi');
  assert.equal(Buffer.from(audio.base64, 'base64').length, 3);
});

test('a local voice that fails, or has nothing to shell, is null', async () => {
  const broken = createLocalVoice({
    execFile: (_f, _a, _o, cb) => cb(new Error('not found')),
    fs: { readFileSync: () => Buffer.from([1]), unlinkSync: () => {} },
    tmpDir: 'C:\\Temp',
  });
  assert.equal(await broken.speak('hello'), null);

  const absent = createLocalVoice({});
  assert.equal(absent.enabled, false);
  assert.equal(await absent.speak('hello'), null);
});

test('local mode never opens a socket', async () => {
  const fallback = fakeFallback();
  const { voice } = makeVoice({ mode: 'local', fallback });
  const audio = await voice.speak('hello');
  assert.equal(FakeSocket.made.length, 0);
  assert.equal(audio.source, 'sapi');
  assert.equal(await voice.warm(), false);
});

// ------------------------------------------------- the gate: audio follows the bubble

const EDGE_AUDIO = { mime: AUDIO_MIME, base64: 'AAAA', bytes: 3, ms: 5, source: 'edge' };

/**
 * Speech with a voice attached, and everything it emitted, on a manual clock and
 * a manual timer queue.
 *
 * The timers matter as much as the clock now: a non-urgent line is held back
 * until its audio is ready, and the hold's deadline is the only thing that can
 * end that wait when the synthesizer never answers. `expire()` is a test firing
 * that deadline by hand, so nothing here waits on a real 3.5 seconds.
 *
 * `speak` overrides what the synthesizer returns — a promise the test holds open
 * is how "audio still in flight" is expressed.
 */
function speechHarness({ muted = false, speak = null } = {}) {
  let t = 1_000_000;
  const lines = [];
  const audio = [];
  const spoken = [];
  const timers = [];
  const speech = createSpeech({
    clock: { now: () => t },
    onLine: (line) => lines.push(line),
    isMuted: () => muted,
    random: () => 0,
    schedule: (fn, ms) => {
      const timer = { fn, ms, cancelled: false, fired: false };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      if (timer) timer.cancelled = true;
    },
    voice: {
      speak(text, opts) {
        spoken.push({ text, kind: opts?.kind ?? null });
        return Promise.resolve(speak ? speak(text, opts) : EDGE_AUDIO);
      },
    },
    onAudio: (payload) => audio.push(payload),
  });
  return {
    speech,
    lines,
    audio,
    spoken,
    timers,
    mute(value) {
      muted = value;
    },
    advance(ms) {
      t += ms;
    },
    /** Fire every hold deadline still armed. Returns how many there were. */
    expire() {
      const due = timers.filter((x) => !x.cancelled && !x.fired);
      for (const timer of due) {
        timer.fired = true;
        timer.fn();
      }
      return due.length;
    },
    /** True while a line is still waiting on its audio. */
    get holding() {
      return timers.some((x) => !x.cancelled && !x.fired);
    },
  };
}

const sessionStart = { source: 'codex', event: 'SessionStart', sessionId: 's1', cwd: 'C:\\dev\\ganyu-pet' };
const stop = { source: 'codex', event: 'Stop', sessionId: 's1', cwd: 'C:\\dev\\ganyu-pet' };
const readPre = { source: 'codex', event: 'PreToolUse', sessionId: 's1', toolName: 'Read', cwd: 'C:\\dev\\ganyu-pet' };
const bashPre = { source: 'codex', event: 'PreToolUse', sessionId: 's1', toolName: 'Bash', cwd: 'C:\\dev\\ganyu-pet' };

test('a line and its audio reach the renderer in the same message', async () => {
  const h = speechHarness();
  const shown = h.speech.notify(sessionStart);
  // The decision is still synchronous — only the paint waits for the sound.
  assert.equal(shown.spoken, true);
  assert.equal(h.lines.length, 0, 'nothing is shown while the audio is in flight');
  assert.equal(h.speech.stats().holding, true);

  await tick();

  assert.equal(h.lines.length, 1);
  assert.equal(h.lines[0].kind, 'greeting');
  assert.deepEqual(h.lines[0].audio, EDGE_AUDIO, 'the words carry their own sound');
  assert.deepEqual(h.audio, [], 'and nothing trails behind on the late channel');
  assert.equal(h.speech.stats().holding, false, 'the hold is released with the line');
  assert.equal(h.holding, false, 'and its deadline is cancelled, not left to fire');
});

test('the bubble still waits no longer than the deadline for audio that never comes', async () => {
  // The synthesizer accepts the line and never answers — the socket hang that
  // SPEAK_TIMEOUT_MS bounds at ten seconds, which is far too long to stare at an
  // empty bubble. The hold's own deadline is what cuts it short.
  const h = speechHarness({ speak: () => new Promise(() => {}) });
  h.speech.notify(sessionStart);
  await tick();

  assert.deepEqual(h.lines, [], 'still held');
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, AUDIO_HOLD_MS, 'and held for exactly the deadline');

  assert.equal(h.expire(), 1);
  assert.equal(h.lines.length, 1, 'the deadline shows her anyway');
  assert.equal(h.lines[0].audio, undefined, 'unvoiced, rather than silent and invisible');
  assert.equal(h.speech.stats().holding, false);
});

test('audio that lands after the deadline is played late rather than thrown away', async () => {
  let answer = null;
  const h = speechHarness({ speak: () => new Promise((resolve) => { answer = resolve; }) });
  h.speech.notify(sessionStart);
  await tick();
  h.expire();
  assert.equal(h.lines.length, 1, 'the words are up, unvoiced');

  answer(EDGE_AUDIO); // the endpoint finally came back
  await tick();

  assert.equal(h.lines.length, 1, 'and are not shown a second time');
  assert.equal(h.audio.length, 1, 'the sound follows on the late channel');
  assert.equal(h.audio[0].kind, 'greeting');
  assert.equal(h.audio[0].text, h.lines[0].text);
});

test('a synthesizer that fails shows the line at once, not at the deadline', async () => {
  // Every ordinary failure — refused socket, dead endpoint, voice switched off —
  // resolves null in milliseconds, so the deadline is not what she waits out.
  const h = speechHarness({ speak: () => null });
  h.speech.notify(sessionStart);
  await tick();

  assert.equal(h.lines.length, 1, 'shown as soon as the failure is known');
  assert.equal(h.lines[0].audio, undefined);
  assert.deepEqual(h.audio, []);
  assert.equal(h.holding, false, 'the deadline was cancelled, never reached');
});

test('mute silences the audio as well as the bubble', async () => {
  const h = speechHarness({ muted: true });
  assert.equal(h.speech.notify(sessionStart).reason, 'muted');
  await tick();
  assert.deepEqual(h.spoken, [], 'the synthesizer is never even asked');
  assert.deepEqual(h.audio, []);
});

test('muting while a line is being synthesized still silences it', async () => {
  const h = speechHarness();
  h.speech.notify(sessionStart);
  h.mute(true); // he reached for the menu while the socket was working
  await tick();
  assert.equal(h.spoken.length, 1, 'it was already in flight');
  assert.deepEqual(h.audio, [], 'and it is dropped rather than played');
  assert.equal(h.lines.length, 1, 'the line she had already decided to show still shows');
  assert.equal(h.lines[0].audio, undefined, 'without its sound');
});

test('a muted pet is a quiet pet, not a slow one', async () => {
  // Mute is checked before anything is synthesized, so there is no hold, no
  // deadline and nothing to wait for: her bubbles must not get slower because
  // he asked for silence. (For an ambient line mute means no bubble at all —
  // the chat path is where muting still leaves words on screen.)
  const h = speechHarness({ muted: true });
  assert.equal(h.speech.notify(sessionStart).reason, 'muted');
  assert.deepEqual(h.timers, [], 'nothing was ever scheduled');

  h.mute(false);
  h.advance(QUIET_THROTTLE_MS + 1);
  const shown = h.speech.notify(stop);
  assert.equal(shown.spoken, true, 'and she is audible again immediately after');
  await tick();
  assert.deepEqual(h.lines[0].audio, EDGE_AUDIO);
});

test('a non-salient line makes no sound, because it makes no bubble', async () => {
  const h = speechHarness();
  h.speech.notify(sessionStart); // her first line, out of the way
  await tick();
  h.advance(QUIET_THROTTLE_MS + 1);

  h.speech.notify(readPre); // first tool of the session: no class change, no line
  const routine = h.speech.notify(bashPre); // a class change, but routine work
  assert.equal(routine.spoken, false);
  await tick();

  assert.equal(h.lines.length, 1, 'still only the greeting');
  assert.equal(h.spoken.length, 1, 'and only the greeting was ever synthesized');
});

test('a throttled line makes no sound', async () => {
  const h = speechHarness();
  h.speech.notify(sessionStart);
  await tick();

  const throttled = h.speech.notify(stop); // inside QUIET_THROTTLE_MS
  assert.equal(throttled.reason, 'throttled');
  await tick();

  assert.equal(h.lines.length, 1);
  assert.equal(h.spoken.length, 1, 'a line she did not show is a line she did not synthesize');
});

test('a held line still blocks the next one, exactly as a shown one does', async () => {
  // The throttle reads the moment a line was *decided*, not the moment it was
  // painted. If holding one reset that, a burst would hold several at once and
  // then paint them all.
  const h = speechHarness({ speak: () => new Promise(() => {}) });
  assert.equal(h.speech.notify(sessionStart).spoken, true);
  h.advance(1000);
  assert.equal(h.speech.notify(stop).reason, 'throttled', 'still throttled while held');
  assert.deepEqual(h.lines, []);
  assert.equal(h.timers.filter((x) => !x.cancelled).length, 1, 'one hold, not two');
});

test('a newer line drops the audio of the one it replaced', async () => {
  let release = null;
  const audio = [];
  let t = 1_000_000;
  const speech = createSpeech({
    clock: { now: () => t },
    random: () => 0,
    voice: {
      // The first call hangs until the test lets it go; the second answers at once.
      speak: (text) =>
        release
          ? Promise.resolve({ mime: AUDIO_MIME, base64: 'QkJC', bytes: 3, ms: 1, source: 'edge' })
          : new Promise((resolve) => {
            release = () => resolve({ mime: AUDIO_MIME, base64: 'QUFB', bytes: 3, ms: 1, source: 'edge' });
          }),
    },
    onAudio: (payload) => audio.push(payload),
  });

  speech.notify(sessionStart);
  await tick();
  t += 1; // an urgent kind may interrupt immediately
  speech.notify({ source: 'claude', event: 'Notification', sessionId: 's2', mode: 'waiting' });
  await tick();

  release(); // the greeting's audio finally arrives, after the newer line
  await tick();

  assert.equal(audio.length, 1);
  assert.equal(audio[0].kind, 'waiting', 'the stale greeting audio is dropped');
});

test('an urgent line is never held for its audio', async () => {
  // `waiting` and `failed` are why the pet exists: a permission prompt held back
  // three seconds to wait on a synthesizer is a regression, whatever it buys.
  const h = speechHarness({ speak: () => new Promise(() => {}) });
  const shown = h.speech.notify({ source: 'claude', event: 'Notification', sessionId: 's2', mode: 'waiting' });

  assert.equal(shown.spoken, true);
  assert.equal(h.lines.length, 1, 'on screen synchronously, before any await');
  assert.equal(h.lines[0].kind, 'waiting');
  assert.equal(h.lines[0].audio, undefined, 'and unvoiced for now');
  assert.deepEqual(h.timers, [], 'no hold, so no deadline either');
});

test('an urgent line is voiced late rather than not at all', async () => {
  let answer = null;
  const h = speechHarness({ speak: () => new Promise((resolve) => { answer = resolve; }) });
  h.speech.notify({ source: 'claude', event: 'Notification', sessionId: 's2', mode: 'waiting' });
  await tick();
  assert.deepEqual(h.audio, []);

  answer(EDGE_AUDIO);
  await tick();

  assert.equal(h.audio.length, 1, 'the sound catches up with the words');
  assert.equal(h.audio[0].kind, 'waiting');
});

test('a second line cannot overtake the first one out of order', async () => {
  // A held line and an urgent one that arrives mid-flight. B must not appear
  // before A, and A — now stale — must never overwrite B.
  const answers = [];
  const h = speechHarness({
    speak: (text) => new Promise((resolve) => answers.push({ text, resolve })),
  });

  h.speech.notify(sessionStart); // A: held, waiting on its audio
  await tick();
  assert.deepEqual(h.lines, [], 'A is still waiting');

  h.advance(1);
  h.speech.notify({ source: 'claude', event: 'Notification', sessionId: 's2', mode: 'waiting' }); // B
  await tick();

  assert.deepEqual(h.lines.map((l) => l.kind), ['waiting'], 'B alone, and B first');
  assert.equal(h.speech.stats().holding, false, 'A released the slot it was holding');
  assert.equal(h.timers[0].cancelled, true, "and A's deadline was cancelled with it");

  // A's audio arrives after all that. It belongs to a line that was never shown.
  answers[0].resolve(EDGE_AUDIO);
  await tick();
  assert.deepEqual(h.lines.map((l) => l.kind), ['waiting'], 'A never appears behind B');
  assert.deepEqual(h.audio, [], 'and is not heard either');

  // B's own audio still lands normally.
  answers[1].resolve(EDGE_AUDIO);
  await tick();
  assert.deepEqual(h.audio.map((a) => a.kind), ['waiting']);
});

test("a superseded line's deadline cannot fire behind the line that replaced it", async () => {
  const h = speechHarness({ speak: () => new Promise(() => {}) });
  h.speech.notify(sessionStart);
  await tick();
  h.advance(1);
  h.speech.notify({ source: 'claude', event: 'Notification', sessionId: 's2', mode: 'waiting' });
  await tick();

  assert.equal(h.expire(), 0, 'nothing is left armed to fire');
  assert.deepEqual(h.lines.map((l) => l.kind), ['waiting']);
});

test('dispose() lets go of a line that was waiting on its audio', async () => {
  const h = speechHarness({ speak: () => new Promise(() => {}) });
  h.speech.notify(sessionStart);
  await tick();
  assert.equal(h.speech.stats().holding, true);

  h.speech.dispose();

  assert.equal(h.speech.stats().holding, false);
  assert.equal(h.expire(), 0, 'no timer survives the teardown');
  assert.deepEqual(h.lines, []);
});

test('a voice that fails costs her nothing at all', async () => {
  const lines = [];
  const speech = createSpeech({
    clock: { now: () => 1_000_000 },
    onLine: (line) => lines.push(line),
    random: () => 0,
    voice: {
      speak: async () => {
        throw new Error('the endpoint is on fire');
      },
    },
  });
  assert.equal(speech.notify(sessionStart).spoken, true);
  await tick();
  assert.equal(lines.length, 1, 'the bubble is unaffected');
});

// --------------------------------------------------------------- chat replies

/** registerIpc wired to nothing but the chat channel, which is all these need. */
function chatChannel({ send, onReply = null }) {
  const handlers = new Map();
  registerIpc({
    ipcMain: {
      on: (channel, fn) => handlers.set(channel, fn),
      handle: (channel, fn) => handlers.set(channel, fn),
      removeListener: () => {},
      removeHandler: () => {},
    },
    getWindow: () => null,
    getFlags: () => ({}),
    onMenuAction: () => {},
    getChat: () => ({ send }),
    onReply,
  });
  return (text) => handlers.get('ganyu:chat')({}, text);
}

test('a chat reply comes back with its own audio, so the strip can do both at once', async () => {
  const said = [];
  const ask = chatChannel({
    send: async () => 'Of course, Kahweng.',
    onReply: async (line) => {
      said.push(line);
      return { mime: AUDIO_MIME, base64: 'QUJD' };
    },
  });

  const reply = await ask('are you there?');
  assert.deepEqual(reply, {
    text: 'Of course, Kahweng.',
    audio: { mime: AUDIO_MIME, base64: 'QUJD' },
  });
  assert.deepEqual(said, ['Of course, Kahweng.'], 'and the words are what was synthesized');
});

test('a reply whose audio did not arrive in time is still a reply', async () => {
  // `onReply` resolving null is main saying "the deadline beat the synthesizer".
  // The words must not wait for a second chance.
  const ask = chatChannel({ send: async () => 'Almost done.', onReply: async () => null });
  assert.deepEqual(await ask('hi'), { text: 'Almost done.', audio: null });
});

test('an unsayable reply is still a reply', async () => {
  const thrower = chatChannel({
    send: async () => 'Almost done.',
    onReply: () => {
      throw new Error('no sound card');
    },
  });
  assert.deepEqual(await thrower('hi'), { text: 'Almost done.', audio: null });

  const rejecter = chatChannel({
    send: async () => 'Almost done.',
    onReply: () => Promise.reject(new Error('the endpoint is on fire')),
  });
  assert.deepEqual(await rejecter('hi'), { text: 'Almost done.', audio: null });
});

test('a reply with no voice behind it at all is returned unchanged', async () => {
  const ask = chatChannel({ send: async () => 'Almost done.' });
  assert.deepEqual(await ask('hi'), { text: 'Almost done.', audio: null });
});

test('a null reply is never spoken', async () => {
  const said = [];
  const ask = chatChannel({ send: async () => '   ', onReply: (line) => said.push(line) });
  assert.equal(await ask('hi'), null, 'no reply at all is still a plain null');
  assert.deepEqual(said, []);
});

test('the audio channel is push-only and named beside the others', () => {
  assert.equal(CHANNELS.audio, 'ganyu:audio');
});

// ------------------------------------------------------------ renderer playback

/** The two methods and one property the player touches on an <audio> element. */
function fakeAudioEl() {
  const el = {
    src: '',
    plays: 0,
    pauses: 0,
    loads: 0,
    pause() {
      el.pauses += 1;
    },
    play() {
      el.plays += 1;
      return Promise.resolve();
    },
    load() {
      el.loads += 1;
    },
    removeAttribute() {
      el.src = '';
    },
  };
  return el;
}

test('a line plays as a data URL of the mime main sent', () => {
  const el = fakeAudioEl();
  const player = createVoicePlayer({ el });

  assert.equal(player.play({ mime: AUDIO_MIME, base64: 'QUJD' }), true);
  assert.equal(el.src, 'data:audio/mpeg;base64,QUJD');
  assert.equal(el.plays, 1);
  assert.equal(player.playing, true);
});

test('a new line interrupts the one being spoken rather than queueing behind it', () => {
  const el = fakeAudioEl();
  const player = createVoicePlayer({ el });

  player.play({ mime: AUDIO_MIME, base64: 'QUFB' });
  player.play({ mime: AUDIO_MIME, base64: 'QkJC' });

  assert.equal(el.src, 'data:audio/mpeg;base64,QkJC', 'the newest line is the one playing');
  assert.equal(el.plays, 2);
  assert.ok(el.pauses >= 1, 'the previous line was stopped first');
});

test('the player refuses anything that is not one of the two formats', () => {
  const el = fakeAudioEl();
  const player = createVoicePlayer({ el });

  assert.equal(player.play({ mime: 'text/html', base64: 'PHNjcmlwdD4=' }), false);
  assert.equal(player.play({ mime: AUDIO_MIME, base64: '' }), false);
  assert.equal(player.play(null), false);
  assert.equal(el.src, '', 'nothing reached the element');
  assert.equal(el.plays, 0);
});

test('the local fallback format plays too', () => {
  const el = fakeAudioEl();
  assert.equal(createVoicePlayer({ el }).play({ mime: WAV_MIME, base64: 'QUJD' }), true);
  assert.equal(el.src, 'data:audio/wav;base64,QUJD');
});

test('stop() clears the element so a later play cannot resume the old line', () => {
  const el = fakeAudioEl();
  const player = createVoicePlayer({ el });
  player.play({ mime: AUDIO_MIME, base64: 'QUJD' });
  player.stop();
  assert.equal(el.src, '');
  assert.equal(el.loads, 1);
  assert.equal(player.playing, false);
});

test('an overlay with no audio element is a silent pet, not a broken one', () => {
  const player = createVoicePlayer({ el: null });
  assert.equal(player.play({ mime: AUDIO_MIME, base64: 'QUJD' }), false);
  assert.equal(player.stop(), false);
  assert.equal(player.playing, false);
});

test('an element that throws on play is swallowed', () => {
  const el = fakeAudioEl();
  el.play = () => {
    throw new Error('no output device');
  };
  assert.equal(createVoicePlayer({ el }).play({ mime: AUDIO_MIME, base64: 'QUJD' }), false);
});
