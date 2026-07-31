// Module D (optional) — brain: turns a hook event into an in-character line, and
// a message the owner typed into an in-character reply, via the owner's own
// OpenAI-compatible endpoint.
//
// Everything here is best-effort. The deterministic MESSAGES table in
// persona.mjs remains the real speech path; the brain only ever improves on it,
// so every failure mode — no config, wrong route, bad key, timeout, garbage
// JSON — resolves to `null` and speech falls back to the canned line. It never
// throws and never rejects.
//
// Privacy: event metadata leaves the machine (event kind, tool name, project
// name — see persona.buildBrainInput), plus, on the chat path, the message the
// owner typed himself, her own past replies, and the three memory digests
// (`getMemory`) — the ledger's, itself built only from the metadata above; the
// session vault's, which is a note title, a date and the owner's own `Left open`
// bullets; and the topic vaults', which is section and note *names* from a
// module that never opens a file.
//
// One thing here is his own writing rather than his machine's: since 2026-07-31,
// at his explicit request, the briefing carries the text of his most recent
// `UserPromptSubmit` — bounded, redacted and switchable (see `readContext` and
// `GANYU_SEE_PROMPTS`). Everything else is unchanged: no file contents, no
// diffs, no subagent brief, no transcript. `store: false` asks the endpoint not
// to retain the exchange, matching the owner's
// `disable_response_storage` setting. The key is
// read from disk at runtime, never logged, and never placed in an error message
// — which is also why failures are reported by error *name* only, since a fetch
// error's message carries the endpoint URL.
//
// No Electron import; fetch, the clock and the timeout are injectable.

import fs from 'node:fs';

import {
  BRAIN_INSTRUCTIONS,
  CHAT_INSTRUCTIONS,
  buildBrainInput,
  buildChatInput,
  clampLine,
} from './persona.mjs';

/** Long enough for a slow first token, short enough that a stale line never lands. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Hard cap on a generated line. The prompt asks for 120; this is the backstop. */
export const MAX_BRAIN_LINE_CHARS = 140;

/**
 * The same backstop for a chat reply, and deliberately not the same number. An
 * answer to a question needs about twice an ambient remark's room (the chat
 * prompt asks for under 200 — persona.CHAT_LINE_TARGET_CHARS), and clamping it
 * at 140 would cut her off mid-sentence every time he asked her anything.
 */
export const MAX_CHAT_LINE_CHARS = 240;

/**
 * Route order. The endpoint is a Responses-API proxy (the owner's codex config
 * sets `wire_api = "responses"`), but it serves chat completions too — probed
 * live, both answer 401 unauthenticated, so both exist. Try the native one
 * first and fall back only on 404/405, i.e. "this route is not here".
 */
export const ROUTES = Object.freeze({
  responses: '/v1/responses',
  chat: '/v1/chat/completions',
});
const ROUTE_ORDER = ['responses', 'chat'];

/**
 * Generous because on the Responses API reasoning tokens are charged against
 * this budget too — a cap tight enough for a 140-char line can be spent
 * entirely on reasoning and return empty output. The line itself measured at
 * most 62 tokens live, so this is headroom for the thinking, not for the line;
 * it is a ceiling, not a spend, and lowering it only buys empty replies.
 */
const MAX_OUTPUT_TOKENS = 300;

/**
 * The same headroom logic for chat: the reply itself is at most ~60 tokens, and
 * the rest is the reasoning budget the Responses API bills against this cap. A
 * chat reply is a real question answered rather than a remark made, so it is
 * given more room to think in — and, as above, this is a ceiling and not a
 * spend.
 */
const MAX_CHAT_OUTPUT_TOKENS = 500;

/** What each request kind asks for and what it will accept back. */
const AMBIENT_LIMITS = Object.freeze({ maxChars: MAX_BRAIN_LINE_CHARS, maxTokens: MAX_OUTPUT_TOKENS });
const CHAT_LIMITS = Object.freeze({ maxChars: MAX_CHAT_LINE_CHARS, maxTokens: MAX_CHAT_OUTPUT_TOKENS });

/** The three keys `.env.local` must carry for the brain to be usable. */
export const REQUIRED_KEYS = Object.freeze([
  'GANYU_OPENAI_BASE_URL',
  'GANYU_OPENAI_MODEL',
  'GANYU_OPENAI_API_KEY',
]);

