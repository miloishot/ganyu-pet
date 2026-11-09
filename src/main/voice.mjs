// Module V — voice: turns a line she is about to say into audio.
//
// Two sources, exactly like speech.mjs has two: Microsoft Edge's "Read Aloud"
// endpoint is the good one, and a local SAPI synthesizer shelled out to
// PowerShell is the one that works with no network. Neither is allowed to cost
// her anything: `speak()` resolves audio or null, never throws and never
// rejects, so a dead endpoint means she moves her lips and says nothing —
// the bubble is unaffected, because the bubble was never waiting on this.
//
// **Why the network path is the primary one, and must stay that way.** This
// machine is Windows 11 *21H2 (build 22000)*. Windows' modern "natural" voices
// need 22H2 / build 22621, so they cannot be installed here at all: the only
// local voices present are the 2005-era SAPI5 ones (Microsoft David/Zira), which
// sound like a car park announcement. Edge TTS is what makes her sound like a
// person on this hardware. Do not "simplify" this file down to the local path.
//
// Zero dependencies on purpose: Node 24 inside Electron 43 ships a global
// `WebSocket` (undici) that accepts a `headers` option, which is the only thing
// this protocol needs that the browser API cannot do. Everything with a side
// effect — the socket constructor, the clock, the child-process runner, the
// filesystem — is injected, so the tests never open a socket or a process.

import { createHash, randomUUID } from 'node:crypto';

// The only project import here, and a deliberate one: `.env.local` has exactly
// one format, and a second parser for the same file is a second set of rules to
// get subtly wrong. brain.mjs owns it because it got there first.
import { parseEnvFile } from './brain.mjs';

/** Edge's Read Aloud synthesis socket. Not a documented API; it is the one Edge itself uses. */
export const READALOUD_WSS =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';

/** Public constant, baked into every Edge build. Not a secret and not the owner's. */
export const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

/**
 * ⚠️ THE FRAGILE STRING. If she goes silent and the log says the socket was
 * refused (403), **this is the line to change** — it tracks the Edge build
 * number and the endpoint starts rejecting it some time after Edge ships a new
 * one. Read the current value out of a live Edge (or any maintained edge-tts
 * client) and paste it here; nothing else in this file needs touching.
 *
 * Verified answering on 2026-07-31: the voices/list endpoint returned 200 and
 * 322 voices with this exact version string.
 */
export const GEC_VERSION = '1-143.0.3650.75';

/** The rest of the handshake Edge sends. The Origin is Edge's own read-aloud extension id. */
export const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
export const EDGE_ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';

/** 24kHz 48kbit mono MP3 — plays directly in an <audio> element, no decoding step. */
export const AUDIO_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
export const AUDIO_MIME = 'audio/mpeg';

/** What the local SAPI fallback produces instead. Uncompressed, hence the separate mime. */
export const WAV_MIME = 'audio/wav';

/**
 * Her voice.
 *
 * `en-US-AvaMultilingualNeural` — tagged Expressive/Caring/Pleasant/Friendly,
 * scenario "Conversation" (checked against the live voice list, not remembered).
 * Three reasons it beats the alternatives for *this* character:
 *
 *  - Her lines are English. A zh-CN or ja-JP voice reads them with an accent
 *    heavy enough to cost intelligibility, which for a pet whose whole output is
 *    one short sentence is the expensive kind of wrong.
 *  - She is a chronically overworked adeptus secretary, not a child.
 *    `en-US-AnaNeural` is the "cute" English voice and is unmistakably a little
 *    girl; it makes "that is the third failure in a row" read as a joke.
 *  - The *Multilingual* variant pronounces the Liyue vocabulary she actually
 *    uses — Qingxin, Yuehai, Liyue — instead of anglicising it, which the plain
 *    `en-US-AvaNeural` does. Same timbre, better at her own nouns.
 *
 * One key in `.env.local` changes it (`GANYU_VOICE_NAME`); 322 are available.
 */
export const DEFAULT_VOICE = 'en-US-AvaMultilingualNeural';

/**
 * Prosody. Slightly under the default pace because she is formal and unhurried,
 * and because a status line spoken quickly is a status line missed. Pitch is
 * left alone — Ava is already in her register, and pitch-shifting a neural voice
 * is what makes it sound synthetic again.
 */
export const VOICE_RATE = '-5%';
export const VOICE_PITCH = '+0Hz';

