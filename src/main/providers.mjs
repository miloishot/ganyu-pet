// Module D (optional) — the brain's wire adapters: one per protocol, one shape.
//
// brain.mjs owns everything that must be true whichever endpoint answers — the
// timeouts, the 401/403 latch, the tool loop and its cap, the fences around tool
// results, the never-throw / never-log-the-key guarantees. This module owns only
// what differs between protocols: the path, the auth header, how a request body
// is laid out, and where the text and the tool calls sit in a reply.
//
// Every adapter has the same six members:
//
//   path                      appended to the configured base URL
//   headers(apiKey)           the full header set; the key appears nowhere else
//   body(request)             request -> the JSON body, carrying only fields
//                             that protocol accepts
//   text(json)                the reply's text, or '' — never throws
//   calls(json)               the reply's tool calls, as
//                             [{callId, name, arguments}] with `arguments` a
//                             JSON string — never throws
//   echo(json)                what a follow-up must send back as the
//                             assistant's turn verbatim, or null where the
//                             protocol's turn is rebuilt from `calls`
//
// `request` is protocol-neutral:
//
//   {model, instructions, input, maxTokens, effort, tools, rounds}
//
//   input      the persona's one string (persona.buildBrainInput / buildChatInput)
//   effort     a reasoning-effort string, or null for "send no such field"
//   tools      brain.mjs's frozen Responses-shaped tool objects, or null
//   rounds     [{calls, outputs, echo}] — the tool calls a previous request
//              asked for, the fenced string each one returned (same order),
//              and that reply's `echo`. Empty on a first request.
//
// Nothing here reads config, touches the network or logs. No Electron import.

/** The flat Responses tool shape, as brain.mjs declares it. */
const toolParts = (tool) => ({
  name: tool.name,
  description: tool.description,
  parameters: tool.parameters,
});

