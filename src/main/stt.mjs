// Module S — speech-to-text: turns a few seconds of him talking into the string
// that goes to `chat.send()`. The listening half of push-to-talk; the mic
// capture, the hotkey and the IPC that carry the audio here live elsewhere.
//
// Same contract as voice.mjs and brain.mjs, and for the same reason: `transcribe`
// resolves a string or `null`, and NEVER throws or rejects. A failed
// transcription costs him one turn — he lets go of the key, nothing appears, he
// tries again or types it. A thrown one would take the pet down while his finger
// is still on the button, which is a far worse trade than a lost sentence.
//
// **This does not go to the endpoint the brain uses.** Measured against the
// owner's proxy (api2cn): `/v1/audio/transcriptions` 404s there — it serves text
// and nothing else. So transcription goes to OpenAI directly, on its own key
// (`GANYU_STT_*`), and the two config blocks in `.env.local` are deliberately
// separate: one endpoint answering is no evidence at all about the other.
//
// **whisper-1 is the FASTER model, not the slower one.** Measured on this
// machine against one 5.7-second WAV:
//
//   | model              | latency  | transcript                        |
//   |--------------------|----------|-----------------------------------|
//   | gpt-4o-transcribe  | 3,815 ms | exact                             |
//   | whisper-1          | 2,899 ms | "promo code's" for "promo codes"   |
//
// Written down because the intuitive assumption is the opposite — the newer,
// bigger-sounding model must be the slow one — and that assumption was recorded
// here wrongly once already. `gpt-4o-transcribe` is the default anyway: ~900ms
// buys an exact transcript, and a transcript with a wrong word in it is a
// message he has to notice, delete and retype, which costs far more than 900ms.
// `GANYU_STT_MODEL=whisper-1` in `.env.local` takes the other trade.
//
// Zero dependencies: Node 24 inside Electron 43 has global `FormData`, `Blob` and
// `fetch`, which is the whole of the multipart request. `fetch`, the clock and
// the timeout are injected, so no test here opens a socket.

import nodeFs from 'node:fs';

import { parseEnvFile } from './brain.mjs';

/** The one route. Not on the brain's endpoint — see the header. */
export const TRANSCRIPTIONS_PATH = '/v1/audio/transcriptions';

/** Used when `.env.local` names only the key, which is the one thing unguessable. */
export const DEFAULT_BASE_URL = 'https://api.openai.com';
export const DEFAULT_MODEL = 'gpt-4o-transcribe';

/** The only key with no default. Everything else here has a sensible one. */
export const REQUIRED_KEY = 'GANYU_STT_API_KEY';

/**
 * How long he will be left standing there.
 *
 * Three measurements, all on `gpt-4o-transcribe` and all against the live
 * endpoint: 3,815ms on a 5.7-second clip, then 5,003ms and 2,689ms on the *same*
 * 8-second clip back to back. Note what the last pair says — the spread between
 * two identical requests is larger than the difference between two clip lengths,
 * because the first one pays for the TLS connection. So the thing to size this
 * against is a cold request, not a long one.
 *
 * A push-to-talk utterance is nearer 3 seconds, well under every clip above, and
 * 8 seconds is ~1.6x the slowest thing measured on audio almost three times its
 * length. A merely slow transcription still lands; only a stalled one is dropped.
 *
 * The ceiling matters more than the floor here, and not because of this request:
 * the transcript goes straight on to `chat.send()`, whose brain has its own
 * 10s (brain.REQUEST_TIMEOUT_MS). Those stack. 8 + 10 = 18 seconds of watching a
 * pet think is already at the edge of what a person will sit through; matching
 * the brain's 10s here would make it 20 and buy nothing, since anything that has
 * not answered in 8 was not going to.
 */
export const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Audio this module will refuse to send. OpenAI's own limit is 25MB, which this
 * is nowhere near on purpose: 4MiB is ~45 seconds of uncompressed 48kHz 16-bit
 * mono WAV and many minutes of the Opus the renderer's MediaRecorder will
 * actually produce. An utterance cannot reach it. Only a bug can — a recorder
 * that never stopped, a whole buffer sent instead of one slice — and the point
 * of refusing before the request is that such a bug costs nothing and says so in
 * the log, instead of arriving as a slow, expensive, mysterious failure.
 */
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

/**
 * Longest transcript handed back. Deliberately the same 500 as
 * `chat.MAX_INPUT_CHARS`: what he sees in the box should be what gets sent, not
 * something a later layer silently shortens. Nothing he says holding a key down
 * comes close.
 */
export const MAX_TRANSCRIPT_CHARS = 500;