/**
 * Timeouts. Measured on this machine: a cold socket opens in 897–1031ms and the
 * first audio on a warm one arrives in 351–1397ms, so these are ~3x the observed
 * worst case rather than tight bounds. They exist to stop a hung socket wedging
 * her permanently, not to police latency — the LLM ahead of this takes 2.5–5s to
 * write the line in the first place, so there is nothing to win below ~500ms.
 */
export const CONNECT_TIMEOUT_MS = 5_000;
export const SPEAK_TIMEOUT_MS = 10_000;

/**
 * Longest line she will ever synthesize. The chat clamp is 240 chars and the
 * ambient one 140, so this is only reached by something that bypassed both.
 */
export const MAX_SPEAK_CHARS = 600;

/** Modes for the `GANYU_VOICE` key. `local` never touches the network. */
export const VOICE_MODES = Object.freeze(['edge', 'local']);

/**
 * `GANYU_VOICE` — three states in one key, because they are three answers to the
 * same question and two keys that can contradict each other is worse than one
 * that cannot.
 *
 *   missing / anything else  -> `edge`  — Edge TTS, local SAPI behind it. **Default on.**
 *   `off` / `0` / `false` / `no` / `mute` / `silent` -> off, she is read only
 *   `local` / `sapi` / `offline` -> the local voice only, no network at all
 *
 * Default on because a pet who can speak and does not is just a slower pet, and
 * because mute already exists for the times he wants quiet — it is a right-click
 * away and it silences the audio with the bubble.
 */
const VOICE_OFF = new Set(['0', 'false', 'no', 'off', 'none', 'mute', 'silent', '']);
const VOICE_LOCAL = new Set(['local', 'sapi', 'offline', 'system']);

/** Same off-spellings as brain.mjs uses, so `.env.local` reads consistently. */
const FALSEY = new Set(['0', 'false', 'no', 'off', 'never', '']);

/**
 * `loadVoiceConfig({envPath, fs, pet})` -> `{enabled, mode, voice, rate, pitch, ambient, reason}`
 *
 * Never throws and has no required keys: a machine with no `.env.local` at all
 * gets the default voice on the default endpoint, which is the whole point —
 * unlike the brain, this needs no credentials from him.
 *
 * **Two sources, and the order between them is deliberate.** `pet.voice` says
 * how this character sounds and travels with the pet; `.env.local` is one
 * person's machine, and it wins. A shared config that could override a local
 * mute would mean installing someone's pet could turn your speakers on.
 */
export function loadVoiceConfig({ envPath = null, fs = null, pet = null } = {}) {
  let env = {};
  if (envPath && fs && typeof fs.readFileSync === 'function') {
    try {
      env = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
    } catch {
      env = {}; // no file is not a misconfiguration, it is the common case
    }
  }

  const petVoice = pet?.voice ?? null;
  const petName = String(petVoice?.name ?? '').trim();
  const petMode = petVoice?.provider === 'local' ? 'local' : 'edge';
  const baseVoice = petName === '' ? DEFAULT_VOICE : petName;

  const raw = String(env.GANYU_VOICE ?? '').trim().toLowerCase();
  if (raw !== '' && VOICE_OFF.has(raw)) {
    return {
      enabled: false, mode: petMode, voice: baseVoice, rate: VOICE_RATE, pitch: VOICE_PITCH,
      ambient: false, reason: 'GANYU_VOICE is off',
    };
  }
  // A pet that declares no voice is a silent pet by design, not a broken one.
  if (petVoice && petVoice.provider === 'none') {
    return {
      enabled: false, mode: 'edge', voice: DEFAULT_VOICE, rate: VOICE_RATE, pitch: VOICE_PITCH,
      ambient: false, reason: 'this pet has no voice',
    };
  }
  const name = String(env.GANYU_VOICE_NAME ?? '').trim();
  return {
    enabled: true,
    mode: raw === '' ? petMode : (VOICE_LOCAL.has(raw) ? 'local' : 'edge'),
    voice: name === '' ? baseVoice : name,
    // Prosody has no env override: it is part of how a character sounds, not a
    // machine preference, and a half-overridden voice is nobody's voice.
    rate: typeof petVoice?.rate === 'string' ? petVoice.rate : VOICE_RATE,
    pitch: typeof petVoice?.pitch === 'string' ? petVoice.pitch : VOICE_PITCH,
    // `GANYU_VOICE_AMBIENT=off` leaves her answering when spoken to and silent
    // the rest of the time — the one half of this feature someone might
    // reasonably not want, since ambient lines arrive unprompted. A key he has
    // not written is a key he has not turned off, exactly as in brain.mjs.
    ambient: env.GANYU_VOICE_AMBIENT == null
      || !FALSEY.has(String(env.GANYU_VOICE_AMBIENT).trim().toLowerCase()),
    reason: null,
  };
}