/** Arguments for an echo, back as an object; malformed JSON is an empty one. */
function argsObject(json) {
  try {
    const parsed = JSON.parse(json || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** A tool call's arguments as the neutral JSON string, whatever shape they came in. */
function argsString(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '{}';
    }
  }
  return '{}';
}

const asArray = (value) => (Array.isArray(value) ? value : []);

// ---------------------------------------------------------------------------
// OpenAI Responses — POST /v1/responses
//
// The original route, and the only one the default provider prefers. Its body
// is built exactly as brain.mjs built it before this module existed — key order
// included — because a test holds the default provider's bodies byte-identical.
// ---------------------------------------------------------------------------

export const RESPONSES_WIRE = Object.freeze({
  path: '/v1/responses',
  headers: (apiKey) => ({
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  }),
  body({ model, instructions, input, maxTokens, effort, tools, rounds }) {
    return {
      model,
      instructions,
      input: rounds.length ? responsesItems(input, rounds) : input,
      max_output_tokens: maxTokens,
      // `store: false` asks the endpoint not to retain the exchange. Responses is
      // the one protocol here that defaults the other way, so it is the one
      // protocol that is sent it.
      store: false,
      ...(effort ? { reasoning: { effort } } : {}),
      // The flat shape is the Responses shape, so the frozen objects go as-is.
      ...(tools?.length ? { tools } : {}),
    };
  },
  text(json) {
    if (typeof json?.output_text === 'string') return json.output_text;
    for (const item of asArray(json?.output)) {
      if (item?.type !== 'message') continue;
      for (const part of asArray(item.content)) {
        if (part?.type === 'output_text' && typeof part.text === 'string') return part.text;
      }
    }
    return '';
  },
  calls(json) {
    const out = [];
    for (const item of asArray(json?.output)) {
      if (item?.type !== 'function_call') continue;
      const callId = typeof item.call_id === 'string' && item.call_id
        ? item.call_id
        : (typeof item.id === 'string' ? item.id : '');
      const name = typeof item.name === 'string' ? item.name : '';
      if (!callId || !name) continue;
      out.push({ callId, name, arguments: typeof item.arguments === 'string' ? item.arguments : '{}' });
    }
    return out;
  },
  echo: () => null,
});

/**
 * The follow-up input: the original message, then each call echoed beside its
 * result. `store: false` means the endpoint kept nothing, so the request has to
 * carry the whole exchange itself.
 */
function responsesItems(input, rounds) {
  const items = [{ role: 'user', content: input }];
  for (const { calls, outputs } of rounds) {
    calls.forEach((call, i) => {
      items.push({ type: 'function_call', call_id: call.callId, name: call.name, arguments: call.arguments });
      items.push({ type: 'function_call_output', call_id: call.callId, output: outputs[i] });
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// OpenAI chat completions — POST /v1/chat/completions
//
// Spoken by Ollama, LM Studio, OpenRouter, DeepSeek and most local servers.
// Deliberately sends the *intersection* of what those accept: no `store` (its
// default on OpenAI's own chat completions is already not to store, and other
// servers do not all know the field), no `strict` on tools (the schemas are
// strict-valid anyway, so a server that enforces it still accepts them), and
// `reasoning_effort` only when the owner set one.
// ---------------------------------------------------------------------------

export const CHAT_WIRE = Object.freeze({
  path: '/v1/chat/completions',
  headers: (apiKey) => ({
    'content-type': 'application/json',
    // A keyless local server (Ollama) gets no auth header at all, rather than
    // an empty bearer token.
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  }),
  body({ model, instructions, input, maxTokens, effort, tools, rounds }) {
    const messages = [
      { role: 'system', content: instructions },
      { role: 'user', content: input },
    ];
    for (const { calls, outputs } of rounds) {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: calls.map((call) => ({
          id: call.callId,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      calls.forEach((call, i) => {
        messages.push({ role: 'tool', tool_call_id: call.callId, content: outputs[i] });
      });
    }
    return {
      model,
      messages,
      max_tokens: maxTokens,
      ...(effort ? { reasoning_effort: effort } : {}),
      ...(tools?.length
        ? { tools: tools.map((tool) => ({ type: 'function', function: toolParts(tool) })) }
        : {}),
    };
  },
  text(json) {
    const content = json?.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  },
  calls(json) {
    const out = [];
    asArray(json?.choices?.[0]?.message?.tool_calls).forEach((call, i) => {
      const name = call?.function?.name;
      if (typeof name !== 'string' || !name) return;
      // Some local servers leave the id off. One is made up, because the
      // follow-up must pair every result with the call it answers.
      const callId = typeof call.id === 'string' && call.id ? call.id : `call_${i}`;
      out.push({ callId, name, arguments: argsString(call.function.arguments) });
    });
    return out;
  },
  // Rebuilt from `calls` rather than echoed, so a made-up id above still pairs.
  echo: () => null,
});

// ---------------------------------------------------------------------------
// Anthropic Messages — POST /v1/messages
//
// Validates its fields strictly, so this body has exactly six possible keys:
// model, max_tokens, system, messages, tools and output_config. No `store` (it
// has none), no `thinking` and no `tool_choice` — each of those returns 400 on
// some current models in some setting, and omitting them is the documented
// default. Reasoning effort is `output_config.effort`, sent only when the owner
// configured one of the values it takes.
//
// The assistant's turn goes back **verbatim**: a reply can carry `thinking` or
// `redacted_thinking` blocks even when none was asked for, and a follow-up that
// drops or reorders them is rejected.
// ---------------------------------------------------------------------------

export const ANTHROPIC_VERSION = '2023-06-01';

/** The `output_config.effort` values the Messages API takes. */
const ANTHROPIC_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export const MESSAGES_WIRE = Object.freeze({
  path: '/v1/messages',
  headers: (apiKey) => ({
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  }),
  body({ model, instructions, input, maxTokens, effort, tools, rounds }) {
    const messages = [{ role: 'user', content: input }];
    for (const { calls, outputs, echo } of rounds) {
      messages.push({
        role: 'assistant',
        content: Array.isArray(echo) && echo.length
          ? echo
          : calls.map((call) => ({
            type: 'tool_use',
            id: call.callId,
            name: call.name,
            input: argsObject(call.arguments),
          })),
      });
      // Every result for one turn goes back in one user message, each paired
      // with its call by id.
      messages.push({
        role: 'user',
        content: calls.map((call, i) => ({
          type: 'tool_result',
          tool_use_id: call.callId,
          content: outputs[i],
        })),
      });
    }
    return {
      model,
      max_tokens: maxTokens,
      system: instructions,
      messages,
      ...(tools?.length
        ? {
          tools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            // No `strict` flag: not every model behind this API is documented to
            // take it, and the schemas are strict-valid whether it is sent or not.
            input_schema: tool.parameters,
          })),
        }
        : {}),
      ...(ANTHROPIC_EFFORTS.has(effort) ? { output_config: { effort } } : {}),
    };
  },
  text(json) {
    const parts = [];
    for (const block of asArray(json?.content)) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join(' ');
  },
  calls(json) {
    const out = [];
    for (const block of asArray(json?.content)) {
      if (block?.type !== 'tool_use') continue;
      const callId = typeof block.id === 'string' ? block.id : '';
      const name = typeof block.name === 'string' ? block.name : '';
      if (!callId || !name) continue;
      out.push({ callId, name, arguments: argsString(block.input) });
    }
    return out;
  },
  echo: (json) => (Array.isArray(json?.content) ? json.content : null),
});

export const WIRES = Object.freeze({
  responses: RESPONSES_WIRE,
  chat: CHAT_WIRE,
  messages: MESSAGES_WIRE,
});

// ---------------------------------------------------------------------------
// Providers — what `GANYU_BRAIN_PROVIDER` selects
//
//   routes        wire names, tried in order; a 404/405 moves to the next
//   gatedRoute    a route reached only with GANYU_ALLOW_CHAT_FALLBACK, sent
//                 the old no-tools body, and announced in the log
//   keyRequired   whether GANYU_OPENAI_API_KEY must be set
//   defaultBaseUrl used when GANYU_OPENAI_BASE_URL is unset (null: required)
//   defaultEffort reasoning effort when none is configured ('none': send none)
// ---------------------------------------------------------------------------

export const DEFAULT_PROVIDER = 'openai';
export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

export const PROVIDERS = Object.freeze({
  openai: Object.freeze({
    routes: Object.freeze(['responses', 'chat']),
    gatedRoute: 'chat',
    keyRequired: true,
    defaultBaseUrl: null,
    defaultEffort: 'low',
  }),
  'openai-chat': Object.freeze({
    routes: Object.freeze(['chat']),
    gatedRoute: null,
    keyRequired: true,
    defaultBaseUrl: null,
    defaultEffort: 'none',
  }),
  anthropic: Object.freeze({
    routes: Object.freeze(['messages']),
    gatedRoute: null,
    keyRequired: true,
    defaultBaseUrl: null,
    defaultEffort: 'none',
  }),
  ollama: Object.freeze({
    routes: Object.freeze(['chat']),
    gatedRoute: null,
    keyRequired: false,
    defaultBaseUrl: OLLAMA_BASE_URL,
    defaultEffort: 'none',
  }),
});

export const PROVIDER_NAMES = Object.freeze(Object.keys(PROVIDERS));

/** The provider's name, normalised: unset or blank is the default. */
export const providerNameFrom = (value) => {
  const name = String(value ?? '').trim().toLowerCase();
  return name === '' ? DEFAULT_PROVIDER : name;
};

/** The provider for a configured value, or null for one that does not exist. */
export const providerFrom = (value) => {
  const name = providerNameFrom(value);
  return Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : null;
};

/** The `reason` an unknown value disables the brain with. Names no config value. */
export const UNKNOWN_PROVIDER_REASON =
  `unknown GANYU_BRAIN_PROVIDER — valid values: ${PROVIDER_NAMES.join(', ')}`;