/**
 * Reasoning effort for the Responses API. Measured on the owner's endpoint:
 * `low` answered in 3.0s against 5.5s for the model's default, and wrote better
 * lines — a status bubble is not a puzzle, and a stale line is a wrong line.
 * Optional `GANYU_OPENAI_REASONING_EFFORT` in `.env.local` overrides it;
 * `none` omits the field entirely, for a model that rejects it.
 */
export const DEFAULT_REASONING_EFFORT = 'low';
const NO_REASONING = new Set(['none', 'off', 'default', '']);

/**
 * `GANYU_SEE_PROMPTS` in `.env.local` — whether the text the owner typed into his
 * agent may travel with the briefing. **Default on**: he asked for it on
 * 2026-07-31, and a key he has not written is a key he has not turned off.
 *
 * Any of these spellings turns it off; everything else, including a missing key
 * and an unparseable one, leaves it on. The switch is honoured *here*, at the
 * last point before the request is built, rather than in context.mjs where the
 * prompt is extracted: this is the network boundary, so there is exactly one
 * place to reach for the field and exactly one place that can refuse it.
 */
const FALSEY = new Set(['0', 'false', 'no', 'off', 'never', '']);
export const seePromptsFrom = (value) =>
  value == null || !FALSEY.has(String(value).trim().toLowerCase());

/** Minimal KEY=VALUE parser: blank lines and `#` comments skipped, values trimmed. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/**
 * loadBrainConfig({envPath}) -> {enabled:false, reason} | {enabled:true, baseUrl, model, apiKey}
 *
 * A missing file, an unreadable file or any missing/empty required key simply
 * means "no brain" — the pet still talks. `reason` names the missing key; it
 * never carries a value, so the whole config object is safe to log except for
 * the three fields above.
 */
export function loadBrainConfig({ envPath } = {}) {
  if (!envPath) return { enabled: false, reason: 'no env path' };
  let text = null;
  try {
    text = fs.readFileSync(envPath, 'utf8');
  } catch {
    return { enabled: false, reason: 'no .env.local' };
  }

  const env = parseEnvFile(text);
  const missing = REQUIRED_KEYS.filter((k) => !env[k]);
  if (missing.length) return { enabled: false, reason: `missing ${missing.join(', ')}` };

  return {
    enabled: true,
    baseUrl: env.GANYU_OPENAI_BASE_URL.replace(/\/+$/, ''),
    model: env.GANYU_OPENAI_MODEL,
    apiKey: env.GANYU_OPENAI_API_KEY,
    reasoningEffort: env.GANYU_OPENAI_REASONING_EFFORT || DEFAULT_REASONING_EFFORT,
    seePrompts: seePromptsFrom(env.GANYU_SEE_PROMPTS),
  };
}

/** Responses API: the SDK shorthand, else walk the output items. */
function textFromResponses(json) {
  if (typeof json?.output_text === 'string') return json.output_text;
  for (const item of Array.isArray(json?.output) ? json.output : []) {
    if (item?.type !== 'message') continue;
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (part?.type === 'output_text' && typeof part.text === 'string') return part.text;
    }
  }
  return '';
}

function textFromChat(json) {
  const content = json?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : '';
}

/**
 * One line, at most `max` characters, word-boundary truncation. Empty -> null.
 * Defaults to the ambient cap; the chat path passes MAX_CHAT_LINE_CHARS, which
 * is the whole reason this takes a parameter at all.
 */
export function postProcess(text, max = MAX_BRAIN_LINE_CHARS) {
  const line = clampLine(text, max);
  return line === '' ? null : line;
}

/**
 * createBrain({config, fetchImpl, now, log, timeoutMs, getContext})
 *   -> {requestLine, requestChat, isEnabled, stats}
 *
 * `requestLine({detail, summary})` resolves to an ambient status line or to null.
 * `requestChat({text, history})` resolves to a reply to something the owner
 * typed, or to null. Neither ever rejects.
 *
 * `getContext` is optional: module A injects a reader over module B's debug ring
 * and aggregate (see context.mjs), and its result is what turns "Claude Code is
 * about to run Edit" into a briefing she can actually say something about. It is
 * called once per request, so the facts are current; a getter that throws is
 * treated as no context at all.
 *
 * `getMemory` is the same shape and the same failure semantics, for recall
 * rather than for the present moment: `{ledger, vault, topics}` — what she wrote
 * down, what he left open in his own session notes, and a map of where things
 * are documented in his reference vaults. **It is read on the chat path only**
 * — see persona.buildChatInput for why an ambient remark is worse for having it.
 */