/**
 * `loadCallConfig({envPath, fs})` -> `{device, mixMic, mic}` — call mode's keys.
 *
 * Read from the same `.env.local` with the same parse rules as
 * `loadVoiceConfig` above, and kept beside it rather than inside it so the
 * voice config's shape stays what every caller already expects.
 *
 *   GANYU_CALL_DEVICE   substring of the output device's label, e.g.
 *                       `Voicemeeter AUX Input` or `CABLE Input`. Blank = none.
 *   GANYU_CALL_MIX_MIC  strictly opt-in, because it opens the microphone: on
 *                       ONLY for `1`/`true`/`yes`/`on` (any case, trimmed).
 *                       Every other value, and a missing key, is off.
 *   GANYU_CALL_MIC      substring of the mic's label; blank = the default input.
 *
 * Never throws. A missing file is no call device, not an error.
 */
/** The only spellings that turn mix mode on. Kept local, not shared with brain.mjs. */
const CALL_MIX_YES = new Set(['1', 'true', 'yes', 'on']);
export const callMixMicFrom = (value) =>
  value != null && CALL_MIX_YES.has(String(value).trim().toLowerCase());

export function loadCallConfig({ envPath = null, fs = null } = {}) {
  let env = {};
  if (envPath && fs && typeof fs.readFileSync === 'function') {
    try {
      env = parseEnvFile(fs.readFileSync(envPath, 'utf8'));
    } catch {
      env = {};
    }
  }
  return {
    device: String(env.GANYU_CALL_DEVICE ?? '').trim(),
    mixMic: callMixMicFrom(env.GANYU_CALL_MIX_MIC),
    mic: String(env.GANYU_CALL_MIC ?? '').trim(),
  };
}

const WS_OPEN = 1;

/**
 * The socket was refused. Named, because the cause is almost always one thing
 * and the fix is almost always one line — see GEC_VERSION above.
 */
export class VoiceAuthError extends Error {
  constructor(detail) {
    super(
      `Edge TTS refused the connection (${detail}). This is nearly always a stale ` +
        `Sec-MS-GEC-Version: bump GEC_VERSION in src/main/voice.mjs (currently ${GEC_VERSION}).`,
    );
    this.name = 'VoiceAuthError';
  }
}

/** Anything else that stopped a socket opening: offline, DNS, TLS, timeout. */
export class VoiceConnectError extends Error {
  constructor(detail) {
    super(`Edge TTS socket did not open (${detail})`);
    this.name = 'VoiceConnectError';
  }
}

/**
 * `Sec-MS-GEC` — uppercase-hex SHA256 of (Windows FILETIME ticks floored to five
 * minutes) concatenated with the trusted client token.
 *
 * FILETIME ticks are 100ns units since 1601-01-01; 11644473600 is the offset
 * from the Unix epoch in seconds. The floor is what makes it deterministic for a
 * fixed clock — every timestamp inside the same five-minute window hashes to the
 * same token, which is also why a test can assert it without freezing the world.
 */
export function secMsGec(nowMs = Date.now(), token = TRUSTED_CLIENT_TOKEN) {
  let seconds = Math.floor(nowMs / 1000) + 11644473600;
  seconds -= seconds % 300;
  return createHash('sha256')
    .update(`${(seconds * 1e7).toFixed(0)}${token}`, 'ascii')
    .digest('hex')
    .toUpperCase();
}

/** The five XML entities. The text is an LLM's, so it may contain any of them. */
export function escapeSsml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** One line of SSML. `xml:lang` follows the voice, which is how Edge picks the phoneme set. */
export function buildSsml({ text, voice = DEFAULT_VOICE, rate = VOICE_RATE, pitch = VOICE_PITCH }) {
  const lang = /^[a-z]{2}-[A-Z]{2}/.test(voice) ? voice.slice(0, 5) : 'en-US';
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${lang}'>` +
    `<voice name='${voice}'><prosody pitch='${pitch}' rate='${rate}'>${escapeSsml(text)}</prosody></voice></speak>`
  );
}

