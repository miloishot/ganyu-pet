// Module B — loopback HTTP hook server. No Electron import: runs standalone with
//   node src/main/server.mjs --standalone --port 47899
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createState } from './state.mjs';

export const DEFAULT_PORT = 47821;
export const DEFAULT_HOST = '127.0.0.1';
// contracts.md says "sweep every 30s", but the sweep is also what re-emits when a
// *time-based* flag expires with no new event to trigger it — and `celebrate`
// only lives 10s. A 30s cadence would leave the pet mid-celebration for up to
// 20s after it should have stopped. 1s pruning is a superset: same TTL, timely
// flag expiry, and `emitChange` dedupes so an unchanged snapshot emits nothing.
const SWEEP_MS = 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const RING_SIZE = 50;
const RAW_CAPTURE_LIMIT = 4096;
const SOURCES = new Set(['codex', 'claude', 'opencode']);
const BARE_EVENT_RE = /^[A-Za-z][A-Za-z0-9 _.:-]{0,63}$/;

/** `--port N` / `--port=N` > GANYU_PORT > 47821. */
export function resolvePort(argv = [], env = {}) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' && i + 1 < argv.length) {
      const n = Number(argv[i + 1]);
      if (Number.isInteger(n) && n >= 0 && n <= 65535) return n;
    }
    if (typeof arg === 'string' && arg.startsWith('--port=')) {
      const n = Number(arg.slice('--port='.length));
      if (Number.isInteger(n) && n >= 0 && n <= 65535) return n;
    }
  }
  const fromEnv = Number(env.GANYU_PORT);
  if (Number.isInteger(fromEnv) && fromEnv >= 0 && fromEnv <= 65535) return fromEnv;
  return DEFAULT_PORT;
}

function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? '';
  return addr === '' || addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function safeStringify(value) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(value, (_k, v) => {
      if (v && typeof v === 'object') {
        if (seen.has(v)) return '[circular]';
        seen.add(v);
      }
      return v;
    }) ?? '';
  } catch {
    return '';
  }
}

/** Keep the ring buffer bounded in memory as well as in length. */
function captureRaw(value) {
  const json = safeStringify(value);
  if (json.length <= RAW_CAPTURE_LIMIT) return value;
  return { truncated: true, bytes: json.length, preview: json.slice(0, RAW_CAPTURE_LIMIT) };
}

function coerceObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  // `{"payload": "<json string>"}` — some forwarders double-wrap.
  if (typeof value.payload === 'string') {
    const inner = tryJsonLenient(value.payload);
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner;
  }
  return value;
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const VALID_JSON_ESCAPE = /["\\/bfnrtu]/;
/**
 * Re-escape lone backslashes so a Windows path that lost its escaping in transit
 * (`"cwd":"C:\Users\kw11l"`) still parses. Only used after a strict parse failed.
 */
function repairJsonEscapes(text) {
  return text.replace(/\\([\s\S])/g, (match, ch) => (VALID_JSON_ESCAPE.test(ch) ? match : `\\\\${ch}`));
}

function tryJsonLenient(text) {
  const strict = tryJson(text);
  if (strict !== undefined) return strict;
  if (!text.includes('\\')) return undefined;
  return tryJson(repairJsonEscapes(text));
}

function fromUrlEncoded(body) {
  let params;
  try {
    params = new URLSearchParams(body);
  } catch {
    return null;
  }
  const payload = params.get('payload') ?? params.get('json') ?? params.get('body');
  if (payload != null && payload !== '') {
    const parsed = coerceObject(tryJsonLenient(payload));
    if (parsed) return parsed;
    if (BARE_EVENT_RE.test(payload.trim())) return { event: payload.trim() };
    return null;
  }
  const event = params.get('event') ?? params.get('hook_event_name');
  if (event) return { event };
  return null;
}

/**
 * Accepts, in order: raw JSON body · `application/x-www-form-urlencoded` with a
 * `payload` field · urlencoded without the header · a bare event-name string.
 * Returns null when nothing usable could be extracted.
 */
export function parseEventBody(body, contentType = '') {
  const text = typeof body === 'string' ? body.trim() : '';
  if (text === '') return null;
  const urlencoded = /application\/x-www-form-urlencoded/i.test(contentType);

  if (urlencoded) {
    const fromForm = fromUrlEncoded(text);
    if (fromForm) return fromForm;
  }

  let parsed = tryJsonLenient(text);
  if (typeof parsed === 'string') {
    // Double-encoded JSON, or a quoted event name.
    const inner = tryJsonLenient(parsed);
    parsed = inner === undefined ? parsed : inner;
  }
  const asObject = coerceObject(parsed);
  if (asObject) return asObject;
  if (typeof parsed === 'string' && BARE_EVENT_RE.test(parsed.trim())) return { event: parsed.trim() };

  if (!urlencoded && text.includes('=')) {
    const fromForm = fromUrlEncoded(text);
    if (fromForm) return fromForm;
  }
  if (BARE_EVENT_RE.test(text)) return { event: text };
  return null;
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error('payload too large');
        err.code = 'E_TOO_LARGE';
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
    req.on('aborted', () => reject(Object.assign(new Error('aborted'), { code: 'E_ABORTED' })));
  });
}