export function createBrain({
  config,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  log = null,
  timeoutMs = REQUEST_TIMEOUT_MS,
  getContext = null,
  getMemory = null,
} = {}) {
  const baseUrl = String(config?.baseUrl ?? '').replace(/\/+$/, '');
  const model = String(config?.model ?? '');
  const apiKey = String(config?.apiKey ?? '');
  const effort = String(config?.reasoningEffort ?? DEFAULT_REASONING_EFFORT).trim().toLowerCase();
  // Absent means on: a brain constructed from a hand-built config in a test, or
  // from a `.env.local` written before the key existed, behaves as he asked.
  const seePrompts = config?.seePrompts !== false;

  // A brain with nothing to call is born disabled rather than special-cased at
  // every call site: speech treats "returns null forever" identically to absent.
  let disabled =
    !config?.enabled || !baseUrl || !model || !apiKey || typeof fetchImpl !== 'function';
  let route = null; // the route that last answered, remembered for the process
  /**
   * Single-flight **per kind**, not one latch for the brain.
   *
   * One shared latch was right while the only caller was the ambient path, where
   * a dropped request costs a status line nobody asked for. It is wrong now that
   * the owner can type: a hook event landing a few milliseconds before he presses
   * Enter would swallow his message, and he would watch the pending bubble
   * resolve to nothing for no reason he could see. His message is the one request
   * that must not be dropped for the machine's convenience — and the reverse
   * holds too, since a chat reply he is reading should not silence her for the
   * rest of the exchange.
   *
   * Within each kind the original argument is unchanged: a second ambient event
   * still gets its canned line rather than a queued one about work already
   * finished, and a second chat message is refused by chat.mjs before it reaches
   * here.
   */
  const inFlight = { ambient: false, chat: false };
  let calls = 0;
  let lastLatencyMs = null;

  const say = (level, message) => {
    try {
      log?.[level]?.(`[ganyu] ${message}`);
    } catch {
      /* a broken logger must not break the pet */
    }
  };

  function bodyFor(kind, instructions, input, limits) {
    if (kind === 'responses') {
      return {
        model,
        instructions,
        input,
        max_output_tokens: limits.maxTokens,
        store: false,
        // Chat completions has no such parameter, so this stays on this branch.
        ...(NO_REASONING.has(effort) ? {} : { reasoning: { effort } }),
      };
    }
    return {
      model,
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: input },
      ],
      max_tokens: limits.maxTokens,
    };
  }

  /**
   * One HTTP attempt. Verdict flags rather than exceptions, so the caller can
   * tell "wrong route" from "wrong key" from "just didn't work this time":
   *   {absent}  404/405 — try the next route
   *   {fatal}   401/403 — the key is wrong, stop asking forever
   *   {ok,text} 2xx     — this route works; `text` may be null
   *   {}        anything else, including a timeout
   */
  async function attempt(kind, instructions, input, limits) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}${ROUTES[kind]}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(bodyFor(kind, instructions, input, limits)),
        signal: controller.signal,
      });
      const status = Number(res?.status);
      if (!Number.isFinite(status)) return {};
      if (status === 404 || status === 405) return { absent: true };
      if (status === 401 || status === 403) return { fatal: true };
      if (status < 200 || status >= 300) return {};
      const json = await res.json();
      const raw = kind === 'responses' ? textFromResponses(json) : textFromChat(json);
      return { ok: true, text: postProcess(raw, limits.maxChars) };
    } catch (err) {
      // Name only: a fetch error's message contains the endpoint URL.
      say('warn', `brain: request failed (${err?.name ?? 'error'}) — using the canned line`);
      return {};
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The world around the event, or nothing. Never the reason a line fails to
   * appear.
   *
   * This is also where `GANYU_SEE_PROMPTS` is honoured. `prompts` is the only
   * field in the context object that is the owner's own writing rather than his
   * machine's metadata, so it is the only one with a switch — and stripping it
   * here means the switch sits on the single path to the network, with nothing
   * downstream able to route around it.
   */
  function readContext() {
    if (typeof getContext !== 'function') return null;
    try {
      const context = getContext();
      if (!context || typeof context !== 'object') return null;
      return seePrompts ? context : { ...context, prompts: [] };
    } catch (err) {
      say('warn', `brain: context unavailable (${err?.name ?? 'error'})`);
      return null;
    }
  }

  /** What she remembers, or nothing. Same contract: an answer, never an exception. */
  function readMemory() {
    if (typeof getMemory !== 'function') return null;
    try {
      const memory = getMemory();
      return memory && typeof memory === 'object' ? memory : null;
    } catch (err) {
      say('warn', `brain: memory unavailable (${err?.name ?? 'error'})`);
      return null;
    }
  }

  /**
   * Walk the routes for one prompt and return the text, or null. Shared by both
   * request kinds so the transport rules — route order, the remembered route, a
   * 404/405 meaning "try the next one", a 401/403 disabling the brain outright —
   * are written once and cannot drift apart between them.
   */
  async function exchange(instructions, input, limits) {
    const order = route ? [route, ...ROUTE_ORDER.filter((r) => r !== route)] : ROUTE_ORDER;
    for (const kind of order) {
      const verdict = await attempt(kind, instructions, input, limits);
      if (verdict.absent) continue;
      if (verdict.fatal) {
        disabled = true;
        say('warn', 'brain: endpoint rejected the key — falling back to canned lines');
        return null;
      }
      if (!verdict.ok) return null;
      route = kind;
      return verdict.text ?? null;
    }
    return null;
  }

  /**
   * The ambient path: a hook event became a briefing, and she remarks on it.
   * A second event while one is in flight gets its canned line and nothing else —
   * queueing would only ever deliver a line describing something the owner has
   * already watched finish. A chat message in flight does not block it.
   */
  async function requestLine({ detail = {}, summary = null } = {}) {
    if (disabled || inFlight.ambient) return null;
    inFlight.ambient = true;
    const started = now();
    try {
      const context = readContext();
      const input = buildBrainInput(context ? { ...detail, context } : detail, summary);
      return await exchange(BRAIN_INSTRUCTIONS, input, AMBIENT_LIMITS);
    } catch {
      return null; // requestLine is a promise of a line or null, never a rejection
    } finally {
      calls += 1;
      lastLatencyMs = now() - started;
      inFlight.ambient = false;
    }
  }

  /**
   * The chat path: the owner typed something and is waiting. Same transport,
   * same persona, a longer answer, and its own latch (see `inFlight`).
   *
   * `text` is his message; `history` is the conversation before it, oldest
   * first, from chat.mjs. The context read is the same one the ambient path
   * uses, so "what am I doing" and "what broke" have facts to draw on — and the
   * same allowlist, so they are still only facts context.mjs was willing to
   * share. Memory is read here and only here, so "what broke *earlier*" and
   * "what was I in the middle of" have something older than the last twenty
   * minutes behind them. An empty message never becomes a request.
   */
  async function requestChat({ text = '', history = [] } = {}) {
    const message = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (disabled || inFlight.chat || message === '') return null;
    inFlight.chat = true;
    const started = now();
    try {
      const context = readContext();
      const input = buildChatInput({ text: message, history, context, memory: readMemory() });
      return await exchange(CHAT_INSTRUCTIONS, input, CHAT_LIMITS);
    } catch {
      return null; // same promise as requestLine: a reply or null, never a rejection
    } finally {
      calls += 1;
      lastLatencyMs = now() - started;
      inFlight.chat = false;
    }
  }

  return {
    requestLine,
    requestChat,
    isEnabled: () => !disabled,
    /**
     * Introspection for tests and debugging. Carries no config values.
     * `inFlight` stays a boolean meaning "anything in flight"; `pending` is the
     * per-kind truth behind it.
     */
    stats() {
      return {
        enabled: !disabled,
        route,
        inFlight: inFlight.ambient || inFlight.chat,
        pending: { ...inFlight },
        calls,
        lastLatencyMs,
      };
    },
  };
}

export default createBrain;
