// Module D (optional) — brain: turns a hook event into an in-character line via
// the owner's own OpenAI-compatible endpoint.
//
// Everything here is best-effort. The deterministic MESSAGES table in
// persona.mjs remains the real speech path; the brain only ever improves on it,
// so every failure mode — no config, wrong route, bad key, timeout, garbage
// JSON — resolves to `null` and speech falls back to the canned line. It never
// throws and never rejects.
//
// Privacy: only event metadata leaves the machine (event kind, tool name,
// project name — see persona.buildBrainInput). No file contents, no prompt
// text, no transcript. `store: false` asks the endpoint not to retain the
// exchange, matching the owner's `disable_response_storage` setting. The key is
// read from disk at runtime, never logged, and never placed in an error message
// — which is also why failures are reported by error *name* only, since a fetch
// error's message carries the endpoint URL.
//
// No Electron import; fetch, the clock and the timeout are injectable.

import fs from 'node:fs';

import { BRAIN_INSTRUCTIONS, buildBrainInput, clampLine } from './persona.mjs';

/** Long enough for a slow first token, short enough that a stale line never lands. */
export const REQUEST_TIMEOUT_MS = 10_000;

/** Hard cap on a generated line. The prompt asks for 120; this is the backstop. */
export const MAX_BRAIN_LINE_CHARS = 140;

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
 * entirely on reasoning and return empty output.
 */
const MAX_OUTPUT_TOKENS = 300;

/** The three keys `.env.local` must carry for the brain to be usable. */
export const REQUIRED_KEYS = Object.freeze([
  'GANYU_OPENAI_BASE_URL',
  'GANYU_OPENAI_MODEL',
  'GANYU_OPENAI_API_KEY',
]);

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

/** One line, at most MAX_BRAIN_LINE_CHARS, word-boundary truncation. Empty -> null. */
export function postProcess(text) {
  const line = clampLine(text, MAX_BRAIN_LINE_CHARS);
  return line === '' ? null : line;
}

/**
 * createBrain({config, fetchImpl, now, log, timeoutMs}) -> {requestLine, ...}
 *
 * `requestLine({detail, summary})` resolves to a line or to null. Never rejects.
 */
export function createBrain({
  config,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  log = null,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  const baseUrl = String(config?.baseUrl ?? '').replace(/\/+$/, '');
  const model = String(config?.model ?? '');
  const apiKey = String(config?.apiKey ?? '');

  // A brain with nothing to call is born disabled rather than special-cased at
  // every call site: speech treats "returns null forever" identically to absent.
  let disabled =
    !config?.enabled || !baseUrl || !model || !apiKey || typeof fetchImpl !== 'function';
  let route = null; // the route that last answered, remembered for the process
  let inFlight = false;
  let calls = 0;
  let lastLatencyMs = null;

  const say = (level, message) => {
    try {
      log?.[level]?.(`[ganyu] ${message}`);
    } catch {
      /* a broken logger must not break the pet */
    }
  };

  function bodyFor(kind, instructions, input) {
    if (kind === 'responses') {
      return {
        model,
        instructions,
        input,
        max_output_tokens: MAX_OUTPUT_TOKENS,
        store: false,
      };
    }
    return {
      model,
      messages: [
        { role: 'system', content: instructions },
        { role: 'user', content: input },
      ],
      max_tokens: MAX_OUTPUT_TOKENS,
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
  async function attempt(kind, instructions, input) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}${ROUTES[kind]}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(bodyFor(kind, instructions, input)),
        signal: controller.signal,
      });
      const status = Number(res?.status);
      if (!Number.isFinite(status)) return {};
      if (status === 404 || status === 405) return { absent: true };
      if (status === 401 || status === 403) return { fatal: true };
      if (status < 200 || status >= 300) return {};
      const json = await res.json();
      const raw = kind === 'responses' ? textFromResponses(json) : textFromChat(json);
      return { ok: true, text: postProcess(raw) };
    } catch (err) {
      // Name only: a fetch error's message contains the endpoint URL.
      say('warn', `brain: request failed (${err?.name ?? 'error'}) — using the canned line`);
      return {};
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * At most one request in flight. A second event during a call gets its canned
   * line and nothing else — queueing would only ever deliver a line describing
   * something the owner has already watched finish.
   */
  async function requestLine({ detail = {}, summary = null } = {}) {
    if (disabled || inFlight) return null;
    inFlight = true;
    const started = now();
    try {
      const instructions = BRAIN_INSTRUCTIONS;
      const input = buildBrainInput(detail, summary);
      const order = route ? [route, ...ROUTE_ORDER.filter((r) => r !== route)] : ROUTE_ORDER;

      for (const kind of order) {
        const verdict = await attempt(kind, instructions, input);
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
    } catch {
      return null; // requestLine is a promise of a line or null, never a rejection
    } finally {
      calls += 1;
      lastLatencyMs = now() - started;
      inFlight = false;
    }
  }

  return {
    requestLine,
    isEnabled: () => !disabled,
    /** Introspection for tests and debugging. Carries no config values. */
    stats() {
      return { enabled: !disabled, route, inFlight, calls, lastLatencyMs };
    },
  };
}

export default createBrain;