/**
 * Container extensions OpenAI accepts, by mime type. This is not cosmetic
 * bookkeeping — the API reads the format off the *filename*, so a blob posted as
 * `blob` or `file` is rejected as an unsupported format however good the audio
 * inside it is.
 */
export const EXTENSIONS = Object.freeze({
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
});

/** What a Chromium `MediaRecorder` produces with no options, so what to assume. */
export const DEFAULT_EXTENSION = 'webm';

const ACCEPTED = new Set(Object.values(EXTENSIONS));

/**
 * loadSttConfig({envPath, fs}) -> {enabled, baseUrl, model, apiKey, reason}
 *
 * Never throws. A missing file, an unreadable one or an empty key all mean the
 * same thing — no push-to-talk, and a pet that is otherwise entirely unaffected.
 * `reason` names the missing key and never carries a value, so the config object
 * is safe to log apart from `apiKey`.
 */
export function loadSttConfig({ envPath = null, fs = nodeFs } = {}) {
  const off = (reason) => ({
    enabled: false,
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    apiKey: '',
    reason,
  });

  if (!envPath) return off('no env path');
  let text = null;
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch {
    return off('no .env.local');
  }

  const env = parseEnvFile(text);
  const apiKey = String(env[REQUIRED_KEY] ?? '').trim();
  if (apiKey === '') return off(`missing ${REQUIRED_KEY}`);

  return {
    enabled: true,
    baseUrl: (String(env.GANYU_STT_BASE_URL ?? '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: String(env.GANYU_STT_MODEL ?? '').trim() || DEFAULT_MODEL,
    apiKey,
    reason: null,
  };
}

/** The container extension for a mime type, `codecs=` parameter and all. */
export function extensionFor(mimeType) {
  const type = String(mimeType ?? '').split(';')[0].trim().toLowerCase();
  return EXTENSIONS[type] ?? DEFAULT_EXTENSION;
}

/**
 * The name the audio part is posted under. Always ends in an extension OpenAI
 * recognises — see EXTENSIONS for why that is load-bearing. A caller-supplied
 * name is kept only if it already carries an accepted one; anything else keeps
 * its stem and gets the extension the mime type implies.
 */
export function fileNameFor({ mimeType = '', fileName = '' } = {}) {
  const raw = String(fileName ?? '').trim().replace(/[\\/:]/g, '');
  const dot = raw.lastIndexOf('.');
  const given = dot > 0 ? raw.slice(dot + 1).toLowerCase() : '';
  if (given !== '' && ACCEPTED.has(given)) return raw;
  const stem = (dot > 0 ? raw.slice(0, dot) : raw) || 'utterance';
  return `${stem}.${extensionFor(mimeType)}`;
}

/**
 * Whatever the caller had, as bytes. Buffers and views come from the main
 * process; a base64 string comes from the renderer, because IPC cannot carry a
 * Blob and base64 is already how voice.mjs moves audio the other way. A
 * `data:` prefix is tolerated for the same reason — `FileReader.readAsDataURL`
 * is the obvious way to produce that string and its output starts with one.
 */
function bytesOf(audio) {
  if (audio == null) return null;
  if (Buffer.isBuffer(audio)) return audio;
  if (audio instanceof ArrayBuffer) return Buffer.from(new Uint8Array(audio));
  if (ArrayBuffer.isView(audio)) return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  if (typeof audio === 'string') {
    return Buffer.from(audio.replace(/^data:[^,]*,/, ''), 'base64');
  }
  return null;
}

/**
 * One line, whitespace collapsed and capped. Empty means silence, and silence is
 * not an utterance — an empty string sent to `chat.send()` would be a message he
 * never spoke, which is worse than no message at all.
 */
export function cleanTranscript(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  return text.length > MAX_TRANSCRIPT_CHARS ? text.slice(0, MAX_TRANSCRIPT_CHARS).trim() : text;
}

/**
 * createStt({config, fetchImpl, log, now, timeoutMs})
 *   -> {transcribe({audio, mimeType, fileName}) -> Promise<string|null>, isEnabled, stats}
 *
 * **Single-flight, and a refusal rather than a queue.** A second `transcribe`
 * while one is in flight resolves null immediately. Queueing would deliver a
 * transcript of something he said several seconds ago into a conversation he has
 * already moved on from — the same argument speech.mjs makes for dropping a
 * throttled line and voice.mjs makes for abandoning a superseded one. In
 * practice it also cannot legitimately happen: one key, one mouth.
 *
 * Note the asymmetry with voice.mjs, which is newest-wins. There the newest line
 * is the one worth hearing; here the *first* call is the one whose audio has
 * already been recorded and paid for, and the second is a double-press.
 */
export function createStt({
  config,
  fetchImpl = globalThis.fetch,
  log = null,
  now = Date.now,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const baseUrl = String(config?.baseUrl ?? '').replace(/\/+$/, '');
  const model = String(config?.model ?? '');
  const apiKey = String(config?.apiKey ?? '');

  let disabled =
    !config?.enabled || !baseUrl || !model || !apiKey || typeof fetchImpl !== 'function';
  let inFlight = false;
  let lastLatencyMs = null;
  let lastError = null;
  const counts = { calls: 0, transcribed: 0, silent: 0, rejected: 0, dropped: 0, failed: 0 };

  const say = (level, message) => {
    try {
      log?.[level]?.(`[ganyu][stt] ${message}`);
    } catch {
      /* a broken logger must not cost him the transcript */
    }
  };

  async function request(bytes, mimeType, fileName) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const form = new FormData();
      // The filename is the format declaration — see EXTENSIONS.
      form.append('file', new Blob([bytes], { type: mimeType }), fileName);
      form.append('model', model);

      const res = await fetchImpl(`${baseUrl}${TRANSCRIPTIONS_PATH}`, {
        method: 'POST',
        // Authorization only. Setting `content-type` by hand here is the classic
        // way to break this request: FormData supplies it *with the multipart
        // boundary*, and a hand-written one has no boundary for the server to
        // split the parts on.
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
        signal: controller.signal,
      });

      const status = Number(res?.status);
      if (status === 401 || status === 403) {
        // Permanent for the process, exactly as brain.mjs treats its endpoint:
        // a rejected key is not a bad minute, it is a wrong file, and retrying it
        // on every press only fills the log. Said once, because `disabled` makes
        // this branch unreachable a second time. No key and no URL in the line.
        disabled = true;
        lastError = { name: 'SttAuthError' };
        say(
          'warn',
          `the transcription endpoint rejected the key (${status}) — push-to-talk is off for `
          + `this session. Check ${REQUIRED_KEY} in .env.local; it is a separate OpenAI key `
          + 'from the brain\'s, because the brain\'s endpoint does not serve audio at all.',
        );
        return null;
      }
      if (!Number.isFinite(status) || status < 200 || status >= 300) {
        lastError = { name: `HTTP ${status}` };
        say('warn', `endpoint answered ${status} — no transcript this time`);
        return null;
      }

      const json = await res.json();
      return typeof json?.text === 'string' ? json.text : null;
    } catch (err) {
      // Name only. A fetch error's message carries the endpoint URL, and the
      // same habit that keeps the URL out keeps everything else out too.
      lastError = { name: err?.name ?? 'error' };
      say('warn', `request failed (${err?.name ?? 'error'}) — no transcript this time`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    isEnabled: () => !disabled,

    async transcribe({ audio = null, mimeType = '', fileName = '' } = {}) {
      counts.calls += 1;
      if (disabled) {
        counts.rejected += 1;
        return null;
      }
      if (inFlight) {
        counts.dropped += 1;
        return null;
      }

      const bytes = bytesOf(audio);
      if (!bytes || bytes.length === 0) {
        counts.rejected += 1;
        return null;
      }
      if (bytes.length > MAX_AUDIO_BYTES) {
        counts.rejected += 1;
        lastError = { name: 'SttTooLarge' };
        say(
          'warn',
          `refusing ${bytes.length} bytes of audio (ceiling ${MAX_AUDIO_BYTES}) — an utterance `
          + 'is orders of magnitude smaller than this, so something upstream is recording when '
          + 'it should not be',
        );
        return null;
      }

      inFlight = true;
      const started = now();
      try {
        const raw = await request(bytes, String(mimeType ?? ''), fileNameFor({ mimeType, fileName }));
        const text = cleanTranscript(raw);
        if (raw === null) counts.failed += 1;
        else if (text === null) counts.silent += 1;
        else counts.transcribed += 1;
        return text;
      } catch (err) {
        // `request` is written not to throw; this is the belt to its braces, and
        // it is the last thing between a bad response body and a dead pet.
        counts.failed += 1;
        lastError = { name: err?.name ?? 'error' };
        return null;
      } finally {
        lastLatencyMs = now() - started;
        inFlight = false;
      }
    },

    /** Introspection for tests and the log. Carries no config values. */
    stats() {
      return { enabled: !disabled, inFlight, lastLatencyMs, lastError, ...counts };
    },
  };
}

export default createStt;