/** Connection URL, including the time-derived token. */
export function socketUrl(nowMs, connectionId) {
  return (
    `${READALOUD_WSS}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${secMsGec(nowMs)}&Sec-MS-GEC-Version=${GEC_VERSION}&ConnectionId=${connectionId}`
  );
}

/** One line, whitespace collapsed and capped. Empty means "nothing to say". */
function cleanText(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return '';
  return text.length > MAX_SPEAK_CHARS ? text.slice(0, MAX_SPEAK_CHARS).trim() : text;
}

/** A 403/401 is worth its own error; everything else is a connection problem. */
function classifyConnectFailure(detail) {
  return /\b(401|403)\b|forbidden|unauthor/i.test(String(detail ?? ''))
    ? new VoiceAuthError(detail)
    : new VoiceConnectError(detail);
}

/** Whatever the socket handed us, as a Buffer. Tolerant of ArrayBuffer, view, or Buffer. */
function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(String(data ?? ''), 'binary');
}

/**
 * Local SAPI, through PowerShell. The fallback that ships with the feature
 * rather than after it: with no network she is otherwise mute, and mute is worse
 * than dated.
 *
 * **`powershell.exe`, never `pwsh`.** `System.Speech` is a .NET Framework
 * assembly; PowerShell 7.x runs on .NET and `Add-Type -AssemblyName System.Speech`
 * fails there. 5.1 is the one that works, and it is present on every Windows.
 *
 * `-EncodedCommand` (base64 UTF-16LE) rather than a quoted command line: the
 * text came from an LLM, and this way no shell ever parses it. Inside the script
 * it is a single-quoted PowerShell literal, which does not interpolate, with
 * embedded quotes doubled — the one escape that string form has.
 */
export function createLocalVoice({
  execFile,
  fs,
  tmpDir,
  now = () => Date.now(),
  timeoutMs = 15_000,
  powershell = 'powershell.exe',
  newId = () => randomUUID().replace(/-/g, ''),
} = {}) {
  const usable = typeof execFile === 'function' && fs && typeof fs.readFileSync === 'function' && tmpDir;

  function script(text, wavPath) {
    const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
    return [
      'Add-Type -AssemblyName System.Speech;',
      '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
      // -1 of a -10..10 scale: the SAPI voices race by default.
      '$s.Rate = -1;',
      `$s.SetOutputToWaveFile(${lit(wavPath)});`,
      `$s.Speak(${lit(text)});`,
      '$s.Dispose()',
    ].join(' ');
  }

  return {
    enabled: Boolean(usable),
    async speak(raw) {
      // `cleanText` has already collapsed every whitespace run to a single space,
      // so there is no newline left to end the one-line script early.
      const text = cleanText(raw);
      if (!usable || text === '') return null;
      const started = now();
      const wavPath = `${tmpDir.replace(/[\\/]+$/, '')}\\ganyu-voice-${newId()}.wav`;
      const encoded = Buffer.from(script(text, wavPath), 'utf16le').toString('base64');
      try {
        await new Promise((resolve, reject) => {
          execFile(
            powershell,
            ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
            { timeout: timeoutMs, windowsHide: true },
            (err) => (err ? reject(err) : resolve()),
          );
        });
        const bytes = fs.readFileSync(wavPath);
        return {
          mime: WAV_MIME,
          base64: Buffer.from(bytes).toString('base64'),
          bytes: bytes.length,
          ms: now() - started,
          source: 'sapi',
        };
      } catch {
        return null;
      } finally {
        try {
          fs.unlinkSync?.(wavPath);
        } catch {
          /* a stray wav in temp is not worth a line of log */
        }
      }
    },
  };
}

/**
 * createVoice({WebSocketImpl, now, voice, mode, fallback, ...})
 *   -> {speak(text, {voice}) -> Promise<{mime, base64, bytes, ms, source}|null>, warm(), close(), stats()}
 *
 * `speak` NEVER throws and NEVER rejects. Every failure — no socket, a refused
 * one, a timeout, a socket that dies mid-sentence — resolves to the fallback's
 * audio if there is one and to `null` if there is not.
 *
 * **One warm socket.** Opening costs ~900ms and synthesizing costs ~350ms, so
 * the connection is kept and reused; a closed one is simply reconnected on the
 * next `speak` rather than on a timer, because a reconnect loop against an
 * endpoint that is refusing us is worse than a slow first line.
 *
 * **Newest wins.** A second `speak` while one is in flight abandons the first
 * (it resolves null immediately): a status line is only worth hearing while it
 * is still true, which is the same reason speech.mjs drops a throttled line
 * instead of queueing it.
 */