/**
 * createHookServer({state, port, host, log}) → {start, stop, state, debugEvents, port, host, url}
 * Binds 127.0.0.1 only. Nothing here imports Electron.
 */
export function createHookServer({
  state = createState({ clock: () => Date.now() }),
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  log = console,
  sweepMs = SWEEP_MS,
  ringSize = RING_SIZE,
  maxBodyBytes = MAX_BODY_BYTES,
} = {}) {
  const ring = [];
  let sweepTimer = null;
  let boundPort = null;

  function record(entry) {
    ring.push(entry);
    while (ring.length > ringSize) ring.shift();
  }

  function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
    });
    res.end(payload);
  }

  function sendText(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
  }

  async function handleEvent(req, res, source, url) {
    if (!SOURCES.has(source)) {
      record({ at: Date.now(), source, ok: false, error: 'unknown source' });
      sendJson(res, 404, { ok: false, error: `unknown source: ${source}` });
      return;
    }
    let body;
    try {
      body = await readBody(req, maxBodyBytes);
    } catch (err) {
      if (err.code === 'E_TOO_LARGE') {
        record({ at: Date.now(), source, ok: false, error: 'payload too large' });
        if (!res.headersSent) sendJson(res, 413, { ok: false, error: 'payload too large' });
        return;
      }
      if (!res.headersSent) sendJson(res, 400, { ok: false, error: 'read failed' });
      return;
    }

    const payload = parseEventBody(body, req.headers['content-type'] ?? '');
    if (!payload) {
      record({
        at: Date.now(),
        source,
        ok: false,
        error: 'unparseable body',
        bodyPreview: body.slice(0, 512),
      });
      sendJson(res, 400, { ok: false, error: 'unparseable body' });
      return;
    }
    // `POST /event/codex?event=Stop` — the hook script passes the event name in
    // the query when it cannot get it out of stdin.
    const hint = url.searchParams.get('event');
    if (hint && payload.hook_event_name == null && payload.event == null && payload.type == null) {
      payload.event = hint;
    }

    const ev = state.ingest(source, payload);
    const snapshot = state.aggregate();
    record({
      at: ev.at,
      source,
      sessionId: ev.sessionId,
      event: ev.event,
      mode: snapshot.mode,
      sessionMode: ev.sessionMode,
      failed: ev.failed,
      raw: captureRaw(payload),
    });
    sendJson(res, 200, {
      ok: true,
      mode: snapshot.mode,
      sessionMode: ev.sessionMode,
      sessionId: ev.sessionId,
      event: ev.event,
      celebrate: snapshot.celebrate,
    });
  }

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, `http://${DEFAULT_HOST}`);
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad url' });
      return;
    }
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = (req.method ?? 'GET').toUpperCase();
    const eventMatch = /^\/event\/([^/]*)$/.exec(path);

    if (eventMatch) {
      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'use POST' });
        return;
      }
      let source = eventMatch[1];
      try {
        source = decodeURIComponent(source);
      } catch { /* keep raw */ }
      await handleEvent(req, res, source.toLowerCase(), url);
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    if (path === '/healthz') {
      sendText(res, 200, 'ok');
      return;
    }
    if (path === '/state') {
      sendJson(res, 200, state.aggregate());
      return;
    }
    if (path === '/debug/events') {
      if (!isLoopback(req)) {
        sendJson(res, 403, { ok: false, error: 'loopback only' });
        return;
      }
      sendJson(res, 200, { count: ring.length, events: ring.slice() });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log?.error?.(`ganyu-server: ${err?.stack ?? err}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal error' });
      else res.end();
    });
  });
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  // A socket error *after* a successful bind must never become an unhandled
  // 'error' event — inside Electron that takes down the main process, and the
  // pet dies over a dropped connection. Bind failures are still owned by the
  // one-shot listener in start(), which is why this one no-ops until bound.
  server.on('error', (err) => {
    if (boundPort === null) return;
    log?.error?.(`ganyu-server: socket error: ${err?.code ?? ''} ${err?.message ?? err}`);
  });

  function start() {
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        if (err?.code === 'EADDRINUSE') {
          err.message = `port ${port} on ${host} is already in use — ganyu-pet hook scripts hardcode this port. `
            + 'Stop the other listener or set GANYU_PORT.';
        }
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        boundPort = server.address()?.port ?? port;
        if (sweepMs > 0) {
          sweepTimer = setInterval(() => {
            try {
              state.sweep?.();
            } catch (err) {
              log?.error?.(`ganyu-server: sweep failed: ${err?.message ?? err}`);
            }
          }, sweepMs);
          sweepTimer.unref?.();
        }
        resolve({ port: boundPort, host, url: `http://${host}:${boundPort}` });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // Bind loopback only — never 0.0.0.0.
      server.listen(port, host);
    });
  }

  function stop() {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    return new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
  }

  const api = {
    start,
    stop,
    state,
    server,
    host,
    get port() {
      return boundPort ?? port;
    },
    get url() {
      return `http://${host}:${boundPort ?? port}`;
    },
    get listening() {
      return server.listening;
    },
    debugEvents: () => ring.slice(),
    // Module A registers `server.on('error', onServerError)` on whatever this
    // factory returns. Forward listener registration to the underlying
    // http.Server so that handler actually lands instead of being dropped.
    on(...args) {
      server.on(...args);
      return api;
    },
    once(...args) {
      server.once(...args);
      return api;
    },
    off(...args) {
      server.off(...args);
      return api;
    },
  };
  return api;
}

export { createHookServer as createServer };

async function main(argv = process.argv.slice(2), env = process.env) {
  const port = resolvePort(argv, env);
  const standalone = argv.includes('--standalone');
  const hooks = createHookServer({ port });
  let info;
  try {
    info = await hooks.start();
  } catch (err) {
    console.error(`ganyu-pet server: ${err?.message ?? err}`);
    process.exit(1);
    return;
  }
  // Machine-parsable first, human second.
  console.log(`GANYU_SERVER_LISTENING ${JSON.stringify({ ...info, standalone })}`);
  console.log(`ganyu-pet server listening on ${info.url} (POST /event/codex|claude|opencode)`);
  hooks.state.onChange((snapshot) => {
    console.log(`ganyu-pet state: mode=${snapshot.mode} sessions=${snapshot.sessionCount} celebrate=${snapshot.celebrate}`);
  });
  const shutdown = () => {
    hooks.stop().then(() => process.exit(0), () => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const invokedDirectly = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;
if (invokedDirectly) await main();

export default createHookServer;