export function createVoice({
  WebSocketImpl = globalThis.WebSocket,
  now = () => Date.now(),
  voice = DEFAULT_VOICE,
  rate = VOICE_RATE,
  pitch = VOICE_PITCH,
  mode = 'edge',
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  speakTimeoutMs = SPEAK_TIMEOUT_MS,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (handle) => clearTimeout(handle),
  fallback = null,
  newId = () => randomUUID().replace(/-/g, ''),
  log = null,
} = {}) {
  const localOnly = mode === 'local';
  const canConnect = !localOnly && typeof WebSocketImpl === 'function';
  const speakFallback = typeof fallback?.speak === 'function' ? fallback : null;

  let socket = null;
  let opening = null;
  /** The one request the socket is currently streaming, or null. */
  let active = null;
  let closed = false;
  /**
   * Bumped by every `speak`. A call whose generation is stale has been overtaken
   * by a newer line and must produce nothing at all — not even from the
   * fallback, which is slower than the socket and would otherwise arrive last
   * and speak the line she has already moved on from.
   */
  let generation = 0;
  const counts = { spoken: 0, failed: 0, superseded: 0, fellBack: 0, connects: 0 };
  let lastError = null;

  const warn = (message) => {
    try {
      log?.warn?.(message);
    } catch {
      /* a logger that throws is not a reason to go silent */
    }
  };

  /** End the in-flight request, if any, with `value`. */
  function settleActive(value) {
    const request = active;
    active = null;
    if (!request) return;
    if (request.timer !== null) cancel(request.timer);
    request.timer = null;
    request.resolve(value);
  }

  function dropSocket(reason) {
    const dying = socket;
    socket = null;
    if (dying) {
      try {
        dying.close();
      } catch {
        /* already gone */
      }
    }
    // A socket that died mid-sentence must not leave the caller waiting: a stale
    // one wedging her permanently is the failure this whole module exists to
    // avoid, so the request ends now and the next speak reconnects.
    if (active) {
      lastError = new VoiceConnectError(reason);
      settleActive(null);
    }
  }

  function onMessage(event) {
    const request = active;
    if (!request) return;
    if (typeof event?.data === 'string') {
      if (event.data.includes('Path:turn.end') && event.data.includes(request.id)) {
        settleActive(request.chunks.length ? Buffer.concat(request.chunks) : null);
      }
      return;
    }
    const buf = toBuffer(event?.data);
    if (buf.length < 2) return;
    const headerLength = buf.readUInt16BE(0);
    const headers = buf.subarray(2, 2 + headerLength).toString('ascii');
    // Requests are identified per frame, so audio for a line she has already
    // abandoned cannot be spliced onto the front of the next one.
    if (request.id && headers.includes('X-RequestId') && !headers.includes(request.id)) return;
    const audio = buf.subarray(2 + headerLength);
    if (audio.length) request.chunks.push(Buffer.from(audio));
  }

  /** Open one socket and send the audio-format handshake. Rejects on failure. */
  function openSocket() {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let ws = null;

      const fail = (detail) => {
        if (settled) return;
        settled = true;
        if (timer !== null) cancel(timer);
        try {
          ws?.close();
        } catch {
          /* nothing to close */
        }
        reject(classifyConnectFailure(detail));
      };

      try {
        ws = new WebSocketImpl(socketUrl(now(), newId()), {
          headers: {
            'User-Agent': EDGE_UA,
            Origin: EDGE_ORIGIN,
            Pragma: 'no-cache',
            'Cache-Control': 'no-cache',
          },
        });
      } catch (err) {
        fail(err?.message ?? 'constructor threw');
        return;
      }

      ws.binaryType = 'arraybuffer';
      timer = schedule(() => fail(`no open within ${connectTimeoutMs}ms`), connectTimeoutMs);

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        if (timer !== null) cancel(timer);
        try {
          ws.send(
            `X-Timestamp:${new Date(now()).toISOString()}\r\n` +
              'Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' +
              JSON.stringify({
                context: {
                  synthesis: {
                    audio: {
                      metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                      outputFormat: AUDIO_FORMAT,
                    },
                  },
                },
              }),
          );
        } catch (err) {
          fail(err?.message ?? 'config send failed');
          return;
        }
        counts.connects += 1;
        resolve(ws);
      };

      ws.onmessage = onMessage;
      ws.onerror = (event) => {
        const detail = event?.message ?? event?.error?.message ?? 'socket error';
        if (settled) {
          lastError = classifyConnectFailure(detail);
          dropSocket(detail);
          return;
        }
        fail(detail);
      };
      ws.onclose = (event) => {
        const detail = `closed ${event?.code ?? ''} ${event?.reason ?? ''}`.trim();
        if (settled) {
          if (socket === ws) dropSocket(detail);
          return;
        }
        fail(detail);
      };
    });
  }

  async function ensureSocket() {
    if (socket && socket.readyState === WS_OPEN) return socket;
    if (!opening) {
      opening = openSocket()
        .then((ws) => {
          socket = ws;
          return ws;
        })
        .finally(() => {
          opening = null;
        });
    }
    return opening;
  }

  /** The Edge path for one line. Resolves audio bytes, or null on any failure. */
  async function synthesize(text, voiceName) {
    let ws;
    try {
      ws = await ensureSocket();
    } catch (err) {
      lastError = err;
      warn(`[ganyu][voice] ${err.message}`);
      return null;
    }

    const id = newId();
    return new Promise((resolve) => {
      const request = { id, chunks: [], resolve, timer: null, done: false };
      active = request;
      request.timer = schedule(() => {
        if (active !== request) return;
        lastError = new VoiceConnectError(`no audio within ${speakTimeoutMs}ms`);
        // Drop the socket as well: something is wrong with this connection, and
        // a wedged one would make every later line time out too.
        dropSocket('speak timeout');
      }, speakTimeoutMs);

      try {
        ws.send(
          `X-RequestId:${id}\r\nContent-Type:application/ssml+xml\r\n` +
            `X-Timestamp:${new Date(now()).toISOString()}Z\r\nPath:ssml\r\n\r\n` +
            buildSsml({ text, voice: voiceName, rate, pitch }),
        );
      } catch (err) {
        lastError = new VoiceConnectError(err?.message ?? 'send failed');
        dropSocket('send failed');
      }
    });
  }

  return {
    /** False when this instance can never produce Edge audio (no WebSocket, or local mode). */
    enabled: canConnect || Boolean(speakFallback),
    mode: localOnly ? 'local' : 'edge',
    voice,

    /**
     * Open the socket before there is anything to say. Called once at startup:
     * her first line of the evening is a greeting that arrives seconds later, and
     * this is the ~900ms it would otherwise wait for.
     */
    async warm() {
      if (localOnly || closed || !canConnect) return false;
      try {
        await ensureSocket();
        return true;
      } catch {
        return false; // she will simply pay for the connection on the first line
      }
    },

    async speak(text, { voice: override = null } = {}) {
      const line = cleanText(text);
      if (line === '' || closed) return null;

      // Newest wins. The previous line resolves null and its caller drops it.
      const mine = (generation += 1);
      if (active) {
        counts.superseded += 1;
        settleActive(null);
      }

      const started = now();
      let bytes = null;
      if (canConnect) {
        try {
          bytes = await synthesize(line, override || voice);
        } catch (err) {
          // synthesize is written not to throw; this is the belt to its braces.
          lastError = err instanceof Error ? err : new VoiceConnectError(String(err));
          bytes = null;
        }
      }

      if (generation !== mine) return null; // overtaken while we were synthesizing

      if (bytes && bytes.length) {
        counts.spoken += 1;
        return {
          mime: AUDIO_MIME,
          base64: bytes.toString('base64'),
          bytes: bytes.length,
          ms: now() - started,
          source: 'edge',
        };
      }

      counts.failed += 1;
      if (!speakFallback) return null;
      try {
        const local = await speakFallback.speak(line);
        if (generation !== mine) return null;
        if (local) counts.fellBack += 1;
        return local ?? null;
      } catch {
        return null; // the fallback is the last resort; there is nothing after it
      }
    },

    stats() {
      return {
        ...counts,
        mode: localOnly ? 'local' : 'edge',
        voice,
        connected: Boolean(socket && socket.readyState === WS_OPEN),
        lastError: lastError ? { name: lastError.name, message: lastError.message } : null,
      };
    },

    /** Teardown. Ends any in-flight line rather than leaving its promise hanging. */
    close() {
      closed = true;
      settleActive(null);
      dropSocket('closed');
    },
  };
}

export default createVoice;
